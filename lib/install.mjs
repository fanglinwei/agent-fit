import fs from 'node:fs/promises';
import { constants, realpathSync, lstatSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import { VERSION, LEVELS, ROLES, BUILTINS, resolveDefinition, validateDefinition, renderPayload, verificationRequirement } from './codex.mjs';
import { SCOPE_FILE, scopeContext, validateScopeStore, scopeEntry, visibleModes, scopedSelection, assertUnreferenced } from './scopes.mjs';

const SKILL = 'skills/agent-fit';
const STATE_DIR = '.agent-fit';
const STATE = `${STATE_DIR}/state.json`;
const BASELINE = `${STATE_DIR}/restore.json`;
const CUSTOM = `${STATE_DIR}/custom-modes.json`;
const LOCK = `${STATE_DIR}/install.lock`;
const START = '<!-- agent-fit:start -->';
const END = '<!-- agent-fit:end -->';
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ROLE_PATHS = Object.keys(ROLES).map(name => `agents/${name.replaceAll('_', '-')}.toml`);
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const permission = value => Number.isInteger(value) && value >= 0 && value <= 0o777;
const safeText = (value, maximum = 200) => typeof value === 'string' && [...value].length <= maximum && !/[\p{Cc}\p{Cf}]/u.test(value) ? value : null;
const safeSource = value => value.replace(/[\p{Cc}\p{Cf}]/gu, char => `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}`);
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
let testHooks = {};
// These hooks inject filesystem faults in isolated tests; no CLI exposes them.
export function setTestHooks(hooks = {}) { testHooks = hooks; }

export class DelegationError extends Error {
  constructor(code, message, exitCode = 1, details = {}) {
    super(message); this.name = 'DelegationError'; this.code = code; this.exitCode = exitCode; this.details = details;
  }
}
function fail(code, message, exitCode = 1, details = {}) { throw new DelegationError(code, message, exitCode, details); }
function keys(value, required, optional = []) {
  return object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key));
}
export function resolveHome(explicit) {
  let value = explicit ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  if (typeof value !== 'string' || !value || /[\p{Cc}\p{Cf}]/u.test(value)) fail('INVALID_HOME', 'Codex home 必须是有效路径。', 2);
  if (value === '~' || value.startsWith('~/')) value = path.join(os.homedir(), value.slice(2));
  const absolute = path.resolve(value);
  let parent = path.dirname(absolute), suffix = [path.basename(absolute)];
  while (parent !== path.dirname(parent)) {
    try { lstatSync(parent); return path.join(realpathSync(parent), ...suffix); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    suffix.unshift(path.basename(parent)); parent = path.dirname(parent);
  }
  return path.join(parent, ...suffix);
}
function owned(relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || /[\p{Cc}\p{Cf}]/u.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) return false;
  return relative === CUSTOM || relative === SCOPE_FILE || ROLE_PATHS.includes(relative) || relative.startsWith(`${SKILL}/`) && !relative.slice(SKILL.length + 1).split('/').some(part => part.startsWith('.'));
}
function ownedDirectory(relative) {
  return ['agents', 'skills', SKILL, STATE_DIR].includes(relative) || relative.startsWith(`${SKILL}/`) && owned(`${relative}/entry`);
}
async function statOrNull(target) {
  try { return await fs.lstat(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function checkPath(home, relative = '') {
  const target = relative ? path.join(home, relative) : home;
  if (relative && (path.isAbsolute(relative) || path.relative(home, target).startsWith('..'))) fail('UNSAFE_PATH', '目标路径超出受管理范围。');
  const parsed = path.parse(target);
  let current = parsed.root;
  for (const part of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const metadata = await statOrNull(current);
    if (metadata?.isSymbolicLink()) fail('UNSAFE_PATH', `不读写符号链接路径：${current}`);
    if (metadata && current !== target && !metadata.isDirectory()) fail('UNSAFE_PATH', `路径父级不是目录：${current}`);
  }
}
async function observe(home, relative, directory = false, ignoreLock = false) {
  await checkPath(home, relative);
  const target = relative ? path.join(home, relative) : home;
  const metadata = await statOrNull(target);
  if (!metadata) return { kind: 'missing', mode: null, bytes: null, entries: null };
  if (metadata.mode & 0o7000) fail('UNSAFE_PERMISSIONS', `路径含特殊权限位：${target}`);
  if (directory) {
    if (!metadata.isDirectory()) fail('UNSAFE_PATH', `目标不是普通目录：${target}`);
    const entries = (await fs.readdir(target, { withFileTypes: true })).filter(entry => !(relative === '' && entry.name === '.agent-fit-checks') && !(ignoreLock && relative === STATE_DIR && entry.name === 'install.lock')).map(entry => [entry.name, entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'special']).sort((a, b) => a[0].localeCompare(b[0]));
    return { kind: 'directory', mode: metadata.mode & 0o777, bytes: null, entries };
  }
  if (!metadata.isFile()) fail('UNSAFE_PATH', `目标不是普通文件：${target}`);
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.mode & 0o7000) fail('UNSAFE_PATH', `目标不是安全普通文件：${target}`);
    return { kind: 'file', mode: opened.mode & 0o777, bytes: await handle.readFile(), entries: null };
  } finally { await handle.close(); }
}
function stamp(observation) {
  return { kind: observation.kind, mode: observation.mode, sha256: observation.bytes === null ? null : hash(observation.bytes), entries: observation.entries };
}
function decode(bytes, code = 'CONFIG_INVALID', message = '配置无法解析；未输出原始内容。') {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail(code, message); }
}
function parseJson(bytes, code, message) {
  try {
    const text = decode(bytes, code, message), value = JSON.parse(text), stack = [];
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (char === '{' || char === '[') stack.push({ object: char === '{', key: char === '{', names: new Set() });
      else if (char === '}' || char === ']') stack.pop();
      else if (char === ',' && stack.at(-1)?.object) stack.at(-1).key = true;
      else if (char === '"') {
        const begin = index++;
        while (index < text.length && text[index] !== '"') { if (text[index] === '\\') index++; index++; }
        const current = stack.at(-1);
        if (current?.object && current.key) {
          const name = JSON.parse(text.slice(begin, index + 1));
          if (current.names.has(name)) fail(code, message);
          current.names.add(name); current.key = false;
        }
      }
    }
    return value;
  } catch (error) { if (error instanceof DelegationError) throw error; fail(code, message); }
}
function parseConfig(bytes, source) {
  if (bytes === null) return {};
  try { return parseToml(decode(bytes), { integersAsBigInt: 'asNeeded', unsafeKeyBehaviour: 'throw' }); } catch { fail('CONFIG_INVALID', `配置无法解析：${source}；未输出原始内容。`); }
}
function extractRules(bytes) {
  if (bytes === null) return null;
  const text = decode(bytes, 'RULES_INVALID', 'AGENTS.md 不是有效 UTF-8；未修改规则。');
  const matches = [...text.matchAll(/^<!-- agent-fit:start -->\n[\s\S]*?^<!-- agent-fit:end -->(?:\n|$)/gm)];
  if (text.split(START).length - 1 !== matches.length || text.split(END).length - 1 !== matches.length || matches.length > 1) fail('RULES_INVALID', 'AGENTS.md 的受管理标记不完整或重复。');
  if (!matches.length) return null;
  const match = matches[0];
  return { before: Buffer.from(text.slice(0, match.index)), block: Buffer.from(match[0]), after: Buffer.from(text.slice(match.index + match[0].length)) };
}
function normalizeName(name) {
  if (typeof name !== 'string') fail('INVALID_NAME', '档位名称必须是字符串。', 2);
  const normalized = name.trim().normalize('NFC');
  if (!normalized || [...normalized].length > 80 || /[\p{Cc}\p{Cf}]/u.test(normalized)) fail('INVALID_NAME', '档位名称须为 1–80 个字符，且不能包含控制字符。', 2);
  return normalized;
}
function validateCustom(bytes) {
  if (bytes === null) return [];
  const value = parseJson(bytes, 'CUSTOM_MODES_INVALID', '自定义档位记录无效。');
  if (!keys(value, ['schema_version', 'agent', 'modes']) || value.schema_version !== 1 || value.agent !== 'codex' || !Array.isArray(value.modes)) fail('CUSTOM_MODES_INVALID', '自定义档位记录无效。');
  const names = new Set(BUILTINS.flatMap(mode => [mode.id, mode.name]));
  return value.modes.map(mode => {
    if (!keys(mode, ['id', 'name', 'levels'], ['kind']) || typeof mode.id !== 'string' || !mode.id.startsWith('custom-') || !UUID.test(mode.id.slice(7)) || mode.kind !== undefined && mode.kind !== 'custom') fail('CUSTOM_MODES_INVALID', '自定义档位记录无效。');
    let name, levels;
    try { name = normalizeName(mode.name); levels = validateDefinition({ levels: mode.levels }); } catch { fail('CUSTOM_MODES_INVALID', '自定义档位定义无效。'); }
    if (name !== mode.name || name === mode.id || names.has(name) || names.has(mode.id)) fail('CUSTOM_MODES_INVALID', '自定义档位名称或内部 id 重复。');
    names.add(name); names.add(mode.id);
    return { id: mode.id, name, kind: 'custom', levels };
  });
}
function validateState(bytes) {
  if (bytes === null) return null;
  const state = parseJson(bytes, 'STATE_INVALID', '安装记录无效或格式不支持。');
  const fields = ['schema_version', 'agent', 'version', 'files', 'rules_sha256', 'mode', 'mode_kind', 'instance_id', 'file_modes', 'rules_mode', 'restoration'];
  if (state?.schema_version !== 2 || state.agent !== 'codex' || !keys(state, fields) || !object(state.files) || !SHA.test(state.rules_sha256)) fail('STATE_INVALID', '安装记录无效或格式不支持。');
  if (state.version !== VERSION) fail('VERSION_MISMATCH', '配置版本与当前工具不一致；仅支持当前配置版本。未修改任何文件。');
  for (const [relative, digest] of Object.entries(state.files)) if (!owned(relative) || !SHA.test(digest)) fail('STATE_INVALID', '安装记录含非法路径或摘要。');
  if (![...ROLE_PATHS, `${SKILL}/SKILL.md`, `${SKILL}/references/current-mode.json`].every(relative => Object.hasOwn(state.files, relative)) || typeof state.mode !== 'string' || !['builtin', 'custom'].includes(state.mode_kind) || !UUID.test(state.instance_id) || !object(state.file_modes) || !equal(Object.keys(state.files).sort(), Object.keys(state.file_modes).sort()) || !Object.values(state.file_modes).every(permission) || !permission(state.rules_mode)) fail('STATE_INVALID', '安装记录字段无效。');
  const restore = state.restoration;
  if (!keys(restore, ['status', 'baseline_sha256']) || restore.status !== 'available' || !SHA.test(restore.baseline_sha256)) fail('STATE_INVALID', '恢复状态字段无效。');
  return state;
}
function base64(value, code = 'RESTORE_METADATA_INVALID') {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail(code, '恢复记录字节编码无效。');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) fail(code, '恢复记录字节编码无效。');
  return bytes;
}
function validateBaseline(bytes, state) {
  if (bytes === null || hash(bytes) !== state.restoration.baseline_sha256) fail('RESTORE_METADATA_INVALID', '安装前恢复记录缺失或摘要不符。');
  const baseline = parseJson(bytes, 'RESTORE_METADATA_INVALID', '安装前恢复记录无法解析。');
  if (!keys(baseline, ['schema_version', 'agent', 'entries', 'rules', 'created_directories']) || baseline.schema_version !== 1 || baseline.agent !== 'codex' || !object(baseline.entries) || !Array.isArray(baseline.created_directories) || new Set(baseline.created_directories).size !== baseline.created_directories.length || !baseline.created_directories.every(ownedDirectory)) fail('RESTORE_METADATA_INVALID', '安装前恢复记录结构无效。');
  for (const [relative, entry] of Object.entries(baseline.entries)) {
    if (!owned(relative)) fail('RESTORE_METADATA_INVALID', '恢复记录路径不在白名单中。');
    if (entry !== null && (!keys(entry, ['bytes_base64', 'sha256', 'mode']) || !permission(entry.mode) || !SHA.test(entry.sha256) || hash(base64(entry.bytes_base64)) !== entry.sha256)) fail('RESTORE_METADATA_INVALID', '恢复记录条目无效。');
  }
  const expected = Object.keys(state.files).sort();
  if (!equal(Object.keys(baseline.entries).sort(), expected)) fail('RESTORE_METADATA_INVALID', '恢复记录与当前管理文件不对应。');
  const rules = baseline.rules;
  if (!keys(rules, ['existed', 'mode', 'sha256', 'original_block_base64', 'separator_base64', 'original_prefix_sha256']) || typeof rules.existed !== 'boolean' || (rules.existed ? !permission(rules.mode) || !SHA.test(rules.sha256) : rules.mode !== null || rules.sha256 !== null) || !SHA.test(rules.original_prefix_sha256)) fail('RESTORE_METADATA_INVALID', '恢复规则记录无效。');
  const separator = base64(rules.separator_base64);
  if (![0, 1, 2].includes(separator.length) || [...separator].some(value => value !== 10)) fail('RESTORE_METADATA_INVALID', '恢复规则分隔字节无效。');
  if (rules.original_block_base64 !== null) {
    const block = base64(rules.original_block_base64);
    const found = extractRules(block);
    if (!rules.existed || !found || found.before.length || found.after.length || separator.length) fail('RESTORE_METADATA_INVALID', '原管理区块记录无效。');
  }
  return baseline;
}
function diagnostic(code, status, source, message, remedy = ['status', '--details']) { return { code, status, source: safeSource(source), message: safeSource(message), remedy }; }

async function lockExists(home) {
  await checkPath(home, STATE_DIR);
  return (await statOrNull(path.join(home, LOCK))) !== null;
}
async function collect(home, { ignoreLock = false } = {}) {
  if (!ignoreLock && await lockExists(home)) fail('BUSY', '配置写入锁存在；请等待写入完成后重试。');
  const observedFiles = new Map(), observedDirectories = new Map();
  const file = async relative => { if (!observedFiles.has(relative)) observedFiles.set(relative, await observe(home, relative)); return observedFiles.get(relative); };
  const directory = async relative => { if (!observedDirectories.has(relative)) observedDirectories.set(relative, await observe(home, relative, true, ignoreLock)); return observedDirectories.get(relative); };
  await directory(''); await directory(STATE_DIR); await directory('agents'); await directory('skills');
  for (const relative of [STATE, BASELINE, CUSTOM, SCOPE_FILE, 'AGENTS.md', 'AGENTS.override.md', 'config.toml', ...ROLE_PATHS]) await file(relative);
  const state = validateState((await file(STATE)).bytes);
  const customModes = validateCustom((await file(CUSTOM)).bytes);
  let scopeStore;
  try { const bytes = (await file(SCOPE_FILE)).bytes; scopeStore = validateScopeStore(bytes === null ? null : parseJson(bytes, 'SCOPE_CONFIG_INVALID', '作用域配置无法解析。')); }
  catch { fail('SCOPE_CONFIG_INVALID', '作用域配置格式或版本无效；未回退到其他档位。'); }
  await file(`${SKILL}/references/current-mode.json`);
  let mode = null;
  if (state) {
    try { mode = resolveDefinition(state.mode, customModes); } catch { fail('STATE_INVALID', '活动档位引用无效。'); }
    if (mode.kind !== state.mode_kind) fail('STATE_INVALID', '活动档位类型记录无效。');
    const installedBytes = (await file(`${SKILL}/references/current-mode.json`)).bytes;
    if (installedBytes !== null) {
      const installed = parseJson(installedBytes, 'STATE_INVALID', '已部署档位说明无效。');
      if (!keys(installed, ['id', 'name', 'kind', 'levels', 'version', 'roles', 'fallback_conditions']) || installed.id !== state.mode || installed.kind !== state.mode_kind || safeText(installed.name) === null || [...installed.name].length > 80 || !Array.isArray(installed.fallback_conditions) || !installed.fallback_conditions.every(value => typeof value === 'string' && /^[A-Z_]+$/.test(value)) || !equal(installed.roles, ROLES)) fail('STATE_INVALID', '已部署档位说明无效。');
      if (installed.version !== VERSION) fail('STATE_INVALID', '已部署档位说明的版本与当前工具不一致。');
      let levels;
      try { levels = validateDefinition({ levels: installed.levels }); } catch { fail('STATE_INVALID', '已部署档位等级定义无效。'); }
      mode = { id: installed.id, name: installed.name, kind: installed.kind, levels, fallback_conditions: installed.fallback_conditions, definition_version: installed.version };
    }
  }
  const candidates = await renderPayload(home, mode ?? resolveDefinition('official'));
  const paths = new Set([...candidates.files.keys(), ...Object.keys(state?.files ?? {})]);
  for (const relative of paths) {
    if (!owned(relative)) fail('STATE_INVALID', '管理路径不在白名单中。');
    await file(relative);
    let parent = path.posix.dirname(relative);
    while (parent !== '.') { await directory(parent); parent = path.posix.dirname(parent); }
  }
  async function discoverRoles(relative) {
    for (const [name, kind] of (await directory(relative)).entries ?? []) {
      const candidate = `${relative}/${name}`;
      if (kind === 'directory') await discoverRoles(candidate);
      else if (kind === 'file' && name.endsWith('.toml')) await file(candidate);
    }
  }
  await discoverRoles('agents');
  const diagnostics = [];
  let baseline = null;
  if (!state && (await file(BASELINE)).bytes !== null) fail('RESTORE_METADATA_INVALID', '恢复记录存在但安装状态缺失；请人工核对残留配置。');
  if (!state && (await file(CUSTOM)).bytes !== null) fail('STATE_INVALID', '自定义档位记录存在但安装状态缺失。');
  if (!state && (await file(SCOPE_FILE)).bytes !== null) fail('STATE_INVALID', '作用域配置存在但安装状态缺失。');
  if (state) {
    if ((await file(STATE)).mode !== 0o600) diagnostics.push(diagnostic('STATE_PERMISSIONS_DRIFT', 'fail', path.join(home, STATE), '安装状态文件权限变化。'));
    for (const [relative, digest] of Object.entries(state.files)) {
      const actual = await file(relative);
      if (actual.bytes === null || hash(actual.bytes) !== digest || actual.mode !== state.file_modes[relative]) diagnostics.push(diagnostic('MANAGED_FILE_DRIFT', 'fail', path.join(home, relative), '受管理文件被修改、删除或权限变化。'));
    }
    const rules = extractRules((await file('AGENTS.md')).bytes);
    if (!rules || hash(rules.block) !== state.rules_sha256 || (await file('AGENTS.md')).mode !== state.rules_mode) diagnostics.push(diagnostic('MANAGED_RULES_DRIFT', 'fail', path.join(home, 'AGENTS.md'), '受管理区块被修改、移除或权限变化。'));
    if ((await file(BASELINE)).mode !== 0o600) fail('RESTORE_METADATA_INVALID', '安装前恢复记录权限变化。');
    baseline = validateBaseline((await file(BASELINE)).bytes, state);
    if ((await file(CUSTOM)).bytes !== null && !Object.hasOwn(state.files, CUSTOM)) fail('STATE_INVALID', '自定义档位记录未登记所有权。');
    if ((await file(SCOPE_FILE)).bytes !== null && !Object.hasOwn(state.files, SCOPE_FILE)) fail('STATE_INVALID', '作用域配置未登记所有权。');
  }
  let config = {};
  try {
    config = parseConfig((await file('config.toml')).bytes, path.join(home, 'config.toml'));
    if (config.agents !== undefined && !object(config.agents)) fail('CONFIG_INVALID', 'config.toml 的 agents 字段不是配置表。');
  } catch { diagnostics.push(diagnostic('CONFIG_INVALID', 'fail', path.join(home, 'config.toml'), '既有配置无法解析或 agents 字段不是配置表。')); config = {}; }
  const externalRoles = [];
  for (const [relative, observation] of observedFiles) if (relative.startsWith('agents/') && relative.endsWith('.toml') && observation.bytes !== null) {
    let role;
    try { role = parseConfig(observation.bytes, path.join(home, relative)); } catch { diagnostics.push(diagnostic('ROLE_CONFIG_INVALID', 'fail', path.join(home, relative), '角色配置无法解析。')); continue; }
    if (Object.hasOwn(ROLES, role.name) && !ROLE_PATHS.includes(relative)) diagnostics.push(diagnostic('ROLE_NAME_CONFLICT', 'fail', path.join(home, relative), '另一文件定义了本库同名角色。'));
    if (!ROLE_PATHS.includes(relative)) externalRoles.push({ name: safeText(role.name), model: safeText(role.model), effort: safeText(role.model_reasoning_effort), source: safeSource(path.join(home, relative)) });
  }
  for (const name of Object.keys(ROLES)) if (Object.hasOwn(config.agents ?? {}, name)) {
    const registration = config.agents[name];
    let configured = object(registration) && safeText(registration.config_file, 4096);
    if (configured?.startsWith('~/')) configured = path.join(os.homedir(), configured.slice(2));
    if (!configured || resolveHome(path.resolve(home, configured)) !== path.join(home, `agents/${name.replaceAll('_', '-')}.toml`)) diagnostics.push(diagnostic('ROLE_NAME_CONFLICT', 'fail', path.join(home, 'config.toml'), `既有注册指向不同角色配置：${name}。`));
  }
  const roles = Object.entries(ROLES).map(([name, level]) => {
    const relative = `agents/${name.replaceAll('_', '-')}.toml`, source = path.join(home, relative);
    const bytes = observedFiles.get(relative).bytes;
    let role = null;
    try { if (bytes !== null) role = parseConfig(bytes, source); } catch {}
    const expected = level && mode?.levels[level];
    const matches = mode ? role !== null && role.name === name && (expected ? role.model === expected.model && role.model_reasoning_effort === expected.effort : !Object.hasOwn(role, 'model') && !Object.hasOwn(role, 'model_reasoning_effort')) : null;
    if (state && !matches) diagnostics.push(diagnostic('ROLE_CONTRACT_MISMATCH', 'fail', source, `角色 ${name} 的名称、模型或推理强度与当前档位职责不一致；缺失或无效文件也不能满足职责。`));
    return { name, task_level: level, source, managed: !!state?.files[relative], configured_name: safeText(role?.name), configured_model: safeText(role?.model), configured_effort: safeText(role?.model_reasoning_effort), expected_model: expected?.model ?? null, expected_effort: expected?.effort ?? null, matches_mode: matches, availability: { status: 'unknown', source: null }, fallback_candidates: expected?.fallback ? [expected.fallback] : [] };
  });
  const override = (await file('AGENTS.override.md')).bytes;
  if (override && /[^\p{White_Space}]/u.test(override.toString('utf8'))) diagnostics.push(diagnostic('RULES_SHADOWED', 'warn', path.join(home, 'AGENTS.override.md'), '非空 AGENTS.override.md 遮蔽本库 AGENTS.md。'));
  diagnostics.push(diagnostic('MODEL_ACCESS_UNKNOWN', 'unknown', 'static_configuration', '静态配置不证明账号调用权限。', ['models', 'check']));
  diagnostics.push(diagnostic('RULES_LOAD_UNVERIFIED', 'unknown', 'static_configuration', '规则读取与运行模型生效需要宿主证据。'));
  const snapshot = { home, state, mode, customModes, scopeStore, baseline, observedFiles, observedDirectories, diagnostics, config, externalRoles, roles, payload: candidates };
  snapshot.configuration_revision = revision(snapshot);
  return snapshot;
}
function revision(snapshot) {
  return hash(json({ instance: snapshot.state?.instance_id ?? 'not_installed', files: [...snapshot.observedFiles].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => [name, stamp(value)]), directories: [...snapshot.observedDirectories].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => [name, stamp(value)]) }));
}
async function stillObserved(snapshot, ignoreLock = false) {
  if (!ignoreLock && await lockExists(snapshot.home)) return false;
  for (const [relative, original] of snapshot.observedFiles) if (!equal(stamp(original), stamp(await observe(snapshot.home, relative)))) return false;
  for (const [relative, original] of snapshot.observedDirectories) if (!equal(stamp(original), stamp(await observe(snapshot.home, relative, true, ignoreLock)))) return false;
  return true;
}
export async function readSnapshot(home, options = {}) {
  home = resolveHome(home);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const snapshot = await collect(home, options);
      await testHooks.afterSnapshotRead?.(snapshot, attempt);
      if (await stillObserved(snapshot, options.ignoreLock)) return snapshot;
    }
    fail('BUSY', '配置读取期间持续变化；请刷新后重试。');
  } catch (error) {
    if (error instanceof DelegationError) throw error;
    fail('READ_FAILED', '无法安全读取配置；请检查路径、权限或文件格式。');
  }
}
function requireClean(snapshot, restore = false) {
  const failures = snapshot.diagnostics.filter(value => value.status === 'fail' && (!restore || ['MANAGED_FILE_DRIFT', 'MANAGED_RULES_DRIFT', 'STATE_PERMISSIONS_DRIFT'].includes(value.code)));
  if (failures.length) fail(restore ? 'RESTORE_CONFLICT' : failures[0].code, restore ? '受管理内容存在冲突，未恢复任何文件。' : '受管理内容存在冲突，未覆盖任何文件。', 1, { paths: failures.map(value => value.source) });
}
function requireRevision(snapshot, expected) {
  if (expected !== undefined && expected !== snapshot.configuration_revision) fail('CONFIG_CHANGED', '配置已改变；请刷新后重新检查草稿。');
}
function restart(reason, restore = false, restartRequired = false) {
  const messages = {
    deployment_changed: restore ? '原配置已恢复，请重启 Codex 后使用原委派规则。' : '配置已写入，请重启 Codex 后使用新委派规则。',
    definition_only: '档位定义已保存，尚未应用。', no_change: '无配置变化，无需重启 Codex。',
    routing_changed: '档位配置已更新，无需重启 Codex；后续新任务读取新配置，全局角色在下一轮加载，已开始任务沿用原配置。',
    preview: restartRequired ? restore ? '恢复预览未写入；实际恢复成功后请重启 Codex。' : '首次安装或基础规则更新的预览未写入；应用成功后请重启 Codex。' : '预览未写入；本次档位调整无需重启 Codex。',
    not_applied: '配置未应用。', rolled_back: '配置未应用，已回退。', partial_or_unknown: '请核对残留配置并刷新状态；确认配置后重启 Codex。',
  };
  return { required: reason === 'deployment_changed' ? true : reason === 'partial_or_unknown' ? null : false, reason, message: messages[reason] };
}
function changeReport(plan, result, configurationStatus, after = null, reason) {
  return { action: plan.action, agent: 'codex', home: plan.snapshot.home, scope: plan.scope ?? 'global', result, configuration_status: configurationStatus, changed_files: [...plan.changes.keys()], changes: [...plan.changes].map(([relative, change]) => ({ path: relative, action: change.after === null ? 'remove' : change.before.bytes === null ? 'create' : 'replace', permission_changed: change.after !== null && change.before.mode !== change.mode })), revision_before: plan.snapshot.configuration_revision, revision_after: after, mode: plan.mode ? { id: plan.mode.id, name: plan.mode.name, kind: plan.mode.kind } : null, custom_modes_removed: plan.action === 'restore' ? [...plan.snapshot.customModes, ...plan.snapshot.scopeStore.projects.flatMap(entry => entry.modes), ...plan.snapshot.scopeStore.sessions.flatMap(entry => entry.modes)].map(mode => mode.name) : [], warnings: plan.warnings ?? [], restart: restart(reason, plan.action === 'restore', plan.restartRequired), runtime_verification: 'unverified' };
}
async function directoryCreation(snapshot, relatives) {
  const directories = new Set();
  for (const relative of relatives) {
    let parent = path.posix.dirname(relative);
    while (parent !== '.') { directories.add(parent); parent = path.posix.dirname(parent); }
  }
  const missing = [];
  for (const relative of [...directories].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))) if ((snapshot.observedDirectories.get(relative) ?? await observe(snapshot.home, relative, true)).kind === 'missing') missing.push(relative);
  return missing;
}
function managedEntry(observation) {
  return observation.bytes === null ? null : { bytes_base64: observation.bytes.toString('base64'), sha256: hash(observation.bytes), mode: observation.mode };
}
function mergeRules(original, block, state) {
  const found = extractRules(original);
  if (found) {
    const expected = state?.rules_sha256 ?? hash(block);
    if (hash(found.block) !== expected) fail('MANAGED_RULES_DRIFT', '既有受管理区块与记录不符。');
    return { bytes: Buffer.concat([found.before, block, found.after]), separator: Buffer.alloc(0), found };
  }
  if (state) fail('MANAGED_RULES_DRIFT', '受管理规则区块已移除。');
  let separator = '';
  const text = original === null ? '' : decode(original);
  if (text && !text.endsWith('\n')) separator += '\n';
  if (text && !(text + separator).endsWith('\n\n')) separator += '\n';
  return { bytes: Buffer.concat([original ?? Buffer.alloc(0), Buffer.from(separator), block]), separator: Buffer.from(separator), found: null };
}
function configuredLevels(definition, options) {
  let levels;
  if (options.definition !== undefined) {
    if (['level', 'model', 'effort', 'fallbackModel', 'fallbackEffort', 'clearFallback'].some(key => options[key] !== undefined)) fail('INVALID_ARGUMENTS', '整表定义与单级配置参数不能混用。', 2);
    if (json(options.definition).length > 65536) fail('DEFINITION_TOO_LARGE', '档位定义超过 64KiB。', 2);
    levels = validateDefinition(options.definition);
  } else {
    if (!LEVELS.includes(options.level)) fail('INVALID_LEVEL', '请选择 L1–L4 中的一个任务等级。', 2);
    if ((options.model === undefined) !== (options.effort === undefined) || (options.fallbackModel === undefined) !== (options.fallbackEffort === undefined) || options.clearFallback && options.fallbackModel !== undefined) fail('INVALID_ARGUMENTS', '主模型、备用模型与 effort 必须成对指定。', 2);
    levels = structuredClone(definition.levels);
    const current = levels[options.level];
    const primaryChanged = options.model !== undefined && (options.model !== current.model || options.effort !== current.effort);
    levels[options.level] = { ...current, model: options.model ?? current.model, effort: options.effort ?? current.effort, fallback: options.fallbackModel !== undefined ? { model: options.fallbackModel, effort: options.fallbackEffort } : options.clearFallback || primaryChanged ? null : current.fallback };
    levels = validateDefinition({ levels });
  }
  return levels;
}
async function buildPlan(snapshot, action, options) {
  requireRevision(snapshot, options.expectRevision);
  requireClean(snapshot, action === 'restore');
  const { state, home } = snapshot;
  if (action !== 'setup' && action !== 'restore' && !state) fail('NOT_INSTALLED', '请先执行 setup 配置 Codex。');
  if (!['setup', 'set', 'clear', 'delete', 'create', 'configure', 'restore'].includes(action)) fail('INVALID_ACTION', '不支持的写入动作。', 2);
  const changes = new Map();
  const plan = { snapshot, action, changes, mode: snapshot.mode, warnings: [], deploymentChanged: false, restartRequired: false, cleanupDirectories: [] };
  const add = async (relative, after, mode) => {
    const before = snapshot.observedFiles.get(relative) ?? await observe(home, relative);
    const afterMode = after === null ? null : mode ?? before.mode ?? 0o600;
    if (before.bytes?.equals(after ?? Buffer.alloc(0)) && after !== null && before.mode === afterMode || before.bytes === null && after === null) return;
    changes.set(relative, { before, after, mode: afterMode });
  };
  if (action === 'restore') {
    plan.mode = null;
    if (!state) return plan;
    for (const [relative, entry] of Object.entries(snapshot.baseline.entries)) await add(relative, entry === null ? null : base64(entry.bytes_base64), entry?.mode);
    const current = snapshot.observedFiles.get('AGENTS.md');
    const found = extractRules(current.bytes);
    const rules = snapshot.baseline.rules;
    let restored;
    if (rules.original_block_base64 !== null) restored = Buffer.concat([found.before, base64(rules.original_block_base64), found.after]);
    else {
      const separator = base64(rules.separator_base64);
      let before = found.before;
      const prefix = separator.length && before.subarray(-separator.length).equals(separator) ? before.subarray(0, -separator.length) : before;
      const outside = Buffer.concat([prefix, found.after]);
      if (hash(prefix) === rules.original_prefix_sha256 && (rules.existed ? hash(outside) === rules.sha256 : outside.length === 0)) before = prefix;
      else if (separator.length) plan.warnings.push('标记外正文已改变，保留无法确认归属的分隔空白。');
      restored = Buffer.concat([before, found.after]);
    }
    await add('AGENTS.md', !rules.existed && !restored.length ? null : restored, rules.existed ? rules.mode : current.mode);
    await add(BASELINE, null); await add(STATE, null);
    plan.cleanupDirectories = snapshot.baseline.created_directories;
    plan.createdDirectories = await directoryCreation(snapshot, [...changes].filter(([, change]) => change.after !== null).map(([relative]) => relative));
    plan.deploymentChanged = changes.size > 0;
    plan.restartRequired = plan.deploymentChanged;
    return plan;
  }
  const context = await scopeContext(options);
  if (action === 'setup' && context.scope !== 'global') fail('INVALID_ARGUMENT', 'setup 只安装全局基础设施；局部选择请使用 mode set。', 2);
  plan.scope = context.scope;
  const scopeStore = structuredClone(snapshot.scopeStore);
  const local = context.scope !== 'global';
  if (local) {
    if (action === 'clear' && !scopeEntry(scopeStore, context)) { plan.mode = scopedSelection(snapshot, context).definition; return plan; }
    const entry = scopeEntry(scopeStore, context, true);
    const available = visibleModes(snapshot, context);
    if (action === 'set') entry.selection = resolveDefinition(options.mode, available).id;
    if (action === 'clear') entry.selection = null;
    if (action === 'create') {
      const name = normalizeName(options.name);
      if ([...BUILTINS, ...available].some(mode => [mode.name, mode.id].includes(name))) fail('NAME_CONFLICT', '可见档位中已有此名称或 ID。', 2);
      const source = scopedSelection(snapshot, context, options.from ?? 'official').definition;
      const definition = { id: `custom-${randomUUID()}`, name, kind: 'custom', levels: structuredClone(source.levels) };
      entry.modes.push(definition); plan.created_mode = definition;
    }
    if (action === 'configure') {
      const source = resolveDefinition(options.mode, available);
      if (source.kind !== 'custom') fail('BUILTIN_READ_ONLY', '内置档位不可修改；请先复制为自定义档位。', 2);
      const levels = configuredLevels(source, options);
      let definition = entry.modes.find(mode => mode.id === source.id);
      if (!definition) {
        let name = [...source.name].slice(0, 60).join('') + '（局部副本）';
        for (let number = 2; [...BUILTINS, ...available].some(mode => mode.name === name); number++) name = [...source.name].slice(0, 55).join('') + `（局部副本 ${number}）`;
        definition = { id: `custom-${randomUUID()}`, name, kind: 'custom', levels };
        entry.modes.push(definition); plan.created_mode = definition;
        if (scopedSelection(snapshot, context).definition.id === source.id) entry.selection = definition.id;
      } else definition.levels = levels;
    }
    if (action === 'delete') {
      const definition = resolveDefinition(options.mode, available);
      if (!entry.modes.some(mode => mode.id === definition.id)) fail('SCOPE_READ_ONLY', '只能删除当前作用域创建的自定义档位。', 2);
      assertUnreferenced(snapshot, definition.id);
      entry.modes = entry.modes.filter(mode => mode.id !== definition.id);
    }
    validateScopeStore(scopeStore);
    plan.mode = scopedSelection({ ...snapshot, scopeStore }, context).definition;
  }
  let customModes = snapshot.customModes.map(mode => ({ ...mode, levels: structuredClone(mode.levels) }));
  let desiredMode = snapshot.mode ? resolveDefinition(snapshot.mode.id, customModes) : resolveDefinition('official', customModes);
  if (!local && (action === 'setup' && options.mode !== undefined || action === 'set')) desiredMode = resolveDefinition(options.mode, customModes);
  if (!local && action === 'clear') desiredMode = resolveDefinition('official');
  if (!local && action === 'delete') {
    const definition = resolveDefinition(options.mode, customModes);
    if (definition.kind !== 'custom') fail('BUILTIN_READ_ONLY', '内置档位不可删除。', 2);
    assertUnreferenced(snapshot, definition.id);
    customModes = customModes.filter(mode => mode.id !== definition.id);
  }
  if (!local && action === 'create') {
    const name = normalizeName(options.name);
    if ([...BUILTINS, ...customModes].some(mode => [mode.name, mode.id].includes(name))) fail('NAME_CONFLICT', '档位名称与内置命令、既有档位或内部 id 重复。', 2);
    const source = scopedSelection(snapshot, context, options.from ?? 'official').definition;
    const definition = { id: `custom-${randomUUID()}`, name, kind: 'custom', levels: structuredClone(source.levels) };
    customModes.push(definition); plan.created_mode = definition;
  }
  if (!local && action === 'configure') {
    const definition = resolveDefinition(options.mode, customModes);
    if (definition.kind !== 'custom') fail('BUILTIN_READ_ONLY', '内置档位不可修改；请先复制为自定义档位。', 2);
    const levels = configuredLevels(definition, options);
    customModes = customModes.map(mode => mode.id === definition.id ? { ...mode, levels } : mode);
    if (desiredMode.id === definition.id) desiredMode = resolveDefinition(definition.id, customModes);
  }
  const deploying = !local && (action === 'setup' || action === 'set' || action === 'clear' || action === 'configure' && desiredMode.id === resolveDefinition(options.mode, customModes).id);
  if (deploying && snapshot.diagnostics.some(value => value.code === 'RULES_SHADOWED')) fail('RULES_SHADOWED', '非空 AGENTS.override.md 遮蔽本库规则；未写入部署配置。');
  const payload = deploying ? await renderPayload(home, desiredMode) : snapshot.payload;
  const files = new Map(payload.files);
  if (!deploying) {
    files.clear();
    for (const relative of Object.keys(state.files)) files.set(relative, snapshot.observedFiles.get(relative).bytes);
  }
  if (customModes.length || snapshot.observedFiles.get(CUSTOM).bytes !== null) files.set(CUSTOM, json({ schema_version: 1, agent: 'codex', modes: customModes.map(({ id, name, levels }) => ({ id, name, levels })) }));
  if (local || snapshot.observedFiles.get(SCOPE_FILE).bytes !== null) files.set(SCOPE_FILE, json(scopeStore));
  const previous = state?.files ?? {};
  for (const relative of [...new Set([...files.keys(), ...Object.keys(previous)])].sort()) {
    if (!owned(relative)) fail('UNSAFE_PATH', '发布包含非法管理路径。');
    const before = snapshot.observedFiles.get(relative) ?? await observe(home, relative);
    const desired = files.get(relative) ?? null;
    if (before.bytes !== null && !Object.hasOwn(previous, relative) && (!desired || !before.bytes.equals(desired))) fail('FILE_CONFLICT', `文件已有不同内容，未覆盖：${path.join(home, relative)}`);
    await add(relative, desired);
  }
  const originalRules = snapshot.observedFiles.get('AGENTS.md');
  const merged = deploying ? mergeRules(originalRules.bytes, payload.block, state) : { bytes: originalRules.bytes };
  if (deploying) await add('AGENTS.md', merged.bytes);
  const directories = await directoryCreation(snapshot, [...files.keys(), STATE, BASELINE, 'AGENTS.md']);
  let baseline = snapshot.baseline ? structuredClone(snapshot.baseline) : null;
  if (!state) {
    baseline = { schema_version: 1, agent: 'codex', entries: {}, rules: { existed: originalRules.bytes !== null, mode: originalRules.mode, sha256: originalRules.bytes === null ? null : hash(originalRules.bytes), original_block_base64: merged.found?.block.toString('base64') ?? null, separator_base64: merged.separator.toString('base64'), original_prefix_sha256: hash(merged.found?.before ?? originalRules.bytes ?? Buffer.alloc(0)) }, created_directories: directories };
  }
  for (const relative of files.keys()) if (!Object.hasOwn(baseline.entries, relative)) baseline.entries[relative] = managedEntry(snapshot.observedFiles.get(relative) ?? await observe(home, relative));
  baseline.created_directories = [...new Set([...baseline.created_directories, ...directories])];
  await add(BASELINE, json(baseline), 0o600);
  const stateBytes = json({ schema_version: 2, agent: 'codex', version: VERSION, mode: desiredMode.id, mode_kind: desiredMode.kind, instance_id: state?.instance_id ?? randomUUID(), files: Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)).map(([relative, bytes]) => [relative, hash(bytes)])), file_modes: Object.fromEntries([...files.keys()].sort().map(relative => [relative, changes.get(relative)?.mode ?? snapshot.observedFiles.get(relative)?.mode ?? 0o600])), rules_mode: changes.get('AGENTS.md')?.mode ?? originalRules.mode ?? 0o600, rules_sha256: deploying ? hash(payload.block) : state.rules_sha256, restoration: { status: 'available', baseline_sha256: hash(json(baseline)) } });
  await add(STATE, stateBytes, 0o600);
  const ordered = new Map();
  if (changes.has(BASELINE)) ordered.set(BASELINE, changes.get(BASELINE));
  for (const [relative, change] of changes) if (![BASELINE, STATE].includes(relative)) ordered.set(relative, change);
  if (changes.has(STATE)) ordered.set(STATE, changes.get(STATE));
  plan.changes = ordered; if (!local) plan.mode = desiredMode;
  plan.deploymentChanged = [...ordered.keys()].some(relative => ![BASELINE, STATE, CUSTOM, SCOPE_FILE].includes(relative));
  // Compare against today's templates rendered with the old mode, so model/effort changes alone do not require a restart.
  plan.restartRequired = !state || deploying && [...ordered].some(([relative, change]) => {
    if ([BASELINE, STATE, CUSTOM, SCOPE_FILE, `${SKILL}/references/current-mode.json`].includes(relative)) return false;
    const expected = snapshot.payload.files.get(relative);
    return !expected || !change.before.bytes?.equals(expected);
  });
  plan.createdDirectories = directories;

  return plan;
}

async function atomicWrite(home, relative, bytes, mode, expected) {
  await checkPath(home, relative);
  const target = path.join(home, relative);
  if (bytes === null) {
    await testHooks.beforeAtomicCommit?.(relative, bytes);
    if (expected && !equal(stamp(await observe(home, relative)), stamp(expected))) fail('CONFIG_CHANGED', `删除前文件发生变化：${safeSource(target)}`);
    await fs.unlink(target); return;
  }
  await checkPath(home, relative);
  const temporary = path.join(path.dirname(target), `.agent-fit-${randomUUID()}.tmp`);
  let handle, committed = false;
  try {
    handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode);
    await handle.writeFile(bytes); await handle.chmod(mode); await handle.sync(); await handle.close(); handle = null;
    await testHooks.beforeAtomicCommit?.(relative, bytes);
    await checkPath(home, relative);
    if (expected && !equal(stamp(await observe(home, relative)), stamp(expected))) fail('CONFIG_CHANGED', `原子替换前文件发生变化：${safeSource(target)}`);
    await fs.rename(temporary, target); committed = true;
    try { const directory = await fs.open(path.dirname(target), constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); } } catch (error) { if (!['EINVAL', 'EISDIR', 'EPERM', 'ENOTSUP'].includes(error.code)) throw error; }
  } catch (error) { error.atomicApplied = committed; throw error; } finally { await handle?.close(); await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function cleanDirectories(home, directories) {
  for (const relative of [...new Set(directories)].sort((a, b) => b.split('/').length - a.split('/').length || b.localeCompare(a))) {
    if (!ownedDirectory(relative)) continue;
    try { await checkPath(home, relative); await fs.rmdir(path.join(home, relative)); } catch (error) { if (!(error instanceof DelegationError) && !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
  }
}
function normalizedLocked(snapshot, original, created) {
  const normalize = new Map(snapshot.observedDirectories);
  for (const [relative, value] of normalize) {
    if (created.includes(relative) && original.observedDirectories.get(relative)?.kind === 'missing') normalize.set(relative, { kind: 'missing', mode: null, bytes: null, entries: null });
    else if (value.entries) normalize.set(relative, { ...value, entries: value.entries.filter(([name]) => !created.includes(relative ? `${relative}/${name}` : name)) });
  }
  const files = snapshot.observedFiles;
  for (const [relative, value] of original.observedFiles) if (!equal(stamp(value), stamp(files.get(relative) ?? { kind: 'missing', mode: null, bytes: null, entries: null }))) return false;
  for (const [relative, value] of original.observedDirectories) if (!equal(stamp(value), stamp(normalize.get(relative) ?? { kind: 'missing', mode: null, bytes: null, entries: null }))) return false;
  return true;
}
export async function applyPlan(plan, options = {}) {
  if (options.dryRun) {
    await testHooks.beforePreview?.(plan);
    if (!await stillObserved(plan.snapshot)) fail('CONFIG_CHANGED', '预览前配置已改变；请刷新后重试。');
    requireRevision(plan.snapshot, options.expectRevision);
    const report = changeReport(plan, 'preview', 'not_written', null, 'preview');
    if (plan.created_mode) report.created_mode = { id: plan.created_mode.id, name: plan.created_mode.name, kind: plan.created_mode.kind };
    return report;
  }
  if (!plan.changes.size) {
    if (!await stillObserved(plan.snapshot)) fail('CONFIG_CHANGED', '配置已改变；请刷新后重试。');
    return changeReport(plan, 'unchanged', 'unchanged', plan.snapshot.configuration_revision, 'no_change');
  }
  await testHooks.beforeLock?.(plan);
  const home = plan.snapshot.home;
  const ownCreated = [];
  let lockHandle, lockIdentity, ownsLock = false, canceled = false;
  const applied = [];
  const onSignal = () => { canceled = true; };
  let report, pending;
  const ownLock = async () => {
    const actual = await statOrNull(path.join(home, LOCK));
    return actual?.isFile() && actual.dev === lockIdentity?.dev && actual.ino === lockIdentity?.ino;
  };
  try {
  try {
    for (const relative of ['', STATE_DIR]) {
      await checkPath(home, relative);
      if ((await statOrNull(relative ? path.join(home, relative) : home)) === null) {
        await fs.mkdir(relative ? path.join(home, relative) : home, { recursive: relative === '', mode: 0o700 }); ownCreated.push(relative);
      }
    }
    await checkPath(home, LOCK);
    try { lockHandle = await fs.open(path.join(home, LOCK), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); ownsLock = true; } catch (error) { if (error.code === 'EEXIST') fail('BUSY', '配置写入锁存在；未写入配置。'); throw error; }
    lockIdentity = await lockHandle.stat(); await lockHandle.close(); lockHandle = null;
    process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
    await testHooks.afterLock?.(plan);
    const locked = await readSnapshot(home, { ignoreLock: true });
    if (!normalizedLocked(locked, plan.snapshot, ownCreated)) fail('CONFIG_CHANGED', '锁内检测到配置或角色目录变化；未写入配置。');
    requireRevision(plan.snapshot, options.expectRevision);
    requireClean(locked, plan.action === 'restore');
    for (const relative of plan.createdDirectories ?? []) {
      if (ownCreated.includes(relative)) continue;
      await checkPath(home, relative);
      try { await fs.mkdir(path.join(home, relative), { mode: 0o700 }); ownCreated.push(relative); } catch (error) { if (error.code === 'EEXIST') fail('CONFIG_CHANGED', '目录在写入前出现；未覆盖配置。'); throw error; }
    }
    for (const [relative, change] of plan.changes) {
      if (canceled) fail('CANCELED', '操作已取消；已写入内容将安全回退。');
      await testHooks.beforeWrite?.(relative, change, applied.length);
      if (!await ownLock()) fail('BUSY', '安装锁在写入期间被移除或替换，停止配置。');
      if (canceled) fail('CANCELED', '操作已取消；已写入内容将安全回退。');
      const current = await observe(home, relative);
      if (!equal(stamp(current), stamp(change.before))) fail('CONFIG_CHANGED', `写入前文件发生变化：${path.join(home, relative)}`);
      try { await atomicWrite(home, relative, change.after, change.mode, change.before); applied.push(relative); } catch (error) { if (error.atomicApplied) applied.push(relative); throw error; }
      await testHooks.afterWrite?.(relative, change, applied.length);
    }
    if (!await ownLock()) fail('BUSY', '安装锁在写入期间被移除或替换，停止配置。');
    for (const relative of applied) {
      const change = plan.changes.get(relative);
      const desired = { kind: change.after === null ? 'missing' : 'file', mode: change.mode, bytes: change.after, entries: null };
      if (!equal(stamp(await observe(home, relative)), stamp(desired))) fail('CONFIG_CHANGED', `提交核对发现并发修改：${safeSource(path.join(home, relative))}`);
    }
    const after = await readSnapshot(home, { ignoreLock: true });
    requireClean(after, plan.action === 'restore');
    report = changeReport(plan, 'applied', 'written', after.configuration_revision, plan.restartRequired ? 'deployment_changed' : plan.deploymentChanged || plan.scope && plan.scope !== 'global' ? 'routing_changed' : 'definition_only');
    if (plan.created_mode) report.created_mode = { id: plan.created_mode.id, name: plan.created_mode.name, kind: plan.created_mode.kind };
  } catch (error) {
    const failures = [];
    for (const relative of [...applied].reverse()) {
      const change = plan.changes.get(relative);
      try {
        const current = await observe(home, relative);
        const desired = { kind: change.after === null ? 'missing' : 'file', mode: change.mode, bytes: change.after, entries: null };
        if (!equal(stamp(current), stamp(desired))) { failures.push(path.join(home, relative)); continue; }
        await testHooks.beforeRollback?.(relative, change);
        await atomicWrite(home, relative, change.before.bytes, change.before.mode, desired);
      } catch { failures.push(path.join(home, relative)); }
    }
    const status = failures.length ? 'partial' : applied.length ? 'rolled_back' : 'not_written';
    const reason = failures.length ? 'partial_or_unknown' : applied.length ? 'rolled_back' : 'not_applied';
    report = changeReport(plan, 'failed', status, null, reason);
    report.rollback_failures = failures;
    pending = error instanceof DelegationError ? error : new DelegationError('WRITE_FAILED', '配置写入失败；已尝试回退安全文件。');
    pending.details = { ...pending.details, report };
  } finally {
    await lockHandle?.close();
    if (ownsLock) await (async () => { await testHooks.beforeUnlock?.(plan); if (await statOrNull(path.join(home, LOCK))) { if (!await ownLock()) fail('LOCK_RELEASE_FAILED', '安装锁已被替换，保留新锁供人工核对。'); await fs.unlink(path.join(home, LOCK)); } })().catch(error => { if (error.code !== 'ENOENT') {
      if (report) report.warnings.push('配置操作已结束，但锁无法释放；请核对状态与锁文件。');
      pending ??= new DelegationError('LOCK_RELEASE_FAILED', '配置操作已结束，但锁无法释放；请核对状态。', 1, { report });
    } });
  }
  if (pending) {
    await cleanDirectories(home, ownCreated.filter(Boolean)).catch(() => {});
    if (ownCreated.includes('')) await fs.rmdir(home).catch(() => {});
    try { if (pending.details.report && pending.details.report.result !== 'applied') pending.details.report.revision_after = (await readSnapshot(home)).configuration_revision; } catch {}
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    throw pending;
  }
  if (plan.action === 'restore') {
    try { await testHooks.beforeCleanup?.(plan); await cleanDirectories(home, plan.cleanupDirectories); } catch { report.warnings.push('受管理内容已恢复，部分空目录无法清理。'); }
    try { report.revision_after = (await readSnapshot(home)).configuration_revision; } catch { report.revision_after = null; report.warnings.push('原配置已恢复，但完成后的配置观察不可用；请刷新状态。'); }
  }
  process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
  return report;
  } finally { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); }
}
export async function mutate(home, action, options = {}) {
  let plan;
  try {
    const snapshot = await readSnapshot(home);
    plan = await buildPlan(snapshot, action, options);
    return await applyPlan(plan, options);
  } catch (error) {
    if (!(error instanceof DelegationError)) error = error.exitCode === 2 ? new DelegationError(error.code ?? 'INVALID_ARGUMENT', error.message, 2) : new DelegationError('WRITE_FAILED', '无法安全完成配置操作；未输出原始配置。');
    if (!error.details.report && plan) error.details.report = changeReport(plan, 'failed', 'not_written', null, 'not_applied');
    throw error;
  }
}
export async function planSetup(home, options = {}) { return buildPlan(await readSnapshot(home), 'setup', options); }
export async function planModeSwitch(home, options = {}) { return buildPlan(await readSnapshot(home), 'set', options); }
export async function planModeDefinition(home, action, options = {}) { return buildPlan(await readSnapshot(home), action, options); }
export async function planRestore(home, options = {}) { return buildPlan(await readSnapshot(home), 'restore', options); }

export async function statusReport(home, options = {}) {
  const snapshot = await readSnapshot(home, options);
  const { state } = snapshot;
  const effective = scopedSelection(snapshot, await scopeContext(options));
  const mode = state ? effective.definition : null;
  const registeredRoles = [], profileCandidates = [], skippedPaths = [];
  for (const [name, registration] of Object.entries(snapshot.config.agents ?? {})) if (object(registration) && safeText(name, 80) !== null) {
    const configFile = safeText(registration.config_file, 4096);
    let relative = null;
    if (configFile) {
      const configured = configFile.startsWith('~/') ? path.join(os.homedir(), configFile.slice(2)) : path.resolve(snapshot.home, configFile);
      const candidate = path.relative(snapshot.home, configured);
      if (candidate && !candidate.startsWith(`..${path.sep}`) && candidate !== '..' && !path.isAbsolute(candidate)) relative = candidate.split(path.sep).join('/');
    }
    const inspected = relative !== null && snapshot.observedFiles.get(relative)?.kind === 'file';
    const reason = inspected ? null : relative === null ? 'outside_bound_home_or_not_inspected' : 'not_inspected';
    registeredRoles.push({ name, config_file: configFile, source: path.join(snapshot.home, 'config.toml'), inspected, reason });
    if (!inspected) skippedPaths.push({ path: configFile, source: path.join(snapshot.home, 'config.toml'), reason });
  }
  for (const [name, profile] of Object.entries(snapshot.config.profiles ?? {})) if (object(profile) && safeText(name, 80) !== null) profileCandidates.push({ name, model: safeText(profile.model), effort: safeText(profile.model_reasoning_effort, 40), default_subagent_model: safeText(profile.agents?.default_subagent_model), default_subagent_reasoning_effort: safeText(profile.agents?.default_subagent_reasoning_effort, 40), source: path.join(snapshot.home, 'config.toml'), active: null });
  if (profileCandidates.length) skippedPaths.push({ path: path.join(snapshot.home, 'config.toml'), reason: 'conditional_active_profile_unknown' });
  for (const [relative, observed] of snapshot.observedDirectories) if (relative === 'agents' || relative.startsWith('agents/')) for (const [name, kind] of observed.entries ?? []) if (kind === 'symlink') skippedPaths.push({ path: safeSource(path.join(snapshot.home, relative, name)), reason: 'unfollowed_symlink' });
  const rulesSummary = ['仅在用户和宿主授权下委派', '按当前档位、任务难度和验证需求选择模型', '用户明确模型、预算和项目规则优先', '禁止递归委派', '禁止修改生产、共享环境、第三方系统和代理配置', '明确独占写入', '先读取真实材料与验收条件', '等价局部差异自行适配', '核心前提失效只阻断受影响部分', '必要验证通过后停止，不擅自扩大检查', '未知退出状态、陈旧报告或部分结果标记 PARTIAL', '固定角色不适用时使用 task_delegate，权限与验收不变', 'fire 每会话先验证；失败时用用户指定组合，否则继承父代理组合', '备用须满足原授权、预算、工具和能力；失败不得静默降级'];
  return { ...effective, definition: undefined, global_mode: snapshot.mode, agent: 'codex', home: snapshot.home, cli_version: VERSION, configuration_version: state?.version ?? null, configuration_revision: snapshot.configuration_revision, installation: state ? 'installed' : 'not_installed', integrity: snapshot.diagnostics.some(value => value.status === 'fail') ? 'drifted' : 'clean', mode: mode ? { id: mode.id, name: mode.name, kind: mode.kind, levels: mode.levels } : null, verification: verificationRequirement(mode), restoration: { status: state?.restoration.status ?? 'not_installed' }, roles: snapshot.roles, task_levels: mode ? LEVELS.map(level => ({ level, ...mode.levels[level] })) : [], rules: { source: path.join(snapshot.home, SKILL, 'SKILL.md'), integrity: state ? snapshot.diagnostics.some(value => ['MANAGED_RULES_DRIFT', 'MANAGED_FILE_DRIFT'].includes(value.code)) ? 'drifted' : 'clean' : 'not_installed', summary: options.details ? rulesSummary : [] }, related_config: { agents_enabled: typeof snapshot.config.agents?.enabled === 'boolean' ? snapshot.config.agents.enabled : typeof snapshot.config.features?.multi_agent === 'boolean' ? snapshot.config.features.multi_agent : null, default_subagent_model: safeText(snapshot.config.agents?.default_subagent_model), default_subagent_reasoning_effort: safeText(snapshot.config.agents?.default_subagent_reasoning_effort), inheritance_note: 'task_delegate 的省略参数不证明继承；须核对全局子代理默认值与宿主派发参数。', external_roles: snapshot.externalRoles, registered_roles: registeredRoles, profile_candidates: profileCandidates, project_candidates: [] }, inspection: { checked_paths: [...snapshot.observedFiles.keys()].map(relative => safeSource(path.join(snapshot.home, relative))), skipped_paths: skippedPaths }, diagnostics: snapshot.diagnostics, warnings: state ? ['运行模型身份尚未验证；已开始任务沿用原配置。'] : [], runtime_verification: 'unverified' };
}
export async function listReport(home, options = {}) {
  const snapshot = await readSnapshot(home, options);
  const context = await scopeContext(options), effective = scopedSelection(snapshot, context);
  return { ...effective, definition: undefined, configuration_revision: snapshot.configuration_revision, home: snapshot.home, modes: [...BUILTINS, ...visibleModes(snapshot, context)].map(mode => ({ ...(mode.kind === 'builtin' && snapshot.mode?.id === mode.id ? snapshot.mode : mode), active: effective.active && effective.definition.id === mode.id, definition_scope: mode.definition_scope ?? 'builtin', source: mode.kind === 'builtin' && snapshot.mode?.id === mode.id ? 'installed_snapshot' : mode.kind === 'builtin' ? 'package' : 'custom_definition', definition_version: mode.kind === 'builtin' && snapshot.mode?.id === mode.id ? snapshot.mode.definition_version ?? snapshot.state.version : mode.kind === 'builtin' ? VERSION : null })), diagnostics: snapshot.diagnostics };
}
export async function showReport(home, selector, options = {}) {
  const snapshot = await readSnapshot(home, options);
  const selected = scopedSelection(snapshot, await scopeContext(options), selector);
  const { definition } = selected;
  const activeBuiltin = definition.kind === 'builtin' && snapshot.mode?.id === definition.id;
  return { ...selected, configuration_revision: snapshot.configuration_revision, home: snapshot.home, source: activeBuiltin ? path.join(snapshot.home, SKILL, 'references/current-mode.json') : definition.kind === 'builtin' ? 'package' : path.join(snapshot.home, selected.definition_scope === 'global' ? CUSTOM : SCOPE_FILE), definition_version: activeBuiltin ? snapshot.mode.definition_version ?? snapshot.state.version : definition.kind === 'builtin' ? VERSION : null, diagnostics: snapshot.diagnostics, runtime_verification: 'unverified' };
}
