/**
 * Tests for main process IPC handler logic.
 *
 * We extract and test the data/preference logic independently,
 * without requiring Electron. Uses a temp file for preferences.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Helpers to simulate prefs logic from main.js ────────────────────────

let tmpDir;
let prefsFile;

function loadPrefs() {
  try {
    if (fs.existsSync(prefsFile)) return JSON.parse(fs.readFileSync(prefsFile, 'utf-8'));
  } catch { /* ignore */ }
  return {};
}

function savePrefs(prefs) {
  const dir = path.dirname(prefsFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(prefsFile, JSON.stringify(prefs, null, 2));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmad-main-test-'));
  prefsFile = path.join(tmpDir, 'preferences.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Preferences persistence ─────────────────────────────────────────────

describe('Preferences — load/save', () => {
  it('returns empty object when no prefs file exists', () => {
    expect(loadPrefs()).toEqual({});
  });

  it('persists and loads preferences', () => {
    savePrefs({ lastProjectPath: '/foo/bar' });
    const prefs = loadPrefs();
    expect(prefs.lastProjectPath).toBe('/foo/bar');
  });

  it('overwrites existing preferences', () => {
    savePrefs({ a: 1 });
    savePrefs({ b: 2 });
    const prefs = loadPrefs();
    expect(prefs.b).toBe(2);
    expect(prefs.a).toBeUndefined();
  });

  it('handles corrupted JSON gracefully', () => {
    fs.writeFileSync(prefsFile, 'not json{{{');
    expect(loadPrefs()).toEqual({});
  });
});

// ── Project list management ─────────────────────────────────────────────

describe('Project list', () => {
  function addProject(projectPath) {
    const prefs = loadPrefs();
    prefs.lastProjectPath = projectPath;
    if (!Array.isArray(prefs.projects)) prefs.projects = [];
    const name = path.basename(projectPath);
    const existing = prefs.projects.findIndex(p => p.path === projectPath);
    const now = new Date().toISOString();
    if (existing !== -1) {
      const proj = prefs.projects[existing];
      proj.lastOpenedAt = now;
      prefs.projects.splice(existing, 1);
      prefs.projects.unshift(proj);
    } else {
      prefs.projects.unshift({ name, path: projectPath, archived: false, addedAt: now, lastOpenedAt: now });
    }
    savePrefs(prefs);
    return prefs;
  }

  it('adds a new project to the list', () => {
    addProject('/home/user/project-a');
    const prefs = loadPrefs();
    expect(prefs.projects).toHaveLength(1);
    expect(prefs.projects[0].name).toBe('project-a');
    expect(prefs.projects[0].path).toBe('/home/user/project-a');
    expect(prefs.projects[0].archived).toBe(false);
  });

  it('moves existing project to top on re-open', () => {
    addProject('/home/user/project-a');
    addProject('/home/user/project-b');
    addProject('/home/user/project-a'); // Re-open

    const prefs = loadPrefs();
    expect(prefs.projects).toHaveLength(2);
    expect(prefs.projects[0].path).toBe('/home/user/project-a');
    expect(prefs.projects[1].path).toBe('/home/user/project-b');
  });

  it('sets lastProjectPath', () => {
    addProject('/home/user/my-project');
    expect(loadPrefs().lastProjectPath).toBe('/home/user/my-project');
  });

  it('does not duplicate projects', () => {
    addProject('/home/user/x');
    addProject('/home/user/x');
    addProject('/home/user/x');
    expect(loadPrefs().projects).toHaveLength(1);
  });
});

// ── Project archiving ───────────────────────────────────────────────────

describe('Project archiving', () => {
  function archiveProject(projectPath) {
    const prefs = loadPrefs();
    if (!Array.isArray(prefs.projects)) return false;
    const project = prefs.projects.find(p => p.path === projectPath);
    if (project) {
      project.archived = true;
      savePrefs(prefs);
    }
    return true;
  }

  function unarchiveProject(projectPath) {
    const prefs = loadPrefs();
    if (!Array.isArray(prefs.projects)) return false;
    const project = prefs.projects.find(p => p.path === projectPath);
    if (project) {
      project.archived = false;
      savePrefs(prefs);
    }
    return true;
  }

  it('archives a project', () => {
    savePrefs({ projects: [{ name: 'test', path: '/test', archived: false }] });
    archiveProject('/test');
    const prefs = loadPrefs();
    expect(prefs.projects[0].archived).toBe(true);
  });

  it('unarchives a project', () => {
    savePrefs({ projects: [{ name: 'test', path: '/test', archived: true }] });
    unarchiveProject('/test');
    const prefs = loadPrefs();
    expect(prefs.projects[0].archived).toBe(false);
  });

  it('handles archiving non-existent project gracefully', () => {
    savePrefs({ projects: [{ name: 'a', path: '/a', archived: false }] });
    archiveProject('/nonexistent');
    expect(loadPrefs().projects[0].archived).toBe(false);
  });
});

// ── Session history ─────────────────────────────────────────────────────

describe('Session history', () => {
  function saveSessionEntry(entry) {
    const prefs = loadPrefs();
    if (!Array.isArray(prefs.sessionHistory)) prefs.sessionHistory = [];
    entry.createdAt = entry.createdAt || new Date().toISOString();
    prefs.sessionHistory.unshift(entry);
    if (prefs.sessionHistory.length > 20) {
      prefs.sessionHistory = prefs.sessionHistory.slice(0, 20);
    }
    savePrefs(prefs);
  }

  function getSessionHistory() {
    const prefs = loadPrefs();
    return Array.isArray(prefs.sessionHistory) ? prefs.sessionHistory : [];
  }

  function removeSessionEntry(entryId) {
    const prefs = loadPrefs();
    if (!Array.isArray(prefs.sessionHistory)) return [];
    prefs.sessionHistory = prefs.sessionHistory.filter(e => e.id !== entryId);
    savePrefs(prefs);
    return prefs.sessionHistory;
  }

  function clearHistory() {
    const prefs = loadPrefs();
    prefs.sessionHistory = [];
    savePrefs(prefs);
  }

  it('returns empty array when no history', () => {
    expect(getSessionHistory()).toEqual([]);
  });

  it('saves and retrieves session entries', () => {
    saveSessionEntry({ id: '1', command: 'claude /dev-story', label: 'Story 1' });
    const history = getSessionHistory();
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe('1');
    expect(history[0].command).toBe('claude /dev-story');
  });

  it('prepends new entries (most recent first)', () => {
    saveSessionEntry({ id: '1', label: 'First' });
    saveSessionEntry({ id: '2', label: 'Second' });
    const history = getSessionHistory();
    expect(history[0].id).toBe('2');
    expect(history[1].id).toBe('1');
  });

  it('limits history to 20 entries', () => {
    for (let i = 0; i < 25; i++) {
      saveSessionEntry({ id: `${i}`, label: `Entry ${i}` });
    }
    expect(getSessionHistory()).toHaveLength(20);
  });

  it('removes a specific entry by id', () => {
    saveSessionEntry({ id: 'keep', label: 'Keep' });
    saveSessionEntry({ id: 'remove', label: 'Remove' });
    removeSessionEntry('remove');
    const history = getSessionHistory();
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe('keep');
  });

  it('clears all history', () => {
    saveSessionEntry({ id: '1', label: 'A' });
    saveSessionEntry({ id: '2', label: 'B' });
    clearHistory();
    expect(getSessionHistory()).toEqual([]);
  });

  it('adds createdAt automatically', () => {
    saveSessionEntry({ id: '1', label: 'Auto date' });
    const entry = getSessionHistory()[0];
    expect(entry.createdAt).toBeDefined();
    expect(new Date(entry.createdAt).getFullYear()).toBeGreaterThanOrEqual(2025);
  });
});

// ── Story sessions ──────────────────────────────────────────────────────

describe('Story sessions', () => {
  function getStorySession(storySlug, phase) {
    const prefs = loadPrefs();
    if (!prefs.storySessions) return null;
    return prefs.storySessions[`${storySlug}:${phase}`] || null;
  }

  function saveStorySession(storySlug, phase, sessionId) {
    const prefs = loadPrefs();
    if (!prefs.storySessions) prefs.storySessions = {};
    prefs.storySessions[`${storySlug}:${phase}`] = sessionId;
    savePrefs(prefs);
  }

  it('returns null when no session exists', () => {
    expect(getStorySession('1-1-foo', 'in-progress')).toBeNull();
  });

  it('saves and retrieves story session', () => {
    saveStorySession('1-1-foo', 'in-progress', 'session-abc');
    expect(getStorySession('1-1-foo', 'in-progress')).toBe('session-abc');
  });

  it('different phases have different sessions', () => {
    saveStorySession('1-1-foo', 'in-progress', 'sess-dev');
    saveStorySession('1-1-foo', 'review', 'sess-review');
    expect(getStorySession('1-1-foo', 'in-progress')).toBe('sess-dev');
    expect(getStorySession('1-1-foo', 'review')).toBe('sess-review');
  });

  it('overwrites existing session for same story+phase', () => {
    saveStorySession('1-1-foo', 'in-progress', 'old');
    saveStorySession('1-1-foo', 'in-progress', 'new');
    expect(getStorySession('1-1-foo', 'in-progress')).toBe('new');
  });
});

// ── Settings ────────────────────────────────────────────────────────────

describe('Settings', () => {
  function getSettings() {
    const prefs = loadPrefs();
    return prefs.settings || {
      defaultLlm: 'claude',
      reviewLlm: 'claude',
      llmConfig: {
        claude: { binary: 'claude', extraArgs: '' },
        codex: { binary: 'codex', extraArgs: '--full-auto' },
      },
      terminal: { fontSize: 13 },
      notifications: { toast: true, os: true, sound: false, pollInterval: 30 }
    };
  }

  function saveSettings(settings) {
    const prefs = loadPrefs();
    prefs.settings = settings;
    savePrefs(prefs);
  }

  it('returns defaults when no settings saved', () => {
    const settings = getSettings();
    expect(settings.defaultLlm).toBe('claude');
    expect(settings.terminal.fontSize).toBe(13);
  });

  it('returns default notification settings', () => {
    const settings = getSettings();
    expect(settings.notifications.toast).toBe(true);
    expect(settings.notifications.os).toBe(true);
    expect(settings.notifications.sound).toBe(false);
    expect(settings.notifications.pollInterval).toBe(30);
  });

  it('saves and retrieves custom settings', () => {
    saveSettings({ defaultLlm: 'codex', terminal: { fontSize: 16 } });
    const prefs = loadPrefs();
    expect(prefs.settings.defaultLlm).toBe('codex');
    expect(prefs.settings.terminal.fontSize).toBe(16);
  });

  it('saves and retrieves notification settings', () => {
    saveSettings({
      defaultLlm: 'claude',
      notifications: { toast: false, os: true, sound: true, pollInterval: 60 }
    });
    const prefs = loadPrefs();
    expect(prefs.settings.notifications.toast).toBe(false);
    expect(prefs.settings.notifications.sound).toBe(true);
    expect(prefs.settings.notifications.pollInterval).toBe(60);
  });
});

// ── Quick actions ───────────────────────────────────────────────────────

describe('Quick actions', () => {
  it('returns null when no quick actions saved', () => {
    expect(loadPrefs().quickActions).toBeUndefined();
  });

  it('saves and retrieves quick actions', () => {
    const actions = [
      { label: 'Build', command: 'npm run build' },
      { label: 'Test', command: 'npm test' }
    ];
    const prefs = loadPrefs();
    prefs.quickActions = actions;
    savePrefs(prefs);

    const loaded = loadPrefs();
    expect(loaded.quickActions).toHaveLength(2);
    expect(loaded.quickActions[0].label).toBe('Build');
  });
});

// ── Project removal ─────────────────────────────────────────────────────

describe('Project removal', () => {
  it('removes a project from the list', () => {
    savePrefs({
      projects: [
        { name: 'a', path: '/a' },
        { name: 'b', path: '/b' },
        { name: 'c', path: '/c' }
      ]
    });
    const prefs = loadPrefs();
    prefs.projects = prefs.projects.filter(p => p.path !== '/b');
    savePrefs(prefs);

    const updated = loadPrefs();
    expect(updated.projects).toHaveLength(2);
    expect(updated.projects.map(p => p.path)).toEqual(['/a', '/c']);
  });
});

// ── File versioning ─────────────────────────────────────────────────────

describe('File versioning', () => {
  let versionsFile;

  function loadVersionsDb() {
    try {
      if (fs.existsSync(versionsFile)) return JSON.parse(fs.readFileSync(versionsFile, 'utf-8'));
    } catch { /* ignore */ }
    return {};
  }

  function saveVersionsDb(db) {
    fs.writeFileSync(versionsFile, JSON.stringify(db));
  }

  function saveVersion(filePath, content, maxVersions = 20) {
    const db = loadVersionsDb();
    if (!db[filePath]) db[filePath] = [];
    db[filePath].unshift({
      savedAt: new Date().toISOString(),
      content
    });
    if (db[filePath].length > maxVersions) {
      db[filePath] = db[filePath].slice(0, maxVersions);
    }
    saveVersionsDb(db);
  }

  function getVersions(filePath) {
    const db = loadVersionsDb();
    return (db[filePath] || []).map((v, i) => ({
      index: i,
      savedAt: v.savedAt,
      content: v.content,
      preview: v.content.substring(0, 120)
    }));
  }

  beforeEach(() => {
    versionsFile = path.join(tmpDir, 'file-versions.json');
  });

  it('returns empty array when no versions exist', () => {
    expect(getVersions('/some/file.md')).toEqual([]);
  });

  it('saves a version and retrieves it', () => {
    saveVersion('/test.md', '# Original content');
    const versions = getVersions('/test.md');
    expect(versions).toHaveLength(1);
    expect(versions[0].content).toBe('# Original content');
    expect(versions[0].savedAt).toBeDefined();
  });

  it('most recent version is first', () => {
    saveVersion('/test.md', 'Version 1');
    saveVersion('/test.md', 'Version 2');
    saveVersion('/test.md', 'Version 3');
    const versions = getVersions('/test.md');
    expect(versions[0].content).toBe('Version 3');
    expect(versions[2].content).toBe('Version 1');
  });

  it('limits versions per file', () => {
    for (let i = 0; i < 25; i++) {
      saveVersion('/test.md', `Content ${i}`, 20);
    }
    expect(getVersions('/test.md')).toHaveLength(20);
  });

  it('keeps versions separate per file', () => {
    saveVersion('/a.md', 'Content A');
    saveVersion('/b.md', 'Content B');
    expect(getVersions('/a.md')).toHaveLength(1);
    expect(getVersions('/b.md')).toHaveLength(1);
    expect(getVersions('/a.md')[0].content).toBe('Content A');
  });

  it('includes preview in version entries', () => {
    const longContent = 'X'.repeat(200);
    saveVersion('/test.md', longContent);
    const versions = getVersions('/test.md');
    expect(versions[0].preview).toHaveLength(120);
  });

  it('write-file creates version of old content before overwriting', () => {
    // Simulate the write-file flow
    const filePath = path.join(tmpDir, 'story.md');
    fs.writeFileSync(filePath, '# Original');

    // Simulate what main.js write-file handler does
    const oldContent = fs.readFileSync(filePath, 'utf-8');
    const newContent = '# Updated';
    if (oldContent !== newContent) {
      saveVersion(filePath, oldContent);
    }
    fs.writeFileSync(filePath, newContent);

    // Verify
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('# Updated');
    const versions = getVersions(filePath);
    expect(versions).toHaveLength(1);
    expect(versions[0].content).toBe('# Original');
  });

  it('restore creates version of current content', () => {
    const filePath = path.join(tmpDir, 'story.md');
    fs.writeFileSync(filePath, '# V1');
    saveVersion(filePath, '# V1');
    fs.writeFileSync(filePath, '# V2');

    // Simulate restore
    const versions = getVersions(filePath);
    const restoreContent = versions[0].content;
    const currentContent = fs.readFileSync(filePath, 'utf-8');
    saveVersion(filePath, currentContent); // Save current before restoring
    fs.writeFileSync(filePath, restoreContent);

    expect(fs.readFileSync(filePath, 'utf-8')).toBe('# V1');
    const newVersions = getVersions(filePath);
    expect(newVersions).toHaveLength(2);
    expect(newVersions[0].content).toBe('# V2'); // Current was saved
  });
});

// ── Per-project session history (.bmad-board/session-history.json) ─────────

describe('Per-project session history', () => {
  let projectDir;

  function getProjectHistoryPath(projectPath) {
    return path.join(projectPath, '.bmad-board', 'session-history.json');
  }

  function loadProjectHistory(projectPath) {
    const histFile = getProjectHistoryPath(projectPath);
    try {
      if (fs.existsSync(histFile)) return JSON.parse(fs.readFileSync(histFile, 'utf-8'));
    } catch { /* ignore */ }
    return [];
  }

  function saveProjectHistory(projectPath, history) {
    const histFile = getProjectHistoryPath(projectPath);
    const dir = path.dirname(histFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(histFile, JSON.stringify(history, null, 2));
  }

  function migrateSessionHistory(projectPath) {
    const prefs = loadPrefs();
    if (!Array.isArray(prefs.sessionHistory) || prefs.sessionHistory.length === 0) return;
    const matching = prefs.sessionHistory.filter(e => e.projectPath === projectPath);
    if (matching.length === 0) return;
    const existing = loadProjectHistory(projectPath);
    const existingIds = new Set(existing.map(e => e.id));
    const toMerge = matching.filter(e => !existingIds.has(e.id));
    if (toMerge.length > 0) {
      const merged = [...toMerge, ...existing].slice(0, 20);
      saveProjectHistory(projectPath, merged);
    }
    prefs.sessionHistory = prefs.sessionHistory.filter(e => e.projectPath !== projectPath);
    savePrefs(prefs);
  }

  beforeEach(() => {
    projectDir = path.join(tmpDir, 'my-project');
    fs.mkdirSync(projectDir, { recursive: true });
  });

  it('returns empty array when no history exists', () => {
    expect(loadProjectHistory(projectDir)).toEqual([]);
  });

  it('saves and loads session history per project', () => {
    const entry = { id: 'sess-1', command: 'dev story-1', createdAt: '2026-01-01T00:00:00Z' };
    const history = loadProjectHistory(projectDir);
    history.unshift(entry);
    saveProjectHistory(projectDir, history);

    const loaded = loadProjectHistory(projectDir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('sess-1');
  });

  it('creates .bmad-board folder automatically', () => {
    saveProjectHistory(projectDir, [{ id: 'a' }]);
    expect(fs.existsSync(path.join(projectDir, '.bmad-board'))).toBe(true);
    expect(fs.existsSync(getProjectHistoryPath(projectDir))).toBe(true);
  });

  it('keeps history separate between projects', () => {
    const projectA = path.join(tmpDir, 'proj-a');
    const projectB = path.join(tmpDir, 'proj-b');
    fs.mkdirSync(projectA, { recursive: true });
    fs.mkdirSync(projectB, { recursive: true });

    saveProjectHistory(projectA, [{ id: 'a1' }, { id: 'a2' }]);
    saveProjectHistory(projectB, [{ id: 'b1' }]);

    expect(loadProjectHistory(projectA)).toHaveLength(2);
    expect(loadProjectHistory(projectB)).toHaveLength(1);
    expect(loadProjectHistory(projectB)[0].id).toBe('b1');
  });

  it('migrates global history to per-project file', () => {
    // Seed global prefs with legacy session history
    savePrefs({
      sessionHistory: [
        { id: 's1', projectPath: projectDir, command: 'dev s1' },
        { id: 's2', projectPath: '/other/project', command: 'dev s2' },
        { id: 's3', projectPath: projectDir, command: 'dev s3' }
      ]
    });

    migrateSessionHistory(projectDir);

    // Per-project file should have the 2 matching entries
    const projectHist = loadProjectHistory(projectDir);
    expect(projectHist).toHaveLength(2);
    expect(projectHist.map(e => e.id)).toEqual(['s1', 's3']);

    // Global prefs should only have the non-matching entry
    const prefs = loadPrefs();
    expect(prefs.sessionHistory).toHaveLength(1);
    expect(prefs.sessionHistory[0].id).toBe('s2');
  });

  it('does not duplicate entries during migration', () => {
    // Entry already in per-project file
    saveProjectHistory(projectDir, [{ id: 's1', command: 'existing' }]);

    // Same ID in global prefs
    savePrefs({
      sessionHistory: [
        { id: 's1', projectPath: projectDir, command: 'from global' },
        { id: 's2', projectPath: projectDir, command: 'new' }
      ]
    });

    migrateSessionHistory(projectDir);

    const hist = loadProjectHistory(projectDir);
    // s2 is new, s1 already existed - no duplicate
    expect(hist).toHaveLength(2);
    expect(hist.map(e => e.id)).toEqual(['s2', 's1']);
  });
});

// ── terminal:tab-meta IPC handler (new in this PR) ──────────────────────
//
// The handler in main.js calls companionServer.shareTerminalStart when it
// receives terminal:tab-meta from the renderer process. We test the logic
// inline (extracted) since the IPC channel itself requires Electron.

describe('terminal:tab-meta IPC handler logic', () => {
  /**
   * Simulates the handler from main.js:
   *   ipcMain.on('terminal:tab-meta', (event, data) => {
   *     if (companionServer && data?.sessionId) {
   *       companionServer.shareTerminalStart(data.sessionId, {
   *         storySlug: data.storySlug,
   *         storyPhase: data.storyPhase
   *       });
   *     }
   *   });
   */
  function handleTerminalTabMeta(companionServer, data) {
    if (companionServer && data?.sessionId) {
      companionServer.shareTerminalStart(data.sessionId, {
        storySlug: data.storySlug,
        storyPhase: data.storyPhase
      });
    }
  }

  it('calls shareTerminalStart with correct sessionId and story metadata', () => {
    const calls = [];
    const mockServer = {
      shareTerminalStart: (sessionId, opts) => calls.push({ sessionId, opts })
    };

    handleTerminalTabMeta(mockServer, {
      sessionId: 42,
      storySlug: '1-1-my-story',
      storyPhase: 'in-progress'
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].sessionId).toBe(42);
    expect(calls[0].opts.storySlug).toBe('1-1-my-story');
    expect(calls[0].opts.storyPhase).toBe('in-progress');
  });

  it('does nothing when companionServer is null', () => {
    // Should not throw
    expect(() => handleTerminalTabMeta(null, { sessionId: 1, storySlug: 'x' })).not.toThrow();
  });

  it('does nothing when data has no sessionId', () => {
    const calls = [];
    const mockServer = {
      shareTerminalStart: (sessionId, opts) => calls.push({ sessionId, opts })
    };

    handleTerminalTabMeta(mockServer, { storySlug: 'x', storyPhase: 'review' });
    expect(calls).toHaveLength(0);
  });

  it('does nothing when data is null', () => {
    const calls = [];
    const mockServer = {
      shareTerminalStart: (sessionId, opts) => calls.push({ sessionId, opts })
    };

    handleTerminalTabMeta(mockServer, null);
    expect(calls).toHaveLength(0);
  });

  it('passes undefined storySlug and storyPhase when not present in data', () => {
    const calls = [];
    const mockServer = {
      shareTerminalStart: (sessionId, opts) => calls.push({ sessionId, opts })
    };

    handleTerminalTabMeta(mockServer, { sessionId: 99 });

    expect(calls).toHaveLength(1);
    expect(calls[0].sessionId).toBe(99);
    expect(calls[0].opts.storySlug).toBeUndefined();
    expect(calls[0].opts.storyPhase).toBeUndefined();
  });

  it('handles tab metadata without a story (plain terminal tab)', () => {
    const calls = [];
    const mockServer = {
      shareTerminalStart: (sessionId, opts) => calls.push({ sessionId, opts })
    };

    // Renderer sends tab meta for a non-story terminal (storySlug absent)
    handleTerminalTabMeta(mockServer, { sessionId: 7, storySlug: undefined, storyPhase: undefined });

    expect(calls).toHaveLength(1);
    expect(calls[0].opts.storySlug).toBeUndefined();
  });
});