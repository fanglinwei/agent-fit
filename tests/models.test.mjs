import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, realpath, rm, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { checkAccountModels } from '../lib/models.mjs';
import { BUILTINS } from '../lib/codex.mjs';

const PRIVATE = 'PRIVATE_SENTINEL_TOKEN_EMAIL_CONFIG';
function model(name = 'gpt-6-luna', efforts = ['high', 'medium']) {
  return { id: name, model: name, displayName: name, description: PRIVATE, hidden: false, defaultReasoningEffort: efforts[0], supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort, description: PRIVATE })), inputModalities: ['text', 'image'], privateConfig: PRIVATE };
}
async function fixture(t) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'delegation-model-test-'));
  const home = path.join(root, 'home');
  await mkdir(home);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, home };
}
function fakeServer(options = {}) {
  const calls = [], children = [], launches = [];
  const script = `
    import readline from 'node:readline';
    import fs from 'node:fs';
    const options = ${JSON.stringify(options)};
    let initialized = false, page = 0;
    const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\\n');
    for await (const line of readline.createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      if (request.method === 'initialized') { initialized = true; continue; }
      if (options.stderr) process.stderr.write(options.stderr);
      if (request.method === options.hang) continue;
      if (request.method === options.exit) process.exit(0);
      if (request.method === options.malformed) { process.stdout.write('{' + ${JSON.stringify(PRIVATE)} + '\\n'); continue; }
      if (request.method === options.frameLimit) { process.stdout.write('x'.repeat(1024 * 1024 + 1)); continue; }
      if (request.method === options.totalLimit) {
        for (let i = 0; i < 50; i++) process.stdout.write(JSON.stringify({method:'ignored',params:'x'.repeat(200000)}) + '\\n');
        continue;
      }
      if (request.method === options.rpcError) { process.stdout.write(JSON.stringify({ id: request.id, error: { code: -32000, message: ${JSON.stringify(PRIVATE)}, data: { token: ${JSON.stringify(PRIVATE)} } } }) + '\\n'); continue; }
      if (request.method === 'initialize') {
        if (fs.readdirSync(process.cwd()).length) process.exit(5);
        reply(request.id, options.handshake ?? {userAgent:'codex-cli/0.156.1', codexHome:process.env.CODEX_HOME, platformFamily:'unix', platformOs:'macos'});
      } else if (!initialized) process.exit(6);
      else if (request.method === 'account/read') reply(request.id, options.account ?? {account:{type:'chatgpt',email:${JSON.stringify(PRIVATE)},planType:'pro',token:${JSON.stringify(PRIVATE)}},requiresOpenaiAuth:true,workspaceRouting:{chatgptAccountId:${JSON.stringify(PRIVATE)}}});
      else if (request.method === 'config/read') {
        if (options.noConfigRead) process.stdout.write(JSON.stringify({id:request.id,error:{code:-32601,message:${JSON.stringify(PRIVATE)}}}) + '\\n');
        else reply(request.id, {config:{model_provider:options.provider ?? 'openai',token:${JSON.stringify(PRIVATE)},profiles:{private:${JSON.stringify(PRIVATE)}}},origins:{private:${JSON.stringify(PRIVATE)}}});
      } else if (request.method === 'model/list') {
        if (!request.params.includeHidden) process.exit(7);
        if (options.loop) reply(request.id, {data:[],nextCursor:'same'});
        else if (options.endless) reply(request.id, {data:[],nextCursor:'cursor-' + page++});
        else reply(request.id, (options.pages ?? [{data:${JSON.stringify([model()])},nextCursor:null}])[page++]);
      } else process.exit(8);
    }
  `;
  return {
    calls, children, launches,
    spawn(command, args, settings) {
      launches.push({ command, args, settings });
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], settings);
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (bytes, ...rest) => { calls.push(JSON.parse(bytes)); return write(bytes, ...rest); };
      children.push(child);
      return child;
    },
  };
}
const single = { model: 'gpt-6-luna', effort: 'high' };
const codes = report => report.diagnostics.map(item => item.code);

test('catalog pagination includes hidden models, binds home, and emits only safe fields', async t => {
  const { home } = await fixture(t);
  const server = fakeServer({ stderr: PRIVATE, pages: [{ data: [model()], nextCursor: 'next' }, { data: [{ ...model('gpt-6.1-sol'), hidden: true }], nextCursor: null }] });
  const report = await checkAccountModels({ home, target: single }, { spawn: server.spawn });
  assert.equal(report.exit_code, 0);
  assert.equal(report.status, 'passed');
  assert.equal(report.catalog.status, 'complete');
  assert.equal(report.catalog.pages, 2);
  assert.equal(report.catalog.models[1].hidden, true);
  assert.equal(report.account.status, 'authenticated');
  assert.equal(report.context.provider, 'openai');
  assert.equal(report.context.context_match, 'unverified');
  assert.equal(report.mode, null);
  assert.equal(report.configuration_revision, report.source_revision);
  assert.equal(report.configuration_changed, false);
  assert.equal(report.checked_pairs[0].access, 'unknown');
  assert.equal(report.checked_pairs[0].parameter_support, 'supported');
  assert.equal(JSON.stringify(report).includes(PRIVATE), false);
  assert.deepEqual(server.calls.map(call => call.method), ['initialize', 'initialized', 'account/read', 'config/read', 'model/list', 'model/list']);
  assert.deepEqual(server.calls[0].params.capabilities, { experimentalApi: true });
  assert.equal(server.calls[2].params.refreshToken, false);
  assert.deepEqual(server.calls.slice(4).map(call => call.params.cursor), [null, 'next']);
  assert.equal(server.launches[0].command, 'codex');
  assert.deepEqual(server.launches[0].args, ['app-server']);
  assert.equal(server.launches[0].settings.shell, false);
  assert.equal(server.launches[0].settings.env.CODEX_HOME, home);
  await assert.rejects(stat(server.launches[0].settings.cwd), { code: 'ENOENT' });
  assert.equal(server.children[0].exitCode, 0);
  assert.deepEqual(await readdir(home), []);
});

test('catalog absence leaves access unknown; reliable effort incompatibility returns 3', async t => {
  const { home } = await fixture(t);
  const missing = fakeServer();
  const absent = await checkAccountModels({ home, target: { model: 'not-listed', effort: 'high' } }, { spawn: missing.spawn });
  assert.equal(absent.exit_code, 0);
  assert.equal(absent.checked_pairs[0].reason_code, 'MODEL_NOT_LISTED');
  assert.equal(absent.checked_pairs[0].access, 'unknown');
  const server = fakeServer({ pages: [{ data: [model('gpt-6-luna', ['medium'])] }] });
  const report = await checkAccountModels({ home, target: single }, { spawn: server.spawn });
  assert.equal(report.exit_code, 3);
  assert.equal(report.status, 'failed');
  assert.equal(report.checked_pairs[0].parameter_support, 'incompatible');
  assert.equal(report.checked_pairs[0].access, 'unknown');
});

test('account null is unknown for external providers and authentication required for OpenAI', async t => {
  const { home } = await fixture(t);
  for (const provider of ['external', 'openai']) {
    const server = fakeServer({ provider, account: { account: null, requiresOpenaiAuth: true } });
    const report = await checkAccountModels({ home }, { spawn: server.spawn });
    assert.equal(report.account.status, provider === 'openai' ? 'authentication_required' : 'unknown');
    assert.equal(report.exit_code, provider === 'openai' ? 1 : 0);
    assert.equal(report.catalog.status, 'complete');
  }
});

test('unsupported config read leaves provider unknown without borrowing another context', async t => {
  const { home } = await fixture(t);
  const server = fakeServer({ noConfigRead: true, account: { account: null, requiresOpenaiAuth: false } });
  const report = await checkAccountModels({ home }, { spawn: server.spawn });
  assert.equal(report.exit_code, 0);
  assert.equal(report.context.provider, null);
  assert.equal(report.account.status, 'unknown');
});

test('missing home launches no child and does not create the home', async t => {
  const { root } = await fixture(t);
  const home = path.join(root, 'absent');
  let started = false;
  const report = await checkAccountModels({ home }, { spawn() { started = true; throw Error(PRIVATE); } });
  assert.equal(report.exit_code, 1);
  assert.ok(codes(report).includes('HOME_NOT_FOUND'));
  assert.equal(started, false);
  await assert.rejects(stat(home), { code: 'ENOENT' });
});

test('missing codex executable has a safe diagnostic', async t => {
  const { home } = await fixture(t);
  const report = await checkAccountModels({ home }, { spawn: (_command, _args, settings) => spawn(path.join(home, 'no-codex'), [], settings) });
  assert.equal(report.exit_code, 1);
  assert.ok(codes(report).includes('CODEX_NOT_FOUND'));
});

for (const [name, options, code] of [
  ['timeout', { hang: 'model/list' }, 'RPC_TIMEOUT'],
  ['malformed frame', { malformed: 'account/read' }, 'RPC_INVALID'],
  ['unexpected exit', { exit: 'model/list' }, 'RPC_EXITED'],
  ['frame limit', { frameLimit: 'model/list' }, 'RPC_FRAME_LIMIT'],
  ['total receive limit', { totalLimit: 'model/list' }, 'RPC_TOTAL_LIMIT'],
  ['cursor loop', { loop: true }, 'RPC_CURSOR_LOOP'],
  ['page limit', { endless: true }, 'RPC_PAGE_LIMIT'],
  ['raw RPC error', { rpcError: 'account/read' }, 'RPC_FAILED'],
  ['malformed account', { account: { account: { type: PRIVATE }, requiresOpenaiAuth: true } }, 'RPC_INVALID'],
  ['malformed effort capability', { pages: [{ data: [{ ...model(), supportedReasoningEfforts: ['high'] }] }] }, 'RPC_INVALID'],
  ['malformed input capability', { pages: [{ data: [{ ...model(), inputModalities: [1] }] }] }, 'RPC_INVALID'],
  ['handshake mismatch', { handshake: { userAgent: 'codex-cli/0.156.1', codexHome: '/another-home', platformFamily: 'unix', platformOs: 'macos' } }, 'RPC_HOME_MISMATCH'],
]) {
  test(`${name} returns safe partial data and closes its child`, async t => {
    const { home } = await fixture(t);
    const server = fakeServer(options);
    const report = await checkAccountModels({ home, target: single }, { spawn: server.spawn, deadlineMs: name === 'timeout' ? 150 : 2000 });
    assert.equal(report.exit_code, 1);
    assert.ok(codes(report).includes(code), JSON.stringify(codes(report)));
    assert.notEqual(report.catalog.status, 'complete');
    assert.equal(report.checked_pairs[0].access, 'unknown');
    assert.equal(JSON.stringify(report).includes(PRIVATE), false);
    assert.ok(server.children[0].exitCode !== null || server.children[0].signalCode !== null);
  });
}

test('incomplete pagination preserves models but does not infer an unsupported effort', async t => {
  const { home } = await fixture(t);
  const server = fakeServer({ pages: [{ data: [model('gpt-6-luna', ['medium'])], nextCursor: 'next' }, { data: 'malformed', nextCursor: null }] });
  const report = await checkAccountModels({ home, target: single }, { spawn: server.spawn });
  assert.equal(report.exit_code, 1);
  assert.equal(report.catalog.models.length, 1);
  assert.equal(report.checked_pairs[0].parameter_support, 'unknown');
});

test('post-deployment check keeps immutable committed pairs and revision across a later switch', async t => {
  const { home } = await fixture(t);
  const server = fakeServer();
  const selection = { mode: BUILTINS[0], configurationRevision: 'committed-revision', pairs: [single, single, { model: 'old-custom', effort: 'high' }] };
  let snapshots = 0;
  const report = await checkAccountModels({ home, selection }, { spawn: server.spawn, readSnapshot: async () => ({ configuration_revision: snapshots++ ? 'later-revision' : 'start-revision', mode: BUILTINS[2] }) });
  assert.equal(report.configuration_revision, 'start-revision');
  assert.equal(report.source_revision, 'committed-revision');
  assert.equal(report.mode.id, 'low');
  assert.deepEqual(report.checked_pairs.map(({ model: name, effort }) => ({ model: name, effort })), [single, { model: 'old-custom', effort: 'high' }]);
  assert.equal(report.configuration_changed, true);
  assert.deepEqual(selection.pairs, [single, single, { model: 'old-custom', effort: 'high' }]);
});

test('busy end snapshot reports change unknown without replacing source revision', async t => {
  const { home } = await fixture(t);
  const server = fakeServer();
  let snapshots = 0;
  const report = await checkAccountModels({ home, target: single }, { spawn: server.spawn, readSnapshot: async () => { if (snapshots++) throw Object.assign(Error(PRIVATE), { code: 'BUSY' }); return { configuration_revision: 'initial' }; } });
  assert.equal(report.source_revision, 'initial');
  assert.equal(report.configuration_changed, null);
  assert.equal(JSON.stringify(report).includes(PRIVATE), false);
});

test('verify hard gate sends no thread, turn, tool or inference requests even with a compatible catalog', async t => {
  const { home } = await fixture(t);
  const server = fakeServer({ pages: [{ data: [model(), model('gpt-6.1-sol')] }] });
  const report = await checkAccountModels({ home, verify: true }, { spawn: server.spawn, readSnapshot: async () => ({ configuration_revision: 'initial', mode: BUILTINS[1] }) });
  assert.equal(report.exit_code, 1);
  assert.equal(report.catalog.status, 'complete');
  assert.ok(codes(report).includes('PROBE_ISOLATION_UNSUPPORTED'));
  assert.equal(report.checked_pairs.length, 3);
  assert.ok(report.checked_pairs.every(pair => pair.request_status === 'not_checked' && pair.access === 'unknown' && pair.actual_model === null));
  assert.ok(server.calls.every(call => ['initialize', 'initialized', 'account/read', 'config/read', 'model/list'].includes(call.method)));
  assert.equal(report.diagnostics.find(item => item.code === 'PROBE_ISOLATION_UNSUPPORTED').evidence.tested_cli_version, '0.156.1');
  assert.deepEqual(await readdir(home), []);
});

test('verify incomplete safety gate has exit 1 priority over a known incompatible effort', async t => {
  const { home } = await fixture(t);
  const server = fakeServer({ pages: [{ data: [model('gpt-6-luna', ['medium'])] }] });
  const report = await checkAccountModels({ home, verify: true, target: single }, { spawn: server.spawn });
  assert.equal(report.exit_code, 1);
  assert.equal(report.mode, null);
  assert.equal(report.checked_pairs[0].parameter_support, 'incompatible');
  assert.ok(codes(report).includes('PROBE_ISOLATION_UNSUPPORTED'));
});

test('partial target input rejects before any child can launch', async t => {
  const { home } = await fixture(t);
  let launched = false;
  await assert.rejects(checkAccountModels({ home, target: { model: 'only-model' } }, { spawn() { launched = true; } }), { exitCode: 2 });
  assert.equal(launched, false);
});

test('verify without an installed definition or explicit target returns before spawning', async t => {
  const { home } = await fixture(t);
  let launched = false;
  const report = await checkAccountModels({ home, verify: true }, { spawn() { launched = true; } });
  assert.equal(report.exit_code, 1);
  assert.equal(report.catalog.status, 'not_checked');
  assert.equal(report.checked_pairs.length, 0);
  assert.ok(codes(report).includes('PROBE_TARGET_REQUIRED'));
  assert.equal(launched, false);
});

test('the shared deadline includes initial snapshot reads and does not launch late work', async t => {
  const { home } = await fixture(t);
  let launched = false;
  const report = await checkAccountModels({ home, target: single }, { deadlineMs: 20, spawn() { launched = true; }, readSnapshot: () => new Promise(() => {}) });
  assert.equal(report.exit_code, 1);
  assert.ok(codes(report).includes('RPC_TIMEOUT'));
  assert.equal(launched, false);
  assert.equal(report.configuration_changed, null);
});

test('unsafe home aliases do not start Codex even for an explicit target', async t => {
  const { root, home } = await fixture(t);
  const alias = path.join(root, 'alias');
  await symlink(home, alias);
  let launched = false;
  const report = await checkAccountModels({ home: alias, target: single }, { spawn() { launched = true; } });
  assert.equal(report.exit_code, 1);
  assert.ok(codes(report).includes('INVALID_HOME'));
  assert.equal(launched, false);
});

test('post-check accepts all eight committed primary and fallback combinations', async t => {
  const { home } = await fixture(t);
  const server = fakeServer();
  const pairs = Array.from({ length: 8 }, (_, index) => ({ model: `configured-${index}`, effort: 'high' }));
  const report = await checkAccountModels({ home, selection: { mode: BUILTINS[0], configurationRevision: 'committed', pairs } }, { spawn: server.spawn, readSnapshot: async () => ({ configuration_revision: 'committed' }) });
  assert.equal(report.exit_code, 0);
  assert.equal(report.checked_pairs.length, 8);
  assert.ok(report.checked_pairs.every(pair => pair.access === 'unknown'));
});

test('a supplied home with spaces and quote characters remains data', async t => {
  const { root } = await fixture(t);
  const home = path.join(root, ' home $quoted ` name " ');
  await mkdir(home);
  const server = fakeServer();
  const report = await checkAccountModels({ home, target: single }, { spawn: server.spawn });
  assert.equal(report.exit_code, 0);
  assert.equal(server.launches[0].settings.env.CODEX_HOME, home);
  assert.equal(server.launches[0].settings.shell, false);
  assert.deepEqual(await readdir(home), []);
});
