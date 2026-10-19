import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAccountController } from '../lib/accounts.mjs';
import { probeResponses } from '../lib/probe.mjs';

const PRIVATE = 'PRIVATE_KEY_TOKEN_EMAIL';
async function fixture(t) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'delegation-auth-test-'));
  const home = path.join(root, 'home'); await mkdir(home);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, home };
}
function fakeServer(options = {}) {
  const calls = [], launches = [];
  const script = `
    import readline from 'node:readline';
    import fs from 'node:fs';
    const options = ${JSON.stringify(options)};
    const file=process.env.CODEX_HOME + '/fake-account';
    let type=fs.existsSync(file)?fs.readFileSync(file,'utf8'):options.accountType??null;
    const reply=(id,result)=>process.stdout.write(JSON.stringify({id,result})+'\\n');
    const notify=success=>process.stdout.write(JSON.stringify({method:'account/login/completed',params:{loginId:'login-id',success,error:${JSON.stringify(PRIVATE)}}})+'\\n');
    let pending=false;
    for await(const line of readline.createInterface({input:process.stdin})) {
      const request=JSON.parse(line);
      if(request.method==='initialized') continue;
      if(request.method==='initialize') reply(request.id,{codexHome:options.wrongHome??process.env.CODEX_HOME});
      else if(request.method==='config/read') reply(request.id,{config:options.config??{model_provider:'openai',model_providers:{openai:options.envKey?{env_key:options.envKey}:{}},private:${JSON.stringify(PRIVATE)}}});
      else if(request.method==='account/read') {
        if(pending&&options.completeOnRead){type='chatgpt';fs.writeFileSync(file,type);notify(options.success!==false);pending=false;}
        reply(request.id,{account:type?{type,email:${JSON.stringify(PRIVATE)},token:${JSON.stringify(PRIVATE)}}:null,requiresOpenaiAuth:true});
      } else if(request.method==='account/login/start') {
        if(options.rpcError){process.stdout.write(JSON.stringify({id:request.id,error:{code:-32000,message:${JSON.stringify(PRIVATE)}}})+'\\n');continue;}
        if(request.params.type==='apiKey'){type='apiKey';fs.writeFileSync(file,type);reply(request.id,{type,token:${JSON.stringify(PRIVATE)}});}
        else {
          const type=request.params.type;
          if(options.early){fs.writeFileSync(file,'chatgpt');notify(true);}
          reply(request.id,{type,loginId:'login-id',authUrl:options.url??'https://auth.openai.com/authorize?state=test',verificationUrl:options.url??'https://auth.openai.com/codex/device',userCode:'ABCD-1234',private:${JSON.stringify(PRIVATE)}});pending=true;
        }
      } else if(request.method==='account/login/cancel'){pending=false;notify(false);reply(request.id,{status:'canceled'});}
      else if(request.method==='account/logout'){type=null;fs.rmSync(file,{force:true});reply(request.id,{});}
      else process.exit(4);
    }
  `;
  return { calls, launches, spawn(command, args, settings) {
    launches.push({ command, args, settings });
    const child=spawn(process.execPath,['--input-type=module','-e',script],settings);
    const write=child.stdin.write.bind(child.stdin);
    child.stdin.write=(bytes,...rest)=>{ const request=JSON.parse(bytes); if(request.params?.apiKey) request.params.apiKey='[redacted]'; calls.push(request); return write(bytes,...rest); };
    return child;
  } };
}
test('existing Codex authorization is reused without login and private account fields stay private', async t => {
  const { home }=await fixture(t); const server=fakeServer({accountType:'chatgpt'});
  const controller=createAccountController(home,{spawn:server.spawn}); t.after(()=>controller.close());
  const result=await controller.action({operation:'status'});
  assert.equal(result.account.status,'authenticated'); assert.equal(result.credential_source,'codex_login');
  assert.equal(JSON.stringify(result).includes(PRIVATE),false);
  assert.equal(server.calls.some(call=>call.method==='account/login/start'),false);
  assert.equal(server.launches[0].settings.env.CODEX_HOME,home);
  await assert.rejects(stat(server.launches[0].settings.cwd),{code:'ENOENT'});
});
test('browser and device authorization remain alive until completion, then re-read persisted login', async t => {
  for(const method of ['chatgpt','chatgptDeviceCode']) {
    const { home }=await fixture(t); const server=fakeServer({completeOnRead:true});
    const controller=createAccountController(home,{spawn:server.spawn}); t.after(()=>controller.close());
    const pending=await controller.action({operation:'login',method});
    assert.equal(pending.login.status,'pending'); assert.ok(pending.login.url.startsWith('https://auth.openai.com/'));
    assert.equal(pending.login.user_code,method==='chatgptDeviceCode'?'ABCD-1234':null);
    await stat(server.launches[0].settings.cwd);
    await assert.rejects(controller.action({operation:'login',method}),{code:'LOGIN_PENDING'});
    const result=await controller.action({operation:'status'});
    assert.equal(result.login.status,'succeeded'); assert.equal(result.account.status,'authenticated');
    assert.equal(result.login.url,null); assert.equal(JSON.stringify(result).includes(PRIVATE),false);
    await assert.rejects(stat(server.launches[0].settings.cwd),{code:'ENOENT'});
    const restarted=createAccountController(home,{spawn:server.spawn}); t.after(()=>restarted.close());
    assert.equal((await restarted.action({operation:'status'})).account.status,'authenticated');
  }
});
test('API key uses stdin RPC only and logout clears official login', async t => {
  const { home }=await fixture(t); const server=fakeServer(); const controller=createAccountController(home,{spawn:server.spawn}); t.after(()=>controller.close());
  const result=await controller.action({operation:'login',method:'apiKey',apiKey:PRIVATE});
  assert.equal(result.login.status,'succeeded'); assert.equal(result.account.type,'apiKey');
  assert.equal(JSON.stringify(result).includes(PRIVATE),false);
  assert.equal(JSON.stringify(server.launches.map(item=>item.args)).includes(PRIVATE),false);
  assert.equal(await readFile(path.join(home,'fake-account'),'utf8'),'apiKey');
  assert.equal(server.calls.find(call=>call.method==='account/login/start').params.apiKey,'[redacted]');
  assert.equal((await controller.action({operation:'logout'})).account.status,'authentication_required');
});
test('provider environment credentials are detected without returning their values or starting login', async t => {
  const {home}=await fixture(t);const key='SUBAGENT_AUTH_TEST_CREDENTIAL';const previous=process.env[key];process.env[key]=PRIVATE;
  t.after(()=>{if(previous===undefined)delete process.env[key];else process.env[key]=previous;});
  const server=fakeServer({envKey:key,accountType:'chatgpt'});const controller=createAccountController(home,{spawn:server.spawn});t.after(()=>controller.close());
  const result=await controller.action({operation:'status'});
  assert.equal(result.credential_source,'provider_environment');assert.equal(JSON.stringify(result).includes(PRIVATE),false);
  assert.equal(server.calls.some(call=>call.method==='account/login/start'),false);
});
test('default OpenAI credentials shown in accounts match the login used by verification', async t => {
  const { home } = await fixture(t);
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'UNSELECTED_ENVIRONMENT_KEY';
  t.after(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
  const config = { model_provider: 'openai' };
  const server = fakeServer({ config, accountType: 'apiKey' });
  const controller = createAccountController(home, { spawn: server.spawn }); t.after(() => controller.close());
  await writeFile(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: PRIVATE }), { mode: 0o600 });
  const account = await controller.action({ operation: 'status' });
  assert.equal(account.credential_source, 'codex_login');
  const probe = await probeResponses({ home, config, pair: { model: 'fixture', effort: 'low' }, deadline: Date.now() + 2000 }, { fetch: async (_url, init) => {
    assert.equal(init.headers.get('authorization'), 'Bearer ' + PRIVATE);
    return new Response(JSON.stringify({ status: 'completed', model: 'fixture', reasoning: { effort: 'low' }, output: [{ type: 'message' }] }));
  } });
  assert.equal(probe.reason_code, 'PROBE_VERIFIED');
  assert.equal(JSON.stringify({ account, probe }).includes(PRIVATE), false);
});
test('cancel, timeout, early completion, login failure and invalid auth URL terminate safely', async t => {
  for(const scenario of ['cancel','timeout','early','failure','url']) {
    const { home }=await fixture(t);
    const server=fakeServer({early:scenario==='early',completeOnRead:scenario==='failure',success:scenario!=='failure',url:scenario==='url'?'https://evil.example/authorize':undefined});
    const controller=createAccountController(home,{spawn:server.spawn,timeoutMs:scenario==='timeout'?500:10000}); t.after(()=>controller.close());
    if(scenario==='url') {await assert.rejects(controller.action({operation:'login',method:'chatgpt'}),{code:'AUTH_RESPONSE_INVALID'});continue;}
    const pending=await controller.action({operation:'login',method:'chatgpt'});
    if(scenario==='early') {assert.equal(pending.login.status,'succeeded');continue;}
    if(scenario==='cancel') assert.equal((await controller.action({operation:'cancel'})).login.status,'cancelled');
    if(scenario==='failure') assert.equal((await controller.action({operation:'status'})).login.status,'failed');
    if(scenario==='timeout') {await new Promise(resolve=>setTimeout(resolve,550));assert.equal((await controller.action({operation:'status'})).login.status,'expired');}
    await assert.rejects(stat(server.launches[0].settings.cwd),{code:'ENOENT'});
  }
});
test('RPC errors and mismatched or symlinked homes cannot authorize another configuration directory', async t => {
  const { root, home }=await fixture(t);
  const controller=createAccountController(home,{spawn:fakeServer({rpcError:true}).spawn}); t.after(()=>controller.close());
  await assert.rejects(controller.action({operation:'login',method:'apiKey',apiKey:PRIVATE}),error=>error.code==='ACCOUNT_UNAVAILABLE'&&!error.message.includes(PRIVATE));
  const wrong=createAccountController(home,{spawn:fakeServer({wrongHome:'/other'}).spawn}); t.after(()=>wrong.close());
  await assert.rejects(wrong.action({operation:'status'}),{code:'RPC_HOME_MISMATCH'});
  const link=path.join(root,'linked');await symlink(home,link);
  const unsafe=createAccountController(link,{spawn:fakeServer().spawn});t.after(()=>unsafe.close());
  await assert.rejects(unsafe.action({operation:'status'}));
});
