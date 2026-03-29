/**
 * @module markdown
 * @description Simple Markdown Renderer — lightweight markdown-to-HTML converter
 * with no external dependencies. Supports headers, bold/italic, code blocks,
 * inline code, lists (ordered, unordered, checkboxes), blockquotes, tables,
 * links, and horizontal rules.
 *
 * Used by both the Electron renderer (inline copy) and the companion server
 * for rendering BMAD story/document content.
 */

const MD = {
  /**
   * Convert a markdown string to an HTML string.
   * Processes fenced code blocks, inline code, headers (h1-h4), bold, italic,
   * checkboxes, lists, blockquotes, horizontal rules, simple tables, and links.
   * Wraps loose `<li>` elements in `<ul>` and loose `<tr>` elements in `<table>`.
   *
   * @param {string} text - Raw markdown text.
   * @returns {string} HTML string wrapped in `<p>` tags.
   */
  render(text) {
    if (!text) return '';
    let html = text
      // Code blocks (fenced)
      .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
        `<pre><code class="lang-${lang}">${this.esc(code.trim())}</code></pre>`)
      // Inline code
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      // Headers
      .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      // Bold & italic
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      // Checkboxes
      .replace(/^(\s*)- \[x\] (.+)$/gm, '$1<li style="list-style:none"><input type="checkbox" checked disabled> $2</li>')
      .replace(/^(\s*)- \[ \] (.+)$/gm, '$1<li style="list-style:none"><input type="checkbox" disabled> $2</li>')
      // Unordered lists
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      // Ordered lists
      .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
      // Blockquotes
      .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
      // Horizontal rules
      .replace(/^---$/gm, '<hr>')
      // Tables (simple)
      .replace(/^\|(.+)\|$/gm, (match) => {
        const cells = match.split('|').filter(c => c.trim());
        if (cells.every(c => c.trim().match(/^[-:]+$/))) return '<!--table-sep-->';
        const tag = 'td';
        return '<tr>' + cells.map(c => `<${tag}>${c.trim()}</${tag}>`).join('') + '</tr>';
      })
      // Links
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:var(--accent)">$1</a>')
      // Paragraphs (blank lines)
      .replace(/\n\n/g, '</p><p>')
      // Line breaks
      .replace(/\n/g, '<br>');

    // Wrap loose <li> in <ul>
    html = html.replace(/((?:<li[^>]*>.*?<\/li>\s*(?:<br>)?)+)/g, '<ul>$1</ul>');
    // Wrap <tr> in <table>
    html = html.replace(/((?:<tr>.*?<\/tr>\s*(?:<!--table-sep-->)?\s*(?:<br>)?)+)/g, (m) => {
      const cleaned = m.replace(/<!--table-sep-->/g, '').replace(/<br>/g, '');
      // Make first row headers
      const first = cleaned.replace(/<tr>(.*?)<\/tr>/, (_, inner) =>
        '<thead><tr>' + inner.replace(/<td>/g, '<th>').replace(/<\/td>/g, '</th>') + '</tr></thead>');
      return '<table>' + first + '</table>';
    });

    return '<p>' + html + '</p>';
  },

  /**
   * Escape HTML special characters to prevent XSS when embedding user content.
   *
   * @param {string} str - Raw string to escape.
   * @returns {string} HTML-safe string with &, <, > escaped.
   */
  esc(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
};

module.exports = { MD };
