import './isolate-home.mjs';
import bindings from '../adapters/codex/model-bindings.json' with { type: 'json' };
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, chmod, readFile, realpath } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelHistory } from '../lib/model-history.mjs';
import { readSnapshot } from '../lib/install.mjs';

const CLI = fileURLToPath(new URL('../bin/agent-fit.mjs', import.meta.url));
const PRIVATE = 'TEST_ONLY_AUTOMATIC_KEY';
async function fixture(t, { official = false } = {}) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'delegation-automatic-'));
  const home = path.join(root, 'home'), bin = path.join(root, 'bin');
  await mkdir(bin);
  const posts = [], requests = [];
  const launches = path.join(root, 'codex-launches'), catalog = path.join(root, 'catalog.json');
  let reject = null;
  const server = http.createServer(async (req, res) => {
    requests.push(req.method);
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') { res.end(JSON.stringify({ data: [{ id: bindings.frontier }] })); return; }
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); posts.push(body);
    assert.equal(req.headers.authorization, 'Bearer ' + PRIVATE);
    assert.deepEqual(body.tools, []); assert.equal(body.tool_choice, 'none'); assert.equal(body.store, false);
    assert.deepEqual(body.input, [{ role: 'user', content: [{ type: 'input_text', text: 'Reply with OK.' }] }]);
    if (reject) { res.statusCode = reject.status; res.end(JSON.stringify({ error: reject.error })); return; }
    res.end(JSON.stringify({ status: 'completed', model: body.model, reasoning: body.reasoning, output: [{ type: 'message' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  await writeFile(path.join(bin, 'codex'), `#!${process.execPath}
import readline from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(launches)}, 'started\\n');
for await (const line of readline.createInterface({input:process.stdin})) {
 const q=JSON.parse(line);if(q.id===undefined)continue;
 appendFileSync(${JSON.stringify(launches)}, q.method+'\\n');
 const result=q.method==='initialize'?{userAgent:'codex-cli/0.156.1',codexHome:process.env.CODEX_HOME,platformFamily:'unix',platformOs:'macos'}:q.method==='account/read'?{account:{type:'apiKey'},requiresOpenaiAuth:false}:q.method==='config/read'?{config:${official ? '{}' : `{model_provider:'automatic-test',model_providers:{'automatic-test':{base_url:${JSON.stringify(base)},env_key:'AUTOMATIC_TEST_KEY'}}}`}}:q.method==='model/list'?{data:JSON.parse(readFileSync(${JSON.stringify(catalog)},'utf8')),nextCursor:null}:{};
 process.stdout.write(JSON.stringify({id:q.id,result})+'\\n');
}
`, { mode: 0o755 });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const run = args => new Promise((resolve, reject) => {
    const env = { ...process.env, PATH: bin, AUTOMATIC_TEST_KEY: PRIVATE };
    delete env.OPENAI_BASE_URL;
    const child = spawn(process.execPath, [CLI, ...args, '--json', '--codex-home', home], { env });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => { try { resolve({ code, report: JSON.parse(stdout), stderr }); } catch { reject(Error(stdout + stderr)); } });
  });
  return { root, home, posts, requests, launches, catalog, run, reject: value => { reject = value; } };
}

test('configuration operations never launch model checks, query providers or save check records', async t => {
  const f = await fixture(t);
  let result = await f.run(['setup', '--dry-run']);
  assert.equal(result.code, 0);
  await assert.rejects(readFile(path.join(f.home, 'AGENTS.md')), { code: 'ENOENT' });
  for (const args of [
    ['setup', '--mode', 'heigh'], ['setup'], ['mode', 'set', 'heigh'],
    ['mode', 'set', 'low'], ['mode', 'set', 'mid'],
    ['mode', 'create', 'copy', '--from', 'heigh'],
    ['mode', 'configure', 'copy', '--level', 'L1', '--model', 'custom', '--effort', 'high'],
    ['mode', 'set', 'copy', '--dry-run'], ['mode', 'set', 'copy'],
    ['mode', 'configure', 'copy', '--level', 'L1', '--model', 'custom', '--effort', 'ultra'],
    ['mode', 'configure', 'copy', '--level', 'L1', '--model', 'custom', '--effort', 'ultra'],
    ['status'], ['restore'],
  ]) {
    result = await f.run(args); assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(Object.hasOwn(result.report.data, 'post_check'), false);
    assert.equal(Object.hasOwn(result.report.data, 'post_check_target'), false);
    assert.deepEqual(f.requests, [], args.join(' '));
  }
  await assert.rejects(readFile(f.launches), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(f.home, '.agent-fit-checks')), { code: 'ENOENT' });
});

test('model binding reviews all affected routes and updates only new builtin selections in the bound home', async t => {
  const f = await fixture(t, { official: true });
  const run = async (args, code = 0) => {
    const result = await f.run(args);
    assert.equal(result.code, code, JSON.stringify(result));
    return result.report;
  };
  await run(['setup']);
  await run(['mode', 'create', 'pinned', '--from', 'mid']);
  const scope = ['--scope', 'session', '--thread', 'fixture-chat', '--project', f.root];
  await run(['mode', 'set', 'low', ...scope]);
  const bindingPath = path.join(f.home, '.agent-fit/model-bindings.json');
  const original = (await run(['explain', '--level', 'L2'])).data;
  const routes = ['models', 'bind', 'general', 'future-general'];
  const setCatalog = (efforts, hidden = false) => writeFile(f.catalog, JSON.stringify([{
    id: 'future-general', model: 'future-general', displayName: 'Future general', hidden,
    defaultReasoningEffort: efforts[0], supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })),
  }]));
  const allEfforts = ['medium', 'high', 'xhigh', 'ultra'];
  await setCatalog(allEfforts.slice(0, -1));
  let failed = await run([...routes, '--dry-run'], 1);
  assert.equal(failed.errors[0].code, 'MODEL_BINDING_UNSUPPORTED');
  assert.match(failed.errors[0].message, /future-general\/ultra/);
  assert.equal(failed.data.model_binding.preview_token, undefined);
  await setCatalog(allEfforts);
  let preview = (await run([...routes, '--dry-run'])).data;
  assert.equal(preview.configuration_status, 'not_written');
  assert.ok(preview.model_binding.routes.some(route => route.mode === 'mid' && route.level === 'L2' && route.position === 'primary' && route.after.model === 'future-general'));
  assert.ok(preview.model_binding.routes.some(route => route.mode === 'low' && route.task === 'visual' && route.position === 'fallback' && route.after.model === 'future-general'));
  await assert.rejects(readFile(bindingPath), { code: 'ENOENT' });
  assert.equal((await run(['explain', '--level', 'L2'])).data.primary.model, bindings.general);

  await run(['mode', 'create', 'changed-since-preview']);
  failed = await run([...routes, '--apply', preview.model_binding.preview_token], 2);
  assert.equal(failed.errors[0].code, 'MODEL_BINDING_PREVIEW_REQUIRED');
  preview = (await run([...routes, '--dry-run'])).data;
  const apply = [...routes, '--apply', preview.model_binding.preview_token];
  await setCatalog(allEfforts, true);
  failed = await run(apply, 1);
  assert.equal(failed.errors[0].code, 'MODEL_BINDING_UNSUPPORTED');
  await assert.rejects(readFile(bindingPath), { code: 'ENOENT' });
  await setCatalog(allEfforts);
  const applied = (await run(apply)).data;
  assert.equal(applied.configuration_status, 'written');
  assert.equal(applied.restart.required, false);
  assert.deepEqual(JSON.parse(await readFile(bindingPath)), { general: 'future-general' });
  const current = (await run(['explain', '--level', 'L2', '--role', 'task_execute'])).data;
  assert.deepEqual(current.primary, { model: 'future-general', effort: 'medium' });
  assert.equal(current.dispatch_role, 'task_execute');
  assert.deepEqual(original.primary, { model: bindings.general, effort: 'medium' });
  assert.equal((await run(['explain', '--level', 'L2', '--mode', 'pinned'])).data.primary.model, bindings.general);
  const scoped = (await run(['explain', '--level', 'L1', '--task', 'visual', ...scope])).data;
  assert.equal(scoped.mode_id, 'low');
  assert.equal(scoped.fallback.model, 'future-general');
  assert.equal((await run(['mode', 'list', ...scope])).data.modes.find(mode => mode.id === 'heigh').levels.L2.model, 'future-general');
  assert.equal((await run(['status'])).data.roles.find(role => role.name === 'task_execute').configured_model, 'future-general');
  await run(['mode', 'set', 'heigh']);
  assert.equal((await run(['explain', '--level', 'L2'])).data.primary.model, 'future-general');
  const otherHome = path.join(f.root, 'another-home');
  assert.equal((await readSnapshot(otherHome)).builtins.find(mode => mode.id === 'mid').levels.L2.model, bindings.general);
  assert.deepEqual(f.requests, []);
  assert.ok((await readFile(f.launches, 'utf8')).trim().split('\n').every(method => ['started', 'initialize', 'account/read', 'config/read', 'model/list'].includes(method)));
  await run(['restore']);
  await assert.rejects(readFile(bindingPath), { code: 'ENOENT' });
});

test('manual verification still makes an isolated request and saves history independently of settings', async t => {
  const f = await fixture(t);
  assert.equal((await f.run(['setup', '--mode', 'mid'])).code, 0);
  assert.deepEqual(f.requests, []);
  const args = ['models', 'check', '--verify', '--model', bindings.frontier, '--effort', 'ultra'];
  let result = await f.run(args);
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(result.report.data.status, 'passed'); assert.equal(result.report.data.trigger, 'manual');
  assert.equal(result.report.data.checked_pairs[0].identity_status, 'matched');
  assert.deepEqual(f.requests, ['GET', 'POST']); assert.equal(f.posts.length, 1);
  assert.equal((await modelHistory(f.home)).records.length, 1);
  await chmod(path.join(f.home, '.agent-fit-checks'), 0o755);
  result = await f.run(['mode', 'set', 'heigh']);
  assert.equal(result.code, 0); assert.equal((await readSnapshot(f.home)).mode.id, 'heigh');
  assert.equal(f.posts.length, 1);
  result = await f.run(args);
  assert.equal(result.code, 1); assert.equal(result.report.data.status, 'incomplete');
  assert.equal(result.report.data.check_status, 'passed');
  assert.equal(result.report.data.history.status, 'failed');
  assert.equal((await readSnapshot(f.home)).mode.id, 'heigh');
});

test('provider authentication failure only affects an explicitly requested model check', async t => {
  const f = await fixture(t); f.reject({ status: 401, error: { message: PRIVATE } });
  let result = await f.run(['setup', '--mode', 'heigh']);
  assert.equal(result.code, 0); assert.equal(result.report.data.configuration_status, 'written');
  assert.deepEqual(f.requests, []);
  result = await f.run(['models', 'bind', 'general', 'provider-model', '--dry-run']);
  assert.equal(result.code, 1);
  assert.equal(result.report.errors[0].code, 'MODEL_BINDING_CATALOG_UNAVAILABLE');
  assert.deepEqual(f.requests, []);
  result = await f.run(['models', 'check', '--verify', '--model', bindings.frontier, '--effort', 'ultra']);
  assert.notEqual(result.code, 0); assert.equal(result.report.data.stop_reason, 'PROBE_AUTH_FAILED');
  assert.equal(result.report.data.history.status, 'saved');
  assert.equal((await readSnapshot(f.home)).mode.id, 'heigh'); assert.equal(f.posts.length, 1);
  assert.equal(JSON.stringify(result).includes(PRIVATE), false);
});
