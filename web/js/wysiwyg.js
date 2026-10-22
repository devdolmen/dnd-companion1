// Tome & Table — WYSIWYG markdown editing for notes (contract: docs/superpowers/specs/2026-10-13-multiuser-server-design.md §5).
// htmlToMarkdown() turns markdown.js output and browser-made contenteditable HTML back into markdown; createEditor() mounts a
// div.wysiwyg.md editing surface with toolbar commands, [[wikilink]] conversion, wikilink/tag clicks and task checkboxes.
import { render, escapeHtml } from './markdown.js';

// ================================================================ HTML → markdown

const FENCE = '```';
const NBSP = '\u00a0';
const ZWSP = '\u200b';
const ZW_RE = /[\u200b\ufeff]/g;
const LAYOUT_WS = /^[ \t\n\r]*$/;
const BLOCK_TAGS = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'CAPTION', 'CENTER', 'DD', 'DETAILS', 'DIV', 'DL', 'DT',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV',
  'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL']);
const IGNORED_TAGS = new Set(['AUDIO', 'BUTTON', 'CANVAS', 'HEAD', 'IFRAME', 'LINK', 'META', 'NOSCRIPT', 'OBJECT', 'OPTION',
  'SCRIPT', 'SELECT', 'STYLE', 'SVG', 'TEMPLATE', 'TEXTAREA', 'TITLE', 'VIDEO']);
const ROOT_AS_BLOCK = new Set(['BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'LI', 'OL', 'P', 'PRE', 'TABLE', 'UL']);
const ENTITIES = { lt: '<', gt: '>', quot: '"', '#39': "'", amp: '&' };
// Same pattern as markdown.js WIKI_RE, applied to the raw source.
const WIKI_SRC = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;

const tagOf = (n) => (n && n.nodeType === 1 ? String(n.nodeName).toUpperCase() : '');
const isText = (n) => !!n && n.nodeType === 3;
const isBlock = (n) => BLOCK_TAGS.has(tagOf(n));
const isList = (n) => tagOf(n) === 'UL' || tagOf(n) === 'OL';
const isCheckbox = (n) => tagOf(n) === 'INPUT' && String(n.getAttribute('type') || '').toLowerCase() === 'checkbox';
const hasClass = (n, c) => !!(n && n.classList && n.classList.contains(c));
const cleanText = (s) => String(s).replace(ZW_RE, '').replace(/\u00a0/g, ' ').replace(/\r\n?|\n/g, ' ');
const oneLine = (s) => s.split('\n').filter((l) => l.trim()).join(' ');
const wrapLines = (s, d) => s.split('\n').map((l) => (l.trim() ? d + l + d : l)).join('\n');
const outsideCode = (s) => s.replace(/`[^`\n]*`/g, '');
const urlPart = (u) => String(u).trim().replace(/\s/g, '%20').replace(/\)/g, '%29');
// markdown.js escapes wikilink titles twice (its pattern runs on escaped text), so its DOM holds e.g. "&amp;"; undo one level.
const unescapeOnce = (s) => String(s).replace(/&(lt|gt|quot|#39|amp);/g, (_, k) => ENTITIES[k]);
const cleanTitle = (s) => String(s == null ? '' : s).replace(/[[\]|#\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();

function textNodes(node) {
  if (isText(node)) return [node];
  const out = [];
  const walker = (node.ownerDocument || document).createTreeWalker(node, 4 /* NodeFilter.SHOW_TEXT */);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) out.push(t);
  return out;
}
const firstText = (node) => textNodes(node)[0] || null;
const lastText = (node) => { const all = textNodes(node); return all[all.length - 1] || null; };

/** Serialize an element's content (the editor root, or any rendered / edited HTML) to markdown. */
export function htmlToMarkdown(rootElement) {
  if (!rootElement) return '';
  // Normalise in place (only touches the DOM when a block was left inside a <p>/<h*>, which browsers sometimes do).
  const src = rootElement.querySelector ? liftNestedBlocks(rootElement) : rootElement;
  const nodes = ROOT_AS_BLOCK.has(tagOf(src)) ? [src] : Array.from(src.childNodes || []);
  return tidy(blocksMd(nodes, {}).join('\n\n'));
}

// Browsers sometimes leave a list, quote or table inside a <p>/<h*> (e.g. insertUnorderedList in Chrome).
// Move such blocks out so they sit beside the paragraph; drop the paragraph if nothing is left in it.
export function liftNestedBlocks(root) {
  const LIFT = 'ul, ol, blockquote, table, pre, hr, h1, h2, h3, h4, h5, h6';
  let guard = 0;
  let hit;
  while ((hit = Array.from(root.querySelectorAll(LIFT)).find((b) => b.parentNode && /^(P|H[1-6])$/.test(b.parentNode.tagName))) && guard++ < 500) {
    const par = hit.parentNode;
    const after = document.createElement(par.tagName.toLowerCase());
    while (hit.nextSibling) after.appendChild(hit.nextSibling);
    par.parentNode.insertBefore(hit, par.nextSibling);
    if (after.textContent.trim() || after.querySelector('img, input')) hit.parentNode.insertBefore(after, hit.nextSibling);
    if (!par.textContent.trim() && !par.querySelector('img, input')) par.remove();
  }
  return root;
}

// At most one blank line between blocks and none at the ends; blank lines inside fenced code stay as they are.
function tidy(md) {
  const out = [];
  let fence = false;
  for (const line of md.split('\n')) {
    if (/^```/.test(line)) fence = !fence;
    if (!fence && !line.trim()) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }
    out.push(line);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join('\n');
}

// Block-level children → list of markdown blocks; runs of inline nodes (loose text, <br>, <b>…) become paragraphs.
function blocksMd(nodes, ctx) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length) {
      const p = paragraphMd(run, ctx);
      if (p) out.push(p);
      run = [];
    }
  };
  for (const n of Array.from(nodes)) {
    if (isBlock(n)) {
      flush();
      const b = blockMd(n, ctx);
      if (b && b.trim()) out.push(b);
    } else run.push(n);
  }
  flush();
  return out;
}

function blockMd(n, ctx) {
  const tag = tagOf(n);
  const h = /^H([1-6])$/.exec(tag);
  if (h) {
    const text = oneLine(inlineMd(n.childNodes, ctx)).replace(/^\s+/, '');
    return text ? `${'#'.repeat(Number(h[1]))} ${text}` : '';
  }
  switch (tag) {
    case 'P': return paragraphMd(n.childNodes, ctx);
    case 'HR': return '---';
    case 'PRE': return preMd(n);
    case 'UL': case 'OL': return listMd(n, 0, ctx);
    case 'LI': return itemMd(n, 0, '-', ctx);
    case 'BLOCKQUOTE': {
      const inner = blocksMd(n.childNodes, ctx).join('\n\n');
      return inner.trim() ? inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n') : '';
    }
    case 'TABLE': case 'THEAD': case 'TBODY': case 'TFOOT': case 'TR': return tableMd(n, ctx);
    case 'TD': case 'TH': return paragraphMd(n.childNodes, ctx);
    default: return blocksMd(n.childNodes, ctx).join('\n\n'); // div (also div.table-wrap), section, …
  }
}

// A paragraph keeps its <br> line breaks as newlines (markdown.js joins paragraph lines with <br>).
function paragraphMd(nodes, ctx) {
  const out = [];
  for (const line of inlineMd(nodes, ctx).split('\n')) {
    if (line.trim()) out.push(line);
    else if (out.length && out[out.length - 1] !== '') out.push('');
  }
  if (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

// Inline content → markdown text with "\n" for hard line breaks. ctx: { strong, em, del, mark, emMark, skip }.
function inlineMd(nodes, ctx) {
  const list = Array.from(nodes);
  let out = '';
  for (let i = 0; i < list.length; i++) {
    const n = list[i];
    if (n === ctx.skip) continue;
    if (isText(n)) { out += cleanText(n.data); continue; }
    if (n.nodeType !== 1) continue;
    const kinds = wrapKinds(n);
    if (!kinds) { out += inlineEl(n, ctx); continue; }
    const key = kinds.join();
    const kids = Array.from(n.childNodes);
    // <b>a</b><b>b</b> → **ab**: adjacent runs with the same formatting are merged
    while (i + 1 < list.length && (wrapKinds(list[i + 1]) || []).join() === key) kids.push(...list[++i].childNodes);
    out += wrapMd(kinds, kids, ctx);
  }
  return out;
}

function wrapKinds(n) {
  switch (tagOf(n)) {
    case 'B': case 'STRONG': return ['strong'];
    case 'I': case 'EM': return ['em'];
    case 'S': case 'STRIKE': case 'DEL': return ['del'];
    case 'MARK': return ['mark'];
    case 'SPAN': case 'FONT': {
      const st = n.style || {};
      const kinds = [];
      const fw = String(st.fontWeight || '').toLowerCase();
      if (fw === 'bold' || fw === 'bolder' || Number(fw) >= 600) kinds.push('strong');
      if (/italic|oblique/.test(String(st.fontStyle || '').toLowerCase())) kinds.push('em');
      if (/line-through/.test(`${st.textDecoration || ''} ${st.textDecorationLine || ''}`.toLowerCase())) kinds.push('del');
      return kinds.length ? kinds : null;
    }
    default: return null;
  }
}

function wrapMd(kinds, nodes, ctx) {
  if (!kinds.length) return inlineMd(nodes, ctx);
  const [kind, ...rest] = kinds;
  const inner = (c) => wrapMd(rest, nodes, c);
  if (ctx[kind]) return inner(ctx); // <b> inside <b>: nothing to add
  if (kind === 'strong') {
    // markdown.js: **x** may not contain "*" and __x__ may not contain "_"; nested em then uses the other character.
    let s = inner({ ...ctx, strong: true, emMark: '*' });
    if (!outsideCode(s).includes('*')) return wrapLines(s, '**');
    if (!outsideCode(s).includes('_')) return wrapLines(s, '__');
    s = inner({ ...ctx, strong: true, emMark: '_' });
    return wrapLines(s, '**');
  }
  if (kind === 'em') {
    const s = inner({ ...ctx, em: true });
    return wrapLines(s, ctx.emMark || (outsideCode(s).includes('*') ? '_' : '*'));
  }
  if (kind === 'del') return wrapLines(inner({ ...ctx, del: true }), '~~');
  return wrapLines(inner({ ...ctx, mark: true }), '==');
}

function inlineEl(n, ctx) {
  const tag = tagOf(n);
  if (IGNORED_TAGS.has(tag)) return '';
  switch (tag) {
    case 'BR': return '\n';
    case 'IMG': {
      const src = n.getAttribute('src') || '';
      return src ? `![${cleanText(n.getAttribute('alt') || '')}](${urlPart(src)})` : '';
    }
    case 'INPUT': return isCheckbox(n) ? (n.checked ? '[x]' : '[ ]') : '';
    case 'CODE': case 'KBD': case 'SAMP': case 'TT': {
      const code = cleanText(n.textContent || '');
      return code ? `\`${code}\`` : '';
    }
    case 'A': return anchorMd(n, ctx);
    default: break;
  }
  if (isBlock(n)) {
    // a block inside inline content (li > p, td > div, …) contributes its own line(s)
    if (tag === 'PRE') return `\n${preText(n)}\n`;
    if (tag === 'HR') return '\n';
    return `\n${inlineMd(n.childNodes, ctx)}\n`;
  }
  return inlineMd(n.childNodes, ctx); // u, ins, span, font, sub, sup, label, …: keep the content only
}

function anchorMd(a, ctx) {
  const text = cleanText(a.textContent || '').trim();
  if (hasClass(a, 'wikilink') || a.hasAttribute('data-title')) {
    const label = unescapeOnce(text);
    const title = unescapeOnce(a.getAttribute('data-title') || '').replace(/\s+/g, ' ').trim() || label;
    if (!title || !label) return '';
    return label === title ? `[[${title}]]` : `[[${title}|${label}]]`;
  }
  if (hasClass(a, 'tag') || a.hasAttribute('data-tag')) {
    if (/^#\S/.test(text)) return text;
    const tag = String(a.getAttribute('data-tag') || text).replace(/^#+/, '').trim();
    return tag ? `#${tag}` : '';
  }
  const label = inlineMd(a.childNodes, ctx).replace(/\s*\n\s*/g, ' ');
  const href = a.getAttribute('href');
  if (!href) return label;
  return `[${label.trim() ? label : href}](${urlPart(href)})`;
}

function preText(pre) {
  let s = '';
  let synthetic = false; // the last "\n" came from a <br> or block boundary rather than from the code text
  const walk = (node) => {
    for (const c of Array.from(node.childNodes)) {
      if (isText(c)) {
        const t = c.data.replace(ZW_RE, '').replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n');
        if (t) { s += t; synthetic = false; }
      } else if (tagOf(c) === 'BR') {
        s += '\n';
        synthetic = true;
      } else if (c.nodeType === 1 && !IGNORED_TAGS.has(tagOf(c))) {
        const block = isBlock(c);
        if (block && s && !s.endsWith('\n')) { s += '\n'; synthetic = true; }
        walk(c);
        if (block && s && !s.endsWith('\n')) { s += '\n'; synthetic = true; }
      }
    }
  };
  walk(pre);
  return synthetic && s.endsWith('\n') ? s.slice(0, -1) : s;
}

function preMd(pre) {
  const code = Array.from(pre.children || []).find((c) => tagOf(c) === 'CODE');
  const cls = String((code && code.getAttribute('class')) || pre.getAttribute('class') || '').trim();
  const m = /^lang(?:uage)?-(.+)$/.exec(cls) || /(?:^|\s)lang(?:uage)?-(\S+)/.exec(cls);
  const text = preText(pre);
  return `${FENCE}${m ? m[1].trim() : ''}\n${text ? `${text}\n` : ''}${FENCE}`;
}

function listMd(list, depth, ctx) {
  const lines = [];
  let num = 0;
  for (const c of Array.from(list.childNodes)) {
    if (isList(c)) { // Chrome's indent produces ul > ul: a nested list without a parent item
      const s = listMd(c, depth + 1, ctx);
      if (s) lines.push(s);
      continue;
    }
    if (isText(c)) { if (!cleanText(c.data).trim()) continue; } else if (c.nodeType !== 1) continue;
    num += 1;
    lines.push(itemMd(c, depth, tagOf(list) === 'OL' ? `${num}.` : '-', ctx));
  }
  return lines.join('\n');
}

function itemMd(item, depth, marker, ctx) {
  const kids = tagOf(item) === 'LI' ? Array.from(item.childNodes) : [item];
  const own = kids.filter((k) => !isList(k));
  const first = firstLeaf(own);
  const box = isCheckbox(first) ? first : null;
  const task = box ? `[${box.checked ? 'x' : ' '}] ` : hasClass(item, 'task') ? '[ ] ' : '';
  // markdown.js list items are single lines: <br>s and p/div children are joined with spaces
  const body = oneLine(inlineMd(own, { ...ctx, skip: box })).replace(/^\s+/, '');
  let md = `${'  '.repeat(depth)}${marker} ${task}${body}`;
  for (const nested of kids.filter(isList)) {
    const s = listMd(nested, depth + 1, ctx);
    if (s) md += `\n${s}`;
  }
  return md;
}

function firstLeaf(nodes) {
  for (const n of nodes) {
    if (isText(n)) { if (cleanText(n.data).trim()) return n; continue; }
    if (n.nodeType !== 1) continue;
    if (/^(INPUT|IMG|BR|HR)$/.test(tagOf(n))) return n;
    const leaf = firstLeaf(Array.from(n.childNodes));
    if (leaf) return leaf;
  }
  return null;
}

function tableMd(node, ctx) {
  const rows = [];
  const visit = (n) => {
    for (const c of Array.from(n.children || [])) {
      const t = tagOf(c);
      if (t === 'TR') rows.push(c);
      else if (t === 'THEAD' || t === 'TBODY' || t === 'TFOOT') visit(c);
    }
  };
  if (tagOf(node) === 'TR') rows.push(node); else visit(node);
  const grid = rows.map((tr) => Array.from(tr.children).filter((c) => tagOf(c) === 'TD' || tagOf(c) === 'TH'));
  const width = grid.reduce((w, r) => Math.max(w, r.length), 0);
  if (!width) return '';
  const cols = (fn) => `| ${Array.from({ length: width }, (_, k) => fn(k)).join(' | ')} |`;
  const cell = (c) => (c ? oneLine(inlineMd(c.childNodes, ctx)).trim() : '');
  const align = (c) => {
    const a = String((c && ((c.style && c.style.textAlign) || c.getAttribute('align'))) || '').toLowerCase();
    return a === 'center' ? ':---:' : a === 'right' || a === 'end' ? '---:' : '---';
  };
  return [cols((k) => cell(grid[0][k])), cols((k) => align(grid[0][k])), ...grid.slice(1).map((r) => cols((k) => cell(r[k])))].join('\n');
}

// ================================================================ editor

const is = (...tags) => (n) => tags.includes(tagOf(n));

function taskBox(li) {
  for (const c of Array.from(li.childNodes)) {
    if (isText(c) && !c.data.replace(ZW_RE, '').trim()) continue;
    return isCheckbox(c) ? c : null;
  }
  return null;
}

function safeHref(u) {
  const s = String(u == null ? '' : u).trim();
  if (!s) return '';
  if (/^(https?:|mailto:)/i.test(s)) return urlPart(s);
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return ''; // javascript:, data:, … are refused
  return `https://${urlPart(s.replace(/^\/+/, ''))}`;
}

// The "\n" text nodes markdown.js puts between blocks carry no meaning; drop them so editing never lands in them.
function stripLayoutWhitespace(root) {
  for (const box of [root, ...root.querySelectorAll('blockquote, ul, ol, table, thead, tbody, tfoot, tr, div')]) {
    for (const n of Array.from(box.childNodes)) {
      if (isText(n) && LAYOUT_WS.test(n.data)
        && (!n.previousSibling || !n.nextSibling || isBlock(n.previousSibling) || isBlock(n.nextSibling))) n.remove();
    }
  }
}

/**
 * Mount a WYSIWYG editor. Returns { setMarkdown(md), getMarkdown(), focus(), destroy(), exec(command, arg) }.
 * onChange(markdown) is debounced (250 ms) and only fires when the serialized markdown actually changed.
 */
export function createEditor({ mount, markdown = '', readOnly = false, resolveLink, titles, onChange, onOpenLink, onTag, placeholder } = {}) {
  if (!mount) throw new Error('createEditor: a mount element is required');
  const doc = mount.ownerDocument || document;
  const win = doc.defaultView || window;
  const ro = !!readOnly;
  const resolve = typeof resolveLink === 'function' ? resolveLink : () => ({ exists: true });

  const el = doc.createElement('div');
  el.className = 'wysiwyg md';
  el.setAttribute('contenteditable', ro ? 'false' : 'true');
  el.setAttribute('spellcheck', 'true');
  el.setAttribute('role', 'textbox');
  el.setAttribute('aria-multiline', 'true');
  if (ro) el.setAttribute('aria-readonly', 'true');
  el.setAttribute('data-placeholder', placeholder == null ? (ro ? '' : 'Start writing…') : String(placeholder));
  mount.appendChild(el);

  let lastMd = '';
  let timer = 0;
  let saved = null;        // last selection range seen inside the editor (toolbar clicks and dialogs steal focus)
  let destroyed = false;
  let busy = false;        // inside our own insertHTML (its input event must not re-trigger conversions)
  let wasConnected = false;
  let boxDown = null;      // checkbox under the last mousedown and its state at that moment
  let boxWas = false;
  const suggest = { box: null, items: [], index: 0 };

  // ---------------------------------------------------------- content & change notification

  // markdown.js matches [[wikilinks]] on HTML-escaped text, so a title with an apostrophe (escaped to &#39;) is cut at
  // the "#" and would be saved back truncated. Swap wikilinks for inert tokens, render, then build the anchors here.
  function load(md) {
    const links = [];
    const src = String(md == null ? '' : md).replace(WIKI_SRC, (whole, title, alias) => {
      links.push({ whole, title: title.trim(), alias: alias ? alias.trim() : '' });
      return `\u0001${links.length - 1}\u0001`;
    });
    el.innerHTML = render(src, { resolveLink: resolve });
    if (links.length) {
      for (const t of textNodes(el)) {
        if (!t.data.includes('\u0001')) continue;
        const parts = t.data.split(/\u0001(\d+)\u0001/);
        if (parts.length < 2) continue;
        const inCode = !!closestIn(t, is('PRE', 'CODE'));
        const frag = doc.createDocumentFragment();
        parts.forEach((p, i) => {
          if (i % 2 === 0) { if (p) frag.appendChild(doc.createTextNode(p)); return; }
          const link = links[Number(p)];
          if (!link) return;
          frag.appendChild(inCode ? doc.createTextNode(link.whole) : wikiAnchor(link.title, link.alias !== link.title ? link.alias : ''));
        });
        t.parentNode.replaceChild(frag, t);
      }
      if (el.innerHTML.includes('\u0001')) { // a token that landed in an attribute (e.g. image alt): restore the source text
        for (const node of Array.from(el.querySelectorAll('*'))) {
          for (const attr of Array.from(node.attributes)) {
            if (attr.value.includes('\u0001')) {
              node.setAttribute(attr.name, attr.value.replace(/\u0001(\d+)\u0001/g, (_, k) => (links[Number(k)] ? links[Number(k)].whole : '')));
            }
          }
        }
      }
    }
    stripLayoutWhitespace(el);
    saved = null;
    lastMd = htmlToMarkdown(el);
  }

  function emit() {
    win.clearTimeout(timer);
    timer = 0;
    const md = htmlToMarkdown(el);
    if (md === lastMd) return;
    lastMd = md;
    if (typeof onChange === 'function') {
      try { onChange(md); } catch (err) { console.error('wysiwyg onChange', err); }
    }
  }
  function changed() {
    if (ro || destroyed) return;
    win.clearTimeout(timer);
    timer = win.setTimeout(emit, 250);
  }
  function flush() { if (timer) emit(); }
  function edited() { normalizeTasks(); saveRange(); changed(); }

  // Keep li.task / span.done in step with the checkboxes (a deleted checkbox turns the item back into a plain one).
  function normalizeTasks() {
    for (const li of Array.from(el.querySelectorAll('li'))) {
      let box = taskBox(li);
      if (!box && li.classList.contains('task')) { // text typed in front of the checkbox: put the box back first
        const stray = Array.from(li.children).find(isCheckbox);
        if (stray) { li.insertBefore(stray, li.firstChild); box = stray; }
      }
      if (box && !li.classList.contains('task')) li.classList.add('task');
      if (!box && li.classList.contains('task')) li.classList.remove('task');
      const done = !!(box && box.checked);
      for (const s of Array.from(li.children)) {
        if (tagOf(s) === 'SPAN' && s.classList.contains('done') !== done) s.classList.toggle('done', done);
      }
    }
  }

  // ---------------------------------------------------------- selection helpers

  function closestIn(node, pred) {
    for (let n = isText(node) ? node.parentNode : node; n && n !== el; n = n.parentNode) {
      if (n.nodeType === 1 && pred(n)) return n;
    }
    return null;
  }
  function liveRange() {
    const s = win.getSelection ? win.getSelection() : null;
    if (!s || !s.rangeCount) return null;
    const r = s.getRangeAt(0);
    return el.contains(r.startContainer) && el.contains(r.endContainer) ? r : null;
  }
  function saveRange() {
    const r = liveRange();
    if (r) saved = r.cloneRange();
  }
  function currentRange() {
    const r = liveRange();
    if (r) return r.cloneRange();
    if (saved && el.contains(saved.startContainer) && el.contains(saved.endContainer)) return saved.cloneRange();
    const end = doc.createRange();
    end.selectNodeContents(el);
    end.collapse(false);
    return end;
  }
  function select(r) {
    saved = r.cloneRange();
    const s = win.getSelection ? win.getSelection() : null;
    if (!s || !el.isConnected) return;
    try { s.removeAllRanges(); s.addRange(r); } catch (err) { /* selection unavailable */ }
  }
  function caret(node, offset) {
    const r = doc.createRange();
    r.setStart(node, offset);
    r.collapse(true);
    select(r);
  }
  function caretAfter(node) {
    if (isText(node)) { caret(node, node.length); return; }
    const r = doc.createRange();
    r.setStartAfter(node);
    r.collapse(true);
    select(r);
  }
  function caretAtEnd(node) {
    const t = lastText(node);
    if (t) caret(t, t.length);
    else caret(node, tagOf(node.lastChild) === 'BR' ? node.childNodes.length - 1 : node.childNodes.length);
  }
  function focusEditor() {
    const r = currentRange();
    if (el.isConnected && doc.activeElement !== el) {
      try { el.focus({ preventScroll: true }); } catch (err) { el.focus(); }
    }
    select(r);
  }
  // Run a DOM change and put the selection back on the same text positions (text nodes survive being moved).
  function keepCaret(fn) {
    const r = currentRange();
    const sc = r.startContainer;
    const so = r.startOffset;
    const ec = r.endContainer;
    const eo = r.endOffset;
    fn();
    if (isText(sc) && isText(ec) && el.contains(sc) && el.contains(ec)) {
      try {
        const nr = doc.createRange();
        nr.setStart(sc, Math.min(so, sc.length));
        nr.setEnd(ec, Math.min(eo, ec.length));
        select(nr);
        return true;
      } catch (err) { /* fall through */ }
    }
    return false;
  }
  function native(cmd, value) {
    if (!el.isConnected || typeof doc.execCommand !== 'function') return false;
    try { return doc.execCommand(cmd, false, value == null ? null : value) === true; } catch (err) { return false; }
  }

  // ---------------------------------------------------------- block helpers

  function emptyPara() {
    const p = doc.createElement('p');
    p.appendChild(doc.createElement('br'));
    return p;
  }
  // Wrap the run of inline siblings around `node` (bounded by blocks) in a <p> and return it.
  // Wrap every inline run sitting directly in the editor root in a <p>.
  function wrapLooseRuns() {
    for (const n of Array.from(el.childNodes)) {
      if (n.parentNode !== el || isBlock(n)) continue;
      if (isText(n) && !n.data.replace(ZW_RE, '').trim()) continue;
      wrapRun(n);
    }
  }
  function wrapRun(node) {
    const parent = node.parentNode;
    let a = node;
    let b = node;
    while (a.previousSibling && !isBlock(a.previousSibling)) a = a.previousSibling;
    while (b.nextSibling && !isBlock(b.nextSibling)) b = b.nextSibling;
    while (a !== b && isText(a) && LAYOUT_WS.test(a.data)) a = a.nextSibling;
    while (b !== a && isText(b) && LAYOUT_WS.test(b.data)) b = b.previousSibling;
    const p = doc.createElement('p');
    keepCaret(() => {
      parent.insertBefore(p, a);
      let n = a;
      while (n) {
        const next = n === b ? null : n.nextSibling;
        p.appendChild(n);
        n = next;
      }
    });
    return p;
  }
  // The direct child of the editor holding the selection start (loose inline content is wrapped in a <p> first).
  function topBlock(r) {
    let n = r.startContainer;
    if (n === el) n = el.childNodes[r.startOffset - 1] || el.childNodes[r.startOffset] || null;
    if (!n) {
      const p = emptyPara();
      el.appendChild(p);
      return p;
    }
    while (n.parentNode && n.parentNode !== el) n = n.parentNode;
    if (n.parentNode !== el) return null;
    return isBlock(n) ? n : wrapRun(n);
  }
  // The text block ("line") holding the selection start, or null when it is not a convertible block.
  function leafBlock(r) {
    const b = closestIn(r.startContainer, isBlock) || topBlock(r);
    if (!b) return null;
    const tag = tagOf(b);
    if (/^(P|H[1-6]|PRE|LI|TD|TH)$/.test(tag)) return b;
    if (/^(UL|OL|TABLE|THEAD|TBODY|TFOOT|TR|HR)$/.test(tag) || hasClass(b, 'table-wrap')) return null;
    if (!Array.from(b.childNodes).some(isBlock)) return b;
    let n = r.startContainer === b ? b.childNodes[r.startOffset] || b.childNodes[r.startOffset - 1] : r.startContainer;
    while (n && n.parentNode !== b) n = n.parentNode;
    if (!n) return null;
    if (isBlock(n)) return /^(P|H[1-6]|PRE)$/.test(tagOf(n)) ? n : null;
    return wrapRun(n);
  }
  const isBlank = (b) => !(b.textContent || '').replace(ZW_RE, '').trim() && !b.querySelector('img, input, hr, table, ul, ol, pre');
  function sibling(n, dir) {
    let s = n[dir];
    while (s && isText(s) && LAYOUT_WS.test(s.data)) s = s[dir];
    return s;
  }
  function mergeLists(list) {
    let cur = list;
    keepCaret(() => {
      const prev = sibling(cur, 'previousSibling');
      if (prev && tagOf(prev) === tagOf(cur)) {
        while (cur.firstChild) prev.appendChild(cur.firstChild);
        cur.parentNode.removeChild(cur);
        cur = prev;
      }
      const next = sibling(cur, 'nextSibling');
      if (next && tagOf(next) === tagOf(cur)) {
        while (next.firstChild) cur.appendChild(next.firstChild);
        next.parentNode.removeChild(next);
      }
    });
    return cur;
  }
  function unwrap(w) {
    const p = w.parentNode;
    if (!p) return;
    while (w.firstChild) p.insertBefore(w.firstChild, w);
    p.removeChild(w);
  }
  function unwrapQuote(q) {
    const parent = q.parentNode;
    let run = null;
    for (const c of Array.from(q.childNodes)) {
      if (isBlock(c)) { run = null; parent.insertBefore(c, q); continue; }
      if (!run && isText(c) && LAYOUT_WS.test(c.data)) { q.removeChild(c); continue; }
      if (!run) { run = doc.createElement('p'); parent.insertBefore(run, q); }
      run.appendChild(c);
    }
    parent.removeChild(q);
  }

  // ---------------------------------------------------------- anchors

  function wikiAnchor(title, alias) {
    const a = doc.createElement('a');
    let exists = true;
    try { exists = !!(resolve(title) || {}).exists; } catch (err) { exists = true; }
    a.className = exists ? 'wikilink' : 'wikilink missing';
    a.setAttribute('data-title', title);
    a.setAttribute('href', '#');
    a.textContent = alias || title;
    return a;
  }
  function tagAnchor(tag) {
    const a = doc.createElement('a');
    a.className = 'tag';
    a.setAttribute('data-tag', tag.toLowerCase());
    a.setAttribute('href', '#');
    a.textContent = `#${tag}`;
    return a;
  }
  function linkAnchor(href) {
    const a = doc.createElement('a');
    a.setAttribute('href', href);
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener');
    return a;
  }
  function outsideAnchor(r) {
    const a = closestIn(r.startContainer, is('A'));
    if (!a) return r;
    const lead = doc.createRange();
    lead.setStart(a, 0);
    lead.setEnd(r.startContainer, r.startOffset);
    const out = doc.createRange();
    if (lead.toString()) out.setStartAfter(a); else out.setStartBefore(a);
    out.collapse(true);
    return out;
  }
  // Insert inline nodes in place of range r. The native insertHTML keeps the browser's undo stack coherent;
  // the DOM fallback covers detached editors and browsers that refuse the command.
  function insertInline(nodes, range) {
    const r = outsideAnchor(range);
    if (el.isConnected && (doc.activeElement === el || el.contains(doc.activeElement))) {
      select(r);
      const before = el.innerHTML;
      let ok = false;
      busy = true;
      try { ok = native('insertHTML', nodes.map((n) => (isText(n) ? escapeHtml(n.data) : n.outerHTML)).join('')); } finally { busy = false; }
      if (ok && el.innerHTML !== before) { saveRange(); return; }
    }
    r.deleteContents();
    const frag = doc.createDocumentFragment();
    nodes.forEach((n) => frag.appendChild(n));
    r.insertNode(frag);
    caretAfter(nodes[nodes.length - 1]);
  }

  // ---------------------------------------------------------- [[wikilink]] typing + suggestions

  const WIKI_TAIL = /\[\[([^[\]|#\n]+)(?:\|([^[\]\n]+))?\]\]$/;
  const SUGGEST_TAIL = /\[\[([^[\]|#\n]*)$/;

  // Text before a collapsed caret within the run of adjacent text nodes (not inside links or code).
  function caretText() {
    const r = liveRange();
    if (!r || !r.collapsed) return null;
    let node = r.startContainer;
    let offset = r.startOffset;
    if (!isText(node)) {
      const prev = node.childNodes[offset - 1];
      if (!isText(prev)) return null;
      node = prev;
      offset = prev.length;
    }
    if (closestIn(node, is('A', 'CODE', 'PRE'))) return null;
    const parts = [{ node, end: offset }];
    let text = node.data.slice(0, offset);
    for (let p = node.previousSibling; isText(p); p = p.previousSibling) {
      parts.unshift({ node: p, end: p.length });
      text = p.data + text;
    }
    return { text, parts, node, offset };
  }
  // Range over the last `len` characters before the caret.
  function tailRange(ct, len) {
    const r = doc.createRange();
    r.setEnd(ct.node, ct.offset);
    let left = len;
    for (let i = ct.parts.length - 1; i >= 0; i--) {
      const { node, end } = ct.parts[i];
      if (left <= end) { r.setStart(node, end - left); return r; }
      left -= end;
    }
    r.setStart(ct.parts[0].node, 0);
    return r;
  }
  function autoLink() {
    const ct = caretText();
    const m = ct && WIKI_TAIL.exec(ct.text);
    if (!m) return false;
    const title = cleanTitle(m[1]);
    const alias = cleanTitle(m[2]);
    if (!title) return false;
    hideSuggest();
    insertInline([wikiAnchor(title, alias && alias !== title ? alias : ''), doc.createTextNode(NBSP)], tailRange(ct, m[0].length));
    return true;
  }
  function hideSuggest() {
    if (suggest.box) suggest.box.style.display = 'none';
    suggest.items = [];
  }
  function updateSuggest() {
    if (typeof titles !== 'function') return;
    const ct = caretText();
    const m = ct && SUGGEST_TAIL.exec(ct.text);
    if (!m) { hideSuggest(); return; }
    const q = m[1].trim().toLowerCase();
    let all = [];
    try { all = Array.from(titles() || [], (x) => String(x)); } catch (err) { all = []; }
    const hits = [...new Set(all)].filter((x) => x && x.toLowerCase().includes(q))
      .sort((a, b) => Number(b.toLowerCase().startsWith(q)) - Number(a.toLowerCase().startsWith(q)) || a.localeCompare(b))
      .slice(0, 8);
    if (!hits.length) { hideSuggest(); return; }
    if (!suggest.box) {
      suggest.box = doc.createElement('div');
      suggest.box.className = 'popover wysiwyg-suggest';
      suggest.box.setAttribute('role', 'listbox');
      suggest.box.addEventListener('mousedown', (ev) => ev.preventDefault()); // keep the caret in the editor
      doc.body.appendChild(suggest.box);
    }
    const box = suggest.box;
    box.textContent = '';
    suggest.items = hits;
    suggest.index = 0;
    hits.forEach((title, i) => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = `tree-item${i === 0 ? ' active' : ''}`;
      b.setAttribute('role', 'option');
      b.textContent = title;
      b.addEventListener('click', () => pickSuggestion(i));
      box.appendChild(b);
    });
    const live = liveRange();
    let rect = live ? live.getBoundingClientRect() : null;
    if (!rect || (!rect.top && !rect.left && !rect.height)) rect = el.getBoundingClientRect();
    box.style.display = 'flex';
    box.style.left = `${Math.max(8, Math.min(rect.left, win.innerWidth - 280))}px`;
    box.style.top = `${Math.max(8, Math.min(rect.bottom + 6, win.innerHeight - 240))}px`;
  }
  function pickSuggestion(i) {
    const title = suggest.items[i];
    hideSuggest();
    const ct = caretText();
    const m = ct && SUGGEST_TAIL.exec(ct.text);
    if (!title || !m) return;
    insertInline([wikiAnchor(title, ''), doc.createTextNode(NBSP)], tailRange(ct, m[0].length));
    edited();
  }
  function suggestKey(e) {
    if (!suggest.box || suggest.box.style.display === 'none' || !suggest.items.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = suggest.items.length;
      suggest.index = (suggest.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      Array.from(suggest.box.children).forEach((b, i) => b.classList.toggle('active', i === suggest.index));
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickSuggestion(suggest.index); return true; }
    if (e.key === 'Escape') { e.preventDefault(); hideSuggest(); return true; }
    return false;
  }

  // ---------------------------------------------------------- inline formatting

  // Text-node pieces covered by a range (skipping code blocks and the whitespace between blocks).
  function segments(r) {
    const root = r.commonAncestorContainer;
    const nodes = isText(root) ? [root] : textNodes(root).filter((t) => r.intersectsNode(t));
    return nodes
      .map((t) => ({ t, s: t === r.startContainer ? r.startOffset : 0, e: t === r.endContainer ? r.endOffset : t.length }))
      .filter((g) => g.e > g.s && !closestIn(g.t, is('PRE'))
        && !(LAYOUT_WS.test(g.t.data) && (g.t.parentNode === el || isBlock(g.t.previousSibling) || isBlock(g.t.nextSibling))));
  }
  function wrapSegments(segs, make) {
    let first = null;
    let last = null;
    for (const g of segs) {
      let node = g.t;
      if (g.e < node.length) node.splitText(g.e);
      if (g.s > 0) node = node.splitText(g.s);
      const w = make();
      node.parentNode.insertBefore(w, node);
      w.appendChild(node);
      if (!first) first = w;
      last = w;
    }
    if (first) {
      const r = doc.createRange();
      r.setStartBefore(first);
      r.setEndAfter(last);
      select(r);
    }
    return first;
  }
  function wordAt(r) {
    const t = r.startContainer;
    if (!isText(t)) return null;
    const word = /[\p{L}\p{N}_'’-]/u;
    let a = r.startOffset;
    let b = r.startOffset;
    while (a > 0 && word.test(t.data[a - 1])) a -= 1;
    while (b < t.length && word.test(t.data[b])) b += 1;
    if (a === b) return null;
    const w = doc.createRange();
    w.setStart(t, a);
    w.setEnd(t, b);
    return w;
  }
  // Toggle an inline wrapper (mark, code, or the fallback for b/i/s) over the selection, the word at the caret,
  // or — on an empty spot — a fresh empty element to type into.
  function toggleInline(tag, tags) {
    const match = is(...tags);
    let r = currentRange();
    let caretInWord = -1;
    if (r.collapsed) {
      const host = closestIn(r.startContainer, match);
      if (host) { keepCaret(() => unwrap(host)); return true; }
      const w = wordAt(r);
      if (!w) {
        const node = doc.createElement(tag);
        const t = doc.createTextNode(ZWSP);
        node.appendChild(t);
        r.insertNode(node);
        caret(t, 1);
        return true;
      }
      caretInWord = r.startOffset - w.startOffset;
      r = w;
    }
    const segs = segments(r);
    if (!segs.length) return false;
    const hosts = segs.map((g) => closestIn(g.t, match));
    if (hosts.every(Boolean)) {
      new Set(hosts).forEach(unwrap);
      const nr = doc.createRange();
      nr.setStart(segs[0].t, segs[0].s);
      nr.setEnd(segs[segs.length - 1].t, segs[segs.length - 1].e);
      select(nr);
      return true;
    }
    const first = wrapSegments(segs.filter((g, i) => !hosts[i]), () => doc.createElement(tag));
    if (first && caretInWord >= 0 && isText(first.firstChild)) caret(first.firstChild, Math.min(caretInWord, first.firstChild.length));
    return !!first;
  }

  // ---------------------------------------------------------- block commands

  function setBlock(tagName) {
    let tag = tagName;
    const r = currentRange();
    if (tag === 'blockquote') {
      const q = closestIn(r.startContainer, is('BLOCKQUOTE'));
      if (q) { // toggle the quote off
        if (!keepCaret(() => unwrapQuote(q))) caretAtEnd(el);
        return true;
      }
    } else if (tag !== 'p' && tagOf(closestIn(r.startContainer, isBlock)) === tag.toUpperCase()) {
      tag = 'p'; // H2 pressed inside an H2 turns it back into a paragraph
    }
    if (native('formatBlock', tag)) return true;
    const b = leafBlock(r);
    if (!b || /^(LI|TD|TH)$/.test(tagOf(b))) return false;
    if (tag === 'blockquote') {
      const q = doc.createElement('blockquote');
      keepCaret(() => { b.parentNode.insertBefore(q, b); q.appendChild(b); });
      return true;
    }
    const nb = doc.createElement(tag);
    const kept = keepCaret(() => {
      while (b.firstChild) nb.appendChild(b.firstChild);
      b.parentNode.replaceChild(nb, b);
    });
    if (!nb.firstChild) nb.appendChild(doc.createElement('br'));
    if (!kept) caretAtEnd(nb);
    return true;
  }

  function unwrapListItem(li) {
    const list = li.parentNode;
    const p = doc.createElement('p');
    keepCaret(() => {
      while (li.firstChild) p.appendChild(li.firstChild);
      if (!li.previousElementSibling && !li.nextElementSibling) { list.parentNode.replaceChild(p, list); }
      else if (!li.previousElementSibling) { list.parentNode.insertBefore(p, list); li.remove(); }
      else if (!li.nextElementSibling) { list.parentNode.insertBefore(p, list.nextSibling); li.remove(); }
      else { const rest = doc.createElement(tagOf(list).toLowerCase()); while (li.nextSibling) rest.appendChild(li.nextSibling); li.remove(); list.parentNode.insertBefore(p, list.nextSibling); p.parentNode.insertBefore(rest, p.nextSibling); }
    });
    if (!p.firstChild) p.appendChild(doc.createElement('br'));
    return true;
  }

  function setList(type) {
    const inLi = () => { const rr = currentRange(); return rr ? closestIn(rr.startContainer, is('LI')) : null; };
    const before = inLi();
    if (native(type === 'ol' ? 'insertOrderedList' : 'insertUnorderedList')) {
      const after = inLi();
      // The native command reports success even when the document is unfocused; verify it did something.
      if ((!!after) !== (!!before) || (after && before && after !== before)) {
        // Chrome can leave the new list inside the paragraph (<p><ul>…</ul></p>); lift it out.
        keepCaret(() => liftNestedBlocks(el));
        return true;
      }
    }
    const r = currentRange();
    const li = closestIn(r.startContainer, is('LI'));
    if (li) {
      const list = li.parentNode;
      if (!isList(list)) return false;
      if (tagOf(list) === type.toUpperCase()) return unwrapListItem(li);
      const nl = doc.createElement(type);
      keepCaret(() => {
        while (list.firstChild) nl.appendChild(list.firstChild);
        list.parentNode.replaceChild(nl, list);
      });
      return true;
    }
    const b = leafBlock(r);
    if (!b || /^(TD|TH)$/.test(tagOf(b))) return false;
    const list = doc.createElement(type);
    const item = doc.createElement('li');
    const kept = keepCaret(() => {
      while (b.firstChild) item.appendChild(b.firstChild);
      list.appendChild(item);
      b.parentNode.replaceChild(list, b);
    });
    if (!item.firstChild) item.appendChild(doc.createElement('br'));
    mergeLists(list);
    if (!kept) caretAtEnd(item);
    return true;
  }

  function checkbox(checked) {
    const cb = doc.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!checked;
    return cb;
  }
  function newTask() {
    const li = doc.createElement('li');
    li.className = 'task';
    const span = doc.createElement('span');
    const text = doc.createTextNode(ZWSP); // gives the caret a home inside the span
    span.appendChild(text);
    li.append(checkbox(false), doc.createTextNode(' '), span);
    return { li, span, text };
  }
  // li → li.task with the renderer's structure: <input type=checkbox> <span>content</span> [nested lists]
  function toTask(li) {
    const span = doc.createElement('span');
    for (const c of Array.from(li.childNodes)) {
      if (isList(c)) continue;
      if (isBlock(c)) {
        while (c.firstChild) span.appendChild(c.firstChild);
        li.removeChild(c);
      } else span.appendChild(c);
    }
    while (span.lastChild && tagOf(span.lastChild) === 'BR') span.removeChild(span.lastChild);
    if (!span.firstChild) span.appendChild(doc.createTextNode(ZWSP));
    li.classList.add('task');
    li.insertBefore(span, li.firstChild);
    li.insertBefore(doc.createTextNode(' '), span);
    li.insertBefore(checkbox(false), li.firstChild);
  }
  function caretIntoItem(li) {
    const own = Array.from(li.childNodes).filter((c) => !isList(c));
    const span = own.find((c) => tagOf(c) === 'SPAN');
    let t = span ? lastText(span) : null;
    if (!t) {
      for (const c of own) {
        const x = isText(c) ? c : lastText(c);
        if (x && x.data.trim()) t = x;
      }
    }
    if (!t) {
      t = doc.createTextNode(ZWSP);
      if (span) span.appendChild(t);
      else li.insertBefore(t, Array.from(li.childNodes).find(isList) || null);
    }
    caret(t, t.length);
  }
  function makeTask() {
    const r = currentRange();
    const li = closestIn(r.startContainer, is('LI'));
    if (li && isList(li.parentNode)) {
      if (taskBox(li)) { // already a task: add a fresh one below it
        const n = newTask();
        li.parentNode.insertBefore(n.li, li.nextSibling);
        caret(n.text, n.text.length);
      } else if (!keepCaret(() => toTask(li))) caretIntoItem(li);
      return true;
    }
    const b = leafBlock(r);
    if (!b || /^(LI|TD|TH)$/.test(tagOf(b))) { // nothing convertible here: start a new task list below
      const n = newTask();
      const ul = doc.createElement('ul');
      ul.appendChild(n.li);
      const top = topBlock(r);
      if (top) top.parentNode.insertBefore(ul, top.nextSibling); else el.appendChild(ul);
      mergeLists(ul);
      caret(n.text, n.text.length);
      return true;
    }
    const ul = doc.createElement('ul');
    const item = doc.createElement('li');
    const kept = keepCaret(() => {
      while (b.firstChild) item.appendChild(b.firstChild);
      ul.appendChild(item);
      b.parentNode.replaceChild(ul, b);
      toTask(item);
    });
    mergeLists(ul);
    if (!kept) caretIntoItem(item);
    return true;
  }

  function insertHr() {
    const top = topBlock(currentRange());
    const hr = doc.createElement('hr');
    if (top && /^(P|DIV)$/.test(tagOf(top)) && !hasClass(top, 'table-wrap') && isBlank(top)) {
      top.parentNode.insertBefore(hr, top); // the empty line becomes the paragraph after the rule
      caret(top, 0);
      return true;
    }
    const p = emptyPara();
    if (top) top.parentNode.insertBefore(p, top.nextSibling); else el.appendChild(p);
    p.parentNode.insertBefore(hr, p);
    caret(p, 0);
    return true;
  }

  function insertTable() {
    const top = topBlock(currentRange());
    const wrap = doc.createElement('div');
    wrap.className = 'table-wrap';
    const table = doc.createElement('table');
    const section = (name, cellTag) => {
      const s = doc.createElement(name);
      const tr = doc.createElement('tr');
      for (let i = 0; i < 2; i++) {
        const c = doc.createElement(cellTag);
        c.style.textAlign = 'left';
        c.appendChild(doc.createElement('br'));
        tr.appendChild(c);
      }
      s.appendChild(tr);
      return s;
    };
    table.append(section('thead', 'th'), section('tbody', 'td'));
    wrap.appendChild(table);
    if (top && /^(P|DIV)$/.test(tagOf(top)) && !hasClass(top, 'table-wrap') && isBlank(top)) top.parentNode.replaceChild(wrap, top);
    else if (top) top.parentNode.insertBefore(wrap, top.nextSibling);
    else el.appendChild(wrap);
    if (!/^(P|DIV|H[1-6])$/.test(tagOf(wrap.nextSibling)) || hasClass(wrap.nextSibling, 'table-wrap')) {
      wrap.parentNode.insertBefore(emptyPara(), wrap.nextSibling); // somewhere to keep typing below the table
    }
    caret(table.querySelector('th'), 0);
    return true;
  }

  // ---------------------------------------------------------- insertion commands

  function insertText(text) {
    const s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    if (!s) return false;
    const r = currentRange();
    const inPre = !!closestIn(r.startContainer, is('PRE'));
    if (!inPre && native('insertText', s)) return true;
    r.deleteContents();
    const frag = doc.createDocumentFragment();
    let last = null;
    if (inPre) {
      last = doc.createTextNode(s);
      frag.appendChild(last);
    } else {
      s.split('\n').forEach((part, i) => {
        if (i) { last = doc.createElement('br'); frag.appendChild(last); }
        if (part) { last = doc.createTextNode(part); frag.appendChild(last); }
      });
    }
    r.insertNode(frag);
    if (last) caretAfter(last);
    return true;
  }

  function insertLink(url) {
    const href = safeHref(url);
    if (!href) return false;
    const r = currentRange();
    if (!r.collapsed && r.toString().trim()) {
      if (native('createLink', href)) return true;
      return !!wrapSegments(segments(r), () => linkAnchor(href));
    }
    const a = linkAnchor(href);
    a.textContent = String(url).trim();
    insertInline([a, doc.createTextNode(NBSP)], r);
    return true;
  }

  function insertWikilink(arg) {
    const r = currentRange();
    const selected = r.collapsed ? '' : cleanTitle(r.toString());
    const title = cleanTitle(arg) || selected;
    if (!title) return false;
    if (closestIn(r.startContainer, is('PRE', 'CODE'))) return insertText(`[[${title}]]`);
    insertInline([wikiAnchor(title, selected && selected !== title ? selected : ''), doc.createTextNode(NBSP)], r);
    return true;
  }

  function textBefore(r) {
    const pre = doc.createRange();
    pre.setStart(closestIn(r.startContainer, isBlock) || el, 0);
    pre.setEnd(r.startContainer, r.startOffset);
    return pre.toString().replace(ZW_RE, '');
  }
  function insertTag(arg) {
    const tag = String(arg == null ? '' : arg).trim().replace(/^#+/, '').replace(/\s+/g, '-');
    if (!tag) return false;
    const r = currentRange();
    // markdown.js only recognises #letter[word/-]*; anything else (or code) is inserted as plain text
    if (!/^[A-Za-z][\w/-]*$/.test(tag) || closestIn(r.startContainer, is('PRE', 'CODE'))) return insertText(`#${tag}`);
    const nodes = [tagAnchor(tag), doc.createTextNode(NBSP)];
    if (/[^\s(]$/.test(textBefore(r))) nodes.unshift(doc.createTextNode(NBSP)); // a tag needs a space before it
    insertInline(nodes, r);
    return true;
  }

  // ---------------------------------------------------------- keys: tasks, list exit, indent

  function isEmptyItem(li) {
    for (const c of Array.from(li.childNodes)) {
      if (isList(c)) return false;
      if (isCheckbox(c)) continue;
      if (tagOf(c) === 'IMG' || (c.nodeType === 1 && c.querySelector('img, input, table, hr'))) return false;
      if ((c.textContent || '').replace(ZW_RE, '').trim()) return false;
    }
    return true;
  }
  // Enter on an empty item: leave the list (or move one level out of a nested list).
  function exitItem(li) {
    const list = li.parentNode;
    const host = list.parentNode;
    const tail = [];
    for (let n = li.nextSibling; n; n = n.nextSibling) tail.push(n);
    const moveTail = (place) => {
      if (!tail.some((n) => n.nodeType === 1)) return;
      const nl = list.cloneNode(false);
      tail.forEach((n) => nl.appendChild(n));
      place(nl);
    };
    if (host && host !== el && el.contains(host) && (tagOf(host) === 'LI' || isList(host))) {
      const anchor = tagOf(host) === 'LI' ? host : list;
      anchor.parentNode.insertBefore(li, anchor.nextSibling);
      moveTail((nl) => li.appendChild(nl));
      if (!list.querySelector('li')) list.parentNode.removeChild(list);
      caretIntoItem(li);
      return;
    }
    const p = emptyPara();
    list.parentNode.insertBefore(p, list.nextSibling);
    moveTail((nl) => p.parentNode.insertBefore(nl, p.nextSibling));
    list.removeChild(li);
    if (!list.querySelector('li')) list.parentNode.removeChild(list);
    caret(p, 0);
  }
  // Enter inside a task: the text after the caret moves into a new, unchecked task below.
  function splitTask(li, r) {
    const head = doc.createRange();
    head.setStart(li, 0);
    head.setEnd(r.startContainer, r.startOffset);
    if (!head.toString().replace(ZW_RE, '').trim() && !head.cloneContents().querySelector('img')) {
      // caret at the start of the task: open an empty task above and keep this one (and its state) intact
      li.parentNode.insertBefore(newTask().li, li);
      const span = Array.from(li.childNodes).find((c) => tagOf(c) === 'SPAN');
      const first = span && firstText(span);
      if (first) caret(first, 0);
      return;
    }
    const tail = doc.createRange();
    tail.setStart(r.startContainer, r.startOffset);
    const nested = Array.from(li.childNodes).find(isList);
    if (nested) tail.setEndBefore(nested); else tail.setEnd(li, li.childNodes.length);
    const frag = tail.extractContents();
    for (const c of Array.from(frag.childNodes)) if (tagOf(c) === 'SPAN') unwrap(c);
    while (frag.lastChild && tagOf(frag.lastChild) === 'BR') frag.removeChild(frag.lastChild);
    const n = newTask();
    const moved = !!((frag.textContent || '').replace(ZW_RE, '').trim() || frag.querySelector('img'));
    if (moved) {
      n.span.removeChild(n.text);
      n.span.appendChild(frag);
    }
    li.parentNode.insertBefore(n.li, li.nextSibling);
    const old = Array.from(li.childNodes).find((c) => tagOf(c) === 'SPAN');
    if (old && !old.textContent) old.appendChild(doc.createTextNode(ZWSP));
    const t = moved ? firstText(n.span) : n.text;
    if (t) caret(t, moved ? 0 : t.length); else caret(n.span, 0);
  }

  function onKeydown(e) {
    if (destroyed) return;
    if (suggestKey(e)) return;
    if (e.isComposing || e.keyCode === 229 || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      const r = liveRange();
      const li = r && closestIn(r.startContainer, is('LI'));
      if (!li || !li.parentNode) return;
      if (isEmptyItem(li)) {
        e.preventDefault();
        exitItem(li);
        edited();
        return;
      }
      if (!taskBox(li)) return; // plain items: the browser's own Enter creates the next item
      e.preventDefault();
      if (!r.collapsed) r.deleteContents();
      splitTask(li, r);
      edited();
      return;
    }
    if (e.key === 'Tab') {
      const r = liveRange();
      if (!r) return;
      if (closestIn(r.startContainer, is('PRE'))) {
        e.preventDefault();
        if (!e.shiftKey) insertText('  ');
        edited();
      } else if (closestIn(r.startContainer, is('LI'))) {
        e.preventDefault();
        native(e.shiftKey ? 'outdent' : 'indent');
        edited();
      }
    }
  }

  // ---------------------------------------------------------- events

  function onInput(e) {
    if (destroyed) return;
    if (!busy && !e.isComposing && (!e.inputType || e.inputType.startsWith('insert'))) autoLink();
    normalizeTasks();
    if (!busy) updateSuggest();
    saveRange();
    changed();
  }
  function onPaste(e) {
    if (destroyed) return;
    const data = e.clipboardData || win.clipboardData;
    if (!data) return;
    e.preventDefault(); // plain text only: no foreign HTML gets into the note
    const text = data.getData('text/plain') || data.getData('text') || '';
    if (text) insertText(text);
    edited();
  }
  function onMousedown(e) {
    if (isCheckbox(e.target)) { boxDown = e.target; boxWas = e.target.checked; }
  }
  function onClick(e) {
    const t = e.target;
    if (!t || t.nodeType !== 1) return;
    if (isCheckbox(t)) {
      if (ro) { e.preventDefault(); return; } // the browser reverts its own toggle
      const was = boxDown === t ? boxWas : !t.checked;
      boxDown = null;
      t.checked = !was; // settle the state whether or not the browser toggled it inside contenteditable
      edited();
      return;
    }
    const a = t.closest('a');
    if (!a || !el.contains(a)) return;
    if (hasClass(a, 'wikilink') || a.hasAttribute('data-title')) {
      e.preventDefault();
      flush();
      const title = unescapeOnce(a.getAttribute('data-title') || a.textContent || '').trim();
      if (title && typeof onOpenLink === 'function') onOpenLink(title);
      return;
    }
    if (hasClass(a, 'tag') || a.hasAttribute('data-tag')) {
      e.preventDefault();
      flush();
      const tag = String(a.getAttribute('data-tag') || (a.textContent || '').replace(/^#/, '')).trim().toLowerCase();
      if (tag && typeof onTag === 'function') onTag(tag);
      return;
    }
    if (!ro) { // editing: a click places the caret; Ctrl/Cmd+click opens the web link
      e.preventDefault();
      const href = a.getAttribute('href') || '';
      if ((e.ctrlKey || e.metaKey) && /^(https?:|mailto:)/i.test(href)) win.open(href, '_blank', 'noopener');
    }
  }
  function onFocus() {
    try { doc.execCommand('defaultParagraphSeparator', false, 'p'); } catch (err) { /* not supported */ }
  }
  function onBlur() {
    saveRange();
    flush();
    win.setTimeout(hideSuggest, 150);
  }
  function onSelectionChange() {
    if (!el.isConnected) {
      if (wasConnected) doc.removeEventListener('selectionchange', onSelectionChange);
      return;
    }
    wasConnected = true;
    saveRange();
  }

  el.addEventListener('click', onClick);
  if (!ro) {
    el.addEventListener('mousedown', onMousedown);
    el.addEventListener('mouseup', () => win.setTimeout(() => { boxDown = null; }, 0));
    el.addEventListener('input', onInput);
    el.addEventListener('compositionend', () => { if (!destroyed && autoLink()) edited(); });
    el.addEventListener('keydown', onKeydown);
    el.addEventListener('keyup', saveRange);
    el.addEventListener('paste', onPaste);
    el.addEventListener('focus', onFocus);
    el.addEventListener('blur', onBlur);
    doc.addEventListener('selectionchange', onSelectionChange);
  }

  // ---------------------------------------------------------- commands & public API

  function run(command, arg) {
    switch (command) {
      case 'bold': return native('bold') || toggleInline('strong', ['B', 'STRONG']);
      case 'italic': return native('italic') || toggleInline('em', ['I', 'EM']);
      case 'strike': return native('strikeThrough') || toggleInline('del', ['S', 'STRIKE', 'DEL']);
      case 'highlight': return toggleInline('mark', ['MARK']);
      case 'code': return toggleInline('code', ['CODE']);
      case 'h1': case 'h2': case 'h3': return setBlock(command);
      case 'paragraph': return setBlock('p');
      case 'quote': return setBlock('blockquote');
      case 'ul': case 'ol': return setList(command);
      case 'task': return makeTask();
      case 'hr': return insertHr();
      case 'link': return insertLink(arg);
      case 'wikilink': return insertWikilink(arg);
      case 'tag': return insertTag(arg);
      case 'table': return insertTable();
      case 'undo': case 'redo': return native(command);
      case 'insertText': return insertText(arg);
      default: return false;
    }
  }

  function exec(command, arg) {
    if (ro || destroyed) return false;
    hideSuggest();
    focusEditor();
    let done = false;
    try { done = !!run(command, arg); } catch (err) { console.error('wysiwyg exec', command, err); }
    // Native commands can leave inline content loose in the root (e.g. after a list is toggled off); re-wrap it.
    try { wrapLooseRuns(); } catch (err) { /* best effort */ }
    if (el.isConnected && doc.activeElement !== el) {
      try { el.focus({ preventScroll: true }); } catch (err) { el.focus(); }
    }
    edited();
    return done;
  }

  load(markdown);

  return {
    setMarkdown(md) {
      if (destroyed) return;
      win.clearTimeout(timer); // a pending change belongs to the content being replaced
      timer = 0;
      hideSuggest();
      load(md);
    },
    getMarkdown() {
      return htmlToMarkdown(el);
    },
    focus() {
      if (destroyed || !el.isConnected) return;
      const r = saved && el.contains(saved.startContainer) ? saved.cloneRange() : null;
      try { el.focus({ preventScroll: true }); } catch (err) { el.focus(); }
      if (r) select(r);
    },
    destroy() {
      if (destroyed) return;
      flush();
      destroyed = true;
      win.clearTimeout(timer);
      doc.removeEventListener('selectionchange', onSelectionChange);
      if (suggest.box) suggest.box.remove();
      el.remove();
    },
    exec,
  };
}
