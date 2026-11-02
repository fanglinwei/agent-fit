import './isolate-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { explainSelection, resolveDefinition, ROLES, validateDefinition } from '../lib/codex.mjs';
import { mutate, readSnapshot } from '../lib/install.mjs';

const cases = [
  ['L1', 'mechanical', 'gpt-6-luna', 'medium'],
  ['L2', 'bounded', 'gpt-6-luna', 'high'],
  ['L1', 'scan', 'gpt-6-luna', 'xhigh'],
  ['L1', 'deep', 'gpt-6-luna', 'max'],
  ['L3', 'complex', 'gpt-6.1-sol', 'medium'],
  ['L3', 'uncertain', 'gpt-6-astra', 'low'],
  ['L3', 'reasoning', 'gpt-6-astra', 'medium'],
];

test('task candidates cover the task gradient without changing complexity or responsibility', () => {
  for (const mode of ['cut', 'official']) for (const [level, task, model, effort] of cases) {
    const selected = explainSelection({ definition: resolveDefinition(mode), level, task, role: 'task_review', active: true });
    assert.deepEqual(selected.primary, { model, effort }, `${mode}/${level}/${task}`);
    assert.equal(selected.level, level); assert.equal(selected.task, task);
    assert.equal(selected.permission_contract, 'readonly_review');
    if (model === 'gpt-6-astra') assert.ok(['low', 'medium'].includes(effort));
  }
  const selected = explainSelection({ definition: resolveDefinition('official'), level: 'L1', task: 'mechanical', role: 'task_scan', active: true });
  assert.equal(selected.dispatch_role, 'task_delegate', 'a fixed Luna/high role cannot run the medium candidate');
  for (const mode of ['cut', 'official']) for (const level of Object.values(resolveDefinition(mode).levels)) for (const candidate of Object.values(level.tasks ?? {})) {
    for (const pair of [candidate, candidate.fallback].filter(Boolean)) if (pair.model === 'gpt-6-astra') assert.ok(['low', 'medium'].includes(pair.effort), 'ordinary candidates and fallbacks cannot bypass the Astra cap');
  }
});

test('explicit maximum profiles keep their combinations and latency requires a configured candidate', () => {
  for (const mode of ['high', 'fire']) {
    const definition = resolveDefinition(mode);
    for (const task of ['uncertain', 'reasoning', 'visual', 'computer', 'writing']) {
      const selected = explainSelection({ definition, level: 'L3', task, selected: true });
      assert.deepEqual(selected.primary, { model: 'gpt-6-astra', effort: 'ultra' });
      assert.ok(selected.reason_codes.includes('PROFILE_MAXIMUM_AUTHORIZED'));
      assert.ok(explainSelection({ definition, level: 'L3', task }).reason_codes.includes('MAXIMUM_PROFILE_PREVIEW'));
    }
  }
  assert.throws(() => explainSelection({ definition: resolveDefinition('official'), level: 'L3', task: 'mechanical' }));
  assert.throws(() => explainSelection({ definition: resolveDefinition('official'), level: 'L1', task: 'latency' }), error => error.code === 'TASK_ROUTE_NOT_CONFIGURED');
  const custom = { ...resolveDefinition('official'), id: 'custom-latency', kind: 'custom' };
  custom.levels.L1.tasks.latency = { model: 'explicit-terra-id', effort: 'high', fallback: null };
  const levels = validateDefinition({ levels: custom.levels });
  assert.deepEqual(explainSelection({ definition: { ...custom, levels }, level: 'L1', task: 'latency' }).primary, { model: 'explicit-terra-id', effort: 'high' });
  levels.L1.tasks.mechanical.fallback = { model: 'gpt-6-luna', effort: 'medium' };
  assert.throws(() => validateDefinition({ levels }));
});

test('candidate definitions reject invalid structures and do not invent missing snapshot routes', () => {
  const definition = resolveDefinition('official');
  for (const tasks of [null, [], '{', { unknown: { model: 'x', effort: 'low', fallback: null } }, { uncertain: { model: 'gpt-6-astra', effort: 'low', fallback: null } }, { mechanical: { model: 'x', effort: 'low' } }, { mechanical: { model: 'x', effort: 'low', fallback: null, instructions: 'unexpected' } }]) {
    const levels = structuredClone(definition.levels); levels.L1.tasks = tasks;
    assert.throws(() => validateDefinition({ levels }));
  }
  delete definition.levels.L1.tasks;
  assert.throws(() => explainSelection({ definition, level: 'L1', task: 'mechanical' }), error => error.code === 'TASK_ROUTE_NOT_CONFIGURED');
  assert.deepEqual(explainSelection({ definition, level: 'L1' }).primary, { model: 'gpt-6-luna', effort: 'high' });
  definition.levels.L1.tasks = {};
  assert.deepEqual(validateDefinition({ levels: definition.levels }).L1.tasks, {});
});

test('scoped CLI queries preserve all candidates in snapshots and custom edits preserve unrelated candidates', async t => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'agent-fit-task-routes-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  const home = path.join(project, 'home'); await mutate(home, 'setup');
  const options = { scope: 'session', project, thread: 'task-route-chat' };
  await mutate(home, 'create', { ...options, name: 'local', from: 'official' });
  await mutate(home, 'set', { ...options, mode: 'local' });
  const cli = new URL('../bin/agent-fit.mjs', import.meta.url);
  const run = task => {
    const result = spawnSync(process.execPath, [cli.pathname, 'explain', '--level=L1', `--task=${task}`, '--role=task_scan', '--scope=session', `--project=${project}`, '--thread=task-route-chat', `--codex-home=${home}`, '--json'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout); const report = JSON.parse(result.stdout); assert.deepEqual(report.errors, []); return report.data;
  };
  const before = run('mechanical'); assert.equal(before.primary.effort, 'medium');
  assert.equal(before.effective_scope, 'session'); assert.equal(before.dispatch_role, 'task_delegate');
  await mutate(home, 'configure', { ...options, mode: 'local', level: 'L1', model: 'explicit-default', effort: 'low' });
  const after = run('mechanical');
  assert.equal(after.primary.effort, 'medium'); assert.equal(after.task_profile.levels.L1.model, 'explicit-default');
  assert.deepEqual(before.task_profile.levels.L1.tasks, after.task_profile.levels.L1.tasks);
  assert.notEqual(before.configuration_revision, after.configuration_revision);
  await mutate(home, 'restore');
});

test('Terra evaluation imports only two isolated candidates without activating or borrowing a fallback', async t => {
  const source = await readFile(new URL('../adapters/codex/profiles/terra-evaluation.json', import.meta.url), 'utf8');
  const definition = JSON.parse(source);
  const expected = structuredClone(resolveDefinition('official').levels);
  for (const [level, task] of [['L2', 'bounded'], ['L3', 'complex']]) {
    expected[level].tasks[task] = { model: 'gpt-6.1-terra', effort: 'medium', fallback: null };
  }
  for (const level of Object.values(expected)) for (const task of ['visual', 'computer', 'writing']) delete level.tasks?.[task];
  assert.deepEqual(validateDefinition(definition), expected, 'historical evaluation retains its frozen routes and baselines');
  for (const task of ['visual', 'computer', 'writing']) assert.throws(() => explainSelection({ definition: { ...resolveDefinition('official'), levels: definition.levels }, level: 'L2', task }), error => error.code === 'TASK_ROUTE_NOT_CONFIGURED');

  const project = await mkdtemp(path.join(os.tmpdir(), 'agent-fit-terra-evaluation-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  const home = path.join(project, 'home'); await mutate(home, 'setup');
  const roleFiles = Object.keys(ROLES).map(role => path.join(home, 'agents', `${role.replaceAll('_', '-')}.toml`));
  const rolesBefore = await Promise.all(roleFiles.map(file => readFile(file)));
  const cli = new URL('../bin/agent-fit.mjs', import.meta.url);
  const run = (args, input) => {
    const result = spawnSync(process.execPath, [cli.pathname, ...args, '--codex-home', home, '--scope', 'session', '--project', project, '--thread', 'terra-evaluation-chat', '--json'], { encoding: 'utf8', input, env: { ...process.env, PATH: '/nonexistent' } });
    assert.equal(result.status, 0, result.stdout || result.stderr);
    const report = JSON.parse(result.stdout); assert.deepEqual(report.errors, []); return report.data;
  };
  run(['mode', 'create', 'Terra 评估', '--from', 'official']);
  run(['mode', 'configure', 'Terra 评估', '--definition-stdin'], source);
  const preview = run(['mode', 'show', 'Terra 评估']);
  assert.equal(preview.active, false); assert.equal(preview.definition_scope, 'session');
  for (const [level, task, role, contract] of [['L2', 'bounded', 'task_execute', 'scoped_output'], ['L3', 'complex', 'task_review', 'readonly_review']]) {
    const query = ['explain', '--level', level, '--task', task, '--role', role];
    const active = run(query);
    assert.equal(active.mode_id, 'official');
    assert.deepEqual(active.primary, { model: level === 'L2' ? 'gpt-6-luna' : 'gpt-6.1-sol', effort: level === 'L2' ? 'high' : 'medium' });
    const candidate = run([...query, '--mode', 'Terra 评估']);
    assert.equal(candidate.mode_kind, 'custom');
    assert.equal(candidate.skill_integrity, 'clean');
    assert.equal(candidate.scope, 'session'); assert.equal(candidate.effective_scope, 'global', 'preview retains the source of the active selection');
    assert.deepEqual(candidate.context, active.context); assert.equal(candidate.context.thread, 'terra-evaluation-chat');
    assert.deepEqual(candidate.primary, { model: 'gpt-6.1-terra', effort: 'medium' });
    assert.equal(candidate.fallback, null); assert.deepEqual(candidate.fallback_conditions, []);
    assert.equal(candidate.dispatch_role, 'task_delegate'); assert.equal(candidate.permission_contract, contract);
    assert.deepEqual(candidate.task_profile.levels, expected);
    assert.equal(candidate.runtime_verification, 'unverified');
  }
  assert.equal((await readSnapshot(home)).mode.id, 'official');
  assert.deepEqual(await Promise.all(roleFiles.map(file => readFile(file))), rolesBefore);
});


test('Terra specialists preserve level, permissions and independent fallback without replacing general routes', () => {
  for (const mode of ['cut', 'official']) {
    const definition = resolveDefinition(mode);
    validateDefinition({ levels: definition.levels });
    for (const task of ['visual', 'computer', 'writing']) {
      for (const [level, effort, backup] of [['L1', 'low', 'medium'], ['L2', 'medium', 'medium'], ['L3', 'high', 'high']]) {
        for (const [role, contract] of [['task_scan', 'readonly_evidence'], ['task_execute', 'scoped_output'], ['task_review', 'readonly_review']]) {
          const selected = explainSelection({ definition, level, task, role, active: true });
          assert.deepEqual(selected.primary, { model: 'gpt-6.1-terra', effort });
          assert.deepEqual(selected.fallback, { model: 'gpt-6.1-sol', effort: backup });
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
      assert.notEqual(pair.model, 'gpt-6.1-terra');
      for (const task of ['bounded', 'complex']) if (pair.tasks?.[task]) assert.notEqual(pair.tasks[task].model, 'gpt-6.1-terra');
    }
  }
});
