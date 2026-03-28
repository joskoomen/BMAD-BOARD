/**
 * Preload script — exposes a safe `window.api` bridge between the
 * renderer process and main process via Electron's contextBridge.
 *
 * Each method maps to an ipcMain handler in main.js.
 * Grouped by domain: project, settings, BMAD config, session history,
 * terminal, and companion server.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // App
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // Window
  newWindow: () => ipcRenderer.invoke('new-window'),

  // Project
  openProject: () => ipcRenderer.invoke('open-project'),
  loadLastProject: () => ipcRenderer.invoke('load-last-project'),
  scanProject: () => ipcRenderer.invoke('scan-project'),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('write-file', filePath, content),
  getFileVersions: (filePath) => ipcRenderer.invoke('get-file-versions', filePath),
  restoreFileVersion: (filePath, versionIndex) => ipcRenderer.invoke('restore-file-version', filePath, versionIndex),
  getProjectPath: () => ipcRenderer.invoke('get-project-path'),
  getProjectList: () => ipcRenderer.invoke('get-project-list'),
  loadProjectByPath: (path) => ipcRenderer.invoke('load-project-by-path', path),
  removeProjectFromList: (path) => ipcRenderer.invoke('remove-project-from-list', path),
  getQuickActions: () => ipcRenderer.invoke('get-quick-actions'),
  saveQuickActions: (actions) => ipcRenderer.invoke('save-quick-actions', actions),
  showNotification: (opts) => ipcRenderer.invoke('show-notification', opts),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getStorySession: (storySlug, phase) => ipcRenderer.invoke('get-story-session', storySlug, phase),
  saveStorySession: (storySlug, phase, sessionId) => ipcRenderer.invoke('save-story-session', storySlug, phase, sessionId),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  getProviders: () => ipcRenderer.invoke('settings:get-providers'),

  // BMAD Config
  readBmadConfig: () => ipcRenderer.invoke('bmad-config:read'),
  writeBmadConfig: (updates) => ipcRenderer.invoke('bmad-config:write', updates),
  readBmadManifest: () => ipcRenderer.invoke('bmad-manifest:read'),

  // Project archiving
  archiveProject: (path) => ipcRenderer.invoke('project:archive', path),
  unarchiveProject: (path) => ipcRenderer.invoke('project:unarchive', path),

  // Tab State (per-project persistence)
  saveTabState: (state) => ipcRenderer.invoke('tab-state:save', state),
  getTabState: () => ipcRenderer.invoke('tab-state:get'),

  // Session History
  saveSessionHistory: (entry) => ipcRenderer.invoke('session-history:save', entry),
  getSessionHistory: () => ipcRenderer.invoke('session-history:get'),
  removeSessionHistory: (entryId) => ipcRenderer.invoke('session-history:remove', entryId),
  clearSessionHistory: () => ipcRenderer.invoke('session-history:clear'),

  // Terminal / Claude (external)
  launchPhaseCommand: (opts) => ipcRenderer.invoke('launch-phase-command', opts),
  launchPartyMode: () => ipcRenderer.invoke('launch-party-mode'),
  openTerminal: (command) => ipcRenderer.invoke('open-terminal', command),

  // Companion Server
  getCompanionInfo: () => ipcRenderer.invoke('companion:get-info'),
  toggleCompanion: (enabled) => ipcRenderer.invoke('companion:toggle', enabled),
  regenerateCompanionToken: () => ipcRenderer.invoke('companion:regenerate-token'),

  // Embedded Terminal (PTY)
  terminalCreate: (opts) => ipcRenderer.invoke('terminal:create', opts || {}),
  terminalInput: (id, data) => ipcRenderer.send('terminal:input', { id, data }),
  terminalResize: (id, cols, rows) => ipcRenderer.send('terminal:resize', { id, cols, rows }),
  terminalKill: (id) => ipcRenderer.invoke('terminal:kill', { id }),
  onTerminalData: (callback) => {
    const handler = (_, payload) => callback(payload.id, payload.data);
    ipcRenderer.on('terminal:data', handler);
    return () => ipcRenderer.removeListener('terminal:data', handler);
  },
  onTerminalExit: (callback) => {
    const handler = (_, payload) => callback(payload.id, payload.exitCode);
    ipcRenderer.on('terminal:exit', handler);
    return () => ipcRenderer.removeListener('terminal:exit', handler);
  },

  // Menu events
  onCloseActiveTab: (callback) => {
    ipcRenderer.on('close-active-tab', callback);
    return () => ipcRenderer.removeListener('close-active-tab', callback);
  },
  onNewTerminalTab: (callback) => {
    ipcRenderer.on('new-terminal-tab', callback);
    return () => ipcRenderer.removeListener('new-terminal-tab', callback);
  },
  onShowSettings: (callback) => {
    ipcRenderer.on('show-settings', callback);
    return () => ipcRenderer.removeListener('show-settings', callback);
  }
});
