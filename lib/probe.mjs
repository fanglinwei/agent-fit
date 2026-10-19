import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checkPath } from './install.mjs';

const LIMIT = 2 * 1024 * 1024;
const valid = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\p{Cc}\p{Cf}]/u.test(value);
const fail = code => Object.assign(new Error(code), { code });
export function providerCredential(config, env = process.env) {
  const provider = config.model_providers?.[config.model_provider ?? 'openai'] ?? {};
  if (provider.env_key) return { source: valid(env[provider.env_key]) ? 'provider_environment' : 'not_confirmed', value: env[provider.env_key] };
  if (provider.experimental_bearer_token) return { source: valid(provider.experimental_bearer_token) ? 'provider_config' : 'not_confirmed', value: provider.experimental_bearer_token };
  return null;
}
async function fileAuth(home) {
  await checkPath(home, 'auth.json');
  const handle = await open(path.join(home, 'auth.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1024 * 1024 || process.platform !== 'win32' && (info.uid !== process.getuid() || (info.mode & 0o022))) throw fail('PROBE_AUTH_UNAVAILABLE');
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}
async function connection(home, config, env) {
  const name = config.model_provider ?? 'openai';
  const provider = config.model_providers?.[name] ?? {};
  if (name !== 'openai' && !valid(provider.base_url) || provider.wire_api && provider.wire_api !== 'responses' || provider.auth || provider.aws || provider.gateway_oauth) throw fail('PROBE_PROVIDER_UNSUPPORTED');
  let base = provider.base_url ?? env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
  const headers = new Headers();
  let credential;
  const configured = providerCredential(config, env);
  if (configured) {
    credential = configured.value;
    if (!valid(credential)) throw fail('PROBE_AUTH_UNAVAILABLE');
  } else if (name === 'openai' || provider.requires_openai_auth) {
    if (config.cli_auth_credentials_store && config.cli_auth_credentials_store !== 'file') throw fail('PROBE_AUTH_UNAVAILABLE');
    // The native account reader has already checked the selected home; never copy its auth file.
    const auth = await fileAuth(home).catch(() => { throw fail('PROBE_AUTH_UNAVAILABLE'); });
    credential = auth.auth_mode === 'chatgpt' ? null : auth.OPENAI_API_KEY;
    if ((!credential || auth.auth_mode === 'chatgpt') && auth.tokens?.access_token) {
      if (provider.base_url || name !== 'openai') throw fail('PROBE_PROVIDER_UNSUPPORTED');
      credential = auth.tokens.access_token;
      base = 'https://chatgpt.com/backend-api/codex';
      if (valid(auth.tokens.account_id)) headers.set('chatgpt-account-id', auth.tokens.account_id);
    }
    if (!valid(credential)) throw fail('PROBE_AUTH_UNAVAILABLE');
  }
  let url;
  try { url = new URL(base.replace(/\/+$/, '') + '/responses'); } catch { throw fail('PROBE_PROVIDER_UNSUPPORTED'); }
  if (url.username || url.password || url.search || url.hash || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw fail('PROBE_PROVIDER_UNSUPPORTED');
  for (const [key, value] of Object.entries(provider.query_params ?? {})) url.searchParams.set(key, value);
  for (const [key, value] of Object.entries(provider.http_headers ?? {})) headers.set(key, value);
  for (const [key, variable] of Object.entries(provider.env_http_headers ?? {})) if (env[variable]) headers.set(key, env[variable]);
  if (credential) {
    if (!valid(credential)) throw fail('PROBE_AUTH_UNAVAILABLE');
    headers.set('authorization', 'Bearer ' + credential);
  }
  headers.set('content-type', 'application/json');
  headers.set('accept', 'text/event-stream, application/json');
  return { url, headers };
}
export async function bindProbeAuthorization(home, config, env = process.env) {
  const fingerprint = ({ url, headers }) => createHash('sha256').update(JSON.stringify([url.href, [...headers]])).digest('hex');
  let expected, changed = false;
  try { expected = fingerprint(await connection(home, config, env)); }
  catch (error) { return async () => { throw error; }; }
  // Keep the binding private to this check; credentials and their digest never enter reports.
  return async () => {
    let current;
    try { current = await connection(home, config, env); }
    catch { changed = true; }
    if (!current || fingerprint(current) !== expected) changed = true;
    if (changed) throw fail('PROBE_AUTH_CHANGED');
    return current;
  };
}
async function responseData(response) {
  let bytes = 0, buffer = '', completed = null;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const stream = response.headers.get('content-type')?.includes('text/event-stream');
  const consume = line => {
    if (!line.startsWith('data:')) return;
    const value = line.slice(5).trim();
    if (!value || value === '[DONE]') return;
    const event = JSON.parse(value);
    if (['response.completed', 'response.failed', 'response.incomplete'].includes(event.type)) completed = event.response;
    if (event.type === 'error') throw fail('PROBE_RESPONSE_FAILED');
  };
  if (!response.body) throw fail('PROBE_RESPONSE_INVALID');
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > LIMIT) throw fail('PROBE_RESPONSE_LIMIT');
    buffer += decoder.decode(chunk, { stream: true });
    if (stream) {
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) { consume(buffer.slice(0, newline).trimEnd()); buffer = buffer.slice(newline + 1); }
    }
  }
  buffer += decoder.decode();
  if (!stream) return JSON.parse(buffer);
  if (buffer.trim()) consume(buffer.trimEnd());
  if (!completed) throw fail('PROBE_STREAM_INCOMPLETE');
  return completed;
}

export function usesProviderCatalog(config, env = process.env) {
  const name = config.model_provider ?? 'openai';
  return name !== 'openai' || Boolean(config.model_providers?.[name]?.base_url || env.OPENAI_BASE_URL);
}

export async function providerModels({ home, config, deadline }, internal = {}) {
  const result = { source: 'provider_models', status: 'incomplete', includes_hidden: null, pages: 0, models: [], revision: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
  try {
    const { url, headers } = await (internal.authorization ? internal.authorization() : connection(home, config, internal.env ?? process.env));
    url.pathname = url.pathname.replace(/\/responses$/, '/models');
    headers.set('accept', 'application/json');
    if (Date.now() >= deadline) throw fail('PROBE_TIMEOUT');
    const response = await (internal.fetch ?? fetch)(url, { method: 'GET', headers, redirect: 'error', signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw fail(({ 401: 'PROBE_AUTH_FAILED', 403: 'PROBE_ACCESS_DENIED', 429: 'PROBE_RATE_LIMITED' })[response.status] ?? 'PROVIDER_CATALOG_FAILED');
    }
    const data = await responseData(response);
    await internal.authorization?.();
    if (!Array.isArray(data?.data) || data.data.length > 1000 || data.data.some(model => !valid(model?.id) || model.id.length > 200 || model.id.trim() !== model.id)) throw fail('PROVIDER_CATALOG_INVALID');
    result.models = [...new Set(data.data.map(model => model.id))].map(id => ({ id, model: id, display_name: id, hidden: false, default_reasoning_effort: null, supported_reasoning_efforts: [], input_modalities: null }));
    result.pages = 1;
    // shortcut: provider pagination dialects differ; require a complete list before batch verification.
    if (data.has_more === true || data.next_cursor || data.nextCursor) throw fail('PROVIDER_CATALOG_PARTIAL');
    result.revision = createHash('sha256').update(JSON.stringify(result.models.map(model => model.id).sort())).digest('hex');
    result.status = 'complete';
  } catch (error) {
    result.reason_code = controller.signal.aborted ? 'PROBE_TIMEOUT' : /^(PROBE|PROVIDER)_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'PROVIDER_CATALOG_FAILED';
  } finally { clearTimeout(timer); }
  return result;
}

// No agent loop or tool executor exists here: even an unexpected call in output cannot execute.
export async function probeResponses({ home, config, pair, deadline }, internal = {}) {
  const result = { request_status: 'not_checked', access: 'unknown', actual_model: null, actual_effort: null, identity_status: 'unverified', reason_code: 'PROBE_RESPONSE_FAILED', http_status: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
  try {
    const { url, headers } = await (internal.authorization ? internal.authorization() : connection(home, config, internal.env ?? process.env));
    if (Date.now() >= deadline) throw fail('PROBE_TIMEOUT');
    result.request_status = 'incomplete';
    const response = await (internal.fetch ?? fetch)(url, {
      method: 'POST', headers, redirect: 'error', signal: controller.signal,
      body: JSON.stringify({ model: pair.model, ...(pair.effort === null ? {} : { reasoning: { effort: pair.effort } }), instructions: 'Reply with OK only.', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply with OK.' }] }], tools: [], tool_choice: 'none', store: false, stream: true }),
    });
    result.http_status = response.status;
    if (!response.ok) {
      // Project known error codes only; provider messages can contain credentials or private URLs.
      let rejection;
      try { rejection = await responseData(response); } catch { /* HTTP status still gives a safe result. */ }
      result.request_status = 'failed';
      if ([401, 403].includes(response.status)) result.access = 'denied';
      if (rejection?.error?.code === 'model_not_found' && [400, 404].includes(response.status)) {
        result.access = 'unavailable'; throw fail('PROBE_MODEL_NOT_FOUND');
      }
      if (response.status === 400 && ['reasoning', 'reasoning.effort'].includes(rejection?.error?.param)) throw fail('PROBE_EFFORT_UNSUPPORTED');
      if (response.status === 400 && ['reasoning', 'reasoning.effort', 'tool_choice', 'tools', 'stream', 'store', 'input'].includes(rejection?.error?.param)) throw fail('PROBE_PARAMETER_REJECTED');
      throw fail(({ 401: 'PROBE_AUTH_FAILED', 403: 'PROBE_ACCESS_DENIED', 429: 'PROBE_RATE_LIMITED' })[response.status] ?? 'PROBE_HTTP_FAILED');
    }
    const data = await responseData(response);
    await internal.authorization?.();
    if (data?.status !== 'completed') throw fail('PROBE_RESPONSE_FAILED');
    if (!Array.isArray(data.output) || !data.output.some(item => item.type === 'message') || data.output.some(item => !['message', 'reasoning'].includes(item.type))) throw fail('PROBE_UNEXPECTED_OUTPUT');
    result.request_status = 'succeeded'; result.access = 'available';
    result.actual_model = valid(data.model) && data.model.length <= 200 ? data.model : null;
    result.actual_effort = valid(data.reasoning?.effort) && data.reasoning.effort.length <= 40 ? data.reasoning.effort : null;
    if (pair.effort === null) {
      result.reason_code = 'PROBE_AVAILABLE';
      if (result.actual_model && result.actual_model !== pair.model) { result.identity_status = 'mismatch'; result.reason_code = 'PROBE_IDENTITY_MISMATCH'; }
    }
    else if (!result.actual_model || !result.actual_effort) result.reason_code = 'PROBE_IDENTITY_UNVERIFIED';
    else if (result.actual_model !== pair.model || result.actual_effort !== pair.effort) { result.identity_status = 'mismatch'; result.reason_code = 'PROBE_IDENTITY_MISMATCH'; }
    else { result.identity_status = 'matched'; result.reason_code = 'PROBE_VERIFIED'; }
  } catch (error) {
    result.reason_code = controller.signal.aborted ? 'PROBE_TIMEOUT' : /^PROBE_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'PROBE_NETWORK_FAILED';
  } finally { clearTimeout(timer); }
  return result;
}
