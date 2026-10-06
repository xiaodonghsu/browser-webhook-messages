/**
 * 模板引擎：把消息模板里的 {{ 变量 }} 替换成实际内容。
 *
 * 设计要点
 * - 裸变量（{{ content }}）按「编码方式」自动转义：
 *     json  → JSON 字符串转义（不含首尾引号），可直接放进 JSON 的引号内
 *     url   → encodeURIComponent（表单 / 查询串）
 *     raw   → 原样输出（纯文本、HTML）
 *   编码方式由地址簿里的 Content-Type 自动推导。
 * - 也可强制指定：{{ content_json }} / {{ content_url }} / {{ content_raw }}
 * - 未知变量替换为空串，并由 unknownVariables() 报出来，避免把 {{ xxx }} 原样发出去。
 */

/** 支持的 Content-Type → 编码方式 */
export function modeForContentType(contentType) {
  const ct = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (ct === 'application/json' || ct.endsWith('+json')) return 'json';
  if (ct === 'application/x-www-form-urlencoded') return 'url';
  return 'raw';
}

export const MODE_LABEL = { json: 'JSON 转义', url: 'URL 编码', raw: '原样输出' };

/** 按指定编码方式转义一个值 */
export function encodeFor(mode, value) {
  const text = value === undefined || value === null ? '' : String(value);
  switch (mode) {
    case 'json':
      // JSON.stringify 会转义 " \ 以及换行等控制字符，去掉首尾引号即可嵌入字符串字面量
      return JSON.stringify(text).slice(1, -1);
    case 'url':
      return encodeURIComponent(text);
    default:
      return text;
  }
}

/** 变量说明（用于界面上的提示与插入按钮） */
export const VARIABLE_DOCS = [
  { name: 'content', desc: '消息正文（按编码方式自动转义）' },
  { name: 'title', desc: '标题（页面标题或手动填写）' },
  { name: 'url', desc: '来源页面地址' },
  { name: 'format', desc: '内容格式：markdown / text / html' },
  { name: 'time', desc: '时间 HH:mm:ss' },
  { name: 'date', desc: '日期 YYYY-MM-DD' },
  { name: 'datetime', desc: '日期时间 YYYY-MM-DD HH:mm:ss' },
  { name: 'timestamp', desc: 'Unix 毫秒时间戳' },
  { name: 'webhook_name', desc: '当前地址名称' },
  { name: 'hostname', desc: '来源域名' },
];

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const SUFFIX_RE = /^(.*)_(raw|json|url)$/;

/** 列出模板里用到的变量名（去重，按出现顺序） */
export function placeholdersOf(template) {
  const out = [];
  for (const m of String(template ?? '').matchAll(PLACEHOLDER_RE)) {
    const name = m[1];
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** 解析 {{ name }} → { base, force }，force 为 _raw/_json/_url 后缀强制编码 */
function resolve(name, vars) {
  const m = SUFFIX_RE.exec(name);
  if (m && Object.prototype.hasOwnProperty.call(vars, m[1])) {
    return { base: m[1], force: m[2] };
  }
  if (Object.prototype.hasOwnProperty.call(vars, name)) {
    return { base: name, force: null };
  }
  return null;
}

/**
 * 渲染模板。
 * @param {string} template 含 {{ 变量 }} 的模板
 * @param {Record<string, unknown>} vars 变量表
 * @param {{mode?: 'json'|'url'|'raw'}} [opts]
 */
export function renderTemplate(template, vars, opts = {}) {
  const mode = opts.mode || 'raw';
  return String(template ?? '').replace(PLACEHOLDER_RE, (raw, name) => {
    const hit = resolve(name, vars || {});
    if (!hit) return '';
    return encodeFor(hit.force || mode, vars[hit.base]);
  });
}

/** 模板里引用了、但变量表里没有的名字 */
export function unknownVariables(template, vars) {
  const names = placeholdersOf(template).filter((n) => !resolve(n, vars || {}));
  return names;
}

/** 模板里是否含 {{ content }} 之类的正文占位符 */
export function hasContentPlaceholder(template) {
  return placeholdersOf(template).some((n) => {
    const m = SUFFIX_RE.exec(n);
    return (m ? m[1] : n) === 'content';
  });
}

/** 生成一次发送所需的完整变量表 */
export function makeVars(input = {}, now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  let hostname = '';
  try {
    hostname = input.url ? new URL(input.url).hostname : '';
  } catch {
    hostname = '';
  }
  return {
    content: input.content ?? '',
    title: input.title ?? '',
    url: input.url ?? '',
    format: input.format || 'markdown',
    time,
    date,
    datetime: `${date} ${time}`,
    timestamp: String(now.getTime()),
    webhook_name: input.webhookName ?? '',
    hostname,
  };
}
