import path from 'node:path';
import { realpath, stat, lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { argumentError, BUILTINS, resolveDefinition, validateDefinition, validateText } from './codex.mjs';

export const SCOPE_FILE = '.agent-fit/scopes.json';
export const SCOPES = ['global', 'project', 'session'];
const exec = promisify(execFile);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, names) => object(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));

export async function scopeContext(options = {}) {
  const scope = options.scope ?? 'global';
  if (!SCOPES.includes(scope)) throw argumentError('作用域必须是 global、project 或 session。');
  let project = null;
  const directory = options.project ?? process.cwd();
  try {
    const root = await realpath(directory);
    if (!(await stat(root)).isDirectory()) throw new Error();
    try { project = (await exec('git', ['-C', root, 'rev-parse', '--show-toplevel'], { timeout: 5000, maxBuffer: 65536 })).stdout.trim(); }
    catch {
      // A missing Git executable must not turn a worktree subdirectory into a new project.
      for (let current = root; ; current = path.dirname(current)) {
        const marker = await lstat(path.join(current, '.git')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (marker?.isFile() || marker?.isDirectory()) { project = current; break; }
        if (current === path.dirname(current)) break;
      }
      if (!project && options.project !== undefined) project = root;
    }
    if (project) project = await realpath(project);
  } catch { throw argumentError('项目路径必须是已存在的目录。', 'INVALID_PROJECT'); }
  const thread = options.thread ?? process.env.CODEX_THREAD_ID ?? null;
  if (thread !== null) validateText(thread, 200, '聊天线程 ID');
  if (scope === 'project' && !project) throw argumentError('非 Git 项目需要显式指定 --project。', 'PROJECT_REQUIRED');
  if (scope === 'session' && !thread) throw argumentError('会话作用域需要当前聊天线程 ID；在聊天中调用或显式指定 --thread。', 'THREAD_REQUIRED');
  return { scope, project, thread };
}

export function validateScopeStore(value) {
  if (value === null) return { schema_version: 1, projects: [], sessions: [] };
  if (!exact(value, ['schema_version', 'projects', 'sessions']) || value.schema_version !== 1) throw argumentError('作用域配置版本或结构无效。');
  for (const [collection, key] of [['projects', 'project'], ['sessions', 'thread']]) {
    if (!Array.isArray(value[collection])) throw argumentError('作用域配置列表无效。');
    const identities = new Set();
    for (const entry of value[collection]) {
      if (!exact(entry, [key, 'selection', 'modes'])) throw argumentError('作用域配置条目无效。');
      validateText(entry[key], key === 'project' ? 4096 : 200, '作用域标识');
      if (key === 'project' && !path.isAbsolute(entry[key]) || identities.has(entry[key])) throw argumentError('作用域标识无效或重复。');
      identities.add(entry[key]);
      if (entry.selection !== null) validateText(entry.selection, 200, '档位引用');
      if (!Array.isArray(entry.modes)) throw argumentError('作用域自定义档位无效。');
      const names = new Set(BUILTINS.flatMap(mode => [mode.id, mode.name]));
      for (const mode of entry.modes) {
        if (!exact(mode, ['id', 'name', 'kind', 'levels']) || mode.kind !== 'custom' || !/^custom-[a-f0-9-]{36}$/i.test(mode.id)) throw argumentError('作用域档位结构无效。');
        validateText(mode.name, 80, '档位名称');
        if (names.has(mode.id) || names.has(mode.name)) throw argumentError('作用域档位名称或 ID 重复。');
        names.add(mode.id); names.add(mode.name);
        validateDefinition({ levels: mode.levels });
      }
    }
  }
  return value;
}

export function scopeEntry(store, context, create = false) {
  if (context.scope === 'global') return null;
  const [list, key] = context.scope === 'project' ? ['projects', 'project'] : ['sessions', 'thread'];
  let entry = store[list].find(value => value[key] === context[key]);
  if (!entry && create) { entry = { [key]: context[key], selection: null, modes: [] }; store[list].push(entry); }
  return entry ?? null;
}

export function visibleModes(snapshot, context) {
  const result = snapshot.customModes.map(mode => ({ ...mode, definition_scope: 'global' }));
  for (const scope of ['project', 'session']) {
    if (SCOPES.indexOf(scope) > SCOPES.indexOf(context.scope)) break;
    const entry = scopeEntry(snapshot.scopeStore, { ...context, scope });
    for (const mode of entry?.modes ?? []) result.push({ ...mode, definition_scope: scope });
  }
  return result;
}

export function scopedSelection(snapshot, context, selector) {
  const modes = visibleModes(snapshot, context);
  let effectiveScope = 'global', selection = snapshot.mode?.id ?? null;
  for (const scope of ['project', 'session']) {
    if (SCOPES.indexOf(scope) > SCOPES.indexOf(context.scope)) break;
    const entry = scopeEntry(snapshot.scopeStore, { ...context, scope });
    if (entry?.selection !== null && entry?.selection !== undefined) { selection = entry.selection; effectiveScope = scope; }
  }
  let definition;
  try { definition = resolveDefinition(selector ?? selection ?? 'official', modes); }
  catch (error) {
    if (selector !== undefined) throw error;
    throw Object.assign(new Error('有效作用域的档位引用无效；请修复或清除该层选择。'), { code: 'SCOPE_REFERENCE_INVALID', exitCode: 1 });
  }
  if (definition.id === snapshot.mode?.id) definition = { ...definition, ...snapshot.mode };
  const own = scopeEntry(snapshot.scopeStore, context);
  return {
    definition, active: selection === definition.id,
    scope: context.scope, effective_scope: effectiveScope, context: { project: context.project, thread: context.thread },
    selection: context.scope === 'global' ? snapshot.mode?.id ?? null : own?.selection ?? null,
    inherited: effectiveScope !== context.scope,
    definition_scope: definition.kind === 'builtin' ? 'builtin' : modes.find(mode => mode.id === definition.id)?.definition_scope,
  };
}

export function assertUnreferenced(snapshot, id) {
  if (snapshot.mode?.id === id || [...snapshot.scopeStore.projects, ...snapshot.scopeStore.sessions].some(entry => entry.selection === id)) {
    throw argumentError('档位仍被某个作用域选择；请先替换或清除选择，再删除。', 'MODE_IN_USE');
  }
}
