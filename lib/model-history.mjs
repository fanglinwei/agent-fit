import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { checkPath } from './install.mjs';
import { argumentError } from './codex.mjs';

const DIRECTORY = '.agent-fit-checks';
const ID = /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BYTES = 4 * 1024 * 1024;
const failure = () => Object.assign(new Error('检查记录无法安全读写，请核对当前配置目录的权限和记录文件。'), { code: 'MODEL_HISTORY_UNAVAILABLE', exitCode: 1 });
const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value ?? {}, key)).map(key => [key, value[key]]));

// Keep an explicit projection: later RPC fields must not silently become persisted credentials.
function resultFields(data) {
  return {
    ...pick(data, ['cli_version', 'codex_version', 'probe_transport', 'check_kind', 'configuration_revision', 'source_revision', 'configuration_changed', 'authorization_changed', 'status', 'check_status', 'exit_code', 'stop_reason', 'inheritance_fallback']),
    verification_summary: pick(data.verification_summary, ['request_succeeded', 'reported_identity_matched', 'session_context_matched', 'fire_gate_satisfied', 'missing_evidence']),
    ...(['setup', 'set', 'configure', 'manual'].includes(data.trigger) ? { trigger: data.trigger } : {}),
    availability: pick(data.availability, ['total', 'available', 'unavailable', 'unconfirmed']),
    account: pick(data.account, ['status', 'type']),
    context: pick(data.context, ['scope', 'provider', 'context_match']),
    mode: pick(data.mode, ['id', 'name', 'kind']),
    catalog: { ...pick(data.catalog, ['status', 'source', 'revision', 'reason_code', 'pages', 'includes_hidden']), models: (data.catalog?.models ?? []).map(model => pick(model, ['id', 'model', 'display_name', 'hidden', 'default_reasoning_effort', 'supported_reasoning_efforts', 'input_modalities'])) },
    checked_pairs: (data.checked_pairs ?? []).map(pair => pick(pair, ['model', 'effort', 'access', 'parameter_support', 'request_status', 'actual_model', 'actual_effort', 'identity_status', 'http_status', 'reason_code', 'stopped_by', 'source_revision', 'valid_for_current_configuration'])),
    diagnostics: (data.diagnostics ?? []).map(item => pick(item, ['code', 'status'])),
  };
}
async function directory(home, create = false) {
  await checkPath(home, DIRECTORY);
  const root = await lstat(home);
  if (!root.isDirectory()) throw failure();
  const target = path.join(home, DIRECTORY);
  if (create) await mkdir(target, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  let info;
  try { info = await lstat(target); } catch (error) { if (error.code === 'ENOENT' && !create) return null; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== 'win32' && ((info.mode & 0o777) !== 0o700 || info.uid !== process.getuid())) throw failure();
  return target;
}
async function readRecord(home, id) {
  if (!ID.test(id)) throw argumentError('检查记录标识无效。');
  await directory(home);
  const relative = `${DIRECTORY}/${id}.json`;
  await checkPath(home, relative);
  const handle = await open(path.join(home, relative), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BYTES || process.platform !== 'win32' && ((info.mode & 0o777) !== 0o600 || info.uid !== process.getuid())) throw failure();
    const record = JSON.parse(await handle.readFile('utf8'));
    if (record.schema_version !== 1 || record.id !== id || !['catalog', 'verify', 'availability'].includes(record.kind) || !Number.isFinite(Date.parse(record.checked_at)) || !record.result || typeof record.result !== 'object' || Array.isArray(record.result)) throw failure();
    return { ...pick(record, ['schema_version', 'id', 'checked_at', 'kind']), result: resultFields(record.result) };
  } finally { await handle.close(); }
}
export async function saveModelCheck(home, data, { verify = false } = {}) {
  const id = `${Date.now()}-${randomUUID()}`;
  const record = { schema_version: 1, id, checked_at: new Date().toISOString(), kind: data.check_kind === 'availability' ? 'availability' : verify ? 'verify' : 'catalog', result: resultFields(data) };
  const bytes = JSON.stringify(record, null, 2) + '\n';
  if (Buffer.byteLength(bytes) > MAX_BYTES) throw failure();
  let temporary;
  try {
    const target = await directory(home, true);
    await checkPath(home, `${DIRECTORY}/${id}.json`);
    temporary = path.join(target, `.tmp-${id}`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await checkPath(home, DIRECTORY);
    await rename(temporary, path.join(target, `${id}.json`)); temporary = null;
    return { status: 'saved', id, checked_at: record.checked_at };
  } catch { throw failure(); }
  finally { if (temporary) { await checkPath(home, DIRECTORY); await rm(temporary, { force: true }); } }
}
export async function modelHistory(home, { id, cursor } = {}) {
  try {
    if (id !== undefined) return { record: await readRecord(home, id) };
    if (cursor !== undefined && !ID.test(cursor)) throw argumentError('检查记录分页标识无效。');
    const target = await directory(home);
    if (!target) return { records: [], next_cursor: null };
    const files = (await readdir(target)).filter(file => file.endsWith('.json') && ID.test(file.slice(0, -5))).map(file => file.slice(0, -5)).sort().reverse().filter(value => !cursor || value < cursor);
    const records = [];
    for (const value of files.slice(0, 30)) {
      const record = await readRecord(home, value);
      records.push({ ...pick(record, ['id', 'checked_at', 'kind']), ...pick(record.result, ['status', 'check_status', 'exit_code', 'source_revision', 'configuration_changed', 'authorization_changed', 'trigger', 'stop_reason']), verification_summary: record.result.verification_summary, account: record.result.account, context: record.result.context, checked_pairs: record.result.checked_pairs, diagnostics: record.result.diagnostics, catalog_status: record.result.catalog.status });
    }
    return { records, next_cursor: files.length > 30 ? files[29] : null };
  } catch (error) { if (error.exitCode === 2) throw error; throw failure(); }
}
export async function recordedModelCheck(options, internal = {}) {
  const { checkAccountModels } = await import('./models.mjs');
  const data = await checkAccountModels(options, internal);
  data.trigger = 'manual';
  try { data.history = await saveModelCheck(options.home, data, { verify: options.verify }); }
  catch { data.history = { status: 'failed', code: 'MODEL_HISTORY_UNAVAILABLE' }; data.exit_code ||= 1; data.status = 'incomplete'; }
  return data;
}
