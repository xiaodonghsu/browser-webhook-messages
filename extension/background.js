/**
 * 后台 Service Worker
 * - 统一负责真正的网络发送（弹窗关掉也不影响；同时避开页面 CORS 限制）
 * - 右键菜单：把选中文字 / 当前页面 / 链接直接推到某个地址
 * - 记录最近发送，用角标反馈成功失败
 */
import { loadAll, loadWebhooks, pushHistory, saveWebhooks } from './lib/storage.js';
import { buildRequest, buildVars, performRequest } from './lib/request.js';

const MENU_ROOT = 'mh-root';
const MENU_MANAGE = 'mh-open-manage';
const MENU_PREFIX = 'mh-send:';
const BADGE_MS = 4000;

let badgeTimer = null;

function flashBadge(ok, text) {
  chrome.action.setBadgeBackgroundColor({ color: ok ? '#16a34a' : '#dc2626' });
  chrome.action.setBadgeText({ text });
  if (badgeTimer) clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => chrome.action.setBadgeText({ text: '' }), BADGE_MS);
}

async function findHook(id) {
  const list = await loadWebhooks();
  return list.find((w) => w.id === id) || null;
}

/**
 * 发送一条消息。
 * @param {{webhookId?: string, webhook?: object, content: string, title?: string, url?: string, format?: string}} payload
 */
async function sendMessage(payload) {
  const hook = payload.webhook || (payload.webhookId ? await findHook(payload.webhookId) : null);
  if (!hook) {
    return { ok: false, error: '找不到对应的地址，可能已被删除' };
  }
  if (hook.enabled === false) {
    return { ok: false, error: `地址「${hook.name}」已停用` };
  }

  const input = {
    content: payload.content ?? '',
    title: payload.title ?? '',
    url: payload.url ?? '',
    format: payload.format || 'markdown',
  };
  const vars = buildVars(hook, input);
  const request = buildRequest(hook, vars);
  const result = await performRequest(request);

  // 只把可展示的摘要写进记录，避免把整个变量表存起来
  const summary = {
    url: request.url,
    method: request.method,
    headers: request.headers,
    body: request.rawBody,
    warnings: request.warnings,
  };

  await pushHistory({
    webhookId: hook.id,
    webhookName: hook.name,
    ok: result.ok,
    status: result.status,
    statusText: result.statusText,
    durationMs: result.durationMs,
    error: result.error || '',
    title: input.title,
    content: input.content.slice(0, 500),
    url: input.url,
    response: (result.responseText || '').slice(0, 300),
    source: payload.source || 'popup',
  });

  flashBadge(result.ok, result.ok ? 'OK' : 'ERR');
  return { ok: result.ok, result, request: summary, webhookName: hook.name };
}

/* --------------------------------- 右键菜单 --------------------------------- */

async function refreshContextMenus() {
  await chrome.contextMenus.removeAll();
  const { webhooks } = await loadAll();
  const enabled = webhooks.filter((w) => w.enabled !== false);

  chrome.contextMenus.create({
    id: MENU_ROOT,
    title: 'MessageHook 推送到手机',
    contexts: ['selection', 'page', 'link'],
  });
  chrome.contextMenus.create({
    id: MENU_MANAGE,
    parentId: MENU_ROOT,
    title: '管理地址簿…',
    contexts: ['selection', 'page', 'link'],
  });
  if (!enabled.length) {
    chrome.contextMenus.create({
      id: 'mh-empty',
      parentId: MENU_ROOT,
      title: '（还没有地址，先到地址簿添加）',
      enabled: false,
      contexts: ['selection', 'page', 'link'],
    });
    return;
  }
  for (const hook of enabled) {
    chrome.contextMenus.create({
      id: `${MENU_PREFIX}${hook.id}`,
      parentId: MENU_ROOT,
      title: `发送到「${hook.name || hook.url}」`,
      contexts: ['selection', 'page', 'link'],
    });
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const id = String(info.menuItemId);
  if (id === MENU_MANAGE) {
    chrome.tabs.create({ url: chrome.runtime.getURL('manage.html') });
    return;
  }
  if (!id.startsWith(MENU_PREFIX)) return;

  const webhookId = id.slice(MENU_PREFIX.length);
  const selection = (info.selectionText || '').trim();
  const content = selection || info.linkUrl || info.pageUrl || '';
  const title = (tab && tab.title) || selection.split('\n')[0].slice(0, 60) || '来自浏览器';
  const pageUrl = info.pageUrl || (tab && tab.url) || '';

  await sendMessage({
    webhookId,
    content,
    title,
    url: pageUrl,
    format: 'markdown',
    source: 'context-menu',
  });
});

/* --------------------------------- 消息通道 --------------------------------- */

const handlers = {
  async 'messagehook:send'(msg) {
    return sendMessage({ ...msg, source: msg.source || 'popup' });
  },
  async 'messagehook:list'() {
    const { webhooks, settings, history } = await loadAll();
    return { webhooks, settings, history };
  },
  async 'messagehook:save-webhooks'(msg) {
    await saveWebhooks(msg.webhooks || []);
    return { ok: true };
  },
  async 'messagehook:clear-history'() {
    await chrome.storage.local.set({ history: [] });
    return { ok: true };
  },
  async 'messagehook:open-manage'() {
    await chrome.tabs.create({ url: chrome.runtime.getURL('manage.html') });
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = msg && handlers[msg.type];
  if (!handler) return false;
  Promise.resolve(handler(msg))
    .then((res) => sendResponse(res))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true; // 异步响应
});

chrome.runtime.onInstalled.addListener((details) => {
  refreshContextMenus();
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('manage.html') });
  }
});

chrome.runtime.onStartup.addListener(refreshContextMenus);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.webhooks) refreshContextMenus();
});

refreshContextMenus();
