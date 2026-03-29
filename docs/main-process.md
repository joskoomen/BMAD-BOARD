# Main Process (main.js)

The main process is the entry point of the Electron application. It manages windows, handles IPC requests from the renderer, and coordinates all Node.js-side operations.

## Responsibilities

- **Window Management** — Create and track BrowserWindow instances
- **IPC Handler Registration** — 40+ handlers for project, file, terminal, git, settings, and companion operations
- **Preferences** — Load/save user preferences from `preferences.json` in Electron's userData directory
- **File Versioning** — Automatic snapshots before file overwrites
- **Session History** — Per-project session tracking with legacy migration
- **Companion Server** — Start/stop the HTTP/WebSocket server for mobile access
- **Application Menu** — macOS/Windows menu bar with keyboard shortcuts

## Key Functions

### Window Management

| Function | Description |
|----------|-------------|
| `createWindow()` | Creates a new BrowserWindow with preload script and dark theme |
| `getWindowProjectPath(event)` | Gets the project path for the window that sent an IPC event |
| `setWindowProjectPath(event, path)` | Associates a project path with a specific window |
| `getWindowFromEvent(event)` | Resolves the BrowserWindow from an IPC event |

### Preferences

| Function | Description |
|----------|-------------|
| `loadPrefs()` | Reads `preferences.json` from userData, returns `{}` on failure |
| `savePrefs(prefs)` | Writes preferences JSON to userData (creates directory if needed) |

### File Versioning

| Function | Description |
|----------|-------------|
| `loadVersionsDb()` | Loads the version database from `file-versions.json` |
| `saveVersionsDb(db)` | Persists the version database |
| `saveVersion(filePath, content)` | Creates a snapshot of file content (max 20 per file) |
| `getVersions(filePath)` | Returns all saved versions for a file path |

### Session History

| Function | Description |
|----------|-------------|
| `getProjectHistoryPath(projectPath)` | Returns path to `.bmad-board/session-history.json` |
| `migrateSessionHistory(projectPath)` | Migrates legacy global history to per-project storage |
| `loadProjectHistory(projectPath)` | Loads session history, triggers migration if needed |
| `saveProjectHistory(projectPath, history)` | Saves session history array to project directory |

### Project Loading

| Function | Description |
|----------|-------------|
| `loadProject(projectPath, event)` | Scans project, updates preferences, tracks window association |
| `startCompanionServer()` | Initializes the companion HTTP/WS server if enabled |
| `updateStoryStatusInYaml(projectPath, slug, newPhase)` | Updates story phase in sprint-status.yaml |

## IPC Handler Groups

### Project Management

| Channel | Type | Description |
|---------|------|-------------|
| `open-project` | invoke | Opens a directory picker, loads selected project |
| `load-last-project` | invoke | Loads the last opened project from preferences |
| `scan-project` | invoke | Re-scans the current project's BMAD files |
| `read-file` | invoke | Reads a file's UTF-8 content |
| `write-file` | invoke | Writes content to file (with version snapshot) |
| `get-file-versions` | invoke | Gets version history for a file |
| `restore-file-version` | invoke | Restores a file to a previous version |
| `get-project-path` | invoke | Returns the current project path |
| `get-project-list` | invoke | Returns all known projects from preferences |
| `load-project-by-path` | invoke | Loads a project by its path directly |
| `remove-project-from-list` | invoke | Removes a project from the project list |
| `get-quick-actions` | invoke | Gets user-defined quick actions |
| `save-quick-actions` | invoke | Saves quick actions to preferences |
| `show-notification` | invoke | Shows a native OS notification |
| `open-external` | invoke | Opens a URL in the default browser |
| `get-story-session` | invoke | Gets the LLM session ID for a story+phase |
| `save-story-session` | invoke | Saves the LLM session ID for a story+phase |

### Terminal / Claude

| Channel | Type | Description |
|---------|------|-------------|
| `launch-phase-command` | invoke | Builds and launches a phase command in external terminal |
| `launch-party-mode` | invoke | Opens external terminal for retrospective |
| `open-terminal` | invoke | Opens an external terminal with a custom command |

### Embedded Terminal (PTY)

| Channel | Type | Description |
|---------|------|-------------|
| `terminal:create` | invoke | Creates a new PTY session, returns session ID |
| `terminal:input` | on | Forwards user input to a PTY session |
| `terminal:resize` | on | Resizes a PTY session |
| `terminal:kill` | invoke | Kills a PTY session |
| `terminal:data` | send | Streams PTY output to renderer (main→renderer) |
| `terminal:exit` | send | Notifies renderer of PTY exit (main→renderer) |

### Session History

| Channel | Type | Description |
|---------|------|-------------|
| `session-history:save` | invoke | Adds/updates a session history entry |
| `session-history:get` | invoke | Returns all session history entries |
| `session-history:remove` | invoke | Removes a session history entry by ID |
| `session-history:clear` | invoke | Clears all session history |

### Settings

| Channel | Type | Description |
|---------|------|-------------|
| `settings:get` | invoke | Returns user settings from preferences |
| `settings:save` | invoke | Saves settings to preferences |
| `settings:get-providers` | invoke | Returns list of available LLM providers |

### BMAD Config

| Channel | Type | Description |
|---------|------|-------------|
| `bmad-config:read` | invoke | Reads the BMAD config.yaml for the project |
| `bmad-config:write` | invoke | Writes updates to the BMAD config |
| `bmad-manifest:read` | invoke | Reads the BMAD manifest file |

### Companion Server

| Channel | Type | Description |
|---------|------|-------------|
| `companion:get-info` | invoke | Returns companion server connection info |
| `companion:toggle` | invoke | Enables or disables the companion server |
| `companion:regenerate-token` | invoke | Generates a new auth token |

### Project Archiving

| Channel | Type | Description |
|---------|------|-------------|
| `project:archive` | invoke | Archives a project (marks as archived) |
| `project:unarchive` | invoke | Unarchives a project |

### Git Operations

See [Git Integration](./git-integration.md) for the full list of 30+ git IPC handlers.

## Application Menu

The main process sets up a native application menu with these shortcuts:

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl+N` | New Window |
| `Cmd/Ctrl+T` | New Terminal Tab |
| `Cmd/Ctrl+W` | Close Tab |
| `Cmd/Ctrl+,` | Settings |

## Lifecycle

```
app.whenReady()
  → Build application menu
  → createWindow()
  → startCompanionServer()

app.on('window-all-closed')
  → terminalManager.killAll()
  → companionServer.stop()
  → app.quit() (non-macOS)

app.on('activate')
  → createWindow() if no windows exist
  → startCompanionServer() if stopped
```
