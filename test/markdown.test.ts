import { describe, it, expect } from 'vitest';
import { mdToHtml, commentToHtml } from '../src/lib/markdown.js';

describe('mdToHtml (article variant)', () => {
  it('converts headings h1-h4', () => {
    expect(mdToHtml('# Title')).toBe('<h1>Title</h1>');
    expect(mdToHtml('#### Small')).toBe('<h4>Small</h4>');
  });

  it('converts paragraphs and preserves single line breaks as <br/>', () => {
    expect(mdToHtml('line one\nline two')).toBe('<p>line one<br />line two</p>');
  });

  it('converts bold, italic, inline code, and links', () => {
    expect(mdToHtml('**bold**')).toBe('<p><strong>bold</strong></p>');
    expect(mdToHtml('a *word* here')).toBe('<p>a <em>word</em> here</p>');
    expect(mdToHtml('use `code`')).toBe('<p>use <code>code</code></p>');
    expect(mdToHtml('[Civitai](https://civitai.com)')).toBe(
      '<p><a href="https://civitai.com" rel="ugc" target="_blank">Civitai</a></p>'
    );
  });

  it('converts unordered and ordered lists', () => {
    expect(mdToHtml('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(mdToHtml('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
  });

  it('converts blockquotes and horizontal rules', () => {
    expect(mdToHtml('> quoted')).toBe('<blockquote><p>quoted</p></blockquote>');
    expect(mdToHtml('---')).toBe('<hr />');
  });

  it('escapes raw HTML in text', () => {
    expect(mdToHtml('a < b & c > d')).toBe('<p>a &lt; b &amp; c &gt; d</p>');
  });

  it('handles multiple blocks separated by blank lines', () => {
    expect(mdToHtml('# H\n\npara')).toBe('<h1>H</h1>\n<p>para</p>');
  });
});

describe('commentToHtml (restricted variant)', () => {
  it('emits only paragraphs with restricted inline tags', () => {
    expect(commentToHtml('hello **world**')).toBe('<p>hello <strong>world</strong></p>');
  });

  it('does not emit inline code (sanitized out)', () => {
    // backticks are left as literal text in comment mode
    expect(commentToHtml('use `code`')).toBe('<p>use `code`</p>');
  });

  it('joins paragraphs without newlines between them', () => {
    expect(commentToHtml('p1\n\np2')).toBe('<p>p1</p><p>p2</p>');
  });

  it('escapes raw HTML', () => {
    expect(commentToHtml('<script>')).toBe('<p>&lt;script&gt;</p>');
  });

  it('converts links', () => {
    expect(commentToHtml('[x](https://e.com)')).toBe(
      '<p><a href="https://e.com" rel="ugc" target="_blank">x</a></p>'
    );
  });
});
