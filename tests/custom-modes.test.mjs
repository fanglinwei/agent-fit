import './isolate-home.mjs';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mutate, readSnapshot, showReport, listReport, setTestHooks } from '../lib/install.mjs';
import { LEVELS, resolveDefinition } from '../lib/codex.mjs';

const temporary = [];
afterEach(async () => { setTestHooks(); await Promise.all(temporary.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))); });
async function fixture() { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delegation-custom-')); temporary.push(directory); const home = path.join(directory, 'home'); await mutate(home, 'setup'); return home; }
const canonicalDefinition = () => ({ levels: structuredClone(resolveDefinition('official').levels) });
async function managed(home) { const snapshot = await readSnapshot(home); return Object.fromEntries(await Promise.all([...Object.keys(snapshot.state.files), 'AGENTS.md', '.agent-fit/state.json', '.agent-fit/restore.json'].map(async relative => [relative, (await fs.readFile(path.join(home, relative))).toString('base64')]))); }

test('create copies complete source by value without activating and extends first baseline only for custom metadata', async () => {
  const home = await fixture(); const initial = await readSnapshot(home), baseline = initial.baseline;
  const report = await mutate(home, 'create', { name: '我的四级档位', from: 'fire' });
  assert.equal(report.result, 'applied'); assert.equal(report.restart.required, false); assert.equal(report.restart.reason, 'definition_only');
  assert.equal((await readSnapshot(home)).mode.id, 'official');
  const custom = (await listReport(home)).modes.find(mode => mode.name === '我的四级档位'); assert.match(custom.id, /^custom-/); assert.deepEqual(custom.levels, resolveDefinition('fire').levels);
  const after = await readSnapshot(home); assert.equal(after.baseline.entries['.agent-fit/custom-modes.json'], null);
  for (const [relative, before] of Object.entries(baseline.entries)) assert.deepEqual(after.baseline.entries[relative], before); assert.deepEqual(after.baseline.rules, baseline.rules);
  const showed = await showReport(home, custom.name); assert.equal(showed.active, false); assert.equal(showed.configuration_revision, (await listReport(home)).configuration_revision);
});

for (const scope of ['global', 'project', 'session']) test(`${scope} copies the displayed installed snapshot without adding package task candidates`, async () => {
  const home = await fixture();
  const relative = '.agent-fit/current-mode.json';
  const installed = JSON.parse(await fs.readFile(path.join(home, relative), 'utf8'));
  for (const level of LEVELS) delete installed.levels[level].tasks;
  const bytes = Buffer.from(JSON.stringify(installed));
  await fs.writeFile(path.join(home, relative), bytes);
  const statePath = path.join(home, '.agent-fit/state.json');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.files[relative] = createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(statePath, JSON.stringify(state));
  const options = { scope, project: path.dirname(home), thread: 'snapshot-copy-chat' };
  const source = await showReport(home, 'official', options);
  assert.deepEqual(source.diagnostics.filter(item => item.status === 'fail'), []);
  assert.equal(source.definition.levels.L1.tasks, undefined);
  assert.ok(resolveDefinition('official').levels.L1.tasks.mechanical);
  const before = await managed(home);
  await mutate(home, 'create', { ...options, name: 'preview-copy', from: 'official', dryRun: true });
  assert.deepEqual(await managed(home), before);
  for (const from of [undefined, 'official']) {
    const created = await mutate(home, 'create', { ...options, name: from ? 'explicit-copy' : 'default-copy', ...(from ? { from } : {}) });
    const copied = await showReport(home, created.created_mode.id, options);
    assert.deepEqual(copied.definition.levels, source.definition.levels);
    assert.equal(copied.active, false);
    assert.deepEqual((await showReport(home, undefined, options)).definition.levels, source.definition.levels);
  }
  const other = await mutate(home, 'create', { ...options, name: 'package-copy', from: 'cut' });
  assert.deepEqual((await showReport(home, other.created_mode.id, options)).definition.levels, resolveDefinition('cut').levels);
});

test('NFC names are unique, aliases cannot collide, and names remain data even with path separators', async () => {
  const home = await fixture(); await mutate(home, 'create', { name: '  Cafe\u0301  ' });
  assert.equal((await readSnapshot(home)).customModes[0].name, 'Café');
  for (const name of ['Café', '官方', 'cut', 'official', 'high', 'fire', '\u0000bad', '', 'x'.repeat(81)]) await assert.rejects(mutate(home, 'create', { name }), error => error.exitCode === 2);
  const id = (await readSnapshot(home)).customModes[0].id; await assert.rejects(mutate(home, 'create', { name: id }), error => error.exitCode === 2);
  await mutate(home, 'create', { name: '../data-only/name' });
  assert.equal((await readSnapshot(home)).customModes.length, 2); assert.equal(await fs.stat(path.join(path.dirname(home), 'data-only')).catch(() => null), null);
});

test('inactive configure changes only definition and metadata; primary changes clear old fallback unless specified', async () => {
  const home = await fixture(); await mutate(home, 'create', { name: 'custom', from: 'cut' });
  const role = await fs.readFile(path.join(home, 'agents/task-scan.toml'));
  const report = await mutate(home, 'configure', { mode: 'custom', level: 'L1', model: 'user-model', effort: 'custom-effort' });
  assert.equal(report.restart.required, false); assert.deepEqual(await fs.readFile(path.join(home, 'agents/task-scan.toml')), role);
  const custom = (await showReport(home, 'custom')).definition; assert.equal(custom.levels.L1.model, 'user-model'); assert.equal(custom.levels.L1.fallback, null);
  await mutate(home, 'configure', { mode: 'custom', level: 'L1', fallbackModel: 'backup', fallbackEffort: 'low' });
  const noChange = await mutate(home, 'configure', { mode: 'custom', level: 'L1', model: 'user-model', effort: 'custom-effort' }); assert.equal(noChange.result, 'unchanged');
  assert.deepEqual((await showReport(home, 'custom')).definition.levels.L1.fallback, { model: 'backup', effort: 'low' });
});

test('active custom atomic four-level configure updates deployed roles and mode record', async () => {
  const home = await fixture(); await mutate(home, 'create', { name: 'active' }); await mutate(home, 'set', { mode: 'active' });
  const definition = canonicalDefinition(); for (const level of LEVELS) definition.levels[level] = { model: `model-${level}`, effort: `effort-${level}`, fallback: null };
  const report = await mutate(home, 'configure', { mode: 'active', definition });
  assert.equal(report.restart.required, false); assert.equal(report.restart.reason, 'routing_changed');
  const current = await readSnapshot(home); assert.deepEqual(current.mode.levels, definition.levels); assert.equal(current.diagnostics.filter(value => value.status === 'fail').length, 0);
  const modeFile = JSON.parse(await fs.readFile(path.join(home, '.agent-fit/current-mode.json'), 'utf8')); assert.deepEqual(modeFile.levels, definition.levels);
  const role = await fs.readFile(path.join(home, 'agents/task-execute.toml'), 'utf8'); assert.ok(role.includes('model-L2')); assert.ok(role.includes('effort-L2'));
});

test('full-definition schema and paired fields reject invalid input without writing', async () => {
  const home = await fixture(); await mutate(home, 'create', { name: 'custom' }); const before = await managed(home);
  const missing = canonicalDefinition(); delete missing.levels.L4;
  const unknown = canonicalDefinition(); unknown.levels.L1.permissions = 'unrestricted';
  const sameFallback = canonicalDefinition(); sameFallback.levels.L2.fallback = { model: sameFallback.levels.L2.model, effort: sameFallback.levels.L2.effort };
  for (const options of [
    { definition: missing }, { definition: unknown }, { definition: { ...canonicalDefinition(), model: 'bad' } }, { definition: sameFallback },
    { level: 'L1', model: 'only-half' }, { level: 'L1', fallbackModel: 'only-half' }, { level: 'L1', clearFallback: true, fallbackModel: 'backup', fallbackEffort: 'low' },
    { definition: canonicalDefinition(), level: 'L1' }, { level: 'L5', model: 'model', effort: 'low' },
  ]) await assert.rejects(mutate(home, 'configure', { mode: 'custom', ...options }), error => error.exitCode === 2);
  await assert.rejects(mutate(home, 'configure', { mode: 'official', definition: canonicalDefinition() }), error => error.code === 'BUILTIN_READ_ONLY'); assert.deepEqual(await managed(home), before);
});

test('active configure failure rolls back definition and all deployment files together', async () => {
  const home = await fixture(); await mutate(home, 'create', { name: 'active' }); await mutate(home, 'set', { mode: 'active' }); const before = await managed(home);
  const definition = canonicalDefinition(); definition.levels.L2 = { model: 'changed-model', effort: 'changed-effort', fallback: null };
  setTestHooks({ beforeWrite(relative, change, count) { if (count === 2) throw new Error('Fail four-level apply'); } });
  await assert.rejects(mutate(home, 'configure', { mode: 'active', definition }), error => error.details.report.configuration_status === 'rolled_back'); assert.deepEqual(await managed(home), before);
});

test('setup preserves selected custom mode and all independent definitions', async () => {
  const home = await fixture(); await mutate(home, 'create', { name: 'first', from: 'cut' }); await mutate(home, 'create', { name: 'second', from: 'first' });
  await mutate(home, 'configure', { mode: 'first', level: 'L3', model: 'mine', effort: 'mine' });
  assert.notEqual((await showReport(home, 'second')).definition.levels.L3.model, 'mine'); await mutate(home, 'set', { mode: 'second' });
  const baseline = await fs.readFile(path.join(home, '.agent-fit/restore.json')); const report = await mutate(home, 'setup'); assert.equal(report.result, 'unchanged');
  assert.equal((await readSnapshot(home)).mode.name, 'second'); assert.equal((await readSnapshot(home)).customModes.length, 2); assert.deepEqual(await fs.readFile(path.join(home, '.agent-fit/restore.json')), baseline);
});

test('shadowed rules allow inactive save but block active configure', async () => {
  const home = await fixture(); await mutate(home, 'create', { name: 'inactive' }); await mutate(home, 'create', { name: 'active' }); await mutate(home, 'set', { mode: 'active' });
  await fs.writeFile(path.join(home, 'AGENTS.override.md'), 'user\n');
  assert.equal((await mutate(home, 'configure', { mode: 'inactive', level: 'L1', model: 'x', effort: 'low' })).restart.required, false);
  await assert.rejects(mutate(home, 'configure', { mode: 'active', level: 'L1', model: 'x', effort: 'low' }), error => error.code === 'RULES_SHADOWED');
});


test('protected custom metadata rejects id-name namespace collisions in either entry order', async () => {
  const home = await fixture(); await mutate(home, 'create', { name: 'first' }); await mutate(home, 'create', { name: 'second' });
  const snapshot = await readSnapshot(home), customPath = '.agent-fit/custom-modes.json', statePath = '.agent-fit/state.json';
  const original = JSON.parse(await fs.readFile(path.join(home, customPath), 'utf8'));
  const paths = [...Object.keys(snapshot.state.files), 'AGENTS.md', statePath, '.agent-fit/restore.json'];
  const bytes = async () => Object.fromEntries(await Promise.all(paths.map(async relative => [relative, (await fs.readFile(path.join(home, relative))).toString('base64')])));
  for (const order of ['id_before_name', 'name_before_id', 'own_id_name']) {
    const custom = structuredClone(original);
    if (order === 'own_id_name') custom.modes[0].name = custom.modes[0].id;
    else { custom.modes[1].name = custom.modes[0].id; if (order === 'name_before_id') custom.modes.reverse(); }
    const content = Buffer.from(JSON.stringify(custom)); await fs.writeFile(path.join(home, customPath), content);
    const state = structuredClone(snapshot.state); state.files[customPath] = createHash('sha256').update(content).digest('hex'); await fs.writeFile(path.join(home, statePath), JSON.stringify(state));
    const before = await bytes();
    await assert.rejects(readSnapshot(home), error => error.code === 'CUSTOM_MODES_INVALID');
    await assert.rejects(mutate(home, 'set', { mode: 'cut' }), error => error.code === 'CUSTOM_MODES_INVALID');
    assert.deepEqual(await bytes(), before);
  }
});
