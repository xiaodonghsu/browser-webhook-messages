/**
 * 数据层：地址簿 / 设置 / 发送记录的读写，导入导出，以及纯函数形式的规范化与合并。
 * 纯函数部分不依赖 chrome API，可直接在 Node 里测试。
 */

export const STORAGE_KEYS = { webhooks: 'webhooks', settings: 'settings', history: 'history' };

export const EXPORT_FORMAT = 'messagehook-addressbook';
export const EXPORT_VERSION = 1;
export const HISTORY_LIMIT = 30;

export const DEFAULT_CONTENT_TYPE = 'application/json';

export const DEFAULT_SETTINGS = {
  selectedId: '',
  format: 'markdown',
  title: '',
  draft: '',
  openManageAfterSave: false,
};

export function uid() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function defaultTemplate(contentType = DEFAULT_CONTENT_TYPE) {
  const ct = String(contentType).toLowerCase();
  if (ct.includes('json')) return '{\n  "content": "{{ content }}",\n  "title": "{{ title }}",\n  "url": "{{ url }}"\n}';
  if (ct.includes('x-www-form-urlencoded')) return 'title={{ title }}&content={{ content }}';
  if (ct.includes('html')) return '<h3>{{ title }}</h3>\n<p>{{ content }}</p>';
  return '{{ content }}';
}

/** 新建地址条目 */
export function newWebhook(patch = {}) {
  const contentType = patch.contentType || DEFAULT_CONTENT_TYPE;
  return normalizeWebhook({
    id: uid(),
    name: '',
    url: '',
    method: 'POST',
    contentType,
    headers: '',
    template: defaultTemplate(contentType),
    mdToHtml: false,
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...patch,
  });
}

/** 规范化：补默认值、裁掉多余字段，保证后续代码可以放心取值 */
export function normalizeWebhook(raw = {}) {
  const contentType = String(raw.contentType || raw.content_type || DEFAULT_CONTENT_TYPE).trim() || DEFAULT_CONTENT_TYPE;
  const hook = {
    id: String(raw.id || uid()),
    name: String(raw.name ?? raw.label ?? raw.title ?? '').trim(),
    url: String(raw.url ?? raw.webhook ?? raw.endpoint ?? '').trim(),
    method: String(raw.method || 'POST').toUpperCase(),
    contentType,
    headers: typeof raw.headers === 'string' ? raw.headers : stringifyHeaders(raw.headers),
    template: String(raw.template ?? raw.body ?? raw.messageTemplate ?? defaultTemplate(contentType)),
    mdToHtml: Boolean(raw.mdToHtml ?? raw.markdownToHtml ?? false),
    enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || new Date().toISOString(),
  };
  return hook;
}

export function stringifyHeaders(headers) {
  if (!headers) return '';
  if (Array.isArray(headers)) {
    return headers
      .filter((h) => h && (h.name || h.key))
      .map((h) => `${h.name || h.key}: ${h.value ?? ''}`)
      .join('\n');
  }
  if (typeof headers === 'object') {
    return Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n');
  }
  return String(headers);
}

/** 导出为可下载的 JSON 对象 */
export function exportPayload(webhooks, meta = {}) {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    app: 'MessageHook',
    ...meta,
    count: webhooks.length,
    webhooks: webhooks.map((w) => ({
      name: w.name,
      url: w.url,
      method: w.method,
      contentType: w.contentType,
      headers: w.headers,
      template: w.template,
      mdToHtml: w.mdToHtml,
      enabled: w.enabled,
    })),
  };
}

export function exportToText(webhooks, opts = {}) {
  return JSON.stringify(exportPayload(webhooks), null, opts.compact ? 0 : 2);
}

/**
 * 解析导入内容。宽容处理：数组、{webhooks:[]}、单个对象、带注释的 JSON 都能接受。
 * @returns {{ok: boolean, webhooks?: object[], error?: string, count?: number}}
 */
export function parseImport(text) {
  const src = String(text ?? '').trim();
  if (!src) return { ok: false, error: '内容为空' };

  let data;
  try {
    data = JSON.parse(src);
  } catch (err) {
    // 容错：去掉 // 与 /* */ 注释后再试一次
    try {
      data = JSON.parse(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''));
    } catch {
      return { ok: false, error: `不是合法的 JSON：${err.message}` };
    }
  }

  let list;
  if (Array.isArray(data)) list = data;
  else if (data && Array.isArray(data.webhooks)) list = data.webhooks;
  else if (data && Array.isArray(data.addressBook)) list = data.addressBook;
  else if (data && typeof data === 'object' && (data.url || data.webhook || data.endpoint)) list = [data];
  else return { ok: false, error: '未找到地址列表（需要数组或 { "webhooks": [...] }）' };

  const webhooks = list
    .filter((item) => item && typeof item === 'object')
    .map((item) => normalizeWebhook(item))
    .filter((w) => w.url || w.name || w.template);

  if (!webhooks.length) return { ok: false, error: '地址列表为空或缺少 url 字段' };
  if (data && data.format && data.format !== EXPORT_FORMAT) {
    return { ok: true, webhooks, count: webhooks.length, warning: `文件格式标记为「${data.format}」，已按通用格式解析` };
  }
  return { ok: true, webhooks, count: webhooks.length };
}

function uniqueName(existing, name) {
  const base = name || '未命名地址';
  const taken = new Set(existing.map((w) => w.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} (${n})`)) n += 1;
  return `${base} (${n})`;
}

/**
 * 合并导入结果。
 * @param {object[]} existing 现有地址
 * @param {object[]} incoming 导入地址
 * @param {{mode?: 'merge'|'replace', duplicate?: 'rename'|'overwrite'|'skip'}} opts
 */
export function mergeWebhooks(existing, incoming, opts = {}) {
  const mode = opts.mode || 'merge';
  const duplicate = opts.duplicate || 'rename';
  if (mode === 'replace') {
    return { webhooks: incoming.map((w) => normalizeWebhook(w)), added: incoming.length, replaced: 0, skipped: 0, renamed: 0 };
  }

  const list = existing.map((w) => normalizeWebhook(w));
  let added = 0;
  let replaced = 0;
  let skipped = 0;
  let renamed = 0;

  for (const raw of incoming) {
    const inc = normalizeWebhook(raw);
    const idx = list.findIndex((w) => w.name && w.name === inc.name && w.url === inc.url);
    if (idx >= 0) {
      if (duplicate === 'overwrite') {
        list[idx] = { ...inc, id: list[idx].id, createdAt: list[idx].createdAt };
        replaced += 1;
      } else if (duplicate === 'rename') {
        const name = uniqueName(list, inc.name);
        list.push({ ...inc, id: uid(), name });
        renamed += 1;
      } else {
        skipped += 1;
      }
      continue;
    }
    list.push(inc);
    added += 1;
  }
  return { webhooks: list, added, replaced, skipped, renamed };
}

/* ------------------------------ chrome.storage ------------------------------ */

function area() {
  return chrome.storage.local;
}

export async function loadAll() {
  const data = await area().get([STORAGE_KEYS.webhooks, STORAGE_KEYS.settings, STORAGE_KEYS.history]);
  const webhooks = Array.isArray(data[STORAGE_KEYS.webhooks])
    ? data[STORAGE_KEYS.webhooks].map((w) => normalizeWebhook(w))
    : [];
  const settings = { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEYS.settings] || {}) };
  const history = Array.isArray(data[STORAGE_KEYS.history]) ? data[STORAGE_KEYS.history] : [];
  return { webhooks, settings, history };
}

export async function loadWebhooks() {
  const { webhooks } = await loadAll();
  return webhooks;
}

export async function saveWebhooks(webhooks) {
  await area().set({ [STORAGE_KEYS.webhooks]: webhooks.map((w) => normalizeWebhook(w)) });
  return webhooks;
}

export async function loadSettings() {
  const data = await area().get(STORAGE_KEYS.settings);
  return { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEYS.settings] || {}) };
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await area().set({ [STORAGE_KEYS.settings]: next });
  return next;
}

export async function loadHistory() {
  const data = await area().get(STORAGE_KEYS.history);
  return Array.isArray(data[STORAGE_KEYS.history]) ? data[STORAGE_KEYS.history] : [];
}

export async function pushHistory(entry) {
  const list = await loadHistory();
  list.unshift({ id: uid(), at: new Date().toISOString(), ...entry });
  const trimmed = list.slice(0, HISTORY_LIMIT);
  await area().set({ [STORAGE_KEYS.history]: trimmed });
  return trimmed;
}

export async function clearHistory() {
  await area().set({ [STORAGE_KEYS.history]: [] });
}
