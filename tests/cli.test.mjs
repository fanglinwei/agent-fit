import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile, mkdir, writeFile, chmod, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCommand } from '../bin/subagent-delegation.mjs';
import { BUILTINS, VERSION } from '../lib/codex.mjs';

const CLI = fileURLToPath(new URL('../bin/subagent-delegation.mjs', import.meta.url));
const run = (home, args, input) => {
  const result = spawnSync(process.execPath, [CLI, ...args, '--json', ...(args.includes('--help') || args.includes('--version') ? [] : ['--codex-home', home])], { encoding: 'utf8', input, env: { ...process.env, PATH: '/nonexistent' } });
  return { ...result, report: JSON.parse(result.stdout) };
};

test('help/version and strict argument errors never require a home', () => {
  assert.equal(run('/not-a-home', ['--version']).report.data.cli_version, VERSION);
  assert.match(run('/not-a-home', ['--help']).report.data.help, /mode configure/);
  for (const args of [['setup', '--agent', 'other'], ['setup', '--bogus'], ['mode', 'bad'], ['mode', 'configure', 'a', '--definition-stdin', '--level', 'L1'], ['models', 'check', '--model', 'x'], ['serve', '--port', '80'], ['setup', '--mode', 'balanced', '--mode', 'economy']]) {
    assert.throws(() => parseCommand(args), e => e.exitCode === 2);
  }
  assert.equal(parseCommand(['mode', 'create', '--agent', 'codex', '--', '-named']).options.name, '-named');
});

test('real CLI supports setup/switch/custom whole stdin/status/explain/restore with restart results', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'delegation-cli-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home with spaces');
  const dry = run(home, ['setup', '--dry-run']); assert.equal(dry.status, 0); assert.equal(dry.report.data.result, 'preview');
  await assert.rejects(readFile(path.join(home, 'AGENTS.md')));
  assert.equal(run(home, ['explain', '--level', 'L1']).status, 1);
  assert.equal(run(home, ['explain', '--mode', 'balanced', '--level', 'L1']).status, 0);
  let result = run(home, ['setup']); assert.equal(result.status, 0, result.stdout); assert.equal(result.report.data.restart.required, true);
  result = run(home, ['mode', 'set', 'performance']); assert.equal(result.status, 0); assert.match(result.report.data.restart.message, /重启 Codex/);
  result = run(home, ['mode', 'create', '我的任务']); assert.equal(result.status, 0); assert.equal(result.report.data.restart.required, false);
  const definition = { levels: structuredClone(BUILTINS[1].levels) }; definition.levels.L4 = { model: 'my-model', effort: 'high', fallback: null };
  result = run(home, ['mode', 'configure', '我的任务', '--definition-stdin'], JSON.stringify(definition)); assert.equal(result.status, 0, result.stdout);
  result = run(home, ['mode', 'set', '我的任务']); assert.equal(result.status, 0);
  const status = run(home, ['status', '--details']); assert.equal(status.status, 0); assert.equal(status.report.data.mode.levels.L4.model, 'my-model');
  const invalid = structuredClone(definition); invalid.levels.L1.model = '\ud800';
  result = run(home, ['mode', 'configure', '我的任务', '--definition-stdin'], JSON.stringify(invalid));
  assert.equal(result.status, 2);
  assert.equal(run(home, ['status']).report.data.configuration_revision, status.report.data.configuration_revision);
  result = run(home, ['explain', '--level', 'L4', '--role', 'task_review']); assert.equal(result.status, 0); assert.equal(result.report.data.dispatch_role, 'task_delegate');
  assert.equal(result.report.data.permission_contract, 'readonly_review');
  result = run(home, ['restore']); assert.equal(result.status, 0, result.stdout); assert.equal(result.report.data.restart.required, true);
  assert.equal(run(home, ['status']).report.data.installation, 'not_installed');
});

test('real CLI JSON errors redact malformed private config and reject stale revisions', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'delegation-private-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home'); await mkdir(home);
  await writeFile(path.join(home, 'config.toml'), 'api_key = "TEST_ONLY_NOT_REAL');
  let result = run(home, ['setup']); assert.equal(result.status, 1); assert.ok(!`${result.stdout}${result.stderr}`.includes('TEST_ONLY_NOT_REAL'));
  await writeFile(path.join(home, 'config.toml'), 'model = "user"\n');
  result = run(home, ['setup']); assert.equal(result.status, 0);
  result = run(home, ['mode', 'set', 'economy', '--expect-revision', 'old']); assert.equal(result.status, 1); assert.equal(result.report.errors[0].code, 'CONFIG_CHANGED');
  assert.equal(run(home, ['status']).report.data.mode.id, 'balanced');
  assert.equal(run(home, ['mode', 'configure', 'balanced', '--definition-stdin'], '{broken').status, 2);
  assert.equal(run(home, ['mode', 'configure', 'balanced', '--definition-stdin'], ' '.repeat(65537)).status, 2);
  const roleFile = path.join(home, 'agents/task-scan.toml');
  await writeFile(roleFile, await readFile(roleFile, 'utf8') + '\n# changed\n');
  result = run(home, ['status']); assert.equal(result.status, 1); assert.equal(result.report.data.integrity, 'drifted');
  result = run(home, ['explain', '--level', 'L1', '--role', 'task_scan']);
  assert.equal(result.status, 1); assert.equal(result.report.data.dispatch_role, 'task_scan');
  assert.ok(result.report.errors.some(error => error.code === 'MANAGED_FILE_DRIFT'));
});

test('human CLI errors escape terminal controls in untrusted paths', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'delegation-terminal-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home'), hostile = path.join(home, 'agents', '\u001b[2JATTACK');
  await mkdir(hostile, { recursive: true }); await chmod(hostile, 0o1700);
  const result = spawnSync(process.execPath, [CLI, 'status', '--codex-home', home], { encoding: 'utf8', env: { ...process.env, PATH: '/nonexistent' } });
  assert.equal(result.status, 1);
  assert.ok(!result.stderr.includes('\u001b')); assert.match(result.stderr, /\\u001b\[2JATTACK/);
});

test('npm style symlink executable runs the CLI main entry', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'delegation-bin-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const link = path.join(dir, 'installed command'); await symlink(CLI, link);
  const result = spawnSync(process.execPath, [link, '--version', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).data.cli_version, VERSION);
});
