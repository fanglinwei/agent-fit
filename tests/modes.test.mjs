import test from 'node:test';
import assert from 'node:assert/strict';
import { safeToml, BUILTINS, ROLES, renderPayload, explainSelection, validateDefinition, resolveDefinition } from '../lib/codex.mjs';

test('builtin ids are low/mid/fire and other names are not aliases', () => {
  assert.deepEqual(BUILTINS.map(mode => mode.id), ['low', 'mid', 'fire']);
  for (const id of ['low', 'mid', 'fire']) assert.equal(resolveDefinition(id).id, id);
  for (const name of ['economy', 'balanced', 'performance', '经济', '适中', '性能']) {
    assert.throws(() => resolveDefinition(name), error => error.code === 'MODE_NOT_FOUND');
  }
  const custom = { ...resolveDefinition('mid'), id: 'custom-example', name: '我的档位', kind: 'custom' };
  assert.equal(resolveDefinition(custom.id, [custom]).id, custom.id);
  assert.equal(resolveDefinition(custom.name, [custom]).id, custom.id);
});

test('all builtin primary/fallback tables render roles and current data consistently', async () => {
  const expected = [
    ['gpt-6-luna/high', 'gpt-6-luna/high', 'gpt-6.1-sol/medium', 'gpt-6.1-sol/high'],
    ['gpt-6-luna/high', 'gpt-6.1-sol/medium', 'gpt-6.1-sol/high', 'gpt-6.1-sol/high'],
    ['gpt-6-luna/high', 'gpt-6.1-sol/high', 'gpt-6-astra/low', 'gpt-6-astra/low'],
  ];
  for (const [index, mode] of BUILTINS.entries()) {
    assert.deepEqual(Object.values(mode.levels).map(v => `${v.model}/${v.effort}`), expected[index]);
    const { files, block } = await renderPayload('/test/home with spaces', mode);
    const current = JSON.parse(files.get('skills/subagent-delegation/references/current-mode.json'));
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
    assert.ok(block.toString().includes('/test/home with spaces/skills/subagent-delegation/SKILL.md'));
  }
});

test('role selection cannot expand original permission contract', () => {
  const low = resolveDefinition('low');
  const hard = explainSelection({ definition: low, level: 'L3', role: 'task_execute' });
  assert.equal(hard.dispatch_role, 'task_delegate'); assert.equal(hard.permission_contract, 'scoped_output');
  assert.equal(hard.primary.model, 'gpt-6.1-sol');
  const read = explainSelection({ definition: low, level: 'L1', role: 'task_scan' });
  assert.equal(read.dispatch_role, 'task_scan'); assert.equal(read.access, 'unknown');
  assert.equal(explainSelection({ definition: low, level: 'L4', role: 'task_review' }).dispatch_role, 'task_delegate');
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
  assert.equal(data.skill, '/test/`quote<>"/skills/subagent-delegation/SKILL.md');
});
