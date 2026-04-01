#!/usr/bin/env node
/**
 * BMAD Board — MCP Server (Standalone)
 *
 * Model Context Protocol server that exposes BMAD project sync tools.
 * Can be used by Claude CLI, Cursor, or any MCP-compatible client.
 *
 * Usage:
 *   node lib/mcp-server.js --project-path /path/to/project
 *
 * MCP config (claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "bmad-board": {
 *         "command": "node",
 *         "args": ["lib/mcp-server.js", "--project-path", "/path/to/project"]
 *       }
 *     }
 *   }
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const path = require('path');
const { SyncEngine } = require('./sync-engine');
const { getSyncProviderList } = require('./sync-providers');
const { scanProject } = require('./bmad-scanner');

// ── Parse CLI args ──────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--project-path' && argv[i + 1]) {
      args.projectPath = path.resolve(argv[++i]);
    }
  }
  return args;
}

// ── MCP Server Setup ────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const projectPath = args.projectPath || process.cwd();

  const engine = new SyncEngine(projectPath, scanProject);

  const server = new McpServer({
    name: 'bmad-board-sync',
    version: '1.0.0'
  });

  // ── Tools ───────────────────────────────────────────────────────────

  server.tool(
    'sync_list_providers',
    'List available sync providers (Notion, Obsidian, Linear)',
    {},
    async () => {
      const providers = getSyncProviderList();
      return { content: [{ type: 'text', text: JSON.stringify(providers, null, 2) }] };
    }
  );

  server.tool(
    'sync_configure',
    'Configure a sync provider with API key and settings',
    {
      provider: z.enum(['notion', 'obsidian', 'linear']).describe('Sync provider to configure'),
      config: z.record(z.string()).describe('Provider-specific configuration (apiKey, vaultPath, etc.)')
    },
    async ({ provider, config }) => {
      const result = engine.configure(provider, config);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    'sync_validate',
    'Validate sync provider configuration',
    {
      provider: z.enum(['notion', 'obsidian', 'linear']).optional().describe('Provider to validate (uses configured if omitted)'),
      config: z.record(z.string()).optional().describe('Config to validate (uses saved if omitted)')
    },
    async ({ provider, config }) => {
      const result = await engine.validate(provider, config);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    'sync_test_connection',
    'Test connection to the configured sync provider',
    {
      provider: z.enum(['notion', 'obsidian', 'linear']).optional(),
      config: z.record(z.string()).optional()
    },
    async ({ provider, config }) => {
      const result = await engine.testConnection(provider, config);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    'sync_setup',
    'Initial remote setup: create databases (Notion), folders (Obsidian), or project (Linear)',
    {},
    async () => {
      const result = await engine.setup();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'sync_all',
    'Full bidirectional sync of all epics, stories, and documents',
    {
      direction: z.enum(['both', 'push', 'pull']).optional().describe('Sync direction (default: both)'),
      conflictStrategy: z.enum(['local-wins', 'remote-wins', 'last-modified-wins']).optional()
        .describe('Conflict resolution strategy (default: last-modified-wins)')
    },
    async ({ direction, conflictStrategy }) => {
      const result = await engine.syncAll({ direction, conflictStrategy });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'sync_push',
    'Push all local BMAD data to the configured remote provider',
    {},
    async () => {
      const result = await engine.pushAll();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'sync_pull',
    'Pull remote changes to local BMAD project files',
    {},
    async () => {
      const result = await engine.pullAll();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'sync_item',
    'Sync a single epic, story, or document',
    {
      type: z.enum(['epic', 'story', 'document']).describe('Item type'),
      key: z.string().describe('Epic key, story slug, or document filename')
    },
    async ({ type, key }) => {
      const result = await engine.syncItem(type, key);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'sync_status',
    'Show current sync status: provider, last sync time, item counts',
    {},
    async () => {
      const status = engine.getSyncStatus();
      return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
    }
  );

  // ── Resources ───────────────────────────────────────────────────────

  server.resource(
    'sync-status',
    'bmad://sync-status',
    async (uri) => {
      const status = engine.getSyncStatus();
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(status, null, 2) }] };
    }
  );

  server.resource(
    'project-summary',
    'bmad://project-summary',
    async (uri) => {
      const data = await scanProject(projectPath);
      const status = engine.getSyncStatus();
      const summary = {
        project: data.projectMeta,
        epicCount: data.epics?.length || 0,
        storyCount: data.epics?.reduce((n, e) => n + (e.stories?.length || 0), 0) || 0,
        documentCount: data.documents?.length || 0,
        sync: status
      };
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(summary, null, 2) }] };
    }
  );

  // ── Start ───────────────────────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Export parseArgs for testing
module.exports = { parseArgs };

// Only auto-start when run directly (not when required by tests)
if (require.main === module) {
  main().catch(err => {
    console.error('MCP server error:', err);
    process.exit(1);
  });
}
