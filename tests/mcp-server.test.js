import path from 'path';
import { getSyncProviderList, getSyncProviderKeys, getSyncProvider } from '../lib/sync-providers.js';
import { SyncEngine } from '../lib/sync-engine.js';

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class { tool() {} resource() {} connect() {} }
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {}
}));

const { parseArgs } = await import('../lib/mcp-server.js');

/**
 * MCP server tests — validate that the tools and engine work correctly
 * without actually starting an MCP transport. We test the underlying
 * modules that the MCP server delegates to.
 */

describe('MCP Server tool dependencies', () => {
  describe('sync_list_providers', () => {
    it('returns all three providers', () => {
      const providers = getSyncProviderList();
      expect(providers.length).toBe(3);
      const keys = providers.map(p => p.key);
      expect(keys).toContain('notion');
      expect(keys).toContain('obsidian');
      expect(keys).toContain('linear');
    });

    it('each provider has configFields', () => {
      const providers = getSyncProviderList();
      for (const p of providers) {
        expect(Array.isArray(p.configFields)).toBe(true);
        expect(p.configFields.length).toBeGreaterThan(0);
      }
    });
  });

  describe('sync_validate', () => {
    it('notion validates apiKey and parentPageId', async () => {
      const provider = getSyncProvider('notion');
      const result = await provider.validateConfig({ apiKey: 'test', parentPageId: 'abc' });
      expect(result.valid).toBe(true);
    });

    it('obsidian validates vaultPath', async () => {
      const provider = getSyncProvider('obsidian');
      const result = await provider.validateConfig({ vaultPath: '/tmp' });
      expect(result.valid).toBe(true);
    });

    it('linear validates apiKey and teamId', async () => {
      const provider = getSyncProvider('linear');
      const result = await provider.validateConfig({ apiKey: 'lin_xxx', teamId: 'team-1' });
      expect(result.valid).toBe(true);
    });
  });

  describe('sync_status', () => {
    it('returns unconfigured status for fresh engine', () => {
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
      fs.mkdirSync(path.join(tmpDir, '.bmad-board'), { recursive: true });

      const engine = new SyncEngine(tmpDir, () => ({}));
      const status = engine.getSyncStatus();

      expect(status.configured).toBe(false);
      expect(status.provider).toBeNull();
      expect(status.counts.epics).toBe(0);
      expect(status.counts.stories).toBe(0);
      expect(status.counts.documents).toBe(0);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('provider interface completeness', () => {
    const requiredMethods = ['validateConfig', 'testConnection', 'setup', 'push', 'pull', 'toMarkdown', 'fromMarkdown'];

    for (const key of getSyncProviderKeys()) {
      it(`${key} implements all required methods`, () => {
        const provider = getSyncProvider(key);
        for (const method of requiredMethods) {
          expect(typeof provider[method]).toBe('function');
        }
      });

      it(`${key} has name and configFields`, () => {
        const provider = getSyncProvider(key);
        expect(typeof provider.name).toBe('string');
        expect(Array.isArray(provider.configFields)).toBe(true);
      });
    }
  });
});

describe('parseArgs', () => {
  it('extracts --project-path from argv', () => {
    const args = parseArgs(['node', 'mcp-server.js', '--project-path', '/tmp/my-project']);
    expect(args.projectPath).toBe(path.resolve('/tmp/my-project'));
  });

  it('returns empty object when no args', () => {
    const args = parseArgs(['node', 'mcp-server.js']);
    expect(args).toEqual({});
  });

  it('ignores unknown flags', () => {
    const args = parseArgs(['node', 'mcp-server.js', '--verbose', '--project-path', '/tmp/proj']);
    expect(args.projectPath).toBe(path.resolve('/tmp/proj'));
    expect(args.verbose).toBeUndefined();
  });

  it('resolves relative paths', () => {
    const args = parseArgs(['node', 'mcp-server.js', '--project-path', 'relative/path']);
    expect(path.isAbsolute(args.projectPath)).toBe(true);
  });

  it('ignores --project-path without a following value', () => {
    const args = parseArgs(['node', 'mcp-server.js', '--project-path']);
    expect(args).toEqual({});
  });

  it('only processes the first --project-path (last occurrence wins via reassignment)', () => {
    // The implementation iterates linearly: last match wins
    const args = parseArgs(['node', 'mcp-server.js', '--project-path', '/first', '--project-path', '/second']);
    expect(args.projectPath).toBe(path.resolve('/second'));
  });

  it('handles argv shorter than 2 elements without crashing', () => {
    expect(() => parseArgs([])).not.toThrow();
    expect(() => parseArgs(['node'])).not.toThrow();
  });

  it('returns only projectPath key when --project-path is provided', () => {
    const args = parseArgs(['node', 'mcp-server.js', '--project-path', '/some/path']);
    expect(Object.keys(args)).toEqual(['projectPath']);
  });

  it('resolves absolute path unchanged', () => {
    const args = parseArgs(['node', 'mcp-server.js', '--project-path', '/absolute/path']);
    expect(args.projectPath).toBe('/absolute/path');
  });
});