import { spawn } from 'node:child_process';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readSnapshot } from './install.mjs';
import { VERSION, LEVELS, validatePair, argumentError, verificationRequirement } from './codex.mjs';
import { probeResponses, providerModels, usesProviderCatalog } from './probe.mjs';

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
  CONFIG_CHANGED: '配置在确认后发生变化；本次未发起验证，请刷新状态后重新确认组合。',
  PROVIDER_CATALOG_FAILED: '无法读取当前供应商的 /models 候选目录；未使用 Codex 目录代替。可手动填写模型和强度进行 Responses 验证。',
  PROVIDER_CATALOG_INVALID: '供应商模型目录格式无效或超过 1000 个候选；未开始批量调用。',
  PROVIDER_CATALOG_PARTIAL: '供应商目录仍有后续分页，本次未完整枚举；请手动选择模型验证。',
  PROVIDER_CATALOG_CHANGED: '供应商候选目录在确认后发生变化；未发起批量调用，请重新检查并确认。',
  PROBE_AVAILABLE: '供应商 Responses 请求已完成，本次可调用；使用供应商默认参数，未验证指定推理强度及严格模型身份。',
  PROBE_VERIFIED: '实际请求完成，响应中的模型与推理强度均匹配。',
  PROBE_AUTH_UNAVAILABLE: '无法读取此配置对应的授权；请检查凭据存储、供应商环境变量，或重新登录。系统凭据库中的授权尚不支持独立请求。',
  PROBE_PROVIDER_UNSUPPORTED: '当前供应商的地址、协议或特殊授权不支持独立 Responses 验证；未发送请求。',
  PROBE_AUTH_FAILED: '供应商拒绝授权（401），请检查当前配置目录的登录及凭据。',
  PROBE_ACCESS_DENIED: '供应商拒绝访问（403），请检查模型与账号权限。',
  PROBE_RATE_LIMITED: '供应商返回额度或频率限制（429），请检查额度后再试。',
  PROBE_HTTP_FAILED: '供应商返回请求错误；请核对模型、推理强度及服务状态。',
  PROBE_MODEL_NOT_FOUND: '当前供应商返回 model_not_found：未提供所选模型或未向此账号开放。Codex 目录记录不代表该供应商支持此模型，请核对供应商的模型标识。',
  PROBE_PARAMETER_REJECTED: '当前供应商拒绝验证参数；请核对其 Responses 协议及推理强度支持。',
  PROBE_NETWORK_FAILED: '验证连接或响应格式异常，请检查当前供应商网络后重试。',
  PROBE_RESPONSE_FAILED: '供应商未返回完整成功结果；实际调用未确认。',
  PROBE_RESPONSE_LIMIT: '验证响应超过 2 MiB，读取已停止。',
  PROBE_STREAM_INCOMPLETE: '响应流提前结束，未取得完整完成事件。',
  PROBE_UNEXPECTED_OUTPUT: '验证返回了非预期输出；不会执行其中的任何工具调用。',
  PROBE_TIMEOUT: '实际调用验证超时；请求已停止，未自动重试。',
  PROBE_IDENTITY_UNVERIFIED: '实际请求成功，但响应没有同时提供模型与推理强度，严格身份验证未完成。',
  PROBE_IDENTITY_MISMATCH: '实际请求成功，但响应报告的模型或推理强度与所选组合不同。',
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

export function rpcClient(child, deadline, { onNotification = () => {}, onFailure = () => {}, requestTimeoutMs = null } = {}) {
  let buffer = Buffer.alloc(0), received = 0, nextId = 0, stopped = false, fatal = null;
  const pending = new Map();
  const exited = new Promise(resolve => child.once('close', resolve));
  function fail(code) {
    if (fatal || stopped) return;
    fatal = failure(code);
    for (const { reject } of pending.values()) reject(fatal);
    pending.clear();
    onFailure(fatal);
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
      if (typeof message.method === 'string' && !Object.hasOwn(message, 'id')) { onNotification(message); continue; }
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
        const timeout = requestTimeoutMs ? setTimeout(() => fail('RPC_TIMEOUT'), requestTimeoutMs) : null;
        pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
        try { send({ id, method, params }); }
        catch (error) { pending.delete(id); clearTimeout(timeout); reject(error); }
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

export function safeAccount(value, provider) {
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
export async function checkAccountModels({ home, verify = false, discover = false, target, selection, expectRevision, expectCatalog } = {}, internal = {}) {
  if (typeof home !== 'string' || !home || home.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(home) || !path.isAbsolute(home)) throw argumentError('必须提供绝对路径 Codex home。', 'INVALID_HOME');
  if (typeof verify !== 'boolean' || typeof discover !== 'boolean' || target && selection || discover && (!verify || target || selection)) throw argumentError('模型检查参数无效。');
  if (expectRevision !== undefined && !text(expectRevision, 200)) throw argumentError('模型检查配置版本无效。');
  if (expectCatalog !== undefined && (!discover || !/^[a-f0-9]{64}$/.test(expectCatalog))) throw argumentError('供应商目录版本无效。');
  const explicit = target === undefined ? null : validatePair(target);
  const snapshotReader = internal.readSnapshot ?? readSnapshot;
  const deadline = Date.now() + (internal.deadlineMs ?? (verify ? 90_000 : 30_000));
  const result = {
    agent: 'codex', home, cli_version: VERSION, configuration_revision: null, source_revision: null,
    mode: null, checked_pairs: [], account: { status: 'unknown', type: null, requires_openai_auth: null },
    catalog: { status: 'not_checked', includes_hidden: true, pages: 0, models: [] },
    context: { scope: 'selected_cli_home', provider: null, profile: null, context_match: 'unverified' },
    configuration_changed: null, status: 'incomplete', diagnostics: [], exit_code: 0,
  };
  let snapshot, unsafeHome = false, snapshotTimedOut = false;
  try { snapshot = await withinDeadline(snapshotReader(home), deadline); result.configuration_revision = snapshot.configuration_revision; }
  catch (error) {
    snapshotTimedOut = error.code === 'RPC_TIMEOUT';
    unsafeHome = ['UNSAFE_PATH', 'UNSAFE_PERMISSIONS', 'INVALID_HOME'].includes(error.code);
    result.diagnostics.push(diagnostic('CONFIG_SNAPSHOT_UNAVAILABLE'));
    result.exit_code = 1;
  }
  result.source_revision = selection?.configurationRevision ?? result.configuration_revision;
  if (expectRevision !== undefined && expectRevision !== result.configuration_revision) {
    result.source_revision = expectRevision; result.configuration_changed = true; result.exit_code = 1;
    result.diagnostics.push(diagnostic('CONFIG_CHANGED'));
    if (explicit) result.checked_pairs = [{ ...explicit, access: 'unknown', parameter_support: 'unknown', request_status: 'not_checked', actual_model: null, actual_effort: null, reason_code: 'CONFIG_CHANGED' }];
    return result;
  }
  let pairs;
  if (discover) pairs = [];
  else if (explicit) pairs = [explicit];
  else if (selection) {
    if (!Array.isArray(selection.pairs) || selection.pairs.length > 8 || !text(selection.configurationRevision, 200)) throw argumentError('配置后检查必须绑定完整组合和配置版本。');
    result.mode = selectedMode(selection.mode);
    pairs = selection.pairs.map(validatePair);
  } else if (snapshot?.mode) {
    result.mode = selectedMode(snapshot.mode);
    pairs = LEVELS.flatMap(level => [snapshot.mode.levels[level], ...(verify ? [] : [snapshot.mode.levels[level].fallback])].filter(Boolean).map(pair => validatePair({ model: pair.model, effort: pair.effort })));
  } else pairs = [];
  pairs = [...new Map(pairs.map(pair => [JSON.stringify(pair), pair])).values()];
  result.verification = discover ? { required: false, scope: 'model_availability' } : verificationRequirement(selection?.mode ?? snapshot?.mode);
  if (discover) result.check_kind = 'availability';
  result.checked_pairs = pairs.map(pair => ({ ...pair, access: 'unknown', parameter_support: 'unknown', request_status: verify ? 'not_checked' : 'not_requested', actual_model: null, actual_effort: null, reason_code: 'MODEL_ACCESS_UNKNOWN' }));
  if (verify && !discover && !pairs.length) {
    result.exit_code = 1;
    result.diagnostics.push(diagnostic('PROBE_TARGET_REQUIRED'));
    return result;
  }
  let rpc, directory, providerConfig;
  try {
    if (unsafeHome) throw failure('INVALID_HOME');
    const metadata = await lstat(home).catch(error => { if (error.code === 'ENOENT') throw failure('HOME_NOT_FOUND'); throw error; });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw failure('INVALID_HOME');
    if (snapshotTimedOut || Date.now() >= deadline) throw failure('RPC_TIMEOUT');
    directory = await mkdtemp(path.join(os.tmpdir(), 'subagent-delegation-models-'));
    const child = (internal.spawn ?? spawn)('codex', ['app-server'], { shell: false, cwd: directory, env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
    rpc = rpcClient(child, Math.min(deadline, Date.now() + 30_000));
    const initialized = await rpc.request('initialize', { clientInfo: { name: 'subagent_delegation', version: VERSION }, capabilities: { experimentalApi: true } });
    if (!object(initialized) || !text(initialized.userAgent, 1000) || !text(initialized.platformFamily, 200) || !text(initialized.platformOs, 200) || typeof initialized.codexHome !== 'string' || !path.isAbsolute(initialized.codexHome)) throw failure('RPC_INVALID');
    if (path.resolve(initialized.codexHome) !== path.resolve(home)) throw failure('RPC_HOME_MISMATCH');
    result.codex_version = initialized.userAgent.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null;
    rpc.notify('initialized');
    const account = await rpc.request('account/read', { refreshToken: false });
    try {
      const config = await rpc.request('config/read', { includeLayers: false, cwd: null });
      if (!object(config) || !object(config.config) || config.config.model_provider != null && !text(config.config.model_provider, 200)) throw failure('RPC_INVALID');
      result.context.provider = config.config.model_provider ?? null;
      providerConfig = config.config;
    } catch (error) { if (error.code !== 'RPC_UNSUPPORTED') throw error; }
    result.account = safeAccount(account, result.context.provider);
    if (result.account.status === 'authentication_required') {
      result.exit_code = 1;
      result.diagnostics.push(diagnostic('ACCOUNT_AUTHENTICATION_REQUIRED'));
    }
    if (providerConfig && usesProviderCatalog(providerConfig, internal.env ?? process.env)) {
      result.catalog = await providerModels({ home, config: providerConfig, deadline }, internal);
      if (result.catalog.status !== 'complete') {
        result.diagnostics.push({ ...diagnostic(result.catalog.reason_code), source: 'provider_models' });
        if (!verify || discover) result.exit_code = 1;
      }
    } else {
      result.catalog.source = 'codex_app_server';
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
    }
    if (discover) {
      if (result.catalog.source !== 'provider_models' || result.catalog.status !== 'complete') result.exit_code = 1;
      else if (expectCatalog && expectCatalog !== result.catalog.revision) { result.exit_code = 1; result.diagnostics.push(diagnostic('PROVIDER_CATALOG_CHANGED')); }
      else result.checked_pairs = result.catalog.models.map(model => ({ model: model.id, effort: null, access: 'unknown', parameter_support: 'unknown', request_status: 'not_checked', actual_model: null, actual_effort: null, reason_code: 'MODEL_ACCESS_UNKNOWN' }));
    }
    result.diagnostics.push(diagnostic('CONTEXT_UNVERIFIED'), diagnostic('MODEL_ACCESS_UNKNOWN'));
    for (const pair of result.checked_pairs) {
      const models = result.catalog.models.filter(model => model.model === pair.model || model.id === pair.model);
      if (models.length === 0) { pair.reason_code = 'MODEL_NOT_LISTED'; continue; }
      if (result.catalog.source === 'provider_models') continue;
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
    result.probe_transport = 'responses_without_tools';
    if (!providerConfig || !result.source_revision || result.exit_code === 1) result.exit_code = 1;
    else {
      for (const pair of result.checked_pairs) {
        if (pair.parameter_support === 'incompatible') continue;
        if (Date.now() >= deadline) { pair.reason_code = 'PROBE_TIMEOUT'; result.exit_code = 1; continue; }
        const current = await withinDeadline(snapshotReader(home), deadline).catch(() => null);
        if (!current || current.configuration_revision !== result.source_revision) {
          result.exit_code = 1; pair.reason_code = 'CONFIG_CHANGED';
          result.diagnostics.push(diagnostic('CONFIG_CHANGED')); break;
        }
        Object.assign(pair, await probeResponses({ home, config: providerConfig, pair, deadline }, internal));
        result.diagnostics.push({ ...diagnostic(pair.reason_code, pair.identity_status), source: 'provider_responses', model: pair.model, effort: pair.effort });
        if (discover) {
          if (pair.identity_status === 'mismatch' || pair.request_status !== 'succeeded' && !['denied', 'unavailable'].includes(pair.access)) result.exit_code = 1;
        } else if (pair.identity_status !== 'matched') result.exit_code = pair.identity_status === 'mismatch' || pair.request_status === 'failed' ? result.exit_code === 1 ? 1 : 3 : 1;
      }
    }
    if (result.checked_pairs.every(pair => pair.access !== 'unknown')) result.diagnostics = result.diagnostics.filter(item => item.code !== 'MODEL_ACCESS_UNKNOWN');
  }
  if (discover) result.availability = { total: result.checked_pairs.length, available: result.checked_pairs.filter(pair => pair.access === 'available' && pair.identity_status !== 'mismatch').length, unavailable: result.checked_pairs.filter(pair => ['unavailable', 'denied'].includes(pair.access)).length, unconfirmed: result.checked_pairs.filter(pair => !['available', 'unavailable', 'denied'].includes(pair.access) || pair.identity_status === 'mismatch').length };
  if (Date.now() < deadline) {
    try {
      const end = await withinDeadline(snapshotReader(home), deadline);
      result.configuration_changed = result.source_revision === null ? null : end.configuration_revision !== result.source_revision;
    } catch { result.configuration_changed = null; }
  }
  result.status = result.exit_code === 1 ? 'incomplete' : result.exit_code === 3 ? 'failed' : 'passed';
  return result;
}
