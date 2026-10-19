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
async function fixture(t) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'delegation-automatic-'));
  const home = path.join(root, 'home'), bin = path.join(root, 'bin');
  await mkdir(bin);
  const posts = [], requests = [];
  const launches = path.join(root, 'codex-launches');
  let reject = null;
  const server = http.createServer(async (req, res) => {
    requests.push(req.method);
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') { res.end(JSON.stringify({ data: [{ id: 'gpt-6-astra' }] })); return; }
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
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(launches)}, 'started\\n');
for await (const line of readline.createInterface({input:process.stdin})) {
 const q=JSON.parse(line);if(q.id===undefined)continue;
 const result=q.method==='initialize'?{userAgent:'codex-cli/0.156.1',codexHome:process.env.CODEX_HOME,platformFamily:'unix',platformOs:'macos'}:q.method==='account/read'?{account:{type:'apiKey'},requiresOpenaiAuth:false}:q.method==='config/read'?{config:{model_provider:'automatic-test',model_providers:{'automatic-test':{base_url:${JSON.stringify(base)},env_key:'AUTOMATIC_TEST_KEY'}}}}:{};
 process.stdout.write(JSON.stringify({id:q.id,result})+'\\n');
}
`, { mode: 0o755 });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const run = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args, '--json', '--codex-home', home], { env: { ...process.env, PATH: bin, AUTOMATIC_TEST_KEY: PRIVATE } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => { try { resolve({ code, report: JSON.parse(stdout), stderr }); } catch { reject(Error(stdout + stderr)); } });
  });
  return { root, home, posts, requests, launches, run, reject: value => { reject = value; } };
}

test('configuration operations never launch model checks, query providers or save check records', async t => {
  const f = await fixture(t);
  let result = await f.run(['setup', '--dry-run']);
  assert.equal(result.code, 0);
  await assert.rejects(readFile(path.join(f.home, 'AGENTS.md')), { code: 'ENOENT' });
  for (const args of [
    ['setup', '--mode', 'high'], ['setup'], ['mode', 'set', 'high'],
    ['mode', 'set', 'cut'], ['mode', 'set', 'official'], ['mode', 'set', 'fire'],
    ['mode', 'create', 'copy', '--from', 'fire'],
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

test('manual verification still makes an isolated request and saves history independently of settings', async t => {
  const f = await fixture(t);
  assert.equal((await f.run(['setup', '--mode', 'fire'])).code, 0);
  assert.deepEqual(f.requests, []);
  const args = ['models', 'check', '--verify', '--model', 'gpt-6-astra', '--effort', 'ultra'];
  let result = await f.run(args);
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(result.report.data.status, 'passed'); assert.equal(result.report.data.trigger, 'manual');
  assert.equal(result.report.data.checked_pairs[0].identity_status, 'matched');
  assert.deepEqual(f.requests, ['GET', 'POST']); assert.equal(f.posts.length, 1);
  assert.equal((await modelHistory(f.home)).records.length, 1);
  await chmod(path.join(f.home, '.agent-fit-checks'), 0o755);
  result = await f.run(['mode', 'set', 'high']);
  assert.equal(result.code, 0); assert.equal((await readSnapshot(f.home)).mode.id, 'high');
  assert.equal(f.posts.length, 1);
  result = await f.run(args);
  assert.equal(result.code, 1); assert.equal(result.report.data.status, 'passed');
  assert.equal(result.report.data.history.status, 'failed');
  assert.equal((await readSnapshot(f.home)).mode.id, 'high');
});

test('provider authentication failure only affects an explicitly requested model check', async t => {
  const f = await fixture(t); f.reject({ status: 401, error: { message: PRIVATE } });
  let result = await f.run(['setup', '--mode', 'high']);
  assert.equal(result.code, 0); assert.equal(result.report.data.configuration_status, 'written');
  assert.deepEqual(f.requests, []);
  result = await f.run(['models', 'check', '--verify', '--model', 'gpt-6-astra', '--effort', 'ultra']);
  assert.notEqual(result.code, 0); assert.equal(result.report.data.stop_reason, 'PROBE_AUTH_FAILED');
  assert.equal(result.report.data.history.status, 'saved');
  assert.equal((await readSnapshot(f.home)).mode.id, 'high'); assert.equal(f.posts.length, 1);
  assert.equal(JSON.stringify(result).includes(PRIVATE), false);
});
