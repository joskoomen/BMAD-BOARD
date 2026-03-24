import { describe, it, expect } from 'vitest';
import { MD } from '../lib/markdown.js';

// ── Basics ──────────────────────────────────────────────────────────────

describe('MD.render — basics', () => {
  it('returns empty string for falsy input', () => {
    expect(MD.render(null)).toBe('');
    expect(MD.render(undefined)).toBe('');
    expect(MD.render('')).toBe('');
  });

  it('wraps plain text in paragraph tags', () => {
    expect(MD.render('Hello world')).toBe('<p>Hello world</p>');
  });

  it('converts double newlines to paragraph breaks', () => {
    const result = MD.render('First paragraph\n\nSecond paragraph');
    expect(result).toContain('</p><p>');
    expect(result).toContain('First paragraph');
    expect(result).toContain('Second paragraph');
  });

  it('converts single newlines to <br>', () => {
    const result = MD.render('Line one\nLine two');
    expect(result).toContain('Line one<br>Line two');
  });
});

// ── Headers ─────────────────────────────────────────────────────────────

describe('MD.render — headers', () => {
  it('converts h1', () => {
    expect(MD.render('# Title')).toContain('<h1>Title</h1>');
  });

  it('converts h2', () => {
    expect(MD.render('## Subtitle')).toContain('<h2>Subtitle</h2>');
  });

  it('converts h3', () => {
    expect(MD.render('### Section')).toContain('<h3>Section</h3>');
  });

  it('converts h4', () => {
    expect(MD.render('#### Subsection')).toContain('<h4>Subsection</h4>');
  });

  it('does not convert mid-line hashes', () => {
    const result = MD.render('This is not # a header');
    expect(result).not.toContain('<h1>');
  });
});

// ── Inline formatting ───────────────────────────────────────────────────

describe('MD.render — inline formatting', () => {
  it('converts bold text', () => {
    expect(MD.render('This is **bold** text')).toContain('<strong>bold</strong>');
  });

  it('converts italic text', () => {
    expect(MD.render('This is *italic* text')).toContain('<em>italic</em>');
  });

  it('converts inline code', () => {
    expect(MD.render('Use `console.log` here')).toContain('<code>console.log</code>');
  });

  it('converts links', () => {
    const result = MD.render('[Click me](https://example.com)');
    expect(result).toContain('href="https://example.com"');
    expect(result).toContain('Click me');
  });
});

// ── Code blocks ─────────────────────────────────────────────────────────

describe('MD.render — code blocks', () => {
  it('converts fenced code blocks', () => {
    const result = MD.render('```js\nconst x = 1;\n```');
    expect(result).toContain('<pre><code class="lang-js">');
    expect(result).toContain('const x = 1;');
  });

  it('escapes HTML in code blocks', () => {
    const result = MD.render('```\n<div>test</div>\n```');
    expect(result).toContain('&lt;div&gt;');
    expect(result).not.toContain('<div>test</div>');
  });

  it('handles code blocks without language', () => {
    const result = MD.render('```\nplain code\n```');
    expect(result).toContain('<pre><code class="lang-">');
  });
});

// ── Lists ───────────────────────────────────────────────────────────────

describe('MD.render — lists', () => {
  it('converts unordered list items', () => {
    const result = MD.render('- Item one\n- Item two');
    expect(result).toContain('<li>Item one</li>');
    expect(result).toContain('<li>Item two</li>');
    expect(result).toContain('<ul>');
  });

  it('converts ordered list items', () => {
    const result = MD.render('1. First\n2. Second');
    expect(result).toContain('<li>First</li>');
    expect(result).toContain('<li>Second</li>');
  });

  it('converts checked checkboxes', () => {
    const result = MD.render('- [x] Done task');
    expect(result).toContain('checked');
    expect(result).toContain('Done task');
  });

  it('converts unchecked checkboxes', () => {
    const result = MD.render('- [ ] Pending task');
    expect(result).toContain('<input type="checkbox" disabled>');
    expect(result).toContain('Pending task');
    expect(result).not.toContain('checked');
  });
});

// ── Blockquotes ─────────────────────────────────────────────────────────

describe('MD.render — blockquotes', () => {
  it('converts blockquotes', () => {
    const result = MD.render('> This is a quote');
    expect(result).toContain('<blockquote>This is a quote</blockquote>');
  });
});

// ── Horizontal rules ────────────────────────────────────────────────────

describe('MD.render — horizontal rules', () => {
  it('converts --- to <hr>', () => {
    const result = MD.render('Above\n---\nBelow');
    expect(result).toContain('<hr>');
  });
});

// ── Tables ──────────────────────────────────────────────────────────────

describe('MD.render — tables', () => {
  it('converts simple tables with headers', () => {
    const md = '| Name | Value |\n|------|-------|\n| foo  | bar   |';
    const result = MD.render(md);
    expect(result).toContain('<table>');
    expect(result).toContain('<thead>');
    expect(result).toContain('<th>Name</th>');
    // Each group of <tr> becomes its own <table> with first row as header
    // The renderer makes every first row in a table group a header row
  });

  it('treats separator row as comment, not data row', () => {
    const md = '| A | B |\n|---|---|\n| 1 | 2 |';
    const result = MD.render(md);
    expect(result).not.toContain('<td>---</td>');
    expect(result).toContain('<!--table-sep-->');
  });
});

// ── MD.esc ──────────────────────────────────────────────────────────────

describe('MD.esc', () => {
  it('escapes ampersands', () => {
    expect(MD.esc('a & b')).toBe('a &amp; b');
  });

  it('escapes angle brackets', () => {
    expect(MD.esc('<script>')).toBe('&lt;script&gt;');
  });

  it('handles multiple entities', () => {
    expect(MD.esc('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });
});

// ── Complex / combined content ──────────────────────────────────────────

describe('MD.render — combined content', () => {
  it('handles mixed headers, lists, and code', () => {
    const md = `# Title

Some text with **bold** and *italic*.

- Item one
- Item two

\`\`\`js
const x = 1;
\`\`\``;
    const result = MD.render(md);
    expect(result).toContain('<h1>Title</h1>');
    expect(result).toContain('<strong>bold</strong>');
    expect(result).toContain('<em>italic</em>');
    expect(result).toContain('<li>Item one</li>');
    expect(result).toContain('<pre><code');
  });

  it('handles bold inside a list item', () => {
    const result = MD.render('- **Important** item');
    expect(result).toContain('<li><strong>Important</strong> item</li>');
  });

  it('handles links inside bold', () => {
    const result = MD.render('**[link](url)** text');
    expect(result).toContain('<a href="url"');
  });
});
