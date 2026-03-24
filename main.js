const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { scanProject } = require('./lib/bmad-scanner');
const { buildClaudeCommand } = require('./lib/phase-commands');
const { openClaudeWithCommand, openPartyMode } = require('./lib/terminal-launcher');
const { TerminalManager } = require('./lib/terminal-manager');
const { getProviderList } = require('./lib/llm-providers');
const { CompanionServer, startHeartbeat } = require('./lib/companion-server');

let mainWindow;
let currentProjectPath = null;
const windowProjectPaths = new Map();  // webContents.id -> projectPath
const terminalManager = new TerminalManager();
let companionServer = null;
let companionHeartbeat = null;

const PREFS_FILE = path.join(app.getPath('userData'), 'preferences.json');

function loadPrefs() {
  try {
    if (fs.existsSync(PREFS_FILE)) return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf-8'));
  } catch { /* ignore */ }
  return {};
}

function savePrefs(prefs) {
  const dir = path.dirname(PREFS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a1a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.loadFile('index.html');

  win.on('closed', () => {
    windowProjectPaths.delete(win.webContents.id);
  });

  // Keep mainWindow pointing to latest for backward compat
  mainWindow = win;
  return win;
}

function getWindowProjectPath(event) {
  return windowProjectPaths.get(event.sender.id) || currentProjectPath;
}

function setWindowProjectPath(event, projectPath) {
  windowProjectPaths.set(event.sender.id, projectPath);
  // Keep global in sync for backward compat
  currentProjectPath = projectPath;
}

function getWindowFromEvent(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

app.whenReady().then(async () => {
  createWindow();
  await startCompanionServer();
});

async function startCompanionServer() {
  const prefs = loadPrefs();
  const companionEnabled = prefs.settings?.companion?.enabled !== false; // enabled by default
  if (!companionEnabled) return;

  const port = prefs.settings?.companion?.port || 3939;

  companionServer = new CompanionServer({
    terminalManager,
    scanProject: (projectPath) => scanProject(projectPath),
    getProjectPath: () => currentProjectPath,
    getSettings: () => {
      const p = loadPrefs();
      return p.settings || {};
    },
    buildCommand: (phase, storySlug, storyFilePath) => {
      return buildClaudeCommand(phase, storySlug, storyFilePath);
    },
    updateStoryStatus: (projectPath, slug, newPhase) => {
      updateStoryStatusInYaml(projectPath, slug, newPhase);
    }
  });

  try {
    await companionServer.start(port);
    companionHeartbeat = startHeartbeat(companionServer);
    console.log('[companion] Server started successfully');
  } catch (err) {
    console.error('[companion] Failed to start server:', err.message);
  }
}

// ── Story Status Update in YAML ────────────────────────────────────────

function updateStoryStatusInYaml(projectPath, slug, newPhase) {
  const implDir = path.join(projectPath, '_bmad-output', 'implementation');
  const candidates = [
    path.join(implDir, 'sprint-status.yaml'),
    path.join(projectPath, '_bmad-output', 'sprint-status.yaml')
  ];

  // Also check config-driven paths
  const data = scanProject(projectPath);
  if (data.config?.implementationArtifacts) {
    candidates.unshift(path.join(data.config.implementationArtifacts, 'sprint-status.yaml'));
  }

  const filePath = candidates.find(p => fs.existsSync(p));
  if (!filePath) throw new Error('sprint-status.yaml not found');

  let content = fs.readFileSync(filePath, 'utf-8');
  const regex = new RegExp(`^(\\s*${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*)(.+)$`, 'm');
  const match = content.match(regex);

  if (!match) throw new Error(`Story "${slug}" not found in sprint-status.yaml`);

  content = content.replace(regex, `$1${newPhase}`);
  fs.writeFileSync(filePath, content, 'utf-8');
}

ipcMain.handle('new-window', () => {
  createWindow();
  return true;
});

app.on('window-all-closed', () => {
  terminalManager.killAll();
  if (companionHeartbeat) clearInterval(companionHeartbeat);
  if (companionServer) companionServer.stop();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── IPC: Project management ──────────────────────────────────────────────

ipcMain.handle('open-project', async (event) => {
  const win = getWindowFromEvent(event);
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    message: 'Select a project folder with BMAD files'
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return loadProject(result.filePaths[0], event);
});

ipcMain.handle('load-last-project', (event) => {
  const prefs = loadPrefs();
  if (prefs.lastProjectPath && fs.existsSync(prefs.lastProjectPath)) {
    return loadProject(prefs.lastProjectPath, event);
  }
  return null;
});

ipcMain.handle('scan-project', (event) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return null;
  return scanProject(projectPath);
});

ipcMain.handle('read-file', (_, filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
});

ipcMain.handle('write-file', (_, filePath, content) => {
  try {
    // Create a version snapshot before overwriting
    const oldContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;
    if (oldContent !== null && oldContent !== content) {
      saveVersion(filePath, oldContent);
    }
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('get-file-versions', (_, filePath) => {
  return getVersions(filePath);
});

ipcMain.handle('restore-file-version', (_, filePath, versionIndex) => {
  try {
    const versions = getVersions(filePath);
    if (versionIndex < 0 || versionIndex >= versions.length) return { error: 'Version not found' };
    const version = versions[versionIndex];
    // Save current content as a new version before restoring
    const currentContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;
    if (currentContent !== null) {
      saveVersion(filePath, currentContent);
    }
    fs.writeFileSync(filePath, version.content, 'utf-8');
    return { success: true, content: version.content };
  } catch (err) {
    return { error: err.message };
  }
});

// ── IPC: Terminal / Claude commands (external) ───────────────────────────

ipcMain.handle('launch-phase-command', async (event, { phase, storySlug, storyFilePath }) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const cmd = buildClaudeCommand(phase, storySlug, storyFilePath);
  if (!cmd) return { error: 'No command for this phase' };
  try {
    await openClaudeWithCommand(projectPath, cmd);
    return { success: true, command: cmd };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('launch-party-mode', async (event) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  try {
    await openPartyMode(projectPath);
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('open-terminal', async (event, command) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  try {
    const { openTerminal } = require('./lib/terminal-launcher');
    await openTerminal(projectPath, command || '');
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

// ── IPC: Embedded Terminal (PTY) ─────────────────────────────────────────

ipcMain.handle('terminal:create', (event, { cols, rows }) => {
  const cwd = getWindowProjectPath(event) || require('os').homedir();
  const senderContents = event.sender;
  const id = terminalManager.create({
    cwd,
    cols: cols || 120,
    rows: rows || 30,
    onData: (sessionId, data) => {
      if (!senderContents.isDestroyed()) {
        senderContents.send('terminal:data', { id: sessionId, data });
      }
      // Share with companion clients
      if (companionServer) {
        companionServer.shareTerminalData(sessionId, data);
      }
    },
    onExit: (sessionId, exitCode) => {
      if (!senderContents.isDestroyed()) {
        senderContents.send('terminal:exit', { id: sessionId, exitCode });
      }
      // Share with companion clients
      if (companionServer) {
        companionServer.shareTerminalExit(sessionId, exitCode);
      }
    }
  });
  return { id };
});

ipcMain.on('terminal:input', (_, { id, data }) => {
  terminalManager.write(id, data);
});

ipcMain.on('terminal:resize', (_, { id, cols, rows }) => {
  terminalManager.resize(id, cols, rows);
});

ipcMain.handle('terminal:kill', (_, { id }) => {
  terminalManager.kill(id);
  return { success: true };
});

ipcMain.handle('get-project-path', (event) => {
  return getWindowProjectPath(event);
});

ipcMain.handle('get-project-list', () => {
  const prefs = loadPrefs();
  const projects = Array.isArray(prefs.projects) ? prefs.projects : [];
  // Filter out projects whose directories no longer exist
  return projects.filter(p => fs.existsSync(p.path));
});

ipcMain.handle('load-project-by-path', (event, projectPath) => {
  if (!projectPath || !fs.existsSync(projectPath)) return null;
  return loadProject(projectPath, event);
});

ipcMain.handle('remove-project-from-list', (_, projectPath) => {
  const prefs = loadPrefs();
  if (!Array.isArray(prefs.projects)) return;
  prefs.projects = prefs.projects.filter(p => p.path !== projectPath);
  savePrefs(prefs);
  return prefs.projects;
});

ipcMain.handle('get-quick-actions', () => {
  const prefs = loadPrefs();
  return prefs.quickActions || null; // null = use defaults
});

ipcMain.handle('save-quick-actions', (_, actions) => {
  const prefs = loadPrefs();
  prefs.quickActions = actions;
  savePrefs(prefs);
  return true;
});

ipcMain.handle('open-external', (_, url) => {
  shell.openExternal(url);
});

ipcMain.handle('get-story-session', (_, storySlug, phase) => {
  const prefs = loadPrefs();
  if (!prefs.storySessions) return null;
  return prefs.storySessions[`${storySlug}:${phase}`] || null;
});

ipcMain.handle('save-story-session', (_, storySlug, phase, sessionId) => {
  const prefs = loadPrefs();
  if (!prefs.storySessions) prefs.storySessions = {};
  prefs.storySessions[`${storySlug}:${phase}`] = sessionId;
  savePrefs(prefs);
  return true;
});

// ── IPC: Session History ─────────────────────────────────────────────────

// ── Per-project session history (.bmad-board/session-history.json) ────────

function getProjectHistoryPath(projectPath) {
  return path.join(projectPath, '.bmad-board', 'session-history.json');
}

function migrateSessionHistory(projectPath) {
  const prefs = loadPrefs();
  if (!Array.isArray(prefs.sessionHistory) || prefs.sessionHistory.length === 0) return;

  const matching = prefs.sessionHistory.filter(e => e.projectPath === projectPath);
  if (matching.length === 0) return;

  // Merge into per-project file (avoid duplicates by id)
  const existing = loadProjectHistory(projectPath);
  const existingIds = new Set(existing.map(e => e.id));
  const toMerge = matching.filter(e => !existingIds.has(e.id));

  if (toMerge.length > 0) {
    const merged = [...toMerge, ...existing].slice(0, 20);
    saveProjectHistory(projectPath, merged);
  }

  // Remove migrated entries from global prefs
  prefs.sessionHistory = prefs.sessionHistory.filter(e => e.projectPath !== projectPath);
  savePrefs(prefs);
}

function loadProjectHistory(projectPath) {
  if (!projectPath) return [];
  const histFile = getProjectHistoryPath(projectPath);
  try {
    if (fs.existsSync(histFile)) return JSON.parse(fs.readFileSync(histFile, 'utf-8'));
  } catch { /* ignore */ }
  return [];
}

function saveProjectHistory(projectPath, history) {
  if (!projectPath) return;
  const histFile = getProjectHistoryPath(projectPath);
  const dir = path.dirname(histFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(histFile, JSON.stringify(history, null, 2));
}

ipcMain.handle('session-history:save', (event, entry) => {
  const projectPath = getWindowProjectPath(event);
  const history = loadProjectHistory(projectPath);

  entry.createdAt = entry.createdAt || new Date().toISOString();
  entry.projectPath = entry.projectPath || projectPath;
  entry.projectName = entry.projectName || (projectPath ? path.basename(projectPath) : 'Unknown');

  // Prepend (most recent first)
  history.unshift(entry);

  // Keep max 20 entries
  if (history.length > 20) history.length = 20;

  saveProjectHistory(projectPath, history);
  return true;
});

ipcMain.handle('session-history:get', (event) => {
  const projectPath = getWindowProjectPath(event);
  return loadProjectHistory(projectPath);
});

ipcMain.handle('session-history:remove', (event, entryId) => {
  const projectPath = getWindowProjectPath(event);
  const history = loadProjectHistory(projectPath).filter(e => e.id !== entryId);
  saveProjectHistory(projectPath, history);
  return history;
});

ipcMain.handle('session-history:clear', (event) => {
  const projectPath = getWindowProjectPath(event);
  saveProjectHistory(projectPath, []);
  return [];
});

// ── IPC: Settings ─────────────────────────────────────────────────────────

ipcMain.handle('settings:get', () => {
  const prefs = loadPrefs();
  return prefs.settings || {
    defaultLlm: 'claude',
    reviewLlm: 'claude',
    llmConfig: {
      claude: { binary: 'claude', extraArgs: '' },
      codex: { binary: 'codex', extraArgs: '--full-auto' },
      cursor: { binary: 'cursor', extraArgs: '' },
      aider: { binary: 'aider', extraArgs: '' },
      opencode: { binary: 'opencode', extraArgs: '' }
    },
    terminal: {
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'SF Mono', 'Menlo', 'Consolas', monospace",
      scrollback: 10000
    },
    notifications: {
      toast: true,
      os: true,
      sound: false,
      pollInterval: 30
    }
  };
});

ipcMain.handle('settings:save', (_, settings) => {
  const prefs = loadPrefs();
  prefs.settings = settings;
  savePrefs(prefs);
  return true;
});

ipcMain.handle('settings:get-providers', () => {
  return getProviderList();
});

// ── IPC: Companion Server ──────────────────────────────────────────────

ipcMain.handle('companion:get-info', () => {
  if (!companionServer) return { enabled: false };
  return {
    enabled: true,
    ...companionServer.getConnectionInfo()
  };
});

ipcMain.handle('companion:toggle', async (_, enabled) => {
  const prefs = loadPrefs();
  if (!prefs.settings) prefs.settings = {};
  if (!prefs.settings.companion) prefs.settings.companion = {};
  prefs.settings.companion.enabled = enabled;
  savePrefs(prefs);

  if (enabled && !companionServer) {
    await startCompanionServer();
  } else if (!enabled && companionServer) {
    if (companionHeartbeat) clearInterval(companionHeartbeat);
    companionServer.stop();
    companionServer = null;
  }

  return enabled;
});

ipcMain.handle('companion:regenerate-token', () => {
  if (!companionServer) return null;
  const crypto = require('crypto');
  companionServer.token = crypto.randomBytes(24).toString('hex');
  return companionServer.getConnectionInfo();
});

ipcMain.handle('show-notification', (event, { title, body }) => {
  if (!Notification.isSupported()) return false;
  const notification = new Notification({ title, body });
  notification.on('click', () => {
    const win = getWindowFromEvent(event);
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  notification.show();
  return true;
});

// ── IPC: BMAD Config ──────────────────────────────────────────────────────

ipcMain.handle('bmad-config:read', (event) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return null;
  const configPath = path.join(projectPath, '_bmad', 'bmm', 'config.yaml');
  try {
    if (!fs.existsSync(configPath)) return null;
    const content = fs.readFileSync(configPath, 'utf-8');
    // Simple YAML parser for key: value pairs
    const config = {};
    content.split('\n').forEach(line => {
      const match = line.match(/^(\w[\w_]*)\s*:\s*(.+)$/);
      if (match) {
        let val = match[2].trim();
        // Strip quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        config[match[1]] = val;
      }
    });
    return config;
  } catch {
    return null;
  }
});

ipcMain.handle('bmad-config:write', (event, updates) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const configPath = path.join(projectPath, '_bmad', 'bmm', 'config.yaml');
  try {
    if (!fs.existsSync(configPath)) return { error: 'Config file not found' };
    let content = fs.readFileSync(configPath, 'utf-8');
    for (const [key, value] of Object.entries(updates)) {
      const regex = new RegExp(`^(${key}\\s*:\\s*)(.+)$`, 'm');
      if (regex.test(content)) {
        content = content.replace(regex, `$1${value}`);
      }
    }
    fs.writeFileSync(configPath, content);
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('bmad-manifest:read', (event) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return null;
  const manifestPath = path.join(projectPath, '_bmad', '_config', 'manifest.yaml');
  try {
    if (!fs.existsSync(manifestPath)) return null;
    const content = fs.readFileSync(manifestPath, 'utf-8');
    const manifest = {};
    content.split('\n').forEach(line => {
      const match = line.match(/^(\w[\w_]*)\s*:\s*(.+)$/);
      if (match) {
        let val = match[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        manifest[match[1]] = val;
      }
    });
    return manifest;
  } catch {
    return null;
  }
});

// ── IPC: Project Archiving ────────────────────────────────────────────────

ipcMain.handle('project:archive', (_, projectPath) => {
  const prefs = loadPrefs();
  if (!Array.isArray(prefs.projects)) return false;
  const project = prefs.projects.find(p => p.path === projectPath);
  if (project) {
    project.archived = true;
    savePrefs(prefs);
  }
  return true;
});

ipcMain.handle('project:unarchive', (_, projectPath) => {
  const prefs = loadPrefs();
  if (!Array.isArray(prefs.projects)) return false;
  const project = prefs.projects.find(p => p.path === projectPath);
  if (project) {
    project.archived = false;
    savePrefs(prefs);
  }
  return true;
});

// ── File Versioning ──────────────────────────────────────────────────────

const MAX_VERSIONS_PER_FILE = 20;
const VERSIONS_FILE = path.join(app.getPath('userData'), 'file-versions.json');

function loadVersionsDb() {
  try {
    if (fs.existsSync(VERSIONS_FILE)) return JSON.parse(fs.readFileSync(VERSIONS_FILE, 'utf-8'));
  } catch { /* ignore */ }
  return {};
}

function saveVersionsDb(db) {
  const dir = path.dirname(VERSIONS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(VERSIONS_FILE, JSON.stringify(db));
}

function saveVersion(filePath, content) {
  const db = loadVersionsDb();
  if (!db[filePath]) db[filePath] = [];
  db[filePath].unshift({
    savedAt: new Date().toISOString(),
    content
  });
  // Trim to max versions
  if (db[filePath].length > MAX_VERSIONS_PER_FILE) {
    db[filePath] = db[filePath].slice(0, MAX_VERSIONS_PER_FILE);
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

// ── Helpers ──────────────────────────────────────────────────────────────

function loadProject(projectPath, event) {
  currentProjectPath = projectPath;

  // Track per-window project path
  if (event) {
    setWindowProjectPath(event, projectPath);
  }

  const prefs = loadPrefs();
  prefs.lastProjectPath = projectPath;

  // Maintain a project list with name + path
  if (!Array.isArray(prefs.projects)) prefs.projects = [];
  const name = path.basename(projectPath);
  const existing = prefs.projects.findIndex(p => p.path === projectPath);
  const now = new Date().toISOString();
  if (existing !== -1) {
    const proj = prefs.projects[existing];
    proj.lastOpenedAt = now;
    // Move to top (most recently used)
    prefs.projects.splice(existing, 1);
    prefs.projects.unshift(proj);
  } else {
    prefs.projects.unshift({ name, path: projectPath, archived: false, addedAt: now, lastOpenedAt: now });
  }
  savePrefs(prefs);

  // Migrate legacy session history from global prefs to per-project file
  migrateSessionHistory(projectPath);

  const data = scanProject(projectPath);

  // Set title on the calling window, or fallback to mainWindow
  const win = event ? getWindowFromEvent(event) : mainWindow;
  if (win && !win.isDestroyed()) {
    win.setTitle(`BMAD Board — ${name}`);
  }
  return data;
}
