import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { VERSION, argumentError, validateDefinition, validatePair, validateText, LEVELS, ROLES } from './codex.mjs';

const CLI = fileURLToPath(new URL('../bin/subagent-delegation.mjs', import.meta.url));
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);
const allowed = {
  status: ['details'], list: [], show: ['mode'], explain: ['mode', 'level', 'role'],
  setup: ['mode', 'expectRevision', 'dryRun'], set: ['mode', 'expectRevision', 'dryRun'],
  create: ['name', 'from', 'expectRevision', 'dryRun'],
  configure: ['mode', 'definition', 'level', 'model', 'effort', 'fallbackModel', 'fallbackEffort', 'clearFallback', 'expectRevision', 'dryRun'],
  restore: ['expectRevision', 'dryRun'], models: ['verify', 'model', 'effort'],
};
const writing = new Set(['setup', 'set', 'create', 'configure', 'restore']);
const booleanFields = new Set(['details', 'dryRun', 'clearFallback', 'verify']);
const required = { show: ['mode'], set: ['mode'], create: ['name'], configure: ['mode'], explain: ['level'] };

export function actionCommand(body, { home, project }) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['action', 'params'].includes(k)) || !Object.hasOwn(allowed, body.action)) throw argumentError('网页动作无效。');
  const params = body.params ?? {};
  if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(k => !allowed[body.action].includes(k))) throw argumentError('网页动作参数无效。');
  for (const [key, value] of Object.entries(params)) {
    if (booleanFields.has(key)) { if (typeof value !== 'boolean') throw argumentError('布尔参数类型无效。'); }
    else if (key !== 'definition') validateText(value, key === 'expectRevision' ? 200 : 200, '参数');
  }
  for (const key of required[body.action] || []) if (!Object.hasOwn(params, key)) throw argumentError('网页动作缺少参数。');
  if (writing.has(body.action) && !params.expectRevision) throw argumentError('网页写入必须携带配置版本。');
  if (params.level && !LEVELS.includes(params.level)) throw argumentError('任务等级无效。');
  if (params.role && !Object.hasOwn(ROLES, params.role)) throw argumentError('职责无效。');
  if (Boolean(params.model) !== Boolean(params.effort)) throw argumentError('模型与推理强度必须成对。');
  if (params.model) validatePair({ model: params.model, effort: params.effort });
  let stdin;
  if (body.action === 'configure') {
    if (Object.hasOwn(params, 'definition')) {
      if (['level', 'model', 'effort', 'fallbackModel', 'fallbackEffort', 'clearFallback'].some(k => Object.hasOwn(params, k))) throw argumentError('整表定义与单级参数互斥。');
      stdin = JSON.stringify({ levels: validateDefinition(params.definition) });
      if (Buffer.byteLength(stdin) > 65536) throw argumentError('整表输入超过 64 KiB。');
    } else if (!params.level || !params.model || !params.effort) throw argumentError('配置需要完整定义或单级参数。');
    if (Boolean(params.fallbackModel) !== Boolean(params.fallbackEffort) || (params.clearFallback && params.fallbackModel)) throw argumentError('备用参数无效。');
  }
  const argv = body.action === 'models' ? ['models', 'check'] : ['set', 'list', 'show', 'create', 'configure'].includes(body.action) ? ['mode', body.action] : [body.action];
  for (const key of ['mode', 'name']) if (params[key] !== undefined && ['set', 'show', 'create', 'configure'].includes(body.action)) argv.push('--', params[key]);
  // Keep positional names after all flags so even a name beginning with '-' is data.
  const positional = argv.includes('--') ? argv.splice(argv.indexOf('--')) : [];
  argv.push('--agent=codex', `--codex-home=${home}`, '--json');
  if (body.action === 'status') argv.push(`--project=${project}`);
  for (const [key, value] of Object.entries(params)) {
    if (key === 'name' || (key === 'mode' && positional.length) || key === 'definition') continue;
    const flag = key.replace(/[A-Z]/g, char => '-' + char.toLowerCase());
    if (typeof value === 'boolean') { if (value) argv.push(`--${flag}`); }
    else argv.push(`--${flag}=${value}`);
  }
  if (stdin !== undefined) argv.push('--definition-stdin');
  argv.push(...positional);
  return { argv, stdin };
}

function equalSecret(a, b) {
  const left = Buffer.from(a || ''), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function validEnvelope(value) {
  return value && value.report_schema_version === 1 && Object.keys(value).every(k => ['report_schema_version', 'data', 'errors'].includes(k)) && (value.data === null || (typeof value.data === 'object' && !Array.isArray(value.data))) && Array.isArray(value.errors) && value.errors.every(e => e && typeof e.code === 'string' && typeof e.message === 'string');
}

async function runCLI(command, project) {
  return await new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...command.argv], { shell: false, cwd: project, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let bytes = 0; let overflow = false;
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes <= 2 * 1024 * 1024) chunks.push(chunk); else overflow = true; });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.stdin.end(command.stdin || '');
    let done = false;
    const finish = (code, error = false) => {
      if (done) return; done = true;
      let report;
      try { report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { /* Invalid child output is never exposed. */ }
      if (error || overflow || ![0, 1, 2, 3].includes(code) || !validEnvelope(report) || (code === 0 && report.errors.length)) {
        resolve({ exit_code: 1, report: { report_schema_version: 1, data: { result: 'unknown', configuration_status: 'unknown', restart: { required: null, reason: 'partial_or_unknown', message: '命令结果未确认；先查询当前配置，再决定是否重试。' } }, errors: [{ code: 'COMMAND_RESULT_INVALID', message: '命令结果未确认；查询配置后再继续。' }] }, command: { argv: command.argv } });
      } else resolve({ exit_code: code, report, command: { argv: command.argv } });
    };
    child.on('error', () => finish(null, true));
    child.on('close', code => finish(code));
  });
}

export async function serveLocal({ home, project = process.cwd(), port = 0, open = false }) {
  if (!Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535))) throw argumentError('端口必须是 0 或 1024–65535。');
  const csrf = randomBytes(32).toString('hex'), session = randomBytes(32).toString('hex');
  let active = null, recent = null, closing = false, origin;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    const fail = (status, code, message) => { if (!res.headersSent && !res.destroyed) send(status, { exit_code: 1, report: { report_schema_version: 1, data: null, errors: [{ code, message }] } }); };
    if (req.headers.host !== new URL(origin).host) return fail(403, 'HOST_REJECTED', '请求地址不匹配本地服务。');
    if (closing) return fail(503, 'SERVICE_CLOSING', '服务正在停止。');
    let pathname;
    try { pathname = new URL(req.url, origin).pathname; } catch { return fail(400, 'INVALID_REQUEST', '请求无效。'); }
    if (req.method === 'GET' && staticFiles.has(pathname)) {
      try {
        const [file, type] = staticFiles.get(pathname);
        const bytes = await readFile(new URL(`../web/${file}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': type }); res.end(bytes);
      } catch { fail(500, 'STATIC_UNAVAILABLE', '页面资源不可读取。'); }
      return;
    }
    if (req.method === 'GET' && pathname === '/api/bootstrap') {
      res.setHeader('Set-Cookie', `delegation_session=${session}; HttpOnly; SameSite=Strict; Path=/`);
      return send(200, { home, project, cli_version: VERSION, csrf_token: csrf, recent_result: recent });
    }
    if (req.method !== 'POST' || pathname !== '/api/actions') return fail(404, 'NOT_FOUND', '请求路径不存在。');
    const cookies = (req.headers.cookie || '').split(';').map(v => v.trim());
    if (req.headers.origin !== origin || !equalSecret(req.headers['x-delegation-token'], csrf) || !cookies.some(v => equalSecret(v, `delegation_session=${session}`))) return fail(403, 'CSRF_REJECTED', '请求会话无效；重新加载页面。');
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) return fail(415, 'CONTENT_TYPE_REJECTED', '仅接受 UTF-8 JSON。');
    if (active) return fail(409, 'BUSY', '已有命令正在执行，请稍后重新操作。');
    try {
      let length = 0; const chunks = [];
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 131072) { fail(413, 'BODY_TOO_LARGE', '请求超过 128 KiB。'); req.resume(); return; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { return fail(400, 'INVALID_JSON', '请求必须是有效 UTF-8 JSON。'); }
      const command = actionCommand(body, { home, project });
      // Recheck after reading the body: two simultaneous uploads must not launch two children.
      if (active || closing) return fail(409, 'BUSY', '已有命令正在执行或服务正在停止。');
      active = runCLI(command, project);
      recent = await active;
      active = null;
      send(200, recent);
    } catch (error) {
      fail(400, error.exitCode === 2 ? error.code : 'INVALID_REQUEST', error.exitCode === 2 ? error.message : '请求无法执行。');
    }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(Object.assign(new Error('端口被占用或本地服务无法启动。'), { code: 'SERVER_UNAVAILABLE', exitCode: 1 })));
    server.listen(port, '127.0.0.1', () => { server.removeAllListeners('error'); resolve(); });
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  if (open) {
    const command = process.platform === 'darwin' ? ['open', [origin]] : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', origin]] : ['xdg-open', [origin]];
    const child = spawn(command[0], command[1], { shell: false, stdio: 'ignore' });
    child.on('error', () => process.stderr.write('浏览器未打开，请手动访问上面的本地网址。\n'));
    child.on('exit', code => { if (code) process.stderr.write('浏览器未打开，请手动访问上面的本地网址。\n'); });
  }
  return { url: origin, async close() {
    closing = true;
    if (active) await active;
    server.closeIdleConnections();
    await new Promise(resolve => server.close(resolve));
  } };
}
