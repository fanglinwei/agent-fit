import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { safeToml, BUILTINS, ROLES, renderPayload, explainSelection, validateDefinition, resolveDefinition } from '../lib/codex.mjs';

test('packaged role files and explicit registrations exactly cover the role registry with both model axes', async () => {
  const assets = new URL('../adapters/codex/skills/agent-fit/assets/codex/', import.meta.url);
  const registrations = safeToml(await readFile(new URL('config.toml', assets))).agents;
  const filenames = (await readdir(new URL('agents/', assets), { recursive: true })).filter(name => name.endsWith('.toml')).sort();
  assert.deepEqual(Object.keys(registrations).sort(), Object.keys(ROLES).sort());
  assert.deepEqual(filenames, Object.keys(ROLES).map(name => `${name.replaceAll('_', '-')}.toml`).sort());
  const baseline = resolveDefinition('official');
  for (const [name, level] of Object.entries(ROLES)) {
    const relative = `agents/${name.replaceAll('_', '-')}.toml`;
    assert.equal(registrations[name].config_file, relative);
    const role = safeToml(await readFile(new URL(relative, assets)));
    assert.equal(role.name, name);
    if (level) {
      assert.equal(role.model, baseline.levels[level].model);
      assert.equal(role.model_reasoning_effort, baseline.levels[level].effort);
    } else {
      assert.equal(Object.hasOwn(role, 'model'), false);
      assert.equal(Object.hasOwn(role, 'model_reasoning_effort'), false);
    }
  }
});

test('builtin ids are cut/official/high/fire and other names are not aliases', () => {
  assert.deepEqual(BUILTINS.map(mode => mode.id), ['cut', 'official', 'high', 'fire']);
  for (const id of ['cut', 'official', 'high', 'fire']) assert.equal(resolveDefinition(id).id, id);
  for (const name of ['low', 'mid', 'economy', 'balanced', 'performance', '经济', '官方', '高级', '全开']) {
    assert.throws(() => resolveDefinition(name), error => error.code === 'MODE_NOT_FOUND');
  }
  const custom = { ...resolveDefinition('official'), id: 'custom-example', name: '我的档位', kind: 'custom' };
  assert.equal(resolveDefinition(custom.id, [custom]).id, custom.id);
  assert.equal(resolveDefinition(custom.name, [custom]).id, custom.id);
});

test('all builtin primary/fallback tables render roles and current data consistently', async () => {
  const expected = [
    ['gpt-6-luna/high', 'gpt-6-luna/high', 'gpt-6.1-sol/medium', 'gpt-6.1-sol/high'],
    ['gpt-6-luna/high', 'gpt-6.1-sol/medium', 'gpt-6.1-sol/high', 'gpt-6.1-sol/xhigh'],
    ['gpt-6-luna/max', 'gpt-6.1-sol/ultra', 'gpt-6-astra/ultra', 'gpt-6-astra/ultra'],
    ['gpt-6-astra/ultra', 'gpt-6-astra/ultra', 'gpt-6-astra/ultra', 'gpt-6-astra/ultra'],
  ];
  const backups = [
    ['gpt-6.1-sol/medium', 'gpt-6.1-sol/medium', 'gpt-6-sol/medium', 'gpt-6-sol/high'],
    ['gpt-6.1-sol/medium', 'gpt-6-sol/medium', 'gpt-6-sol/high', 'gpt-6-sol/xhigh'],
    ['gpt-6.1-sol/high', 'gpt-6-sol/ultra', 'gpt-6.1-sol/ultra', 'gpt-6.1-sol/ultra'],
    [null, null, null, null],
  ];
  for (const [index, mode] of BUILTINS.entries()) {
    assert.deepEqual(Object.values(mode.levels).map(v => `${v.model}/${v.effort}`), expected[index]);
    assert.deepEqual(Object.values(mode.levels).map(v => v.fallback ? `${v.fallback.model}/${v.fallback.effort}` : null), backups[index]);
    for (const [level, value] of Object.entries(mode.levels)) {
      const selection = explainSelection({ definition: mode, level });
      assert.deepEqual(selection.fallback, value.fallback);
      assert.deepEqual(selection.fallback_conditions, value.fallback ? mode.fallback_conditions : []);
    }
    const { files, block } = await renderPayload('/test/home with spaces', mode);
    const current = JSON.parse(files.get('skills/agent-fit/references/current-mode.json'));
    assert.equal(current.id, mode.id);
    assert.deepEqual(current.levels, mode.levels);
    const contracts = [];
    for (const [role, level] of Object.entries(ROLES)) {
      const content = safeToml(files.get(`agents/${role.replaceAll('_', '-')}.toml`));
      assert.equal(content.name, role);
      assert.equal(Object.hasOwn(content.features ?? {}, 'image_generation'), false);
      assert.doesNotMatch(content.developer_instructions, /Git|不生成图像/);
      assert.ok(content.description); assert.ok(content.developer_instructions.includes('不继续派生子代理'));
      contracts.push(content.developer_instructions.split('\n\n本角色')[0]);
      if (level) { assert.equal(content.model, mode.levels[level].model); assert.equal(content.model_reasoning_effort, mode.levels[level].effort); }
      else { assert.ok(!Object.hasOwn(content, 'model')); assert.ok(!Object.hasOwn(content, 'model_reasoning_effort')); }
    }
    assert.equal(new Set(contracts).size, 1);
    assert.match(block.toString(), /Codex 启动/); assert.match(block.toString(), /每次创建/);
    assert.doesNotMatch(block.toString(), /Git|不生成图像/);
    assert.ok(block.toString().includes('/test/home with spaces/skills/agent-fit/SKILL.md'));
  }
});

test('role selection cannot expand original permission contract', () => {
  const low = resolveDefinition('cut');
  const hard = explainSelection({ definition: low, level: 'L3', role: 'task_execute', active: true });
  assert.equal(hard.dispatch_role, 'task_delegate'); assert.equal(hard.permission_contract, 'scoped_output');
  assert.equal(hard.primary.model, 'gpt-6.1-sol');
  const read = explainSelection({ definition: low, level: 'L1', role: 'task_scan', active: true });
  assert.equal(read.dispatch_role, 'task_scan'); assert.equal(read.access, 'unknown');
  assert.equal(explainSelection({ definition: low, level: 'L1', role: 'task_scan' }).dispatch_role, 'task_delegate');
  assert.equal(explainSelection({ definition: low, level: 'L1', role: 'task_scan', active: false }).dispatch_role, 'task_delegate');
  assert.equal(explainSelection({ definition: low, level: 'L4', role: 'task_review', active: true }).dispatch_role, 'task_delegate');
});

test('simple review and complex evidence gathering use the chosen level without changing responsibility', () => {
  const definition = resolveDefinition('official');
  for (const [level, role, contract] of [['L1', 'task_review', 'readonly_review'], ['L3', 'task_scan', 'readonly_evidence']]) {
    const selected = explainSelection({ definition, level, role, active: true });
    assert.equal(selected.level, level);
    assert.equal(selected.level_source, 'argument');
    assert.deepEqual(selected.primary, { model: definition.levels[level].model, effort: definition.levels[level].effort });
    assert.equal(selected.dispatch_role, 'task_delegate');
    assert.equal(selected.permission_contract, contract);
  }
  const high = resolveDefinition('high');
  assert.deepEqual(explainSelection({ definition: high, level: 'L3' }).primary, explainSelection({ definition: high, level: 'L4' }).primary);
});

test('whole definition validation rejects incomplete, unknown and identical backup pairs', () => {
  const base = structuredClone(BUILTINS[1].levels);
  assert.throws(() => validateDefinition({ levels: { L1: base.L1 } }));
  assert.throws(() => validateDefinition({ levels: base, instructions: 'expand permissions' }));
  base.L1.fallback = { model: base.L1.model, effort: base.L1.effort };
  assert.throws(() => validateDefinition({ levels: base }));
  base.L1.fallback = null; base.L2.model = 'private\nmodel';
  assert.throws(() => validateDefinition({ levels: base }));
});

test('rendered paths are data escaped and distinct per home', async () => {
  const a = await renderPayload('/test/`quote<>"', BUILTINS[1]);
  const b = await renderPayload('/other', BUILTINS[1]);
  assert.notEqual(a.block.toString(), b.block.toString());
  const data = JSON.parse(a.block.toString().split('```json\n')[1].split('\n```')[0]);
  assert.equal(data.skill, '/test/`quote<>"/skills/agent-fit/SKILL.md');
});


test('fire requires session verification and describes an unpinned user or parent fallback', () => {
  const explained = explainSelection({ definition: resolveDefinition('fire'), level: 'L1', role: 'task_scan' });
  assert.equal(explained.verification.required, true);
  assert.equal(explained.verification.scope, 'session');
  assert.equal(explained.verification.on_failure.selection, 'user_or_parent');
  assert.equal(explained.verification.on_failure.dispatch_role, 'task_delegate');
  assert.equal(explained.permission_contract, 'readonly_evidence');
  assert.equal(explained.fallback, null);
  assert.equal(explainSelection({ definition: resolveDefinition('high'), level: 'L3' }).verification, null);
  const custom = { ...resolveDefinition('fire'), kind: 'custom', id: 'custom-test' };
  assert.equal(explainSelection({ definition: custom, level: 'L1' }).verification, null);
});
