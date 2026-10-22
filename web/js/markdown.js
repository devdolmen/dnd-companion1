// Tiny markdown renderer with Obsidian-style [[wikilinks]] and #tags. Pure.

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const WIKI_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;
const TAG_RE = /(^|[\s(])#([A-Za-z][\w/-]*)/g;

export function extractLinks(md) {
  const out = new Set();
  const src = stripCode(md);
  for (const m of src.matchAll(WIKI_RE)) out.add(m[1].trim());
  return [...out];
}

export function extractTags(md) {
  const out = new Set();
  const src = stripCode(md);
  for (const m of src.matchAll(TAG_RE)) out.add(m[2].toLowerCase());
  return [...out];
}

function stripCode(md) {
  return String(md || '').replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

const PH = '\u0000';

function inline(text, opts) {
  const resolve = opts.resolveLink || (() => ({ exists: true }));
  const codes = []; const links = [];
  let s = String(text);
  // Pull out code spans and wikilinks BEFORE escaping so titles with ' & < > survive intact.
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `${PH}C${codes.length - 1}${PH}`; });
  s = s.replace(WIKI_RE, (_, title, alias) => { links.push({ title: title.trim(), alias: alias ? alias.trim() : null }); return `${PH}L${links.length - 1}${PH}`; });
  s = escapeHtml(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => `<img alt="${alt}" src="${url}">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    const safe = /^(https?:|mailto:)/i.test(url) ? url : '#';
    return `<a href="${safe}" target="_blank" rel="noopener">${label}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/==([^=]+)==/g, '<mark>$1</mark>');
  s = s.replace(TAG_RE, (_, pre, tag) => `${pre}<a class="tag" data-tag="${tag.toLowerCase()}" href="#">#${tag}</a>`);
  s = s.replace(/\u0000L(\d+)\u0000/g, (_, i) => {
    const l = links[Number(i)]; const info = resolve(l.title) || {};
    const cls = info.exists ? 'wikilink' : 'wikilink missing';
    return `<a class="${cls}" data-title="${escapeHtml(l.title)}" href="#">${escapeHtml(l.alias || l.title)}</a>`;
  });
  s = s.replace(/\u0000C(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
  return s;
}

export function render(md, opts = {}) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const listStack = []; // {type:'ul'|'ol', indent}

  let lastIsList = false;
  const emit = (html) => { if (lastIsList) out[out.length - 1] += html; else out.push(html); lastIsList = true; };
  const closeLists = (toIndent = -1) => {
    while (listStack.length && listStack[listStack.length - 1].indent > toIndent) {
      emit(`</li></${listStack.pop().type}>`);
    }
    if (!listStack.length) lastIsList = false;
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      closeLists();
      const lang = line.slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code${lang ? ` class="lang-${escapeHtml(lang)}"` : ''}>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    if (/^\s*$/.test(line)) { closeLists(); i++; continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeLists();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(h[2], opts)}</h${lvl}>`);
      i++; continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { closeLists(); out.push('<hr>'); i++; continue; }

    if (/^>/.test(line)) {
      closeLists();
      const buf = [];
      while (i < lines.length && /^>/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${render(buf.join('\n'), opts)}</blockquote>`);
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      closeLists();
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      const aligns = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : 'left'));
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      let t = '<div class="table-wrap"><table><thead><tr>';
      head.forEach((c, k) => { t += `<th style="text-align:${aligns[k] || 'left'}">${inline(c, opts)}</th>`; });
      t += '</tr></thead><tbody>';
      for (const r of rows) {
        t += '<tr>';
        head.forEach((_, k) => { t += `<td style="text-align:${aligns[k] || 'left'}">${inline(r[k] || '', opts)}</td>`; });
        t += '</tr>';
      }
      t += '</tbody></table></div>';
      out.push(t);
      continue;
    }

    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      const indent = li[1].replace(/\t/g, '  ').length;
      const type = /\d/.test(li[2]) ? 'ol' : 'ul';
      let content = li[3];
      let cls = '';
      const task = content.match(/^\[([ xX])\]\s+(.*)$/);
      if (task) {
        const checked = task[1] !== ' ';
        content = task[2];
        cls = ' class="task"';
        content = `<input type="checkbox" data-line="${i}" ${checked ? 'checked' : ''}> <span${checked ? ' class="done"' : ''}>${inline(content, opts)}</span>`;
      } else {
        content = inline(content, opts);
      }
      const top = listStack[listStack.length - 1];
      if (!top || indent > top.indent) {
        listStack.push({ type, indent });
        emit(`<${type}><li${cls}>${content}`);
      } else {
        closeLists(indent);
        const cur = listStack[listStack.length - 1];
        if (cur && cur.indent === indent) {
          if (cur.type !== type) { emit(`</li></${cur.type}>`); listStack.pop(); listStack.push({ type, indent }); emit(`<${type}><li${cls}>${content}`); }
          else emit(`</li><li${cls}>${content}`);
        } else {
          listStack.push({ type, indent });
          emit(`<${type}><li${cls}>${content}`);
        }
      }
      i++; continue;
    }

    // Paragraph: gather until blank / block start
    closeLists();
    const buf = [line];
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s|\s*\|)/.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${buf.map((l) => inline(l, opts)).join('<br>')}</p>`);
  }
  closeLists();
  return out.join('\n');
}

// Toggle the Nth checkbox line in markdown source. Returns new source.
export function toggleTask(md, lineIndex) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const l = lines[lineIndex];
  if (l == null) return md;
  if (/\[ \]/.test(l)) lines[lineIndex] = l.replace('[ ]', '[x]');
  else lines[lineIndex] = l.replace(/\[[xX]\]/, '[ ]');
  return lines.join('\n');
}
