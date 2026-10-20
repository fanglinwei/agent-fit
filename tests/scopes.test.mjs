import './isolate-home.mjs';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mutate, readSnapshot, showReport, listReport, statusReport, setTestHooks } from '../lib/install.mjs';
import { scopeContext, scopedSelection, SCOPE_FILE } from '../lib/scopes.mjs';
import { checkAccountModels } from '../lib/models.mjs';

const directories = [];
afterEach(async () => { setTestHooks(); await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'delegation-scopes-')));
  directories.push(directory);
  const home = path.join(directory, 'home'), project = path.join(directory, 'a'), other = path.join(directory, 'b');
  await fs.mkdir(project); await fs.mkdir(other); await mutate(home, 'setup');
  return { home, project, other };
}
const cli = (home, args) => {
  const result = spawnSync(process.execPath, ['bin/agent-fit.mjs', ...args, `--codex-home=${home}`, '--json'], { encoding: 'utf8' });
  return { code: result.status, ...JSON.parse(result.stdout) };
};

test('session > project > global, threads and projects isolate, clearing restores whole inherited profile', async () => {
  const { home, project, other } = await fixture();
  const a = { scope: 'project', project }, chat = { scope: 'session', project, thread: 'chat-a' };
  const initialRevision = (await readSnapshot(home)).configuration_revision;
  assert.equal((await mutate(home, 'clear', chat)).result, 'unchanged');
  assert.equal((await readSnapshot(home)).configuration_revision, initialRevision);
  const role = await fs.readFile(path.join(home, 'agents/task-execute.toml'));
  for (const options of [{ ...a, mode: 'cut' }, { ...chat, mode: 'high' }]) {
    const report = await mutate(home, 'set', options);
    assert.equal(report.restart.required, false); assert.match(report.restart.message, /无需重启/);
  }
  assert.equal((await showReport(home, undefined, chat)).definition.id, 'high');
  const inherited = await showReport(home, undefined, { ...chat, thread: 'chat-b' });
  assert.equal(inherited.definition.id, 'cut'); assert.equal(inherited.effective_scope, 'project'); assert.equal(inherited.inherited, true);
  assert.equal((await showReport(home, undefined, { ...a, project: other })).definition.id, 'official');
  assert.deepEqual(await fs.readFile(path.join(home, 'agents/task-execute.toml')), role);
  assert.equal((await readSnapshot(home)).mode.id, 'official');
  const report = await mutate(home, 'clear', chat);
  assert.equal(report.restart.required, false); assert.equal(report.scope, 'session');
  assert.equal((await showReport(home, undefined, chat)).definition.id, 'cut');
  await mutate(home, 'clear', a);
  assert.equal((await showReport(home, undefined, chat)).definition.id, 'official');
  assert.equal((await statusReport(home, chat)).effective_scope, 'global');
});

test('scope definitions are visible downwards; editing an inherited custom copies and preserves the original', async () => {
  const { home, project, other } = await fixture();
  await mutate(home, 'create', { name: 'shared', from: 'cut' });
  await mutate(home, 'set', { mode: 'shared' });
  const before = (await showReport(home, 'shared')).definition;
  const context = { scope: 'project', project };
  const result = await mutate(home, 'configure', { ...context, mode: 'shared', level: 'L2', model: 'project-model', effort: 'high' });
  assert.ok(result.created_mode); assert.notEqual(result.created_mode.id, before.id);
  const local = (await showReport(home, undefined, context)).definition;
  assert.equal(local.id, result.created_mode.id); assert.equal(local.levels.L2.model, 'project-model');
  assert.deepEqual(local.levels.L1, before.levels.L1); assert.equal(local.levels.L2.fallback, null);
  assert.deepEqual((await showReport(home, 'shared')).definition.levels, before.levels);
  const chat = { scope: 'session', project, thread: 'chat-a' };
  assert.ok((await listReport(home, chat)).modes.some(mode => mode.id === local.id));
  assert.ok(!(await listReport(home, { ...context, project: other })).modes.some(mode => mode.id === local.id));
  const saved = await mutate(home, 'create', { ...chat, name: 'private', from: local.id });
  assert.ok(!(await listReport(home, { ...chat, thread: 'chat-b' })).modes.some(mode => mode.id === saved.created_mode.id));
  await mutate(home, 'clear', context);
  assert.ok((await listReport(home, context)).modes.some(mode => mode.id === local.id));
});

test('delete blocks references from every scope; clear does not delete definitions; restore removes scope data', async () => {
  const { home, project } = await fixture();
  const custom = await mutate(home, 'create', { name: 'global-custom' });
  const chat = { scope: 'session', project, thread: 'chat-a' };
  await mutate(home, 'set', { ...chat, mode: custom.created_mode.id });
  await assert.rejects(mutate(home, 'delete', { mode: custom.created_mode.id }), { code: 'MODE_IN_USE' });
  await assert.rejects(mutate(home, 'delete', { ...chat, mode: custom.created_mode.id }), { code: 'SCOPE_READ_ONLY' });
  await mutate(home, 'clear', chat);
  await mutate(home, 'delete', { mode: custom.created_mode.id });
  assert.ok(!(await listReport(home, chat)).modes.some(mode => mode.id === custom.created_mode.id));
  await mutate(home, 'create', { ...chat, name: 'local-only' });
  const restored = await mutate(home, 'restore');
  assert.deepEqual(restored.custom_modes_removed, ['local-only']);
  assert.equal(await fs.stat(path.join(home, SCOPE_FILE)).catch(() => null), null);
  assert.equal((await readSnapshot(home)).state, null);
});

test('scope writes use preview, revision checks, permissions, lock and rollback without changing global roles', async () => {
  const { home, project } = await fixture();
  const options = { scope: 'project', project, mode: 'high' };
  const revision = (await readSnapshot(home)).configuration_revision;
  const preview = await mutate(home, 'set', { ...options, dryRun: true, expectRevision: revision });
  assert.equal(preview.result, 'preview');
  assert.equal(await fs.stat(path.join(home, SCOPE_FILE)).catch(() => null), null);
  setTestHooks({ beforeWrite(relative) { if (relative.endsWith('/state.json')) throw new Error('injected'); } });
  await assert.rejects(mutate(home, 'set', options), error => error.details.report.configuration_status === 'rolled_back');
  assert.equal((await readSnapshot(home)).configuration_revision, revision);
  setTestHooks(); await mutate(home, 'set', options);
  assert.equal((await fs.stat(path.join(home, SCOPE_FILE))).mode & 0o777, 0o600);
  await assert.rejects(mutate(home, 'set', { ...options, mode: 'cut', expectRevision: revision }), { code: 'CONFIG_CHANGED' });
  await fs.writeFile(path.join(home, '.agent-fit/install.lock'), '');
  await assert.rejects(mutate(home, 'clear', options), { code: 'BUSY' });
});

test('CLI resolves session profiles with explicit generic dispatch and a complete task snapshot', async () => {
  const { home, project } = await fixture();
  assert.equal(cli(home, ['mode', 'set', 'high', '--scope=session', `--project=${project}`, '--thread=chat-a']).code, 0);
  const query = ['explain', '--level=L2', '--role=task_execute', '--scope=session', `--project=${project}`, '--thread=chat-a'];
  const before = cli(home, query);
  assert.equal(before.code, 0); assert.deepEqual(before.errors, []);
  assert.equal(before.data.mode_id, 'high'); assert.equal(before.data.effective_scope, 'session');
  assert.equal(before.data.dispatch_role, 'task_delegate');
  assert.equal(before.data.task_profile.levels.L4.model, 'gpt-6-astra');
  await mutate(home, 'set', { scope: 'session', project, thread: 'chat-a', mode: 'cut' });
  assert.equal(before.data.task_profile.id, 'high'); assert.equal(cli(home, query).data.mode_id, 'cut');
  const restored = cli(home, ['mode', 'show', '--scope=session', `--project=${project}`, '--thread=chat-a']);
  assert.equal(restored.data.definition.id, 'cut');
  const fresh = cli(home, ['mode', 'show', '--scope=session', `--project=${project}`, '--thread=forked-chat']);
  assert.equal(fresh.data.definition.id, 'official');
});

test('invalid references and unsupported store versions fail explicitly; model checks do not probe', async () => {
  const { home, project } = await fixture();
  await mutate(home, 'set', { scope: 'project', project, mode: 'cut' });
  const snapshot = await readSnapshot(home);
  snapshot.scopeStore.projects[0].selection = 'deleted-profile';
  assert.throws(() => scopedSelection(snapshot, { scope: 'project', project, thread: null }), { code: 'SCOPE_REFERENCE_INVALID' });
  assert.equal(scopedSelection(snapshot, { scope: 'global', project, thread: null }).definition.id, 'official');
  let started = 0;
  const check = await checkAccountModels({ home, scope: 'project', project, verify: true }, { readSnapshot: async () => snapshot, spawn() { started++; throw new Error(); } });
  assert.equal(check.exit_code, 1); assert.equal(started, 0); assert.deepEqual(check.checked_pairs, []);
  const store = JSON.parse(await fs.readFile(path.join(home, SCOPE_FILE), 'utf8'));
  store.schema_version = 999; await fs.writeFile(path.join(home, SCOPE_FILE), JSON.stringify(store));
  assert.equal(cli(home, ['explain', '--level=L2', '--scope=project', `--project=${project}`]).errors[0].code, 'SCOPE_CONFIG_INVALID');
});

test('project roots canonicalize Git subdirectories and missing thread context never becomes global', async () => {
  const root = await scopeContext({ scope: 'project', project: process.cwd() });
  const nested = await scopeContext({ scope: 'project', project: path.join(process.cwd(), 'lib') });
  assert.equal(root.project, nested.project);
  await assert.rejects(scopeContext({ scope: 'session', thread: '', project: process.cwd() }), error => error.exitCode === 2);
});
