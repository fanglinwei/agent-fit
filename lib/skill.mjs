import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { skillAssets, VERSION } from './codex.mjs';

const MANIFEST = '.agent-fit-manifest.json';
let testHooks = {};
export function setSkillTestHooks(hooks = {}) { testHooks = hooks; }
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code, exitCode: 1 }); };
export const sharedSkillPath = () => path.join(os.homedir(), '.agents/skills/agent-fit');
async function stat(target) { try { return await fs.lstat(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function checkDirectoryPath(target) {
  let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await stat(current);
    if (info && (!info.isDirectory() || info.isSymbolicLink())) fail('UNSAFE_PATH', `共享 Skill 安装父级不安全：${current}`);
  }
}

async function rootAt(target) {
  try {
    const root = await fs.realpath(target), info = await fs.lstat(root);
    if (!info.isDirectory() || info.mode & 0o7022 || process.platform !== 'win32' && info.uid !== process.getuid()) fail('UNSAFE_PATH', `Skill 目录所有者、权限或类型不安全：${target}`);
    return root;
  } catch (error) { if (error.code === 'ENOENT' && !await stat(target)) return null; throw error; }
}

// Only the Skill root may be a link. Files and nested directories never follow links.
export async function readSkillFile(root, relative) {
  if (!relative || relative.split('/').some(part => !part || part === '.' || part === '..') || relative.includes('\\')) fail('UNSAFE_PATH', '非法 Skill 文件路径。');
  if (await fs.realpath(root) !== root) fail('UNSAFE_PATH', `Skill 目录已改变：${root}`);
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const info = await stat(current);
    if (!info) return { bytes: null, mode: null };
    if (info.isSymbolicLink() || info.mode & 0o7022 || process.platform !== 'win32' && info.uid !== process.getuid()) fail('UNSAFE_PATH', `Skill 文件路径不安全：${current}`);
    if (current !== path.join(root, relative) && !info.isDirectory()) fail('UNSAFE_PATH', `Skill 父级不是目录：${current}`);
  }
  const handle = await fs.open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1024 * 1024) fail('UNSAFE_PATH', `Skill 不是普通文件或过大：${current}`);
    return { bytes: await handle.readFile(), mode: info.mode & 0o777 };
  } finally { await handle.close(); }
}

export async function inspectSkill(home) {
  const assets = await skillAssets(), roots = [];
  const shared = await rootAt(sharedSkillPath());
  const legacyPath = path.join(home, 'skills/agent-fit');
  const legacy = await rootAt(legacyPath);
  if ((await stat(legacyPath))?.isSymbolicLink() && legacy !== shared) fail('UNSAFE_PATH', '旧 Skill 软链接必须指向已识别的共享 Skill 目录。');
  for (const root of [...new Set([shared, legacy].filter(Boolean))]) {
    const files = new Map();
    for (const relative of [...assets.keys(), 'references/current-mode.json', MANIFEST]) files.set(relative, await readSkillFile(root, relative));
    const entry = files.get('SKILL.md').bytes;
    if (!entry || !/^name: agent-fit$/m.test(entry.toString('utf8'))) fail('SKILL_CONFLICT', `目录中不是有效的 agent-fit Skill：${root}`);
    const issues = [];
    let integrity = 'clean', manifest = null;
    const receipt = files.get(MANIFEST).bytes;
    if (receipt === null) {
      integrity = 'untracked';
      issues.push({ code: 'SKILL_UPDATE_REQUIRED', message: '共享规则未登记摘要；显式预览 skill update 后更新，不把规则视为已核验。' });
    } else {
      try {
        manifest = JSON.parse(receipt);
        if (manifest?.layout !== 1 || typeof manifest.version !== 'string' || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files) || Object.keys(manifest.files).length !== assets.size || [...assets.keys()].some(name => !Object.hasOwn(manifest.files, name) || !/^[a-f0-9]{64}$/.test(manifest.files[name]))) throw new Error();
      } catch {
        manifest = null; integrity = 'invalid';
        issues.push({ code: 'SKILL_MANIFEST_INVALID', message: '共享规则清单结构或文件列表无效；保留原文件，修复清单后再委派。' });
      }
    }
    for (const name of assets.keys()) {
      const actual = files.get(name).bytes;
      if (actual === null) {
        integrity = integrity === 'invalid' ? 'invalid' : 'incomplete';
        issues.push({ code: 'SKILL_FILE_MISSING', file: name, message: '共享规则缺少发布资产；修复规则后再委派。' });
      } else if (manifest && hash(actual) !== manifest.files[name]) {
        if (integrity === 'clean') integrity = 'modified';
        issues.push({ code: 'SKILL_FILE_MODIFIED', file: name, message: '共享规则内容与已登记摘要不符；保留用户修改，核对规则后再委派。' });
      }
    }
    roots.push({ root, files, integrity, issues });
  }
  const identity = roots.map(({ root, files }) => [root, [...files].map(([relative, value]) => [relative, value.mode, value.bytes === null ? null : hash(value.bytes)])]);
  return { path: roots.length ? path.join(roots[0].root, 'SKILL.md') : null, roots, revision: hash(JSON.stringify(identity)), integrity: roots[0]?.integrity ?? 'not_installed', issues: roots[0]?.issues ?? [], assets };
}

export async function updateSkill(home, { dryRun = false, installOnly = false, legacyState = null } = {}) {
  const inspection = await inspectSkill(home), destination = sharedSkillPath();
  const existing = await rootAt(destination);
  if (installOnly && existing) return { result: 'unchanged', path: path.join(existing, 'SKILL.md'), changed_files: [] };
  const root = existing ?? destination, assets = inspection.assets;
  const before = new Map();
  for (const relative of [...assets.keys(), MANIFEST]) before.set(relative, existing ? await readSkillFile(existing, relative) : { bytes: null, mode: null });
  let recorded = {};
  if (before.get(MANIFEST).bytes) {
    try {
      const value = JSON.parse(before.get(MANIFEST).bytes);
      if (value.layout !== 1 || typeof value.version !== 'string' || !value.files || Array.isArray(value.files) || Object.entries(value.files).some(([name, digest]) => !assets.has(name) || !/^[a-f0-9]{64}$/.test(digest))) throw new Error();
      recorded = value.files;
    } catch { fail('SKILL_CONFLICT', '共享 Skill 管理记录无效；保留现有文件。'); }
  }
  const changes = new Map();
  for (const [relative, bytes] of assets) {
    const actual = before.get(relative).bytes;
    if (actual?.equals(bytes)) continue;
    const expected = recorded[relative] ?? legacyState?.legacy_skill_files?.[`skills/agent-fit/${relative}`] ?? legacyState?.files[`skills/agent-fit/${relative}`];
    if (actual !== null && (!expected || hash(actual) !== expected)) fail('SKILL_CONFLICT', `共享 Skill 含未确认的修改，未覆盖：${path.join(root, relative)}`);
    changes.set(relative, bytes);
  }
  const manifest = Buffer.from(JSON.stringify({ layout: 1, version: VERSION, files: Object.fromEntries([...assets].map(([name, bytes]) => [name, hash(bytes)])) }, null, 2) + '\n');
  if (!before.get(MANIFEST).bytes?.equals(manifest)) changes.set(MANIFEST, manifest);
  const report = { action: 'skill-update', home, result: dryRun ? 'preview' : changes.size ? 'applied' : 'unchanged', path: path.join(root, 'SKILL.md'), changed_files: [...changes.keys()], version: VERSION, restart: { required: !dryRun && changes.size > 0, message: dryRun ? '共享规则预览未写入；更新后请重启 Codex。' : changes.size ? '共享规则已更新，请重启 Codex 后使用。' : '共享规则无变化。' } };
  if (!existing) await checkDirectoryPath(path.dirname(root));
  if (dryRun || !changes.size) return report;
  const parent = path.dirname(root), created = [], applied = [];
  await checkDirectoryPath(parent);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  if (await fs.realpath(parent) !== parent) fail('UNSAFE_PATH', `共享 Skill 安装父级含符号链接：${parent}`);
  const lock = path.join(parent, '.agent-fit-skill.lock');
  let handle;
  try { handle = await fs.open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
  catch (error) { if (error.code === 'EEXIST') fail('BUSY', '共享 Skill 正在更新；请稍后重试。'); throw error; }
  const identity = await handle.stat();
  const ownsLock = async () => { const actual = await stat(lock); return actual?.dev === identity.dev && actual?.ino === identity.ino; };
  const write = async (relative, bytes, mode, expected) => {
    if (!await ownsLock()) fail('BUSY', '共享 Skill 更新锁被替换；保留新锁，停止写入。');
    const actual = await readSkillFile(root, relative);
    if (actual.mode !== expected.mode || (actual.bytes === null ? expected.bytes !== null : !actual.bytes.equals(expected.bytes ?? Buffer.alloc(0)))) fail('CONFIG_CHANGED', `共享 Skill 在更新期间改变：${path.join(root, relative)}`);
    const target = path.join(root, relative);
    if (bytes === null) { await fs.unlink(target); return; }
    const temporary = path.join(path.dirname(target), `.agent-fit-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, bytes, { flag: 'wx', mode });
      await fs.chmod(temporary, mode);
      const current = await readSkillFile(root, relative);
      if (current.mode !== actual.mode || (current.bytes === null ? actual.bytes !== null : !current.bytes.equals(actual.bytes))) fail('CONFIG_CHANGED', `共享 Skill 在替换前改变：${target}`);
      await fs.rename(temporary, target);
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  };
  try {
    const directories = new Set(['']);
    for (const relative of changes.keys()) { let folder = path.posix.dirname(relative); while (folder !== '.') { directories.add(folder); folder = path.posix.dirname(folder); } }
    for (const relative of [...directories].sort((a, b) => a.split('/').length - b.split('/').length)) {
      const target = path.join(root, relative), info = await stat(target);
      if (!info) { await fs.mkdir(target, { mode: 0o700 }); created.push(target); }
      else if (!info.isDirectory() || info.isSymbolicLink()) fail('UNSAFE_PATH', `共享 Skill 目录不安全：${target}`);
    }
    for (const [relative, bytes] of changes) {
      await testHooks.beforeWrite?.(relative, applied.length);
      await write(relative, bytes, before.get(relative).mode ?? 0o600, before.get(relative)); applied.push(relative);
    }
    return report;
  } catch (error) {
    const failures = [];
    for (const relative of applied.reverse()) {
      try { await write(relative, before.get(relative).bytes, before.get(relative).mode, { bytes: changes.get(relative), mode: before.get(relative).mode ?? 0o600 }); }
      catch { failures.push(path.join(root, relative)); }
    }
    for (const target of created.reverse()) await fs.rmdir(target).catch(() => {});
    if (failures.length) fail('SKILL_UPDATE_PARTIAL', `共享 Skill 更新未完成，部分文件回退失败；请核对：${failures.join('、')}`);
    throw error;
  } finally { await handle.close(); if (await ownsLock()) await fs.unlink(lock); }
}
