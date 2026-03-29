import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { SyncEngine } from '../lib/sync-engine.js';

// ── Test Helpers ────────────────────────────────────────────────────────

let tmpDir;

function createTmpProject() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmad-sync-test-'));
  // Create .bmad-board dir
  fs.mkdirSync(path.join(tmpDir, '.bmad-board'), { recursive: true });
  return tmpDir;
}

function cleanupTmpProject() {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Mock scanProject that returns consistent test data. */
function mockScanProject() {
  return {
    found: true,
    projectPath: tmpDir,
    config: {},
    projectMeta: { name: 'Test Project', userName: 'Tester', language: 'English' },
    epics: [
      {
        number: 1,
        key: 'epic-1',
        title: 'First Epic',
        status: 'in-progress',
        stories: [
          { slug: '1-1-setup', title: 'Setup', status: 'done', epicNumber: 1, storyNumber: '1', content: '# Setup\n\nDone.' },
          { slug: '1-2-tests', title: 'Tests', status: 'in-progress', epicNumber: 1, storyNumber: '2', content: '# Tests\n\nWIP.' }
        ]
      }
    ],
    documents: [
      { category: 'Planning', name: 'PRD', filename: 'prd.md', content: '# PRD\n\nRequirements.' }
    ]
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('SyncEngine', () => {
  beforeEach(() => createTmpProject());
  afterEach(() => cleanupTmpProject());

  describe('constructor', () => {
    it('initializes with empty state', () => {
      const engine = new SyncEngine(tmpDir, mockScanProject);
      expect(engine.projectPath).toBe(tmpDir);
      expect(engine.state.provider).toBeNull();
    });

    it('loads existing state from file', () => {
      const state = { provider: 'obsidian', config: { vaultPath: '/tmp' }, lastFullSync: null, mappings: { epics: {}, stories: {}, documents: {} } };
      fs.writeFileSync(path.join(tmpDir, '.bmad-board', 'sync-state.json'), JSON.stringify(state));

      const engine = new SyncEngine(tmpDir, mockScanProject);
      expect(engine.state.provider).toBe('obsidian');
      expect(engine.state.config.vaultPath).toBe('/tmp');
    });
  });

  describe('configure', () => {
    it('sets provider and config', () => {
      const engine = new SyncEngine(tmpDir, mockScanProject);
      engine.configure('obsidian', { vaultPath: '/tmp/vault' });
      expect(engine.state.provider).toBe('obsidian');
      expect(engine.state.config.vaultPath).toBe('/tmp/vault');
    });

    it('persists state to disk', () => {
      const engine = new SyncEngine(tmpDir, mockScanProject);
      engine.configure('notion', { apiKey: 'test', parentPageId: 'abc' });

      const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, '.bmad-board', 'sync-state.json'), 'utf-8'));
      expect(saved.provider).toBe('notion');
    });

    it('throws on unknown provider', () => {
      const engine = new SyncEngine(tmpDir, mockScanProject);
      expect(() => engine.configure('jira', {})).toThrow('Unknown sync provider');
    });
  });

  describe('validate', () => {
    it('validates provider config', async () => {
      const engine = new SyncEngine(tmpDir, mockScanProject);
      const result = await engine.validate('obsidian', { vaultPath: '/tmp' });
      expect(result.valid).toBe(true);
    });

    it('returns errors for invalid config', async () => {
      const engine = new SyncEngine(tmpDir, mockScanProject);
      const result = await engine.validate('notion', {});
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('uses configured provider if not specified', async () => {
      const engine = new SyncEngine(tmpDir, mockScanProject);
      engine.configure('obsidian', { vaultPath: '/tmp' });
      const result = await engine.validate();
      expect(result.valid).toBe(true);
    });
  });

  describe('getSyncStatus', () => {
    it('returns unconfigured status by default', () => {
      const engine = new SyncEngine(tmpDir, mockScanProject);
      const status = engine.getSyncStatus();
      expect(status.configured).toBe(false);
      expect(status.provider).toBeNull();
      expect(status.counts.epics).toBe(0);
    });

    it('returns configured status after configure', () => {
      const engine = new SyncEngine(tmpDir, mockScanProject);
      engine.configure('obsidian', { vaultPath: '/tmp' });
      const status = engine.getSyncStatus();
      expect(status.configured).toBe(true);
      expect(status.provider).toBe('obsidian');
    });

    it('masks API key in config', () => {
      const engine = new SyncEngine(tmpDir, mockScanProject);
      engine.configure('notion', { apiKey: 'secret-key', parentPageId: 'abc' });
      const status = engine.getSyncStatus();
      expect(status.config.apiKey).toBe('***');
    });
  });

  describe('Obsidian push', () => {
    it('creates files in vault directory', async () => {
      const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bmad-vault-'));

      const engine = new SyncEngine(tmpDir, mockScanProject);
      engine.configure('obsidian', { vaultPath });

      // Setup creates directories
      await engine.setup();

      // Push creates files
      const result = await engine.pushAll();
      expect(result.pushed).toBeGreaterThan(0);

      // Check files exist
      const projectDir = path.join(vaultPath, 'Test Project');
      expect(fs.existsSync(path.join(projectDir, 'epics', 'epic-1.md'))).toBe(true);
      expect(fs.existsSync(path.join(projectDir, 'stories', '1-1-setup.md'))).toBe(true);
      expect(fs.existsSync(path.join(projectDir, 'stories', '1-2-tests.md'))).toBe(true);
      expect(fs.existsSync(path.join(projectDir, 'documents', 'prd.md'))).toBe(true);

      // Check content includes front matter
      const epicContent = fs.readFileSync(path.join(projectDir, 'epics', 'epic-1.md'), 'utf-8');
      expect(epicContent).toContain('---');
      expect(epicContent).toContain('key: epic-1');
      expect(epicContent).toContain('status: in-progress');

      // Check sync state was updated
      const status = engine.getSyncStatus();
      expect(status.counts.epics).toBe(1);
      expect(status.counts.stories).toBe(2);
      expect(status.counts.documents).toBe(1);
      expect(status.lastFullSync).toBeTruthy();

      // Cleanup
      fs.rmSync(vaultPath, { recursive: true, force: true });
    });

    it('skips unchanged files on second push', async () => {
      const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bmad-vault-'));

      const engine = new SyncEngine(tmpDir, mockScanProject);
      engine.configure('obsidian', { vaultPath });
      await engine.setup();
      await engine.pushAll();

      // Get mtime of first push
      const projectDir = path.join(vaultPath, 'Test Project');
      const mtime1 = fs.statSync(path.join(projectDir, 'epics', 'epic-1.md')).mtimeMs;

      // Wait a bit and push again
      await new Promise(r => setTimeout(r, 50));
      await engine.pushAll();

      // File should NOT be rewritten (same content hash)
      const mtime2 = fs.statSync(path.join(projectDir, 'epics', 'epic-1.md')).mtimeMs;
      expect(mtime2).toBe(mtime1);

      fs.rmSync(vaultPath, { recursive: true, force: true });
    });
  });

  describe('_updateStoryStatus', () => {
    it('updates status in sprint-status.yaml', () => {
      // Create sprint status file
      const implDir = path.join(tmpDir, '_bmad-output', 'implementation');
      fs.mkdirSync(implDir, { recursive: true });
      fs.writeFileSync(path.join(implDir, 'sprint-status.yaml'),
        'project: Test\ndevelopment_status:\n  epic-1: in-progress\n  1-1-setup: done\n  1-2-tests: in-progress\n');

      const engine = new SyncEngine(tmpDir, mockScanProject);
      const updated = engine._updateStoryStatus('1-2-tests', 'review');
      expect(updated).toBe(true);

      const content = fs.readFileSync(path.join(implDir, 'sprint-status.yaml'), 'utf-8');
      expect(content).toContain('1-2-tests: review');
    });
  });
});
