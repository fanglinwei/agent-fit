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
  assert.equal((await action({ action: 'setup', params: { codexHome: '/other', expectRevision: 'x' } })).status, 400);
  let result = await (await action({ action: 'status', params: { details: true } })).json();
  assert.equal(result.report.data.installation, 'not_installed');
  let revision = result.report.data.configuration_revision;
  result = await (await action({ action: 'setup', params: { mode: 'mid', dryRun: true, expectRevision: revision } })).json();
  assert.equal(result.report.data.result, 'preview');
  result = await (await action({ action: 'setup', params: { mode: 'mid', expectRevision: revision } })).json();
  assert.equal(result.exit_code, 0, JSON.stringify(result)); assert.equal(result.report.data.restart.required, true);
  result = await (await action({ action: 'set', params: { mode: 'low', expectRevision: revision } })).json();
  assert.equal(result.exit_code, 1); assert.equal(result.report.errors[0].code, 'CONFIG_CHANGED');
  result = await (await action({ action: 'status' })).json(); revision = result.report.data.configuration_revision;
  result = await (await action({ action: 'restore', params: { expectRevision: revision } })).json();
  assert.equal(result.exit_code, 0); assert.equal(result.report.data.mode, null);
  assert.equal((await fetch(service.url + '/not-in-static-list')).status, 404);
});
