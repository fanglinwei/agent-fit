import { spawn } from 'node:child_process';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readSnapshot } from './install.mjs';
import { VERSION, LEVELS, validatePair, argumentError } from './codex.mjs';

const FRAME_BYTES = 1024 * 1024;
const TOTAL_BYTES = 8 * FRAME_BYTES;
const MESSAGES = {
  HOME_NOT_FOUND: '所选 Codex home 不存在；未启动检查进程。',
  INVALID_HOME: '所选 Codex home 不是可检查的普通目录。',
  CONFIG_SNAPSHOT_UNAVAILABLE: '无法稳定读取配置版本；检查结果不能证明当前配置。',
  CODEX_NOT_FOUND: '未找到 Codex CLI；请安装受支持的客户端后重试。',
  RPC_FAILED: 'Codex 协议请求失败；未输出原始响应或错误内容。',
  RPC_UNSUPPORTED: '客户端不支持所需的账号或模型目录接口。',
  RPC_INVALID: '客户端响应格式无效；未输出原始响应。',
  RPC_HOME_MISMATCH: '客户端报告的 Codex home 与所选 home 不一致。',
  RPC_EXITED: '检查进程在目录读取完成前退出。',
  RPC_TIMEOUT: '账号和模型目录检查超过共享期限。',
  RPC_FRAME_LIMIT: '客户端响应超过单帧 1MiB 限制。',
  RPC_TOTAL_LIMIT: '客户端响应超过整轮 8MiB 限制。',
  RPC_CURSOR_LOOP: '目录分页 cursor 重复；目录未完整读取。',
  RPC_PAGE_LIMIT: '目录超过 100 页限制；目录未完整读取。',
  CONTEXT_UNVERIFIED: '本次仅检查所选 home 的 CLI 上下文；桌面会话、启动参数和 profile 未验证。',
  MODEL_ACCESS_UNKNOWN: '模型目录和参数支持不证明账号实际调用权限。',
  MODEL_NOT_LISTED: '目录未列出目标模型；调用权限仍未知。',
  MODEL_EFFORT_UNSUPPORTED: '目录明确未包含目标推理强度；请修改该模型组合。',
  ACCOUNT_AUTHENTICATION_REQUIRED: '所检查 CLI 的 OpenAI 上下文需要登录；请完成登录后重新检查。',
  PROBE_TARGET_REQUIRED: '推理验证需要有效当前档位，或显式提供 model 和 effort。',
  PROBE_ISOLATION_UNSUPPORTED: '已核验的 Codex CLI 接口不能证明禁用全部工具和限制读取范围；未创建线程或发送推理请求。',
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, maximum) => typeof value === 'string' && value.length > 0 && [...value].length <= maximum && value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value);
const failure = code => Object.assign(new Error(MESSAGES[code]), { code });
const diagnostic = (code, status = 'unknown') => ({ code, status, source: 'codex_app_server', message: MESSAGES[code] });

async function withinDeadline(promise, deadline) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(failure('RPC_TIMEOUT')), Math.max(0, deadline - Date.now())); })]);
  } finally { clearTimeout(timer); }
}

function rpcClient(child, deadline) {
  let buffer = Buffer.alloc(0), received = 0, nextId = 0, stopped = false, fatal = null;
  const pending = new Map();
  const exited = new Promise(resolve => child.once('close', resolve));
  function fail(code) {
    if (fatal || stopped) return;
    fatal = failure(code);
    for (const { reject } of pending.values()) reject(fatal);
    pending.clear();
  }
  const timer = setTimeout(() => fail('RPC_TIMEOUT'), Math.max(0, deadline - Date.now()));
  child.on('error', error => fail(error.code === 'ENOENT' ? 'CODEX_NOT_FOUND' : 'RPC_FAILED'));
  child.stdin.on('error', () => fail('RPC_EXITED'));
  child.once('close', () => fail('RPC_EXITED'));
  function count(bytes) {
    received += bytes;
    if (received > TOTAL_BYTES) fail('RPC_TOTAL_LIMIT');
  }
  child.stderr.on('data', bytes => count(bytes.length));
  child.stdout.on('data', chunk => {
    count(chunk.length);
    if (fatal || stopped) return;
    buffer = Buffer.concat([buffer, chunk]);
    let newline;
    while ((newline = buffer.indexOf(10)) !== -1) {
      if (newline > FRAME_BYTES) { fail('RPC_FRAME_LIMIT'); return; }
      const frame = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      let message;
      try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame)); }
      catch { fail('RPC_INVALID'); return; }
      if (!object(message) || message.jsonrpc !== undefined && message.jsonrpc !== '2.0') { fail('RPC_INVALID'); return; }
      if (typeof message.method === 'string' && !Object.hasOwn(message, 'id')) continue;
      const request = pending.get(message.id);
      if (!request || Object.hasOwn(message, 'method') || Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')) { fail('RPC_INVALID'); return; }
      pending.delete(message.id);
      if (Object.hasOwn(message, 'error')) {
        if (!object(message.error) || !Number.isInteger(message.error.code) || typeof message.error.message !== 'string') { fail('RPC_INVALID'); request.reject(failure('RPC_INVALID')); return; }
        request.reject(failure(message.error.code === -32601 ? 'RPC_UNSUPPORTED' : 'RPC_FAILED'));
      } else request.resolve(message.result);
    }
    if (buffer.length > FRAME_BYTES) fail('RPC_FRAME_LIMIT');
  });
  function send(value) {
    if (fatal) throw fatal;
    if (stopped || child.exitCode !== null || Date.now() >= deadline) throw failure(Date.now() >= deadline ? 'RPC_TIMEOUT' : 'RPC_EXITED');
    child.stdin.write(`${JSON.stringify(value)}\n`);
  }
  return {
    request(method, params) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        try { send({ id, method, params }); }
        catch (error) { pending.delete(id); reject(error); }
      });
    },
    notify(method) { send({ method }); },
    async close() {
      stopped = true;
      clearTimeout(timer);
      child.stdin.end();
      for (const { reject } of pending.values()) reject(failure('RPC_EXITED'));
      pending.clear();
      const wait = async () => {
        let timeout;
        const done = await Promise.race([exited.then(() => true), new Promise(resolve => { timeout = setTimeout(() => resolve(false), 250); })]);
        clearTimeout(timeout);
        return done;
      };
      if (!await wait()) {
        child.kill('SIGTERM');
        if (!await wait()) { child.kill('SIGKILL'); await wait(); }
      }
    },
  };
}

function safeAccount(value, provider) {
  if (!object(value) || typeof value.requiresOpenaiAuth !== 'boolean') throw failure('RPC_INVALID');
  const account = value.account ?? null;
  if (account !== null && (!object(account) || !['apiKey', 'chatgpt', 'amazonBedrock'].includes(account.type))) throw failure('RPC_INVALID');
  return {
    status: account ? 'authenticated' : provider === 'openai' && value.requiresOpenaiAuth ? 'authentication_required' : 'unknown',
    type: account?.type ?? null, requires_openai_auth: value.requiresOpenaiAuth,
  };
}

function safeModel(value) {
  if (!object(value) || !text(value.id, 200) || !text(value.model, 200) || !text(value.displayName, 200) || typeof value.hidden !== 'boolean' || !text(value.defaultReasoningEffort, 40) || !Array.isArray(value.supportedReasoningEfforts) || value.supportedReasoningEfforts.length > 100 || value.supportedReasoningEfforts.some(option => !object(option) || !text(option.reasoningEffort, 40))) throw failure('RPC_INVALID');
  const modalities = Object.hasOwn(value, 'inputModalities') ? value.inputModalities : null;
  if (Object.hasOwn(value, 'inputModalities') && modalities === null) throw failure('RPC_INVALID');
  if (modalities !== null && (!Array.isArray(modalities) || modalities.length > 100 || modalities.some(modality => !text(modality, 40)))) throw failure('RPC_INVALID');
  return {
    id: value.id, model: value.model, display_name: value.displayName, hidden: value.hidden,
    default_reasoning_effort: value.defaultReasoningEffort,
    supported_reasoning_efforts: [...new Set(value.supportedReasoningEfforts.map(option => option.reasoningEffort))],
    input_modalities: modalities === null ? null : [...new Set(modalities)],
  };
}

function selectedMode(mode) {
  return object(mode) ? { id: mode.id, name: mode.name, kind: mode.kind } : mode ?? null;
}

// The second argument only injects a child/snapshots/deadline in isolated tests; no CLI exposes it.
export async function checkAccountModels({ home, verify = false, target, selection } = {}, internal = {}) {
  if (typeof home !== 'string' || !home || home.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(home) || !path.isAbsolute(home)) throw argumentError('必须提供绝对路径 Codex home。', 'INVALID_HOME');
  if (typeof verify !== 'boolean' || target && selection) throw argumentError('模型检查参数无效。');
  const explicit = target === undefined ? null : validatePair(target);
  const snapshotReader = internal.readSnapshot ?? readSnapshot;
  const deadline = Date.now() + (internal.deadlineMs ?? 30_000);
  const result = {
    agent: 'codex', home, cli_version: VERSION, configuration_revision: null, source_revision: null,
    mode: null, checked_pairs: [], account: { status: 'unknown', type: null, requires_openai_auth: null },
    catalog: { status: 'not_checked', includes_hidden: true, pages: 0, models: [] },
    context: { scope: 'selected_cli_home', provider: null, profile: null, context_match: 'unverified' },
    configuration_changed: null, status: 'incomplete', diagnostics: [], exit_code: 0,
  };
  let snapshot, unsafeHome = false;
  try { snapshot = await withinDeadline(snapshotReader(home), deadline); result.configuration_revision = snapshot.configuration_revision; }
  catch (error) {
    unsafeHome = ['UNSAFE_PATH', 'UNSAFE_PERMISSIONS', 'INVALID_HOME'].includes(error.code);
    result.diagnostics.push(diagnostic('CONFIG_SNAPSHOT_UNAVAILABLE'));
    result.exit_code = 1;
  }
  result.source_revision = selection?.configurationRevision ?? result.configuration_revision;
  let pairs;
  if (explicit) pairs = [explicit];
  else if (selection) {
    if (!Array.isArray(selection.pairs) || selection.pairs.length > 8 || !text(selection.configurationRevision, 200)) throw argumentError('配置后检查必须绑定完整组合和配置版本。');
    result.mode = selectedMode(selection.mode);
    pairs = selection.pairs.map(validatePair);
  } else if (snapshot?.mode) {
    result.mode = selectedMode(snapshot.mode);
    pairs = LEVELS.flatMap(level => [snapshot.mode.levels[level], ...(verify ? [] : [snapshot.mode.levels[level].fallback])].filter(Boolean).map(pair => validatePair({ model: pair.model, effort: pair.effort })));
  } else pairs = [];
  pairs = [...new Map(pairs.map(pair => [JSON.stringify(pair), pair])).values()];
  result.checked_pairs = pairs.map(pair => ({ ...pair, access: 'unknown', parameter_support: 'unknown', request_status: verify ? 'not_checked' : 'not_requested', actual_model: null, actual_effort: null, reason_code: 'MODEL_ACCESS_UNKNOWN' }));
  if (verify && !pairs.length) {
    result.exit_code = 1;
    result.diagnostics.push(diagnostic('PROBE_TARGET_REQUIRED'));
    return result;
  }
  let rpc, directory;
  try {
    if (unsafeHome) throw failure('INVALID_HOME');
    const metadata = await lstat(home).catch(error => { if (error.code === 'ENOENT') throw failure('HOME_NOT_FOUND'); throw error; });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw failure('INVALID_HOME');
    if (Date.now() >= deadline) throw failure('RPC_TIMEOUT');
    directory = await mkdtemp(path.join(os.tmpdir(), 'subagent-delegation-models-'));
    const child = (internal.spawn ?? spawn)('codex', ['app-server'], { shell: false, cwd: directory, env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
    rpc = rpcClient(child, deadline);
    const initialized = await rpc.request('initialize', { clientInfo: { name: 'subagent_delegation', version: VERSION }, capabilities: { experimentalApi: true } });
    if (!object(initialized) || !text(initialized.userAgent, 1000) || !text(initialized.platformFamily, 200) || !text(initialized.platformOs, 200) || typeof initialized.codexHome !== 'string' || !path.isAbsolute(initialized.codexHome)) throw failure('RPC_INVALID');
    if (path.resolve(initialized.codexHome) !== path.resolve(home)) throw failure('RPC_HOME_MISMATCH');
    rpc.notify('initialized');
    const account = await rpc.request('account/read', { refreshToken: false });
    try {
      const config = await rpc.request('config/read', { includeLayers: false, cwd: null });
      if (!object(config) || !object(config.config) || config.config.model_provider != null && !text(config.config.model_provider, 200)) throw failure('RPC_INVALID');
      result.context.provider = config.config.model_provider ?? null;
    } catch (error) { if (error.code !== 'RPC_UNSUPPORTED') throw error; }
    result.account = safeAccount(account, result.context.provider);
    if (result.account.status === 'authentication_required') {
      result.exit_code = 1;
      result.diagnostics.push(diagnostic('ACCOUNT_AUTHENTICATION_REQUIRED'));
    }
    let cursor = null;
    const cursors = new Set();
    result.catalog.status = 'incomplete';
    for (let page = 0; page < 100; page++) {
      const value = await rpc.request('model/list', { cursor, limit: 100, includeHidden: true });
      if (!object(value) || !Array.isArray(value.data) || value.nextCursor != null && !text(value.nextCursor, 4096)) throw failure('RPC_INVALID');
      const models = value.data.map(safeModel);
      result.catalog.models.push(...models);
      result.catalog.pages++;
      cursor = value.nextCursor ?? null;
      if (cursor === null) { result.catalog.status = 'complete'; break; }
      if (cursors.has(cursor)) throw failure('RPC_CURSOR_LOOP');
      cursors.add(cursor);
      if (page === 99) throw failure('RPC_PAGE_LIMIT');
    }
    result.diagnostics.push(diagnostic('CONTEXT_UNVERIFIED'), diagnostic('MODEL_ACCESS_UNKNOWN'));
    for (const pair of result.checked_pairs) {
      const models = result.catalog.models.filter(model => model.model === pair.model || model.id === pair.model);
      if (models.length === 0) { pair.reason_code = 'MODEL_NOT_LISTED'; continue; }
      pair.parameter_support = models.some(model => model.supported_reasoning_efforts.includes(pair.effort)) ? 'supported' : 'incompatible';
      if (pair.parameter_support === 'incompatible') {
        pair.reason_code = 'MODEL_EFFORT_UNSUPPORTED';
        if (!result.exit_code) result.exit_code = 3;
        result.diagnostics.push({ ...diagnostic(pair.reason_code, 'incompatible'), model: pair.model, effort: pair.effort });
      }
    }
  } catch (error) {
    result.exit_code = 1;
    result.diagnostics.push(diagnostic(Object.hasOwn(MESSAGES, error.code) ? error.code : 'RPC_FAILED'));
  } finally {
    if (rpc) await rpc.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
  if (verify) {
    // codex-cli 0.156.1 ThreadStart.dynamicTools adds tools; TurnStart has no complete tool allowlist.
    // readOnly permits reads and does not deny MCP/network/agents. Keep the G3 gate closed before any thread/turn.
    result.exit_code = 1;
    result.diagnostics.push({ ...diagnostic('PROBE_ISOLATION_UNSUPPORTED', 'unsupported'), source: 'codex_cli_schema', evidence: { tested_cli_version: '0.156.1', schema_fields: ['ThreadStartParams.dynamicTools', 'TurnStartParams.sandboxPolicy', 'ToolsToml'], source: 'https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/core/config.schema.json' } });
  }
  if (Date.now() < deadline) {
    try {
      const end = await withinDeadline(snapshotReader(home), deadline);
      result.configuration_changed = result.source_revision === null ? null : end.configuration_revision !== result.source_revision;
    } catch { result.configuration_changed = null; }
  }
  result.status = result.exit_code === 1 ? 'incomplete' : result.exit_code === 3 ? 'failed' : 'passed';
  return result;
}
