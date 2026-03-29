/**
 * Sync Provider Registry
 *
 * Generic provider abstraction for syncing BMAD project data to external
 * platforms (Notion, Obsidian, Linear). Each provider implements a common
 * interface for push/pull/conversion operations.
 *
 * Follows the same registry pattern as lib/llm-providers.js.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Helpers ─────────────────────────────────────────────────────────────

/** Compute content hash for change detection. */
function contentHash(str) {
  return crypto.createHash('md5').update(str || '').digest('hex');
}

/** Simple rate limiter: resolves after `ms` milliseconds. */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Markdown ↔ Notion Blocks ────────────────────────────────────────────

/**
 * Convert markdown text to an array of Notion block objects.
 * Handles: headings, paragraphs, code blocks, bullet/numbered lists,
 * checkboxes, blockquotes, and horizontal rules.
 */
function markdownToNotionBlocks(md) {
  if (!md) return [];
  const blocks = [];
  const lines = md.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block (fenced)
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim() || 'plain text';
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push({
        object: 'block',
        type: 'code',
        code: {
          rich_text: [{ type: 'text', text: { content: codeLines.join('\n') } }],
          language: lang
        }
      });
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const type = `heading_${level}`;
      blocks.push({
        object: 'block',
        type,
        [type]: { rich_text: [{ type: 'text', text: { content: headingMatch[2] } }] }
      });
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|_{3,}|\*{3,})$/.test(line.trim())) {
      blocks.push({ object: 'block', type: 'divider', divider: {} });
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      blocks.push({
        object: 'block',
        type: 'quote',
        quote: { rich_text: [{ type: 'text', text: { content: line.slice(2) } }] }
      });
      i++;
      continue;
    }

    // Checkbox (to_do)
    const todoMatch = line.match(/^[-*]\s+\[([ xX])\]\s+(.*)/);
    if (todoMatch) {
      blocks.push({
        object: 'block',
        type: 'to_do',
        to_do: {
          rich_text: [{ type: 'text', text: { content: todoMatch[2] } }],
          checked: todoMatch[1] !== ' '
        }
      });
      i++;
      continue;
    }

    // Bullet list
    if (/^[-*]\s+/.test(line)) {
      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: [{ type: 'text', text: { content: line.replace(/^[-*]\s+/, '') } }]
        }
      });
      i++;
      continue;
    }

    // Numbered list
    const numMatch = line.match(/^\d+\.\s+(.*)/);
    if (numMatch) {
      blocks.push({
        object: 'block',
        type: 'numbered_list_item',
        numbered_list_item: {
          rich_text: [{ type: 'text', text: { content: numMatch[1] } }]
        }
      });
      i++;
      continue;
    }

    // Empty line — skip
    if (!line.trim()) {
      i++;
      continue;
    }

    // Paragraph (default)
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: line } }] }
    });
    i++;
  }

  return blocks;
}

/**
 * Convert an array of Notion block objects back to markdown.
 */
function notionBlocksToMarkdown(blocks) {
  if (!blocks || !blocks.length) return '';
  const lines = [];

  for (const block of blocks) {
    const getText = (richText) =>
      (richText || []).map(t => t.plain_text || t.text?.content || '').join('');

    switch (block.type) {
      case 'heading_1':
        lines.push(`# ${getText(block.heading_1?.rich_text)}`);
        break;
      case 'heading_2':
        lines.push(`## ${getText(block.heading_2?.rich_text)}`);
        break;
      case 'heading_3':
        lines.push(`### ${getText(block.heading_3?.rich_text)}`);
        break;
      case 'paragraph':
        lines.push(getText(block.paragraph?.rich_text));
        break;
      case 'code':
        lines.push(`\`\`\`${block.code?.language || ''}`);
        lines.push(getText(block.code?.rich_text));
        lines.push('```');
        break;
      case 'bulleted_list_item':
        lines.push(`- ${getText(block.bulleted_list_item?.rich_text)}`);
        break;
      case 'numbered_list_item':
        lines.push(`1. ${getText(block.numbered_list_item?.rich_text)}`);
        break;
      case 'to_do':
        lines.push(`- [${block.to_do?.checked ? 'x' : ' '}] ${getText(block.to_do?.rich_text)}`);
        break;
      case 'quote':
        lines.push(`> ${getText(block.quote?.rich_text)}`);
        break;
      case 'divider':
        lines.push('---');
        break;
      default:
        // Unsupported block type — try to extract text
        if (block[block.type]?.rich_text) {
          lines.push(getText(block[block.type].rich_text));
        }
        break;
    }
  }

  return lines.join('\n');
}

// ── Obsidian Front Matter ───────────────────────────────────────────────

/** Parse YAML front matter from markdown content. */
function parseFrontMatter(content) {
  if (!content || !content.startsWith('---')) {
    return { frontMatter: {}, body: content || '' };
  }
  const endIdx = content.indexOf('---', 3);
  if (endIdx === -1) return { frontMatter: {}, body: content };

  const yamlBlock = content.slice(3, endIdx).trim();
  const frontMatter = {};
  for (const line of yamlBlock.split('\n')) {
    const match = line.match(/^(\w[\w-]*):\s*(.+)/);
    if (match) {
      let val = match[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      frontMatter[match[1]] = val;
    }
  }
  const body = content.slice(endIdx + 3).replace(/^\n+/, '');
  return { frontMatter, body };
}

/** Serialize front matter + body back to markdown with YAML header. */
function buildFrontMatter(frontMatter, body) {
  const entries = Object.entries(frontMatter).filter(([, v]) => v != null);
  if (!entries.length) return body;
  const yaml = entries.map(([k, v]) => `${k}: ${v}`).join('\n');
  return `---\n${yaml}\n---\n\n${body}`;
}

// ── Provider: Notion ────────────────────────────────────────────────────

const notionProvider = {
  name: 'Notion',

  configFields: [
    { key: 'apiKey', label: 'API Key (Integration Token)', type: 'password', required: true },
    { key: 'parentPageId', label: 'Parent Page ID', type: 'text', required: true,
      hint: 'The Notion page under which databases will be created' }
  ],

  _getClient(config) {
    const { Client } = require('@notionhq/client');
    return new Client({ auth: config.apiKey });
  },

  async validateConfig(config) {
    const errors = [];
    if (!config.apiKey) errors.push('API Key is required');
    if (!config.parentPageId) errors.push('Parent Page ID is required');
    return { valid: errors.length === 0, errors };
  },

  async testConnection(config) {
    try {
      const notion = this._getClient(config);
      const user = await notion.users.me({});
      return { ok: true, message: `Connected as ${user.name || user.id}` };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  },

  /**
   * Create Epics database, Stories database (with relation), and
   * Documents parent page under the configured parent page.
   */
  async setup(config, projectData) {
    const notion = this._getClient(config);
    const parentId = config.parentPageId;
    const projectName = projectData?.projectMeta?.name || 'BMAD Project';

    // Create Epics database
    const epicsDb = await notion.databases.create({
      parent: { page_id: parentId },
      title: [{ type: 'text', text: { content: `${projectName} — Epics` } }],
      properties: {
        Title: { title: {} },
        Key: { rich_text: {} },
        Status: { select: {
          options: [
            { name: 'backlog', color: 'default' },
            { name: 'ready-for-dev', color: 'yellow' },
            { name: 'in-progress', color: 'blue' },
            { name: 'review', color: 'purple' },
            { name: 'done', color: 'green' }
          ]
        }},
        Number: { number: {} }
      }
    });

    // Create Stories database with relation to Epics
    const storiesDb = await notion.databases.create({
      parent: { page_id: parentId },
      title: [{ type: 'text', text: { content: `${projectName} — Stories` } }],
      properties: {
        Title: { title: {} },
        Slug: { rich_text: {} },
        Status: { select: {
          options: [
            { name: 'backlog', color: 'default' },
            { name: 'ready-for-dev', color: 'yellow' },
            { name: 'in-progress', color: 'blue' },
            { name: 'review', color: 'purple' },
            { name: 'done', color: 'green' }
          ]
        }},
        Epic: { relation: { database_id: epicsDb.id, single_property: {} } },
        'Epic Number': { number: {} },
        'Story Number': { rich_text: {} }
      }
    });

    // Create Documents parent page
    const docsPage = await notion.pages.create({
      parent: { page_id: parentId },
      properties: {
        title: [{ type: 'text', text: { content: `${projectName} — Documents` } }]
      }
    });

    return {
      epicsDatabaseId: epicsDb.id,
      storiesDatabaseId: storiesDb.id,
      documentsPageId: docsPage.id
    };
  },

  /**
   * Push local BMAD data to Notion.
   * Returns updated mappings for synced items.
   */
  async push(config, syncState, projectData) {
    const notion = this._getClient(config);
    const results = { epics: {}, stories: {}, documents: {} };
    const mappings = syncState.mappings || {};

    // Push epics
    for (const epic of (projectData.epics || [])) {
      await delay(350); // Rate limit: ~3 req/sec
      const existing = mappings.epics?.[epic.key];
      const hash = contentHash(JSON.stringify({ title: epic.title, status: epic.status }));

      if (existing?.contentHash === hash) {
        results.epics[epic.key] = existing;
        continue;
      }

      const properties = {
        Title: { title: [{ text: { content: epic.title || `Epic ${epic.number}` } }] },
        Key: { rich_text: [{ text: { content: epic.key } }] },
        Status: { select: { name: epic.status || 'backlog' } },
        Number: { number: epic.number }
      };

      let pageId;
      if (existing?.remoteId) {
        await notion.pages.update({ page_id: existing.remoteId, properties });
        pageId = existing.remoteId;
      } else {
        const page = await notion.pages.create({
          parent: { database_id: config.epicsDatabaseId },
          properties
        });
        pageId = page.id;
      }

      results.epics[epic.key] = {
        remoteId: pageId,
        lastSync: new Date().toISOString(),
        contentHash: hash
      };
    }

    // Push stories
    for (const epic of (projectData.epics || [])) {
      for (const story of (epic.stories || [])) {
        await delay(350);
        const existing = mappings.stories?.[story.slug];
        const hash = contentHash(story.content || '');

        if (existing?.contentHash === hash) {
          results.stories[story.slug] = existing;
          continue;
        }

        const epicMapping = results.epics[epic.key] || mappings.epics?.[epic.key];
        const properties = {
          Title: { title: [{ text: { content: story.title || story.slug } }] },
          Slug: { rich_text: [{ text: { content: story.slug } }] },
          Status: { select: { name: story.status || 'backlog' } },
          'Epic Number': { number: epic.number },
          'Story Number': { rich_text: [{ text: { content: String(story.storyNumber) } }] }
        };
        if (epicMapping?.remoteId) {
          properties.Epic = { relation: [{ id: epicMapping.remoteId }] };
        }

        const blocks = markdownToNotionBlocks(story.content || '');

        let pageId;
        if (existing?.remoteId) {
          await notion.pages.update({ page_id: existing.remoteId, properties });
          // Replace page content: delete old blocks, append new
          const oldBlocks = await notion.blocks.children.list({ block_id: existing.remoteId });
          for (const b of (oldBlocks.results || [])) {
            await delay(350);
            await notion.blocks.delete({ block_id: b.id });
          }
          if (blocks.length) {
            await delay(350);
            await notion.blocks.children.append({ block_id: existing.remoteId, children: blocks });
          }
          pageId = existing.remoteId;
        } else {
          const page = await notion.pages.create({
            parent: { database_id: config.storiesDatabaseId },
            properties,
            children: blocks.slice(0, 100) // Notion limit: 100 blocks per create
          });
          pageId = page.id;
        }

        results.stories[story.slug] = {
          remoteId: pageId,
          lastSync: new Date().toISOString(),
          contentHash: hash
        };
      }
    }

    // Push documents
    for (const doc of (projectData.documents || [])) {
      await delay(350);
      const docKey = doc.filename;
      const existing = mappings.documents?.[docKey];
      const hash = contentHash(doc.content || '');

      if (existing?.contentHash === hash) {
        results.documents[docKey] = existing;
        continue;
      }

      const blocks = markdownToNotionBlocks(doc.content || '');

      let pageId;
      if (existing?.remoteId) {
        await notion.pages.update({
          page_id: existing.remoteId,
          properties: {
            title: [{ text: { content: doc.name || doc.filename } }]
          }
        });
        const oldBlocks = await notion.blocks.children.list({ block_id: existing.remoteId });
        for (const b of (oldBlocks.results || [])) {
          await delay(350);
          await notion.blocks.delete({ block_id: b.id });
        }
        if (blocks.length) {
          await delay(350);
          await notion.blocks.children.append({ block_id: existing.remoteId, children: blocks });
        }
        pageId = existing.remoteId;
      } else {
        const page = await notion.pages.create({
          parent: { page_id: config.documentsPageId },
          properties: {
            title: [{ text: { content: doc.name || doc.filename } }]
          },
          children: blocks.slice(0, 100)
        });
        pageId = page.id;
      }

      results.documents[docKey] = {
        remoteId: pageId,
        lastSync: new Date().toISOString(),
        contentHash: hash
      };
    }

    return results;
  },

  /**
   * Pull data from Notion databases.
   * Returns arrays of epics, stories, and documents with content.
   */
  async pull(config, syncState) {
    const notion = this._getClient(config);
    const items = { epics: [], stories: [], documents: [] };

    // Pull epics
    if (config.epicsDatabaseId) {
      const resp = await notion.databases.query({ database_id: config.epicsDatabaseId });
      for (const page of resp.results) {
        const props = page.properties;
        const getText = (prop) =>
          (prop?.rich_text || []).map(t => t.plain_text || '').join('') ||
          (prop?.title || []).map(t => t.plain_text || '').join('');

        items.epics.push({
          key: getText(props.Key),
          title: getText(props.Title),
          status: props.Status?.select?.name || 'backlog',
          number: props.Number?.number || 0,
          remoteId: page.id,
          lastEdited: page.last_edited_time
        });
      }
    }

    // Pull stories
    if (config.storiesDatabaseId) {
      const resp = await notion.databases.query({ database_id: config.storiesDatabaseId });
      for (const page of resp.results) {
        await delay(350);
        const props = page.properties;
        const getText = (prop) =>
          (prop?.rich_text || []).map(t => t.plain_text || '').join('') ||
          (prop?.title || []).map(t => t.plain_text || '').join('');

        // Fetch page content blocks
        const blocksResp = await notion.blocks.children.list({ block_id: page.id });
        const content = notionBlocksToMarkdown(blocksResp.results);

        items.stories.push({
          slug: getText(props.Slug),
          title: getText(props.Title),
          status: props.Status?.select?.name || 'backlog',
          epicNumber: props['Epic Number']?.number || 0,
          storyNumber: getText(props['Story Number']),
          content,
          remoteId: page.id,
          lastEdited: page.last_edited_time
        });
      }
    }

    // Pull documents
    if (config.documentsPageId) {
      const children = await notion.blocks.children.list({ block_id: config.documentsPageId });
      for (const child of children.results) {
        if (child.type !== 'child_page') continue;
        await delay(350);
        const page = await notion.pages.retrieve({ page_id: child.id });
        const blocksResp = await notion.blocks.children.list({ block_id: child.id });
        const content = notionBlocksToMarkdown(blocksResp.results);

        const title = (page.properties?.title?.title || [])
          .map(t => t.plain_text || '').join('');

        items.documents.push({
          name: title,
          filename: title.toLowerCase().replace(/\s+/g, '-') + '.md',
          content,
          remoteId: child.id,
          lastEdited: page.last_edited_time
        });
      }
    }

    return items;
  },

  toMarkdown(content) { return notionBlocksToMarkdown(content); },
  fromMarkdown(md) { return markdownToNotionBlocks(md); }
};

// ── Provider: Obsidian ──────────────────────────────────────────────────

const obsidianProvider = {
  name: 'Obsidian Vault',

  configFields: [
    { key: 'vaultPath', label: 'Vault Path', type: 'directory', required: true,
      hint: 'Path to your Obsidian vault folder' }
  ],

  async validateConfig(config) {
    const errors = [];
    if (!config.vaultPath) errors.push('Vault path is required');
    return { valid: errors.length === 0, errors };
  },

  async testConnection(config) {
    if (!config.vaultPath) return { ok: false, message: 'No vault path configured' };
    if (!fs.existsSync(config.vaultPath)) {
      return { ok: false, message: `Vault not found: ${config.vaultPath}` };
    }
    return { ok: true, message: `Vault exists at ${config.vaultPath}` };
  },

  async setup(config, projectData) {
    const vaultRoot = config.vaultPath;
    const projectName = projectData?.projectMeta?.name || 'bmad-project';
    const base = path.join(vaultRoot, projectName);

    const dirs = [base, path.join(base, 'epics'), path.join(base, 'stories'),
      path.join(base, 'documents')];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    return { basePath: base };
  },

  async push(config, syncState, projectData) {
    const projectName = projectData?.projectMeta?.name || 'bmad-project';
    const base = path.join(config.vaultPath, projectName);
    const results = { epics: {}, stories: {}, documents: {} };
    const mappings = syncState.mappings || {};

    // Ensure dirs exist
    for (const sub of ['epics', 'stories', 'documents']) {
      const dir = path.join(base, sub);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    // Push epics
    for (const epic of (projectData.epics || [])) {
      const hash = contentHash(JSON.stringify({ title: epic.title, status: epic.status }));
      const existing = mappings.epics?.[epic.key];
      if (existing?.contentHash === hash) {
        results.epics[epic.key] = existing;
        continue;
      }

      const filePath = path.join(base, 'epics', `${epic.key}.md`);
      const body = `# ${epic.title || `Epic ${epic.number}`}\n\nStatus: ${epic.status || 'backlog'}\n`;
      const content = buildFrontMatter({
        key: epic.key, status: epic.status || 'backlog',
        number: epic.number, lastSync: new Date().toISOString()
      }, body);

      fs.writeFileSync(filePath, content, 'utf-8');
      results.epics[epic.key] = {
        remoteId: filePath, lastSync: new Date().toISOString(), contentHash: hash
      };
    }

    // Push stories
    for (const epic of (projectData.epics || [])) {
      for (const story of (epic.stories || [])) {
        const hash = contentHash(story.content || '');
        const existing = mappings.stories?.[story.slug];
        if (existing?.contentHash === hash) {
          results.stories[story.slug] = existing;
          continue;
        }

        const filePath = path.join(base, 'stories', `${story.slug}.md`);
        const content = buildFrontMatter({
          slug: story.slug, status: story.status || 'backlog',
          epicNumber: story.epicNumber, storyNumber: story.storyNumber,
          lastSync: new Date().toISOString()
        }, story.content || '');

        fs.writeFileSync(filePath, content, 'utf-8');
        results.stories[story.slug] = {
          remoteId: filePath, lastSync: new Date().toISOString(), contentHash: hash
        };
      }
    }

    // Push documents
    for (const doc of (projectData.documents || [])) {
      const hash = contentHash(doc.content || '');
      const docKey = doc.filename;
      const existing = mappings.documents?.[docKey];
      if (existing?.contentHash === hash) {
        results.documents[docKey] = existing;
        continue;
      }

      const filePath = path.join(base, 'documents', doc.filename);
      const content = buildFrontMatter({
        category: doc.category, lastSync: new Date().toISOString()
      }, doc.content || '');

      fs.writeFileSync(filePath, content, 'utf-8');
      results.documents[docKey] = {
        remoteId: filePath, lastSync: new Date().toISOString(), contentHash: hash
      };
    }

    return results;
  },

  async pull(config, syncState) {
    const items = { epics: [], stories: [], documents: [] };
    const projectDirs = fs.readdirSync(config.vaultPath, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'));

    for (const projDir of projectDirs) {
      const base = path.join(config.vaultPath, projDir.name);

      // Pull epics
      const epicsDir = path.join(base, 'epics');
      if (fs.existsSync(epicsDir)) {
        for (const file of fs.readdirSync(epicsDir).filter(f => f.endsWith('.md'))) {
          const raw = fs.readFileSync(path.join(epicsDir, file), 'utf-8');
          const { frontMatter, body } = parseFrontMatter(raw);
          const stat = fs.statSync(path.join(epicsDir, file));
          items.epics.push({
            key: frontMatter.key || path.basename(file, '.md'),
            title: body.match(/^#\s+(.+)/m)?.[1] || frontMatter.key || file,
            status: frontMatter.status || 'backlog',
            number: parseInt(frontMatter.number) || 0,
            remoteId: path.join(epicsDir, file),
            lastEdited: stat.mtime.toISOString()
          });
        }
      }

      // Pull stories
      const storiesDir = path.join(base, 'stories');
      if (fs.existsSync(storiesDir)) {
        for (const file of fs.readdirSync(storiesDir).filter(f => f.endsWith('.md'))) {
          const raw = fs.readFileSync(path.join(storiesDir, file), 'utf-8');
          const { frontMatter, body } = parseFrontMatter(raw);
          const stat = fs.statSync(path.join(storiesDir, file));
          items.stories.push({
            slug: frontMatter.slug || path.basename(file, '.md'),
            title: body.match(/^#\s+(.+)/m)?.[1] || frontMatter.slug || file,
            status: frontMatter.status || 'backlog',
            epicNumber: parseInt(frontMatter.epicNumber) || 0,
            storyNumber: frontMatter.storyNumber || '',
            content: body,
            remoteId: path.join(storiesDir, file),
            lastEdited: stat.mtime.toISOString()
          });
        }
      }

      // Pull documents
      const docsDir = path.join(base, 'documents');
      if (fs.existsSync(docsDir)) {
        for (const file of fs.readdirSync(docsDir).filter(f => f.endsWith('.md'))) {
          const raw = fs.readFileSync(path.join(docsDir, file), 'utf-8');
          const { frontMatter, body } = parseFrontMatter(raw);
          const stat = fs.statSync(path.join(docsDir, file));
          items.documents.push({
            name: body.match(/^#\s+(.+)/m)?.[1] || file,
            filename: file,
            content: body,
            category: frontMatter.category || 'General',
            remoteId: path.join(docsDir, file),
            lastEdited: stat.mtime.toISOString()
          });
        }
      }
    }

    return items;
  },

  toMarkdown(content) { return content; },   // Already markdown
  fromMarkdown(md) { return md; }            // Already markdown
};

// ── Provider: Linear ────────────────────────────────────────────────────

const linearProvider = {
  name: 'Linear',

  configFields: [
    { key: 'apiKey', label: 'API Key', type: 'password', required: true },
    { key: 'teamId', label: 'Team ID', type: 'text', required: true,
      hint: 'Linear team identifier (found in team settings)' }
  ],

  _getClient(config) {
    const { LinearClient } = require('@linear/sdk');
    return new LinearClient({ apiKey: config.apiKey });
  },

  async validateConfig(config) {
    const errors = [];
    if (!config.apiKey) errors.push('API Key is required');
    if (!config.teamId) errors.push('Team ID is required');
    return { valid: errors.length === 0, errors };
  },

  async testConnection(config) {
    try {
      const client = this._getClient(config);
      const viewer = await client.viewer;
      return { ok: true, message: `Connected as ${viewer.name || viewer.email}` };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  },

  /**
   * Create a Linear project for this BMAD project.
   */
  async setup(config, projectData) {
    const client = this._getClient(config);
    const projectName = projectData?.projectMeta?.name || 'BMAD Project';

    const project = await client.createProject({
      name: projectName,
      teamIds: [config.teamId]
    });
    const proj = await project.project;

    return { projectId: proj.id };
  },

  /**
   * Push BMAD data to Linear: Epics become labels, Stories become issues.
   */
  async push(config, syncState, projectData) {
    const client = this._getClient(config);
    const results = { epics: {}, stories: {}, documents: {} };
    const mappings = syncState.mappings || {};

    // Get workflow states for status mapping
    const team = await client.team(config.teamId);
    const statesResp = await team.states();
    const states = statesResp.nodes || [];

    const statusMap = {
      'backlog': states.find(s => s.type === 'backlog')?.id,
      'ready-for-dev': states.find(s => s.type === 'unstarted')?.id,
      'in-progress': states.find(s => s.type === 'started')?.id,
      'review': states.find(s => s.type === 'started')?.id,
      'done': states.find(s => s.type === 'completed')?.id
    };

    // Push epics as labels
    for (const epic of (projectData.epics || [])) {
      const hash = contentHash(JSON.stringify({ title: epic.title, status: epic.status }));
      const existing = mappings.epics?.[epic.key];
      if (existing?.contentHash === hash) {
        results.epics[epic.key] = existing;
        continue;
      }

      let labelId;
      if (existing?.remoteId) {
        await client.updateIssueLabel(existing.remoteId, {
          name: `Epic: ${epic.title || `Epic ${epic.number}`}`
        });
        labelId = existing.remoteId;
      } else {
        const label = await client.createIssueLabel({
          name: `Epic: ${epic.title || `Epic ${epic.number}`}`,
          teamId: config.teamId
        });
        const created = await label.issueLabel;
        labelId = created.id;
      }

      results.epics[epic.key] = {
        remoteId: labelId, lastSync: new Date().toISOString(), contentHash: hash
      };
    }

    // Push stories as issues
    for (const epic of (projectData.epics || [])) {
      for (const story of (epic.stories || [])) {
        const hash = contentHash(story.content || '');
        const existing = mappings.stories?.[story.slug];
        if (existing?.contentHash === hash) {
          results.stories[story.slug] = existing;
          continue;
        }

        const epicLabel = results.epics[epic.key] || mappings.epics?.[epic.key];
        const stateId = statusMap[story.status || 'backlog'];

        let issueId;
        if (existing?.remoteId) {
          const updateData = {
            title: story.title || story.slug,
            description: story.content || ''
          };
          if (stateId) updateData.stateId = stateId;
          await client.updateIssue(existing.remoteId, updateData);
          issueId = existing.remoteId;
        } else {
          const createData = {
            title: story.title || story.slug,
            description: story.content || '',
            teamId: config.teamId
          };
          if (stateId) createData.stateId = stateId;
          if (epicLabel?.remoteId) createData.labelIds = [epicLabel.remoteId];
          if (config.projectId) createData.projectId = config.projectId;

          const issue = await client.createIssue(createData);
          const created = await issue.issue;
          issueId = created.id;
        }

        results.stories[story.slug] = {
          remoteId: issueId, lastSync: new Date().toISOString(), contentHash: hash
        };
      }
    }

    // Documents are not naturally supported in Linear — skip
    results.documents = mappings.documents || {};

    return results;
  },

  /**
   * Pull issues from Linear team, map back to stories.
   */
  async pull(config, syncState) {
    const client = this._getClient(config);
    const items = { epics: [], stories: [], documents: [] };

    const team = await client.team(config.teamId);
    const issuesResp = await team.issues();

    // Reverse state type map
    const stateTypeToStatus = {
      backlog: 'backlog',
      unstarted: 'ready-for-dev',
      started: 'in-progress',
      completed: 'done',
      cancelled: 'done'
    };

    for (const issue of (issuesResp.nodes || [])) {
      const state = await issue.state;
      const labelsResp = await issue.labels();
      const labels = labelsResp?.nodes || [];

      items.stories.push({
        slug: issue.identifier?.toLowerCase().replace(/\s+/g, '-') || issue.id,
        title: issue.title,
        status: stateTypeToStatus[state?.type] || 'backlog',
        content: issue.description || '',
        remoteId: issue.id,
        lastEdited: issue.updatedAt,
        labels: labels.map(l => l.name)
      });
    }

    // Extract epic labels
    const labelsResp = await team.labels();
    for (const label of (labelsResp?.nodes || [])) {
      if (label.name.startsWith('Epic: ')) {
        items.epics.push({
          key: label.name.replace('Epic: ', '').toLowerCase().replace(/\s+/g, '-'),
          title: label.name.replace('Epic: ', ''),
          remoteId: label.id,
          status: 'in-progress'
        });
      }
    }

    return items;
  },

  toMarkdown(content) { return content; },   // Linear uses markdown natively
  fromMarkdown(md) { return md; }
};

// ── Provider Registry ───────────────────────────────────────────────────

const SYNC_PROVIDERS = {
  notion: notionProvider,
  obsidian: obsidianProvider,
  linear: linearProvider
};

function getSyncProvider(key) {
  return SYNC_PROVIDERS[key] || null;
}

function getSyncProviderKeys() {
  return Object.keys(SYNC_PROVIDERS);
}

function getSyncProviderList() {
  return Object.entries(SYNC_PROVIDERS).map(([key, p]) => ({
    key,
    name: p.name,
    configFields: p.configFields
  }));
}

module.exports = {
  SYNC_PROVIDERS,
  getSyncProvider,
  getSyncProviderKeys,
  getSyncProviderList,
  // Exported for testing / reuse
  contentHash,
  markdownToNotionBlocks,
  notionBlocksToMarkdown,
  parseFrontMatter,
  buildFrontMatter
};
