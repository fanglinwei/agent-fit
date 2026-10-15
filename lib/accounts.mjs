import { spawn } from 'node:child_process';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rpcClient, safeAccount } from './models.mjs';
import { checkPath } from './install.mjs';
import { VERSION, argumentError } from './codex.mjs';

const failure = (code, message) => Object.assign(new Error(message), { code, exitCode: 1 });
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\p{Cc}\p{Cf}]/u.test(value);
function authUrl(value) {
  if (!text(value)) throw failure('AUTH_RESPONSE_INVALID', '客户端返回的授权地址无效。');
  let url;
  try { url = new URL(value); } catch { throw failure('AUTH_RESPONSE_INVALID', '客户端返回的授权地址无效。'); }
  if (url.protocol !== 'https:' || !['auth.openai.com', 'auth0.openai.com', 'chatgpt.com'].includes(url.hostname) || url.username || url.password || url.port) throw failure('AUTH_RESPONSE_INVALID', '客户端返回了非官方授权地址，登录已停止。');
  return url.href;
}

// Only the test harness supplies a child/deadline; HTTP callers cannot override either.
export function createAccountController(home, internal = {}) {
  let session = null, attempt = null, account = { status: 'unknown', type: null }, provider = null, credentialSource = 'not_confirmed';
  let completion = null, closing = null;
  const timeoutMs = internal.timeoutMs ?? 10 * 60_000;
  function completed(message) {
    if (message.method !== 'account/login/completed') return;
    const value = message.params;
    if (!value || typeof value.success !== 'boolean') return;
    completion = { loginId: value.loginId, success: value.success };
    if (attempt?.id && completion.loginId === attempt.id) {
      attempt.status = completion.success ? 'succeeded' : 'failed';
      attempt.url = null; attempt.user_code = null;
    }
  }
  async function stop() {
    if (closing) return closing;
    const current = session; session = null;
    if (!current) return;
    closing = (async () => { await current.rpc.close(); await rm(current.directory, { recursive: true, force: true }); })();
    try { await closing; } finally { closing = null; }
  }
  async function open() {
    if (closing) await closing;
    if (session) return session.rpc;
    await checkPath(home);
    const info = await lstat(home);
    if (!info.isDirectory()) throw failure('INVALID_HOME', '所选 Codex 配置目录不存在或不可访问。');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'subagent-delegation-login-'));
    const child = (internal.spawn ?? spawn)('codex', ['app-server'], { shell: false, cwd: directory, env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
    const rpc = rpcClient(child, Date.now() + timeoutMs, { requestTimeoutMs: 30_000, onNotification: completed, onFailure: error => {
      if (attempt?.status === 'pending' || attempt?.status === 'starting') {
        attempt.status = error.code === 'RPC_TIMEOUT' ? 'expired' : 'failed';
        attempt.url = null; attempt.user_code = null;
      }
      void stop().catch(() => { if (attempt) attempt.status = 'failed'; });
    } });
    session = { rpc, directory };
    try {
      const handshake = await rpc.request('initialize', { clientInfo: { name: 'subagent_delegation_login', version: VERSION }, capabilities: { experimentalApi: true } });
      if (!handshake || handshake.codexHome !== home) throw failure('RPC_HOME_MISMATCH', '客户端配置目录与当前页面不一致，登录已停止。');
      rpc.notify('initialized');
      const config = await rpc.request('config/read', { includeLayers: false, cwd: null });
      provider = text(config?.config?.model_provider) ? config.config.model_provider : null;
      const selected = config?.config?.model_providers?.[provider];
      const envKey = selected?.env_key ?? (provider === 'openai' ? 'OPENAI_API_KEY' : null);
      credentialSource = envKey && process.env[envKey] ? 'provider_environment' : selected?.experimental_bearer_token ? 'provider_config' : 'not_confirmed';
      return rpc;
    } catch (error) { await stop(); throw error; }
  }
  async function read() {
    const rpc = await open();
    account = safeAccount(await rpc.request('account/read', { refreshToken: false }), provider);
    if (account.status === 'authenticated' && credentialSource === 'not_confirmed') credentialSource = 'codex_login';
  }
  function view() {
    return { home, account, provider, credential_source: credentialSource, login: attempt ? { status: attempt.status, method: attempt.method, url: attempt.url, user_code: attempt.user_code, expires_at: attempt.expires_at } : null };
  }
  return {
    async action({ operation, method, apiKey }) {
      try {
        if (operation === 'status') {
          await read();
          if (attempt?.status === 'succeeded' && account.status !== 'authenticated') attempt.status = 'failed';
        } else if (operation === 'login') {
          if (attempt?.status === 'pending') throw failure('LOGIN_PENDING', '已有授权等待完成。请继续授权或先取消。');
          if (!['chatgpt', 'chatgptDeviceCode', 'apiKey'].includes(method)) throw argumentError('不支持的登录方式。');
          if (method === 'apiKey' && (!text(apiKey) || apiKey.trim() !== apiKey)) throw argumentError('请输入有效 API Key。');
          if (method !== 'apiKey' && apiKey !== undefined) throw argumentError('此登录方式不接受 API Key。');
          await stop(); completion = null;
          attempt = { status: 'starting', method, id: null, url: null, user_code: null, expires_at: new Date(Date.now() + timeoutMs).toISOString() };
          const rpc = await open();
          const result = await rpc.request('account/login/start', method === 'apiKey' ? { type: method, apiKey } : { type: method });
          apiKey = undefined;
          if (!result || result.type !== method) throw failure('AUTH_RESPONSE_INVALID', '客户端未返回可识别的登录结果。');
          if (method === 'apiKey') {
            await read();
            if (account.status !== 'authenticated' || account.type !== 'apiKey') throw failure('AUTH_NOT_CONFIRMED', 'API Key 登录状态未确认，请重新检查。');
            attempt.status = 'succeeded';
          } else {
            if (!text(result.loginId) || method === 'chatgptDeviceCode' && (!text(result.userCode) || result.userCode.length > 100)) throw failure('AUTH_RESPONSE_INVALID', '客户端返回的授权信息无效。');
            attempt.id = result.loginId;
            attempt.url = authUrl(method === 'chatgpt' ? result.authUrl : result.verificationUrl);
            attempt.user_code = method === 'chatgptDeviceCode' ? result.userCode : null;
            attempt.status = 'pending';
            if (completion?.loginId === attempt.id) completed({ method: 'account/login/completed', params: completion });
            if (attempt.status === 'succeeded') await read();
          }
        } else if (operation === 'cancel') {
          if (attempt?.status === 'pending' && session) await session.rpc.request('account/login/cancel', { loginId: attempt.id });
          if (attempt) { attempt.status = 'cancelled'; attempt.url = null; attempt.user_code = null; }
        } else if (operation === 'logout') {
          if (attempt?.status === 'pending' && session) await session.rpc.request('account/login/cancel', { loginId: attempt.id });
          const rpc = await open();
          await rpc.request('account/logout', {}); attempt = null;
          await read();
        } else throw argumentError('不支持的账号操作。');
        return view();
      } catch (error) {
        if (attempt?.status === 'starting') { attempt.status = 'failed'; attempt.url = null; attempt.user_code = null; }
        if (error.exitCode === 2 || ['LOGIN_PENDING', 'AUTH_RESPONSE_INVALID', 'AUTH_NOT_CONFIRMED', 'RPC_HOME_MISMATCH'].includes(error.code)) throw error;
        throw failure(error.code === 'CODEX_NOT_FOUND' ? 'CODEX_NOT_FOUND' : 'ACCOUNT_UNAVAILABLE', error.code === 'CODEX_NOT_FOUND' ? '本地服务未找到 Codex CLI，请检查启动服务的终端。' : '账号操作未完成。请重试或在 Codex CLI 中检查登录状态。');
      } finally { if (attempt?.status !== 'pending') await stop(); }
    },
    async close() {
      if (attempt) { attempt.status = 'cancelled'; attempt.url = null; attempt.user_code = null; }
      await stop();
    },
  };
}
