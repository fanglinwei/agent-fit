'use strict';

const LEVELS = ['L1', 'L2', 'L3', 'L4'];
const LEVEL_LABELS = ['明确简单', '范围内产出', '独立复核', '困难与高影响'];
const LEVEL_EXAMPLES = ['查找信息、核对明确事实', '实现已明确范围、整理材料', '检查证据、复核复杂结论', '复杂分析、困难产出与高影响裁决'];
const ROLE_LABELS = { task_scan: '扫描取证', task_execute: '范围内产出', task_review: '独立复核', task_delegate: '明确委派' };
const CONTRACT_LABELS = { readonly_evidence: '只读取证，保留证据与局部阻断', scoped_output: '只在明确范围内产出，独占写入', readonly_review: '只读独立复核，保留原验收要求', bounded_delegate: '遵守本次明确职责与授权范围' };
const $ = id => document.getElementById(id);
const clone = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const state = { bootstrap: null, status: null, modes: [], saved: null, draft: null, selected: null, revision: null, busy: false, stale: false, connected: false, result: null, preview: null, restorePreview: null, models: null, modelTime: null, modelRevision: null, readTime: null, tab: 'modes' };

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
function installed() { return typeof state.status?.installation === 'object' ? state.status.installation.status : state.status?.installation; }
function activeMode() { return typeof state.status?.mode === 'object' ? state.status.mode : state.modes.find(mode => mode.id === state.status?.installation?.mode) ?? null; }
function dirty() { return Boolean(state.saved && state.draft && !same(state.saved.levels, state.draft.levels)); }
function current() { return state.selected === activeMode()?.id; }
function custom() { return state.saved?.kind === 'custom'; }
function now() { return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function pairText(pair) { return pair ? `${pair.model} / ${pair.effort}` : '无备用'; }
function validText(value, maximum) { return typeof value === 'string' && value.length > 0 && value.trim() === value && [...value].length <= maximum && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value); }
function displayValue(value) { return value === null || value === undefined ? '未确认' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value); }

class ActionError extends Error {
  constructor(code, message, response = null) { super(message); this.code = code; this.response = response; }
}
function modeCommand(selector) {
  return state.modes.find(mode => mode.id === selector)?.command ?? selector;
}
async function request(action, params = {}, allowPartial = false) {
  if (params.mode) params = { ...params, mode: modeCommand(params.mode) };
  if (params.from) params = { ...params, from: modeCommand(params.from) };
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
  const integrity = state.status?.integrity ?? state.status?.installation?.integrity;
  return !state.connected || !state.revision || state.stale || integrity === 'drifted' || installed() === 'invalid' || (state.status?.diagnostics ?? []).some(item => item.status === 'fail' || ['RULES_SHADOWED', 'ADAPTER_UNSUPPORTED'].includes(item.code));
}

async function readBatch(preferred) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
    const status = (await request('status', { details: true }, true)).report.data;
    const listing = (await request('list', {}, true)).report.data;
    if (!status || !Array.isArray(listing?.modes)) throw new ActionError('COMMAND_RESULT_INVALID', '配置查询缺少状态或档位列表。');
    const active = typeof status.mode === 'object' ? status.mode?.id : status.installation?.mode;
    const selected = listing.modes.some(mode => mode.id === preferred) ? preferred : active ?? listing.modes.find(mode => mode.id === 'balanced')?.id ?? listing.modes[0]?.id;
    const shown = selected ? (await request('show', { mode: listing.modes.find(mode => mode.id === selected)?.command ?? selected }, true)).report.data : null;
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
  if (params.mode) params = { ...params, mode: modeCommand(params.mode) };
  if (params.from) params = { ...params, from: modeCommand(params.from) };
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
  if (installed() === 'not_installed' || installed() === 'legacy') return { action: 'setup', params };
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
}
function renderModePicker() {
  const focusedMode = $('mode-radios').contains(document.activeElement) ? document.activeElement.id : null;
  const isCustom = state.modes.find(mode => mode.id === state.selected)?.kind === 'custom';
  const descriptions = { economy: '简单任务，优先节省', balanced: '日常任务，兼顾质量', performance: '复杂任务，优先质量', custom: '自行设置模型与备用' };
  const radios = state.modes.filter(mode => mode.kind !== 'custom').map(mode => ({ value: mode.id, label: `${mode.name} · ${mode.command ?? mode.id}` }));
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
    const summary = node('summary', { on: { click: event => { if (desktop.matches) event.preventDefault(); } } }, node('span', { class: 'level-code' }, level), node('span', { class: 'level-name' }, LEVEL_LABELS[index]), node('span', { id: `${level}-changed`, class: 'tag', hidden: true }, '已修改'), node('span', { class: 'level-example' }, LEVEL_EXAMPLES[index]), node('span', { id: `${level}-summary`, class: 'level-summary' }, pairText(pair)));
    const fields = node('div', { class: 'level-fields' });
    if (custom()) fields.append(node('div', { class: 'field-grid' }, field(level, 'model', pair.model), field(level, 'effort', pair.effort)));
    else fields.append(node('div', { class: 'field-grid' }, node('div', {}, node('p', { class: 'muted' }, '主模型'), node('p', { class: 'readonly-value model-value' }, pair.model)), node('div', {}, node('p', { class: 'muted' }, '推理强度'), node('p', { class: 'readonly-value effort-value' }, pair.effort))));
    fields.append(node('p', { id: `${level}-error`, class: 'field-error', hidden: true }));
    const modelEvidence = node('details', { class: 'model-evidence' }, node('summary', {}, '可用性证据'), node('p', { id: `${level}-evidence`, class: 'evidence' }, evidence(pair)));
    const fallbackFields = node('div', { id: `${level}-fallback-fields`, class: 'field-grid', hidden: !pair.fallback });
    const fallbackDetails = node('details', { class: 'fallback' }, node('summary', { id: `${level}-fallback-summary` }, `备用：${pairText(pair.fallback)}`));
    if (custom()) {
      if (pair.fallback) fallbackFields.append(field(level, 'model', pair.fallback.model, true), field(level, 'effort', pair.fallback.effort, true));
      fallbackDetails.append(node('label', { class: 'enable' }, node('input', { type: 'checkbox', checked: Boolean(pair.fallback), on: { change: event => {
        state.draft.levels[level].fallback = event.target.checked ? { model: '', effort: '' } : null;
        fallbackFields.hidden = !event.target.checked;
        fallbackFields.replaceChildren();
        if (event.target.checked) fallbackFields.append(field(level, 'model', '', true), field(level, 'effort', '', true));
        state.preview = null; updateLevelSummary(level); renderChanges(); renderControls(); renderPreview();
      } } }), '启用一个备用组合'), fallbackFields);
    } else fallbackDetails.append(node('p', { class: 'muted' }, pairText(pair.fallback)));
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
  $(`${level}-fallback-summary`).textContent = `备用：${pairText(pair.fallback)}`;
}
function renderChanges() {
  if (!state.draft) { $('changes-count').textContent = '暂无可编辑的定义'; replace('change-list'); return; }
  const setup = installed() === 'not_installed' || installed() === 'legacy';
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
  const blocked = state.busy || writeBlocked();
  const operation = nextWrite();
  $('draft-label').hidden = !operation;
  $('apply').textContent = state.busy ? '请等待操作完成…' : installed() === 'not_installed' ? '配置 Codex' : installed() === 'legacy' ? '升级并配置 Codex' : dirty() ? current() ? '保存并应用' : '保存档位' : !current() && state.saved ? '设为当前档位' : '无修改';
  $('apply').disabled = blocked || !operation;
  $('preview').disabled = blocked || !operation;
  $('new-mode').disabled = blocked || !['installed', 'legacy'].includes(installed());
  $('copy-mode').disabled = blocked || !state.saved || !['installed', 'legacy'].includes(installed());
  $('cancel-draft').hidden = !dirty(); $('cancel-draft').disabled = state.busy;
  $('cancel-selection').hidden = !activeMode() || current() || dirty(); $('cancel-selection').disabled = state.busy;
  const version = state.status?.configuration_version ?? state.status?.installation?.version;
  $('upgrade').hidden = !version || version === state.bootstrap?.cli_version || installed() !== 'installed'; $('upgrade').disabled = blocked;
  $('refresh').disabled = state.busy;
  for (const id of ['custom-mode', 'explain', 'explain-mode', 'explain-level', 'explain-role', 'check-models', 'verify', 'verify-model', 'verify-effort', 'close-preview', 'compare']) $(id).disabled = state.busy || !state.connected;
  for (const input of document.querySelectorAll('#levels input, #mode-radios input, #verify-form input[type=radio]')) input.disabled = state.busy || !state.connected;
  for (const link of document.querySelectorAll('.tabs a')) link.setAttribute('aria-disabled', String(state.busy));
  const restoration = state.status?.restoration?.status ?? state.status?.installation?.restoration?.status;
  $('restore-preview').disabled = state.busy || !state.connected || !state.revision || state.stale || !['available'].includes(restoration);
  $('restore-confirm').disabled = state.busy || !state.restorePreview || state.restorePreview.revision !== state.revision;
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
  const summary = state.status?.rules?.summary ?? ['用户与宿主授权优先', '禁止递归委派', '只读 Git', '明确独占写入', '外部写入交回主代理', '局部阻断与最小充分验证', '保留专业规则、预算和高影响裁决边界'];
  replace('rule-summary', node('ul', {}, summary.map(item => node('li', {}, typeof item === 'string' ? item : displayValue(item)))));
  replace('sources', node('p', { class: 'muted' }, `项目查询范围：${state.bootstrap?.project ?? '服务启动时的工作目录'}`), node('pre', {}, JSON.stringify({ rules: state.status?.rules, related_config: state.status?.related_config, inspection: state.status?.inspection, diagnostics: state.status?.diagnostics }, null, 2)));
  const previous = $('explain-mode').value;
  replace('explain-mode', state.modes.map(mode => node('option', { value: mode.id, selected: mode.id === (previous || state.selected) }, mode.name)));
}
function renderRestore() {
  const restoration = state.status?.restoration?.status ?? state.status?.installation?.restoration?.status;
  const messages = { available: '安装前恢复记录可用。仍需先预览并通过完整预检。', not_installed: '未安装本工具，无需恢复。', not_applicable: '未安装本工具，无需恢复。', legacy_unavailable: '旧版安装没有首次配置前的恢复基线。自动恢复不可用，请使用原备份或在本地人工核对。', invalid: '恢复记录无效。自动恢复已阻止，请核对诊断与原备份。' };
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
function renderModels() {
  $('models-time').textContent = state.modelTime ? `上次检查：${state.modelTime}；对象：${state.bootstrap.home}。${state.modelRevision !== state.revision ? '配置版本已变化，结果需重新核对。' : '目录信息不能证明实际调用权限。'}` : '尚未检查。配置值的调用权限未确认。';
  replace('model-suggestions', (state.models?.report.data?.catalog?.models ?? []).map(model => node('option', { value: model.model ?? model.id }, model.display_name ?? model.model ?? model.id)));
  if (!state.models) { replace('models-result'); return; }
  const data = state.models.report.data;
  const catalogue = data.catalog?.models ?? [];
  const pairs = data.checked_pairs ?? [];
  const statusLabels = { complete: '目录读取完整', incomplete: '目录读取未完成', not_checked: '尚未检查', passed: '目录检查完成', unknown: '未确认', not_requested: '未请求', supported: '支持', incompatible: '不支持', unavailable: '本次不可用', succeeded: '本次请求成功', success: '本次请求成功', failed: '本次请求失败', verified: '本次请求成功', unverified: '未确认' };
  const contents = [node('p', {}, `账号状态：${statusLabels[data.account?.status] ?? data.account?.status ?? '未确认'}；${statusLabels[data.catalog?.status] ?? '目录状态未确认'}`), node('p', { class: 'muted' }, '目录列出、参数支持、实际请求成功和实际模型身份是不同证据。实际身份没有可信 metadata 时保持未确认。')];
  if (data.configuration_changed !== false || data.context?.context_match !== 'matched') contents.push(node('p', { class: 'muted' }, '账号/供应商上下文或配置版本未确认，结果不能证明当前配置的调用权限。'));
  if (catalogue.length) {
    const table = node('table', {}, node('caption', {}, '目录与参数建议'), node('thead', {}, node('tr', {}, ['模型标识', '目录记录', '支持的推理强度'].map(text => node('th', { scope: 'col' }, text)))), node('tbody', {}, catalogue.map(model => node('tr', {}, node('td', {}, model.model ?? model.id), node('td', {}, model.display_name ?? '目录列出'), node('td', {}, (model.supported_reasoning_efforts ?? []).join('、') || '未确认')))));
    contents.push(node('div', { class: 'table-wrap' }, table));
  } else contents.push(node('p', { class: 'muted' }, '没有取得模型目录。保留原配置值，可查看诊断后重试。'));
  if (pairs.length) {
    const table = node('table', {}, node('caption', {}, '本次检查的模型组合'), node('thead', {}, node('tr', {}, ['模型 / 推理强度', '参数支持', '该次请求', '实际身份'].map(text => node('th', { scope: 'col' }, text)))), node('tbody', {}, pairs.map(pair => node('tr', {}, node('td', {}, pairText(pair), node('p', { class: 'muted' }, pair.reason_code ?? '')), node('td', {}, statusLabels[pair.parameter_support] ?? pair.parameter_support ?? '未确认'), node('td', {}, statusLabels[pair.request_status] ?? pair.request_status ?? '未确认', node('p', { class: 'muted' }, `权限：${statusLabels[pair.access] ?? pair.access ?? '未确认'}`)), node('td', {}, pair.actual_model ? `${pair.actual_model} / ${pair.actual_effort ?? '未确认'}` : '未确认')))));
    contents.push(node('div', { class: 'table-wrap' }, table));
  }
  contents.push(node('details', { class: 'technical' }, node('summary', {}, '检查诊断与配置版本'), node('p', {}, `检查开始版本：${data.configuration_revision ?? '未确认'}；组合来源版本：${data.source_revision ?? '未确认'}`), data.diagnostics?.length ? node('ul', {}, data.diagnostics.map(item => node('li', {}, `${item.code}：${item.message ?? item.status ?? '未确认'}`))) : node('p', { class: 'muted' }, '未返回额外诊断。')));
  contents.push(node('details', { class: 'technical' }, node('summary', {}, '本次检查的终端命令与结果'), node('pre', {}, commandText(state.models.command?.argv ?? [])), node('p', { class: 'muted' }, `退出码：${state.models.exit_code}`)));
  replace('models-result', contents);
}
function render() {
  const active = activeMode();
  $('configured').dataset.state = installed();
  $('versions').textContent = `工具 ${state.bootstrap?.cli_version ?? '未知'} · 已安装配置 ${state.status?.configuration_version ?? state.status?.installation?.version ?? '未安装'}`;
  $('configured').textContent = installed() === 'legacy' ? '旧版安装，档位未记录' : active ? `已配置：${active.name}` : '尚未配置本工具';
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
      if (!validText(normalized, 80) || state.modes.some(mode => mode.id === normalized || mode.name === normalized || mode.command === normalized)) {
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
    const fields = [['档位', data.mode_name ?? data.mode_id], ['主模型 / 推理强度', pairText(data.primary)], ['请求职责', ROLE_LABELS[data.requested_role] ?? data.requested_role], ['实际应使用角色', data.dispatch_role], ['权限契约', CONTRACT_LABELS[data.permission_contract] ?? displayValue(data.permission_contract)], ['备用组合', pairText(data.fallback)]];
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
  } finally { busy(false); }
}
async function verify() {
  if (state.busy) return;
  const single = document.querySelector('input[name=verify-scope]:checked').value === 'single';
  const params = { verify: true };
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
  const answer = await dialog({ title: '确认本次实际调用验证', description: `可能消耗额度或产生费用。本次验证 ${pairs.length} 个主模型组合，不验证备用，不修改配置。宿主不支持受限验证时将拒绝调用。`, content: node('ul', {}, pairs.map(pair => node('li', {}, pairText(pair)))), choices: [{ label: '关闭', value: null }, { label: '确认额度并验证', value: true, class: 'primary' }] });
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
$('upgrade').addEventListener('click', async () => {
  if (dirty()) { showError(new ActionError('UNSAVED_DRAFT', '请先保存或取消草稿，再预览升级配置。')); return; }
  const params = { mode: activeMode()?.id ?? state.selected, expectRevision: state.revision };
  if (!await performWrite('setup', params, { preview: true })) return;
  const answer = await dialog({ title: '升级已安装配置？', description: '以下是 CLI 预览的文件变化。保留已选择的档位与自定义定义；升级后请重启 Codex。', content: node('pre', {}, JSON.stringify(state.preview.response.report.data?.changes ?? state.preview.response.report.data?.changed_files ?? [], null, 2)), choices: [{ label: '返回查看预览', value: null }, { label: '升级配置', value: true, class: 'primary' }] });
  if (answer) await performWrite('setup', params);
});
$('copy-definition').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(JSON.stringify({ levels: state.draft.levels }, null, 2)); $('copy-status').textContent = '完整四级 JSON 已复制。'; }
  catch { $('copy-status').textContent = '浏览器未允许复制，请展开以下 JSON 手动复制。'; $('command').textContent += `\n\n${JSON.stringify({ levels: state.draft.levels }, null, 2)}`; }
});
$('explain').addEventListener('click', explain);
$('check-models').addEventListener('click', () => checkModels());
$('verify').addEventListener('click', verify);
for (const input of document.querySelectorAll('input[name=verify-scope]')) input.addEventListener('change', () => { $('verify-pair').hidden = input.value !== 'single'; });
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
}
start();
