import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { inspectProject } from '../lib/codex.mjs';
import { mutate, statusReport } from '../lib/install.mjs';

test('project queries include ancestor root rules, nested role candidates and safe profiles without instructions', async t => {
 const dir=await mkdtemp(path.join(os.tmpdir(),'delegation-project-')); t.after(()=>rm(dir,{recursive:true,force:true}));
 const root=await realpath(dir), child=path.join(root,'project/child'); await mkdir(child,{recursive:true});
 await mkdir(path.join(root,'.codex/agents/nested'),{recursive:true});
 await writeFile(path.join(root,'AGENTS.md'),'TEST_ONLY_NOT_REAL private instructions');
 await writeFile(path.join(root,'.codex/config.toml'),'api_key="TEST_ONLY_NOT_REAL"\n[profiles.work]\nmodel="custom"\n[agents.external]\nconfig_file="/untrusted/role.toml"\n');
 await writeFile(path.join(root,'.codex/agents/nested/a.toml'),'name="task_scan"\nmodel="custom"\ndeveloper_instructions="TEST_ONLY_NOT_REAL"\n');
 const result=await inspectProject(child);
 assert.ok(result.candidates.some(c=>c.kind==='project_rules'&&c.source===path.join(root,'AGENTS.md')));
 assert.ok(result.candidates.some(c=>c.kind==='project_role'&&c.name==='task_scan'));
 assert.ok(result.candidates.some(c=>c.kind==='profile_candidate'&&c.name==='work'));
 assert.ok(result.candidates.some(c=>c.kind==='role_registration'&&c.inspected===false));
 assert.ok(!JSON.stringify(result).includes('TEST_ONLY_NOT_REAL'));
});

test('project inspection skips symlinked config folders without disclosing outside contents', async t => {
 const dir=await mkdtemp(path.join(os.tmpdir(),'delegation-symlink-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const root=await realpath(dir), project=path.join(root,'project'), outside=path.join(root,'outside');
 await mkdir(project);await mkdir(path.join(outside,'agents'),{recursive:true});
 await writeFile(path.join(outside,'agents/private.toml'),'name="TEST_ONLY_NOT_REAL"');
 await symlink(outside,path.join(project,'.codex'));
 const result=await inspectProject(project);
 assert.ok(result.skipped.some(c=>c.reason==='symlink_not_followed'));
 assert.ok(!JSON.stringify(result).includes('TEST_ONLY_NOT_REAL'));
});

test('global default subagent inheritance and enabled settings are safely projected', async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'delegation-defaults-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const home=await realpath(dir);
 await writeFile(path.join(home,'config.toml'),'api_key="TEST_ONLY_NOT_REAL"\n[agents]\nenabled=false\ndefault_subagent_model="custom"\ndefault_subagent_reasoning_effort="high"\n');
 await mutate(home,'setup');const result=await statusReport(home,{details:true});
 assert.equal(result.related_config.agents_enabled,false);
 assert.equal(result.related_config.default_subagent_model,'custom');
 assert.equal(result.related_config.default_subagent_reasoning_effort,'high');
 assert.ok(!JSON.stringify(result).includes('TEST_ONLY_NOT_REAL'));
});
