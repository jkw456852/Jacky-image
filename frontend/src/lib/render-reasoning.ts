/**
 * Lightweight markdown renderers for agent output.
 *
 * renderReasoning — for reasoning/thinking text (kept stable).
 * renderMarkdown  — for assistant message body text. Supports:
 *   - # ## ### headers
 *   - **bold** / __bold__
 *   - *italic* / _italic_
 *   - ~~strikethrough~~
 *   - `inline code`
 *   - ```fenced code blocks```
 *   - [links](url)
 *   - * / - unordered lists
 *   - 1. 2. ordered lists
 *   - > blockquotes
 *   - GFM-style tables
 *   - ![alt](image-url) images
 *   - safe raw HTML subset
 *   - --- horizontal rules
 *
 * Always sanitizes HTML to prevent XSS.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function decodeCodePoint(value: number): string {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : '';
}

function decodeHtmlEntities(text: string): string {
  let value = text;
  for (let i = 0; i < 3; i++) {
    const next = value
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => decodeCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_m, decimal: string) => decodeCodePoint(parseInt(decimal, 10)));
    if (next === value) return next;
    value = next;
  }
  return value;
}

type UrlKind = 'link' | 'image';

function sanitizeUrl(raw: string, kind: UrlKind): string | null {
  const value = decodeHtmlEntities(raw).trim();
  if (!value || /[\u0000-\u001f\u007f<>]/.test(value)) return null;

  if (kind === 'image' && /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(value)) {
    return value.replace(/\s/g, '');
  }

  if (/^(#|\/|\.\/|\.\.\/)/.test(value)) return value;

  try {
    const url = new URL(value, 'https://local.invalid');
    const protocol = url.protocol.toLowerCase();
    const allowed = kind === 'image'
      ? ['http:', 'https:', 'blob:']
      : ['http:', 'https:', 'mailto:', 'tel:'];
    return allowed.includes(protocol) ? value : null;
  } catch {
    return null;
  }
}

const SAFE_HTML_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'code', 'del', 'details', 'div', 'em', 'figcaption',
  'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'kbd', 'li', 'mark',
  'ol', 'p', 'pre', 's', 'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul'
]);

const VOID_HTML_TAGS = new Set(['br', 'hr', 'img']);
const HTML_BLOCK_TAGS = new Set([
  'blockquote', 'details', 'div', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'li', 'ol', 'p', 'pre', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'tr', 'ul'
]);

const DANGEROUS_HTML_TAG_NAMES = [
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea',
  'select', 'option', 'meta', 'link', 'base', 'svg', 'math', 'video', 'audio', 'canvas'
].join('|');
const DANGEROUS_HTML_BLOCK_RE = new RegExp(`&lt;(${DANGEROUS_HTML_TAG_NAMES})(?:\\s(?:(?!&gt;)[\\s\\S])*)?&gt;[\\s\\S]*?&lt;\\/\\1&gt;`, 'gi');
const DANGEROUS_HTML_TAG_RE = new RegExp(`&lt;\\/?(?:${DANGEROUS_HTML_TAG_NAMES})(?:\\s(?:(?!&gt;)[\\s\\S])*)?\\/?&gt;`, 'gi');

function stripDangerousEscapedHtml(html: string): string {
  return html
    .replace(DANGEROUS_HTML_BLOCK_RE, '')
    .replace(DANGEROUS_HTML_TAG_RE, '');
}

function sanitizeHtmlAttributes(tag: string, rawAttrs: string): string {
  const attrs = decodeHtmlEntities(rawAttrs);
  const allowed: Record<string, Set<string>> = {
    a: new Set(['href', 'title']),
    img: new Set(['src', 'alt', 'title', 'width', 'height']),
    td: new Set(['align', 'colspan', 'rowspan']),
    th: new Set(['align', 'colspan', 'rowspan']),
    details: new Set(['open']),
  };
  const attrAllowList = allowed[tag];
  if (!attrAllowList) return '';

  const out: string[] = [];
  const attrRe = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(attrs))) {
    const name = match[1].toLowerCase();
    if (!attrAllowList.has(name) || name.startsWith('on')) continue;

    const rawValue = match[2] ?? match[3] ?? match[4] ?? '';
    if (tag === 'details' && name === 'open') {
      out.push('open');
      continue;
    }

    if ((tag === 'a' && name === 'href') || (tag === 'img' && name === 'src')) {
      const safeUrl = sanitizeUrl(rawValue, tag === 'img' ? 'image' : 'link');
      if (!safeUrl) continue;
      out.push(`${name}="${escapeHtml(safeUrl)}"`);
      continue;
    }

    if ((name === 'width' || name === 'height' || name === 'colspan' || name === 'rowspan') && !/^\d{1,4}$/.test(rawValue)) {
      continue;
    }

    if (name === 'align' && !/^(left|center|right)$/i.test(rawValue)) {
      continue;
    }

    out.push(`${name}="${escapeHtml(rawValue)}"`);
  }

  if (tag === 'a' && out.some(attr => attr.startsWith('href='))) {
    out.push('target="_blank"', 'rel="noopener noreferrer"', 'class="md-link"');
  }

  if (tag === 'img' && out.some(attr => attr.startsWith('src='))) {
    out.push('class="md-image"', 'loading="lazy"', 'decoding="async"');
  }

  return out.length > 0 ? ` ${out.join(' ')}` : '';
}

function sanitizeEscapedHtmlTag(match: string, closing: string | undefined, tagName: string, attrs: string, selfClosing: string | undefined): string {
  const tag = tagName.toLowerCase();
  if (!SAFE_HTML_TAGS.has(tag)) return match;
  if (closing) return VOID_HTML_TAGS.has(tag) ? '' : `</${tag}>`;

  const sanitizedAttrs = sanitizeHtmlAttributes(tag, attrs || '');
  if ((tag === 'a' && !sanitizedAttrs.includes('href=')) || (tag === 'img' && !sanitizedAttrs.includes('src='))) {
    return '';
  }

  return VOID_HTML_TAGS.has(tag) || selfClosing ? `<${tag}${sanitizedAttrs}>` : `<${tag}${sanitizedAttrs}>`;
}

function sanitizeEscapedHtmlPair(match: string, tagName: string, attrs: string, content: string): string {
  const tag = tagName.toLowerCase();
  if (tag !== 'a') return match;

  const sanitizedAttrs = sanitizeHtmlAttributes(tag, attrs || '');
  return sanitizedAttrs.includes('href=')
    ? `<a${sanitizedAttrs}>${content}</a>`
    : content;
}

function restoreSafeHtmlTags(html: string): string {
  return stripDangerousEscapedHtml(html)
    .replace(/&lt;(a)([^<>]*?)&gt;([\s\S]*?)&lt;\/\1&gt;/gi, sanitizeEscapedHtmlPair)
    .replace(/&lt;(\/)?([a-zA-Z][\w:-]*)([^<>]*?)(\/)?&gt;/g, sanitizeEscapedHtmlTag);
}

function isEscapedHtmlBlock(line: string): boolean {
  const match = line.match(/^&lt;\/?([a-zA-Z][\w:-]*)\b/);
  return Boolean(match && HTML_BLOCK_TAGS.has(match[1].toLowerCase()));
}

function renderInlineMarkdown(text: string): string {
  return renderInline(text);
}

// ---------------------------------------------------------------------------
// Inline rendering (called inside block-level content)
// ---------------------------------------------------------------------------

function renderInline(text: string): string {
  const inlineCodes: string[] = [];
  const generatedHtml: string[] = [];

  const stashGeneratedHtml = (html: string) => {
    const idx = generatedHtml.length;
    generatedHtml.push(html);
    return `\x00MDHTML${idx}\x00`;
  };

  const restoreInlineCodeText = (value: string) => value.replace(/\x00MDIC(\d+)\x00/g, (_m, idxStr: string) => {
    const idx = parseInt(idxStr, 10);
    return inlineCodes[idx] ?? '';
  });

  // Protect inline code from bold/italic/link/image/raw HTML processing.
  let t = text.replace(/`([^`]+)`/g, (_m, code: string) => {
    const idx = inlineCodes.length;
    inlineCodes.push(code);
    return `\x00MDIC${idx}\x00`;
  });

  // Images: ![alt](url "optional title")
  t = t.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;(.+?)&quot;|\s+"(.+?)")?\)/g,
    (match: string, alt: string, src: string, titleA?: string, titleB?: string) => {
      const safeSrc = sanitizeUrl(src, 'image');
      if (!safeSrc) return match;
      const title = titleA || titleB;
      const safeAlt = escapeHtml(decodeHtmlEntities(restoreInlineCodeText(alt)));
      const titleAttr = title ? ` title="${escapeHtml(decodeHtmlEntities(restoreInlineCodeText(title)))}"` : '';
      return stashGeneratedHtml(`<span class="md-image-card"><img class="md-image" src="${escapeHtml(safeSrc)}" alt="${safeAlt}"${titleAttr} loading="lazy" decoding="async" /></span>`);
    }
  );

  // Links: [text](url)
  t = t.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (match: string, label: string, href: string) => {
      const safeHref = sanitizeUrl(href, 'link');
      if (!safeHref) return match;
      return stashGeneratedHtml(`<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer" class="md-link">${label}</a>`);
    }
  );

  // Bold (**text** or __text__)
  t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/__(.+?)__/g, '<strong>$1</strong>');

  // Italic (*text* or _text_) — careful not to overlap with bold
  t = t.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  t = t.replace(/(?<!_)_([^_]+)_(?!_)/g, '<em>$1</em>');

  // Strikethrough
  t = t.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // Restore safe raw HTML tags outside generated markdown HTML and inline code.
  t = restoreSafeHtmlTags(t);

  t = t.replace(/\x00MDHTML(\d+)\x00/g, (_m, idxStr: string) => {
    const idx = parseInt(idxStr, 10);
    return generatedHtml[idx] ?? _m;
  });

  t = t.replace(/\x00MDIC(\d+)\x00/g, (_m, idxStr: string) => {
    const idx = parseInt(idxStr, 10);
    const code = inlineCodes[idx];
    return code !== undefined
      ? `<code class="md-inline-code">${code}</code>`
      : _m;
  });

  return t;
}

// ---------------------------------------------------------------------------
// Full markdown renderer for assistant messages
// ---------------------------------------------------------------------------

const FENCE_RE = /```([^\n`]*)\n?([\s\S]*?)```/g;
const CB_PLACEHOLDER = '\x00MD_CB_';
const CB_PLACEHOLDER_RE = /^\x00MD_CB_(\d+)\x00$/;

function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
  }

  return btoa(binary);
}

function renderCodeBlockCard(block: { code: string; lang: string }): string {
  const trimmed = block.code.replace(/^\n+|\n+$/g, '');
  const encoded = encodeBase64Utf8(trimmed);
  const lang = block.lang.trim();
  const langLabel = lang ? escapeHtml(lang) : 'code';
  const copyButton = `<button class="md-code-copy" data-code="${encoded}" title="复制代码" type="button" aria-label="复制代码"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>`;

  return `<figure class="md-code-card"><figcaption class="md-code-header"><span class="md-code-lang">${langLabel}</span>${copyButton}</figcaption><pre class="md-code-block"><code>${escapeHtml(trimmed)}</code></pre></figure>`;
}

type TableAlign = 'left' | 'center' | 'right' | null;

function splitTableRow(row: string): string[] {
  const normalized = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  return normalized
    .split(/(?<!\\)\|/g)
    .map(cell => cell.replace(/\\\|/g, '|').trim());
}

function parseTableAlign(cell: string): TableAlign | false {
  const normalized = cell.trim();
  if (!/^:?-{3,}:?$/.test(normalized)) return false;
  if (normalized.startsWith(':') && normalized.endsWith(':')) return 'center';
  if (normalized.endsWith(':')) return 'right';
  if (normalized.startsWith(':')) return 'left';
  return null;
}

function parseTableDivider(line: string): TableAlign[] | null {
  if (!line.includes('|')) return null;
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const aligns = cells.map(parseTableAlign);
  return aligns.every(align => align !== false) ? (aligns as TableAlign[]) : null;
}

function isTableRow(line: string): boolean {
  return line.includes('|') && splitTableRow(line).length > 1;
}

function tableCellClass(align: TableAlign): string {
  switch (align) {
    case 'left': return ' class="md-table-align-left"';
    case 'center': return ' class="md-table-align-center"';
    case 'right': return ' class="md-table-align-right"';
    default: return '';
  }
}

function renderTableBlock(headerLine: string, dividerLine: string, bodyLines: string[]): string | null {
  const aligns = parseTableDivider(dividerLine);
  if (!aligns) return null;

  const headers = splitTableRow(headerLine);
  const width = Math.max(headers.length, aligns.length);
  const head = Array.from({ length: width }, (_, idx) => {
    const content = headers[idx] ?? '';
    return `<th${tableCellClass(aligns[idx] ?? null)}>${renderInlineMarkdown(content)}</th>`;
  }).join('');

  const body = bodyLines.map(row => {
    const cells = splitTableRow(row);
    const tds = Array.from({ length: width }, (_, idx) => {
      const content = cells[idx] ?? '';
      return `<td${tableCellClass(aligns[idx] ?? null)}>${renderInlineMarkdown(content)}</td>`;
    }).join('');
    return `<tr>${tds}</tr>`;
  }).join('');

  return `<div class="md-table-card"><div class="md-table-scroll"><table class="md-table"><thead><tr>${head}</tr></thead>${body ? `<tbody>${body}</tbody>` : ''}</table></div></div>`;
}

function renderBlockquoteBlock(quoteLines: string[]): string {
  const paragraphs: string[][] = [];
  let current: string[] = [];

  for (const line of quoteLines) {
    if (!line.trim()) {
      if (current.length > 0) {
        paragraphs.push(current);
        current = [];
      }
      continue;
    }
    current.push(line.trim());
  }

  if (current.length > 0) paragraphs.push(current);

  const content = paragraphs.length > 0
    ? paragraphs.map(lines => `<p>${lines.map(renderInlineMarkdown).join('<br />')}</p>`).join('')
    : '<p></p>';

  return `<blockquote class="md-blockquote">${content}</blockquote>`;
}

function renderSafeHtmlBlock(line: string): string {
  return restoreSafeHtmlTags(line);
}

/**
 * Convert markdown text to safe HTML. Supports block-level and inline
 * elements commonly emitted by LLM output.
 *
 * @param raw - Raw markdown text.
 * @returns HTML string safe for dangerouslySetInnerHTML.
 */
export function renderMarkdown(raw: string): string {
  // 1. Extract and protect fenced code blocks
  const codeBlocks: { code: string; lang: string }[] = [];
  let text = raw.replace(FENCE_RE, (_m, lang: string, code: string) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ code, lang: lang || '' });
    return `${CB_PLACEHOLDER}${idx}\x00`;
  });

  // 2. Escape HTML everywhere, then remove dangerous HTML blocks before line parsing
  text = stripDangerousEscapedHtml(escapeHtml(text));

  // 3. Line-by-line block-level processing
  const lines = text.split('\n');
  const out: string[] = [];
  let inList: 'ul' | 'ol' | null = null;

  const closeList = () => {
    if (!inList) return;
    out.push(`</${inList}>`);
    inList = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      closeList();
      continue;
    }

    const codeBlockMatch = trimmed.match(CB_PLACEHOLDER_RE);
    if (codeBlockMatch) {
      closeList();
      const block = codeBlocks[parseInt(codeBlockMatch[1], 10)];
      if (block) out.push(renderCodeBlockCard(block));
      continue;
    }

    if (i + 1 < lines.length && isTableRow(trimmed) && parseTableDivider(lines[i + 1].trim())) {
      const dividerLine = lines[i + 1].trim();
      const bodyLines: string[] = [];
      let j = i + 2;

      while (j < lines.length) {
        const candidate = lines[j].trim();
        if (!candidate || candidate.match(CB_PLACEHOLDER_RE) || !isTableRow(candidate) || parseTableDivider(candidate)) break;
        bodyLines.push(candidate);
        j++;
      }

      const table = renderTableBlock(trimmed, dividerLine, bodyLines);
      if (table) {
        closeList();
        out.push(table);
        i = j - 1;
        continue;
      }
    }

    if (/^&gt;\s?/.test(trimmed)) {
      const quoteLines: string[] = [];
      let j = i;

      while (j < lines.length) {
        const candidate = lines[j].trim();
        if (!/^&gt;\s?/.test(candidate)) break;
        quoteLines.push(candidate.replace(/^&gt;\s?/, ''));
        j++;
      }

      closeList();
      out.push(renderBlockquoteBlock(quoteLines));
      i = j - 1;
      continue;
    }

    if (isEscapedHtmlBlock(trimmed)) {
      closeList();
      out.push(renderSafeHtmlBlock(line));
      continue;
    }

    // Headers (# ## ### #### ##### ######)
    const hMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (hMatch) {
      closeList();
      const level = hMatch[1].length;
      out.push(
        `<h${level} class="md-h${level}">${renderInlineMarkdown(hMatch[2])}</h${level}>`
      );
      continue;
    }

    // Horizontal rules (---, ***, ___)
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      closeList();
      out.push('<hr class="md-hr" />');
      continue;
    }

    // Unordered lists (* / -)
    if (/^[\*\-]\s/.test(trimmed)) {
      if (inList !== 'ul') {
        closeList();
        out.push('<ul class="md-list">');
        inList = 'ul';
      }
      const content = trimmed.replace(/^[\*\-]\s+/, '');
      out.push(`<li>${renderInlineMarkdown(content)}</li>`);
      continue;
    }

    // Ordered lists (1. 2. ...)
    if (/^\d+\.\s/.test(trimmed)) {
      if (inList !== 'ol') {
        closeList();
        out.push('<ol class="md-list">');
        inList = 'ol';
      }
      const content = trimmed.replace(/^\d+\.\s+/, '');
      out.push(`<li>${renderInlineMarkdown(content)}</li>`);
      continue;
    }

    closeList();
    out.push(`<p>${renderInlineMarkdown(trimmed)}</p>`);
  }

  closeList();

  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Legacy renderer for reasoning / thinking text
// ---------------------------------------------------------------------------

/**
 * Convert basic markdown to safe HTML. Handles the subset commonly found
 * in model reasoning output: bold, italic, inline code, code blocks.
 *
 * @param raw - The raw markdown text.
 * @returns HTML string safe for dangerouslySetInnerHTML.
 */
export function renderReasoning(raw: string): string {
  let html = escapeHtml(raw);

  // Code blocks (```...```) — must process before inline code
  html = html.replace(
    /<code>([\s\S]*?)<\/code>/g,
    (_, code: string) =>
      `<pre class="reasoning-code-block"><code>${code}</code></pre>`
  );

  // Inline code (`...`)
  html = html.replace(
    /`([^`]+)`/g,
    '<code class="reasoning-inline-code">$1</code>'
  );

  // Bold (**text** or __text__)
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');

  // Italic (*text* or _text_) — careful not to overlap with bold
  html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  html = html.replace(/(?<!_)_([^_]+)_(?!_)/g, '<em>$1</em>');

  return html;
}