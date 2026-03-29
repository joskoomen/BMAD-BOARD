/** @file main.js — Electron main process for BMAD Board.
 *
 * Responsibilities:
 *  - Application lifecycle (window creation, menu, app events)
 *  - IPC handler registration for all renderer ↔ main communication
 *  - Project management (open, scan, list, persist MRU)
 *  - Per-project session history (load, save, migrate from legacy global storage)
 *  - File versioning (automatic snapshots before overwrites)
 *  - Embedded PTY terminal management via node-pty
 *  - External terminal/LLM launcher integration
 *  - Companion HTTP/WebSocket server lifecycle
 *  - Git operations via GitManager
 *  - User preference persistence (userData/preferences.json)
 */
const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Menu } = require('electron');
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

/** Load preferences from the userData JSON file. */
function loadPrefs() {
  try {
    if (fs.existsSync(PREFS_FILE)) return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf-8'));
  } catch { /* ignore */ }
  return {};
}

/** Persist preferences to the userData JSON file.
 * @param {Object} prefs - The preferences object to save.
 */
function savePrefs(prefs) {
  const dir = path.dirname(PREFS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2));
}

/** Create and configure a new BrowserWindow.
 * @returns {BrowserWindow} The newly created window.
 */
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

  const webContentsId = win.webContents.id;
  win.on('closed', () => {
    windowProjectPaths.delete(webContentsId);
  });

  // Keep mainWindow pointing to latest for backward compat
  mainWindow = win;
  return win;
}

/** Get the project path associated with the IPC event's window.
 * @param {Electron.IpcMainInvokeEvent} event
 * @returns {string|null}
 */
function getWindowProjectPath(event) {
  return windowProjectPaths.get(event.sender.id) || currentProjectPath;
}

/** Associate a project path with the IPC event's window.
 * @param {Electron.IpcMainInvokeEvent} event
 * @param {string} projectPath
 */
function setWindowProjectPath(event, projectPath) {
  windowProjectPaths.set(event.sender.id, projectPath);
  // Keep global in sync for backward compat
  currentProjectPath = projectPath;
}

/** Get the BrowserWindow instance from an IPC event.
 * @param {Electron.IpcMainInvokeEvent} event
 * @returns {BrowserWindow}
 */
function getWindowFromEvent(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

app.whenReady().then(async () => {
  // Build application menu with keyboard shortcuts
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => createWindow()
        },
        {
          label: 'New Terminal Tab',
          accelerator: 'CmdOrCtrl+T',
          click: (_, win) => {
            if (win && !win.isDestroyed()) {
              win.webContents.send('new-terminal-tab');
            }
          }
        },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: (_, win) => {
            if (win && !win.isDestroyed()) {
              win.webContents.send('close-active-tab');
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click: (_, win) => {
            if (win && !win.isDestroyed()) {
              win.webContents.send('show-settings');
            }
          }
        },
        { type: 'separator' },
        ...(isMac ? [{ role: 'close' }] : [{ role: 'quit' }])
      ]
    },
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
      { role: 'selectAll' }
    ]},
    { label: 'View', submenu: [
      { role: 'reload' }, { role: 'forceReload' },
      { role: 'toggleDevTools' }, { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' }, { role: 'togglefullscreen' }
    ]},
    { label: 'Window', submenu: [
      { role: 'minimize' }, { role: 'zoom' },
      ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [])
    ]}
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  createWindow();
  await startCompanionServer();
});

/** Initialize and start the companion HTTP/WS server if enabled in preferences. */
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
    },
    launchOnDesktop: (command, storySlug, phase) => {
      // Send to the most recently focused window's renderer
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) {
        win.webContents.send('companion-launch-command', { command, storySlug, phase });
        // Bring window to front
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    }
  });

  // Restore persisted token if available
  if (prefs.settings?.companion?.token) {
    companionServer.token = prefs.settings.companion.token;
  }

  try {
    await companionServer.start(port);
    companionHeartbeat = startHeartbeat(companionServer);
    // Persist token for future sessions
    prefs.settings = prefs.settings || {};
    prefs.settings.companion = prefs.settings.companion || {};
    prefs.settings.companion.token = companionServer.token;
    savePrefs(prefs);
    console.log('[companion] Server started successfully');
  } catch (err) {
    console.error('[companion] Failed to start server:', err.message);
    companionServer = null;
    companionHeartbeat = null;
  }
}

// ── Story Status Update in YAML ────────────────────────────────────────

/** Update a story's phase in sprint-status.yaml.
 * @param {string} projectPath - Root path of the project.
 * @param {string} slug - The story slug identifier.
 * @param {string} newPhase - The new phase value to set.
 */
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

// ── IPC: App ──────────────────────────────────────────────────────────────

/** Return the current application version string. */
ipcMain.handle('get-app-version', () => app.getVersion());

/** Open a new BrowserWindow and return true. */
ipcMain.handle('new-window', () => {
  createWindow();
  return true;
});

app.on('window-all-closed', () => {
  terminalManager.killAll();
  if (companionHeartbeat) clearInterval(companionHeartbeat);
  companionHeartbeat = null;
  if (companionServer) companionServer.stop();
  companionServer = null;
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  // Restart companion server if it was cleaned up
  if (!companionServer) {
    await startCompanionServer();
  }
});

// ── IPC: Project Management ──────────────────────────────────────────────

/** Show a directory picker and load the selected project. Returns scanned project data or null. */
ipcMain.handle('open-project', async (event) => {
  const win = getWindowFromEvent(event);
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    message: 'Select a project folder with BMAD files'
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return loadProject(result.filePaths[0], event);
});

/** Load the most recently opened project from preferences. Returns scanned data or null. */
ipcMain.handle('load-last-project', (event) => {
  const prefs = loadPrefs();
  if (prefs.lastProjectPath && fs.existsSync(prefs.lastProjectPath)) {
    return loadProject(prefs.lastProjectPath, event);
  }
  return null;
});

/** Re-scan the current window's project and return fresh BMAD data. */
ipcMain.handle('scan-project', (event) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return null;
  return scanProject(projectPath);
});

/** Read a file from disk and return its UTF-8 contents, or null on error.
 * @param {string} filePath - Absolute path to the file.
 */
ipcMain.handle('read-file', (_, filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
});

/** Write content to a file, creating a version snapshot if the content changed.
 * @param {string} filePath - Absolute path to the file.
 * @param {string} content - New file content to write.
 * @returns {{success: boolean}|{error: string}}
 */
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

/** Return all saved version snapshots for a file.
 * @param {string} filePath - Absolute path to the file.
 */
ipcMain.handle('get-file-versions', (_, filePath) => {
  return getVersions(filePath);
});

/** Restore a previously saved version of a file by index, snapshotting the current content first.
 * @param {string} filePath - Absolute path to the file.
 * @param {number} versionIndex - Zero-based index into the saved versions array.
 * @returns {{success: boolean, content: string}|{error: string}}
 */
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

// ── IPC: Terminal / Claude Commands (External) ───────────────────────────

/** Build and launch an LLM phase command in an external terminal.
 * @param {{phase: string, storySlug: string, storyFilePath: string}} args
 * @returns {{success: boolean, command: string}|{error: string}}
 */
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

/** Launch all stories in party mode using the LLM launcher.
 * @returns {{success: boolean}|{error: string}}
 */
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

/** Open an external terminal window, optionally running a command on launch.
 * @param {string} [command] - Shell command to run on open.
 * @returns {{success: boolean}|{error: string}}
 */
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

/** Create a new PTY session in the current project directory.
 * @param {{cols: number, rows: number}} dimensions - Initial terminal dimensions.
 * @returns {{id: string}} The new session identifier.
 */
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

/** Forward keyboard input data to a PTY session.
 * @param {{id: string, data: string}} payload
 */
ipcMain.on('terminal:input', (_, { id, data }) => {
  terminalManager.write(id, data);
});

/** Resize a PTY session to new column/row dimensions.
 * @param {{id: string, cols: number, rows: number}} payload
 */
ipcMain.on('terminal:resize', (_, { id, cols, rows }) => {
  terminalManager.resize(id, cols, rows);
});

/** Kill a PTY session by ID.
 * @param {{id: string}} payload
 * @returns {{success: boolean}}
 */
ipcMain.handle('terminal:kill', (_, { id }) => {
  terminalManager.kill(id);
  return { success: true };
});

// ── IPC: Project / Preferences Helpers ───────────────────────────────────

/** Return the project path currently associated with the calling window. */
ipcMain.handle('get-project-path', (event) => {
  return getWindowProjectPath(event);
});

/** Return the MRU project list, filtering out directories that no longer exist. */
ipcMain.handle('get-project-list', () => {
  const prefs = loadPrefs();
  const projects = Array.isArray(prefs.projects) ? prefs.projects : [];
  // Filter out projects whose directories no longer exist
  return projects.filter(p => fs.existsSync(p.path));
});

/** Load a project by an explicit path. Returns scanned data, or null if the path is invalid.
 * @param {string} projectPath - Absolute path to the project root.
 */
ipcMain.handle('load-project-by-path', (event, projectPath) => {
  if (!projectPath || !fs.existsSync(projectPath)) return null;
  return loadProject(projectPath, event);
});

/** Remove a project entry from the MRU list in preferences.
 * @param {string} projectPath - Path of the project to remove.
 * @returns {Array} Updated project list.
 */
ipcMain.handle('remove-project-from-list', (_, projectPath) => {
  const prefs = loadPrefs();
  if (!Array.isArray(prefs.projects)) return;
  prefs.projects = prefs.projects.filter(p => p.path !== projectPath);
  savePrefs(prefs);
  return prefs.projects;
});

/** Return persisted quick-action definitions, or null to indicate defaults should be used. */
ipcMain.handle('get-quick-actions', () => {
  const prefs = loadPrefs();
  return prefs.quickActions || null; // null = use defaults
});

/** Persist custom quick-action definitions to preferences.
 * @param {Array} actions - Array of quick-action definition objects.
 */
ipcMain.handle('save-quick-actions', (_, actions) => {
  const prefs = loadPrefs();
  prefs.quickActions = actions;
  savePrefs(prefs);
  return true;
});

/** Open a URL in the system's default browser.
 * @param {string} url - The URL to open externally.
 */
ipcMain.handle('open-external', (_, url) => {
  shell.openExternal(url);
});

/** Retrieve the persisted Claude session ID for a story/phase pair.
 * @param {string} storySlug - Unique story slug identifier.
 * @param {string} phase - Story phase name.
 * @returns {string|null} Stored session ID, or null if not found.
 */
ipcMain.handle('get-story-session', (_, storySlug, phase) => {
  const prefs = loadPrefs();
  if (!prefs.storySessions) return null;
  return prefs.storySessions[`${storySlug}:${phase}`] || null;
});

/** Persist a Claude session ID for a story/phase pair.
 * @param {string} storySlug - Unique story slug identifier.
 * @param {string} phase - Story phase name.
 * @param {string} sessionId - The Claude session ID to persist.
 * @returns {boolean} Always true on success.
 */
ipcMain.handle('save-story-session', (_, storySlug, phase, sessionId) => {
  const prefs = loadPrefs();
  if (!prefs.storySessions) prefs.storySessions = {};
  prefs.storySessions[`${storySlug}:${phase}`] = sessionId;
  savePrefs(prefs);
  return true;
});

// ── IPC: Session History ─────────────────────────────────────────────────
// Per-project history is stored in <project>/.bmad-board/session-history.json

/** Get the per-project session history file path.
 * @param {string} projectPath
 * @returns {string}
 */
function getProjectHistoryPath(projectPath) {
  return path.join(projectPath, '.bmad-board', 'session-history.json');
}

/** Migrate legacy global session history entries to the per-project file.
 * @param {string} projectPath
 */
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

/** Load session history entries for a project.
 * @param {string} projectPath
 * @returns {Array}
 */
function loadProjectHistory(projectPath) {
  if (!projectPath) return [];
  const histFile = getProjectHistoryPath(projectPath);
  try {
    if (fs.existsSync(histFile)) return JSON.parse(fs.readFileSync(histFile, 'utf-8'));
  } catch { /* ignore */ }
  return [];
}

/** Save session history entries for a project.
 * @param {string} projectPath
 * @param {Array} history
 */
function saveProjectHistory(projectPath, history) {
  if (!projectPath) return;
  const histFile = getProjectHistoryPath(projectPath);
  const dir = path.dirname(histFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(histFile, JSON.stringify(history, null, 2));
}

/** Upsert a session history entry for the current project (max 20 entries kept).
 * @param {Object} entry - Session history entry object (id, command, claudeSessionId, etc.).
 * @returns {boolean} Always true on success.
 */
ipcMain.handle('session-history:save', (event, entry) => {
  const projectPath = getWindowProjectPath(event);
  const history = loadProjectHistory(projectPath);

  entry.createdAt = entry.createdAt || new Date().toISOString();
  entry.projectPath = entry.projectPath || projectPath;
  entry.projectName = entry.projectName || (projectPath ? path.basename(projectPath) : 'Unknown');

  // Check for existing entry with same claudeSessionId or same command
  const existingIdx = history.findIndex(h =>
    (entry.claudeSessionId && h.claudeSessionId === entry.claudeSessionId) ||
    (!entry.claudeSessionId && entry.command && h.command === entry.command)
  );

  if (existingIdx !== -1) {
    // Update existing entry and move to top
    const existing = history.splice(existingIdx, 1)[0];
    existing.createdAt = entry.createdAt;
    if (entry.claudeSessionId) existing.claudeSessionId = entry.claudeSessionId;
    history.unshift(existing);
  } else {
    // Prepend new entry (most recent first)
    history.unshift(entry);
  }

  // Keep max 20 entries
  if (history.length > 20) history.length = 20;

  saveProjectHistory(projectPath, history);
  return true;
});

/** Return all session history entries for the current project.
 * @returns {Array} Array of session history entry objects.
 */
ipcMain.handle('session-history:get', (event) => {
  const projectPath = getWindowProjectPath(event);
  return loadProjectHistory(projectPath);
});

/** Remove a single session history entry by ID.
 * @param {string} entryId - The unique ID of the entry to remove.
 * @returns {Array} Updated history array.
 */
ipcMain.handle('session-history:remove', (event, entryId) => {
  const projectPath = getWindowProjectPath(event);
  const history = loadProjectHistory(projectPath).filter(e => e.id !== entryId);
  saveProjectHistory(projectPath, history);
  return history;
});

/** Clear all session history entries for the current project.
 * @returns {Array} Empty array.
 */
ipcMain.handle('session-history:clear', (event) => {
  const projectPath = getWindowProjectPath(event);
  saveProjectHistory(projectPath, []);
  return [];
});

// ── Per-project tab state (.bmad-board/tab-state.json) ───────────────────

function getTabStatePath(projectPath) {
  return path.join(projectPath, '.bmad-board', 'tab-state.json');
}

function loadTabState(projectPath) {
  if (!projectPath) return null;
  try {
    const filePath = getTabStatePath(projectPath);
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch { /* ignore */ }
  return null;
}

function saveTabStateToDisk(projectPath, state) {
  if (!projectPath) return;
  const filePath = getTabStatePath(projectPath);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

ipcMain.handle('tab-state:save', (event, tabState) => {
  const projectPath = getWindowProjectPath(event);
  saveTabStateToDisk(projectPath, tabState);
  return true;
});

ipcMain.handle('tab-state:get', (event) => {
  const projectPath = getWindowProjectPath(event);
  return loadTabState(projectPath);
});

// ── IPC: Settings ─────────────────────────────────────────────────────────

/** Return the current application settings, falling back to hardcoded defaults.
 * @returns {Object} Settings object including LLM config, terminal, and notification options.
 */
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

/** Persist the full settings object to preferences.
 * @param {Object} settings - Settings object to save.
 * @returns {boolean} Always true on success.
 */
ipcMain.handle('settings:save', (_, settings) => {
  const prefs = loadPrefs();
  prefs.settings = settings;
  savePrefs(prefs);
  return true;
});

/** Return the list of available LLM provider descriptors.
 * @returns {Array} Provider list from llm-providers module.
 */
ipcMain.handle('settings:get-providers', () => {
  return getProviderList();
});

// ── IPC: Companion Server ──────────────────────────────────────────────

/** Return connection info for the companion server, or {enabled: false} if stopped.
 * @returns {{enabled: boolean, port?: number, token?: string}}
 */
ipcMain.handle('companion:get-info', () => {
  if (!companionServer) return { enabled: false };
  return {
    enabled: true,
    ...companionServer.getConnectionInfo()
  };
});

/** Enable or disable the companion server, starting/stopping it as needed.
 * @param {boolean} enabled - Whether the companion server should be running.
 * @returns {boolean} The new enabled state.
 */
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

/** Rotate the companion server auth token and persist the new value.
 * @returns {Object|null} Updated connection info, or null if the server is not running.
 */
ipcMain.handle('companion:regenerate-token', () => {
  if (!companionServer) return null;
  companionServer.rotateToken();
  // Persist the new token
  const prefs = loadPrefs();
  if (!prefs.settings) prefs.settings = {};
  if (!prefs.settings.companion) prefs.settings.companion = {};
  prefs.settings.companion.token = companionServer.token;
  savePrefs(prefs);
  return companionServer.getConnectionInfo();
});

/** Show a native OS notification; clicking it focuses the calling window.
 * @param {{title: string, body: string}} payload - Notification title and body text.
 * @returns {boolean} True if notifications are supported and shown, false otherwise.
 */
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

/** Read and parse the project's _bmad/bmm/config.yaml as a flat key/value object.
 * @returns {Object|null} Parsed config, or null if the file does not exist or an error occurs.
 */
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

/** Apply key/value updates to _bmad/bmm/config.yaml, preserving file formatting.
 * @param {Object} updates - Map of config keys to their new values.
 * @returns {{success: boolean}|{error: string}}
 */
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

/** Read and parse _bmad/_config/manifest.yaml as a flat key/value object.
 * @returns {Object|null} Parsed manifest, or null if the file does not exist or an error occurs.
 */
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

/** Mark a project as archived in the MRU list.
 * @param {string} projectPath - Absolute path of the project to archive.
 * @returns {boolean} True on success, false if the project list is absent.
 */
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

/** Clear the archived flag on a project in the MRU list.
 * @param {string} projectPath - Absolute path of the project to unarchive.
 * @returns {boolean} True on success, false if the project list is absent.
 */
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

// ── IPC: Git ────────────────────────────────────────────────────────────
// All git handlers delegate to a per-call GitManager(projectPath) instance.

const { GitManager } = require('./lib/git-manager');

/** Check whether the current project directory is inside a git repository.
 * @returns {boolean}
 */
ipcMain.handle('git:is-repo', async (event) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return false;
  const gm = new GitManager(projectPath);
  return gm.isRepo();
});

/** Return the current git working-tree status (staged, unstaged, untracked files).
 * @returns {Object|{error: string}}
 */
ipcMain.handle('git:status', async (event) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  return gm.status();
});

/** List all local and remote branches with current-branch indicator.
 * @returns {Object|{error: string}}
 */
ipcMain.handle('git:branches', async (event) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  return gm.branches();
});

/** Return the commit log for the current branch.
 * @param {number} [limit=25] - Maximum number of commits to return.
 * @returns {Array|{error: string}}
 */
ipcMain.handle('git:log', async (event, limit) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  return gm.log(limit || 25);
});

/** Checkout an existing branch.
 * @param {string} branch - Branch name to switch to.
 * @returns {Object|{error: string}}
 */
ipcMain.handle('git:checkout', async (event, branch) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  return gm.checkout(branch);
});

/** Create a new branch, optionally from a specific start point.
 * @param {string} name - New branch name.
 * @param {string} [startPoint] - Commit/branch to branch from (defaults to HEAD).
 * @returns {Object|{error: string}}
 */
ipcMain.handle('git:create-branch', async (event, name, startPoint) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  return gm.createBranch(name, startPoint);
});

/** Fetch from all remotes.
 * @returns {{ok: boolean}|{error: string}}
 */
ipcMain.handle('git:fetch', async (event) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  await gm.fetch();
  return { ok: true };
});

/** Pull from a remote branch.
 * @param {string} [remote] - Remote name (e.g. 'origin').
 * @param {string} [branch] - Branch name to pull.
 * @returns {Object|{error: string}}
 */
ipcMain.handle('git:pull', async (event, remote, branch) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  return gm.pull(remote, branch);
});

/** Push the current branch to a remote.
 * @param {string} [remote] - Remote name (e.g. 'origin').
 * @param {string} [branch] - Branch name to push.
 * @returns {{ok: boolean}|{error: string}}
 */
ipcMain.handle('git:push', async (event, remote, branch) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  await gm.push(remote, branch);
  return { ok: true };
});

/** Merge a branch into the current branch.
 * @param {string} branch - Branch name to merge in.
 * @returns {Object|{error: string}}
 */
ipcMain.handle('git:merge', async (event, branch) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  return gm.merge(branch);
});

/** Abort an in-progress merge.
 * @returns {{ok: boolean}|{error: string}}
 */
ipcMain.handle('git:abort-merge', async (event) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  await gm.abortMerge();
  return { ok: true };
});

// ── IPC: Git — Tags ──────────────────────────────────────────────────────

/** List all git tags in the repository.
 * @returns {Array}
 */
ipcMain.handle('git:tags', async (event) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return [];
  const gm = new GitManager(projectPath);
  return gm.tags();
});

/** Create an annotated (or lightweight) tag.
 * @param {string} name - Tag name.
 * @param {string} [message] - Annotation message; omit for a lightweight tag.
 * @returns {{ok: boolean}|{error: string}}
 */
ipcMain.handle('git:create-tag', async (event, name, message) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  await gm.createTag(name, message);
  return { ok: true };
});

/** Delete a local tag.
 * @param {string} name - Tag name to delete.
 * @returns {{ok: boolean}|{error: string}}
 */
ipcMain.handle('git:delete-tag', async (event, name) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  await gm.deleteTag(name);
  return { ok: true };
});

/** Push a single tag to the remote.
 * @param {string} name - Tag name to push.
 * @returns {{ok: boolean}|{error: string}}
 */
ipcMain.handle('git:push-tag', async (event, name) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  await gm.pushTag(name);
  return { ok: true };
});

/** Push all local tags to the remote.
 * @returns {{ok: boolean}|{error: string}}
 */
ipcMain.handle('git:push-all-tags', async (event) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  await gm.pushAllTags();
  return { ok: true };
});

// ── IPC: Git — Staging & Diff ────────────────────────────────────────────

/** Open the configured git merge tool for a conflicted file.
 * @param {string} file - Relative path of the conflicted file.
 * @returns {{ok: boolean}|{error: string}}
 */
ipcMain.handle('git:open-merge-tool', async (event, file) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  try {
    await gm.openMergeTool(file);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

/** Stage specific files.
 * @param {string[]} files - Array of relative file paths to stage.
 * @returns {{ok: boolean}|{error: string}}
 */
ipcMain.handle('git:stage', async (event, files) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  await gm.stage(files);
  return { ok: true };
});

/** Stage all modified and untracked files.
 * @returns {{ok: boolean}|{error: string}}
 */
ipcMain.handle('git:stage-all', async (event) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  await gm.stageAll();
  return { ok: true };
});

/** Unstage specific files (reset HEAD).
 * @param {string[]} files - Array of relative file paths to unstage.
 * @returns {{ok: boolean}|{error: string}}
 */
ipcMain.handle('git:unstage', async (event, files) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  await gm.unstage(files);
  return { ok: true };
});

/** Return the combined unstaged diff for all modified files.
 * @returns {string|{error: string}}
 */
ipcMain.handle('git:diff', async (event) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  return gm.diff();
});

/** Return the diff for a single file (staged or unstaged).
 * @param {string} file - Relative path of the file.
 * @param {boolean} [staged=false] - If true, diff against the index; otherwise against the working tree.
 * @returns {string|{error: string}}
 */
ipcMain.handle('git:diff-file', async (event, file, staged) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  return gm.diffFile(file, staged);
});

/** Create a commit with the given message from currently staged changes.
 * @param {string} message - Commit message.
 * @returns {Object|{error: string}}
 */
ipcMain.handle('git:commit', async (event, message) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  return gm.commit(message);
});

/** Check whether the GitHub CLI (`gh`) is available on PATH.
 * @returns {boolean}
 */
ipcMain.handle('git:has-gh-cli', async (event) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return false;
  const gm = new GitManager(projectPath);
  return gm.hasGhCli();
});

/** Return the URL of the default remote (origin).
 * @returns {string|null}
 */
ipcMain.handle('git:remote-url', async (event) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return null;
  const gm = new GitManager(projectPath);
  return gm.getRemoteUrl();
});

// ── IPC: Git — Stash ─────────────────────────────────────────────────────

/** List all stash entries.
 * @returns {Array}
 */
ipcMain.handle('git:stash-list', async (event) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return [];
  const gm = new GitManager(projectPath);
  return gm.stashList();
});

/** Stash current changes with an optional message.
 * @param {string} [message] - Optional stash description.
 * @returns {Object|{error: string}}
 */
ipcMain.handle('git:stash', async (event, message) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  return gm.stash(message);
});

/** Apply and remove a stash entry by index.
 * @param {number} index - Stash list index (0 = most recent).
 * @returns {Object|{error: string}}
 */
ipcMain.handle('git:stash-pop', async (event, index) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  return gm.stashPop(index);
});

/** Drop (delete) a stash entry by index without applying it.
 * @param {number} index - Stash list index to drop.
 * @returns {Object|{error: string}}
 */
ipcMain.handle('git:stash-drop', async (event, index) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  return gm.stashDrop(index);
});

// ── IPC: Git — Branch Management ─────────────────────────────────────────

/** Delete a local branch.
 * @param {string} name - Branch name to delete.
 * @param {boolean} [force=false] - Force-delete even if not merged.
 * @returns {Object|{error: string}}
 */
ipcMain.handle('git:delete-branch', async (event, name, force) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  return gm.deleteBranch(name, force);
});

/** Delete a branch on the remote (push delete).
 * @param {string} name - Remote branch name to delete.
 * @returns {Object|{error: string}}
 */
ipcMain.handle('git:delete-remote-branch', async (event, name) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  return gm.deleteRemoteBranch(name);
});

// ── IPC: Git — Commit Detail ─────────────────────────────────────────────

/** Return the full detail (metadata + changed files) for a commit.
 * @param {string} hash - Full or abbreviated commit hash.
 * @returns {Object|{error: string}}
 */
ipcMain.handle('git:show-commit', async (event, hash) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  return gm.showCommit(hash);
});

/** Return the unified diff for an entire commit.
 * @param {string} hash - Commit hash.
 * @returns {string|{error: string}}
 */
ipcMain.handle('git:commit-diff', async (event, hash) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  return gm.commitDiff(hash);
});

/** Return the diff for a single file within a specific commit.
 * @param {string} hash - Commit hash.
 * @param {string} file - Relative path of the file within the repo.
 * @returns {string|{error: string}}
 */
ipcMain.handle('git:commit-file-diff', async (event, hash, file) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  return gm.commitFileDiff(hash, file);
});

// ── IPC: Git — Discard & Amend ───────────────────────────────────────────

/** Discard unstaged changes to a single file (restore from HEAD).
 * @param {string} file - Relative path of the file to restore.
 * @returns {Object|{error: string}}
 */
ipcMain.handle('git:discard-file', async (event, file) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  return gm.discardFile(file);
});

/** Discard all unstaged changes in the working tree (hard reset to HEAD).
 * @returns {Object|{error: string}}
 */
ipcMain.handle('git:discard-all', async (event) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  return gm.discardAll();
});

/** Amend the most recent commit, optionally updating its message.
 * @param {string} [message] - New commit message; omit to keep the current message.
 * @returns {Object|{error: string}}
 */
ipcMain.handle('git:amend', async (event, message) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  return gm.amend(message);
});

// ── IPC: Git — Revert & Rebase ───────────────────────────────────────────

/** Create a revert commit that undoes the changes introduced by a specific commit.
 * @param {string} hash - Commit hash to revert.
 * @returns {Object|{error: string}}
 */
ipcMain.handle('git:revert', async (event, hash) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  return gm.revert(hash);
});

/** Rebase the current branch onto another branch.
 * @param {string} branch - Target branch to rebase onto.
 * @returns {Object|{error: string}}
 */
ipcMain.handle('git:rebase', async (event, branch) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  return gm.rebase(branch);
});

/** Abort an in-progress rebase and restore the pre-rebase state.
 * @returns {Object|{error: string}}
 */
ipcMain.handle('git:rebase-abort', async (event) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  return gm.rebaseAbort();
});

/** Continue a paused rebase after resolving conflicts.
 * @returns {Object|{error: string}}
 */
ipcMain.handle('git:rebase-continue', async (event) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  return gm.rebaseContinue();
});

/** Check whether a rebase is currently in progress.
 * @returns {boolean}
 */
ipcMain.handle('git:is-rebasing', async (event) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return false;
  const gm = new GitManager(projectPath);
  return gm.isRebasing();
});

// ── IPC: Git — File History & Conflict Resolution ────────────────────────

/** Return the commit history for a single file.
 * @param {string} file - Relative file path.
 * @param {number} [limit=25] - Maximum number of log entries to return.
 * @returns {Array}
 */
ipcMain.handle('git:file-log', async (event, file, limit) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return [];
  const gm = new GitManager(projectPath);
  return gm.fileLog(file, limit);
});

/** Read a conflicted file and parse its conflict markers into structured sections.
 * @param {string} file - Relative path of the conflicted file.
 * @returns {Object|{error: string}}
 */
ipcMain.handle('git:read-conflict-file', async (event, file) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  return gm.readConflictFile(file);
});

/** Write resolved content to a previously conflicted file and stage it.
 * @param {string} file - Relative path of the file.
 * @param {string} content - Resolved file content to write.
 * @returns {Object|{error: string}}
 */
ipcMain.handle('git:resolve-conflict', async (event, file, content) => {
  const projectPath = getWindowProjectPath(event);
  if (!projectPath) return { error: 'No project loaded' };
  const gm = new GitManager(projectPath);
  return gm.resolveConflict(file, content);
});

// ── File Versioning ──────────────────────────────────────────────────────

const MAX_VERSIONS_PER_FILE = 20;
const VERSIONS_FILE = path.join(app.getPath('userData'), 'file-versions.json');

/** Load the file versioning database from disk.
 * @returns {Object}
 */
function loadVersionsDb() {
  try {
    if (fs.existsSync(VERSIONS_FILE)) return JSON.parse(fs.readFileSync(VERSIONS_FILE, 'utf-8'));
  } catch { /* ignore */ }
  return {};
}

/** Persist the file versioning database to disk.
 * @param {Object} db
 */
function saveVersionsDb(db) {
  const dir = path.dirname(VERSIONS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(VERSIONS_FILE, JSON.stringify(db));
}

/** Save a version snapshot of a file before overwriting.
 * @param {string} filePath - Absolute path to the file.
 * @param {string} content - The file content to snapshot.
 */
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

/** Get all saved versions of a file.
 * @param {string} filePath - Absolute path to the file.
 * @returns {Array<{index: number, savedAt: string, content: string, preview: string}>}
 */
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

/** Load a project: set paths, update prefs, scan BMAD files, and set window title.
 * @param {string} projectPath - Root path of the project to load.
 * @param {Electron.IpcMainInvokeEvent} [event] - IPC event for per-window tracking.
 * @returns {Object} Scanned project data.
 */
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
