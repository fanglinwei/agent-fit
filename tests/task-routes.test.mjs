import './isolate-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { explainSelection, resolveDefinition, validateDefinition } from '../lib/codex.mjs';
import { mutate } from '../lib/install.mjs';

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
    for (const task of ['uncertain', 'reasoning']) {
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
