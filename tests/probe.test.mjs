import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink, realpath, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { probeResponses, providerModels } from '../lib/probe.mjs';

const key = 'PRIVATE_PROBE_CREDENTIAL';
const pair = { model: 'gpt-6-astra', effort: 'ultra' };
const config = { model_provider: 'custom', model_providers: { custom: { base_url: 'https://configured.example/v1', env_key: 'PROBE_TEST_KEY', wire_api: 'responses' } } };
function completed(overrides = {}) { return { object: 'response', status: 'completed', model: pair.model, reasoning: { effort: pair.effort }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }], ...overrides }; }
async function invoke(value, options = {}) {
  let request;
  const result = await probeResponses({ home: '/tmp', config, pair, deadline: Date.now() + 2000 }, { env: { PROBE_TEST_KEY: key }, fetch: async (url, init) => { request = { url, ...init }; return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }); }, ...options });
  return { result, request };
}
test('a real tool-free request uses only the selected provider and checks response metadata', async () => {
  const { result, request } = await invoke(completed());
  assert.equal(request.url.href, 'https://configured.example/v1/responses');
  assert.equal(request.headers.get('authorization'), 'Bearer ' + key);
  const body = JSON.parse(request.body);
  assert.deepEqual(body.tools, []); assert.equal(body.tool_choice, 'none'); assert.equal(body.store, false);
  assert.equal(body.model, pair.model); assert.equal(body.reasoning.effort, pair.effort);
  assert.equal(body.input.length, 1); assert.equal(request.redirect, 'error');
  assert.equal(result.request_status, 'succeeded'); assert.equal(result.identity_status, 'matched');
  assert.equal(JSON.stringify(result).includes(key), false);
});
test('missing or mismatched identity never passes even when the request succeeds', async () => {
  assert.equal((await invoke(completed({ reasoning: null }))).result.reason_code, 'PROBE_IDENTITY_UNVERIFIED');
  assert.equal((await invoke(completed({ model: 'different' }))).result.reason_code, 'PROBE_IDENTITY_MISMATCH');
  assert.equal((await invoke(completed({ output: [{ type: 'function_call', name: 'shell' }] }))).result.reason_code, 'PROBE_UNEXPECTED_OUTPUT');
  assert.equal((await invoke(completed({ status: 'incomplete' }))).result.request_status, 'incomplete');
});
test('HTTP, malformed, oversized, truncated stream and network failures are classified without raw errors', async () => {
  for (const [status, code] of [[401, 'PROBE_AUTH_FAILED'], [403, 'PROBE_ACCESS_DENIED'], [429, 'PROBE_RATE_LIMITED'], [500, 'PROBE_HTTP_FAILED']]) {
    const { result } = await invoke(null, { fetch: async () => new Response(key, { status }) });
    assert.equal(result.reason_code, code); assert.equal(result.http_status, status);
    assert.equal(JSON.stringify(result).includes(key), false);
  }
  for (const fetch of [async () => { throw Error(key); }, async () => new Response('{broken'), async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)), async () => new Response('data: {"type":"response.created"}\n\n', { headers: { 'content-type': 'text/event-stream' } })]) {
    const { result } = await invoke(null, { fetch }); assert.notEqual(result.reason_code, 'PROBE_VERIFIED'); assert.equal(JSON.stringify(result).includes(key), false);
  }
});
test('streamed completion metadata is required; the assistant cannot declare its own model', async () => {
  const event = 'data: ' + JSON.stringify({ type: 'response.completed', response: completed() }) + '\n\n';
  assert.equal((await invoke(null, { fetch: async () => new Response(event, { headers: { 'content-type': 'text/event-stream' } }) })).result.identity_status, 'matched');
});
test('Codex file authorization is used without writing or following symlinks', async t => {
  const home = await mkdtemp(path.join(await realpath(os.tmpdir()), 'delegation-probe-test-')); t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: key }), { mode: 0o600 });
  let calls = 0;
  const run = () => probeResponses({ home, config: { model_provider: 'openai' }, pair, deadline: Date.now() + 2000 }, { env: {}, fetch: async (_url, init) => { calls++; assert.equal(init.headers.get('authorization'), 'Bearer ' + key); return new Response(JSON.stringify(completed())); } });
  assert.equal((await run()).identity_status, 'matched');
  await chmod(path.join(home, 'auth.json'), 0o644);
  assert.equal((await run()).identity_status, 'matched');
  await chmod(path.join(home, 'auth.json'), 0o666);
  assert.equal((await run()).reason_code, 'PROBE_AUTH_UNAVAILABLE');
  await rm(path.join(home, 'auth.json')); await symlink('/etc/passwd', path.join(home, 'auth.json'));
  assert.equal((await run()).reason_code, 'PROBE_AUTH_UNAVAILABLE'); assert.equal(calls, 2);
});
test('missing custom provider credentials, commands and insecure endpoints cause no network call', async () => {
  for (const provider of [{ base_url: 'http://public.example/v1', env_key: 'PROBE_TEST_KEY' }, { base_url: 'https://configured.example', env_key: 'MISSING' }, { base_url: 'https://configured.example', auth: { command: 'anything' } }]) {
    let called = false;
    const result = await probeResponses({ home: '/tmp', config: { model_provider: 'custom', model_providers: { custom: provider } }, pair, deadline: Date.now() + 2000 }, { env: { PROBE_TEST_KEY: key }, fetch: async () => { called = true; throw Error(); } });
    assert.equal(called, false); assert.equal(result.request_status, 'not_checked');
  }
});

test('provider model-not-found is shown as unavailable and does not expose the raw message', async () => {
 const {result}=await invoke(null,{fetch:async()=>new Response(JSON.stringify({error:{code:'model_not_found',param:'model',message:key}}),{status:400})});
 assert.equal(result.reason_code,'PROBE_MODEL_NOT_FOUND');assert.equal(result.request_status,'failed');assert.equal(result.access,'unavailable');assert.equal(JSON.stringify(result).includes(key),false);
});
test('ChatGPT file credentials only go to the official endpoint and credential-store overrides are respected', async t => {
 const home=await mkdtemp(path.join(await realpath(os.tmpdir()),'delegation-oauth-probe-'));t.after(()=>rm(home,{recursive:true,force:true}));
 await writeFile(path.join(home,'auth.json'),JSON.stringify({auth_mode:'chatgpt',OPENAI_API_KEY:'STALE_KEY',tokens:{access_token:key,account_id:'PRIVATE_ACCOUNT'}}),{mode:0o600});
 let calls=0;
 const run=config=>probeResponses({home,config,pair,deadline:Date.now()+2000},{env:{},fetch:async(url,init)=>{
  calls++;assert.equal(url.href,'https://chatgpt.com/backend-api/codex/responses');assert.equal(init.headers.get('authorization'),'Bearer '+key);assert.equal(init.headers.get('chatgpt-account-id'),'PRIVATE_ACCOUNT');
  return new Response(JSON.stringify(completed()));
 }});
 assert.equal((await run({model_provider:'openai'})).reason_code,'PROBE_VERIFIED');
 assert.equal((await run({model_provider:'openai',cli_auth_credentials_store:'keyring'})).reason_code,'PROBE_AUTH_UNAVAILABLE');
 assert.equal((await run({model_provider:'custom',model_providers:{custom:{base_url:'https://configured.example',requires_openai_auth:true}}})).reason_code,'PROBE_PROVIDER_UNSUPPORTED');
 assert.equal(calls,1);
});

test('provider candidates use the same credentials and endpoint; only identifiers are projected', async () => {
  const load = data => providerModels({home:'/tmp',config,deadline:Date.now()+2000},{env:{PROBE_TEST_KEY:key},fetch:async(url,init)=>{
    assert.equal(url.href,'https://configured.example/v1/models'); assert.equal(init.method,'GET');
    assert.equal(init.headers.get('authorization'),'Bearer '+key); assert.equal(init.redirect,'error');
    return new Response(JSON.stringify(data));
  }});
  const result=await load({data:[{id:'provider-a',owned_by:key},{id:'provider-b'},{id:'provider-a'}],secret:key});
  assert.equal(result.status,'complete'); assert.equal(result.models.length,2); assert.deepEqual(result.models[0].supported_reasoning_efforts,[]);
  assert.equal(result.models[0].default_reasoning_effort,null); assert.equal(JSON.stringify(result).includes(key),false);
  assert.equal((await load({data:[{id:'provider-b'},{id:'provider-a'}]})).revision,result.revision);
  assert.equal((await load({data:[{id:'bad\nmodel'}]})).reason_code,'PROVIDER_CATALOG_INVALID');
  const partial=await load({data:[{id:'provider-a'}],has_more:true});
  assert.equal(partial.status,'incomplete');assert.equal(partial.revision,null);assert.equal(partial.reason_code,'PROVIDER_CATALOG_PARTIAL');
  assert.equal((await load({data:Array.from({length:1001},(_,i)=>({id:'model-'+i}))})).reason_code,'PROVIDER_CATALOG_INVALID');
});
test('default-parameter availability does not manufacture a reasoning level or strict identity proof', async () => {
  let body;
  const result=await probeResponses({home:'/tmp',config,pair:{model:pair.model,effort:null},deadline:Date.now()+2000},{env:{PROBE_TEST_KEY:key},fetch:async(_url,init)=>{
    body=JSON.parse(init.body);return new Response(JSON.stringify(completed({reasoning:null})));
  }});
  assert.equal(Object.hasOwn(body,'reasoning'),false);assert.equal(result.access,'available');
  assert.equal(result.reason_code,'PROBE_AVAILABLE');assert.equal(result.identity_status,'unverified');
});
test('provider list HTTP and timeout failures remain safe and do not return a Codex catalogue', async () => {
  for (const [status,code] of [[401,'PROBE_AUTH_FAILED'],[403,'PROBE_ACCESS_DENIED'],[404,'PROVIDER_CATALOG_FAILED'],[429,'PROBE_RATE_LIMITED']]) {
    const result=await providerModels({home:'/tmp',config,deadline:Date.now()+2000},{env:{PROBE_TEST_KEY:key},fetch:async()=>new Response(key,{status})});
    assert.equal(result.status,'incomplete');assert.equal(result.reason_code,code);assert.deepEqual(result.models,[]);assert.equal(JSON.stringify(result).includes(key),false);
  }
  const result=await providerModels({home:'/tmp',config,deadline:Date.now()-1},{env:{PROBE_TEST_KEY:key},fetch:async()=>{throw Error('should not call');}});
  assert.equal(result.reason_code,'PROBE_TIMEOUT');
});
