'use strict';

const LEVELS = ['L1', 'L2', 'L3', 'L4'];
const LEVEL_LABELS = ['明确执行', '有边界的推理', '复杂推理', '高不确定性推理'];
const LEVEL_EXAMPLES = ['方法与验收已知，含大型确定性处理', '局部分析、有限方案选择', '多约束、竞争假设与矛盾证据', '检验关键假设、处理强耦合开放问题'];
const ROUTE_EXAMPLES = ['按明确格式取证、按已批准规则批量替换', '实现边界清楚的功能、修复可复现的局部问题', '跨模块根因分析、状态与生命周期问题', '多机制交互的疑难问题、约束冲突的架构取舍'];
const TASK_LABELS = { mechanical: '确定性机械任务', bounded: '普通有界任务', scan: '大型有界扫描或审查', deep: '大型确定性深度任务', complex: '有界复杂任务', uncertain: '高歧义、高耦合或高后果', reasoning: '复杂推理或质量验证失败', latency: '明确追求低延迟' };
const TASK_LEVELS = { mechanical: ['L1'], bounded: ['L2'], scan: ['L1', 'L2'], deep: ['L1', 'L2'], complex: ['L2', 'L3'], uncertain: ['L3', 'L4'], reasoning: ['L3', 'L4'], latency: LEVELS };
const ROLE_LABELS = { task_scan: '扫描取证', task_execute: '范围内产出', task_review: '独立复核', task_delegate: '明确委派' };
const CONTRACT_LABELS = { readonly_evidence: '只读取证，保留证据与局部阻断', scoped_output: '只在明确范围内产出，独占写入', readonly_review: '只读独立复核，保留原验收要求', bounded_delegate: '遵守本次明确职责与授权范围' };
const $ = id => document.getElementById(id);
const clone = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const state = { scope: 'global', bootstrap: null, status: null, modes: [], saved: null, draft: null, selected: null, revision: null, busy: false, stale: false, connected: false, result: null, preview: null, restorePreview: null, readTime: null, tab: 'modes', account: null, modelCheck: null, rulesMode: '', rulesRoute: null };
const SCOPE_LABELS = { global: '全局', project: '当前项目', session: '当前会话' };
let loginTimer;
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
function routePair(pair) {
  const names = { 'gpt-6-luna': 'Luna', 'gpt-6.1-sol': 'Sol 6.1', 'gpt-6-sol': 'Sol 6', 'gpt-6-astra': 'Astra', 'gpt-5.6-sol': 'Sol 5.6' };
  return pair ? `${names[pair.model] ?? pair.model} / ${pair.effort ?? '供应商默认参数'}` : '未配置';
}
function primaryPairs(definition) {
  return [...new Map(Object.values(definition.levels).flatMap(level => [level, ...Object.values(level.tasks ?? {})]).map(({ model, effort }) => [JSON.stringify([model, effort]), { model, effort }])).values()];
}
function validText(value, maximum) { return typeof value === 'string' && value.length > 0 && value.trim() === value && [...value].length <= maximum && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value); }
function displayValue(value) { return value === null || value === undefined ? '未确认' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value); }

class ActionError extends Error {
  constructor(code, message, response = null) { super(message); this.code = code; this.response = response; }
}
async function request(action, params = {}, allowPartial = false) {
  if (!['account', 'setup', 'restore'].includes(action)) params = { ...params, scope: state.scope };
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
    if (allowPartial && (typeof payload.report.data?.configuration_revision === 'string' || ['applied', 'unchanged'].includes(payload.report.data?.result))) return payload;
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
  const selection = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement ? [focused.selectionStart, focused.selectionEnd] : null;
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
      if (selection && ($(focusedId) instanceof HTMLInputElement || $(focusedId) instanceof HTMLTextAreaElement) && selection[0] !== null) $(focusedId).setSelectionRange(...selection);
    }
  }
}

function commandArguments(action, params) {
  const args = [];
  if (['set', 'create', 'configure'].includes(action)) args.push('mode', action);
  else args.push(action);
  args.push(`--codex-home=${state.bootstrap?.home ?? ''}`, '--json');
  if (!['setup', 'restore'].includes(action)) {
    args.push(`--scope=${state.scope}`, `--project=${state.bootstrap?.project ?? ''}`);
    if (state.bootstrap?.thread) args.push(`--thread=${state.bootstrap.thread}`);
  }
  if (params.expectRevision) args.push(`--expect-revision=${params.expectRevision}`);
  if (params.dryRun) args.push('--dry-run');
  if (action === 'setup' && params.mode) args.push(`--mode=${params.mode}`);
  if (action === 'configure') args.push('--definition-stdin');
  if (action === 'create') args.push(`--from=${params.from}`);
  if (action === 'explain') args.push(`--mode=${params.mode}`, `--level=${params.level}`, `--role=${params.role}`);
  if (action === 'explain' && params.task) args.push(`--task=${params.task}`);
  if (['set', 'configure', 'show'].includes(action)) args.push('--', params.mode);
  if (action === 'create') args.push('--', params.name);
  return args;
}
function commandText(argv) { return ['agent-fit', ...argv.map(value => "'" + String(value).replaceAll("'", "'\\''") + "'")].join(' '); }
function nextWrite() {
  if (!state.saved) return null;
  const params = { mode: state.selected, expectRevision: state.revision };
  if (installed() === 'not_installed') return { action: 'setup', params };
  if (dirty()) return { action: 'configure', params: { ...params, definition: { levels: clone(state.draft.levels) } } };
  return { action: 'set', params };
}
function validateDraft() {
  const errors = [];
  if (!state.draft) return false;
  for (const level of LEVELS) {
    const pair = state.draft.levels[level];
    let message = '';
    let target = `${level}-model`;
    if (!validText(pair.model, 200)) message = '主模型必填，须为 1–200 个字符，不能含控制字符或首尾空白。';
    else if (!validText(pair.effort, 40)) message = '推理强度必填，须为 1–40 个字符，不能含控制字符或首尾空白。';
    else if (pair.fallback && (!validText(pair.fallback.model, 200) || !validText(pair.fallback.effort, 40))) message = '备用模型与推理强度都必须完整填写，或关闭备用。';
    else if (pair.fallback && pair.fallback.model === pair.model && pair.fallback.effort === pair.effort) message = '备用组合须与主模型组合不同。';
    if (!message && pair.tasks !== undefined) {
      if (!pair.tasks || typeof pair.tasks !== 'object' || Array.isArray(pair.tasks) || Object.entries(pair.tasks).some(([task, candidate]) => !Object.hasOwn(TASK_LEVELS, task) || !TASK_LEVELS[task].includes(level) || !candidate || typeof candidate !== 'object' || Array.isArray(candidate) || Object.keys(candidate).length !== 3 || !['model', 'effort', 'fallback'].every(key => Object.hasOwn(candidate, key)) || !validText(candidate.model, 200) || !validText(candidate.effort, 40) || candidate.fallback !== null && (!candidate.fallback || Object.keys(candidate.fallback).length !== 2 || !validText(candidate.fallback.model, 200) || !validText(candidate.fallback.effort, 40) || candidate.fallback.model === candidate.model && candidate.fallback.effort === candidate.effort))) message = '任务候选须为有效 JSON 对象，类型须适用本等级，每项提供 model、effort 和 fallback（可为 null），备用须不同。';
      if (message) target = `${level}-tasks`;
    }
    const messageNode = $(`${level}-error`);
    if (messageNode) { messageNode.textContent = message; messageNode.hidden = !message; }
    for (const field of document.querySelectorAll(`[data-level="${level}"]`)) field.setAttribute('aria-invalid', String(Boolean(message)));
    if (message) errors.push({ level, message, target });
  }
  if (errors.length) {
    replace('error-content', node('p', {}, '请先修正以下等级，输入内容已保留。'), node('ul', {}, errors.map(({ level, message, target }) => node('li', {}, node('a', { href: `#${target}`, on: { click: event => { event.preventDefault(); $(`level-${level}`).open = true; const field = $(target); const details = field.closest('.task-candidates'); if (details) details.open = true; field.focus(); } } }, `${level}：${message}`)))));
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
  for (const warning of data?.warnings ?? []) contents.push(node('p', { class: 'muted' }, typeof warning === 'string' ? warning : warning.message ?? warning.code));
  contents.push(node('details', {}, node('summary', {}, '本次执行结果与命令'), node('p', { class: 'muted' }, `退出码：${response.exit_code}；以下命令按 POSIX 终端引用参数。`), node('pre', {}, commandText(response.command?.argv ?? [])), node('details', {}, node('summary', {}, '完整参数数组'), node('pre', {}, JSON.stringify(response.command?.argv ?? [], null, 2))), node('pre', {}, JSON.stringify(data, null, 2))));
  replace('result', contents); $('result').hidden = false;
}
async function performWrite(action, params, { preview = false } = {}) {
  if (state.busy || (action === 'restore' ? !state.connected || !state.revision || state.stale : writeBlocked())) return false;
  busy(true, preview ? '正在执行 CLI 预检与文件变更预览…' : action === 'restore' ? '正在恢复原配置，请等待安全完成…' : '正在保存配置，请等待…');
  clearError();
  try {
    const response = await request(action, { ...params, ...(preview ? { dryRun: true } : {}) }, !preview);
    if (preview) {
      if (action === 'restore') { state.restorePreview = { response, revision: state.revision }; renderRestore(); }
      else { state.preview = { response, definition: clone(state.draft), revision: state.revision }; renderPreview(); }
      return true;
    }
    state.result = response; renderResult();
    const data = response.report.data;
    if (!['applied', 'unchanged'].includes(data?.result)) return false;
    state.preview = null; state.restorePreview = null;
    if (data.created_mode) state.selected = data.created_mode.id;
    if (['restore', 'clear', 'delete'].includes(action)) state.selected = null;
    if (action === 'restore') state.scope = 'global';
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
  state.tab = ['modes', 'rules', 'accounts', 'restore'].includes(tab) ? tab : 'modes';
  for (const item of ['modes', 'rules', 'accounts', 'restore']) $(item).hidden = item !== state.tab;
  for (const link of document.querySelectorAll('.tabs a')) {
    if (link.hash === `#${state.tab}`) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  history.replaceState(null, '', `#${state.tab}`);
  if (state.tab === 'accounts' && state.connected && !state.busy) void accountAction({ operation: 'status' });
}
function renderModePicker() {
  const focusedMode = $('mode-radios').contains(document.activeElement) ? document.activeElement.id : null;
  const isCustom = state.modes.find(mode => mode.id === state.selected)?.kind === 'custom';
  const descriptions = { cut: '节省优先，按任务选同级候选', official: '四级基线与任务候选', high: '选档即授权最高强度，含 Astra/ultra', fire: '选档即授权 Astra/ultra，仍须先验证', custom: '自行设置模型、候选与备用' };
  const radios = state.modes.filter(mode => mode.kind !== 'custom').map(mode => ({ value: mode.id, label: `${mode.name} · ${mode.id}` }));
  radios.push({ value: 'custom', label: '自定义' });
  replace('mode-radios', radios.map(option => node('label', {}, node('input', { id: `mode-${option.value}`, type: 'radio', name: 'mode', value: option.value, 'aria-label': option.label, 'aria-describedby': `mode-${option.value}-note`, checked: option.value === 'custom' ? isCustom : state.selected === option.value, disabled: state.busy || !state.connected, on: { change: () => { if (option.value !== 'custom') selectMode(option.value); else { const target = state.modes.find(mode => mode.kind === 'custom'); if (target) selectMode(target.id); else { renderModePicker(); createMode(); } } } } }), node('span', { class: 'mode-name' }, option.label), node('span', { id: `mode-${option.value}-note`, class: 'mode-description' }, descriptions[option.value] ?? '查看模型分配'))));
  $('custom-picker').hidden = !isCustom;
  replace('custom-mode', state.modes.filter(mode => mode.kind === 'custom').map(mode => node('option', { value: mode.id, selected: mode.id === state.selected }, mode.name)));
  if (focusedMode) $(focusedMode)?.focus();
}
function field(level, name, value, fallback = false) {
  const id = `${level}-${fallback ? 'fallback-' : ''}${name}`;
  return node('div', {}, node('label', { htmlFor: id }, `${fallback ? '备用' : '主'}${name === 'model' ? '模型' : '推理强度'}`), node('input', { id, value, ...(name === 'effort' ? { list: 'effort-suggestions' } : {}), maxLength: name === 'model' ? 400 : 80, autocomplete: 'off', 'data-level': level, 'aria-describedby': `${level}-error`, on: { input: event => {
    const pair = fallback ? state.draft.levels[level].fallback : state.draft.levels[level];
    pair[name] = event.target.value;
    state.preview = null;
    updateLevelSummary(level); renderChanges(); renderControls(); renderPreview();
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
    fields.append(node('div', { class: 'level-meta' }, fallbackDetails));
    const tasks = pair.tasks;
    if (custom() || tasks && typeof tasks === 'object' && Object.keys(tasks).length) {
      const candidates = node('details', { class: 'technical task-candidates' }, node('summary', {}, '同级任务候选'), node('p', {}, '先选复杂度与保障下限，再按任务特征选择；未指定任务类型时使用上方基线。'));
      if (custom()) {
        const id = `${level}-tasks`;
        candidates.append(node('label', { htmlFor: id }, '任务候选 JSON'), node('p', { class: 'muted' }, `本等级支持：${Object.entries(TASK_LEVELS).filter(([, levels]) => levels.includes(level)).map(([task]) => task).join('、')}。每项包含 model、effort、fallback；{} 清空候选。明确保存并选择的组合即为授权，含高强度 Astra。`), node('textarea', { id, value: typeof tasks === 'string' ? tasks : JSON.stringify(tasks ?? {}, null, 2), rows: 8, maxLength: 65536, spellcheck: false, 'data-level': level, 'aria-describedby': `${level}-error`, on: { input: event => {
          try { const parsed = JSON.parse(event.target.value); state.draft.levels[level].tasks = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : event.target.value; } catch { state.draft.levels[level].tasks = event.target.value; }
          state.preview = null; updateLevelSummary(level); renderChanges(); renderControls(); renderPreview();
          $(`${level}-error`).hidden = true; event.target.removeAttribute('aria-invalid');
        } } }));
      } else candidates.append(node('ul', {}, Object.entries(tasks).map(([task, candidate]) => node('li', {}, `${TASK_LABELS[task] ?? task}：${pairText(candidate)}；备用：${pairText(candidate.fallback)}`))));
      fields.append(candidates);
    }
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
    return node('div', { class: 'change-item' }, node('h4', {}, `${level} · ${LEVEL_LABELS[LEVELS.indexOf(level)]}`), before ? node('p', { class: 'change-before' }, `已保存：${pairText(before)}`) : null, node('p', { class: 'change-after' }, `将使用：${pairText(after)}`), !same(before?.fallback, after.fallback) || setup ? node('p', {}, before ? `备用：${pairText(before.fallback)} → ${pairText(after.fallback)}` : `备用：${pairText(after.fallback)}`) : null, !same(before?.tasks, after.tasks) ? node('details', {}, node('summary', {}, '任务候选变化'), node('pre', {}, `原候选：${JSON.stringify(before?.tasks ?? {}, null, 2)}\n新候选：${JSON.stringify(after.tasks ?? {}, null, 2)}`)) : null);
  }));
  if (!changes.length) replace('change-list', node('div', { class: 'empty-changes' }, node('span', { 'aria-hidden': true }, '✓'), node('p', {}, current() ? '没有待应用的变更' : `将切换至「${state.saved.name}」`), node('p', {}, current() ? '可重新设置当前档位，也可选择其他档位。' : '模型组合与当前档位相同。')));
  $('save-note').textContent = state.stale ? '草稿来自旧版本，请刷新后比较。' : dirty() && !current() && !setup ? `保存到${SCOPE_LABELS[state.scope]}，随后可单独设为当前档位。` : dirty() && current() ? `完整四级保存到${SCOPE_LABELS[state.scope]}；编辑上层定义时先生成局部副本。` : setup ? '点击配置后才写入绑定的 Codex home。' : `仅设置${SCOPE_LABELS[state.scope]}的档位选择。`;
  const operation = nextWrite();
  $('command').textContent = operation ? commandText(commandArguments(operation.action, operation.params)) : '尚未选择配置动作。';
  $('copy-definition').hidden = !custom();
}
function renderControls() {
  renderPrimaryCheck();
  const pendingLogin = state.account?.login?.status === 'pending';
  const blocked = state.busy || writeBlocked() || pendingLogin;
  const operation = nextWrite();
  $('draft-label').hidden = !operation;
  $('apply').textContent = state.busy ? '请等待操作完成…' : installed() === 'not_installed' ? '配置 Codex' : dirty() ? current() ? '保存并应用' : '保存档位' : !current() && state.saved ? '设为当前档位' : '重新设置当前档位';
  $('apply').disabled = blocked || !operation;
  $('preview').disabled = blocked || !operation;
  $('check-primary').disabled = blocked || !activeMode() || !current() || dirty();
  $('new-mode').disabled = blocked || installed() !== 'installed';
  $('copy-mode').disabled = blocked || !state.saved || installed() !== 'installed';
  $('delete-mode').disabled = blocked || !custom() || state.saved.definition_scope !== state.scope || dirty();
  $('clear-scope').disabled = blocked || installed() !== 'installed' || !state.status?.selection || dirty();
  $('scope').disabled = state.busy || !state.connected;
  for (const option of $('scope').options) option.disabled = option.value !== 'global' && (installed() !== 'installed' || option.value === 'session' && !state.bootstrap?.thread);
  $('cancel-draft').hidden = !dirty(); $('cancel-draft').disabled = state.busy;
  $('cancel-selection').hidden = !activeMode() || current() || dirty(); $('cancel-selection').disabled = state.busy;
  $('refresh').disabled = state.busy;
  for (const id of ['custom-mode', 'rules-mode', 'edit-routes', 'close-preview', 'compare']) $(id).disabled = state.busy || !state.connected;
  $('explain-role').disabled = state.busy || !state.connected || !state.rulesRoute;
  for (const button of document.querySelectorAll('[data-route], #route-retry')) button.disabled = state.busy || !state.connected || state.stale;
  for (const input of document.querySelectorAll('#levels input, #levels textarea, #mode-radios input')) input.disabled = state.busy || !state.connected;
  for (const input of document.querySelectorAll('#account-refresh, #cancel-login')) input.disabled = state.busy || !state.connected;
  for (const id of ['login-browser', 'login-device', 'login-key']) $(id).disabled = state.busy || !state.connected || pendingLogin;
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
  $('account-context').textContent = `配置目录：${state.bootstrap.home}；供应商：${data.provider ?? '未确认'}。${source[data.credential_source] ?? '尚未确认凭据来源'}。`;
  $('account-logout').hidden = data.account?.status !== 'authenticated';
  const login = data.login;
  const contents = [];
  if (login?.status === 'pending') {
    contents.push(node('p', {}, '等待官方授权完成。完成后本页会自动更新；也可点击“检查已有授权”。'));
    if (login.user_code) contents.push(node('p', {}, '在官方页面输入设备码：', node('code', { class: 'device-code' }, login.user_code)));
    if (/^https:\/\/(?:auth\.openai\.com|auth0\.openai\.com|chatgpt\.com)\//.test(login.url ?? '')) contents.push(node('a', { href: login.url, target: '_blank', rel: 'noopener noreferrer', class: 'auth-link' }, '打开官方授权页面'));
    contents.push(node('button', { id: 'cancel-login', type: 'button', class: 'secondary', on: { click: () => accountAction({ operation: 'cancel' }) } }, '取消本次授权'), node('p', { class: 'muted' }, `本页等待至 ${new Date(login.expires_at).toLocaleTimeString('zh-CN')}。设备码不可用时，请先在 ChatGPT 安全设置中启用设备码登录。`));
  } else if (login) {
    contents.push(node('p', {}, { succeeded: '登录已完成。', cancelled: '本次授权已取消。', expired: '授权等待已超时，请重新发起登录。', failed: '登录未完成，请重试；设备码登录需在 ChatGPT 安全设置中启用。' }[login.status] ?? '登录状态未确认。'));
  }
  replace('account-login', contents);
  clearTimeout(loginTimer);
  if (login?.status === 'pending') loginTimer = setTimeout(() => {
    if (state.busy || !state.connected) { renderAccount(); return; }
    void accountAction({ operation: 'status' }, true);
  }, 2000);
}
async function accountAction(params, polling = false) {
  if (state.busy) return;
  busy(true, polling ? '正在确认授权是否完成…' : '正在处理当前配置目录的账号授权…');
  if (!polling) clearError();
  try {
    const previous = state.account;
    state.account = (await request('account', params)).report.data;
    if (params.operation !== 'status' || previous?.login?.status === 'pending' || !same(previous?.account, state.account.account) || previous?.credential_source !== state.account.credential_source) state.modelCheck = null;
    renderAccount();
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
function rulesDefinition() { return state.modes.find(mode => mode.id === state.rulesMode) ?? activeMode() ?? state.modes.find(mode => mode.id === 'official'); }
function maximumMode(definition) { return definition?.kind === 'builtin' && ['high', 'fire'].includes(definition.id); }
function taskPair(definition, level, task) {
  return task && !(maximumMode(definition) && task !== 'latency') ? definition.levels[level].tasks?.[task] : definition.levels[level];
}
const wideRoutes = matchMedia('(min-width: 1200px)');
function placeRouteDetail() {
  const parent = !wideRoutes.matches && state.rulesRoute ? $(`routes-${state.rulesRoute.level}`) : $('routing-workspace');
  if (parent && $('route-detail').parentElement !== parent) parent.append($('route-detail'));
}
function renderRules() {
  state.rulesRoute = null;
  if (!state.modes.some(mode => mode.id === state.rulesMode) || state.rulesMode === activeMode()?.id) state.rulesMode = '';
  placeRouteDetail();
  $('route-detail-title').textContent = '查看一条路由';
  replace('route-selection', node('p', { class: 'muted' }, '点击等级或任务，查看模型、选择依据与备用条件。'));
  replace('explanation'); replace('route-contract');
  $('route-permissions').hidden = true;
  $('explain-role').value = 'task_delegate';
  const active = activeMode(), definition = rulesDefinition();
  $('rules-context').textContent = `当前作用域：${SCOPE_LABELS[state.scope]}；生效档位：${active?.name ?? '尚未配置'}；来源：${SCOPE_LABELS[state.status?.effective_scope] ?? '未配置'}${state.status?.inherited ? '（继承）' : ''}`;
  $('rules-bound-context').textContent = $('scope-context').textContent;
  replace('rules-mode', node('option', { value: '' }, active ? `当前生效：${active.name} · ${active.id}` : '尚未配置 · 预览官方档位'), state.modes.filter(mode => mode.id !== active?.id).map(mode => node('option', { value: mode.id }, `预览：${mode.name} · ${mode.id}`)));
  $('rules-mode').value = state.rulesMode;
  const preview = !active || definition?.id !== active.id;
  $('rules-view-note').textContent = preview ? `只读预览「${definition?.name ?? '未知'}」，尚未生效。查看不会切换档位。` : `正在展示「${active.name}」的已保存生效配置；未保存草稿不参与路由。`;
  $('rules-view-note').dataset.preview = String(preview);
  $('rules-maximum').hidden = !maximumMode(definition);
  replace('rules-maximum', maximumMode(definition) ? [node('p', {}, preview ? '最高强度预览：查看不构成授权，明确选择此档位后才授权所示最高强度。' : '已选择最高强度档位：明确选档即授权所示组合，包含 Astra / ultra。'), node('p', {}, '普通任务沿用本级最高组合；低延迟仍须显式配置候选。'), definition.id === 'fire' ? node('p', {}, 'fire 每个会话首次使用前实际验证；模型、强度、供应商或账号变化后重新验证。失败时使用用户指定模型与强度，否则继承父代理。') : null] : []);
  replace('route-overview', definition ? LEVELS.map((level, index) => node('button', { type: 'button', class: 'route-overview-item', 'data-route': '', 'data-level': level, 'data-task': '', 'aria-controls': 'route-detail', 'aria-pressed': 'false', on: { click: () => explain(level) } }, node('span', { class: 'route-overview-heading' }, node('strong', {}, level), LEVEL_LABELS[index]), node('strong', { class: 'route-overview-model', title: pairText(definition.levels[level]) }, routePair(definition.levels[level])), node('span', { class: 'muted' }, '等级默认'))) : []);
  replace('route-levels', definition ? LEVELS.map((level, index) => {
    const tasks = ['', ...Object.keys(TASK_LEVELS).filter(task => TASK_LEVELS[task].includes(level))];
    return node('section', { id: `routes-${level}`, class: 'surface route-level', 'aria-labelledby': `routes-${level}-title` },
      node('div', { class: 'route-level-heading' }, node('span', { class: 'level-code' }, level), node('div', {}, node('h3', { id: `routes-${level}-title` }, LEVEL_LABELS[index]), node('p', { class: 'muted' }, LEVEL_EXAMPLES[index]))),
      node('p', { class: 'route-example muted' }, `例如：${ROUTE_EXAMPLES[index]}`),
      node('div', { class: 'route-columns muted', 'aria-hidden': 'true' }, node('span', {}, '任务'), node('span', {}, '模型 / 推理强度')),
      tasks.map(task => {
        const pair = taskPair(definition, level, task), label = task ? TASK_LABELS[task] : '等级默认';
        return node(pair ? 'button' : 'div', { class: `route-row${task ? '' : ' route-baseline'}`, ...(pair ? { type: 'button', 'data-route': '', 'data-level': level, 'data-task': task, 'aria-controls': 'route-detail', 'aria-pressed': 'false', on: { click: () => explain(level, task) } } : {}) }, node('span', { class: 'route-task' }, label, !pair ? node('small', {}, '需在档位配置中添加候选') : null), node('strong', { class: 'route-model', title: pair ? pairText(pair) : '此任务候选未配置，不猜测路由' }, routePair(pair)));
      }));
  }) : [node('p', { class: 'surface muted' }, '暂无可展示的档位。请刷新状态或前往档位配置。')]);
  replace('role-list', (state.status?.roles ?? []).map(role => node('div', { class: 'role' }, node('h4', {}, `${ROLE_LABELS[role.name] ?? role.name} · ${role.name}`), node('p', {}, role.name === 'task_scan' || role.name === 'task_review' ? '只读职责；不获得项目写入权限。' : role.name === 'task_execute' ? '仅在本次明确范围内产出，写入范围须独占。' : '按照本次明确授权与原职责执行。'), node('details', { class: 'technical' }, node('summary', {}, '全局固定角色配置'), node('p', {}, `${role.configured_model ?? role.model ?? '模型未固定'} / ${role.configured_effort ?? role.effort ?? '推理强度未固定'}`), role.source ? node('p', { class: 'path' }, `来源：${role.source}`) : null))));
  if (!state.status?.roles?.length) replace('role-list', node('p', { class: 'muted' }, '未安装本工具的角色。可在档位页先预览并配置。'));
  const summary = state.status?.rules?.summary ?? ['用户与宿主授权优先', '禁止递归委派', '明确独占写入', '外部写入交回主代理', '局部阻断与最小充分验证', '保留专业规则、预算和高影响裁决边界'];
  replace('rule-summary', node('ul', {}, summary.map(item => node('li', {}, typeof item === 'string' ? item : displayValue(item)))));
  replace('sources', node('p', { class: 'muted' }, `项目查询范围：${state.bootstrap?.project ?? '服务启动时的工作目录'}`), node('pre', {}, JSON.stringify({ rules: state.status?.rules, related_config: state.status?.related_config, inspection: state.status?.inspection, diagnostics: state.status?.diagnostics }, null, 2)));
}
function renderRestore() {
  const restoration = state.status?.restoration?.status;
  const messages = { available: '安装前恢复记录可用。仍需先预览并通过完整预检。', not_installed: '未安装本工具，无需恢复。', invalid: '恢复记录无效。自动恢复已阻止，请核对诊断与原备份。' };
  $('restore-capability').textContent = messages[restoration] ?? '恢复能力未确认，请查看状态诊断。';
  $('restore-target').textContent = `绑定 home：${state.bootstrap?.home ?? ''}`;
  const customs = state.restorePreview?.response.report.data?.custom_modes_removed;
  replace('restore-customs', node('p', { class: 'muted' }, customs ? customs.length ? `将清理全部作用域的 ${customs.length} 个自定义档位：${customs.join('、')}` : '没有需清理的自定义档位。' : '恢复会清理此 home 全部作用域的自定义档位；请先预览完整清单。'));
  $('restore-plan').hidden = !state.restorePreview;
  if (state.restorePreview) {
    renderFiles('restore-files', state.restorePreview.response.report.data);
    $('restore-files').append(node('details', { class: 'technical' }, node('summary', {}, '本次恢复预览的终端命令'), node('pre', {}, commandText(state.restorePreview.response.command?.argv ?? []))));
    $('restore-plan-note').textContent = state.restorePreview.response.report.data?.restart?.message ?? '预览未写入；原有配置和无关文件保留。';
  }
  renderControls();
}
function renderPrimaryCheck() {
  const active = activeMode();
  $('primary-check-note').textContent = !active ? '先配置档位，再检测主模型。' : !current() ? '先将所查看档位设为当前，再检测其主模型。' : dirty() ? '先保存并应用修改，再检测主模型。' : `检测已配置的「${active.name}」L1–L4 基线及同级任务候选；相同组合只请求一次，不检测备用。仅手动触发，实际调用可能消耗额度或产生费用。`;
  const check = state.modelCheck;
  if (!check) { replace('primary-check-result'); return; }
  const data = check.response.report.data;
  const stale = data.source_revision !== state.revision || data.configuration_changed !== false || state.stale;
  const note = data.authorization_changed === true ? '授权已变化，本轮结果已失效，请重新检测。' : stale ? '配置已变化或来源版本未确认，请重新检测。' : '仅代表本次请求，不代替 fire 的会话验证。';
  const access = { available: '可调用', unavailable: '不可用', denied: '访问被拒绝', unknown: '未确认' };
  const identity = { matched: '模型与强度匹配', mismatch: '模型或强度不匹配', unverified: '身份未确认' };
  replace('primary-check-result',
    node('p', { class: 'muted' }, `检测档位：${check.mode}；检测时间：${check.time}；${note}`),
    node('ul', {}, data.checked_pairs.map(pair => node('li', {}, `${pairText(pair)}：${pair.identity_status === 'mismatch' ? '未确认' : access[pair.access] ?? '未确认'}；${identity[pair.identity_status] ?? '身份未确认'}；${pair.reason_code}${pair.stopped_by ? `（停止原因：${pair.stopped_by}）` : ''}${pair.http_status ? ` · HTTP ${pair.http_status}` : ''}`))),
    data.diagnostics?.length ? node('p', { class: 'muted' }, `诊断：${[...new Set(data.diagnostics.map(item => item.message ? `${item.message}（${item.code}）` : item.code))].join('；')}`) : null,
    data.history?.status === 'failed' ? node('p', {}, '检测结果未能保存，请检查记录目录权限。') : null);
}
async function checkPrimary() {
  if ($('check-primary').disabled) return;
  const revision = state.revision;
  const active = activeMode();
  const pairs = primaryPairs(active);
  const answer = await dialog({ title: '检测当前档位主模型？', description: `使用 ${state.bootstrap.home} 的当前账号与供应商配置，对已配置的「${active.name}」检测以下 ${pairs.length} 个主模型组合，最多 ${pairs.length} 次实际调用，可能消耗额度或产生费用。总期限 90 秒，不自动重试，不检测备用。`, content: node('ul', {}, pairs.map(pair => node('li', {}, pairText(pair)))), choices: [{ label: '取消', value: null }, { label: '确认并检测', value: true, class: 'primary' }] });
  if (!answer || state.busy) return;
  busy(true, '正在检测当前档位主模型，请等待本次请求完成…'); clearError();
  state.modelCheck = null; renderPrimaryCheck();
  try {
    const response = await request('verify', { expectRevision: revision }, true);
    if (!Array.isArray(response.report.data?.checked_pairs)) throw new ActionError('COMMAND_RESULT_INVALID', '检测结果不完整，请刷新状态后重试。');
    state.modelCheck = { response, time: now(), mode: active.name };
    renderPrimaryCheck();
  } catch (error) { showError(error); }
  finally { busy(false); }
}
function render() {
  const active = activeMode();
  $('configured').dataset.state = installed();
  $('versions').textContent = `工具 ${state.bootstrap?.cli_version ?? '未知'} · 已安装配置 ${state.status?.configuration_version ?? '未安装'}`;
  $('configured').textContent = active ? `已配置：${active.name}` : '尚未配置本工具';
  $('scope').value = state.scope;
  $('scope-context').textContent = state.scope === 'global' ? `绑定 home：${state.bootstrap?.home ?? ''}` : state.scope === 'project' ? `项目：${state.bootstrap?.project ?? ''}` : `聊天：${state.bootstrap?.thread ?? '未绑定'}；项目：${state.bootstrap?.project ?? ''}`;
  $('scope-source').textContent = `编辑范围：${SCOPE_LABELS[state.scope]}；有效来源：${SCOPE_LABELS[state.status?.effective_scope] ?? '未配置'}${state.status?.inherited ? '（继承）' : ''}。${!state.bootstrap?.thread ? '此服务未绑定聊天，当前会话选项不可用。' : ''}`;
  $('clear-scope').textContent = state.scope === 'global' ? '恢复全局默认档位' : '清除本层选择，恢复继承';
  $('runtime').hidden = installed() !== 'installed';
  $('runtime').textContent = '日常全局、项目和会话切档无需重启，后续新任务读取新配置，全局角色在下一轮加载；已开始任务沿用原配置。首次安装、基础规则更新或恢复后请重启 Codex。运行模型身份仍需核实。';
  $('editing-title').textContent = state.saved ? `${custom() ? '正在编辑' : '正在查看'}：${state.saved.name}` : '四级模型预设';
  $('editing-note').textContent = custom() ? state.saved.definition_scope !== state.scope ? '这是上层共享档位；保存时先复制到当前作用域，再修改完整四级。' : '编辑形成草稿，完整四级一次保存。' : '内置定义只读。复制为自定义后可调整四级与备用。';
  const diagnostics = (state.status?.diagnostics ?? []).filter(item => item.status === 'fail' || item.status === 'warn');
  $('diagnostics').hidden = !diagnostics.length;
  replace('diagnostics', diagnostics.map(item => node('p', {}, `${item.code}：${item.message ?? item.status}`, item.source ? node('span', { class: 'path muted' }, `（${item.source}）`) : null)));
  $('last-read').textContent = state.readTime ? `最近状态读取：${state.readTime}；配置与运行状态分别核对。` : '';
  renderModePicker(); renderLevels(); renderChanges(); renderRules(); renderRestore(); renderPreview(); renderControls();
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
async function explain(level, task = '') {
  if (state.busy || !state.connected || state.stale) return;
  const focused = document.activeElement;
  const definition = rulesDefinition(), pair = taskPair(definition, level, task);
  if (!pair) return;
  state.rulesRoute = { level, task };
  const label = task ? TASK_LABELS[task] : '等级默认';
  $('route-detail-title').textContent = `${level} · ${label}`;
  replace('route-selection', node('p', { class: 'route-selected-model', title: pairText(pair) }, routePair(pair)), node('p', { class: 'muted' }, `${definition.name} · ${definition.id === activeMode()?.id ? '当前生效' : '只读预览，尚未生效'}`));
  replace('explanation', node('p', { class: 'muted' }, '正在读取本条路由的选择依据…'));
  replace('route-contract');
  $('route-permissions').hidden = true;
  $('explanation').setAttribute('aria-busy', 'true');
  for (const button of document.querySelectorAll('[data-route]')) button.setAttribute('aria-pressed', String(button.dataset.level === level && button.dataset.task === task));
  placeRouteDetail();
  if (!wideRoutes.matches && focused?.matches('[data-route]')) { $('route-detail-title').focus(); $('route-detail').scrollIntoView({ block: 'nearest' }); }
  busy(true, '正在读取所选路由的解释…'); clearError();
  try {
    const response = await request('explain', { mode: definition.id, level, role: $('explain-role').value, ...(task ? { task } : {}) });
    const data = response.report.data;
    if (data?.configuration_revision !== state.revision) { state.stale = true; throw new ActionError('CONFIG_CHANGED', '配置版本已变化，请刷新状态后重新选择路由。'); }
    if (data.mode_id !== definition.id || data.level !== level || data.task !== (task || null) || data.scope !== state.scope || data.primary?.model !== pair.model || data.primary?.effort !== pair.effort) throw new ActionError('COMMAND_RESULT_INVALID', '解释结果与所选路由不一致，请刷新后重新选择。');
    const reason = task ? maximumMode(definition) && task !== 'latency' ? '此最高强度档位对普通任务使用本级最高组合。' : '命中此等级已配置的任务候选，替代等级默认组合；备用也使用此候选自己的配置。' : '未指定任务候选时，使用此等级的默认组合。';
    const fields = [['等级依据', LEVEL_EXAMPLES[LEVELS.indexOf(level)]], ['选择依据', reason], ['备用模型 / 强度', data.verification?.required ? '用户指定，否则继承父代理' : pairText(data.fallback)]];
    if (data.fallback) fields.push(['备用触发条件', '模型不可用、强度不支持，或临时故障有限重试后仍失败时，才在剩余次数与预算内接续；认证、权限、额度或原因不明时停止。仍须满足宿主、工具与原验收要求，写入者须先停止。']);
    if (data.verification?.required) fields.push(['使用前检查', '每个会话首次使用前实际验证；模型、强度、供应商或账号变化后重新验证。'], ['检查失败', '使用 task_delegate，采用用户指定模型与强度，否则继承父代理当前组合。']);
    replace('explanation', node('dl', {}, fields.flatMap(([label, value]) => [node('dt', {}, label), node('dd', {}, displayValue(value))])), node('p', { class: 'muted' }, '这是配置路由，未验证账号可用性或实际运行模型。'), node('details', { class: 'technical' }, node('summary', {}, '完整模型 ID、来源与诊断'), node('pre', {}, JSON.stringify({ primary: data.primary, scope: data.scope, effective_scope: data.effective_scope, reason_codes: data.reason_codes, fallback_conditions: data.fallback_conditions, source: data.source, configuration_revision: data.configuration_revision }, null, 2)), node('p', { class: 'muted' }, '本次解释的终端命令'), node('pre', {}, commandText(response.command?.argv ?? []))));
    replace('route-contract', node('dl', {}, node('dt', {}, '请求职责'), node('dd', {}, ROLE_LABELS[data.requested_role]), node('dt', {}, '应使用角色'), node('dd', {}, data.dispatch_role), node('dt', {}, '权限契约'), node('dd', {}, CONTRACT_LABELS[data.permission_contract] ?? displayValue(data.permission_contract))));
    $('route-permissions').hidden = false;
  } catch (error) {
    replace('explanation', node('p', {}, `未能读取本条路由：${error.message}`), node('button', { id: 'route-retry', type: 'button', on: { click: () => explain(level, task) } }, '重试读取'));
    showError(error);
  }
  finally {
    $('explanation').setAttribute('aria-busy', 'false'); busy(false);
    if ($('error').hidden && document.activeElement === document.body) (focused?.isConnected ? focused : $('route-detail-title')).focus();
  }
}
async function restore() {
  if (!state.restorePreview || state.busy) return;
  if (state.restorePreview.revision !== state.revision) { showError(new ActionError('CONFIG_CHANGED', '配置版本已改变，请重新预览恢复。')); return; }
  const customs = state.restorePreview.response.report.data.custom_modes_removed;
  const answer = await dialog({ title: '恢复原配置？', description: '按本次预览恢复首次配置前的记录。将移除本工具规则与角色，清理全部自定义档位。恢复后请重启 Codex。', content: [node('p', { class: 'path' }, state.bootstrap.home), node('p', {}, customs.length ? `清理全部作用域的自定义档位：${customs.join('、')}` : '没有需清理的自定义档位。')], choices: [{ label: '保留配置', value: null }, { label: '恢复原配置', value: true, class: 'danger' }] });
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
$('check-primary').addEventListener('click', checkPrimary);
$('scope').addEventListener('change', async event => {
  const selected = event.target.value;
  $('scope').value = state.scope;
  await leaveDraft(async () => {
    const previous = state.scope;
    state.scope = selected;
    if (await refresh({ selected: null, preserve: false })) { state.modelCheck = null; renderPrimaryCheck(); }
    else { state.scope = previous; render(); }
  });
});
for (const [id, action] of [['clear-scope', 'clear'], ['delete-mode', 'delete']]) $(id).addEventListener('click', async () => {
  const selected = state.selected, revision = state.revision;
  const answer = await dialog({ title: action === 'clear' ? '清除当前层的选择？' : '删除自定义档位？', description: action === 'clear' ? `仅修改${SCOPE_LABELS[state.scope]}的选择，保留自定义定义和其他层；全局清除恢复 official。` : `删除${SCOPE_LABELS[state.scope]}中的「${state.saved.name}」。仍被任何作用域引用时会阻止删除。`, choices: [{ label: '取消', value: null }, { label: '确认', value: true, class: 'primary' }] });
  if (answer) await performWrite(action, { expectRevision: revision, ...(action === 'delete' ? { mode: selected } : {}) });
});
$('preview').addEventListener('click', () => apply(true));
$('cancel-draft').addEventListener('click', async () => { state.draft = clone(state.saved); state.preview = null; if (state.stale) await refresh({ preserve: false }); else render(); });
$('cancel-selection').addEventListener('click', () => selectMode(activeMode().id));
$('close-preview').addEventListener('click', () => { state.preview = null; renderPreview(); $('preview').focus(); });
$('copy-definition').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(JSON.stringify({ levels: state.draft.levels }, null, 2)); $('copy-status').textContent = '完整四级 JSON 已复制。'; }
  catch { $('copy-status').textContent = '浏览器未允许复制，请展开以下 JSON 手动复制。'; $('command').textContent += `\n\n${JSON.stringify({ levels: state.draft.levels }, null, 2)}`; }
});
$('rules-mode').addEventListener('change', () => { state.rulesMode = $('rules-mode').value; renderRules(); renderControls(); });
$('explain-role').addEventListener('change', () => { if (state.rulesRoute) explain(state.rulesRoute.level, state.rulesRoute.task); });
$('edit-routes').addEventListener('click', () => {
  const mode = rulesDefinition()?.id;
  if (!state.busy) leaveDraft(async () => { if (mode && !await refresh({ selected: mode, preserve: false })) return; showTab('modes'); $('editing-title').tabIndex = -1; $('editing-title').focus(); });
});
wideRoutes.addEventListener('change', placeRouteDetail);
$('account-refresh').addEventListener('click', () => accountAction({ operation: 'status' }));
$('login-browser').addEventListener('click', () => login('chatgpt'));
$('login-device').addEventListener('click', () => login('chatgptDeviceCode'));
$('login-key').addEventListener('click', () => login('apiKey'));
$('account-logout').addEventListener('click', async () => {
  const answer = await dialog({ title: '退出当前 Codex 登录？', description: `将退出 ${state.bootstrap.home} 对应的官方登录。其他使用此配置目录的客户端也会受影响。供应商环境变量和配置凭据会保留。`, choices: [{ label: '保留登录', value: null }, { label: '退出登录', value: true, class: 'danger' }] });
  if (answer) await accountAction({ operation: 'logout' });
});
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
  if (state.tab === 'accounts' && state.connected) await accountAction({ operation: 'status' });
}
start();
