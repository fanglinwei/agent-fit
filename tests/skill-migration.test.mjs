import './isolate-home.mjs';
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stringify } from 'smol-toml';
import { mutate, readSnapshot, statusReport, setTestHooks } from '../lib/install.mjs';
import { renderPayload, resolveDefinition, skillAssets, safeToml, VERSION } from '../lib/codex.mjs';
import { inspectSkill, sharedSkillPath, updateSkill, setSkillTestHooks } from '../lib/skill.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const temporary = [];
beforeEach(async () => { await fs.rm(path.dirname(sharedSkillPath()), { recursive: true, force: true }); });
afterEach(async () => { setTestHooks(); setSkillTestHooks(); await Promise.all(temporary.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-fit-migration-')));
  temporary.push(root);
  return { root, home: path.join(root, '.codex') };
}
async function tree(root) {
  const result = {};
  async function visit(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
      const relative = prefix + entry.name, target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target, `${relative}/`);
      else if (entry.isSymbolicLink()) result[relative] = { link: await fs.readlink(target) };
      else result[relative] = { bytes: (await fs.readFile(target)).toString('base64'), mode: (await fs.stat(target)).mode & 0o777 };
    }
  }
  await visit(root); return result;
}
const cli = (home, args) => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/agent-fit.mjs', import.meta.url)), ...args, '--codex-home', home, '--json'], { encoding: 'utf8' });
  assert.equal(result.signal, null);
  return { code: result.status, ...JSON.parse(result.stdout) };
};

// Version 2 registered the full Skill tree and generated home-specific role copies inside it.
async function legacyInstallation(home, placement = 'moved') {
  const mode = resolveDefinition('high');
  const payload = await renderPayload(home, mode), files = new Map();
  for (const [name, bytes] of await skillAssets()) files.set(`skills/agent-fit/${name}`, name === 'SKILL.md' ? Buffer.concat([bytes, Buffer.from('\nLegacy packaged instructions.\n')]) : bytes);
  for (const [relative, bytes] of payload.files) {
    if (relative === '.agent-fit/current-mode.json') { files.set('skills/agent-fit/references/current-mode.json', Buffer.from(JSON.stringify({ ...JSON.parse(bytes), version: '0.7.1' }))); continue; }
    const role = safeToml(bytes);
    role.developer_instructions = `读取 ${home}/skills/agent-fit/SKILL.md。\n` + role.developer_instructions.split('\n\n').slice(1).join('\n\n');
    const rendered = Buffer.from(stringify(role));
    files.set(relative, rendered); files.set(`skills/agent-fit/assets/codex/${relative}`, rendered);
  }
  const rules = Buffer.from(`<!-- agent-fit:start -->\n读取 ${home}/skills/agent-fit/SKILL.md。\n<!-- agent-fit:end -->\n`);
  const baseline = { schema_version: 1, agent: 'codex', entries: Object.fromEntries([...files.keys()].map(name => [name, null])), rules: { existed: false, mode: null, sha256: null, original_block_base64: null, separator_base64: '', original_prefix_sha256: digest(Buffer.alloc(0)) }, created_directories: ['agents', 'skills', 'skills/agent-fit', '.agent-fit'] };
  const base = Buffer.from(JSON.stringify(baseline));
  const state = { schema_version: 2, agent: 'codex', version: '0.7.1', mode: mode.id, mode_kind: mode.kind, instance_id: '01234567-89ab-4cde-8fab-0123456789ab', files: Object.fromEntries([...files].map(([name, bytes]) => [name, digest(bytes)])), file_modes: Object.fromEntries([...files.keys()].map(name => [name, 0o600])), rules_mode: 0o600, rules_sha256: digest(rules), restoration: { status: 'available', baseline_sha256: digest(base) } };
  files.set('AGENTS.md', rules); files.set('.agent-fit/restore.json', base); files.set('.agent-fit/state.json', Buffer.from(JSON.stringify(state)));
  for (const [relative, bytes] of files) { await fs.mkdir(path.dirname(path.join(home, relative)), { recursive: true, mode: 0o700 }); await fs.writeFile(path.join(home, relative), bytes, { mode: 0o600 }); }
  if (placement !== 'legacy') {
    await fs.mkdir(path.dirname(sharedSkillPath()), { recursive: true, mode: 0o700 });
    await fs.rename(path.join(home, 'skills/agent-fit'), sharedSkillPath());
    if (placement === 'link') await fs.symlink(sharedSkillPath(), path.join(home, 'skills/agent-fit'));
  }
  return state;
}

for (const placement of ['legacy', 'moved', 'link']) test(`migrate ${placement} layout without query writes, lost routing or shared changes on switch/restore`, async () => {
  const { home } = await fixture();
  await legacyInstallation(home, placement);
  const before = await tree(home), sharedBefore = await tree(sharedSkillPath());
  const status = cli(home, ['status']), explanation = cli(home, ['explain', '--level', 'L2']);
  assert.equal(status.code, 1); assert.equal(explanation.code, 1);
  assert.deepEqual(status.errors.map(value => value.code), ['MIGRATION_REQUIRED']);
  assert.deepEqual(await tree(home), before); assert.deepEqual(await tree(sharedSkillPath()), sharedBefore);
  const preview = await mutate(home, 'setup', { dryRun: true });
  assert.equal(preview.result, 'preview'); assert.deepEqual(await tree(home), before);
  await mutate(home, 'setup');
  const snapshot = await readSnapshot(home);
  assert.equal(snapshot.state.schema_version, 3); assert.equal(snapshot.mode.id, 'high');
  assert.ok(Object.keys(snapshot.state.files).every(name => !name.startsWith('skills/')));
  assert.deepEqual(snapshot.diagnostics.filter(value => value.status === 'fail'), []);
  const entry = cli(home, ['skill', 'path']); assert.equal(entry.code, 0); assert.equal(entry.data.path, path.join(await fs.realpath(sharedSkillPath()), 'SKILL.md'));
  assert.equal(cli(home, ['explain', '--level', 'L2']).code, 0);
  await fs.rm(path.join(home, 'skills/agent-fit'), { recursive: true, force: true });
  assert.equal(cli(home, ['explain', '--level', 'L2']).code, 0);
  const staticFiles = await tree(sharedSkillPath());
  await mutate(home, 'set', { mode: 'cut' });
  assert.deepEqual(await tree(sharedSkillPath()), staticFiles);
  await mutate(home, 'restore');
  assert.deepEqual(await tree(sharedSkillPath()), staticFiles);
  assert.equal((await statusReport(home)).installation, 'not_installed');
});

test('migration preserves calibrated builtin levels and all local/custom selections', async () => {
  const { home } = await fixture();
  await legacyInstallation(home);
  const statePath = path.join(home, '.agent-fit/state.json');
  const state = JSON.parse(await fs.readFile(statePath));
  const current = path.join(sharedSkillPath(), 'references/current-mode.json');
  const mode = JSON.parse(await fs.readFile(current)); mode.levels.L1.model = 'calibrated-home-model';
  const bytes = Buffer.from(JSON.stringify(mode)); await fs.writeFile(current, bytes);
  state.files['skills/agent-fit/references/current-mode.json'] = digest(bytes);
  const rolePath = path.join(home, 'agents/task-scan.toml');
  const role = safeToml(await fs.readFile(rolePath)); role.model = 'calibrated-home-model';
  const roleBytes = Buffer.from(stringify(role)); await fs.writeFile(rolePath, roleBytes);
  await fs.writeFile(path.join(sharedSkillPath(), 'assets/codex/agents/task-scan.toml'), roleBytes);
  state.files['agents/task-scan.toml'] = digest(roleBytes); state.files['skills/agent-fit/assets/codex/agents/task-scan.toml'] = digest(roleBytes);
  const scopeBytes = Buffer.from(JSON.stringify({ schema_version: 1, projects: [{ project: '/project', selection: 'cut', modes: [] }], sessions: [{ thread: 'chat', selection: 'official', modes: [] }] }));
  const scopes = '.agent-fit/scopes.json'; await fs.writeFile(path.join(home, scopes), scopeBytes, { mode: 0o600 });
  state.files[scopes] = digest(scopeBytes); state.file_modes[scopes] = 0o600;
  const baselinePath = path.join(home, '.agent-fit/restore.json'); const baseline = JSON.parse(await fs.readFile(baselinePath)); baseline.entries[scopes] = null;
  const baselineBytes = Buffer.from(JSON.stringify(baseline)); await fs.writeFile(baselinePath, baselineBytes); state.restoration.baseline_sha256 = digest(baselineBytes);
  await fs.writeFile(statePath, JSON.stringify(state));
  await mutate(home, 'setup');
  assert.equal((await readSnapshot(home)).mode.levels.L1.model, 'calibrated-home-model');
  assert.deepEqual(await fs.readFile(path.join(home, scopes)), scopeBytes);
});

for (const conflict of ['current-mode', 'shared-doc', 'home-role', 'permission', 'original-baseline']) test(`migration preserves all contents when ${conflict} conflicts`, async () => {
  const { home } = await fixture(); await legacyInstallation(home);
  if (conflict === 'current-mode') await fs.appendFile(path.join(sharedSkillPath(), 'references/current-mode.json'), ' ');
  if (conflict === 'shared-doc') await fs.appendFile(path.join(sharedSkillPath(), 'SKILL.md'), 'User edit\n');
  if (conflict === 'home-role') await fs.appendFile(path.join(home, 'agents/task-review.toml'), '\n# User edit\n');
  if (conflict === 'permission') await fs.chmod(path.join(sharedSkillPath(), 'SKILL.md'), 0o644);
  if (conflict === 'original-baseline') {
    const target = path.join(home, '.agent-fit/restore.json'), baseline = JSON.parse(await fs.readFile(target));
    const original = Buffer.from('original user instructions');
    baseline.entries['skills/agent-fit/SKILL.md'] = { bytes_base64: original.toString('base64'), sha256: digest(original), mode: 0o600 };
    const bytes = Buffer.from(JSON.stringify(baseline)); await fs.writeFile(target, bytes);
    const statePath = path.join(home, '.agent-fit/state.json'), state = JSON.parse(await fs.readFile(statePath)); state.restoration.baseline_sha256 = digest(bytes); await fs.writeFile(statePath, JSON.stringify(state));
  }
  const before = await tree(home), shared = await tree(sharedSkillPath());
  await assert.rejects(mutate(home, 'setup'), error => ['MIGRATION_CONFLICT', 'MANAGED_FILE_DRIFT'].includes(error.code));
  assert.deepEqual(await tree(home), before); assert.deepEqual(await tree(sharedSkillPath()), shared);
});

test('migration failure rolls home back and leaves shared files intact', async () => {
  const { home } = await fixture(); await legacyInstallation(home, 'link');
  const before = await tree(home), shared = await tree(sharedSkillPath());
  setTestHooks({ beforeWrite(relative, change, count) { if (count === 2) throw new Error('injected migration failure'); } });
  await assert.rejects(mutate(home, 'setup'), error => error.details.report.configuration_status === 'rolled_back');
  assert.deepEqual(await tree(home), before); assert.deepEqual(await tree(sharedSkillPath()), shared);
});

test('two homes share rules while switches, custom definitions and restore remain isolated', async () => {
  const a = (await fixture()).home, b = (await fixture()).home;
  await mutate(a, 'setup', { mode: 'high' }); await mutate(b, 'setup', { mode: 'cut' });
  await mutate(a, 'create', { name: 'only-a', from: 'high' });
  const bBefore = await tree(b), shared = await tree(sharedSkillPath());
  await mutate(a, 'set', { mode: 'only-a' });
  assert.deepEqual(await tree(b), bBefore); assert.deepEqual(await tree(sharedSkillPath()), shared);
  await mutate(a, 'restore');
  assert.equal((await readSnapshot(b)).mode.id, 'cut'); assert.deepEqual(await tree(b), bBefore); assert.deepEqual(await tree(sharedSkillPath()), shared);
  assert.equal(await fs.stat(path.join(sharedSkillPath(), 'references/current-mode.json')).catch(() => null), null);
});

test('explicit shared update adopts legacy receipts, preserves runtime leftovers and refuses user edits', async () => {
  const { home } = await fixture(); await legacyInstallation(home, 'link'); await mutate(home, 'setup');
  const before = await tree(sharedSkillPath()), snapshot = await readSnapshot(home);
  const preview = await updateSkill(home, { dryRun: true, legacyState: snapshot.state });
  assert.equal(preview.result, 'preview'); assert.deepEqual(await tree(sharedSkillPath()), before);
  const oldMode = await fs.readFile(path.join(sharedSkillPath(), 'references/current-mode.json'));
  const updated = await updateSkill(home, { legacyState: snapshot.state }); assert.equal(updated.result, 'applied');
  assert.deepEqual(await fs.readFile(path.join(sharedSkillPath(), 'references/current-mode.json')), oldMode);
  const stable = await tree(sharedSkillPath()); await mutate(home, 'setup'); assert.deepEqual(await tree(sharedSkillPath()), stable);
  await fs.appendFile(path.join(sharedSkillPath(), 'SKILL.md'), '\nUser-owned change\n');
  const edited = await tree(sharedSkillPath()); await assert.rejects(updateSkill(home), { code: 'SKILL_CONFLICT' }); assert.deepEqual(await tree(sharedSkillPath()), edited);
});

test('nested Skill links, links to unknown roots and home state links remain rejected', async () => {
  const { root, home } = await fixture(); await mutate(home, 'setup');
  const outside = path.join(root, 'outside'); await fs.mkdir(outside);
  const legacy = path.join(home, 'skills/agent-fit'); await fs.mkdir(path.dirname(legacy), { recursive: true }); await fs.symlink(outside, legacy);
  assert.ok((await readSnapshot(home)).diagnostics.some(value => value.code === 'SKILL_UNAVAILABLE')); await fs.unlink(legacy);
  const reference = path.join(sharedSkillPath(), 'references/calibration.md'); await fs.unlink(reference); await fs.symlink('/etc/passwd', reference);
  await assert.rejects(inspectSkill(home), { code: 'UNSAFE_PATH' }); await fs.unlink(reference);
  await fs.writeFile(reference, (await skillAssets()).get('references/calibration.md'), { mode: 0o600 });
  const statePath = path.join(home, '.agent-fit/state.json'); await fs.rename(statePath, path.join(outside, 'state.json')); await fs.symlink(path.join(outside, 'state.json'), statePath);
  await assert.rejects(readSnapshot(home), { code: 'UNSAFE_PATH' });
});

test('shared update failure rolls back, while a concurrent edit is preserved and reported partial', async () => {
  const { home } = await fixture(); await legacyInstallation(home); await mutate(home, 'setup');
  const snapshot = await readSnapshot(home), before = await tree(sharedSkillPath());
  setSkillTestHooks({ beforeWrite(relative, count) { if (count === 2) throw new Error('injected static update failure'); } });
  await assert.rejects(updateSkill(home, { legacyState: snapshot.state }), /injected static update failure/);
  assert.deepEqual(await tree(sharedSkillPath()), before);
  let first;
  setSkillTestHooks({ async beforeWrite(relative, count) { if (count === 0) first = relative; if (count === 2) { await fs.writeFile(path.join(sharedSkillPath(), first), 'user concurrency'); throw new Error('injected failure'); } } });
  await assert.rejects(updateSkill(home, { legacyState: snapshot.state }), { code: 'SKILL_UPDATE_PARTIAL' });
  assert.equal(await fs.readFile(path.join(sharedSkillPath(), first), 'utf8'), 'user concurrency');
  const after = await tree(sharedSkillPath()); for (const name of Object.keys(before)) if (name !== first) assert.deepEqual(after[name], before[name]);
});

test('shared updater preserves a replaced lock and refuses competing updates', async () => {
  const { home } = await fixture(); await legacyInstallation(home); await mutate(home, 'setup');
  const snapshot = await readSnapshot(home), before = await tree(sharedSkillPath());
  const lock = path.join(path.dirname(sharedSkillPath()), '.agent-fit-skill.lock');
  await fs.writeFile(lock, 'another updater');
  await assert.rejects(updateSkill(home, { legacyState: snapshot.state }), { code: 'BUSY' });
  assert.deepEqual(await tree(sharedSkillPath()), before); await fs.unlink(lock);
  let replacement;
  setSkillTestHooks({ async beforeWrite(relative, count) { if (count === 0) { replacement = `${lock}.new`; await fs.writeFile(replacement, 'new writer'); await fs.rename(replacement, lock); } } });
  await assert.rejects(updateSkill(home, { legacyState: snapshot.state }), { code: 'BUSY' });
  assert.equal(await fs.readFile(lock, 'utf8'), 'new writer'); assert.deepEqual(await tree(sharedSkillPath()), before);
  await fs.unlink(lock);
});

test('shared installation rejects a linked parent before creating anything outside', async () => {
  const { root, home } = await fixture(); const outside = path.join(root, 'outside'); await fs.mkdir(outside);
  const agents = path.join(os.homedir(), '.agents'); await fs.rm(agents, { recursive: true, force: true }); await fs.symlink(outside, agents);
  try {
    await assert.rejects(updateSkill(home, { dryRun: true }), { code: 'UNSAFE_PATH' });
    await assert.rejects(updateSkill(home), { code: 'UNSAFE_PATH' });
    assert.deepEqual(await fs.readdir(outside), []);
  } finally { await fs.unlink(agents); }
});

test('setup reports a committed home when shared install fails, and retry completes it', async () => {
  const { home } = await fixture(); const parent = path.dirname(sharedSkillPath()); await fs.mkdir(parent, { recursive: true });
  const lock = path.join(parent, '.agent-fit-skill.lock'); await fs.writeFile(lock, 'another updater');
  await assert.rejects(mutate(home, 'setup'), error => error.code === 'BUSY' && error.details.report.configuration_status === 'written' && error.details.report.restart.required === true);
  assert.equal((await readSnapshot(home)).state.schema_version, 3);
  await fs.unlink(lock);
  const report = await mutate(home, 'setup'); assert.equal(report.shared_skill.result, 'applied'); assert.equal(report.restart.required, true);
  assert.ok((await inspectSkill(home)).path);
});

test('different old and shared snapshots block migration without choosing by timestamps', async () => {
  const { home } = await fixture(); await legacyInstallation(home, 'legacy');
  await fs.mkdir(path.dirname(sharedSkillPath()), { recursive: true }); await fs.cp(path.join(home, 'skills/agent-fit'), sharedSkillPath(), { recursive: true });
  const file = path.join(sharedSkillPath(), 'references/current-mode.json'), mode = JSON.parse(await fs.readFile(file)); mode.levels.L1.model = 'different-home'; await fs.writeFile(file, JSON.stringify(mode));
  const before = await tree(home), shared = await tree(sharedSkillPath());
  await assert.rejects(mutate(home, 'setup'), { code: 'MIGRATION_CONFLICT' });
  assert.deepEqual(await tree(home), before); assert.deepEqual(await tree(sharedSkillPath()), shared);
});

test('unavailable shared rules do not block restoring a home or expose linked file contents', async () => {
  const { home } = await fixture(); await mutate(home, 'setup');
  const entry = path.join(sharedSkillPath(), 'SKILL.md'); await fs.unlink(entry); await fs.symlink('/etc/passwd', entry);
  const report = await statusReport(home); assert.equal(report.mode.id, 'official'); assert.ok(report.diagnostics.some(value => value.code === 'SKILL_UNAVAILABLE'));
  assert.equal(cli(home, ['skill', 'path']).code, 1);
  await mutate(home, 'restore', { expectRevision: report.configuration_revision });
  assert.equal((await fs.lstat(entry)).isSymbolicLink(), true);
  assert.equal(await fs.stat(path.join(home, '.agent-fit/state.json')).catch(() => null), null);
});
