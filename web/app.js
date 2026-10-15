'use strict';

const LEVELS = ['L1', 'L2', 'L3', 'L4'];
const LEVEL_LABELS = ['明确简单', '范围内产出', '独立复核', '困难与高影响'];
const LEVEL_EXAMPLES = ['查找信息、核对明确事实', '实现已明确范围、整理材料', '检查证据、复核复杂结论', '复杂分析、困难产出与高影响裁决'];
const ROLE_LABELS = { task_scan: '扫描取证', task_execute: '范围内产出', task_review: '独立复核', task_delegate: '明确委派' };
const CONTRACT_LABELS = { readonly_evidence: '只读取证，保留证据与局部阻断', scoped_output: '只在明确范围内产出，独占写入', readonly_review: '只读独立复核，保留原验收要求', bounded_delegate: '遵守本次明确职责与授权范围' };
const $ = id => document.getElementById(id);
const clone = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const state = { bootstrap: null, status: null, modes: [], saved: null, draft: null, selected: null, revision: null, busy: false, stale: false, connected: false, result: null, preview: null, restorePreview: null, models: null, modelTime: null, modelRevision: null, readTime: null, tab: 'modes', account: null, history: [], historyCursor: null };
let loginTimer;
const MODEL_DIAGNOSTICS = {
  CONTEXT_UNVERIFIED: '仅验证当前配置目录，尚未核对桌面会话',
  MODEL_ACCESS_UNKNOWN: '目录信息不能证明调用权限',
  PROBE_ISOLATION_UNSUPPORTED: '旧版验证在发送前停止；更新并重启服务后重新验证',
  PROVIDER_CATALOG_FAILED: '供应商 /models 目录读取失败，可手动填写模型进行验证',
  PROVIDER_CATALOG_INVALID: '供应商目录无效或超过候选数量限制',
  PROVIDER_CATALOG_PARTIAL: '供应商目录尚有分页，未开始批量验证',
  PROVIDER_CATALOG_CHANGED: '供应商目录在确认后变化，请重新检查并确认',
  PROBE_AVAILABLE: 'Responses 请求完成，本次可调用；推理强度使用供应商默认值，严格身份未验证',
  PROBE_VERIFIED: '请求完成，响应模型与推理强度匹配',
  PROBE_AUTH_UNAVAILABLE: '当前凭据无法用于独立验证，请检查登录或供应商授权',
  PROBE_PROVIDER_UNSUPPORTED: '此供应商协议或授权方式暂不支持独立验证',
  PROBE_AUTH_FAILED: '授权被拒绝（401），请检查当前登录',
  PROBE_ACCESS_DENIED: '访问被拒绝（403），请检查模型权限',
  PROBE_RATE_LIMITED: '额度或频率受限（429），请检查额度后重试',
  PROBE_HTTP_FAILED: '供应商请求错误，请核对参数与服务状态',
  PROBE_MODEL_NOT_FOUND: '当前供应商未提供所选模型或未向此账号开放，请核对供应商模型标识',
  PROBE_PARAMETER_REJECTED: '供应商拒绝验证参数，请核对协议与推理强度',
  PROBE_NETWORK_FAILED: '连接或响应异常，请检查供应商网络',
  PROBE_RESPONSE_FAILED: '供应商未返回完整成功结果',
  PROBE_RESPONSE_LIMIT: '响应过大，读取已停止',
  PROBE_STREAM_INCOMPLETE: '响应流中断，未取得完成事件',
  PROBE_UNEXPECTED_OUTPUT: '响应包含非预期输出，未执行工具',
  PROBE_TIMEOUT: '调用超时，未自动重试',
  PROBE_IDENTITY_UNVERIFIED: '调用成功，但响应未完整提供模型与推理强度',
  PROBE_IDENTITY_MISMATCH: '调用成功，但响应报告的模型或强度不同',
};
const modelDiagnostic = code => MODEL_DIAGNOSTICS[code] ? `${MODEL_DIAGNOSTICS[code]}（${code}）` : code;

function node(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === 'class') element.className = value;
    else if (name === 'text') element.textContent = value;
    else if (name === 'on') for (const [event, handler] of Object.entries(value)) element.addEventListener(event, handler);
    else if (name === 'list') element.setAttribute(name, value);
    else if (name in element && !name.startsWith('aria-')) element[name] = value;
    else element.setAttribute(name, String(value));
  }
  for (const child of children.flat()) if (child !== null && child !== undefined) element.append(typeof child === 'string' ? document.createTextNode(child) : child);
  return element;
}
function replace(id, ...children) { $(id).replaceChildren(...children.flat()); }
function installed() { return state.status?.installation; }
function activeMode() { return state.status?.mode ?? null; }
function dirty() { return Boolean(state.saved && state.draft && !same(state.saved.levels, state.draft.levels)); }
function current() { return state.selected === activeMode()?.id; }
function custom() { return state.saved?.kind === 'custom'; }
function now() { return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function pairText(pair) { return pair ? `${pair.model} / ${pair.effort ?? '供应商默认参数'}` : '无备用'; }
function validText(value, maximum) { return typeof value === 'string' && value.length > 0 && value.trim() === value && [...value].length <= maximum && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value); }
function displayValue(value) { return value === null || value === undefined ? '未确认' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value); }

class ActionError extends Error {
  constructor(code, message, response = null) { super(message); this.code = code; this.response = response; }
}
async function request(action, params = {}, allowPartial = false) {
  let response, payload;
  try {
    response = await fetch('/api/actions', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Delegation-Token': state.bootstrap.csrf_token }, body: JSON.stringify({ action, params }) });
    payload = await response.json();
  } catch { state.connected = false; throw new ActionError('RESULT_UNKNOWN', '结果暂无法确认。请检查终端中的本地服务并刷新状态；已提交的操作不会自动重发。'); }
  if (!payload || !Number.isInteger(payload.exit_code) || payload.report?.report_schema_version !== 1 || !Array.isArray(payload.report.errors) || payload.report.data !== null && (typeof payload.report.data !== 'object' || Array.isArray(payload.report.data))) {
    const errors = payload?.errors ?? payload?.report?.errors;
    if (Array.isArray(errors) && errors[0]?.code) throw new ActionError(errors[0].code, errors[0].message || '本地服务拒绝了此次操作。');
    if (payload?.error?.code) throw new ActionError(payload.error.code, payload.error.message || '本地服务拒绝了此次操作。');
    throw new ActionError('COMMAND_RESULT_INVALID', '结果暂无法确认：本地服务返回了无法识别的报告。请刷新状态核对。');
  }
  if (!response.ok || payload.exit_code !== 0 || payload.report.errors.length) {
    if (allowPartial && typeof payload.report.data?.configuration_revision === 'string') return payload;
    const error = payload.report.errors[0] ?? { code: 'COMMAND_FAILED', message: '操作未完整完成，请查看本次结果。' };
    if (['CSRF_REJECTED', 'SERVICE_CLOSING'].includes(error.code)) state.connected = false;
    throw new ActionError(error.code, error.message, payload);
  }
  return payload;
}
function showError(error) {
  const message = error.message || '操作未完成，请刷新状态核对。';
  replace('error-content', node('p', {}, message), node('p', { class: 'muted' }, `诊断：${error.code || 'UNKNOWN'}`));
  $('compare').hidden = !state.stale;
  $('error').hidden = false;
  $('error').focus();
}
function clearError() { $('error').hidden = true; $('compare').hidden = true; }
function busy(value, text = '') {
  state.busy = value;
  $('progress').hidden = !value;
  $('progress').textContent = text;
  renderControls();
  for (const button of $('dialog-actions').querySelectorAll('button')) button.disabled = value;
}
function writeBlocked() {
  const integrity = state.status?.integrity;
  return !state.connected || !state.revision || state.stale || integrity === 'drifted' || installed() === 'invalid' || (state.status?.diagnostics ?? []).some(item => item.status === 'fail' || ['RULES_SHADOWED', 'ADAPTER_UNSUPPORTED'].includes(item.code));
}

async function readBatch(preferred) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
    const status = (await request('status', { details: true }, true)).report.data;
    const listing = (await request('list', {}, true)).report.data;
    if (!status || !Array.isArray(listing?.modes)) throw new ActionError('COMMAND_RESULT_INVALID', '配置查询缺少状态或档位列表。');
    const active = status.mode?.id;
    const selected = listing.modes.some(mode => mode.id === preferred) ? preferred : active ?? listing.modes.find(mode => mode.id === 'official')?.id ?? listing.modes[0]?.id;
    const shown = selected ? (await request('show', { mode: selected }, true)).report.data : null;
    const revision = status.configuration_revision;
    if (revision && revision === listing.configuration_revision && (!shown || revision === shown.configuration_revision)) {
      if (shown && (!shown.definition?.levels || LEVELS.some(level => !shown.definition.levels[level]))) throw new ActionError('COMMAND_RESULT_INVALID', '档位报告缺少完整 L1–L4 定义。');
      return { status, modes: listing.modes, selected, saved: shown?.definition ?? null, revision };
    }
    } catch (error) { if (error.code !== 'BUSY' || attempt === 1) throw error; }
  }
  throw new ActionError('BUSY', '配置在查询期间发生变化。已保留上次结果与草稿，请稍后刷新。');
}
async function refresh({ selected = state.selected, compare = false, preserve = true } = {}) {
  if (state.busy || !state.connected) return false;
  const hasDraft = preserve && dirty();
  const oldRevision = state.revision;
  const focused = document.activeElement;
  const focusedId = focused?.id;
  const selection = focused instanceof HTMLInputElement ? [focused.selectionStart, focused.selectionEnd] : null;
  busy(true, '正在按序读取状态、档位列表与完整定义…');
  try {
    const batch = await readBatch(selected);
    state.status = batch.status; state.modes = batch.modes;
    state.readTime = now();
    if (hasDraft && batch.revision !== oldRevision && !compare) {
      state.stale = true;
      showError(new ActionError('CONFIG_CHANGED', '配置已被其他操作更新。草稿已保留；点击“刷新后比较”重新查看差异，再决定是否保存。'));
    } else if (hasDraft && batch.selected !== state.selected) {
      state.stale = true;
      showError(new ActionError('CONFIG_CHANGED', '正在编辑的自定义档位已不存在。草稿仍保留，但无法保存；取消修改后重新选择档位。'));
    } else {
      state.selected = batch.selected;
      state.saved = batch.saved;
      if (!hasDraft) state.draft = batch.saved ? clone(batch.saved) : null;
      state.revision = batch.revision;
      state.stale = false;
      clearError();
    }
    if (oldRevision !== batch.revision) { state.restorePreview = null; state.preview = null; }
    render();
    return true;
  } catch (error) { showError(error); return false; }
  finally {
    busy(false);
    if ($('error').hidden && focusedId && $(focusedId)) {
      $(focusedId).focus();
      if (selection && $(focusedId) instanceof HTMLInputElement && selection[0] !== null) $(focusedId).setSelectionRange(...selection);
    }
  }
}

function commandArguments(action, params) {
  const args = [];
  if (['set', 'create', 'configure'].includes(action)) args.push('mode', action);
  else if (action === 'models') args.push('models', 'check');
  else args.push(action);
  args.push(`--codex-home=${state.bootstrap?.home ?? ''}`, '--json');
  if (params.expectRevision) args.push(`--expect-revision=${params.expectRevision}`);
  if (params.dryRun) args.push('--dry-run');
  if (action === 'setup' && params.mode) args.push(`--mode=${params.mode}`);
  if (action === 'configure') args.push('--definition-stdin');
  if (action === 'create') args.push(`--from=${params.from}`);
  if (action === 'models') {
    if (params.verify) args.push('--verify');
    if (params.discover) args.push('--discover');
    if (params.expectCatalog) args.push(`--expect-catalog=${params.expectCatalog}`);
    if (params.model) args.push(`--model=${params.model}`, `--effort=${params.effort}`);
  }
  if (action === 'explain') args.push(`--mode=${params.mode}`, `--level=${params.level}`, `--role=${params.role}`);
  if (['set', 'configure', 'show'].includes(action)) args.push('--', params.mode);
  if (action === 'create') args.push('--', params.name);
  return args;
}
function commandText(argv) { return ['sub-d', ...argv.map(value => "'" + String(value).replaceAll("'", "'\\''") + "'")].join(' '); }
function nextWrite() {
  if (!state.saved) return null;
  const params = { mode: state.selected, expectRevision: state.revision };
  if (installed() === 'not_installed') return { action: 'setup', params };
  if (dirty()) return { action: 'configure', params: { ...params, definition: { levels: clone(state.draft.levels) } } };
  if (!current()) return { action: 'set', params };
  return null;
}
function validateDraft() {
  const errors = [];
  if (!state.draft) return false;
  for (const level of LEVELS) {
    const pair = state.draft.levels[level];
    let message = '';
    if (!validText(pair.model, 200)) message = '主模型必填，须为 1–200 个字符，不能含控制字符或首尾空白。';
    else if (!validText(pair.effort, 40)) message = '推理强度必填，须为 1–40 个字符，不能含控制字符或首尾空白。';
    else if (pair.fallback && (!validText(pair.fallback.model, 200) || !validText(pair.fallback.effort, 40))) message = '备用模型与推理强度都必须完整填写，或关闭备用。';
    else if (pair.fallback && pair.fallback.model === pair.model && pair.fallback.effort === pair.effort) message = '备用组合须与主模型组合不同。';
    const messageNode = $(`${level}-error`);
    if (messageNode) { messageNode.textContent = message; messageNode.hidden = !message; }
    for (const field of document.querySelectorAll(`[data-level="${level}"]`)) field.setAttribute('aria-invalid', String(Boolean(message)));
    if (message) errors.push({ level, message });
  }
  if (errors.length) {
    replace('error-content', node('p', {}, '请先修正以下等级，输入内容已保留。'), node('ul', {}, errors.map(({ level, message }) => node('li', {}, node('a', { href: `#${level}-model`, on: { click: event => { event.preventDefault(); $(`level-${level}`).open = true; $(`${level}-model`).focus(); } } }, `${level}：${message}`)))));
    $('error').hidden = false; $('error').focus(); return false;
  }
  return true;
}
function resultTitle(data) {
  if (!data) return '本次操作未完成。';
  if (data.result === 'preview') return '预览完成，尚未写入配置。';
  if (data.result === 'unchanged') return '无配置变化。';
  if (data.configuration_status === 'rolled_back') return '配置未应用，变更已回退。';
  if (data.configuration_status === 'partial') return '操作未完整完成，仍有残留需要核对。';
  if (data.result === 'unknown' || data.configuration_status === 'unknown') return '结果暂无法确认，请刷新状态核对。';
  if (data.configuration_status === 'not_written') return '操作未应用，配置未写入。';
  if (data.configuration_status === 'written') {
    if (data.action === 'restore') return '原配置已恢复。';
    if (data.action === 'create') return '档位已创建，尚未设为当前。';
    if (data.restart?.reason === 'definition_only') return '档位定义已保存，尚未应用。';
    return '配置已写入。';
  }
  return '操作结果已返回。';
}
function renderResult() {
  if (!state.result) return;
  const response = state.result;
  const data = response.report.data;
  const contents = [node('p', {}, resultTitle(data))];
  if (data?.restart?.message) contents.push(node('p', {}, data.restart.message));
  if (['incomplete', 'failed'].includes(data?.post_check?.status)) contents.push(node('p', {}, '模型检查未完成。配置阶段的结果已保留，可在模型检查页单独检查。'));
  if (data?.post_check?.configuration_changed !== false && data?.post_check?.status !== 'not_requested') contents.push(node('p', { class: 'muted' }, '附带模型检查的来源版本可能已变化，请刷新后核对检查对象。'));
  for (const warning of data?.warnings ?? []) contents.push(node('p', { class: 'muted' }, typeof warning === 'string' ? warning : warning.message ?? warning.code));
  contents.push(node('details', {}, node('summary', {}, '本次执行结果与命令'), node('p', { class: 'muted' }, `退出码：${response.exit_code}；以下命令按 POSIX 终端引用参数。`), node('pre', {}, commandText(response.command?.argv ?? [])), node('details', {}, node('summary', {}, '完整参数数组'), node('pre', {}, JSON.stringify(response.command?.argv ?? [], null, 2))), node('pre', {}, JSON.stringify(data, null, 2))));
  replace('result', contents); $('result').hidden = false;
}
async function performWrite(action, params, { preview = false } = {}) {
  if (state.busy || (action === 'restore' ? !state.connected || !state.revision || state.stale : writeBlocked())) return false;
  busy(true, preview ? '正在执行 CLI 预检与文件变更预览…' : action === 'restore' ? '正在恢复原配置，请等待安全完成…' : '正在保存配置并检查结果，请等待…');
  clearError();
  try {
    const response = await request(action, { ...params, ...(preview ? { dryRun: true } : {}) });
    if (preview) {
      if (action === 'restore') { state.restorePreview = { response, revision: state.revision }; renderRestore(); }
      else { state.preview = { response, definition: clone(state.draft), revision: state.revision }; renderPreview(); }
      return true;
    }
    state.result = response; renderResult();
    const data = response.report.data;
    if (!['applied', 'unchanged'].includes(data?.result)) return false;
    state.preview = null; state.restorePreview = null;
    if (action === 'create') state.selected = data.created_mode?.id ?? state.selected;
    if (action === 'restore') { state.selected = null; state.models = null; state.modelTime = null; }
    state.draft = state.saved ? clone(state.saved) : null;
    busy(false);
    await refresh({ preserve: false });
    return true;
  } catch (error) {
    if (error.response) { state.result = error.response; renderResult(); }
    if (error.code === 'CONFIG_CHANGED') state.stale = true;
    if (['RESULT_UNKNOWN', 'COMMAND_RESULT_INVALID'].includes(error.code)) state.stale = true;
    showError(error);
    return false;
  } finally { busy(false); }
}
async function apply(preview = false) {
  const operation = nextWrite();
  if (!operation || dirty() && !validateDraft()) return false;
  return performWrite(operation.action, operation.params, { preview });
}

function dialog({ title, description, content = [], choices }) {
  const previous = document.activeElement;
  $('dialog-title').textContent = title; $('dialog-description').textContent = description;
  replace('dialog-content', content);
  return new Promise(resolve => {
    replace('dialog-actions', choices.map(choice => node('button', { type: 'button', class: choice.class || 'secondary', on: { click: async () => { if (state.busy) return; if (choice.validate && !choice.validate()) return; if (choice.run) { await choice.run(); return; } finish(choice.value); } } }, choice.label)));
    const finish = value => { $('confirm-dialog').removeEventListener('cancel', cancel); $('confirm-dialog').close(); if (previous?.isConnected) previous.focus(); resolve(value); };
    const cancel = event => { event.preventDefault(); if (!state.busy) finish(null); };
    $('confirm-dialog').addEventListener('cancel', cancel);
    $('confirm-dialog').showModal();
    $('dialog-actions').querySelector('button')?.focus();
  });
}
async function leaveDraft(callback) {
  if (!dirty()) { await callback(); return; }
  const answer = await dialog({ title: '保留还是放弃本次修改？', description: '草稿尚未保存。放弃只清除本页输入，不会删除已创建的档位。', choices: [{ label: '继续编辑', value: null }, { label: '放弃修改并离开', value: 'discard' }, { label: current() ? '保存并应用后离开' : '保存档位后离开', value: 'save', class: 'primary' }] });
  if (answer === 'discard') { state.draft = clone(state.saved); state.preview = null; if (state.stale) await refresh({ preserve: false }); else render(); await callback(); }
  if (answer === 'save' && await apply()) await callback();
}
async function selectMode(id) {
  if (state.busy || id === state.selected) return;
  await leaveDraft(() => refresh({ selected: id, preserve: false }));
  renderModePicker();
}
function showTab(tab) {
  state.tab = ['modes', 'rules', 'models', 'restore'].includes(tab) ? tab : 'modes';
  for (const item of ['modes', 'rules', 'models', 'restore']) $(item).hidden = item !== state.tab;
  for (const link of document.querySelectorAll('.tabs a')) {
    if (link.hash === `#${state.tab}`) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  history.replaceState(null, '', `#${state.tab}`);
  if (state.tab === 'models' && state.connected && !state.busy) void loadModelWorkspace();
}
function renderModePicker() {
  const focusedMode = $('mode-radios').contains(document.activeElement) ? document.activeElement.id : null;
  const isCustom = state.modes.find(mode => mode.id === state.selected)?.kind === 'custom';
  const descriptions = { cut: '简单任务，优先节省', official: '按官方建议分配', high: '不同模型各自最高强度', fire: '统一最高组合，先验证；失败时继承', custom: '自行设置模型与备用' };
  const radios = state.modes.filter(mode => mode.kind !== 'custom').map(mode => ({ value: mode.id, label: `${mode.name} · ${mode.id}` }));
  radios.push({ value: 'custom', label: '自定义' });
  replace('mode-radios', radios.map(option => node('label', {}, node('input', { id: `mode-${option.value}`, type: 'radio', name: 'mode', value: option.value, 'aria-label': option.label, 'aria-describedby': `mode-${option.value}-note`, checked: option.value === 'custom' ? isCustom : state.selected === option.value, disabled: state.busy || !state.connected, on: { change: () => { if (option.value !== 'custom') selectMode(option.value); else { const target = state.modes.find(mode => mode.kind === 'custom'); if (target) selectMode(target.id); else { renderModePicker(); createMode(); } } } } }), node('span', { class: 'mode-name' }, option.label), node('span', { id: `mode-${option.value}-note`, class: 'mode-description' }, descriptions[option.value] ?? '查看模型分配'))));
  $('custom-picker').hidden = !isCustom;
  replace('custom-mode', state.modes.filter(mode => mode.kind === 'custom').map(mode => node('option', { value: mode.id, selected: mode.id === state.selected }, mode.name)));
  if (focusedMode) $(focusedMode)?.focus();
}
function evidence(pair) {
  if (!state.models) return '可用性未确认 · 尚未检查账号与目录';
  const data = state.models.report.data;
  const model = data.catalog?.models?.find(item => (item.model ?? item.id) === pair.model);
  const efforts = model?.supported_reasoning_efforts ?? [];
  const evidenceStale = state.modelRevision !== state.revision || data.configuration_changed !== false;
  if (evidenceStale) return '目录证据已过时或来源未确认 · 保留原配置值';
  if (!model) return '目录未列出此标识 · 调用权限仍未确认';
  const supported = efforts.includes(pair.effort);
  return `目录列出 · ${supported ? '支持此推理强度' : efforts.length ? `支持值：${efforts.join('、')}` : '推理强度支持未确认'} · 账号调用权限未确认`;
}
function field(level, name, value, fallback = false) {
  const id = `${level}-${fallback ? 'fallback-' : ''}${name}`;
  return node('div', {}, node('label', { htmlFor: id }, `${fallback ? '备用' : '主'}${name === 'model' ? '模型' : '推理强度'}`), node('input', { id, value, list: name === 'model' ? 'model-suggestions' : 'effort-suggestions', maxLength: name === 'model' ? 400 : 80, autocomplete: 'off', 'data-level': level, 'aria-describedby': `${level}-error ${level}-evidence`, on: { input: event => {
    const pair = fallback ? state.draft.levels[level].fallback : state.draft.levels[level];
    pair[name] = event.target.value;
    state.preview = null;
    updateLevelSummary(level); renderChanges(); renderControls(); renderPreview();
    $(`${level}-evidence`).textContent = evidence(state.draft.levels[level]);
    $(`${level}-error`).hidden = true; event.target.removeAttribute('aria-invalid');
  } } }));
}
const desktop = matchMedia('(min-width: 768px)');
function renderLevels() {
  replace('levels');
  if (!state.draft) return;
  LEVELS.forEach((level, index) => {
    const pair = state.draft.levels[level];
    const fallbackText = !custom() && state.saved.id === 'fire' ? '用户指定，否则继承父代理' : pairText(pair.fallback);
    const summary = node('summary', { on: { click: event => { if (desktop.matches) event.preventDefault(); } } }, node('span', { class: 'level-code' }, level), node('span', { class: 'level-name' }, LEVEL_LABELS[index]), node('span', { id: `${level}-changed`, class: 'tag', hidden: true }, '已修改'), node('span', { class: 'level-example' }, LEVEL_EXAMPLES[index]), node('span', { id: `${level}-summary`, class: 'level-summary' }, pairText(pair)));
    const fields = node('div', { class: 'level-fields' });
    if (custom()) fields.append(node('div', { class: 'field-grid' }, field(level, 'model', pair.model), field(level, 'effort', pair.effort)));
    else fields.append(node('div', { class: 'field-grid' }, node('div', {}, node('p', { class: 'muted' }, '主模型'), node('p', { class: 'readonly-value model-value' }, pair.model)), node('div', {}, node('p', { class: 'muted' }, '推理强度'), node('p', { class: 'readonly-value effort-value' }, pair.effort))));
    fields.append(node('p', { id: `${level}-error`, class: 'field-error', hidden: true }));
    const modelEvidence = node('details', { class: 'model-evidence' }, node('summary', {}, '可用性证据'), node('p', { id: `${level}-evidence`, class: 'evidence' }, evidence(pair)));
    const fallbackFields = node('div', { id: `${level}-fallback-fields`, class: 'field-grid', hidden: !pair.fallback });
    const fallbackDetails = node('details', { class: 'fallback' }, node('summary', { id: `${level}-fallback-summary` }, `备用：${fallbackText}`));
    if (custom()) {
      if (pair.fallback) fallbackFields.append(field(level, 'model', pair.fallback.model, true), field(level, 'effort', pair.fallback.effort, true));
      fallbackDetails.append(node('label', { class: 'enable' }, node('input', { type: 'checkbox', checked: Boolean(pair.fallback), on: { change: event => {
        state.draft.levels[level].fallback = event.target.checked ? { model: '', effort: '' } : null;
        fallbackFields.hidden = !event.target.checked;
        fallbackFields.replaceChildren();
        if (event.target.checked) fallbackFields.append(field(level, 'model', '', true), field(level, 'effort', '', true));
        state.preview = null; updateLevelSummary(level); renderChanges(); renderControls(); renderPreview();
      } } }), '启用一个备用组合'), fallbackFields);
    } else fallbackDetails.append(node('p', { class: 'muted' }, fallbackText));
    fields.append(node('div', { class: 'level-meta' }, modelEvidence, fallbackDetails));
    $('levels').append(node('details', { id: `level-${level}`, class: `level${custom() ? '' : ' readonly'}`, open: desktop.matches || index === 0 }, summary, fields));
    updateLevelSummary(level);
  });
}
function updateLevelSummary(level) {
  const pair = state.draft?.levels[level];
  if (!pair || !$(`${level}-summary`)) return;
  const changed = !same(pair, state.saved.levels[level]);
  $(`level-${level}`).classList.toggle('changed', changed);
  $(`${level}-changed`).hidden = !changed;
  $(`${level}-summary`).textContent = pairText(pair);
  $(`${level}-fallback-summary`).textContent = `备用：${!custom() && state.saved.id === 'fire' ? '用户指定，否则继承父代理' : pairText(pair.fallback)}`;
}
function renderChanges() {
  if (!state.draft) { $('changes-count').textContent = '暂无可编辑的定义'; replace('change-list'); return; }
  const setup = installed() === 'not_installed';
  const old = dirty() || current() ? state.saved : activeMode();
  const changes = LEVELS.filter(level => setup || !same(old?.levels?.[level], state.draft.levels[level]));
  $('changes-count').textContent = changes.length ? `${setup ? '将配置' : '变化涉及'} ${changes.length} 个任务等级` : current() ? '尚未修改' : '模型组合不变，将切换档位';
  replace('change-list', changes.map(level => {
    const before = old?.levels?.[level]; const after = state.draft.levels[level];
    return node('div', { class: 'change-item' }, node('h4', {}, `${level} · ${LEVEL_LABELS[LEVELS.indexOf(level)]}`), before ? node('p', { class: 'change-before' }, `已保存：${pairText(before)}`) : null, node('p', { class: 'change-after' }, `将使用：${pairText(after)}`), !same(before?.fallback, after.fallback) || setup ? node('p', {}, before ? `备用：${pairText(before.fallback)} → ${pairText(after.fallback)}` : `备用：${pairText(after.fallback)}`) : null);
  }));
  if (!changes.length) replace('change-list', node('div', { class: 'empty-changes' }, node('span', { 'aria-hidden': true }, '✓'), node('p', {}, current() ? '没有待应用的变更' : `将切换至「${state.saved.name}」`), node('p', {}, current() ? '选择其他档位，或复制一份自定义配置。' : '模型组合与当前档位相同。')));
  $('save-note').textContent = state.stale ? '草稿来自旧版本，请刷新后比较。' : dirty() && !current() && !setup ? '保存后仍需单独设为当前档位。' : dirty() && current() ? '一次保存完整四级，并同步写入已配置档位。' : setup ? '点击配置后才写入绑定的 Codex home。' : !current() ? '此操作将切换磁盘记录的已配置档位。' : '修改自定义定义，或选择另一个档位。';
  const operation = nextWrite();
  $('command').textContent = operation ? commandText(commandArguments(operation.action, operation.params)) : '尚未选择配置动作。';
  $('copy-definition').hidden = !custom();
}
function renderControls() {
  const pendingLogin = state.account?.login?.status === 'pending';
  const blocked = state.busy || writeBlocked() || pendingLogin;
  const operation = nextWrite();
  $('draft-label').hidden = !operation;
  $('apply').textContent = state.busy ? '请等待操作完成…' : installed() === 'not_installed' ? '配置 Codex' : dirty() ? current() ? '保存并应用' : '保存档位' : !current() && state.saved ? '设为当前档位' : '无修改';
  $('apply').disabled = blocked || !operation;
  $('preview').disabled = blocked || !operation;
  $('new-mode').disabled = blocked || installed() !== 'installed';
  $('copy-mode').disabled = blocked || !state.saved || installed() !== 'installed';
  $('cancel-draft').hidden = !dirty(); $('cancel-draft').disabled = state.busy;
  $('cancel-selection').hidden = !activeMode() || current() || dirty(); $('cancel-selection').disabled = state.busy;
  $('refresh').disabled = state.busy;
  for (const id of ['custom-mode', 'explain', 'explain-mode', 'explain-level', 'explain-role', 'check-models', 'verify', 'verify-model', 'verify-effort', 'close-preview', 'compare']) $(id).disabled = state.busy || !state.connected;
  for (const input of document.querySelectorAll('#levels input, #mode-radios input, #verify-form input[type=radio], #verify-efforts button, #catalog-list button')) input.disabled = state.busy || !state.connected;
  for (const input of document.querySelectorAll('#account-refresh, #history-refresh, #history-more, #history-list button, #cancel-login')) input.disabled = state.busy || !state.connected;
  $('discover-models').disabled = state.busy || !state.connected || pendingLogin || state.models?.report.data?.catalog?.status !== 'complete' || !state.models?.report.data?.catalog?.models?.length || state.models?.report.data?.configuration_changed !== false || state.modelRevision !== state.revision;
  for (const id of ['login-browser', 'login-device', 'login-key', 'check-models', 'verify']) $(id).disabled = state.busy || !state.connected || pendingLogin;
  $('account-logout').disabled = state.busy || !state.connected || pendingLogin;
  for (const link of document.querySelectorAll('.tabs a')) link.setAttribute('aria-disabled', String(state.busy));
  const restoration = state.status?.restoration?.status;
  $('restore-preview').disabled = state.busy || !state.connected || !state.revision || state.stale || !['available'].includes(restoration);
  $('restore-confirm').disabled = state.busy || !state.restorePreview || state.restorePreview.revision !== state.revision;
}
function renderAccount() {
  const data = state.account;
  if (!data) return;
  const labels = { authenticated: '已登录', authentication_required: '需要登录', unknown: '授权状态未确认' };
  const types = { chatgpt: 'ChatGPT', apiKey: 'API Key', amazonBedrock: 'Amazon Bedrock' };
  $('account-status').textContent = `${labels[data.account?.status] ?? '授权状态未确认'}${types[data.account?.type] ? ` · ${types[data.account.type]}` : ''}`;
  const source = { codex_login: '复用 Codex 已保存的登录', provider_environment: '已发现供应商环境变量凭据', provider_config: '已发现供应商配置凭据', not_confirmed: '尚未确认凭据来源' };
  $('account-context').textContent = `配置目录：${state.bootstrap.home}；供应商：${data.provider ?? '未确认'}。${source[data.credential_source] ?? '调用权限待检查'}。`;
  $('account-logout').hidden = data.account?.status !== 'authenticated';
  const login = data.login;
  const contents = [];
  if (login?.status === 'pending') {
    contents.push(node('p', {}, '等待官方授权完成。完成后本页会自动更新；也可点击“检查已有授权”。'));
    if (login.user_code) contents.push(node('p', {}, '在官方页面输入设备码：', node('code', { class: 'device-code' }, login.user_code)));
    if (/^https:\/\/(?:auth\.openai\.com|auth0\.openai\.com|chatgpt\.com)\//.test(login.url ?? '')) contents.push(node('a', { href: login.url, target: '_blank', rel: 'noopener noreferrer', class: 'auth-link' }, '打开官方授权页面'));
    contents.push(node('button', { id: 'cancel-login', type: 'button', class: 'secondary', on: { click: () => accountAction({ operation: 'cancel' }) } }, '取消本次授权'), node('p', { class: 'muted' }, `本页等待至 ${new Date(login.expires_at).toLocaleTimeString('zh-CN')}。设备码不可用时，请先在 ChatGPT 安全设置中启用设备码登录。`));
  } else if (login) {
    contents.push(node('p', {}, { succeeded: '登录已完成。点击“检查账号与目录”读取当前账号的模型。', cancelled: '本次授权已取消。', expired: '授权等待已超时，请重新发起登录。', failed: '登录未完成，请重试；设备码登录需在 ChatGPT 安全设置中启用。' }[login.status] ?? '登录状态未确认。'));
  }
  replace('account-login', contents);
  clearTimeout(loginTimer);
  if (login?.status === 'pending') loginTimer = setTimeout(() => {
    if (state.busy || !state.connected) { renderAccount(); return; }
    void accountAction({ operation: 'status' }, true);
  }, 2000);
}
async function readAccount() {
  const previous = state.account?.login?.status;
  state.account = (await request('account', { operation: 'status' })).report.data;
  if (previous === 'pending' && state.account.login?.status !== 'pending') state.modelRevision = null;
  renderAccount(); renderModels();
}
async function readModelHistory(append = false) {
  try {
    const data = (await request('history', append && state.historyCursor ? { cursor: state.historyCursor } : {})).report.data;
    state.history = append ? [...state.history, ...data.records] : data.records;
    state.historyCursor = data.next_cursor;
    $('history-status').textContent = state.history.length ? `已加载 ${state.history.length} 条记录，按时间从近到远显示。` : '还没有检查记录。完成一次检查后会自动保存。';
    replace('history-list', state.history.map(record => node('details', { class: 'history-record' }, node('summary', {}, `${new Date(record.checked_at).toLocaleString('zh-CN')} · ${record.kind === 'availability' ? '供应商可用性检查' : record.kind === 'verify' ? '调用验证' : '目录检查'} · ${{ passed: record.kind === 'availability' ? '可用性检查完成' : record.kind === 'verify' ? '调用验证通过' : '目录检查完成', failed: '检查失败', incomplete: '检查未完成' }[record.status] ?? '结果未确认'}`), node('p', { class: 'muted' }, record.source_revision === state.revision && record.configuration_changed === false ? '来自当前配置版本；账号及会话匹配仍需重新确认。' : '来自旧配置或版本未确认，仅供历史回看。'), node('ul', {}, record.checked_pairs.map(pair => node('li', {}, pairText(pair)))), node('p', { class: 'muted' }, `诊断：${record.diagnostics.map(item => modelDiagnostic(item.code)).join('；') || '无额外诊断'}`), node('button', { type: 'button', class: 'secondary', on: { click: async event => {
      if (state.busy) return;
      busy(true, '正在读取保存的检查结果…');
      try {
        const result = (await request('history', { id: record.id })).report.data.record;
        const detail = event.target.parentElement;
        detail.querySelector('pre')?.remove(); detail.append(node('pre', {}, JSON.stringify(result, null, 2)));
      } catch (error) { $('history-status').textContent = error.message; }
      finally { busy(false); }
    } } }, '查看完整结果'))));
    $('history-more').hidden = !state.historyCursor;
  } catch (error) { $('history-status').textContent = `记录读取未完成：${error.message}`; }
}
async function loadModelWorkspace() {
  if (state.busy) return;
  busy(true, '正在读取已有授权与检查记录…');
  try { await readAccount(); }
  catch (error) { $('account-status').textContent = error.message; }
  await readModelHistory(); busy(false);
}
async function accountAction(params, polling = false) {
  if (state.busy) return;
  const previousLogin = state.account?.login?.status;
  const previousType = state.account?.account?.type;
  busy(true, polling ? '正在确认授权是否完成…' : '正在处理当前配置目录的账号授权…');
  if (!polling) clearError();
  try {
    state.account = (await request('account', params)).report.data;
    if (params.operation !== 'status' || previousLogin === 'pending' && state.account.login?.status !== 'pending' || previousType && previousType !== state.account.account?.type) state.modelRevision = null;
    renderAccount(); renderModels();
  } catch (error) {
    if (polling) {
      if (state.account?.login) state.account.login = { ...state.account.login, status: 'failed', url: null, user_code: null };
      renderAccount(); $('account-status').textContent = error.message;
    }
    else showError(error);
  } finally { busy(false); }
}
async function login(method) {
  if (state.busy) return;
  const key = method === 'apiKey' ? node('input', { id: 'login-api-key', type: 'password', autocomplete: 'off', maxLength: 4096 }) : null;
  const error = node('p', { class: 'dialog-error', hidden: true });
  const answer = await dialog({ title: method === 'apiKey' ? '使用 API Key 登录' : '授权当前 Codex 配置目录', description: `凭据由 Codex 官方客户端保存到 ${state.bootstrap.home} 对应的认证存储。此操作可能替换该目录的既有登录，其他使用此目录的 Codex 客户端也会受影响。`, content: key ? [node('label', { htmlFor: 'login-api-key' }, 'OpenAI API Key'), key, error, node('p', { class: 'muted' }, '密钥只传给本地 Codex，不写入页面存储或检查记录。')] : node('p', {}, '发起后在官方页面完成授权，本页会等待并更新登录状态。'), choices: [{ label: '取消', value: null }, { label: key ? '登录' : '发起授权', value: true, class: 'primary', validate: () => {
    if (key && !validText(key.value, 4096)) { error.textContent = '请输入有效 API Key，不含首尾空白或控制字符。'; error.hidden = false; key.focus(); return false; } return true;
  } }] });
  if (answer) {
    const params = { operation: 'login', method };
    if (key) { params.apiKey = key.value; key.value = ''; }
    await accountAction(params);
    delete params.apiKey;
  } else if (key) key.value = '';
}
function renderPreview() {
  $('preview-area').hidden = !state.preview;
  if (!state.preview) return;
  const data = state.preview.response.report.data;
  $('preview-note').textContent = data?.restart?.message ?? '预览未写入；正式应用仍重新预检和核对配置版本。';
  renderFiles('preview-files', data);
  $('preview-files').append(node('details', { class: 'technical' }, node('summary', {}, '本次预览的终端命令'), node('pre', {}, commandText(state.preview.response.command?.argv ?? []))));
}
function renderFiles(id, data) {
  const files = Array.isArray(data?.changes) ? data.changes : Array.isArray(data?.changed_files) ? data.changed_files : [];
  if (!files.length) { replace(id, node('p', { class: 'muted' }, '未列出文件变化；请核对 CLI 返回的计划。')); return; }
  const verbs = { create: '新增', update: '更新', delete: '清除', remove: '清除', restore: '恢复', replace: data?.action === 'restore' ? '恢复' : '更新', write: '写入' };
  replace(id, node('ul', { class: 'file-list' }, files.map(file => typeof file === 'string' ? node('li', {}, file) : node('li', {}, node('strong', {}, verbs[file.action ?? file.operation] ?? file.action ?? file.operation ?? '变更'), file.path ?? file.relative ?? displayValue(file)))));
}
function renderRules() {
  replace('role-list', (state.status?.roles ?? []).map(role => node('div', { class: 'role' }, node('h4', {}, `${ROLE_LABELS[role.name] ?? role.name} · ${role.name}`), node('p', {}, `${role.configured_model ?? role.model ?? '模型未固定'} / ${role.configured_effort ?? role.effort ?? '推理强度未固定'}`), node('p', {}, role.name === 'task_scan' || role.name === 'task_review' ? '只读职责；不获得项目写入权限。' : role.name === 'task_execute' ? '仅在本次明确范围内产出，写入范围须独占。' : '按照本次明确授权与原职责执行。'), role.source ? node('p', { class: 'path' }, `来源：${role.source}`) : null)));
  if (!state.status?.roles?.length) replace('role-list', node('p', { class: 'muted' }, '未安装本工具的角色。可在档位页先预览并配置。'));
  const summary = state.status?.rules?.summary ?? ['用户与宿主授权优先', '禁止递归委派', '明确独占写入', '外部写入交回主代理', '局部阻断与最小充分验证', '保留专业规则、预算和高影响裁决边界'];
  replace('rule-summary', node('ul', {}, summary.map(item => node('li', {}, typeof item === 'string' ? item : displayValue(item)))));
  replace('sources', node('p', { class: 'muted' }, `项目查询范围：${state.bootstrap?.project ?? '服务启动时的工作目录'}`), node('pre', {}, JSON.stringify({ rules: state.status?.rules, related_config: state.status?.related_config, inspection: state.status?.inspection, diagnostics: state.status?.diagnostics }, null, 2)));
  const previous = $('explain-mode').value;
  replace('explain-mode', state.modes.map(mode => node('option', { value: mode.id, selected: mode.id === (previous || state.selected) }, mode.name)));
}
function renderRestore() {
  const restoration = state.status?.restoration?.status;
  const messages = { available: '安装前恢复记录可用。仍需先预览并通过完整预检。', not_installed: '未安装本工具，无需恢复。', invalid: '恢复记录无效。自动恢复已阻止，请核对诊断与原备份。' };
  $('restore-capability').textContent = messages[restoration] ?? '恢复能力未确认，请查看状态诊断。';
  $('restore-target').textContent = `绑定 home：${state.bootstrap?.home ?? ''}`;
  const customs = state.modes.filter(mode => mode.kind === 'custom');
  replace('restore-customs', node('p', { class: 'muted' }, customs.length ? `将清理 ${customs.length} 个自定义档位：${customs.map(mode => mode.name).join('、')}` : '没有本工具创建的自定义档位。'));
  $('restore-plan').hidden = !state.restorePreview;
  if (state.restorePreview) {
    renderFiles('restore-files', state.restorePreview.response.report.data);
    $('restore-files').append(node('details', { class: 'technical' }, node('summary', {}, '本次恢复预览的终端命令'), node('pre', {}, commandText(state.restorePreview.response.command?.argv ?? []))));
    $('restore-plan-note').textContent = state.restorePreview.response.report.data?.restart?.message ?? '预览未写入；原有配置和无关文件保留。';
  }
  renderControls();
}
function renderModelCatalogue() {
  const data = state.models?.report.data;
  const catalogue = data?.catalog?.models ?? [];
  const provider = data?.catalog?.source === 'provider_models';
  $('catalog-source').textContent = data ? provider ? '来源：当前供应商的 /models 候选目录。可调用性以该供应商的 /responses 实际请求结果为准；推理强度待验证。' : '来源：Codex model/list。目录记录不代表第三方供应商的调用权限。' : '';
  $('discover-models').hidden = !provider;
  $('available-filter').hidden = data?.check_kind !== 'availability';
  const available = new Set((data?.checked_pairs ?? []).filter(pair => pair.access === 'available' && pair.identity_status !== 'mismatch').map(pair => pair.model));
  const query = $('model-search').value.trim().toLowerCase();
  const matches = catalogue.filter(model => (!$('available-only').checked || data?.check_kind !== 'availability' || available.has(model.model)) && [model.model, model.id, model.display_name].some(value => value?.toLowerCase().includes(query)));
  $('catalog-count').textContent = catalogue.length ? `显示 ${matches.length} / ${catalogue.length} 个${provider ? '供应商候选' : '目录模型'}${data?.check_kind === 'availability' ? ` · 本次可调用 ${available.size} 个` : ''}` : '';
  if (!catalogue.length) {
    replace('catalog-list', node('p', { class: 'model-empty' }, state.models ? '没有取得模型目录。检查诊断后，点击上方按钮重试。也可手动输入模型。' : '点击“检查账号与目录”读取模型，再选择需要验证的组合。'));
    return;
  }
  if (!matches.length) {
    replace('catalog-list', node('p', { class: 'model-empty' }, '没有匹配的模型。换个关键词，或在验证区手动输入标识。'));
    return;
  }
  replace('catalog-list', matches.map(model => {
    const id = model.model ?? model.id;
    const checked = (data?.checked_pairs ?? []).find(pair => pair.model === id && pair.request_status !== 'not_requested');
    const outcome = checked ? available.has(id) ? '本次可调用' : ['unavailable', 'denied'].includes(checked.access) ? '本次不可用' : '本次未确认' : '未验证调用';
    return node('div', { class: 'catalog-model' }, node('div', {}, node('h3', {}, model.display_name ?? id), node('p', { class: 'muted path' }, id), provider ? node('p', { class: 'muted' }, outcome) : null, node('div', { class: 'effort-tags' }, (model.supported_reasoning_efforts ?? []).map(effort => node('span', {}, effort)))), node('button', { type: 'button', class: 'secondary', disabled: state.busy || !state.connected, 'aria-label': `选择 ${id} 验证`, on: { click: () => {
      document.querySelector('input[name=verify-scope][value=single]').checked = true;
      $('verify-model').value = id;
      const efforts = model.supported_reasoning_efforts ?? [];
      if (!efforts.includes($('verify-effort').value)) $('verify-effort').value = efforts.includes(model.default_reasoning_effort) ? model.default_reasoning_effort : efforts[0] ?? '';
      renderVerification(); $('verify-model').focus();
    } } }, '选择验证'));
  }));
}
function renderVerification() {
  const single = document.querySelector('input[name=verify-scope]:checked').value === 'single';
  $('verify-pair').hidden = !single;
  const model = (state.models?.report.data?.catalog?.models ?? []).find(model => model.model === $('verify-model').value || model.id === $('verify-model').value);
  const efforts = model?.supported_reasoning_efforts ?? [];
  replace('verify-effort-suggestions', efforts.map(value => node('option', { value })));
  $('verify-efforts').hidden = !single || !efforts.length;
  replace('verify-efforts', efforts.map(effort => node('button', { type: 'button', disabled: state.busy || !state.connected, 'aria-pressed': String(effort === $('verify-effort').value), on: { click: () => {
    $('verify-effort').value = effort;
    for (const button of $('verify-efforts').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.textContent === effort));
    renderVerificationSupport(model);
  } } }, effort)));
  $('verify-support').hidden = !single;
  renderVerificationSupport(model);
  const active = activeMode();
  replace('verify-summary', single ? [] : active?.levels ? [node('h3', {}, `已配置：${active.name}`), node('ul', { class: 'verify-combinations' }, [...new Set(LEVELS.map(level => pairText(active.levels[level])))].map(pair => node('li', {}, pair))), node('p', { class: 'muted' }, '相同组合只验证一次，备用组合不在本次范围内。')] : node('p', { class: 'model-empty' }, '尚未配置档位。选择“单个模型”即可验证。'));
}
function renderVerificationSupport(model) {
  const efforts = model?.supported_reasoning_efforts ?? [];
  let message = '目录支持这个组合，实际调用权限仍待验证。';
  if (!state.models) message = '先检查目录可获得强度建议；也可手动填写组合。';
  else if (state.modelRevision !== state.revision || state.models.report.data.configuration_changed !== false) message = '目录结果已过期或配置版本未确认。请重新检查后核对组合。';
  else if (!$('verify-model').value) message = '从目录选择模型，或手动输入标识。';
  else if (!model) message = '目录未列出这个模型，调用权限待验证。';
  else if (!efforts.length) message = '目录未提供推理强度，需手动填写。';
  else if (!efforts.includes($('verify-effort').value)) message = '请选择目录支持的推理强度；当前输入未在支持列表中。';
  $('verify-support').textContent = message;
}
function renderModels() {
  $('models-auth-note').textContent = `模型检查优先复用 ${state.bootstrap?.home ?? '当前 Codex 配置目录'} 中的已有授权与供应商凭据；不会要求重复登录。`;
  const stale = state.models && (state.modelRevision !== state.revision || state.models.report.data.configuration_changed !== false);
  $('models-time').textContent = state.modelTime ? `上次检查 ${state.modelTime}${stale ? ' · 配置或授权已变化，或版本未确认，请重新检查' : ''}` : '尚未检查。可以先检查目录，或直接填写一个模型验证。';
  $('check-models').textContent = state.models ? '重新检查账号与目录' : '检查账号与目录';
  replace('model-suggestions', (state.models?.report.data?.catalog?.models ?? []).map(model => node('option', { value: model.model ?? model.id }, model.display_name ?? model.model ?? model.id)));
  renderModelCatalogue(); renderVerification();
  if (!state.models) { replace('models-status'); replace('models-feedback'); replace('models-result'); return; }
  const data = state.models.report.data;
  const pairs = data.checked_pairs ?? [];
  const statusLabels = { authenticated: '已登录', authentication_required: '需要登录', complete: '目录读取完整', incomplete: '目录读取未完成', not_checked: '尚未检查', passed: '目录检查完成', unknown: '未确认', not_requested: '未发起调用', supported: '支持', incompatible: '不支持', unavailable: '本次不可用', succeeded: '本次请求成功', success: '本次请求成功', failed: '本次请求失败', verified: '本次请求成功', unverified: '未确认', available: '本次可调用', denied: '访问被拒绝', matched: '响应身份匹配', mismatch: '响应身份不匹配' };
  replace('models-status', node('span', {}, `账号：${statusLabels[data.account?.status] ?? '未确认'}`), node('span', {}, statusLabels[data.catalog?.status] ?? '目录状态未确认'));
  const contents = [];
  const feedback = [];
  if (data.history?.status === 'failed') feedback.push(node('p', { class: 'model-outcome' }, '本次结果未能保存。请检查配置目录下 .subagent-delegation-checks 的权限；当前结果仍可查看。'));
  const codes = new Set((data.diagnostics ?? []).map(item => item.code));
  if (codes.has('CONFIG_CHANGED')) feedback.push(node('p', { class: 'model-outcome' }, '配置在确认后变化，本次未发起验证。请刷新状态，再重新确认组合。'));
  if (codes.has('PROBE_ISOLATION_UNSUPPORTED')) feedback.push(node('div', { class: 'model-outcome' }, node('h3', {}, '本次未发起实际调用'), node('p', {}, '当前客户端无法安全隔离验证所用工具，验证已停止。目录结果仍可用于选择参数。'), node('p', { class: 'muted' }, 'fire 检查未通过时，按规则使用用户指定组合，否则继承父代理的模型与推理强度。')));
  else if (codes.has('ACCOUNT_AUTHENTICATION_REQUIRED')) feedback.push(node('p', { class: 'model-outcome' }, '请先在所检查的 Codex CLI 中登录，再重新检查目录。'));
  else if (codes.has('CODEX_NOT_FOUND')) feedback.push(node('p', { class: 'model-outcome' }, '本地服务未找到 Codex CLI。请确认启动服务的终端能运行 codex，再重启本地服务并检查。'));
  else if (codes.has('MODEL_EFFORT_UNSUPPORTED')) feedback.push(node('p', { class: 'model-outcome' }, '有组合的推理强度不受目录支持。选择目录模型，并改用支持的强度后再验证。'));
  if (data.probe_transport === 'responses_without_tools') {
    feedback.push(node('div', { class: 'model-outcome' }, node('h3', {}, data.check_kind === 'availability' ? '供应商可用性检查结果' : data.status === 'passed' ? '实际调用验证通过' : '实际调用验证结果'), pairs.map(pair => node('p', {}, `${pairText(pair)}：${modelDiagnostic(pair.reason_code)}${pair.http_status ? ` · HTTP ${pair.http_status}` : ''}`))));
  }
  if (data.availability) feedback.unshift(node('p', { class: 'model-outcome', role: 'status' }, `共 ${data.availability.total} 个候选：本次可调用 ${data.availability.available} 个，不可用 ${data.availability.unavailable} 个，未确认 ${data.availability.unconfirmed} 个。默认参数验证不证明指定推理强度可用，也不能替代 fire 的会话验证。`));
  if (data.catalog?.reason_code) feedback.push(node('p', { class: 'model-outcome' }, modelDiagnostic(data.catalog.reason_code)));
  if (codes.has('PROVIDER_CATALOG_CHANGED')) feedback.push(node('p', { class: 'model-outcome' }, modelDiagnostic('PROVIDER_CATALOG_CHANGED')));
  replace('models-feedback', feedback);
  contents.push(node('p', { class: 'muted' }, '目录列出与参数支持不代表实际调用成功；实际模型身份需要可信的运行信息。'));
  if (data.context?.context_match !== 'matched') contents.push(node('p', { class: 'muted' }, '本次检查的是 CLI 配置目录，尚未确认与当前 Codex 会话一致。'));
  if (pairs.length) {
    const checked = pairs.map(pair => {
      const fields = [['参数支持', statusLabels[pair.parameter_support] ?? '未确认'], ['实际调用', statusLabels[pair.request_status] ?? '未确认'], ['调用权限', statusLabels[pair.access] ?? '未确认'], ['实际身份', pair.actual_model ? `${pair.actual_model} / ${pair.actual_effort ?? '未确认'}` : '未确认']];
      return node('div', { class: 'checked-model' }, node('h4', { class: 'path' }, pairText(pair)), node('dl', {}, fields.flatMap(([label, value]) => [node('dt', {}, label), node('dd', {}, value)])));
    });
    contents.push(node('details', { class: 'technical' }, node('summary', {}, `本次检查的 ${pairs.length} 个模型组合`), checked));
  }
  contents.push(node('details', { class: 'technical' }, node('summary', {}, '检查诊断与配置版本'), node('p', { class: 'path' }, `检查目录：${data.home ?? state.bootstrap.home}`), node('p', {}, `检查开始版本：${data.configuration_revision ?? '未确认'}；组合来源版本：${data.source_revision ?? '未确认'}`), data.diagnostics?.length ? node('ul', {}, data.diagnostics.map(item => node('li', {}, `${item.code}：${item.message ?? item.status ?? '未确认'}`))) : node('p', { class: 'muted' }, '未返回额外诊断。')));
  contents.push(node('details', { class: 'technical' }, node('summary', {}, '本次检查的终端命令与结果'), node('pre', {}, commandText(state.models.command?.argv ?? [])), node('p', { class: 'muted' }, `退出码：${state.models.exit_code}`)));
  replace('models-result', contents);
}
function render() {
  const active = activeMode();
  $('configured').dataset.state = installed();
  $('versions').textContent = `工具 ${state.bootstrap?.cli_version ?? '未知'} · 已安装配置 ${state.status?.configuration_version ?? '未安装'}`;
  $('configured').textContent = active ? `已配置：${active.name}` : '尚未配置本工具';
  $('runtime').hidden = installed() !== 'installed';
  $('runtime').textContent = '使用已配置规则前请重启 Codex；运行生效未验证。';
  $('editing-title').textContent = state.saved ? `${custom() ? '正在编辑' : '正在查看'}：${state.saved.name}` : '四级模型预设';
  $('editing-note').textContent = custom() ? '编辑形成草稿，完整四级一次保存。' : '内置定义只读。复制为自定义后可调整四级与备用。';
  const diagnostics = (state.status?.diagnostics ?? []).filter(item => item.status === 'fail' || item.status === 'warn');
  $('diagnostics').hidden = !diagnostics.length;
  replace('diagnostics', diagnostics.map(item => node('p', {}, `${item.code}：${item.message ?? item.status}`, item.source ? node('span', { class: 'path muted' }, `（${item.source}）`) : null)));
  $('last-read').textContent = state.readTime ? `最近状态读取：${state.readTime}；配置与运行状态分别核对。` : '';
  renderModePicker(); renderLevels(); renderChanges(); renderRules(); renderModels(); renderRestore(); renderPreview(); renderControls();
}

async function createMode() {
  if (state.busy || writeBlocked()) return;
  await leaveDraft(async () => {
    const name = node('input', { id: 'new-name', autocomplete: 'off', maxLength: 160 });
    const source = node('select', { id: 'new-from' }, state.modes.map(mode => node('option', { value: mode.id, selected: mode.id === state.selected }, mode.name)));
    const error = node('p', { class: 'dialog-error', hidden: true, role: 'status' });
    const preview = node('div', { id: 'create-preview', hidden: true });
    name.addEventListener('input', () => { preview.hidden = true; });
    source.addEventListener('change', () => { preview.hidden = true; });
    const valid = () => {
      const normalized = name.value.trim().normalize('NFC');
      if (!validText(normalized, 80) || state.modes.some(mode => mode.id === normalized || mode.name === normalized)) {
        error.textContent = '名称须为唯一的 1–80 个字符，不能与内置命令同名或包含控制字符。'; error.hidden = false; name.focus(); return false;
      }
      return true;
    };
    const answer = await dialog({ title: '新建自定义档位', description: '复制完整四级配置。创建后尚未设为当前，取消后续修改不会删除这个档位。', content: [node('label', { htmlFor: 'new-name' }, '档位名称'), name, node('label', { htmlFor: 'new-from' }, '从哪个档位复制'), source, error, preview], choices: [{ label: '关闭', value: null }, { label: '预览创建', validate: valid, run: async () => {
      preview.hidden = false; preview.replaceChildren(node('p', { class: 'muted', role: 'status' }, '正在执行创建预览…'));
      if (await performWrite('create', { name: name.value.trim().normalize('NFC'), from: source.value, expectRevision: state.revision }, { preview: true })) {
        preview.hidden = false;
        preview.replaceChildren(node('p', { class: 'muted', role: 'status' }, '预览完成，尚未创建档位。'), node('pre', {}, commandText(state.preview.response.command?.argv ?? [])));
      }
    } }, { label: '创建档位', value: 'create', class: 'primary', validate: valid }] });
    if (answer === 'create') await performWrite('create', { name: name.value.trim().normalize('NFC'), from: source.value, expectRevision: state.revision });
  });
}
async function explain() {
  if (state.busy) return;
  busy(true, '正在读取所选等级与职责的解释…'); clearError();
  try {
    const response = await request('explain', { mode: $('explain-mode').value, level: $('explain-level').value, role: $('explain-role').value });
    const data = response.report.data;
    const fields = [['档位', data.mode_name ?? data.mode_id], ['主模型 / 推理强度', pairText(data.primary)], ['请求职责', ROLE_LABELS[data.requested_role] ?? data.requested_role], ['实际应使用角色', data.dispatch_role], ['权限契约', CONTRACT_LABELS[data.permission_contract] ?? displayValue(data.permission_contract)], ['备用组合', data.verification?.required ? '用户指定，否则继承父代理' : pairText(data.fallback)]];
    if (data.verification?.required) fields.push(['使用前检查', '每个会话首次使用前实际验证；模型、强度、供应商或账号变化后重新验证。'], ['检查失败', '使用 task_delegate，采用用户指定模型与强度，否则继承父代理当前组合。']);
    replace('explanation', node('h4', {}, `${data.level} 的选择解释`), node('dl', {}, fields.flatMap(([label, value]) => [node('dt', {}, label), node('dd', {}, displayValue(value))])), node('p', { class: 'muted' }, '这是静态选择解释；账号调用权限与运行生效未验证。'), node('details', { class: 'technical' }, node('summary', {}, '选择原因、备用条件与来源'), node('pre', {}, JSON.stringify({ reason_codes: data.reason_codes, fallback_conditions: data.fallback_conditions, source: data.source, configuration_revision: data.configuration_revision }, null, 2)), node('p', { class: 'muted' }, '本次解释的终端命令'), node('pre', {}, commandText(response.command?.argv ?? []))));
    $('explanation').hidden = false;
  } catch (error) { showError(error); }
  finally { busy(false); }
}
async function checkModels(params = {}) {
  if (state.busy) return;
  busy(true, params.verify ? '正在验证已确认的组合；请等待调用与清理完成…' : '正在检查账号状态与模型目录，不发起推理请求…'); clearError();
  try {
    state.models = await request('models', params);
    state.modelTime = now(); state.modelRevision = state.models.report.data?.source_revision ?? state.models.report.data?.configuration_revision;
    renderModels();
    for (const level of LEVELS) if ($(`${level}-evidence`)) $(`${level}-evidence`).textContent = evidence(state.draft.levels[level]);
  } catch (error) {
    if (error.response?.report.data) { state.models = error.response; state.modelTime = now(); state.modelRevision = error.response.report.data.source_revision ?? error.response.report.data.configuration_revision; renderModels(); }
    showError(error);
  } finally { if (state.connected) await readModelHistory(); busy(false); }
  if (state.connected && state.models && state.modelRevision !== state.revision) {
    await refresh();
    busy(true, '正在核对检查记录与当前配置版本…'); await readModelHistory(); busy(false);
  }
}
async function discoverModels() {
  if (state.busy || $('discover-models').disabled) return;
  const catalog = state.models?.report.data?.catalog;
  if (catalog?.source !== 'provider_models' || !catalog.revision || !catalog.models.length) return;
  const params = { verify: true, discover: true, expectRevision: state.revision, expectCatalog: catalog.revision };
  const answer = await dialog({ title: '确认供应商模型检查', description: `使用 ${state.bootstrap.home} 的已有授权，向当前供应商的 /responses 逐一请求以下 ${catalog.models.length} 个候选，最多 ${catalog.models.length} 次调用，可能消耗额度或产生费用。使用供应商默认推理参数，总期限 90 秒；超时或请求错误会标为未确认，不自动重试。结果将保存到当前配置目录。`, content: node('ul', {}, catalog.models.map(model => node('li', {}, model.id))), choices: [{ label: '关闭', value: null }, { label: '确认额度并检查', value: true, class: 'primary' }] });
  if (answer) await checkModels(params);
}
async function verify() {
  if (state.busy) return;
  const single = document.querySelector('input[name=verify-scope]:checked').value === 'single';
  const params = { verify: true, expectRevision: state.revision };
  let pairs;
  if (single) {
    params.model = $('verify-model').value; params.effort = $('verify-effort').value;
    if (!validText(params.model, 200) || !validText(params.effort, 40)) { showError(new ActionError('INVALID_ARGUMENT', '请完整填写模型与推理强度，不含控制字符或首尾空白。')); return; }
    pairs = [{ model: params.model, effort: params.effort }];
  } else {
    const active = activeMode();
    if (!active?.levels) { showError(new ActionError('NOT_INSTALLED', '尚未配置当前档位。可选择单个模型与推理强度进行验证。')); return; }
    pairs = [...new Map(LEVELS.map(level => { const pair = active.levels[level]; return [pairText(pair), { model: pair.model, effort: pair.effort }]; })).values()];
  }
  const answer = await dialog({ title: '确认本次实际调用验证', description: `优先使用 ${state.bootstrap.home} 的已有授权与供应商配置，可能消耗额度或产生费用。本次验证 ${pairs.length} 个主模型组合，不验证备用，不修改配置。宿主不支持受限验证时将拒绝调用。`, content: node('ul', {}, pairs.map(pair => node('li', {}, pairText(pair)))), choices: [{ label: '关闭', value: null }, { label: '确认额度并验证', value: true, class: 'primary' }] });
  if (answer) await checkModels(params);
}
async function restore() {
  if (!state.restorePreview || state.busy) return;
  if (state.restorePreview.revision !== state.revision) { showError(new ActionError('CONFIG_CHANGED', '配置版本已改变，请重新预览恢复。')); return; }
  const customs = state.modes.filter(mode => mode.kind === 'custom');
  const answer = await dialog({ title: '恢复原配置？', description: '按本次预览恢复首次配置前的记录。将移除本工具规则与角色，清理全部自定义档位。恢复后请重启 Codex。', content: [node('p', { class: 'path' }, state.bootstrap.home), node('p', {}, customs.length ? `清理自定义档位：${customs.map(mode => mode.name).join('、')}` : '没有自定义档位。')], choices: [{ label: '保留配置', value: null }, { label: '恢复原配置', value: true, class: 'danger' }] });
  if (answer) await performWrite('restore', { expectRevision: state.restorePreview.revision });
}

for (const form of document.querySelectorAll('form')) form.addEventListener('submit', event => event.preventDefault());
for (const link of document.querySelectorAll('.tabs a')) link.addEventListener('click', event => { event.preventDefault(); if (!state.busy) leaveDraft(() => showTab(link.hash.slice(1))); });
$('refresh').addEventListener('click', () => state.connected ? refresh() : start());
$('compare').addEventListener('click', () => refresh({ compare: true }));
$('custom-mode').addEventListener('change', event => selectMode(event.target.value));
$('new-mode').addEventListener('click', createMode);
$('copy-mode').addEventListener('click', createMode);
$('apply').addEventListener('click', () => apply());
$('preview').addEventListener('click', () => apply(true));
$('cancel-draft').addEventListener('click', async () => { state.draft = clone(state.saved); state.preview = null; if (state.stale) await refresh({ preserve: false }); else render(); });
$('cancel-selection').addEventListener('click', () => selectMode(activeMode().id));
$('close-preview').addEventListener('click', () => { state.preview = null; renderPreview(); $('preview').focus(); });
$('copy-definition').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(JSON.stringify({ levels: state.draft.levels }, null, 2)); $('copy-status').textContent = '完整四级 JSON 已复制。'; }
  catch { $('copy-status').textContent = '浏览器未允许复制，请展开以下 JSON 手动复制。'; $('command').textContent += `\n\n${JSON.stringify({ levels: state.draft.levels }, null, 2)}`; }
});
$('explain').addEventListener('click', explain);
$('discover-models').addEventListener('click', discoverModels);
$('available-only').addEventListener('change', renderModelCatalogue);
$('check-models').addEventListener('click', () => checkModels());
$('account-refresh').addEventListener('click', () => accountAction({ operation: 'status' }));
$('login-browser').addEventListener('click', () => login('chatgpt'));
$('login-device').addEventListener('click', () => login('chatgptDeviceCode'));
$('login-key').addEventListener('click', () => login('apiKey'));
$('account-logout').addEventListener('click', async () => {
  const answer = await dialog({ title: '退出当前 Codex 登录？', description: `将退出 ${state.bootstrap.home} 对应的官方登录。其他使用此配置目录的客户端也会受影响。供应商环境变量和配置凭据会保留。`, choices: [{ label: '保留登录', value: null }, { label: '退出登录', value: true, class: 'danger' }] });
  if (answer) await accountAction({ operation: 'logout' });
});
$('history-refresh').addEventListener('click', async () => { if (state.busy) return; busy(true, '正在读取检查记录…'); await readModelHistory(); busy(false); });
$('history-more').addEventListener('click', async () => { if (state.busy) return; busy(true, '正在读取更早的检查记录…'); await readModelHistory(true); busy(false); });
$('verify').addEventListener('click', verify);
for (const input of document.querySelectorAll('input[name=verify-scope]')) input.addEventListener('change', renderVerification);
$('model-search').addEventListener('input', renderModelCatalogue);
for (const id of ['verify-model', 'verify-effort']) $(id).addEventListener('input', renderVerification);
$('restore-preview').addEventListener('click', () => performWrite('restore', { expectRevision: state.revision }, { preview: true }));
$('restore-confirm').addEventListener('click', restore);
desktop.addEventListener('change', event => { for (const level of LEVELS) if ($(`level-${level}`)) $(`level-${level}`).open = event.matches || level === 'L1'; });
window.addEventListener('beforeunload', event => { if (dirty() || state.busy) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('focus', () => { if (state.connected && !state.busy && !$('confirm-dialog').open) refresh(); });

async function start() {
  showTab(location.hash.slice(1));
  busy(true, '正在连接本地配置服务…');
  try {
    const response = await fetch('/api/bootstrap', { credentials: 'same-origin' });
    const bootstrap = await response.json();
    if (!response.ok || typeof bootstrap.home !== 'string' || typeof bootstrap.csrf_token !== 'string' || typeof bootstrap.cli_version !== 'string') throw new ActionError('SERVICE_UNAVAILABLE', '本地服务无法连接，请在终端重新启动 serve 后刷新页面。');
    state.bootstrap = bootstrap; state.connected = true;
    $('home').textContent = bootstrap.home;
    if (!state.result && bootstrap.recent_result?.report?.data?.result) { state.result = bootstrap.recent_result; renderResult(); }
    busy(false);
    await refresh();
  } catch (error) { state.connected = false; showError(error instanceof ActionError ? error : new ActionError('SERVICE_UNAVAILABLE', '本地服务无法连接，请在终端重新启动 serve 后刷新页面。')); }
  finally { busy(false); }
  if (state.tab === 'models' && state.connected) await loadModelWorkspace();
}
start();
