import { loadAll, saveSettings } from './lib/storage.js';
import { buildRequest, buildVars, validateWebhook } from './lib/request.js';
import { $, debounce, el, fmtTime, toast } from './lib/ui.js';

const state = {
  webhooks: [],
  settings: {},
  history: [],
  page: { title: '', url: '' },
  previewOn: false,
  sending: false,
};

const dom = {
  webhook: $('#webhook'),
  addHook: $('#add-hook'),
  openManage: $('#open-manage'),
  format: $('#format'),
  title: $('#title'),
  content: $('#content'),
  counter: $('#counter'),
  fillPage: $('#fill-page'),
  pageInfo: $('#page-info'),
  previewToggle: $('#preview-toggle'),
  preview: $('#preview'),
  result: $('#result'),
  send: $('#send'),
  clear: $('#clear'),
  historyCard: $('#history-card'),
  history: $('#history'),
  clearHistory: $('#clear-history'),
};

/* ---------------------------------- 初始化 ---------------------------------- */

async function init() {
  const [{ webhooks, settings, history }, tabs] = await Promise.all([
    loadAll(),
    chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []),
  ]);
  state.webhooks = webhooks;
  state.settings = settings;
  state.history = history;

  const tab = tabs && tabs[0];
  if (tab) {
    state.page = { title: tab.title || '', url: tab.url || '' };
    if (state.page.url && !/^https?:/i.test(state.page.url)) state.page.url = '';
  }

  dom.content.value = settings.draft || '';
  dom.title.value = settings.title || '';
  setFormat(settings.format || 'markdown', { silent: true });
  updateCounter();
  renderSelect();
  renderPageInfo();
  renderHistory();
  updatePreview();
  dom.content.focus();
}

function currentHook() {
  return state.webhooks.find((w) => w.id === dom.webhook.value) || null;
}

/* --------------------------------- 地址选择 --------------------------------- */

function renderSelect() {
  const enabled = state.webhooks.filter((w) => w.enabled !== false);
  const disabled = state.webhooks.filter((w) => w.enabled === false);
  dom.webhook.replaceChildren();

  if (!state.webhooks.length) {
    dom.webhook.append(el('option', { value: '', text: '（还没有地址，点右边 ＋ 添加）' }));
    dom.webhook.disabled = true;
  } else {
    dom.webhook.disabled = false;
    for (const hook of enabled) {
      dom.webhook.append(el('option', { value: hook.id, text: hook.name || hook.url }));
    }
    for (const hook of disabled) {
      dom.webhook.append(el('option', { value: hook.id, text: `${hook.name}（已停用）` }));
    }
    const wanted = enabled.some((w) => w.id === state.settings.selectedId)
      ? state.settings.selectedId
      : (enabled[0] || state.webhooks[0]).id;
    dom.webhook.value = wanted;
  }

  const hook = currentHook();
  dom.send.disabled = !hook || hook.enabled === false;
  dom.send.textContent = !state.webhooks.length
    ? '先去添加地址'
    : (hook && hook.enabled === false ? '该地址已停用' : '发送');
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function renderPageInfo() {
  const host = hostOf(state.page.url);
  dom.pageInfo.hidden = !host;
  dom.pageInfo.textContent = host;
  dom.pageInfo.title = state.page.url;
}

/* ---------------------------------- 预览 ---------------------------------- */

function renderPreview() {
  const hook = currentHook();
  const box = dom.preview;
  box.replaceChildren();

  if (!state.previewOn) {
    box.hidden = true;
    return;
  }
  box.hidden = false;

  if (!hook) {
    box.append(el('div', { class: 'notice warn', text: '请先选择一个推送地址' }));
    return;
  }

  const vars = buildVars(hook, {
    content: dom.content.value,
    title: dom.title.value || state.page.title,
    url: state.page.url,
    format: state.settings.format || 'markdown',
  });
  const req = buildRequest(hook, vars);

  const head = el('div', { class: 'row wrap' },
    el('span', { class: 'chip', text: req.method }),
    el('span', { class: 'chip', text: `编码：${req.mode}` }),
    hook.mdToHtml ? el('span', { class: 'chip', text: 'Markdown→HTML' }) : null);

  const urlBlock = el('pre', { class: 'mono-block', text: req.url });
  const headerText = Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\n');
  const bodyBlock = el('pre', { class: 'mono-block', text: req.body ?? '(无请求体，参数已拼到 URL)' });

  box.append(el('div', { class: 'card' },
    el('h3', { text: '请求预览' }),
    head,
    el('div', { class: 'hint', text: 'URL' }),
    urlBlock,
    el('div', { class: 'hint', text: '请求头' }),
    el('pre', { class: 'mono-block', text: headerText || '(无)' }),
    el('div', { class: 'hint', text: '请求体' }),
    bodyBlock,
    ...req.warnings.map((w) => el('div', { class: 'notice warn', style: 'margin-top:6px', text: w })),
  ));
}

const updatePreview = () => { if (state.previewOn) renderPreview(); };

function setFormat(format, opts = {}) {
  state.settings.format = format;
  for (const btn of dom.format.querySelectorAll('button')) {
    btn.classList.toggle('on', btn.dataset.format === format);
  }
  if (!opts.silent) persistSettings({ format });
  updatePreview();
}

function updateCounter() {
  const len = dom.content.value.length;
  dom.counter.textContent = len ? `${len} 字` : '';
}

const persistSettings = debounce((patch) => { saveSettings(patch); }, 350);

/* ---------------------------------- 发送 ---------------------------------- */

function renderResult(res) {
  const box = dom.result;
  box.replaceChildren();
  box.hidden = false;

  if (!res) return;
  if (res.error) {
    box.append(el('div', { class: 'notice err', text: `❌ ${res.error}` }));
    return;
  }

  const { result, request, webhookName } = res;
  const ok = result.ok;
  const title = ok ? '✅ 已发送' : '❌ 发送失败';
  const detail = result.status
    ? `${result.status} ${result.statusText || ''}`.trim()
    : (result.error || '未知错误');

  box.append(el('div', { class: `notice ${ok ? 'ok' : 'err'}` },
    el('div', { text: `${title} · ${webhookName || ''}` }),
    el('div', { class: 'hint', text: `${request.method} ${request.url}` }),
    el('div', { class: 'hint', text: `${detail} · 耗时 ${result.durationMs}ms` }),
  ));

  if (result.responseText) {
    box.append(el('details', {},
      el('summary', { text: '响应内容' }),
      el('div', {}, el('pre', { class: 'mono-block', text: result.responseText })),
    ));
  }
  if (request.warnings && request.warnings.length) {
    box.append(el('details', {},
      el('summary', { text: `请求提醒（${request.warnings.length}）` }),
      el('div', {}, ...request.warnings.map((w) => el('div', { class: 'hint', text: `· ${w}` }))),
    ));
  }
}

async function doSend() {
  if (state.sending) return;
  const hook = currentHook();

  if (!state.webhooks.length) {
    openManage();
    return;
  }
  if (!hook) {
    toast('请先选择推送地址', true);
    return;
  }
  const problems = validateWebhook(hook).filter((p) => !p.includes('名称'));
  if (problems.length) {
    toast(problems[0], true);
    openManage();
    return;
  }
  if (!dom.content.value.trim()) {
    toast('消息内容不能为空', true);
    dom.content.focus();
    return;
  }

  state.sending = true;
  dom.send.disabled = true;
  dom.send.textContent = '发送中…';
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'messagehook:send',
      webhookId: hook.id,
      content: dom.content.value,
      title: dom.title.value || state.page.title,
      url: state.page.url,
      format: state.settings.format || 'markdown',
      source: 'popup',
    });
    renderResult(res);
    if (res && res.ok) {
      toast('发送成功');
      await persistSettingsNow({ draft: dom.content.value, title: dom.title.value, selectedId: hook.id });
    } else {
      toast((res && (res.error || (res.result && res.result.error))) || '发送失败', true);
    }
  } catch (err) {
    renderResult({ error: String((err && err.message) || err) });
    toast('发送失败', true);
  } finally {
    state.sending = false;
    renderSelect();
    state.history = (await loadAll()).history;
    renderHistory();
  }
}

async function persistSettingsNow(patch) {
  state.settings = { ...state.settings, ...patch };
  await saveSettings(patch);
}

/* --------------------------------- 发送记录 --------------------------------- */

function renderHistory() {
  dom.history.replaceChildren();
  const items = state.history.slice(0, 6);
  dom.historyCard.hidden = items.length === 0;

  for (const item of items) {
    dom.history.append(el('button', {
      class: 'history-item',
      type: 'button',
      title: `${item.webhookName || ''} · ${item.status || item.error || ''}`,
      onclick: () => restoreHistory(item),
    },
      el('span', { class: `dot ${item.ok ? 'ok' : 'err'}` }),
      el('span', { class: 'txt', text: `${item.title ? `${item.title} · ` : ''}${item.content || ''}` }),
      el('span', { class: 'when', text: fmtTime(item.at) }),
    ));
  }
}

function restoreHistory(item) {
  dom.content.value = item.content || '';
  dom.title.value = item.title || '';
  updateCounter();
  if (item.webhookId && state.webhooks.some((w) => w.id === item.webhookId)) {
    dom.webhook.value = item.webhookId;
    persistSettingsNow({ selectedId: item.webhookId });
  }
  updatePreview();
  dom.content.focus();
  toast('已回填到编辑区');
}

/* --------------------------------- 页面交互 --------------------------------- */

function openManage() {
  chrome.tabs.create({ url: chrome.runtime.getURL('manage.html') });
}

function fillPageInfo() {
  if (!state.page.url && !state.page.title) {
    toast('当前页面没有可用的标题/地址', true);
    return;
  }
  if (!dom.title.value) dom.title.value = state.page.title;
  const snippet = `[${state.page.title || '当前页面'}](${state.page.url})`;
  dom.content.value = dom.content.value.trim()
    ? `${dom.content.value}\n\n${snippet}`
    : snippet;
  updateCounter();
  persistSettingsNow({ title: dom.title.value, draft: dom.content.value });
  updatePreview();
  dom.content.focus();
}

dom.format.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-format]');
  if (btn) setFormat(btn.dataset.format);
});

dom.webhook.addEventListener('change', () => {
  renderSelect();
  persistSettingsNow({ selectedId: dom.webhook.value });
  updatePreview();
});

dom.content.addEventListener('input', () => {
  updateCounter();
  persistSettings({ draft: dom.content.value });
  updatePreview();
});
dom.content.addEventListener('keydown', (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
    ev.preventDefault();
    doSend();
  }
});
dom.title.addEventListener('input', () => {
  persistSettings({ title: dom.title.value });
  updatePreview();
});

dom.previewToggle.addEventListener('click', () => {
  state.previewOn = !state.previewOn;
  dom.previewToggle.classList.toggle('primary', state.previewOn);
  dom.previewToggle.textContent = state.previewOn ? '收起预览' : '预览请求';
  renderPreview();
});

dom.send.addEventListener('click', doSend);
dom.fillPage.addEventListener('click', fillPageInfo);
dom.addHook.addEventListener('click', openManage);
dom.openManage.addEventListener('click', openManage);

dom.clear.addEventListener('click', () => {
  dom.content.value = '';
  dom.title.value = '';
  dom.result.hidden = true;
  updateCounter();
  persistSettingsNow({ draft: '', title: '' });
  updatePreview();
  dom.content.focus();
});

dom.clearHistory.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'messagehook:clear-history' });
  state.history = [];
  renderHistory();
  toast('记录已清除');
});

init();
