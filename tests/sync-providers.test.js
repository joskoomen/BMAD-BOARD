import os from 'os';
import fs from 'fs';
import {
  SYNC_PROVIDERS,
  getSyncProvider,
  getSyncProviderKeys,
  getSyncProviderList,
  contentHash,
  markdownToNotionBlocks,
  notionBlocksToMarkdown,
  parseFrontMatter,
  buildFrontMatter
} from '../lib/sync-providers.js';

// ── Provider Registry ───────────────────────────────────────────────────

describe('getSyncProvider', () => {
  it('returns notion provider by key', () => {
    const provider = getSyncProvider('notion');
    expect(provider).not.toBeNull();
    expect(provider.name).toBe('Notion');
  });

  it('returns obsidian provider by key', () => {
    const provider = getSyncProvider('obsidian');
    expect(provider).not.toBeNull();
    expect(provider.name).toBe('Obsidian Vault');
  });

  it('returns linear provider by key', () => {
    const provider = getSyncProvider('linear');
    expect(provider).not.toBeNull();
    expect(provider.name).toBe('Linear');
  });

  it('returns null for unknown keys', () => {
    expect(getSyncProvider('jira')).toBeNull();
    expect(getSyncProvider('')).toBeNull();
  });
});

describe('getSyncProviderKeys', () => {
  it('returns all provider keys', () => {
    const keys = getSyncProviderKeys();
    expect(keys).toContain('notion');
    expect(keys).toContain('obsidian');
    expect(keys).toContain('linear');
    expect(keys.length).toBe(3);
  });
});

describe('getSyncProviderList', () => {
  it('returns list with name and configFields', () => {
    const list = getSyncProviderList();
    expect(list.length).toBe(3);
    expect(list[0]).toHaveProperty('key');
    expect(list[0]).toHaveProperty('name');
    expect(list[0]).toHaveProperty('configFields');
  });
});

// ── Config Validation ───────────────────────────────────────────────────

describe('notion validateConfig', () => {
  it('requires apiKey and parentPageId', async () => {
    const provider = getSyncProvider('notion');
    const result = await provider.validateConfig({});
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('API Key is required');
    expect(result.errors).toContain('Parent Page ID is required');
  });

  it('passes with valid config', async () => {
    const provider = getSyncProvider('notion');
    const result = await provider.validateConfig({ apiKey: 'ntn_xxx', parentPageId: 'abc-123' });
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });
});

describe('obsidian validateConfig', () => {
  it('requires vaultPath', async () => {
    const provider = getSyncProvider('obsidian');
    const result = await provider.validateConfig({});
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Vault path is required');
  });

  it('passes with vaultPath', async () => {
    const result = await getSyncProvider('obsidian').validateConfig({ vaultPath: '/tmp/vault' });
    expect(result.valid).toBe(true);
  });
});

describe('linear validateConfig', () => {
  it('requires apiKey and teamId', async () => {
    const result = await getSyncProvider('linear').validateConfig({});
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(2);
  });
});

// ── Obsidian testConnection ─────────────────────────────────────────────

describe('obsidian testConnection', () => {
  it('fails if vault path does not exist', async () => {
    const result = await getSyncProvider('obsidian').testConnection({ vaultPath: '/nonexistent/vault' });
    expect(result.ok).toBe(false);
  });

  it('succeeds if vault path exists', async () => {
    const tmpDir = fs.mkdtempSync(os.tmpdir() + '/obsidian-test-');
    try {
      const result = await getSyncProvider('obsidian').testConnection({ vaultPath: tmpDir });
      expect(result.ok).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Content Hash ────────────────────────────────────────────────────────

describe('contentHash', () => {
  it('returns consistent hash for same content', () => {
    const hash1 = contentHash('hello world');
    const hash2 = contentHash('hello world');
    expect(hash1).toBe(hash2);
  });

  it('returns different hash for different content', () => {
    const hash1 = contentHash('hello');
    const hash2 = contentHash('world');
    expect(hash1).not.toBe(hash2);
  });

  it('handles empty string', () => {
    const hash = contentHash('');
    expect(hash).toBeTruthy();
  });

  it('handles null/undefined', () => {
    const hash = contentHash(null);
    expect(hash).toBeTruthy();
  });
});

// ── Markdown ↔ Notion Blocks ────────────────────────────────────────────

describe('markdownToNotionBlocks', () => {
  it('converts headings', () => {
    const blocks = markdownToNotionBlocks('# Title\n## Subtitle\n### Small');
    expect(blocks.length).toBe(3);
    expect(blocks[0].type).toBe('heading_1');
    expect(blocks[0].heading_1.rich_text[0].text.content).toBe('Title');
    expect(blocks[1].type).toBe('heading_2');
    expect(blocks[2].type).toBe('heading_3');
  });

  it('converts paragraphs', () => {
    const blocks = markdownToNotionBlocks('Hello world');
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe('paragraph');
    expect(blocks[0].paragraph.rich_text[0].text.content).toBe('Hello world');
  });

  it('converts code blocks', () => {
    const blocks = markdownToNotionBlocks('```javascript\nconst x = 1;\n```');
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe('code');
    expect(blocks[0].code.language).toBe('javascript');
    expect(blocks[0].code.rich_text[0].text.content).toBe('const x = 1;');
  });

  it('converts bullet lists', () => {
    const blocks = markdownToNotionBlocks('- Item 1\n- Item 2');
    expect(blocks.length).toBe(2);
    expect(blocks[0].type).toBe('bulleted_list_item');
    expect(blocks[0].bulleted_list_item.rich_text[0].text.content).toBe('Item 1');
  });

  it('converts numbered lists', () => {
    const blocks = markdownToNotionBlocks('1. First\n2. Second');
    expect(blocks.length).toBe(2);
    expect(blocks[0].type).toBe('numbered_list_item');
  });

  it('converts checkboxes', () => {
    const blocks = markdownToNotionBlocks('- [ ] Todo\n- [x] Done');
    expect(blocks.length).toBe(2);
    expect(blocks[0].type).toBe('to_do');
    expect(blocks[0].to_do.checked).toBe(false);
    expect(blocks[1].to_do.checked).toBe(true);
  });

  it('converts blockquotes', () => {
    const blocks = markdownToNotionBlocks('> A quote');
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe('quote');
  });

  it('converts horizontal rules', () => {
    const blocks = markdownToNotionBlocks('---');
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe('divider');
  });

  it('skips empty lines', () => {
    const blocks = markdownToNotionBlocks('Hello\n\nWorld');
    expect(blocks.length).toBe(2);
  });

  it('handles empty/null input', () => {
    expect(markdownToNotionBlocks('')).toEqual([]);
    expect(markdownToNotionBlocks(null)).toEqual([]);
  });
});

describe('notionBlocksToMarkdown', () => {
  it('converts heading blocks', () => {
    const blocks = [
      { type: 'heading_1', heading_1: { rich_text: [{ plain_text: 'Title' }] } },
      { type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Sub' }] } }
    ];
    const md = notionBlocksToMarkdown(blocks);
    expect(md).toBe('# Title\n## Sub');
  });

  it('converts paragraph blocks', () => {
    const blocks = [
      { type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Hello' }] } }
    ];
    expect(notionBlocksToMarkdown(blocks)).toBe('Hello');
  });

  it('converts code blocks', () => {
    const blocks = [{
      type: 'code',
      code: { language: 'js', rich_text: [{ plain_text: 'const x = 1;' }] }
    }];
    expect(notionBlocksToMarkdown(blocks)).toBe('```js\nconst x = 1;\n```');
  });

  it('converts to_do blocks', () => {
    const blocks = [
      { type: 'to_do', to_do: { checked: false, rich_text: [{ plain_text: 'Task' }] } },
      { type: 'to_do', to_do: { checked: true, rich_text: [{ plain_text: 'Done' }] } }
    ];
    expect(notionBlocksToMarkdown(blocks)).toBe('- [ ] Task\n- [x] Done');
  });

  it('converts divider', () => {
    const blocks = [{ type: 'divider', divider: {} }];
    expect(notionBlocksToMarkdown(blocks)).toBe('---');
  });

  it('handles empty input', () => {
    expect(notionBlocksToMarkdown([])).toBe('');
    expect(notionBlocksToMarkdown(null)).toBe('');
  });
});

describe('markdown roundtrip', () => {
  it('preserves basic markdown through conversion', () => {
    const original = '# Title\n\nSome paragraph\n\n- Item 1\n- Item 2\n\n---\n\n> Quote';
    const blocks = markdownToNotionBlocks(original);
    const result = notionBlocksToMarkdown(blocks);
    expect(result).toContain('# Title');
    expect(result).toContain('Some paragraph');
    expect(result).toContain('- Item 1');
    expect(result).toContain('---');
    expect(result).toContain('> Quote');
  });
});

// ── Front Matter ────────────────────────────────────────────────────────

describe('parseFrontMatter', () => {
  it('parses YAML front matter', () => {
    const content = '---\nslug: my-story\nstatus: done\n---\n\n# Story Content';
    const { frontMatter, body } = parseFrontMatter(content);
    expect(frontMatter.slug).toBe('my-story');
    expect(frontMatter.status).toBe('done');
    expect(body).toContain('# Story Content');
  });

  it('handles quoted values', () => {
    const content = '---\ntitle: "My Title"\n---\n\nBody';
    const { frontMatter } = parseFrontMatter(content);
    expect(frontMatter.title).toBe('My Title');
  });

  it('returns empty front matter for content without ---', () => {
    const { frontMatter, body } = parseFrontMatter('# Just Markdown');
    expect(frontMatter).toEqual({});
    expect(body).toBe('# Just Markdown');
  });

  it('handles null input', () => {
    const { frontMatter, body } = parseFrontMatter(null);
    expect(frontMatter).toEqual({});
    expect(body).toBe('');
  });
});

describe('buildFrontMatter', () => {
  it('builds YAML front matter', () => {
    const result = buildFrontMatter({ slug: 'test', status: 'done' }, '# Content');
    expect(result).toContain('---');
    expect(result).toContain('slug: test');
    expect(result).toContain('status: done');
    expect(result).toContain('# Content');
  });

  it('skips front matter if empty', () => {
    const result = buildFrontMatter({}, '# Content');
    expect(result).toBe('# Content');
  });

  it('skips null values', () => {
    const result = buildFrontMatter({ slug: 'test', status: null }, '# Content');
    expect(result).toContain('slug: test');
    expect(result).not.toContain('status');
  });
});

// ── Provider Config Fields ──────────────────────────────────────────────

describe('provider configFields', () => {
  it('notion has apiKey and parentPageId fields', () => {
    const fields = getSyncProvider('notion').configFields;
    expect(fields.find(f => f.key === 'apiKey')).toBeTruthy();
    expect(fields.find(f => f.key === 'parentPageId')).toBeTruthy();
  });

  it('obsidian has vaultPath field', () => {
    const fields = getSyncProvider('obsidian').configFields;
    expect(fields.find(f => f.key === 'vaultPath')).toBeTruthy();
  });

  it('linear has apiKey and teamId fields', () => {
    const fields = getSyncProvider('linear').configFields;
    expect(fields.find(f => f.key === 'apiKey')).toBeTruthy();
    expect(fields.find(f => f.key === 'teamId')).toBeTruthy();
  });
});
