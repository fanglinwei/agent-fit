import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mutate, readSnapshot, statusReport, showReport, setTestHooks, DelegationError, resolveHome } from '../lib/install.mjs';
import { VERSION, renderPayload, resolveDefinition } from '../lib/codex.mjs';

const temporary = [];
afterEach(async () => { setTestHooks(); await Promise.all(temporary.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))); });
async function fixture() { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delegation-install-')); temporary.push(directory); return { directory, home: path.join(directory, 'Codex home with spaces') }; }
async function tree(home) {
  const result = {};
  async function visit(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
      const relative = prefix + entry.name, target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target, `${relative}/`);
      else if (entry.isFile()) result[relative] = { bytes: (await fs.readFile(target)).toString('base64'), mode: (await fs.stat(target)).mode & 0o777 };
    }
  }
  await visit(home); return result;
}
const rejectsCode = (operation, code) => assert.rejects(operation, error => error instanceof DelegationError && error.code === code);

test('setup dry run never creates home and status has an uninstalled revision', async () => {
  const { home } = await fixture();
  const before = await readSnapshot(home);
  const report = await mutate(home, 'setup', { dryRun: true, expectRevision: before.configuration_revision });
  assert.equal(report.result, 'preview'); assert.equal(report.restart.required, false); assert.equal(report.revision_after, null);
  assert.equal(await fs.stat(home).catch(() => null), null);
  assert.equal((await statusReport(home)).configuration_revision, before.configuration_revision);
});

test('setup preserves private config, existing default role, permissions and outside rules; repeated setup is no-op', async () => {
  const { home } = await fixture(); await fs.mkdir(path.join(home, 'agents'), { recursive: true });
  const config = 'model = "user-model"\n[features]\nimage_generation = true\n[model_providers.custom]\napi_key = "TEST_ONLY_NOT_REAL"\n';
  await fs.writeFile(path.join(home, 'config.toml'), config);
  await fs.writeFile(path.join(home, 'agents/default.toml'), 'name = "default"\ndescription = "User"\nmodel = "own"\n');
  await fs.writeFile(path.join(home, 'AGENTS.md'), '# User rules\n'); await fs.chmod(path.join(home, 'AGENTS.md'), 0o640);
  const installed = await mutate(home, 'setup');
  assert.equal(installed.mode.id, 'official'); assert.equal(installed.restart.required, true);
  assert.equal(await fs.readFile(path.join(home, 'config.toml'), 'utf8'), config);
  assert.ok((await fs.readFile(path.join(home, 'AGENTS.md'), 'utf8')).startsWith('# User rules\n'));
  assert.equal((await fs.stat(path.join(home, 'AGENTS.md'))).mode & 0o777, 0o640);
  const before = await tree(home), revision = (await readSnapshot(home)).configuration_revision;
  setTestHooks({ beforeLock() { throw new Error('No-op must not lock'); } });
  const repeated = await mutate(home, 'setup');
  assert.equal(repeated.result, 'unchanged'); assert.equal(repeated.restart.required, false); assert.deepEqual(await tree(home), before);
  assert.equal(repeated.revision_after, revision);
  const baseline = await fs.readFile(path.join(home, '.subagent-delegation/restore.json'), 'utf8');
  assert.ok(!baseline.includes('TEST_ONLY_NOT_REAL')); assert.ok(!baseline.includes('# User rules')); assert.ok(!baseline.includes('User rules'));
  const report = JSON.stringify(await statusReport(home, { details: true })); assert.ok(!report.includes('TEST_ONLY_NOT_REAL')); assert.ok(!report.includes('developer_instructions'));
});

test('mode switches share immutable baseline and synchronize roles, mode record and ownership hashes', async () => {
  const { home } = await fixture(); await mutate(home, 'setup');
  const baseline = await fs.readFile(path.join(home, '.subagent-delegation/restore.json'));
  const initial = await readSnapshot(home), instance = initial.state.instance_id;
  for (const mode of ['cut', 'high', 'fire', 'official']) {
    const report = await mutate(home, 'set', { mode });
    assert.equal(report.result, 'applied'); assert.equal(report.restart.required, true);
    const snapshot = await readSnapshot(home);
    assert.equal(snapshot.mode.id, mode); assert.equal(snapshot.state.instance_id, instance); assert.equal(snapshot.diagnostics.filter(item => item.status === 'fail').length, 0);
    assert.deepEqual(await fs.readFile(path.join(home, '.subagent-delegation/restore.json')), baseline);
    for (const role of (await statusReport(home)).roles) assert.equal(role.matches_mode, true);
    const current = JSON.parse(await fs.readFile(path.join(home, 'skills/subagent-delegation/references/current-mode.json'), 'utf8'));
    assert.equal(current.id, mode);
    assert.deepEqual(current.levels, resolveDefinition(mode).levels);
    assert.deepEqual(report.post_check_target.pairs, [...new Map(Object.values(current.levels).flatMap(pair => [
      { model: pair.model, effort: pair.effort }, pair.fallback,
    ].filter(Boolean)).map(pair => [JSON.stringify(pair), pair])).values()]);
  }
  assert.equal((await mutate(home, 'set', { mode: 'official' })).result, 'unchanged');
});

test('managed content, deletion, mode and rule drift stop all writes', async () => {
  for (const edit of [
    async home => fs.appendFile(path.join(home, 'agents/task-execute.toml'), '\n# user edit\n'),
    async home => fs.unlink(path.join(home, 'agents/task-execute.toml')),
    async home => fs.chmod(path.join(home, 'agents/task-execute.toml'), 0o644),
    async home => fs.writeFile(path.join(home, 'AGENTS.md'), (await fs.readFile(path.join(home, 'AGENTS.md'), 'utf8')).replace('## AI 子代理模型选择与委派', '## User edit')),
  ]) {
    const { home } = await fixture(); await mutate(home, 'setup'); await edit(home); const before = await tree(home);
    await assert.rejects(mutate(home, 'set', { mode: 'cut' }), DelegationError); assert.deepEqual(await tree(home), before);
  }
});

test('different existing files, conflicting role files and registrations cannot be taken over', async () => {
  for (const [relative, content] of [
    ['agents/task-scan.toml', 'name = "user-role"\n'],
    ['agents/custom.toml', 'name = "task_scan"\n'],
    ['config.toml', '[agents.task_scan]\nconfig_file = "elsewhere.toml"\n'],
  ]) {
    const { home } = await fixture(); await fs.mkdir(path.dirname(path.join(home, relative)), { recursive: true }); await fs.writeFile(path.join(home, relative), content); const before = await tree(home);
    await assert.rejects(mutate(home, 'setup'), DelegationError); assert.deepEqual(await tree(home), before);
  }
});

test('matching own explicit registrations and public existing assets are allowed', async () => {
  const { home } = await fixture(); await fs.mkdir(path.join(home, 'agents'), { recursive: true });
  const { files } = await renderPayload(resolveHome(home), resolveDefinition('official'));
  await fs.writeFile(path.join(home, 'agents/task-scan.toml'), files.get('agents/task-scan.toml')); await fs.chmod(path.join(home, 'agents/task-scan.toml'), 0o644);
  await fs.writeFile(path.join(home, 'config.toml'), '[agents.task_scan]\nconfig_file = "agents/task-scan.toml"\n');
  await mutate(home, 'setup'); assert.equal((await readSnapshot(home)).state.file_modes['agents/task-scan.toml'], 0o644);
});

test('unsafe manifest paths, symlink children and symlink homes cannot redirect writes', async () => {
  const { home, directory } = await fixture(); await fs.mkdir(home); const outside = path.join(directory, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(home, 'agents')); await rejectsCode(mutate(home, 'setup'), 'UNSAFE_PATH'); assert.deepEqual(await fs.readdir(outside), []); await fs.unlink(path.join(home, 'agents'));
  await mutate(home, 'setup'); const state = (await readSnapshot(home)).state; state.files['../outside/private.txt'] = '0'.repeat(64); await fs.writeFile(path.join(home, '.subagent-delegation/state.json'), JSON.stringify(state));
  await rejectsCode(mutate(home, 'setup'), 'STATE_INVALID'); assert.deepEqual(await fs.readdir(outside), []);
  const alias = path.join(directory, 'alias'); await fs.symlink(outside, alias); await rejectsCode(mutate(alias, 'setup'), 'UNSAFE_PATH');
});

test('special file permissions are rejected before installation', async () => {
  const { home } = await fixture(); await fs.mkdir(home); await fs.writeFile(path.join(home, 'AGENTS.md'), 'user\n'); await fs.chmod(path.join(home, 'AGENTS.md'), 0o4600);
  await rejectsCode(mutate(home, 'setup'), 'UNSAFE_PERMISSIONS'); assert.equal(await fs.stat(path.join(home, '.subagent-delegation')).catch(() => null), null);
});

test('configuration errors remain sanitized and do not create state', async () => {
  const { home } = await fixture(); await fs.mkdir(home); await fs.writeFile(path.join(home, 'config.toml'), 'agents = true\nprivate_value = "TEST_ONLY_NOT_REAL"\n');
  await assert.rejects(mutate(home, 'setup'), error => { assert.equal(error.code, 'CONFIG_INVALID'); assert.ok(!JSON.stringify(error).includes('TEST_ONLY_NOT_REAL')); assert.ok(!error.message.includes('TEST_ONLY_NOT_REAL')); return true; });
  assert.equal(await fs.stat(path.join(home, '.subagent-delegation')).catch(() => null), null);
});

test('ordinary third write failure restores all bytes and removes new empty directories', async () => {
  const { home } = await fixture(); await fs.mkdir(home); await fs.writeFile(path.join(home, 'AGENTS.md'), 'user\n'); const before = await tree(home);
  setTestHooks({ beforeWrite(relative, change, count) { if (count === 2) throw new Error('Simulated write failure'); } });
  await assert.rejects(mutate(home, 'setup'), error => { assert.equal(error.details.report.configuration_status, 'rolled_back'); assert.equal(error.details.report.restart.required, false); return true; });
  assert.deepEqual(await tree(home), before); assert.deepEqual(await fs.readdir(home), ['AGENTS.md']);
});

test('rollback preserves concurrent edits and continues restoring other safe files', async () => {
  const { home } = await fixture(); await mutate(home, 'setup'); const before = await tree(home);
  let edited;
  setTestHooks({ async beforeWrite(relative, change, count) { if (count === 3) { edited = 'agents/task-execute.toml'; await fs.appendFile(path.join(home, edited), '\n# concurrent user edit\n'); throw new Error('Simulated write failure'); } } });
  await assert.rejects(mutate(home, 'set', { mode: 'fire' }), error => { assert.equal(error.details.report.configuration_status, 'partial'); assert.equal(error.details.report.restart.required, null); assert.ok(error.details.report.rollback_failures.includes(path.join(resolveHome(home), edited))); return true; });
  const after = await tree(home); assert.ok((await fs.readFile(path.join(home, edited), 'utf8')).includes('concurrent user edit'));
  for (const relative of Object.keys(before)) if (relative !== edited) assert.deepEqual(after[relative], before[relative]);
});

test('rollback failure is reported while remaining safe files are rolled back', async () => {
  const { home } = await fixture(); await mutate(home, 'setup'); const before = await tree(home); let failed;
  setTestHooks({ beforeWrite(relative, change, count) { if (count === 3) throw new Error('Fail'); }, beforeRollback(relative) { if (relative === 'agents/task-review.toml') { failed = relative; throw new Error('Rollback fail'); } } });
  await assert.rejects(mutate(home, 'set', { mode: 'fire' }), error => error.details.report.configuration_status === 'partial');
  const after = await tree(home); for (const relative of Object.keys(before)) if (relative !== failed) assert.deepEqual(after[relative], before[relative]);
});

test('existing lock blocks status and writes; read commands never delete it', async () => {
  const { home } = await fixture(); await mutate(home, 'setup'); await fs.writeFile(path.join(home, '.subagent-delegation/install.lock'), ''); const before = await tree(home);
  await rejectsCode(statusReport(home), 'BUSY'); await rejectsCode(mutate(home, 'set', { mode: 'cut' }), 'BUSY'); assert.deepEqual(await tree(home), before);
});

test('revision observes private config, override, chmod, and discovery directory; optimistic stale write is rejected', async () => {
  const { home } = await fixture(); await mutate(home, 'setup'); let revision = (await readSnapshot(home)).configuration_revision;
  for (const change of [
    async () => fs.writeFile(path.join(home, 'config.toml'), 'model = "private"\n'),
    async () => fs.writeFile(path.join(home, 'AGENTS.override.md'), ''),
    async () => fs.chmod(path.join(home, 'agents/task-scan.toml'), 0o640),
  ]) { await change(); const next = (await readSnapshot(home)).configuration_revision; assert.notEqual(next, revision); revision = next; }
  const { home: home2 } = await fixture(); await mutate(home2, 'setup'); const source = (await readSnapshot(home2)).configuration_revision;
  await fs.writeFile(path.join(home2, 'agents/other.toml'), 'name = "other"\n'); const before = await tree(home2);
  await rejectsCode(mutate(home2, 'set', { mode: 'fire', expectRevision: source }), 'CONFIG_CHANGED'); assert.deepEqual(await tree(home2), before);
});

test('lock re-read detects a newly created role directory entry before any write', async () => {
  const { home } = await fixture(); await mutate(home, 'setup'); const before = await tree(home);
  setTestHooks({ async afterLock() { await fs.writeFile(path.join(home, 'agents/new.toml'), 'name = "unrelated"\n'); } });
  await rejectsCode(mutate(home, 'set', { mode: 'cut' }), 'CONFIG_CHANGED'); const after = await tree(home);
  for (const relative of Object.keys(before)) assert.deepEqual(after[relative], before[relative]); assert.ok(after['agents/new.toml']);
});

test('unstable reads retry once, then BUSY without writing', async () => {
  const { home } = await fixture(); await mutate(home, 'setup'); let count = 0;
  setTestHooks({ async afterSnapshotRead() { await fs.writeFile(path.join(home, 'config.toml'), `model = "change-${++count}"\n`); } });
  await rejectsCode(readSnapshot(home), 'BUSY'); assert.equal(count, 2);
});

test('unsupported state formats and mode ids are rejected without migrating or writing', async () => {
  const { home } = await fixture(); await mutate(home, 'setup');
  const target = path.join(home, '.subagent-delegation/state.json');
  const state = JSON.parse(await fs.readFile(target, 'utf8'));
  for (const change of [{ schema_version: 1 }, { schema_version: 3 }, ...['economy', 'balanced', 'performance'].map(mode => ({ mode })), { restoration: { status: 'unavailable', baseline_sha256: null } }, { files: { ...state.files, 'skills/unsupported-skill/SKILL.md': '0'.repeat(64) } }]) {
    await fs.writeFile(target, JSON.stringify({ ...state, ...change }));
    const before = await tree(home);
    await rejectsCode(statusReport(home), 'STATE_INVALID');
    for (const action of ['setup', 'set', 'create', 'configure', 'restore']) await rejectsCode(mutate(home, action, { mode: 'cut', name: 'test' }), 'STATE_INVALID');
    assert.deepEqual(await tree(home), before);
  }
});

test('different configuration versions block reads and writes without upgrading or downgrading', async () => {
  const { home } = await fixture(); await mutate(home, 'setup');
  const target = path.join(home, '.subagent-delegation/state.json');
  const state = JSON.parse(await fs.readFile(target, 'utf8'));
  for (const otherVersion of ['0.1.9', '99.0.0']) {
    await fs.writeFile(target, JSON.stringify({ ...state, version: otherVersion }));
    const before = await tree(home);
    await rejectsCode(statusReport(home), 'VERSION_MISMATCH');
    for (const action of ['setup', 'set', 'create', 'configure', 'restore']) await rejectsCode(mutate(home, action, { mode: 'cut', name: 'test' }), 'VERSION_MISMATCH');
    assert.deepEqual(await tree(home), before);
  }
});

test('override shadowing blocks deployments but restore remains available', async () => {
  const { home } = await fixture(); await fs.mkdir(home); await fs.writeFile(path.join(home, 'AGENTS.override.md'), 'User override\n'); const before = await tree(home);
  await rejectsCode(mutate(home, 'setup'), 'RULES_SHADOWED'); assert.deepEqual(await tree(home), before);
  await fs.unlink(path.join(home, 'AGENTS.override.md')); await mutate(home, 'setup'); await fs.writeFile(path.join(home, 'AGENTS.override.md'), 'User override\n');
  await rejectsCode(mutate(home, 'set', { mode: 'cut' }), 'RULES_SHADOWED'); assert.equal((await mutate(home, 'restore')).result, 'applied'); assert.equal(await fs.readFile(path.join(home, 'AGENTS.override.md'), 'utf8'), 'User override\n');
});

test('blank home override follows host Unicode whitespace semantics', async () => {
  const { home } = await fixture(); await fs.mkdir(home);
  const override = path.join(home, 'AGENTS.override.md'); await fs.writeFile(override, '\n\t \u0085');
  assert.equal((await mutate(home, 'setup')).result, 'applied');
  await fs.writeFile(override, '\ufeff'); await rejectsCode(mutate(home, 'set', { mode: 'cut' }), 'RULES_SHADOWED');
  assert.equal((await mutate(home, 'restore')).result, 'applied');
  assert.equal(await fs.readFile(override, 'utf8'), '\ufeff');
});

test('recursive host role discovery catches same-name collisions and new entries under lock', async () => {
  const { home } = await fixture(); await fs.mkdir(path.join(home, 'agents/nested'), { recursive: true }); await fs.writeFile(path.join(home, 'agents/nested/conflict.toml'), 'name = "task_review"\n');
  await rejectsCode(mutate(home, 'setup'), 'ROLE_NAME_CONFLICT'); await fs.unlink(path.join(home, 'agents/nested/conflict.toml')); await mutate(home, 'setup');
  const before = await tree(home); setTestHooks({ async afterLock() { await fs.writeFile(path.join(home, 'agents/nested/user.toml'), 'name = "user"\n'); } });
  await rejectsCode(mutate(home, 'set', { mode: 'fire' }), 'CONFIG_CHANGED'); const after = await tree(home); for (const relative of Object.keys(before)) assert.deepEqual(after[relative], before[relative]);
});

test('dry-run rechecks the complete observed snapshot before producing preview', async () => {
  const { home } = await fixture(); await mutate(home, 'setup'); const before = await tree(home);
  setTestHooks({ async beforePreview() { await fs.writeFile(path.join(home, 'config.toml'), 'model = "user-change"\n'); } });
  await rejectsCode(mutate(home, 'set', { mode: 'cut', dryRun: true }), 'CONFIG_CHANGED'); const after = await tree(home); for (const relative of Object.keys(before)) assert.deepEqual(after[relative], before[relative]);
});

test('signals before first write cancel without changes and signals after writes trigger complete rollback', async () => {
  for (const count of [0, 2]) {
    setTestHooks();
    const { home } = await fixture(); await mutate(home, 'setup'); const before = await tree(home); const listeners = process.listenerCount('SIGINT');
    setTestHooks({ beforeWrite(relative, change, written) { if (written === count) process.emit('SIGINT'); } });
    await assert.rejects(mutate(home, 'set', { mode: 'fire' }), error => error.code === 'CANCELED' && error.details.report.configuration_status === (count ? 'rolled_back' : 'not_written'));
    assert.deepEqual(await tree(home), before); assert.equal(process.listenerCount('SIGINT'), listeners);
  }
});

test('stable installed mode data is read from its owned deployed snapshot instead of current package preset', async () => {
  const { home } = await fixture(); await mutate(home, 'setup'); const target = path.join(home, 'skills/subagent-delegation/references/current-mode.json'); const current = JSON.parse(await fs.readFile(target, 'utf8'));
  current.levels.L1.model = 'installed-snapshot-model'; const bytes = Buffer.from(JSON.stringify(current)); await fs.writeFile(target, bytes);
  const stateTarget = path.join(home, '.subagent-delegation/state.json'); const state = JSON.parse(await fs.readFile(stateTarget, 'utf8')); state.files['skills/subagent-delegation/references/current-mode.json'] = createHash('sha256').update(bytes).digest('hex'); await fs.writeFile(stateTarget, JSON.stringify(state));
  assert.equal((await readSnapshot(home)).mode.levels.L1.model, 'installed-snapshot-model'); assert.equal((await statusReport(home)).mode.levels.L1.model, 'installed-snapshot-model');
  for (const selector of ['official', undefined]) {
    const shown = await showReport(home, selector);
    assert.equal(shown.definition.levels.L1.model, 'installed-snapshot-model'); assert.equal(shown.definition_version, VERSION);
  }
  await mutate(home, 'setup'); assert.equal((await readSnapshot(home)).mode.levels.L1.model, resolveDefinition('official').levels.L1.model);
});

test('protected JSON rejects duplicate keys instead of silently accepting the final occurrence', async () => {
  const { home } = await fixture(); await mutate(home, 'setup'); const target = path.join(home, '.subagent-delegation/state.json'); const text = await fs.readFile(target, 'utf8'); await fs.writeFile(target, text.replace('"schema_version": 2,', '"schema_version": 2, "schema_version": 2,'));
  await rejectsCode(readSnapshot(home), 'STATE_INVALID');
});

test('registered outside roles and profiles are reported as safe candidates without reading instructions or credentials', async () => {
  const { home, directory } = await fixture(); await fs.mkdir(home); const outside = path.join(directory, 'outside.toml'); await fs.writeFile(outside, 'PRIVATE OUTSIDE INSTRUCTIONS TEST_ONLY_NOT_REAL');
  await fs.writeFile(path.join(home, 'config.toml'), `[agents]\nenabled = true\ndefault_subagent_model = "global-model"\ndefault_subagent_reasoning_effort = "high"\n[agents.elsewhere]\nconfig_file = ${JSON.stringify(outside)}\n[profiles.work]\nmodel = "profile-model"\nmodel_reasoning_effort = "medium"\nprovider_secret = "TEST_ONLY_NOT_REAL"\n[profiles.work.agents]\ndefault_subagent_model = "profile-agent"\n`);
  const report = await statusReport(home); assert.equal(report.related_config.agents_enabled, true); assert.equal(report.related_config.default_subagent_model, 'global-model'); assert.equal(report.related_config.registered_roles[0].inspected, false); assert.equal(report.related_config.profile_candidates[0].default_subagent_model, 'profile-agent'); assert.ok(report.inspection.skipped_paths.some(item => item.reason === 'conditional_active_profile_unknown')); assert.ok(!JSON.stringify(report).includes('TEST_ONLY_NOT_REAL'));
});

test('committed lock cleanup failure preserves applied report and restart reminder', async () => {
  const { home } = await fixture(); setTestHooks({ beforeUnlock() { const error = new Error('Cannot remove lock'); error.code = 'EACCES'; throw error; } });
  await assert.rejects(mutate(home, 'setup'), error => { assert.equal(error.code, 'LOCK_RELEASE_FAILED'); assert.equal(error.details.report.result, 'applied'); assert.equal(error.details.report.configuration_status, 'written'); assert.equal(error.details.report.restart.required, true); return true; });
  setTestHooks(); await fs.unlink(path.join(home, '.subagent-delegation/install.lock')); assert.equal((await readSnapshot(home)).state.schema_version, 2);
});

test('late edit after temporary write is preserved at the final atomic replacement check', async () => {
  const { home } = await fixture(); await mutate(home, 'setup'); const before = await tree(home); let edited;
  setTestHooks({ async beforeAtomicCommit(relative) { if (!edited) { edited = relative; await fs.writeFile(path.join(home, relative), 'late user edit'); } } });
  await assert.rejects(mutate(home, 'set', { mode: 'fire' }), error => error.code === 'CONFIG_CHANGED' && error.details.report.configuration_status === 'not_written');
  const after = await tree(home); assert.equal(await fs.readFile(path.join(home, edited), 'utf8'), 'late user edit'); for (const relative of Object.keys(before)) if (relative !== edited) assert.deepEqual(after[relative], before[relative]);
});

test('late rollback edit survives and other safe files still roll back', async () => {
  const { home } = await fixture(); await mutate(home, 'setup'); const before = await tree(home); let edited;
  setTestHooks({ beforeWrite(relative, change, count) { if (count === 0) edited = relative; if (count === 3) throw new Error('Fail'); }, async beforeRollback(relative) { if (relative === edited) await fs.writeFile(path.join(home, relative), 'late rollback user edit'); } });
  await assert.rejects(mutate(home, 'set', { mode: 'fire' }), error => error.details.report.configuration_status === 'partial');
  const after = await tree(home); assert.equal(await fs.readFile(path.join(home, edited), 'utf8'), 'late rollback user edit'); for (const relative of Object.keys(before)) if (relative !== edited) assert.deepEqual(after[relative], before[relative]);
});

test('concurrent edit after a completed write prevents a false applied report and keeps user content', async () => {
  const { home } = await fixture(); await mutate(home, 'setup'); const before = await tree(home); let edited;
  setTestHooks({ async afterWrite(relative) { if (!edited) { edited = relative; await fs.appendFile(path.join(home, relative), '\n# concurrent after-write user edit\n'); } } });
  await assert.rejects(mutate(home, 'set', { mode: 'fire' }), error => error.details.report.configuration_status === 'partial' && error.details.report.restart.required === null);
  const after = await tree(home); assert.ok((await fs.readFile(path.join(home, edited), 'utf8')).includes('concurrent after-write user edit')); for (const relative of Object.keys(before)) if (relative !== edited) assert.deepEqual(after[relative], before[relative]);
});
