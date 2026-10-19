import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { serveLocal, actionCommand } from '../lib/server.mjs';

test('web action whitelist always uses argv and one full stdin, rejecting arbitrary execution', () => {
  const env = { home: '/fake home', project: '/project' };
  assert.throws(() => actionCommand({ action: 'setup', params: { command: 'echo unsafe' } }, env));
  assert.throws(() => actionCommand({ action: 'restore', params: {} }, env));
  const cmd = actionCommand({ action: 'create', params: { name: '-my `mode`', expectRevision: 'current' } }, env);
  assert.deepEqual(cmd.argv.slice(-2), ['--', '-my `mode`']);
  assert.ok(cmd.argv.includes('--codex-home=/fake home'));
  assert.ok(!cmd.argv.some(arg => arg.startsWith('--agent')));
  assert.ok(actionCommand({ action: 'explain', params: { level: 'L1', task: 'mechanical' } }, env).argv.includes('--task=mechanical'));
  assert.throws(() => actionCommand({ action: 'explain', params: { level: 'L3', task: 'mechanical' } }, env));
  assert.throws(() => actionCommand({ action: 'explain', params: { level: 'L1', task: '__proto__' } }, env));
});

test('loopback service performs real packaged CLI and protects host/origin/session/revision', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'delegation-http-')); const home = path.join(await realpath(dir), 'home');
  const service = await serveLocal({ home, project: dir });
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  const bootstrap = await fetch(service.url + '/api/bootstrap'); const info = await bootstrap.json();
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  const headers = { 'Content-Type': 'application/json', Origin: service.url, Cookie: cookie, 'X-Delegation-Token': info.csrf_token };
  const action = (body, custom = headers) => fetch(service.url + '/api/actions', { method: 'POST', headers: custom, body: JSON.stringify(body) });
  assert.equal((await action({ action: 'status' }, { ...headers, Origin: 'http://evil.example' })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    const request = http.request(service.url + '/api/bootstrap', { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await action({ action: 'status' }, { ...headers, 'X-Delegation-Token': 'wrong' })).status, 403);
  assert.equal((await action({ action: 'account', params: { operation: 'login', method: 'apiKey', apiKey: 'test-private-key' } }, { ...headers, Origin: 'https://evil.example' })).status, 403);
  assert.equal((await action({ action: 'account', params: { operation: 'status', apiKey: 'test-private-key' } })).status, 400);
  assert.equal((await action({ action: 'account', params: { operation: 'login', method: 'unsupported' } })).status, 400);
  assert.equal((await action({ action: 'account', params: { operation: 'login', method: 'apiKey', apiKey: 'test-private-key', home: '/other' } })).status, 400);
  assert.equal((await action({ action: 'history', params: { id: '../../auth.json', cursor: 'x' } })).status, 400);
  for (const body of [{ action: 'models', params: {} }, { action: 'models', params: { verify: true } }, { action: 'history', params: {} }]) {
    const response = await action(body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).report.errors[0].code, 'INVALID_ARGUMENT');
  }
  assert.equal((await action({ action: 'setup', params: { codexHome: '/other', expectRevision: 'x' } })).status, 400);
  let result = await (await action({ action: 'status', params: { details: true } })).json();
  assert.equal(result.report.data.installation, 'not_installed');
  let revision = result.report.data.configuration_revision;
  result = await (await action({ action: 'setup', params: { mode: 'official', dryRun: true, expectRevision: revision } })).json();
  assert.equal(result.report.data.result, 'preview');
  result = await (await action({ action: 'setup', params: { mode: 'official', expectRevision: revision } })).json();
  assert.equal(result.exit_code, 0, JSON.stringify(result)); assert.equal(result.report.data.restart.required, true); assert.equal(Object.hasOwn(result.report.data, 'post_check'), false);
  const staleCheck = await (await action({ action: 'verify', params: { expectRevision: revision } })).json();
  assert.equal(staleCheck.exit_code, 1);
  assert.equal(staleCheck.report.data.configuration_changed, true);
  assert.ok(staleCheck.report.data.diagnostics.some(item => item.code === 'CONFIG_CHANGED'));
  result = await (await action({ action: 'set', params: { mode: 'cut', expectRevision: revision } })).json();
  assert.equal(result.exit_code, 1); assert.equal(result.report.errors[0].code, 'CONFIG_CHANGED');
  result = await (await action({ action: 'status' })).json(); revision = result.report.data.configuration_revision;
  result = await (await action({ action: 'restore', params: { expectRevision: revision } })).json();
  assert.equal(result.exit_code, 0); assert.equal(result.report.data.mode, null);
  assert.equal((await fetch(service.url + '/not-in-static-list')).status, 404);
});

test('web actions reject model checks and history while the CLI remains separate', () => {
  const env = { home: '/tmp/home', project: '/tmp' };
  for (const body of [
    { action: 'models', params: {} },
    { action: 'models', params: { verify: true, discover: true, expectCatalog: 'a'.repeat(64) } },
    { action: 'history', params: {} },
  ]) assert.throws(() => actionCommand(body, env), { code: 'INVALID_ARGUMENT' });
});

test('web verification is limited to the active primary combinations and requires a revision', () => {
  const env = { home: '/fake home', project: '/project' };
  assert.deepEqual(actionCommand({ action: 'verify', params: { expectRevision: 'stable' } }, env).argv,
    ['models', 'check', '--verify', '--codex-home=/fake home', '--json', '--expect-revision=stable']);
  for (const params of [{}, { expectRevision: 'stable', model: 'other', effort: 'high' },
    { expectRevision: 'stable', discover: true }, { expectRevision: 'stable', verify: false }]) {
    assert.throws(() => actionCommand({ action: 'verify', params }, env), { code: 'INVALID_ARGUMENT' });
  }
});

test('scoped web actions bind paths and threads on the server, never from page input', () => {
  const context = { home: '/home', project: '/project root', thread: 'chat-a' };
  const command = actionCommand({ action: 'verify', params: { scope: 'session', expectRevision: 'stable' } }, context);
  assert.ok(command.argv.includes('--scope=session'));
  assert.ok(command.argv.includes('--project=/project root'));
  assert.ok(command.argv.includes('--thread=chat-a'));
  for (const params of [{ scope: 'session', project: '/other' }, { scope: 'session', thread: 'other' }, { scope: 'invalid' }]) {
    assert.throws(() => actionCommand({ action: 'status', params }, context));
  }
  assert.throws(() => actionCommand({ action: 'status', params: { scope: 'session' } }, { home: '/home', project: '/project' }), { code: 'THREAD_REQUIRED' });
  assert.equal(actionCommand({ action: 'clear', params: { scope: 'project', expectRevision: 'stable' } }, context).argv[1], 'clear');
});
