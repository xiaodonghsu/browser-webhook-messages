import { CONTENT_TYPES, METHODS, buildRequest, buildVars, validateWebhook } from './lib/request.js';
import { PRESETS, applyPreset } from './lib/presets.js';
import {
  exportToText, loadAll, mergeWebhooks, newWebhook, normalizeWebhook, parseImport, saveWebhooks, uid,
} from './lib/storage.js';
import { VARIABLE_DOCS } from './lib/template.js';
import { $, copyText, debounce, download, el, pickTextFile, toast } from './lib/ui.js';

const state = {
  webhooks: [],
  currentId: null,
  dirty: false,
  testBusy: false,
};

const dom = {
  list: $('#list'),
  listCount: $('#list-count'),
  editorTitle: $('#editor-title'),
  dirty: $('#dirty'),
  preset: $('#preset'),
  ioCard: $('#io-card'),
  ioTitle: $('#io-title'),
  ioText: $('#io-text'),
  ioDup: $('#io-dup'),
  ioResult: $('#io-result'),
  preview: $('#preview'),
  testResult: $('#test-result'),
  fields: {
    name: $('#f-name'),
    url: $('#f-url'),
    method: $('#f-method'),
    contentType: $('#f-ctype'),
    headers: $('#f-headers'),
    template: $('#f-template'),
    test: $('#f-test'),
    enabled: $('#f-enabled'),
    mdToHtml: $('#f-mdtohtml'),
  },
};

/* ---------------------------------- 初始化 ---------------------------------- */

function buildStaticOptions() {
  for (const m of METHODS) dom.fields.method.append(el('option', { value: m, text: m }));
  const list = $('#ctype-list');
  for (const ct of CONTENT_TYPES) list.append(el('option', { value: ct.value, text: ct.label }));

  const groups = new Map();
  for (const p of PRESETS) {
    if (!groups.has(p.group)) {
      const og = el('optgroup', { label: p.group });
      groups.set(p.group, og);
      dom.preset.append(og);
    }
    groups.get(p.group).append(el('option', { value: p.id, text: p.name }));
  }

  const vars = $('#vars');
  for (const v of VARIABLE_DOCS) {
    vars.append(el('button', {
      class: 'btn sm',
      type: 'button',
      title: v.desc,
      onclick: () => insertAtCursor(dom.fields.template, `{{ ${v.name} }}`),
    }, `{{ ${v.name} }}`));
  }
}

function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  textarea.setRangeText(text, start, end, 'end');
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.focus();
}

async function init() {
  buildStaticOptions();
  $('#ver').textContent = `v${chrome.runtime.getManifest().version}`;
  const { webhooks } = await loadAll();
  state.webhooks = webhooks;
  renderList();
  if (webhooks.length) selectHook(webhooks[0].id);
  else startNew();
  bindEvents();
}

/* --------------------------------- 地址列表 --------------------------------- */

function renderList() {
  dom.list.replaceChildren();
  dom.listCount.textContent = state.webhooks.length ? `（${state.webhooks.length}）` : '';

  if (!state.webhooks.length) {
    dom.list.append(el('div', { class: 'empty', text: '还没有地址，点左上角「新增地址」或在工具栏选择预设模板。' }));
    return;
  }

  for (const hook of state.webhooks) {
    const item = el('div', {
      class: `list-item${hook.id === state.currentId ? ' active' : ''}${hook.enabled === false ? ' off' : ''}`,
      onclick: () => selectHook(hook.id),
    },
      el('div', { class: 'name' },
        el('span', { text: hook.name || '(未命名)' }),
        hook.enabled === false ? el('span', { class: 'chip', text: '已停用' }) : null,
        hook.mdToHtml ? el('span', { class: 'chip', text: 'MD→HTML' }) : null,
      ),
      el('div', { class: 'url', text: hook.url || '(未填写地址)' }),
      el('div', { class: 'actions' },
        el('button', {
          class: 'btn sm', type: 'button', text: '复制',
          onclick: (ev) => { ev.stopPropagation(); duplicateHook(hook); },
        }),
        el('button', {
          class: 'btn sm', type: 'button', text: hook.enabled === false ? '启用' : '停用',
          onclick: (ev) => { ev.stopPropagation(); toggleEnabled(hook); },
        }),
        el('button', {
          class: 'btn sm danger', type: 'button', text: '删除',
          onclick: (ev) => { ev.stopPropagation(); deleteHook(hook.id); },
        }),
      ),
    );
    dom.list.append(item);
  }
}

/* ---------------------------------- 表单 ---------------------------------- */

function startNew(patch = {}) {
  const hook = newWebhook(patch);
  state.currentId = null;
  fillForm(hook);
  setDirty(false);
}

function selectHook(id) {
  if (state.dirty && state.currentId !== id && !confirm('当前修改尚未保存，确定放弃吗？')) return;
  const hook = state.webhooks.find((w) => w.id === id);
  if (!hook) return;
  state.currentId = id;
  fillForm(hook);
  setDirty(false);
  renderList();
}

function fillForm(hook) {
  const f = dom.fields;
  f.name.value = hook.name || '';
  f.url.value = hook.url || '';
  f.method.value = METHODS.includes(hook.method) ? hook.method : 'POST';
  f.contentType.value = hook.contentType || 'application/json';
  f.headers.value = hook.headers || '';
  f.template.value = hook.template || '';
  f.enabled.checked = hook.enabled !== false;
  f.mdToHtml.checked = Boolean(hook.mdToHtml);
  dom.editorTitle.textContent = state.currentId ? `编辑：${hook.name || '(未命名)'}` : '新建地址';
  updatePreview();
}

function readForm(base = {}) {
  const f = dom.fields;
  return normalizeWebhook({
    ...base,
    id: state.currentId || base.id || uid(),
    name: f.name.value.trim(),
    url: f.url.value.trim(),
    method: f.method.value,
    contentType: f.contentType.value.trim() || 'application/json',
    headers: f.headers.value,
    template: f.template.value,
    enabled: f.enabled.checked,
    mdToHtml: f.mdToHtml.checked,
    updatedAt: new Date().toISOString(),
  });
}

function setDirty(value) {
  state.dirty = value;
  dom.dirty.hidden = !value;
}

async function persist(list, message) {
  state.webhooks = list.map((w) => normalizeWebhook(w));
  await saveWebhooks(state.webhooks);
  renderList();
  if (message) toast(message);
}

async function saveForm() {
  const hook = readForm(state.webhooks.find((w) => w.id === state.currentId) || {});
  const problems = validateWebhook(hook).filter((p) => p !== '消息模板不能为空');
  if (problems.length) {
    toast(problems[0], true);
    return;
  }
  const list = [...state.webhooks];
  const idx = list.findIndex((w) => w.id === hook.id);
  if (idx >= 0) list[idx] = { ...hook, createdAt: list[idx].createdAt };
  else list.push(hook);

  state.currentId = hook.id;
  await persist(list, '已保存');
  setDirty(false);
  dom.editorTitle.textContent = `编辑：${hook.name || '(未命名)'}`;
}

function resetForm() {
  const hook = state.currentId ? state.webhooks.find((w) => w.id === state.currentId) : null;
  if (hook) fillForm(hook);
  else fillForm(newWebhook());
  setDirty(false);
}

async function deleteHook(id) {
  const hook = state.webhooks.find((w) => w.id === id);
  if (!hook) return;
  if (!confirm(`确定删除「${hook.name || hook.url}」？`)) return;
  const list = state.webhooks.filter((w) => w.id !== id);
  if (state.currentId === id) {
    state.currentId = null;
    setDirty(false);
  }
  await persist(list, '已删除');
  if (state.currentId === null) {
    if (list.length) selectHook(list[0].id);
    else startNew();
  }
}

async function duplicateHook(hook) {
  const copy = normalizeWebhook({ ...hook, id: uid(), name: `${hook.name || '未命名'} 副本`, createdAt: undefined, updatedAt: undefined });
  const list = [...state.webhooks, copy];
  await persist(list, '已复制');
  selectHook(copy.id);
}

async function toggleEnabled(hook) {
  const list = state.webhooks.map((w) => (w.id === hook.id ? { ...w, enabled: w.enabled === false, updatedAt: new Date().toISOString() } : w));
  await persist(list);
  if (state.currentId === hook.id) fillForm(state.webhooks.find((w) => w.id === hook.id));
}

/* --------------------------------- 预览/测试 -------------------------------- */

function updatePreview() {
  const hook = readForm(state.webhooks.find((w) => w.id === state.currentId) || {});
  const vars = buildVars(hook, {
    content: dom.fields.test.value,
    title: '示例标题',
    url: 'https://example.com/page',
    format: 'markdown',
  });
  const req = buildRequest(hook, vars);

  dom.preview.replaceChildren(
    el('div', { class: 'row wrap' },
      el('span', { class: 'chip', text: req.method }),
      el('span', { class: 'chip', text: `编码：${req.mode}` }),
      hook.mdToHtml ? el('span', { class: 'chip warn', text: '发送前 Markdown→HTML' }) : null,
    ),
    el('div', { class: 'hint', text: 'URL' }),
    el('pre', { class: 'mono-block', text: req.url }),
    el('div', { class: 'hint', text: '请求头' }),
    el('pre', { class: 'mono-block', text: Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\n') || '(无)' }),
    el('div', { class: 'hint', text: '请求体' }),
    el('pre', { class: 'mono-block', text: req.body ?? '(无请求体，参数已拼到 URL)' }),
    ...req.warnings.map((w) => el('div', { class: 'notice warn', style: 'margin-top:6px', text: w })),
  );
}

async function testSend() {
  if (state.testBusy) return;
  const hook = readForm(state.webhooks.find((w) => w.id === state.currentId) || {});
  const problems = validateWebhook(hook).filter((p) => p !== '消息模板不能为空');
  if (problems.length) {
    toast(problems[0], true);
    return;
  }

  state.testBusy = true;
  const btn = $('#btn-test');
  btn.disabled = true;
  btn.textContent = '发送中…';
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'messagehook:send',
      webhook: hook,
      content: dom.fields.test.value,
      title: 'MessageHook 测试',
      url: 'https://example.com/page',
      format: 'markdown',
      source: 'manage-test',
    });
    renderTestResult(res, hook);
  } catch (err) {
    renderTestResult({ error: String((err && err.message) || err) }, hook);
  } finally {
    state.testBusy = false;
    btn.disabled = false;
    btn.textContent = '测试发送';
  }
}

function renderTestResult(res, hook) {
  dom.testResult.replaceChildren();
  if (!res) return;
  if (res.error) {
    dom.testResult.append(el('div', { class: 'notice err', text: `❌ ${res.error}` }));
    return;
  }
  const { result, request } = res;
  dom.testResult.append(el('div', { class: `notice ${result.ok ? 'ok' : 'err'}` },
    el('div', { text: `${result.ok ? '✅ 发送成功' : '❌ 发送失败'} · ${hook.name || '(未命名)'}` }),
    el('div', { class: 'hint', text: `${request.method} ${request.url}` }),
    el('div', {
      class: 'hint',
      text: result.status ? `${result.status} ${result.statusText || ''} · 耗时 ${result.durationMs}ms` : (result.error || ''),
    }),
  ));
  if (result.responseText) {
    dom.testResult.append(el('details', {},
      el('summary', { text: '响应内容' }),
      el('div', {}, el('pre', { class: 'mono-block', text: result.responseText })),
    ));
  }
}

/* --------------------------------- 导入导出 -------------------------------- */

function openIo(text = '') {
  dom.ioCard.hidden = false;
  dom.ioTitle.textContent = '导入地址簿';
  dom.ioText.value = text;
  dom.ioResult.replaceChildren();
  if (!text) dom.ioText.focus();
}

async function confirmImport() {
  const parsed = parseImport(dom.ioText.value);
  if (!parsed.ok) {
    dom.ioResult.replaceChildren(el('div', { class: 'notice err', text: `导入失败：${parsed.error}` }));
    return;
  }
  const mode = document.querySelector('input[name="io-mode"]:checked').value;
  const duplicate = dom.ioDup.value;
  const { webhooks, added, replaced, skipped, renamed } = mergeWebhooks(state.webhooks, parsed.webhooks, { mode, duplicate });
  await persist(webhooks);
  const parts = [`新增 ${added}`];
  if (replaced) parts.push(`覆盖 ${replaced}`);
  if (renamed) parts.push(`改名保留 ${renamed}`);
  if (skipped) parts.push(`跳过 ${skipped}`);
  dom.ioResult.replaceChildren(el('div', { class: 'notice ok', text: `导入成功：${parts.join('，')}（当前共 ${webhooks.length} 条）` }));
  if (parsed.warning) dom.ioResult.append(el('div', { class: 'notice warn', style: 'margin-top:6px', text: parsed.warning }));
  toast('导入完成');
  if (webhooks.length) selectHook(webhooks[webhooks.length - 1].id);
}

function exportFileName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `messagehook-addressbook-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
}

function requireData() {
  if (!state.webhooks.length) {
    toast('地址簿是空的，没有可导出的内容', true);
    return false;
  }
  return true;
}

/* ---------------------------------- 事件 ---------------------------------- */

function bindEvents() {
  $('#btn-new').addEventListener('click', () => {
    if (state.dirty && !confirm('当前修改尚未保存，确定放弃吗？')) return;
    startNew();
    renderList();
  });

  $('#btn-popup').addEventListener('click', () => {
    chrome.windows.create({ url: chrome.runtime.getURL('popup.html'), type: 'popup', width: 440, height: 680 });
  });

  dom.preset.addEventListener('change', () => {
    const preset = PRESETS.find((p) => p.id === dom.preset.value);
    dom.preset.value = '';
    if (!preset) return;
    if (state.dirty && !confirm('将用预设模板覆盖当前表单内容，确定继续吗？')) return;
    const base = readForm(state.webhooks.find((w) => w.id === state.currentId) || {});
    const next = normalizeWebhook(applyPreset(preset, { ...base, name: base.name || '' }));
    fillForm(next);
    setDirty(true);
    toast(`已套用预设：${preset.name}`);
  });

  $('#btn-save').addEventListener('click', saveForm);
  $('#btn-reset').addEventListener('click', resetForm);
  $('#btn-test').addEventListener('click', testSend);
  $('#btn-delete').addEventListener('click', () => { if (state.currentId) deleteHook(state.currentId); });

  const onEdit = () => { setDirty(true); updatePreviewDebounced(); };
  for (const key of ['name', 'url', 'method', 'contentType', 'headers', 'template', 'enabled', 'mdToHtml']) {
    dom.fields[key].addEventListener('input', onEdit);
    dom.fields[key].addEventListener('change', onEdit);
  }
  dom.fields.test.addEventListener('input', updatePreviewDebounced);
  dom.fields.template.addEventListener('keydown', (ev) => {
    if (ev.key === 'Tab') {
      ev.preventDefault();
      insertAtCursor(dom.fields.template, '  ');
    }
  });

  $('#btn-import-file').addEventListener('click', async () => {
    const text = await pickTextFile('.json,application/json');
    if (text === null) return;
    openIo(text);
  });
  $('#btn-import-paste').addEventListener('click', () => openIo(''));
  $('#btn-io-cancel').addEventListener('click', () => { dom.ioCard.hidden = true; });
  $('#btn-io-confirm').addEventListener('click', confirmImport);
  $('#btn-export-file').addEventListener('click', () => {
    if (!requireData()) return;
    download(exportFileName(), exportToText(state.webhooks));
    toast('已导出文件');
  });
  $('#btn-export-clipboard').addEventListener('click', async () => {
    if (!requireData()) return;
    const ok = await copyText(exportToText(state.webhooks));
    toast(ok ? '地址簿 JSON 已复制到剪贴板' : '复制失败，请改用导出文件', !ok);
  });

  window.addEventListener('beforeunload', (ev) => {
    if (!state.dirty) return;
    ev.preventDefault();
    ev.returnValue = '';
  });
}

const updatePreviewDebounced = debounce(updatePreview, 250);

init();
