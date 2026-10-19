#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { VERSION, LEVELS, TASKS, ROLES, argumentError, validateDefinition, validatePair, explainSelection, inspectProject } from '../lib/codex.mjs';

const HELP = `agent-fit ${VERSION} — Codex 子代理委派配置
需要 Node.js 22+。npm 安装仅安装命令；setup 显式配置 Codex。
用法：agent-fit <命令> [选项]。

setup [--mode MODE] [--dry-run]
mode set MODE [--dry-run]
mode clear [--dry-run]
mode delete MODE [--dry-run]
mode list | mode show [MODE]
mode create NAME [--from MODE] [--dry-run]
mode configure MODE --level L1|L2|L3|L4 --model MODEL --effort EFFORT
  [--fallback-model MODEL --fallback-effort EFFORT | --clear-fallback]
mode configure MODE --definition-stdin [--dry-run]
status [--details] [--project PATH]
explain --level L1|L2|L3|L4 [--task mechanical|bounded|scan|deep|complex|uncertain|reasoning|latency] [--mode MODE] [--role ROLE]
models check [--verify] [--discover] [--expect-catalog HASH] [--model MODEL --effort EFFORT]
restore [--dry-run]
serve [--port PORT] [--open]

路由命令支持 --scope global|project|session、--project PATH、--thread ID。
CLI 默认 global；聊天 Skill 切换默认 session。项目和会话选择可用 mode clear 恢复继承。
会话 > 项目 > 全局；查询显示有效档位及来源。局部选择只影响后续新任务。

内置档位：cut（经济）、official（官方，首次配置默认）、high（高级）、fire（全开）。
cut/official 支持同级任务候选；明确选择 high/fire 即授权所示最高强度，包括 Astra/ultra，预算与 fire 验证仍适用。
省略 --agent 时默认使用 codex；也可显式指定 --agent codex。
目标目录支持 --codex-home PATH；默认 CODEX_HOME 或 ~/.codex。
查询及写命令支持 --json；写命令支持 --expect-revision REV。
--help [--json] | --version [--json]
安装与档位设置只修改本地配置，不自动检查账号、模型目录或发送验证请求。
需要时显式运行 models check；--verify 会实际调用模型，可能产生费用。
首次安装、更新基础规则或恢复后请重启 Codex；日常切档无需重启，后续新任务读取新配置。
完整说明：https://github.com/fanglinwei/agent-fit/blob/main/docs/usage.md`;

const strings = ['agent', 'codex-home', 'mode', 'from', 'level', 'task', 'model', 'effort', 'fallback-model', 'fallback-effort', 'expect-revision', 'role', 'project', 'scope', 'thread', 'port', 'expect-catalog'];
const booleans = ['dry-run', 'json', 'details', 'clear-fallback', 'definition-stdin', 'verify', 'discover', 'open', 'help', 'version'];
const optionTypes = Object.fromEntries([...strings.map(k => [k, { type: 'string' }]), ...booleans.map(k => [k, { type: 'boolean' }])]);
const common = ['agent', 'codex-home', 'json'];
const write = [...common, 'dry-run', 'expect-revision'];
const scoped = ['scope', 'project', 'thread'];
const commands = {
  setup: [...write, 'mode'], set: [...write, ...scoped], clear: [...write, ...scoped], delete: [...write, ...scoped], list: [...common, ...scoped], show: [...common, ...scoped],
  create: [...write, ...scoped, 'from'], configure: [...write, ...scoped, 'level', 'model', 'effort', 'fallback-model', 'fallback-effort', 'clear-fallback', 'definition-stdin'],
  status: [...common, ...scoped, 'details'], explain: [...common, ...scoped, 'level', 'task', 'mode', 'role'],
  models: [...common, ...scoped, 'discover', 'expect-catalog', 'verify', 'model', 'effort', 'expect-revision'], restore: write,
  serve: ['agent', 'codex-home', 'project', 'thread', 'port', 'open'],
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
    if (!['set', 'clear', 'delete', 'list', 'show', 'create', 'configure'].includes(action)) throw argumentError('未知 mode 子命令。');
    if (!['list', 'clear'].includes(action) && (action !== 'show' || positionals[2] !== undefined)) { selector = positionals[2]; count = 3; }
  } else if (action === 'models') {
    if (positionals[1] !== 'check') throw argumentError('models 仅支持 check。');
    count = 2;
  }
  if (!commands[action] || positionals.length !== count || ((count === 3) && !selector)) throw argumentError('命令或位置参数无效；使用 --help。');
  if (Object.keys(values).some(k => !commands[action].includes(k))) throw argumentError('该命令不支持给定参数。');
  if (values.agent !== undefined && values.agent !== 'codex') throw argumentError('首版仅支持 --agent codex。', 'AGENT_UNSUPPORTED');
  if (values.scope !== undefined && !['global', 'project', 'session'].includes(values.scope)) throw argumentError('作用域必须是 global、project 或 session。');
  if (values.level !== undefined && !LEVELS.includes(values.level)) throw argumentError('任务等级必须是 L1–L4。');
  if (values.role !== undefined && !Object.hasOwn(ROLES, values.role)) throw argumentError('委派角色无效。');
  if (action === 'explain' && !values.level) throw argumentError('explain 需要 --level。');
  if (values.task !== undefined && (!Object.hasOwn(TASKS, values.task) || !TASKS[values.task].includes(values.level))) throw argumentError('任务类型与复杂度等级不匹配。');
  if (action === 'models' && Boolean(values.model) !== Boolean(values.effort)) throw argumentError('--model 与 --effort 必须成对。');
  if (action === 'models' && (values.discover && (!values.verify || values.model) || values['expect-catalog'] && (!values.discover || !/^[a-f0-9]{64}$/.test(values['expect-catalog'])))) throw argumentError('--discover 需要 --verify，且不能同时指定模型；目录版本须为 SHA-256。');
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
  const pair = value => value ? `${value.model} / ${value.effort ?? '供应商默认参数'}` : '无';
  const levels = definition => {
    for (const [level, value] of Object.entries(definition.levels || {})) {
      lines.push(`${level}  ${pair(value)}  备用：${definition.kind === 'builtin' && definition.id === 'fire' ? '用户指定，否则继承父代理' : pair(value.fallback)}`);
      for (const [task, candidate] of Object.entries(value.tasks ?? {})) lines.push(`  ${task}  ${pair(candidate)}  备用：${pair(candidate.fallback)}`);
    }
  };
  if (data.installation) {
    lines.push(`Codex home：${data.home}`, `工具 ${data.cli_version} · 配置 ${data.configuration_version || '未安装'}`, `状态：${data.installation} · 完整性：${data.integrity}`, `已配置档位：${data.mode?.name || '无'}${data.mode ? ` (${data.mode.id})` : ''}`, `恢复基线：${data.restoration.status}`);
    if (data.mode) levels(data.mode);
    if (data.rules.summary.length) {
      lines.push('', '职责与规则：');
      for (const role of data.roles) lines.push(`${role.name}  ${role.configured_model || '未固定'} / ${role.configured_effort || '未固定'}`);
      lines.push(...data.rules.summary.map(rule => `- ${rule}`), '', '相关配置与检查范围：', ...JSON.stringify({ related_config: data.related_config, inspection: data.inspection }, null, 2).split('\n'));
    }
    if (data.verification?.required) lines.push('fire：每个会话首次委派前须实际验证；失败时使用用户指定组合，否则继承父代理模型与推理强度。');
    lines.push(...data.warnings);
  } else if (data.result) {
    lines.push(`操作：${data.action} · ${data.result} · ${data.configuration_status}`, `Codex home：${data.home}`, `档位：${data.mode?.name || '无'} · 变化文件：${data.changed_files?.length || 0}`);
    if (data.created_mode) lines.push(`已创建：${data.created_mode.name} (${data.created_mode.id})，${data.mode?.id === data.created_mode.id ? '已在当前作用域选择。' : '尚未设为当前档位。'}`);
    if (data.result === 'preview') lines.push(...(data.changes || []).map(change => `${change.action}  ${change.path}`));
    if (data.custom_modes_removed?.length) lines.push(`清理自定义档位：${data.custom_modes_removed.join('、')}`);
    if (data.restart?.message) lines.push(data.restart.message);
    lines.push(...(data.warnings || []));
  } else if (data.modes) {
    lines.push(...data.modes.map(mode => `${mode.active ? '*' : ' '} ${mode.id}  ${mode.name}  ${mode.kind}`));
  } else if (data.definition) {
    lines.push(`${data.definition.name} (${data.definition.id}) · ${data.active ? '当前已配置' : '定义预览'}`, `来源：${data.source} · 定义版本：${data.definition_version || VERSION}`); levels(data.definition);
  } else if (data.dispatch_role) {
    lines.push(`${data.mode_name} · ${data.level}${data.task ? ` · ${data.task}` : ''}`, `主组合：${pair(data.primary)} · 备用：${pair(data.fallback)}`, `职责：${data.requested_role} → 委派角色：${data.dispatch_role}`, `权限契约：${data.permission_contract}`, `原因：${data.reason_codes.join('、')}`);
    if (data.verification?.required) lines.push('先完成本会话实际验证；失败时使用 task_delegate，采用用户指定组合，否则继承父代理模型与推理强度。');
  } else if (data.catalog) {
    lines.push(`账号状态：${data.account.status} · 目录：${data.catalog.status} (${data.catalog.models.length} 个模型)`);
    if (data.catalog.source) lines.push(`目录来源：${data.catalog.source}`);
    if (data.availability) lines.push(`可调用：${data.availability.available} · 不可用：${data.availability.unavailable} · 未确认：${data.availability.unconfirmed}`);
    for (const value of data.checked_pairs) lines.push(`${pair(value)} · 参数：${value.parameter_support} · 调用权限：${value.access} · ${value.reason_code}`);
    if (data.history) lines.push(data.history.status === 'saved' ? `检查记录已保存：${data.history.id}` : '检查结果未保存：MODEL_HISTORY_UNAVAILABLE；请核对记录目录权限。');
  } else lines.push(JSON.stringify(data, null, 2));
  for (const item of data.diagnostics || []) lines.push(`${item.code} [${item.status}] ${item.message}`);
  if (data.runtime_verification) lines.push(`运行生效：${data.runtime_verification}`);
  if (data.scope) lines.push(`查询/修改作用域：${data.scope}${data.effective_scope ? ` · 有效来源：${data.effective_scope}${data.inherited ? '（继承）' : ''}` : ''}`);
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
      const service = await serveLocal({ home, project: options.project ?? process.cwd(), thread: options.thread ?? process.env.CODEX_THREAD_ID ?? null, port: Number(options.port || 0), open: Boolean(options.open) });
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
        shown = await installer.showReport(home, options.mode, options);
        if (snapshot.configuration_revision === shown.configuration_revision) break;
        if (attempt) throw Object.assign(new Error('配置读取期间变化；请刷新。'), { code: 'BUSY', exitCode: 1 });
      }
      data = { configuration_revision: shown.configuration_revision, diagnostics: shown.diagnostics, source: shown.source, definition_version: shown.definition_version, scope: shown.scope, effective_scope: shown.effective_scope, context: shown.context, inherited: shown.inherited, task_profile: shown.definition, ...explainSelection({ definition: shown.definition, level: options.level, task: options.task, role: options.role || 'task_delegate', selected: shown.active, active: options.scope === undefined && shown.active && shown.effective_scope === 'global' }) };
    } else if (action === 'models') {
      const { recordedModelCheck } = await import('../lib/model-history.mjs');
      data = await recordedModelCheck({ home, scope: options.scope, project: options.project, thread: options.thread, verify: Boolean(options.verify), discover: Boolean(options.discover), expectCatalog: options.expectCatalog, target: options.model ? { model: options.model, effort: options.effort } : undefined, expectRevision: options.expectRevision });
      code = data.exit_code || 0; delete data.exit_code;
    } else {
      data = await installer.mutate(home, action, options);
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
