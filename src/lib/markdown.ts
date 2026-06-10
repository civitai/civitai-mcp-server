/**
 * Zero-dependency Markdown -> HTML converters, ported from the civitai-user
 * skill (lib.mjs + comment.mjs). Two variants:
 *
 *  - mdToHtml: full article/changelog converter (h1-h4, lists, blockquotes,
 *    hr, bold/italic/inline-code, links, paragraphs with <br/> line breaks).
 *  - commentToHtml: restricted converter for comments, which the server
 *    sanitizes to a narrow tag set (p, div, strong, em, u, s, a, br, span).
 *
 * The server runs its own sanitizer; these just need to emit reasonable HTML.
 */

/** Inline replacements shared by both converters (article-flavored: includes code). */
function inlineArticle(text: string): string {
  let s = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Links [text](url "title")
  s = s.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
    (_m, txt: string, url: string, title?: string) => {
      const t = title ? ` title="${title}"` : '';
      return `<a href="${url}" rel="ugc" target="_blank"${t}>${txt}</a>`;
    }
  );

  // Bold **text**
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic *text* (avoid bold markers, require non-space boundaries)
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  // Inline code `text`
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');

  return s;
}

/** Inline replacements for comments: no inline code (sanitized out anyway). */
function inlineComment(text: string): string {
  let s = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  s = s.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, t: string, url: string) => `<a href="${url}" rel="ugc" target="_blank">${t}</a>`
  );
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  return s;
}

/**
 * Full Markdown -> HTML for article and changelog content.
 */
export function mdToHtml(md: string): string {
  let src = md.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  src = src.replace(/^﻿/, ''); // strip BOM

  const blocks = src.split(/\n{2,}/);
  const out: string[] = [];

  for (let block of blocks) {
    block = block.trim();
    if (!block) continue;

    // Horizontal rule
    if (/^(---+|\*\*\*+|___+)$/.test(block)) {
      out.push('<hr />');
      continue;
    }

    // ATX headings (single-line only)
    const h = block.match(/^(#{1,4})\s+(.*)$/s);
    if (h && h[2] !== undefined && !h[2].includes('\n')) {
      const level = h[1]!.length;
      out.push(`<h${level}>${inlineArticle(h[2])}</h${level}>`);
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(block)) {
      const inner = block
        .split('\n')
        .map((l) => l.replace(/^>\s?/, ''))
        .join(' ');
      out.push(`<blockquote><p>${inlineArticle(inner)}</p></blockquote>`);
      continue;
    }

    // Unordered list
    if (/^[-*+]\s+/.test(block)) {
      const items = block
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => {
          const m = l.match(/^[-*+]\s+(.*)$/);
          return `<li>${inlineArticle(m ? m[1]! : l.trim())}</li>`;
        });
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(block)) {
      const items = block
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => {
          const m = l.match(/^\d+\.\s+(.*)$/);
          return `<li>${inlineArticle(m ? m[1]! : l.trim())}</li>`;
        });
      out.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // Default: paragraph, preserving intentional line breaks as <br/>.
    const lines = block.split('\n').map((l) => inlineArticle(l)).join('<br />');
    out.push(`<p>${lines}</p>`);
  }

  return out.join('\n');
}

/**
 * Restricted Markdown -> HTML for comments. Only emits p / br / strong / em / a,
 * matching the server's comment sanitizer (p, div, strong, em, u, s, a, br, span).
 */
export function commentToHtml(input: string): string {
  const src = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const paragraphs = src.split(/\n{2,}/);
  const out: string[] = [];
  for (const p of paragraphs) {
    if (!p.trim()) continue;
    const lines = p.split('\n').map(inlineComment).join('<br />');
    out.push(`<p>${lines}</p>`);
  }
  return out.join('');
}
