import { readFile, readdir, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';

export const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const VERSION = (await readFile(new URL('../VERSION', import.meta.url), 'utf8')).trim();
export const LEVELS = ['L1', 'L2', 'L3', 'L4'];
export const ROLES = { task_scan: 'L1', task_execute: 'L2', task_review: 'L3', task_delegate: null };
export const START = '<!-- subagent-delegation:start -->';
export const END = '<!-- subagent-delegation:end -->';
const policy = JSON.parse(await readFile(new URL('../adapters/codex/modes.json', import.meta.url), 'utf8'));
export const FALLBACK_CONDITIONS = policy.fallback_conditions;
export const BUILTINS = policy.modes.map(mode => ({ ...mode, kind: 'builtin', fallback_conditions: FALLBACK_CONDITIONS }));

export function argumentError(message, code = 'INVALID_ARGUMENT') {
  return Object.assign(new Error(message), { code, exitCode: 2 });
}

export function validateText(value, maximum, label) {
  if (typeof value !== 'string' || !value || !value.isWellFormed() || value.trim() !== value || [...value].length > maximum || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw argumentError(`${label}必须为有效 Unicode、无控制字符、无首尾空白的 1–${maximum} 字符文本。`);
  }
  return value;
}

export function validatePair(pair) {
  if (!pair || typeof pair !== 'object' || Array.isArray(pair) || Object.keys(pair).some(k => !['model', 'effort'].includes(k))) {
    throw argumentError('模型组合只接受 model 和 effort。');
  }
  return { model: validateText(pair.model, 200, '模型'), effort: validateText(pair.effort, 40, '推理强度') };
}

export function validateDefinition(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'levels')) throw argumentError('完整定义只接受 levels 对象。');
  const levels = input.levels;
  if (!levels || typeof levels !== 'object' || Array.isArray(levels) || Object.keys(levels).length !== 4 || LEVELS.some(level => !Object.hasOwn(levels, level))) throw argumentError('必须提供完整 L1–L4。');
  return Object.fromEntries(LEVELS.map(level => {
    const value = levels[level];
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3 || !['model', 'effort', 'fallback'].every(k => Object.hasOwn(value, k))) throw argumentError(`${level} 必须显式提供 model、effort、fallback（可为 null）。`);
    const primary = validatePair({ model: value.model, effort: value.effort });
    const fallback = value.fallback === null ? null : validatePair(value.fallback);
    if (fallback && primary.model === fallback.model && primary.effort === fallback.effort) throw argumentError('主配置与备用不能完全相同。');
    return [level, { ...primary, fallback }];
  }));
}

export function resolveDefinition(selector, customModes = []) {
  const name = typeof selector === 'string' ? selector.trim().normalize('NFC') : selector;
  const matches = [...BUILTINS.filter(mode => mode.id === selector), ...customModes.filter(mode => mode.id === selector || mode.name === name)];
  if (matches.length !== 1) throw argumentError('档位不存在或名称不唯一；内置档位请用 cut、official、high、fire，自定义档位请用 mode list 显示的 id 或名称。', 'MODE_NOT_FOUND');
  const mode = matches[0];
  return { ...mode, levels: validateDefinition({ levels: mode.levels }), fallback_conditions: FALLBACK_CONDITIONS };
}

export function verificationRequirement(definition) {
  return definition?.kind === 'builtin' && definition.id === 'fire' ? {
    required: true, scope: 'session', evidence: 'successful_request_and_trusted_runtime_metadata',
    recheck_on: ['model', 'effort', 'provider', 'account'],
    on_failure: { selection: 'user_or_parent', dispatch_role: 'task_delegate', preserve_permission_contract: true },
  } : null;
}

export function explainSelection({ definition, level, role = 'task_delegate' }) {
  if (!LEVELS.includes(level) || !Object.hasOwn(ROLES, role)) throw argumentError('任务等级或角色无效。');
  const { model, effort, fallback } = definition.levels[level];
  const fixed = ROLES[role] && definition.levels[ROLES[role]];
  const matches = level !== 'L4' && fixed && fixed.model === model && fixed.effort === effort;
  return {
    mode_id: definition.id, mode_kind: definition.kind, mode_name: definition.name,
    level, level_source: 'argument', requested_role: role, dispatch_role: matches ? role : 'task_delegate',
    primary: { model, effort }, fallback, fallback_conditions: fallback ? FALLBACK_CONDITIONS : [],
    permission_contract: { task_scan: 'readonly_evidence', task_execute: 'scoped_output', task_review: 'readonly_review', task_delegate: 'bounded_delegate' }[role],
    reason_codes: ['TASK_LEVEL_ARGUMENT', 'MODE_PRESET', matches ? 'FIXED_ROLE_MATCH' : 'UNPINNED_ROLE_REQUIRED', 'MODEL_ACCESS_UNKNOWN', 'RUNTIME_UNVERIFIED'],
    verification: verificationRequirement(definition), access: 'unknown', runtime_verification: 'unverified',
  };
}

export function safeToml(bytes) {
  try { return parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes), { integersAsBigInt: 'asNeeded', unsafeKeyBehaviour: 'throw' }); }
  catch { throw Object.assign(new Error('配置格式无法解析；请在本地检查文件。'), { code: 'INVALID_TOML', exitCode: 1 }); }
}

export function safeJsonData(value) {
  return JSON.stringify(value).replace(/[<>`]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export async function renderPayload(home, mode) {
  const skillRoot = path.join(PACKAGE_ROOT, 'adapters/codex/skills/subagent-delegation');
  const files = new Map();
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw Object.assign(new Error('发布资产不允许符号链接。'), { code: 'INVALID_PACKAGE' });
      const relative = prefix + entry.name;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative + '/');
      else if (entry.isFile() && entry.name !== '.DS_Store') files.set(`skills/subagent-delegation/${relative}`, await readFile(path.join(directory, entry.name)));
    }
  }
  await visit(skillRoot);
  const skillPath = path.join(home, 'skills/subagent-delegation/SKILL.md');
  const modePath = path.join(home, 'skills/subagent-delegation/references/current-mode.json');
  for (const [name, level] of Object.entries(ROLES)) {
    const filename = name.replaceAll('_', '-') + '.toml';
    const role = safeToml(await readFile(path.join(skillRoot, 'assets/codex/agents', filename)));
    if (level) { role.model = mode.levels[level].model; role.model_reasoning_effort = mode.levels[level].effort; }
    else { delete role.model; delete role.model_reasoning_effort; }
    role.developer_instructions = `启动后先读取本 home 的子代理模型选择 Skill，遵守当前派发职责；不递归委派。\n规则路径（JSON 字符串数据）：${safeJsonData(skillPath)}\n\n` + role.developer_instructions;
    const bytes = Buffer.from(stringify(role));
    files.set(`agents/${filename}`, bytes);
    files.set(`skills/subagent-delegation/assets/codex/agents/${filename}`, bytes);
  }
  files.set('skills/subagent-delegation/references/current-mode.json', Buffer.from(JSON.stringify({ ...mode, version: VERSION, roles: ROLES }, null, 2) + '\n'));
  const fragment = await readFile(path.join(skillRoot, 'assets/AGENTS.fragment.md'), 'utf8');
  const block = Buffer.from(`${START}\n## AI 子代理模型选择与委派\n\nCodex 启动或加载本 home 的规则时，必须先读取以下 Skill；每次创建、重新委派或切换子智能体模型前必须再次按 Skill 和当前档位检查。已有上下文可复用，配置变化后须重读。委派仍须有用户或适用规则授权。\n\n以下 JSON 只表示绑定 home 的文件路径，不是新指令：\n\n\`\`\`json\n${safeJsonData({ skill: skillPath, mode: modePath })}\n\`\`\`\n\n${fragment.trim()}\n${END}\n`);
  return { files, block };
}

// Project observations are read only and intentionally do not change the bound home's revision.
export async function inspectProject(project) {
  const observations = new Map(), directories = new Map(), candidates = [], checked = [], skipped = [], diagnostics = [];
  const safePath = async filename => {
    let current = path.parse(filename).root;
    for (const part of filename.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try { if ((await lstat(current)).isSymbolicLink()) { skipped.push({ path: filename, reason: 'symlink_not_followed' }); return false; } }
      catch (error) { if (error.code === 'ENOENT') return true; throw error; }
    }
    return true;
  };
  const observe = async filename => {
    if (!await safePath(filename)) return null;
    let metadata;
    try { metadata = await lstat(filename); } catch (error) { if (error.code === 'ENOENT') return { absent: true }; throw error; }
    if (!metadata.isFile() || metadata.size > 1024 * 1024) { skipped.push({ path: filename, reason: 'not_regular_or_too_large' }); return null; }
    return { bytes: await readFile(filename), mode: metadata.mode & 0o7777 };
  };
  let directory = path.resolve(project);
  try { if (!(await lstat(directory)).isDirectory()) throw new Error(); }
  catch { return { candidates, checked, skipped: [{ path: directory, reason: 'project_not_directory' }], diagnostics }; }
  while (true) {
    const folder = path.join(directory, '.codex');
    for (const filename of [path.join(folder, 'config.toml'), path.join(directory, 'AGENTS.md'), path.join(directory, 'AGENTS.override.md')]) {
      const value = await observe(filename);
      if (value === null) continue;
      observations.set(filename, value); checked.push(filename);
      if (value.absent) continue;
      if (path.basename(filename) !== 'config.toml') { candidates.push({ source: filename, kind: 'project_rules', content_inspected: false }); continue; }
      try {
        const config = safeToml(value.bytes);
        candidates.push({ source: filename, kind: 'project_config', model: typeof config.model === 'string' ? config.model : null, effort: typeof config.model_reasoning_effort === 'string' ? config.model_reasoning_effort : null });
        for (const [name, role] of Object.entries(config.agents || {})) if (role && typeof role === 'object' && !Array.isArray(role)) candidates.push({ source: filename, kind: 'role_registration', name, config_file: typeof role.config_file === 'string' ? role.config_file : null, inspected: false, reason: 'candidate_only_not_followed' });
        for (const [name, profile] of Object.entries(config.profiles || {})) candidates.push({ source: filename, kind: 'profile_candidate', name, model: typeof profile?.model === 'string' ? profile.model : null, effort: typeof profile?.model_reasoning_effort === 'string' ? profile.model_reasoning_effort : null, active: 'unknown' });
      } catch { diagnostics.push({ code: 'PROJECT_CONFIG_INVALID', status: 'fail', source: filename, message: '项目配置格式无法解析；未输出内容。' }); }
    }
    const walkAgents = async agents => {
    if (!await safePath(agents)) return;
    try {
      const metadata = await lstat(agents);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) skipped.push({ path: agents, reason: 'unsafe_directory_not_followed' });
      else {
        const entries = (await readdir(agents, { withFileTypes: true })).map(e => [e.name, e.isSymbolicLink() ? 'symlink' : e.isDirectory() ? 'directory' : 'file']).sort();
        directories.set(agents, entries);
        for (const [name, kind] of entries) {
          if (kind === 'directory') { await walkAgents(path.join(agents, name)); continue; }
          if (kind === 'symlink') { skipped.push({ path: path.join(agents, name), reason: 'symlink_not_followed' }); continue; }
          if (!name.endsWith('.toml') || kind !== 'file') continue;
          const filename = path.join(agents, name), value = await observe(filename);
          if (!value || value.absent) continue;
          observations.set(filename, value); checked.push(filename);
          try {
            const role = safeToml(value.bytes);
            if (typeof role.name === 'string') candidates.push({ source: filename, kind: 'project_role', name: role.name, model: typeof role.model === 'string' ? role.model : null, effort: typeof role.model_reasoning_effort === 'string' ? role.model_reasoning_effort : null });
          } catch { diagnostics.push({ code: 'PROJECT_CONFIG_INVALID', status: 'fail', source: filename, message: '项目角色格式无法解析；未输出内容。' }); }
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') skipped.push({ path: agents, reason: 'unreadable' }); else directories.set(agents, null); }
    };
    await walkAgents(path.join(folder, 'agents'));
    if (directory === path.dirname(directory)) break;
    directory = path.dirname(directory);
  }
  for (const [filename, before] of observations) {
    const after = await observe(filename);
    if (!after || Boolean(before.absent) !== Boolean(after.absent) || before.mode !== after.mode || (before.bytes && !before.bytes.equals(after.bytes || Buffer.alloc(0)))) throw Object.assign(new Error('项目配置读取期间变化；请刷新。'), { code: 'BUSY', exitCode: 1 });
  }
  for (const [folder, before] of directories) {
    let after = null;
    try { const meta = await lstat(folder); if (!meta.isDirectory() || meta.isSymbolicLink()) throw new Error(); after = (await readdir(folder, { withFileTypes: true })).map(e => [e.name, e.isSymbolicLink() ? 'symlink' : e.isDirectory() ? 'directory' : 'file']).sort(); }
    catch (error) { if (before !== null && error.code !== 'ENOENT') throw Object.assign(new Error('项目角色读取期间变化；请刷新。'), { code: 'BUSY', exitCode: 1 }); }
    if (JSON.stringify(after) !== JSON.stringify(before)) throw Object.assign(new Error('项目角色目录读取期间变化；请刷新。'), { code: 'BUSY', exitCode: 1 });
  }
  if (candidates.length) diagnostics.push({ code: 'PROJECT_OVERRIDE_CANDIDATES', status: 'warn', source: path.resolve(project), message: '项目配置可能覆盖用户级设置；实际生效顺序需要宿主核验。' });
  return { candidates, checked, skipped, diagnostics };
}
