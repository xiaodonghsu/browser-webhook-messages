/**
 * 极简 Markdown → HTML 渲染器（无依赖）。
 * 支持：标题、段落、换行、粗体/斜体/删除线、行内代码、围栏代码块、
 *       有序/无序列表（含缩进嵌套）、引用、分割线、链接、图片、简单表格。
 * 定位是「把消息正文变成 webhook 能用的 HTML 片段」，不做完整 CommonMark。
 */

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

const BLOCK_START = /^(\s*(#{1,6})\s|\s*>|\s*([-*+]|\d+[.)])\s|\s*(```|~~~)|\s*\|)/;

/** 行内元素（先整体转义，再套用 Markdown 标记，避免正文里的 HTML 漏进结果） */
export function renderInline(text) {
  const codes = [];
  let s = escapeHtml(text).replace(/`([^`]+)`/g, (_m, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '<img src="$2" alt="$1">');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${codes[Number(i)]}</code>`);
  return s.replace(/\n/g, '<br>');
}

function isBlank(line) {
  return /^\s*$/.test(line);
}

function isHr(line) {
  return /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line);
}

function listItemInfo(line) {
  const m = /^([ \t]*)([-*+]|\d+[.)])[ \t]+(.*)$/.exec(line);
  if (!m) return null;
  return {
    indent: m[1].replace(/\t/g, '  ').length,
    ordered: /\d/.test(m[2]),
    text: m[3],
  };
}

function renderList(node) {
  const tag = node.ordered ? 'ol' : 'ul';
  const items = node.items.map((it) =>
    `<li>${renderInline(it.text)}${it.children ? renderList(it.children) : ''}</li>`);
  return `<${tag}>${items.join('')}</${tag}>`;
}

function buildList(lines, start) {
  const root = { indent: -1, ordered: false, items: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  let i = start;
  while (i < lines.length) {
    const info = listItemInfo(lines[i]);
    if (!info) {
      // 懒续行：缩进且上一项存在，则并入上一项
      if (/^\s+\S/.test(lines[i]) && top().items.length && !BLOCK_START.test(lines[i])) {
        top().items[top().items.length - 1].text += `\n${lines[i].trim()}`;
        i += 1;
        continue;
      }
      break;
    }
    // 缩进回退：关掉比当前项更深的列表层级
    while (stack.length > 1 && info.indent < top().indent) stack.pop();
    let node = top();
    // 比当前层更深，且当前层已有条目 → 挂到最后一个条目下面
    if (node.items.length && info.indent > node.indent) {
      const child = { indent: info.indent, ordered: info.ordered, items: [] };
      node.items[node.items.length - 1].children = child;
      stack.push(child);
      node = child;
    } else if (info.indent > node.indent) {
      node.indent = info.indent; // 记录本层缩进（root 起始为 -1）
      node.ordered = info.ordered; // 本层第一个条目的记号决定 ul / ol
    }
    node.items.push({ text: info.text, children: null });
    i += 1;
  }
  return { html: renderList(root), next: i };
}

function alignOf(sep) {
  const left = sep.startsWith(':');
  const right = sep.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return 'left';
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

export function markdownToHtml(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const fence = /^[ \t]*(```|~~~)[ \t]*([\w+#.-]*)[ \t]*$/.exec(line);
    if (fence) {
      const close = fence[1];
      const lang = fence[2];
      const buf = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^[ \\t]*${close}`).test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过结束围栏
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      out.push(`<pre><code${cls}>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    if (isBlank(line)) {
      i += 1;
      continue;
    }

    if (isHr(line)) {
      out.push('<hr>');
      i += 1;
      continue;
    }

    const heading = /^[ \t]{0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // 表格：表头 + 分隔行
    if (line.includes('|') && i + 1 < lines.length && /^[ \t]*\|?[ \t:|-]*-[ \t:|-]*\|?[ \t]*$/.test(lines[i + 1])) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map(alignOf);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].includes('|') && !isBlank(lines[i])) {
        body.push(splitRow(lines[i]));
        i += 1;
      }
      const th = head.map((c, k) => `<th style="text-align:${aligns[k] || 'left'}">${renderInline(c)}</th>`).join('');
      const rows = body.map((r) => `<tr>${head.map((_c, k) => `<td style="text-align:${aligns[k] || 'left'}">${renderInline(r[k] ?? '')}</td>`).join('')}</tr>`).join('');
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table>`);
      continue;
    }

    // 引用（支持嵌套）
    if (/^[ \t]{0,3}>/.test(line)) {
      const buf = [];
      while (i < lines.length && (/^[ \t]{0,3}>/.test(lines[i]) || (!isBlank(lines[i]) && buf.length))) {
        buf.push(lines[i].replace(/^[ \t]{0,3}>[ \t]?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${markdownToHtml(buf.join('\n'))}</blockquote>`);
      continue;
    }

    // 列表
    if (listItemInfo(line)) {
      const { html, next } = buildList(lines, i);
      out.push(html);
      i = next;
      continue;
    }

    // 段落
    const buf = [];
    while (i < lines.length && !isBlank(lines[i]) && !BLOCK_START.test(lines[i]) && !isHr(lines[i])) {
      buf.push(lines[i]);
      i += 1;
    }
    if (!buf.length) {
      // 防御：避免死循环
      buf.push(lines[i]);
      i += 1;
    }
    out.push(`<p>${renderInline(buf.join('\n'))}</p>`);
  }

  return out.join('\n');
}
