import fs from 'fs';
import path from 'path';
import os from 'os';
import { SyncEngine } from '../lib/sync-engine.js';
import { contentHash } from '../lib/sync-providers.js';

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

    it('returns false when slug not found', () => {
      const implDir = path.join(tmpDir, '_bmad-output', 'implementation');
      fs.mkdirSync(implDir, { recursive: true });
      fs.writeFileSync(path.join(implDir, 'sprint-status.yaml'),
        'project: Test\n  1-1-setup: done\n');

      const engine = new SyncEngine(tmpDir, mockScanProject);
      expect(engine._updateStoryStatus('nonexistent', 'review')).toBe(false);
    });

    it('returns false when no sprint-status.yaml exists', () => {
      const engine = new SyncEngine(tmpDir, mockScanProject);
      expect(engine._updateStoryStatus('1-1-setup', 'review')).toBe(false);
    });

    it('tries fallback path when first does not exist', () => {
      // Create file at second candidate path
      const fallbackDir = path.join(tmpDir, '_bmad-output');
      fs.mkdirSync(fallbackDir, { recursive: true });
      fs.writeFileSync(path.join(fallbackDir, 'sprint-status.yaml'),
        'project: Test\n  1-1-setup: done\n');

      const engine = new SyncEngine(tmpDir, mockScanProject);
      const updated = engine._updateStoryStatus('1-1-setup', 'review');
      expect(updated).toBe(true);

      const content = fs.readFileSync(path.join(fallbackDir, 'sprint-status.yaml'), 'utf-8');
      expect(content).toContain('1-1-setup: review');
    });
  });

  // ── _applyPull conflict resolution ───────────────────────────────────

  describe('_applyPull', () => {
    /** Helper: set up an engine with mappings and local story files. */
    function setupPullScenario({ localContent, mappingHash, mappingLastSync, localFileMtime }) {
      const storyFile = path.join(tmpDir, 'story-1-2-tests.md');
      fs.writeFileSync(storyFile, localContent);
      if (localFileMtime) {
        fs.utimesSync(storyFile, localFileMtime, localFileMtime);
      }

      const localData = {
        epics: [{
          number: 1,
          stories: [{
            slug: '1-2-tests',
            title: 'Tests',
            status: 'in-progress',
            content: localContent,
            filePath: storyFile
          }]
        }]
      };

      const engine = new SyncEngine(tmpDir, () => localData);
      // Pre-populate mapping
      engine.state.provider = 'obsidian';
      engine.state.config = { vaultPath: '/tmp' };
      engine.state.mappings.stories['1-2-tests'] = {
        contentHash: mappingHash || contentHash(localContent),
        lastSync: mappingLastSync || new Date(Date.now() - 60000).toISOString()
      };

      return { engine, localData, storyFile };
    }

    it('returns zero applied when no remote stories', async () => {
      const engine = new SyncEngine(tmpDir, mockScanProject);
      const result = await engine._applyPull({ stories: [] }, { epics: [] }, 'local-wins');
      expect(result.applied).toBe(0);
      expect(result.conflicts).toEqual([]);
    });

    it('skips stories without mappings', async () => {
      const engine = new SyncEngine(tmpDir, mockScanProject);
      const remoteData = {
        stories: [{ slug: 'unknown-story', content: '# Unknown', lastEdited: new Date().toISOString() }]
      };
      const result = await engine._applyPull(remoteData, { epics: [] }, 'local-wins');
      expect(result.applied).toBe(0);
    });

    it('skips unchanged remote (remoteDate <= lastSyncDate)', async () => {
      const now = new Date();
      const { engine, localData } = setupPullScenario({
        localContent: '# Tests\n\nWIP.',
        mappingLastSync: now.toISOString()
      });

      const remoteData = {
        stories: [{
          slug: '1-2-tests',
          content: '# Tests\n\nUpdated.',
          lastEdited: new Date(now.getTime() - 10000).toISOString()
        }]
      };

      const result = await engine._applyPull(remoteData, localData, 'local-wins');
      expect(result.applied).toBe(0);
    });

    it('applies remote-only change when local is unchanged', async () => {
      const originalContent = '# Tests\n\nWIP.';
      const { engine, localData, storyFile } = setupPullScenario({
        localContent: originalContent,
        mappingHash: contentHash(originalContent) // local matches mapping = no local change
      });

      const remoteData = {
        stories: [{
          slug: '1-2-tests',
          content: '# Tests\n\nUpdated remotely.',
          lastEdited: new Date().toISOString()
        }]
      };

      const result = await engine._applyPull(remoteData, localData, 'local-wins');
      expect(result.applied).toBe(1);
      expect(result.conflicts).toEqual([]);
      expect(fs.readFileSync(storyFile, 'utf-8')).toBe('# Tests\n\nUpdated remotely.');
    });

    it('conflict with local-wins keeps local content', async () => {
      const originalContent = '# Tests\n\nOriginal.';
      const { engine, localData, storyFile } = setupPullScenario({
        localContent: '# Tests\n\nLocally edited.',
        mappingHash: contentHash(originalContent) // Different from current local = local changed
      });

      const remoteData = {
        stories: [{
          slug: '1-2-tests',
          content: '# Tests\n\nRemotely edited.',
          lastEdited: new Date().toISOString()
        }]
      };

      const result = await engine._applyPull(remoteData, localData, 'local-wins');
      expect(result.applied).toBe(0);
      expect(result.conflicts).toEqual([]);
      // Local file should be unchanged
      expect(fs.readFileSync(storyFile, 'utf-8')).toBe('# Tests\n\nLocally edited.');
    });

    it('conflict with remote-wins overwrites local', async () => {
      const originalContent = '# Tests\n\nOriginal.';
      const { engine, localData, storyFile } = setupPullScenario({
        localContent: '# Tests\n\nLocally edited.',
        mappingHash: contentHash(originalContent)
      });

      const remoteData = {
        stories: [{
          slug: '1-2-tests',
          content: '# Tests\n\nRemotely edited.',
          lastEdited: new Date().toISOString()
        }]
      };

      const result = await engine._applyPull(remoteData, localData, 'remote-wins');
      expect(result.applied).toBe(1);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]).toMatchObject({ type: 'story', key: '1-2-tests', resolution: 'remote-wins' });
      expect(fs.readFileSync(storyFile, 'utf-8')).toBe('# Tests\n\nRemotely edited.');
    });

    it('conflict with last-modified-wins — local newer keeps local', async () => {
      const originalContent = '# Tests\n\nOriginal.';
      const localTime = new Date();
      const remoteTime = new Date(localTime.getTime() - 30000); // remote is older

      const { engine, localData, storyFile } = setupPullScenario({
        localContent: '# Tests\n\nLocally edited.',
        mappingHash: contentHash(originalContent),
        localFileMtime: localTime
      });

      const remoteData = {
        stories: [{
          slug: '1-2-tests',
          content: '# Tests\n\nRemotely edited.',
          lastEdited: remoteTime.toISOString()
        }]
      };

      const result = await engine._applyPull(remoteData, localData, 'last-modified-wins');
      expect(result.applied).toBe(0);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].resolution).toBe('local-wins');
      expect(fs.readFileSync(storyFile, 'utf-8')).toBe('# Tests\n\nLocally edited.');
    });

    it('conflict with last-modified-wins — remote newer applies remote', async () => {
      const originalContent = '# Tests\n\nOriginal.';
      const localTime = new Date(Date.now() - 60000); // local is older
      const remoteTime = new Date();

      const { engine, localData, storyFile } = setupPullScenario({
        localContent: '# Tests\n\nLocally edited.',
        mappingHash: contentHash(originalContent),
        localFileMtime: localTime
      });

      const remoteData = {
        stories: [{
          slug: '1-2-tests',
          content: '# Tests\n\nRemotely edited.',
          lastEdited: remoteTime.toISOString()
        }]
      };

      const result = await engine._applyPull(remoteData, localData, 'last-modified-wins');
      expect(result.applied).toBe(1);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].resolution).toBe('remote-wins');
      expect(fs.readFileSync(storyFile, 'utf-8')).toBe('# Tests\n\nRemotely edited.');
    });

    it('status change triggers _updateStoryStatus', async () => {
      const originalContent = '# Tests\n\nWIP.';
      const { engine, localData } = setupPullScenario({
        localContent: originalContent,
        mappingHash: contentHash(originalContent)
      });

      // Create sprint status file
      const implDir = path.join(tmpDir, '_bmad-output', 'implementation');
      fs.mkdirSync(implDir, { recursive: true });
      fs.writeFileSync(path.join(implDir, 'sprint-status.yaml'),
        'project: Test\n  1-2-tests: in-progress\n');

      const remoteData = {
        stories: [{
          slug: '1-2-tests',
          content: '# Tests\n\nUpdated.',
          status: 'review', // Different from local 'in-progress'
          lastEdited: new Date().toISOString()
        }]
      };

      await engine._applyPull(remoteData, localData, 'local-wins');

      const yamlContent = fs.readFileSync(path.join(implDir, 'sprint-status.yaml'), 'utf-8');
      expect(yamlContent).toContain('1-2-tests: review');
    });
  });

  // ── syncItem ─────────────────────────────────────────────────────────

  describe('syncItem', () => {
    it('returns error for item not found', async () => {
      const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bmad-vault-'));
      const engine = new SyncEngine(tmpDir, mockScanProject);
      engine.configure('obsidian', { vaultPath });
      await engine.setup();

      const result = await engine.syncItem('story', 'nonexistent-slug');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Item not found');

      fs.rmSync(vaultPath, { recursive: true, force: true });
    });

    it('pushes a single epic by key', async () => {
      const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bmad-vault-'));
      const engine = new SyncEngine(tmpDir, mockScanProject);
      engine.configure('obsidian', { vaultPath });
      await engine.setup();

      const result = await engine.syncItem('epic', 'epic-1');
      expect(result.ok).toBe(true);

      // Verify epic file was created
      const projectDir = path.join(vaultPath, 'Test Project');
      expect(fs.existsSync(path.join(projectDir, 'epics', 'epic-1.md'))).toBe(true);

      fs.rmSync(vaultPath, { recursive: true, force: true });
    });

    it('pushes a single story by slug', async () => {
      const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bmad-vault-'));
      const engine = new SyncEngine(tmpDir, mockScanProject);
      engine.configure('obsidian', { vaultPath });
      await engine.setup();

      const result = await engine.syncItem('story', '1-1-setup');
      expect(result.ok).toBe(true);

      const projectDir = path.join(vaultPath, 'Test Project');
      expect(fs.existsSync(path.join(projectDir, 'stories', '1-1-setup.md'))).toBe(true);

      fs.rmSync(vaultPath, { recursive: true, force: true });
    });

    it('pushes a single document by filename', async () => {
      const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bmad-vault-'));
      const engine = new SyncEngine(tmpDir, mockScanProject);
      engine.configure('obsidian', { vaultPath });
      await engine.setup();

      const result = await engine.syncItem('document', 'prd.md');
      expect(result.ok).toBe(true);

      const projectDir = path.join(vaultPath, 'Test Project');
      expect(fs.existsSync(path.join(projectDir, 'documents', 'prd.md'))).toBe(true);

      fs.rmSync(vaultPath, { recursive: true, force: true });
    });
  });

  // ── syncAll direction control ────────────────────────────────────────

  describe('syncAll direction', () => {
    it('push-only does not call pull', async () => {
      const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bmad-vault-'));
      const engine = new SyncEngine(tmpDir, mockScanProject);
      engine.configure('obsidian', { vaultPath });
      await engine.setup();

      const report = await engine.syncAll({ direction: 'push' });
      expect(report.pushed).toBeGreaterThan(0);
      expect(report.pulled).toBe(0);
      expect(report.lastFullSync).toBeUndefined(); // report doesn't have this, state does
      expect(engine.state.lastFullSync).toBeTruthy();

      fs.rmSync(vaultPath, { recursive: true, force: true });
    });

    it('pull-only does not push', async () => {
      const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bmad-vault-'));
      const engine = new SyncEngine(tmpDir, mockScanProject);
      engine.configure('obsidian', { vaultPath });
      await engine.setup();

      const report = await engine.syncAll({ direction: 'pull' });
      expect(report.pushed).toBe(0);

      fs.rmSync(vaultPath, { recursive: true, force: true });
    });

    it('records errors when push fails', async () => {
      // Use a file as vaultPath (not a directory) — push will fail when trying to mkdir
      const vaultFile = path.join(tmpDir, 'not-a-directory');
      fs.writeFileSync(vaultFile, 'block');

      const engine = new SyncEngine(tmpDir, mockScanProject);
      engine.state.provider = 'obsidian';
      engine.state.config = { vaultPath: vaultFile };

      const report = await engine.syncAll({ direction: 'push' });
      expect(report.errors.length).toBeGreaterThan(0);
      expect(report.errors[0]).toContain('Push failed');
    });
  });

  // ── getState ─────────────────────────────────────────────────────────

  describe('getState', () => {
    it('returns a copy of internal state', () => {
      const engine = new SyncEngine(tmpDir, mockScanProject);
      engine.configure('obsidian', { vaultPath: '/tmp' });
      const state = engine.getState();
      expect(state.provider).toBe('obsidian');
      // Verify top-level properties are independent
      state.provider = 'changed';
      expect(engine.state.provider).toBe('obsidian');
    });
  });
});
