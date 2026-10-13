import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mutate, readSnapshot, statusReport, setTestHooks, resolveHome } from '../lib/install.mjs';
import { renderPayload, resolveDefinition, PACKAGE_ROOT } from '../lib/codex.mjs';

const temporary = [];
afterEach(async () => { setTestHooks(); await Promise.all(temporary.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))); });
async function fixture() { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delegation-restore-')); temporary.push(directory); return { directory, home: path.join(directory, 'home') }; }
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
async function restoreRecord(home) { return JSON.parse(await fs.readFile(path.join(home, '.subagent-delegation/restore.json'), 'utf8')); }
async function alterBaseline(home, edit) {
  const target = path.join(home, '.subagent-delegation/restore.json'); const baseline = await restoreRecord(home); edit(baseline); const bytes = Buffer.from(JSON.stringify(baseline)); await fs.writeFile(target, bytes);
  const stateTarget = path.join(home, '.subagent-delegation/state.json'); const state = JSON.parse(await fs.readFile(stateTarget, 'utf8')); state.restoration.baseline_sha256 = createHash('sha256').update(bytes).digest('hex'); await fs.writeFile(stateTarget, JSON.stringify(state));
}

test('uninstalled restore and dry runs never create home or lock', async () => {
  const { home } = await fixture();
  assert.equal((await mutate(home, 'restore')).result, 'unchanged'); const report = await mutate(home, 'restore', { dryRun: true }); assert.equal(report.result, 'preview'); assert.equal(report.changed_files.length, 0);
  assert.equal(await fs.stat(home).catch(() => null), null);
});

test('first baseline restores exact AGENTS bytes and original mode across multiple switches', async () => {
  for (const original of [null, '', 'user', 'user\n', 'user\r\n', 'user\n\n']) {
    const { home } = await fixture(); await fs.mkdir(home);
    if (original !== null) { await fs.writeFile(path.join(home, 'AGENTS.md'), original); await fs.chmod(path.join(home, 'AGENTS.md'), 0o640); }
    const before = await tree(home); await mutate(home, 'setup'); await mutate(home, 'set', { mode: 'economy' }); await mutate(home, 'set', { mode: 'performance' });
    const preview = await mutate(home, 'restore', { dryRun: true }); assert.equal(preview.result, 'preview'); assert.ok(preview.changed_files.includes('.subagent-delegation/restore.json'));
    const report = await mutate(home, 'restore'); assert.equal(report.result, 'applied'); assert.equal(report.restart.required, true); assert.equal(report.post_check.status, 'not_requested'); assert.match(report.restart.message, /原配置已恢复/);
    assert.deepEqual(await tree(home), before); assert.equal((await statusReport(home)).installation, 'not_installed'); assert.equal(report.revision_after, (await readSnapshot(home)).configuration_revision);
    assert.equal((await mutate(home, 'restore')).result, 'unchanged');
  }
});

test('existing same public assets and rule block are restored with their original permissions', async () => {
  const { home } = await fixture(); await fs.mkdir(path.join(home, 'agents'), { recursive: true });
  const payload = await renderPayload(resolveHome(home), resolveDefinition('balanced'));
  const role = 'agents/task-scan.toml'; await fs.writeFile(path.join(home, role), payload.files.get(role)); await fs.chmod(path.join(home, role), 0o644);
  await fs.writeFile(path.join(home, 'AGENTS.md'), Buffer.concat([Buffer.from('user\n\n'), payload.block, Buffer.from('\nOriginal suffix\n')])); await fs.chmod(path.join(home, 'AGENTS.md'), 0o640);
  const before = await tree(home); await mutate(home, 'setup'); await mutate(home, 'set', { mode: 'performance' }); await mutate(home, 'restore'); assert.deepEqual(await tree(home), before);
});

test('restore clears all custom modes and tool metadata, while preserving new user files and unrelated config', async () => {
  const { home } = await fixture(); await fs.mkdir(home); const config = 'model = "private"\n'; await fs.writeFile(path.join(home, 'config.toml'), config); await mutate(home, 'setup');
  await mutate(home, 'create', { name: 'one' }); await mutate(home, 'create', { name: 'two' }); await mutate(home, 'set', { mode: 'one' });
  await fs.writeFile(path.join(home, 'skills/subagent-model-selection/user-notes.md'), 'user notes'); await fs.writeFile(path.join(home, 'agents/user-role.toml'), 'name = "user-role"\n');
  const dryBefore = await tree(home); const preview = await mutate(home, 'restore', { dryRun: true }); assert.deepEqual(preview.custom_modes_removed, ['one', 'two']); assert.deepEqual(await tree(home), dryBefore);
  const report = await mutate(home, 'restore'); assert.deepEqual(report.custom_modes_removed, ['one', 'two']);
  assert.equal(await fs.readFile(path.join(home, 'config.toml'), 'utf8'), config); assert.equal(await fs.readFile(path.join(home, 'skills/subagent-model-selection/user-notes.md'), 'utf8'), 'user notes'); assert.equal(await fs.readFile(path.join(home, 'agents/user-role.toml'), 'utf8'), 'name = "user-role"\n');
  assert.equal(await fs.stat(path.join(home, '.subagent-delegation')).catch(() => null), null); assert.equal(await fs.stat(path.join(home, 'AGENTS.md')).catch(() => null), null);
});

test('outside AGENTS user edits remain and original missing AGENTS is kept when it gained user content', async () => {
  for (const original of [null, 'before\n']) {
    const { home } = await fixture(); if (original !== null) { await fs.mkdir(home); await fs.writeFile(path.join(home, 'AGENTS.md'), original); }
    await mutate(home, 'setup'); await fs.appendFile(path.join(home, 'AGENTS.md'), '\nUser-added instructions\n');
    const report = await mutate(home, 'restore'); const restored = await fs.readFile(path.join(home, 'AGENTS.md'), 'utf8'); assert.ok(restored.includes('User-added instructions')); assert.ok(!restored.includes('subagent-delegation:start')); if (original) assert.ok(restored.startsWith(original));
    if (original) assert.ok(report.warnings.length > 0);
  }
});

test('restore ignores unrelated invalid configurations, same-name user roles and override contents', async () => {
  const { home } = await fixture(); await mutate(home, 'setup');
  await fs.writeFile(path.join(home, 'config.toml'), 'not valid TOML "private token TEST_ONLY_NOT_REAL'); await fs.writeFile(path.join(home, 'agents/user.toml'), 'not valid TOML'); await fs.writeFile(path.join(home, 'agents/conflict.toml'), 'name = "task_scan"\n'); await fs.writeFile(path.join(home, 'AGENTS.override.md'), 'user override');
  await mutate(home, 'restore'); assert.equal(await fs.readFile(path.join(home, 'config.toml'), 'utf8'), 'not valid TOML "private token TEST_ONLY_NOT_REAL'); assert.equal(await fs.readFile(path.join(home, 'agents/user.toml'), 'utf8'), 'not valid TOML'); assert.equal(await fs.readFile(path.join(home, 'agents/conflict.toml'), 'utf8'), 'name = "task_scan"\n'); assert.equal(await fs.readFile(path.join(home, 'AGENTS.override.md'), 'utf8'), 'user override');
});

test('missing, corrupt or chmod-changed baseline blocks restore and every mutation before writes', async () => {
  for (const edit of [
    async home => fs.unlink(path.join(home, '.subagent-delegation/restore.json')),
    async home => fs.appendFile(path.join(home, '.subagent-delegation/restore.json'), 'corrupt'),
    async home => fs.chmod(path.join(home, '.subagent-delegation/restore.json'), 0o644),
  ]) {
    const { home } = await fixture(); await mutate(home, 'setup'); await edit(home); const before = await tree(home);
    for (const action of ['restore', 'setup', 'set', 'create', 'configure']) await assert.rejects(mutate(home, action, { mode: 'economy', name: 'test' }), error => error.code === 'RESTORE_METADATA_INVALID');
    assert.deepEqual(await tree(home), before);
  }
});

test('malicious restore paths, invalid bytes, unknown fields and arbitrary directories are rejected even with matching metadata hash', async () => {
  for (const edit of [
    baseline => { baseline.entries['../private'] = null; },
    baseline => { baseline.entries['agents/task-scan.toml'] = { bytes_base64: 'not base64!', sha256: '0'.repeat(64), mode: 0o600 }; },
    baseline => { baseline.private = 'unknown field'; },
    baseline => { baseline.created_directories.push('private-user-directory'); },
    baseline => { baseline.entries['agents/task-scan.toml'] = { bytes_base64: '', sha256: '0'.repeat(64), mode: 0o600 }; },
  ]) {
    const { home } = await fixture(); await mutate(home, 'setup'); await alterBaseline(home, edit); const before = await tree(home);
    await assert.rejects(mutate(home, 'restore'), error => error.code === 'RESTORE_METADATA_INVALID'); assert.deepEqual(await tree(home), before);
  }
});

test('managed drift, removed files, chmod and state chmod refuse restore with all contents preserved', async () => {
  for (const edit of [
    async home => fs.appendFile(path.join(home, 'agents/task-review.toml'), '\n# User edit\n'),
    async home => fs.unlink(path.join(home, 'agents/task-scan.toml')),
    async home => fs.chmod(path.join(home, 'skills/subagent-model-selection/SKILL.md'), 0o644),
    async home => fs.chmod(path.join(home, '.subagent-delegation/state.json'), 0o644),
  ]) {
    const { home } = await fixture(); await mutate(home, 'setup'); await edit(home); const before = await tree(home);
    await assert.rejects(mutate(home, 'restore'), error => error.code === 'RESTORE_CONFLICT'); assert.deepEqual(await tree(home), before);
  }
});

test('orphan restore metadata and malformed markers never get mistaken for uninstalled no-op', async () => {
  const { home } = await fixture(); await mutate(home, 'setup'); await fs.unlink(path.join(home, '.subagent-delegation/state.json')); const before = await tree(home);
  await assert.rejects(mutate(home, 'restore'), error => error.code === 'RESTORE_METADATA_INVALID'); await assert.rejects(mutate(home, 'setup'), error => error.code === 'RESTORE_METADATA_INVALID'); assert.deepEqual(await tree(home), before);
  const { home: home2 } = await fixture(); await mutate(home2, 'setup'); await fs.appendFile(path.join(home2, 'AGENTS.md'), '<!-- subagent-delegation:start -->\n'); const before2 = await tree(home2); await assert.rejects(mutate(home2, 'restore'), error => error.code === 'RULES_INVALID'); assert.deepEqual(await tree(home2), before2);
});

test('third restore write failure restores complete pre-restore installation and metadata', async () => {
  const { home } = await fixture(); await mutate(home, 'setup'); const before = await tree(home);
  setTestHooks({ beforeWrite(relative, change, count) { if (count === 2) throw new Error('Fail restore'); } });
  await assert.rejects(mutate(home, 'restore'), error => error.details.report.configuration_status === 'rolled_back' && error.details.report.restart.required === false); assert.deepEqual(await tree(home), before);
});

test('restore rollback preserves concurrent edit and continues other safe restores', async () => {
  const { home } = await fixture(); await mutate(home, 'setup'); const before = await tree(home); let concurrent;
  setTestHooks({ async beforeWrite(relative, change, count) { if (count === 0) concurrent = relative; if (count === 3) { await fs.writeFile(path.join(home, concurrent), 'user concurrency'); throw new Error('Fail restore'); } } });
  await assert.rejects(mutate(home, 'restore'), error => { assert.equal(error.details.report.configuration_status, 'partial'); assert.equal(error.details.report.restart.required, null); assert.ok(error.details.report.rollback_failures.includes(path.join(resolveHome(home), concurrent))); return true; });
  const after = await tree(home); for (const relative of Object.keys(before)) if (relative !== concurrent) assert.deepEqual(after[relative], before[relative]); assert.equal(await fs.readFile(path.join(home, concurrent), 'utf8'), 'user concurrency'); assert.ok(after['.subagent-delegation/restore.json']);
});

test('restore rollback failure leaves safe metadata and rolls back every other safe file', async () => {
  const { home } = await fixture(); await mutate(home, 'setup'); const before = await tree(home); let failed;
  setTestHooks({ beforeWrite(relative, change, count) { if (count === 0) failed = relative; if (count === 3) throw new Error('Fail restore'); }, beforeRollback(relative) { if (relative === failed) throw new Error('Fail rollback'); } });
  await assert.rejects(mutate(home, 'restore'), error => error.details.report.configuration_status === 'partial'); const after = await tree(home); for (const relative of Object.keys(before)) if (relative !== failed) assert.deepEqual(after[relative], before[relative]); assert.ok(after['.subagent-delegation/restore.json']); assert.ok(after['.subagent-delegation/state.json']);
});

test('restore deletes metadata after managed files, status sees BUSY during transaction, and cleanup happens after unlock', async () => {
  const { home } = await fixture(); await mutate(home, 'setup'); const written = [];
  setTestHooks({ async afterWrite(relative) { written.push(relative); await assert.rejects(statusReport(home), error => error.code === 'BUSY'); } });
  await mutate(home, 'restore'); assert.deepEqual(written.slice(-2), ['.subagent-delegation/restore.json', '.subagent-delegation/state.json']); assert.equal(await fs.stat(path.join(home, '.subagent-delegation')).catch(() => null), null); assert.ok(await fs.stat(home));
});

test('restore and reinstall changes instance id to defeat ABA stale revisions', async () => {
  const { home } = await fixture(); await mutate(home, 'setup'); const first = await readSnapshot(home); await mutate(home, 'restore'); await mutate(home, 'setup'); const second = await readSnapshot(home);
  assert.notEqual(first.state.instance_id, second.state.instance_id); assert.notEqual(first.configuration_revision, second.configuration_revision);
  await assert.rejects(mutate(home, 'set', { mode: 'economy', expectRevision: first.configuration_revision }), error => error.code === 'CONFIG_CHANGED');
});

// The copy is a local release fixture; package assets under test remain untouched.
test('upgrade records new paths, retires obsolete assets and restores first values across releases', async () => {
  const { home, directory } = await fixture(); const release = path.join(directory, 'release'); await fs.mkdir(release);
  for (const relative of ['lib', 'adapters']) await fs.cp(path.join(PACKAGE_ROOT, relative), path.join(release, relative), { recursive: true });
  await fs.copyFile(path.join(PACKAGE_ROOT, 'VERSION'), path.join(release, 'VERSION')); await fs.writeFile(path.join(release, 'package.json'), '{"type":"module"}'); await fs.symlink(path.join(PACKAGE_ROOT, 'node_modules'), path.join(release, 'node_modules'));
  const obsolete = 'skills/subagent-model-selection/retired/obsolete.txt';
  await fs.mkdir(path.join(release, 'adapters/codex/skills/subagent-model-selection/retired')); await fs.writeFile(path.join(release, 'adapters/codex/skills/subagent-model-selection/retired/obsolete.txt'), 'public obsolete');
  await fs.mkdir(path.dirname(path.join(home, obsolete)), { recursive: true }); await fs.writeFile(path.join(home, obsolete), 'public obsolete'); await fs.chmod(path.join(home, obsolete), 0o640);
  const original = await import(`${new URL(`file://${path.join(release, 'lib/install.mjs')}`).href}?first`); await original.mutate(home, 'setup'); const firstBaseline = await restoreRecord(home);
  await fs.unlink(path.join(release, 'adapters/codex/skills/subagent-model-selection/retired/obsolete.txt')); await fs.writeFile(path.join(release, 'adapters/codex/skills/subagent-model-selection/new-public.txt'), 'new public');
  await fs.writeFile(path.join(release, 'VERSION'), '0.2.1\n');
  await fs.copyFile(path.join(release, 'lib/codex.mjs'), path.join(release, 'lib/codex-upgraded.mjs'));
  await fs.writeFile(path.join(release, 'lib/install-upgraded.mjs'), (await fs.readFile(path.join(release, 'lib/install.mjs'), 'utf8')).replace("from './codex.mjs'", "from './codex-upgraded.mjs'"));
  const upgraded = await import(new URL(`file://${path.join(release, 'lib/install-upgraded.mjs')}`).href); await upgraded.mutate(home, 'setup'); const second = await upgraded.readSnapshot(home);
  assert.equal(second.state.version, '0.2.1'); assert.ok(second.state.restoration.retired_paths.includes(obsolete)); assert.deepEqual(second.baseline.entries[obsolete], firstBaseline.entries[obsolete]); assert.equal(second.baseline.entries['skills/subagent-model-selection/new-public.txt'], null);
  await fs.writeFile(path.join(home, obsolete), 'user recreation'); await assert.rejects(upgraded.mutate(home, 'restore'), error => error.code === 'RESTORE_CONFLICT'); await fs.unlink(path.join(home, obsolete)); await fs.rmdir(path.dirname(path.join(home, obsolete)));
  await upgraded.mutate(home, 'restore'); assert.deepEqual(await tree(home), { [obsolete]: { bytes: Buffer.from('public obsolete').toString('base64'), mode: 0o640 } });
});

test('new lock after committed restore preserves success and removes signal listeners even when final observation is BUSY', async () => {
  const { home } = await fixture(); await mutate(home, 'setup'); const listeners = process.listenerCount('SIGINT');
  setTestHooks({ async beforeCleanup() { await fs.writeFile(path.join(home, '.subagent-delegation/install.lock'), 'new writer'); } });
  const report = await mutate(home, 'restore'); assert.equal(report.result, 'applied'); assert.equal(report.configuration_status, 'written'); assert.equal(report.restart.required, true); assert.equal(report.revision_after, null); assert.ok(report.warnings.length); assert.equal(process.listenerCount('SIGINT'), listeners);
  assert.equal(await fs.readFile(path.join(home, '.subagent-delegation/install.lock'), 'utf8'), 'new writer'); assert.equal(await fs.stat(path.join(home, 'agents/task-scan.toml')).catch(() => null), null);
});

test('restore detects a deleted file recreated during the transaction and rolls back other safe files', async () => {
  const { home } = await fixture(); await mutate(home, 'setup'); const before = await tree(home); let recreated;
  setTestHooks({ async afterWrite(relative, change) { if (!recreated && change.after === null) { recreated = relative; await fs.writeFile(path.join(home, relative), 'user recreation during restore'); } } });
  await assert.rejects(mutate(home, 'restore'), error => error.details.report.configuration_status === 'partial' && error.details.report.restart.required === null);
  const after = await tree(home); assert.equal(await fs.readFile(path.join(home, recreated), 'utf8'), 'user recreation during restore'); for (const relative of Object.keys(before)) if (relative !== recreated) assert.deepEqual(after[relative], before[relative]);
});
