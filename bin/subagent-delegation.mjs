#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { VERSION, LEVELS, ROLES, MODE_COMMANDS, argumentError, validateDefinition, validatePair, explainSelection, inspectProject } from '../lib/codex.mjs';

const HELP = `sub-d ${VERSION} — Codex 子代理委派配置
需要 Node.js 22+。npm 安装仅安装命令；setup 显式配置 Codex。
用法：sub-d <命令> [选项]。原命令 subagent-delegation 同样可用。

setup [--mode MODE] [--dry-run]
mode set MODE [--dry-run]
mode list | mode show MODE
mode create NAME [--from MODE] [--dry-run]
mode configure MODE --level L1|L2|L3|L4 --model MODEL --effort EFFORT
  [--fallback-model MODEL --fallback-effort EFFORT | --clear-fallback]
mode configure MODE --definition-stdin [--dry-run]
status [--details] [--project PATH]
explain --level L1|L2|L3|L4 [--mode MODE] [--role ROLE]
models check [--verify] [--model MODEL --effort EFFORT]
restore [--dry-run]
serve [--port PORT] [--open]

内置档位：low（经济）、mid（适中，首次配置默认）、fire（性能）。
省略 --agent 时默认使用 codex；也可显式指定 --agent codex。
目标目录支持 --codex-home PATH；默认 CODEX_HOME 或 ~/.codex。
查询及写命令支持 --json；写命令支持 --expect-revision REV。
--help [--json] | --version [--json]
配置部署改变后，请重启 Codex。目录检查不证明模型调用权限。
完整说明：https://github.com/fanglinwei/subagent-delegation/blob/main/docs/usage.md`;

const strings = ['agent', 'codex-home', 'mode', 'from', 'level', 'model', 'effort', 'fallback-model', 'fallback-effort', 'expect-revision', 'role', 'project', 'port'];
const booleans = ['dry-run', 'json', 'details', 'clear-fallback', 'definition-stdin', 'verify', 'open', 'help', 'version'];
const optionTypes = Object.fromEntries([...strings.map(k => [k, { type: 'string' }]), ...booleans.map(k => [k, { type: 'boolean' }])]);
const common = ['agent', 'codex-home', 'json'];
const write = [...common, 'dry-run', 'expect-revision'];
const commands = {
  setup: [...write, 'mode'], set: write, list: common, show: common,
  create: [...write, 'from'], configure: [...write, 'level', 'model', 'effort', 'fallback-model', 'fallback-effort', 'clear-fallback', 'definition-stdin'],
  status: [...common, 'details', 'project'], explain: [...common, 'level', 'mode', 'role'],
  models: [...common, 'verify', 'model', 'effort'], restore: write,
  serve: ['agent', 'codex-home', 'port', 'open'],
};

export function parseCommand(argv) {
  let parsed;
  try { parsed = parseArgs({ args: argv, options: optionTypes, allowPositionals: true, strict: true, tokens: true }); }
  catch { throw argumentError('未知参数或缺少参数值；使用 --help 查看命令。'); }
  const { values, positionals, tokens } = parsed;
  const seen = new Set();
  for (const token of tokens) if (token.kind === 'option') {
    if (seen.has(token.name)) throw argumentError('参数不能重复。');
    seen.add(token.name);
  }
  if (values.help || values.version) {
    if (positionals.length || Object.keys(values).some(k => !['help', 'version', 'json'].includes(k)) || (values.help && values.version)) throw argumentError('帮助/版本仅支持 --json。');
    return { action: values.help ? 'help' : 'version', values, options: {} };
  }
  let action = positionals[0], selector;
  let count = 1;
  if (action === 'mode') {
    action = positionals[1]; count = 2;
    if (!['set', 'list', 'show', 'create', 'configure'].includes(action)) throw argumentError('未知 mode 子命令。');
    if (action !== 'list') { selector = positionals[2]; count = 3; }
  } else if (action === 'models') {
    if (positionals[1] !== 'check') throw argumentError('models 仅支持 check。');
    count = 2;
  }
  if (!commands[action] || positionals.length !== count || ((count === 3) && !selector)) throw argumentError('命令或位置参数无效；使用 --help。');
  if (Object.keys(values).some(k => !commands[action].includes(k))) throw argumentError('该命令不支持给定参数。');
  if (values.agent !== undefined && values.agent !== 'codex') throw argumentError('首版仅支持 --agent codex。', 'AGENT_UNSUPPORTED');
  if (values.level !== undefined && !LEVELS.includes(values.level)) throw argumentError('任务等级必须是 L1–L4。');
  if (values.role !== undefined && !Object.hasOwn(ROLES, values.role)) throw argumentError('委派角色无效。');
  if (action === 'explain' && !values.level) throw argumentError('explain 需要 --level。');
  if (action === 'models' && Boolean(values.model) !== Boolean(values.effort)) throw argumentError('--model 与 --effort 必须成对。');
  if (action === 'models' && values.model) validatePair({ model: values.model, effort: values.effort });
  if (action === 'configure') {
    const fields = ['level', 'model', 'effort', 'fallback-model', 'fallback-effort', 'clear-fallback'];
    if (values['definition-stdin']) {
      if (fields.some(k => Object.hasOwn(values, k))) throw argumentError('整表 stdin 与单级参数互斥。');
    } else {
      if (!values.level || !values.model || !values.effort) throw argumentError('单级配置需要 --level、--model、--effort。');
      validatePair({ model: values.model, effort: values.effort });
      if (Boolean(values['fallback-model']) !== Boolean(values['fallback-effort']) || (values['clear-fallback'] && values['fallback-model'])) throw argumentError('备用参数必须成对，且与 --clear-fallback 互斥。');
      if (values['fallback-model']) validatePair({ model: values['fallback-model'], effort: values['fallback-effort'] });
    }
  }
  if (action === 'serve' && values.port !== undefined && (!/^\d+$/.test(values.port) || (Number(values.port) !== 0 && (Number(values.port) < 1024 || Number(values.port) > 65535)))) throw argumentError('端口必须是 0 或 1024–65535。');
  const options = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), value]));
  if (action === 'create') options.name = selector;
  else if (selector) options.mode = selector;
  return { action, values, options };
}

async function readDefinition() {
  const chunks = []; let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 65536) throw argumentError('整表输入超过 64 KiB。');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw argumentError('整表输入必须是有效 UTF-8 JSON。'); }
  return { levels: validateDefinition(value) };
}

function terminalText(value) {
  return value.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, char => `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}`);
}

function emit(data, errors, json) {
  if (json) process.stdout.write(JSON.stringify({ report_schema_version: 1, data, errors }) + '\n');
  else {
    if (data) {
      if (data.help) process.stdout.write(data.help + '\n');
      else if (data.cli_version && Object.keys(data).length === 1) process.stdout.write(data.cli_version + '\n');
      else process.stdout.write(renderHuman(data) + '\n');
    }
    for (const error of errors) process.stderr.write(`${terminalText(error.code)}: ${terminalText(error.message)}\n`);
  }
}

function renderHuman(data) {
  const lines = [];
  const pair = value => value ? `${value.model} / ${value.effort}` : '无';
  const modeId = mode => mode.kind === 'builtin' ? Object.keys(MODE_COMMANDS).find(command => MODE_COMMANDS[command] === mode.id) ?? mode.id : mode.id;
  const levels = definition => {
    for (const [level, value] of Object.entries(definition.levels || {})) lines.push(`${level}  ${pair(value)}  备用：${pair(value.fallback)}`);
  };
  if (data.installation) {
    lines.push(`Codex home：${data.home}`, `工具 ${data.cli_version} · 配置 ${data.configuration_version || '未安装'}`, `状态：${data.installation} · 完整性：${data.integrity}`, `已配置档位：${data.mode?.name || '无'}${data.mode ? ` (${modeId(data.mode)})` : ''}`, `恢复基线：${data.restoration.status}`);
    if (data.mode) levels(data.mode);
    if (data.rules.summary.length) {
      lines.push('', '职责与规则：');
      for (const role of data.roles) lines.push(`${role.name}  ${role.configured_model || '未固定'} / ${role.configured_effort || '未固定'}`);
      lines.push(...data.rules.summary.map(rule => `- ${rule}`), '', '相关配置与检查范围：', ...JSON.stringify({ related_config: data.related_config, inspection: data.inspection }, null, 2).split('\n'));
    }
    lines.push(...data.warnings);
  } else if (data.result) {
    lines.push(`操作：${data.action} · ${data.result} · ${data.configuration_status}`, `Codex home：${data.home}`, `档位：${data.mode?.name || '无'} · 变化文件：${data.changed_files?.length || 0}`);
    if (data.created_mode) lines.push(`已创建：${data.created_mode.name} (${data.created_mode.id})，尚未设为当前档位。`);
    if (data.result === 'preview') lines.push(...(data.changes || []).map(change => `${change.action}  ${change.path}`));
    if (data.custom_modes_removed?.length) lines.push(`清理自定义档位：${data.custom_modes_removed.join('、')}`);
    if (data.restart?.message) lines.push(data.restart.message);
    if (data.post_check?.status !== 'not_requested') lines.push(`账号目录后检查：${data.post_check?.status}；目录不证明实际调用权限。`);
    lines.push(...(data.warnings || []));
  } else if (data.modes) {
    lines.push(...data.modes.map(mode => `${mode.active ? '*' : ' '} ${mode.command ?? mode.id}  ${mode.name}  ${mode.kind}`));
  } else if (data.definition) {
    lines.push(`${data.definition.name} (${modeId(data.definition)}) · ${data.active ? '当前已配置' : '定义预览'}`, `来源：${data.source} · 定义版本：${data.definition_version || VERSION}`); levels(data.definition);
  } else if (data.dispatch_role) {
    lines.push(`${data.mode_name} · ${data.level}`, `主组合：${pair(data.primary)} · 备用：${pair(data.fallback)}`, `职责：${data.requested_role} → 委派角色：${data.dispatch_role}`, `权限契约：${data.permission_contract}`, `原因：${data.reason_codes.join('、')}`);
  } else if (data.catalog) {
    lines.push(`账号状态：${data.account.status} · 目录：${data.catalog.status} (${data.catalog.models.length} 个模型)`);
    for (const value of data.checked_pairs) lines.push(`${pair(value)} · 参数：${value.parameter_support} · 调用权限：${value.access} · ${value.reason_code}`);
  } else lines.push(JSON.stringify(data, null, 2));
  for (const item of data.diagnostics || []) lines.push(`${item.code} [${item.status}] ${item.message}`);
  if (data.runtime_verification) lines.push(`运行生效：${data.runtime_verification}`);
  return lines.map(terminalText).join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  try {
    if (Number(process.versions.node.split('.')[0]) < 22) throw argumentError('需要 Node.js 22 或更新版本。', 'NODE_UNSUPPORTED');
    const { action, options } = parseCommand(argv);
    if (action === 'help' || action === 'version') { emit(action === 'help' ? { help: HELP } : { cli_version: VERSION }, [], json); return; }
    if (action === 'configure' && options.definitionStdin) options.definition = await readDefinition();
    const installer = await import('../lib/install.mjs');
    const home = installer.resolveHome(options.codexHome);
    if (action === 'serve') {
      const { serveLocal } = await import('../lib/server.mjs');
      const service = await serveLocal({ home, project: process.cwd(), port: Number(options.port || 0), open: Boolean(options.open) });
      process.stdout.write(`本地配置页面：${service.url}\n目标 Codex home：${terminalText(home)}\n按 Ctrl+C 停止。\n`);
      const stop = async () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); await service.close(); };
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
      return;
    }
    let data; let code = 0;
    if (action === 'status') {
      for (let attempt = 0; attempt < 2; attempt++) {
        data = await installer.statusReport(home, options);
        const related = await inspectProject(options.project || process.cwd());
        if ((await installer.readSnapshot(home)).configuration_revision !== data.configuration_revision) {
          if (!attempt) continue;
          throw Object.assign(new Error('配置读取期间变化；请刷新。'), { code: 'BUSY', exitCode: 1 });
        }
        data.related_config.project_candidates = related.candidates;
        data.inspection.checked_paths.push(...related.checked);
        data.inspection.skipped_paths.push(...related.skipped);
        data.diagnostics.push(...related.diagnostics);
        break;
      }
    }
    else if (action === 'list') data = await installer.listReport(home, options);
    else if (action === 'show') data = await installer.showReport(home, options.mode, options);
    else if (action === 'explain') {
      let snapshot, shown;
      for (let attempt = 0; attempt < 2; attempt++) {
        snapshot = await installer.readSnapshot(home);
        if (!options.mode && !snapshot.mode) throw Object.assign(new Error('尚无有效当前档位；先 setup，或用 --mode 明确预览内置档位。'), { code: 'NOT_INSTALLED', exitCode: 1 });
        shown = await installer.showReport(home, options.mode);
        if (snapshot.configuration_revision === shown.configuration_revision) break;
        if (attempt) throw Object.assign(new Error('配置读取期间变化；请刷新。'), { code: 'BUSY', exitCode: 1 });
      }
      data = { configuration_revision: shown.configuration_revision, diagnostics: shown.diagnostics, source: shown.source, definition_version: shown.definition_version, ...explainSelection({ definition: shown.definition, level: options.level, role: options.role || 'task_delegate' }) };
    } else if (action === 'models') {
      const { checkAccountModels } = await import('../lib/models.mjs');
      data = await checkAccountModels({ home, verify: Boolean(options.verify), target: options.model ? { model: options.model, effort: options.effort } : undefined });
      code = data.exit_code || 0; delete data.exit_code;
    } else {
      data = await installer.mutate(home, action, options);
      const target = data.post_check_target; delete data.post_check_target;
      if (target && data.result === 'applied') {
        try {
          const { checkAccountModels } = await import('../lib/models.mjs');
          const checked = await checkAccountModels({ home, selection: target });
          data.post_check = { ...checked, status: checked.exit_code === 3 ? 'failed' : checked.exit_code ? 'incomplete' : 'passed' };
          delete data.post_check.exit_code;
        } catch { data.post_check = { status: 'failed', source_revision: data.revision_after, diagnostics: [{ code: 'MODEL_CHECK_FAILED', status: 'unknown', message: '配置已写入，账号目录检查未完成。' }] }; }
      }
    }
    const errors = ['status', 'list', 'show', 'explain'].includes(action) ? (data.diagnostics || []).filter(item => item.status === 'fail').map(item => ({ code: item.code, message: item.message })) : [];
    if (errors.length) code = 1;
    emit(data, errors, json); process.exitCode = code;
  } catch (error) {
    const known = typeof error.code === 'string' && (error.exitCode === 1 || error.exitCode === 2 || error.exitCode === 3);
    emit(error.details?.report || null, [{ code: known ? error.code : 'IO_ERROR', message: known ? error.message : '操作未完成；请检查路径、权限与配置格式。' }], json);
    process.exitCode = known ? error.exitCode : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) await main();
