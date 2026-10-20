import './isolate-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { saveModelCheck, modelHistory, recordedModelCheck } from '../lib/model-history.mjs';
import { readSnapshot } from '../lib/install.mjs';
const PRIVATE='PRIVATE_KEY_TOKEN_EMAIL';
async function fixture(t) {
 const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'delegation-history-test-'));
 const home=path.join(root,'home');await mkdir(home);t.after(()=>rm(root,{recursive:true,force:true}));return {root,home};
}
const data={status:'incomplete',exit_code:1,source_revision:'old',configuration_changed:false,account:{status:'authenticated',type:'chatgpt',email:PRIVATE,token:PRIVATE},context:{provider:'openai',context_match:'unverified',secret:PRIVATE},catalog:{status:'complete',models:[{model:'gpt-6-astra',supported_reasoning_efforts:['ultra'],token:PRIVATE}]},checked_pairs:[{model:'gpt-6-astra',effort:'ultra',request_status:'not_checked',actual_model:null,token:PRIVATE}],diagnostics:[{code:'PROBE_ISOLATION_UNSUPPORTED',status:'unsupported',message:PRIVATE}],apiKey:PRIVATE};
test('each check gets a private persistent record without credentials and without changing the configuration revision',async t=>{
 const {home}=await fixture(t);const before=(await readSnapshot(home)).configuration_revision;
 const saved=await saveModelCheck(home,data,{verify:true});
 assert.equal(saved.status,'saved');
 const record=(await modelHistory(home,{id:saved.id})).record;
 assert.equal(record.kind,'verify');assert.equal(record.result.status,'incomplete');assert.equal(record.result.checked_pairs[0].actual_model,null);
 const file=path.join(home,'.agent-fit-checks',saved.id+'.json');
 assert.equal((await stat(file)).mode&0o777,0o600);assert.equal((await stat(path.dirname(file))).mode&0o777,0o700);
 assert.equal((await readFile(file,'utf8')).includes(PRIVATE),false);
 assert.equal((await readSnapshot(home)).configuration_revision,before);
 await writeFile(path.join(home,'config.toml'),'model = "different"\n');
 assert.notEqual((await readSnapshot(home)).configuration_revision,before);
 const recreated=(await modelHistory(home)).records;assert.equal(recreated[0].id,saved.id);
});
test('authorization changes persist as invalid results without persisting the private binding', async t => {
 const { home } = await fixture(t);
 const saved = await saveModelCheck(home, { ...data, authorization_changed: true, stop_reason: 'PROBE_AUTH_CHANGED', authorization: { fingerprint: PRIVATE } }, { verify: true });
 const record = (await modelHistory(home, { id: saved.id })).record;
 assert.equal(record.result.authorization_changed, true);
 assert.equal(record.result.stop_reason, 'PROBE_AUTH_CHANGED');
 assert.equal((await modelHistory(home)).records[0].authorization_changed, true);
 assert.equal((await readFile(path.join(home, '.agent-fit-checks', saved.id + '.json'), 'utf8')).includes(PRIVATE), false);
});
test('concurrent records are distinct, pagination keeps older records and failed/passed results remain distinct',async t=>{
 const {home}=await fixture(t);
 const saved=await Promise.all(Array.from({length:33},(_,index)=>saveModelCheck(home,{...data,status:index%2?'passed':'failed',exit_code:index%2?0:3})));
 assert.equal(new Set(saved.map(record=>record.id)).size,33);
 const first=await modelHistory(home);assert.equal(first.records.length,30);assert.ok(first.next_cursor);
 const next=await modelHistory(home,{cursor:first.next_cursor});assert.equal(next.records.length,3);assert.equal(next.next_cursor,null);
 assert.equal(new Set([...first.records,...next.records].map(record=>record.id)).size,33);
 assert.ok(first.records.some(record=>record.status==='passed'));assert.ok(first.records.some(record=>record.status==='failed'));
});
test('missing, corrupt, permissive, symlink and traversal records fail safely',async t=>{
 const {root,home}=await fixture(t);assert.deepEqual((await modelHistory(home)).records,[]);
 await assert.rejects(modelHistory(home,{id:'../auth.json'}),{exitCode:2});
 const saved=await saveModelCheck(home,data);const file=path.join(home,'.agent-fit-checks',saved.id+'.json');
 await chmod(file,0o644);await assert.rejects(modelHistory(home,{id:saved.id}),{code:'MODEL_HISTORY_UNAVAILABLE'});
 await chmod(file,0o600);await writeFile(file,'{broken');await assert.rejects(modelHistory(home),{code:'MODEL_HISTORY_UNAVAILABLE'});
 await rm(file);const privateFile=path.join(root,'private');await writeFile(privateFile,PRIVATE);await symlink(privateFile,file);
 await assert.rejects(modelHistory(home,{id:saved.id}),{code:'MODEL_HISTORY_UNAVAILABLE'});
 await rm(path.dirname(file),{recursive:true});await symlink(root,path.dirname(file));
 await assert.rejects(saveModelCheck(home,data),{code:'MODEL_HISTORY_UNAVAILABLE'});
 assert.equal(await readFile(privateFile,'utf8'),PRIVATE);
});
test('even an incomplete CLI lookup is recorded; record failure never turns a model check into a success',async t=>{
 const {home}=await fixture(t);
 // Use a real missing executable so the normal RPC error path is exercised.
 const {spawn}=await import('node:child_process');
 const report=await recordedModelCheck({home,verify:true,target:{model:'gpt-6-astra',effort:'ultra'}},{spawn:(_command,args,settings)=>spawn('/nonexistent/codex',args,settings)});
 assert.equal(report.status,'incomplete');assert.equal(report.history.status,'saved');assert.equal((await modelHistory(home)).records[0].kind,'verify');
 await rm(path.join(home,'.agent-fit-checks'),{recursive:true});await mkdir(path.join(home,'.agent-fit-checks'),{mode:0o755});
 const unsaved=await recordedModelCheck({home},{spawn:(_command,args,settings)=>spawn('/nonexistent/codex',args,settings)});
 assert.equal(unsaved.history.status,'failed');assert.equal(unsaved.status,'incomplete');
});

test('provider candidates, availability outcomes and source survive history without secrets',async t=>{
 const {home}=await fixture(t);
 const report={...data,check_kind:'availability',availability:{total:2,available:1,unavailable:1,unconfirmed:0,secret:PRIVATE},catalog:{...data.catalog,source:'provider_models',revision:'a'.repeat(64)},checked_pairs:[{model:'provider-model',effort:null,reason_code:'PROBE_AVAILABLE',request_status:'succeeded',access:'available',identity_status:'unverified',secret:PRIVATE}]};
 const saved=await saveModelCheck(home,report,{verify:true});const record=(await modelHistory(home,{id:saved.id})).record;
 assert.equal(record.kind,'availability');assert.equal(record.result.catalog.source,'provider_models');assert.equal(record.result.availability.available,1);
 assert.equal(record.result.checked_pairs[0].effort,null);assert.equal(JSON.stringify(record).includes(PRIVATE),false);assert.equal((await modelHistory(home)).records[0].kind,'availability');
});
