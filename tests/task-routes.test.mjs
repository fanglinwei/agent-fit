import './isolate-home.mjs';
import bindings from '../adapters/codex/model-bindings.json' with { type: 'json' };
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { explainSelection, resolveDefinition, ROLES, validateDefinition } from '../lib/codex.mjs';
import { mutate, readSnapshot } from '../lib/install.mjs';

const cases = [
  ['L1', 'mechanical', bindings.economy, 'medium'],
  ['L2', 'bounded', bindings.economy, 'high'],
  ['L1', 'scan', bindings.economy, 'xhigh'],
  ['L1', 'deep', bindings.economy, 'max'],
  ['L3', 'complex', bindings.general, 'medium'],
  ['L3', 'uncertain', bindings.frontier, 'low'],
  ['L3', 'reasoning', bindings.frontier, 'medium'],
];

test('task candidates cover the task gradient without changing complexity or responsibility', () => {
  for (const mode of ['low', 'mid']) for (const [level, task, model, effort] of cases) {
    const selected = explainSelection({ definition: resolveDefinition(mode), level, task, role: 'task_review', active: true });
    assert.deepEqual(selected.primary, { model, effort }, `${mode}/${level}/${task}`);
    assert.equal(selected.level, level); assert.equal(selected.task, task);
    assert.equal(selected.permission_contract, 'readonly_review');
    if (model === bindings.frontier) assert.ok(['low', 'medium'].includes(effort));
  }
  const selected = explainSelection({ definition: resolveDefinition('mid'), level: 'L1', task: 'mechanical', role: 'task_scan', active: true });
  assert.equal(selected.dispatch_role, 'task_delegate', 'a fixed Luna/high role cannot run the medium candidate');
  for (const mode of ['low', 'mid']) for (const level of Object.values(resolveDefinition(mode).levels)) for (const candidate of Object.values(level.tasks ?? {})) {
    for (const pair of [candidate, candidate.fallback].filter(Boolean)) if (pair.model === bindings.frontier) assert.ok(['low', 'medium'].includes(pair.effort), 'ordinary candidates and fallbacks cannot bypass the Astra cap');
  }
});

test('the heigh profile keeps its maximum combinations and latency requires a configured candidate', () => {
  const definition = resolveDefinition('heigh');
  for (const selected of [false, true]) {
    const baseline = explainSelection({ definition, level: 'L3', selected });
    assert.equal(baseline.active, selected);
    assert.ok(baseline.reason_codes.includes(selected ? 'PROFILE_MAXIMUM_AUTHORIZED' : 'MAXIMUM_PROFILE_PREVIEW'));
    assert.equal(baseline.runtime_verification, 'unverified');
  }
  for (const task of ['uncertain', 'reasoning', 'visual', 'computer', 'writing']) {
    const selected = explainSelection({ definition, level: 'L3', task, selected: true });
    assert.deepEqual(selected.primary, { model: bindings.frontier, effort: 'ultra' });
    assert.ok(selected.reason_codes.includes('PROFILE_MAXIMUM_AUTHORIZED'));
    assert.ok(explainSelection({ definition, level: 'L3', task }).reason_codes.includes('MAXIMUM_PROFILE_PREVIEW'));
  }
  assert.throws(() => explainSelection({ definition: resolveDefinition('mid'), level: 'L3', task: 'mechanical' }));
  assert.throws(() => explainSelection({ definition: resolveDefinition('mid'), level: 'L1', task: 'latency' }), error => error.code === 'TASK_ROUTE_NOT_CONFIGURED');
  const custom = { ...resolveDefinition('mid'), id: 'custom-latency', kind: 'custom' };
  custom.levels.L1.tasks.latency = { model: 'explicit-terra-id', effort: 'high', fallback: null };
  const levels = validateDefinition({ levels: custom.levels });
  assert.deepEqual(explainSelection({ definition: { ...custom, levels }, level: 'L1', task: 'latency' }).primary, { model: 'explicit-terra-id', effort: 'high' });
  levels.L1.tasks.mechanical.fallback = { model: bindings.economy, effort: 'medium' };
  assert.throws(() => validateDefinition({ levels }));
});

test('candidate definitions reject invalid structures and do not invent missing snapshot routes', () => {
  const definition = resolveDefinition('mid');
  for (const tasks of [null, [], '{', { unknown: { model: 'x', effort: 'low', fallback: null } }, { uncertain: { model: bindings.frontier, effort: 'low', fallback: null } }, { mechanical: { model: 'x', effort: 'low' } }, { mechanical: { model: 'x', effort: 'low', fallback: null, instructions: 'unexpected' } }]) {
    const levels = structuredClone(definition.levels); levels.L1.tasks = tasks;
    assert.throws(() => validateDefinition({ levels }));
  }
  delete definition.levels.L1.tasks;
  assert.throws(() => explainSelection({ definition, level: 'L1', task: 'mechanical' }), error => error.code === 'TASK_ROUTE_NOT_CONFIGURED');
  assert.deepEqual(explainSelection({ definition, level: 'L1' }).primary, { model: bindings.economy, effort: 'high' });
  definition.levels.L1.tasks = {};
  assert.deepEqual(validateDefinition({ levels: definition.levels }).L1.tasks, {});
});

test('scoped CLI queries preserve all candidates in snapshots and custom edits preserve unrelated candidates', async t => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'agent-fit-task-routes-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  const home = path.join(project, 'home'); await mutate(home, 'setup');
  const options = { scope: 'session', project, thread: 'task-route-chat' };
  await mutate(home, 'create', { ...options, name: 'local', from: 'mid' });
  await mutate(home, 'set', { ...options, mode: 'local' });
  const cli = new URL('../bin/agent-fit.mjs', import.meta.url);
  const run = task => {
    const result = spawnSync(process.execPath, [cli.pathname, 'explain', '--level=L1', `--task=${task}`, '--role=task_scan', '--scope=session', `--project=${project}`, '--thread=task-route-chat', `--codex-home=${home}`, '--json'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout); const report = JSON.parse(result.stdout); assert.deepEqual(report.errors, []); return report.data;
  };
  const before = run('mechanical'); assert.equal(before.primary.effort, 'medium');
  assert.equal(before.effective_scope, 'session'); assert.equal(before.active, true); assert.equal(before.dispatch_role, 'task_delegate');
  await mutate(home, 'configure', { ...options, mode: 'local', level: 'L1', model: 'explicit-default', effort: 'low' });
  const after = run('mechanical');
  assert.equal(after.primary.effort, 'medium'); assert.equal(after.task_profile.levels.L1.model, 'explicit-default');
  assert.deepEqual(before.task_profile.levels.L1.tasks, after.task_profile.levels.L1.tasks);
  assert.notEqual(before.configuration_revision, after.configuration_revision);
  await mutate(home, 'restore');
});

test('custom candidate imports preserve unrelated routes without activating or borrowing a fallback', async t => {
  const definition = { levels: structuredClone(resolveDefinition('mid').levels) };
  const expected = structuredClone(resolveDefinition('mid').levels);
  for (const [level, task] of [['L2', 'bounded'], ['L3', 'complex']]) {
    definition.levels[level].tasks[task] = { model: 'custom-candidate', effort: 'medium', fallback: null };
    expected[level].tasks[task] = { model: 'custom-candidate', effort: 'medium', fallback: null };
  }
  const source = JSON.stringify(definition);
  assert.deepEqual(validateDefinition(definition), expected);

  const project = await mkdtemp(path.join(os.tmpdir(), 'agent-fit-candidate-import-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  const home = path.join(project, 'home'); await mutate(home, 'setup');
  const roleFiles = Object.keys(ROLES).map(role => path.join(home, 'agents', `${role.replaceAll('_', '-')}.toml`));
  const rolesBefore = await Promise.all(roleFiles.map(file => readFile(file)));
  const cli = new URL('../bin/agent-fit.mjs', import.meta.url);
  const run = (args, input) => {
    const result = spawnSync(process.execPath, [cli.pathname, ...args, '--codex-home', home, '--scope', 'session', '--project', project, '--thread', 'candidate-import-chat', '--json'], { encoding: 'utf8', input, env: { ...process.env, PATH: '/nonexistent' } });
    assert.equal(result.status, 0, result.stdout || result.stderr);
    const report = JSON.parse(result.stdout); assert.deepEqual(report.errors, []); return report.data;
  };
  run(['mode', 'create', 'candidate', '--from', 'mid']);
  run(['mode', 'configure', 'candidate', '--definition-stdin'], source);
  const preview = run(['mode', 'show', 'candidate']);
  assert.equal(preview.active, false); assert.equal(preview.definition_scope, 'session');
  for (const [level, task, role, contract] of [['L2', 'bounded', 'task_execute', 'scoped_output'], ['L3', 'complex', 'task_review', 'readonly_review']]) {
    const query = ['explain', '--level', level, '--task', task, '--role', role];
    const active = run(query);
    assert.equal(active.mode_id, 'mid'); assert.equal(active.active, true);
    assert.deepEqual(active.primary, { model: level === 'L2' ? bindings.economy : bindings.general, effort: level === 'L2' ? 'high' : 'medium' });
    const candidate = run([...query, '--mode', 'candidate']);
    assert.equal(candidate.mode_kind, 'custom'); assert.equal(candidate.active, false);
    assert.equal(candidate.skill_integrity, 'clean');
    assert.equal(candidate.scope, 'session'); assert.equal(candidate.effective_scope, 'global', 'preview retains the source of the active selection');
    assert.deepEqual(candidate.context, active.context); assert.equal(candidate.context.thread, 'candidate-import-chat');
    assert.deepEqual(candidate.primary, { model: 'custom-candidate', effort: 'medium' });
    assert.equal(candidate.fallback, null); assert.deepEqual(candidate.fallback_conditions, []);
    assert.equal(candidate.dispatch_role, 'task_delegate'); assert.equal(candidate.permission_contract, contract);
    assert.deepEqual(candidate.task_profile.levels, expected);
    assert.equal(candidate.runtime_verification, 'unverified');
  }
  assert.equal((await readSnapshot(home)).mode.id, 'mid');
  assert.deepEqual(await Promise.all(roleFiles.map(file => readFile(file))), rolesBefore);
});


test('Terra specialists preserve level, permissions and independent fallback without replacing general routes', () => {
  for (const mode of ['low', 'mid']) {
    const definition = resolveDefinition(mode);
    validateDefinition({ levels: definition.levels });
    for (const task of ['visual', 'computer', 'writing']) {
      for (const [level, effort, backup] of [['L1', 'low', 'medium'], ['L2', 'medium', 'medium'], ['L3', 'high', 'high']]) {
        for (const [role, contract] of [['task_scan', 'readonly_evidence'], ['task_execute', 'scoped_output'], ['task_review', 'readonly_review']]) {
          const selected = explainSelection({ definition, level, task, role, active: true });
          assert.deepEqual(selected.primary, { model: bindings.visual_work, effort });
          assert.deepEqual(selected.fallback, { model: bindings.general, effort: backup });
          assert.ok(selected.fallback_conditions.includes('TASK_REQUIREMENTS_AND_TOOL_CAPABILITIES_MET'));
          assert.equal(selected.level, level); assert.equal(selected.task, task);
          assert.equal(selected.dispatch_role, 'task_delegate'); assert.equal(selected.permission_contract, contract);
        }
      }
      assert.throws(() => explainSelection({ definition, level: 'L4', task }), error => error.code === 'INVALID_ARGUMENT');
      const invalid = structuredClone(definition.levels);
      invalid.L4.tasks[task] = structuredClone(invalid.L3.tasks[task]);
      assert.throws(() => validateDefinition({ levels: invalid }));
    }
    for (const [level, pair] of Object.entries(definition.levels)) {
      assert.notEqual(pair.model, bindings.visual_work);
      for (const task of ['bounded', 'complex']) if (pair.tasks?.[task]) assert.notEqual(pair.tasks[task].model, bindings.visual_work);
    }
  }
});
