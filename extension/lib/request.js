/**
 * 请求构造与发送：preview（弹窗/管理页）和实际发送（后台）共用同一套逻辑，
 * 保证「预览看到的」就是「真正发出去的」。
 */
import { makeVars, modeForContentType, renderTemplate, unknownVariables } from './template.js';
import { markdownToHtml } from './markdown.js';

export const METHODS = ['POST', 'PUT', 'PATCH', 'GET', 'DELETE'];

export const CONTENT_TYPES = [
  { value: 'application/json', label: 'application/json' },
  { value: 'application/x-www-form-urlencoded', label: 'application/x-www-form-urlencoded' },
  { value: 'text/plain; charset=utf-8', label: 'text/plain' },
  { value: 'text/markdown; charset=utf-8', label: 'text/markdown' },
  { value: 'text/html; charset=utf-8', label: 'text/html' },
];

/**
 * HTTP 头部的值只允许 <= 0xFF 的字符（ByteString），夹中文等字符会让 fetch 直接抛错。
 * 这里按 RFC 2047 编成 =?UTF-8?B?...?= ，保证「能发出去」，并在预览里提示用户。
 */
export function encodeHeaderValue(value) {
  const text = String(value ?? '');
  if (!/[^\u0000-\u00ff]/.test(text)) return { value: text, encoded: false };
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { value: `=?UTF-8?B?${btoa(binary)}?=`, encoded: true };
}

/** 逐行解析自定义请求头："X-Token: abc" */
export function parseHeaderLines(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (name) out.push({ name, value });
  }
  return out;
}

export function validateWebhook(hook) {
  const problems = [];
  if (!hook) return ['地址不存在'];
  if (!String(hook.name || '').trim()) problems.push('名称不能为空');
  const url = String(hook.url || '').trim();
  if (!url) {
    problems.push('Webhook 地址不能为空');
  } else if (!/^https?:\/\/\S+$/i.test(url)) {
    problems.push('Webhook 地址必须以 http:// 或 https:// 开头');
  }
  if (!String(hook.template || '').trim()) problems.push('消息模板不能为空');
  if (!CONTENT_TYPES.some((c) => c.value === hook.contentType) && !/^[\w.+-]+\/[\w.+-]+/.test(String(hook.contentType || ''))) {
    problems.push('Content-Type 不合法');
  }
  return problems;
}

/**
 * 构造请求。
 * @param {object} hook 地址簿条目
 * @param {Record<string, unknown>} vars 变量表（一般由 makeVars 生成）
 * @param {{timeoutMs?: number}} [opts]
 * @returns {{url: string, method: string, headers: Record<string,string>, body: string|undefined, rawBody: string, mode: string, warnings: string[], vars: object}}
 */
export function buildRequest(hook, vars, opts = {}) {
  const mode = modeForContentType(hook.contentType);
  const template = String(hook.template || '').trim() || '{{ content }}';
  const body = renderTemplate(template, vars, { mode });

  const headers = {};
  const warnings = [];
  // 请求头的值同样支持 {{ 变量 }}（按原样插入，方便放 token / 标题）
  for (const h of parseHeaderLines(hook.headers)) {
    const rendered = renderTemplate(h.value, vars, { mode: 'raw' });
    const safe = encodeHeaderValue(rendered);
    if (safe.encoded) {
      warnings.push(`请求头「${h.name}」含非 ASCII 字符，已按 RFC 2047 编码发送；若服务端不识别，请把它放进请求体或改用 {{ xxx_url }}`);
    }
    headers[h.name] = safe.value;
  }
  const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
  if (!hasContentType) headers['Content-Type'] = hook.contentType || 'text/plain; charset=utf-8';

  const method = String(hook.method || 'POST').toUpperCase();
  let url = renderTemplate(String(hook.url || '').trim(), vars, { mode: 'url' });

  let payload = body;
  if (method === 'GET' || method === 'HEAD') {
    // GET/HEAD 不能带请求体：把渲染结果拼到查询串
    if (body) url += (url.includes('?') ? '&' : '?') + body;
    payload = undefined;
  }

  const unknown = [
    ...unknownVariables(template, vars),
    ...unknownVariables(String(hook.url || ''), vars),
    ...unknownVariables(String(hook.headers || ''), vars),
  ];
  if (unknown.length) warnings.push(`模板里有未知变量：${[...new Set(unknown)].join('、')}（已按空串替换）`);
  if (mode === 'json' && payload !== undefined) {
    try {
      JSON.parse(payload);
    } catch (err) {
      warnings.push(`请求体不是合法 JSON：${err.message}`);
    }
  }
  if (mode === 'url' && payload !== undefined && /[\s"<>]/.test(payload.replace(/%[0-9A-Fa-f]{2}/g, ''))) {
    warnings.push('表单请求体里含有未编码的空白或引号，请用 {{ content }} 占位（会自动做 URL 编码）');
  }

  return {
    url,
    method,
    headers,
    body: payload,
    rawBody: body,
    mode,
    template,
    vars,
    timeoutMs: opts.timeoutMs || 20000,
    warnings,
  };
}

/** 组装变量表；mdToHtml 为真时先把 Markdown 转成 HTML 再注入 {{ content }} */
export function buildVars(hook, input) {
  const vars = makeVars({ ...input, webhookName: hook?.name || '' });
  if (hook?.mdToHtml && input.format !== 'text') {
    vars.content = markdownToHtml(input.content);
  }
  return vars;
}

/** 真正发请求；任何异常都转成结构化结果，不抛出 */
export async function performRequest(req, opts = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = opts.timeoutMs || req.timeoutMs || 20000;
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'follow',
    });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      durationMs: Date.now() - started,
      contentType: res.headers.get('content-type') || '',
      responseText: text.length > 4000 ? `${text.slice(0, 4000)}\n…（已截断）` : text,
    };
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      statusText: aborted ? '超时' : '请求失败',
      durationMs: Date.now() - started,
      responseText: '',
      error: aborted
        ? `请求超时（>${timeout}ms）`
        : String((err && err.message) || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 一次完整的「构造 + 发送」 */
export async function sendOnce(hook, input, opts = {}) {
  const vars = buildVars(hook, input);
  const req = buildRequest(hook, vars, opts);
  const result = await performRequest(req, opts);
  return { request: req, result };
}
