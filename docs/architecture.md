# Architecture Overview

BMAD Board follows a standard Electron architecture with a clear separation between the **main process** (Node.js), the **renderer process** (browser), and a **preload bridge** that safely connects them.

## High-Level Diagram

```
┌───────────────────────────────────────────────────────────────────┐
│                      Electron Main Process                        │
│                         (main.js)                                 │
│                                                                   │
│  ┌─────────────┐  ┌────────────────┐  ┌───────────────────────┐  │
│  │ Preferences  │  │ File Versioning│  │  Session History      │  │
│  │ (JSON file)  │  │ (snapshots)    │  │  (per-project)        │  │
│  └─────────────┘  └────────────────┘  └───────────────────────┘  │
│                                                                   │
│  ┌─────────────┐  ┌────────────────┐  ┌───────────────────────┐  │
│  │ BMAD Scanner│  │ Phase Commands │  │  LLM Providers        │  │
│  │ (lib/)      │  │ (lib/)         │  │  (lib/)               │  │
│  └─────────────┘  └────────────────┘  └───────────────────────┘  │
│                                                                   │
│  ┌─────────────┐  ┌────────────────┐  ┌───────────────────────┐  │
│  │ Terminal Mgr │  │ Git Manager   │  │  Companion Server     │  │
│  │ (node-pty)  │  │ (simple-git)  │  │  (HTTP + WebSocket)   │  │
│  └─────────────┘  └────────────────┘  └───────────────────────┘  │
│                                                                   │
│                    40+ IPC Handlers                                │
└─────────────────────────┬─────────────────────────────────────────┘
                          │
                   preload.js (contextBridge)
                   window.api = { ... }
                          │
┌─────────────────────────┴─────────────────────────────────────────┐
│                    Electron Renderer Process                       │
│                      (Browser Context)                             │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │  app.js — Main UI                                          │   │
│  │  ├── Epic/Story Dashboard                                  │   │
│  │  ├── Document Viewer (markdown rendering)                  │   │
│  │  ├── Git View (branches, commits, diffs, merge, stash)     │   │
│  │  ├── Session History                                       │   │
│  │  ├── Settings & BMAD Config                                │   │
│  │  └── Phase Polling (auto-detect story status changes)      │   │
│  └────────────────────────────────────────────────────────────┘   │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │  terminal-renderer.js — Embedded Terminal                  │   │
│  │  ├── xterm.js with multi-tab support                       │   │
│  │  ├── Command palette (Cmd+K) with BMAD suggestions         │   │
│  │  ├── Auto-launch Claude CLI in new tabs                    │   │
│  │  └── PTY session management (via IPC to main process)      │   │
│  └────────────────────────────────────────────────────────────┘   │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
                          │
                     HTTP / WebSocket
                     (port 3939)
                          │
┌─────────────────────────┴─────────────────────────────────────────┐
│                    Companion PWA (Mobile)                          │
│                    companion/app.js                                │
│                                                                   │
│  ├── Epic/Story Dashboard (responsive)                            │
│  ├── Terminal Viewer (real-time via WebSocket)                     │
│  ├── Story Phase Management (advance phases remotely)             │
│  ├── Push Notifications                                           │
│  └── Service Worker (offline support)                             │
└───────────────────────────────────────────────────────────────────┘
```

## Process Communication

### IPC Bridge (preload.js)

The renderer **never** accesses Node.js APIs directly. All communication goes through `window.api`, which is exposed by `preload.js` using Electron's `contextBridge`:

```
Renderer (app.js)           Preload (preload.js)          Main (main.js)
─────────────────           ───────────────────           ──────────────
window.api.scanProject()  → ipcRenderer.invoke('scan-project') → ipcMain.handle('scan-project')
                                                                    └─ scanProject(projectPath)
                                                                    └─ return result
                           ← Promise resolves with data  ← return data
```

### Communication Patterns

| Pattern | Usage | Example |
|---------|-------|---------|
| **Request-Reply** | Most operations | `ipcRenderer.invoke()` → `ipcMain.handle()` |
| **One-Way (main→renderer)** | Menu events, terminal output | `win.webContents.send()` → `ipcRenderer.on()` |
| **One-Way (renderer→main)** | Terminal input/resize | `ipcRenderer.send()` → `ipcMain.on()` |

## Multi-Window Support

Each BrowserWindow tracks its own project path independently using a `Map<webContentsId, projectPath>`:

```javascript
const windowProjectPaths = new Map();  // webContents.id → projectPath
```

When an IPC handler receives an event, it looks up the project path for that specific window via `getWindowProjectPath(event)`. This allows multiple windows to have different projects open simultaneously.

## Data Flow Patterns

### 1. Project Loading

```
User selects directory
  → dialog.showOpenDialog()
  → scanProject(path)
    → loadBmadConfig()     // Parse _bmad/config.yaml
    → parseSprintStatus()  // Extract epic/story structure
    → enrichStoriesFromFiles()  // Load markdown story content
    → collectDocuments()   // Index planning/implementation docs
  → Return structured data to renderer
  → Renderer renders epic/story dashboard
```

### 2. Story Phase Advancement

```
User clicks "Start Development" on a story
  → buildCommand(phase, storySlug, storyFilePath, providerKey)
  → Terminal tab opens with LLM CLI command
  → LLM processes the BMAD slash command
  → Phase poller detects status change in sprint-status.yaml
  → UI updates story card with new phase
```

### 3. Embedded Terminal Session

```
User opens terminal tab
  → terminal:create IPC → TerminalManager.create()
  → node-pty spawns shell process
  → PTY output → terminal:data IPC → xterm.js renders
  → User types → terminal:input IPC → PTY stdin
  → Terminal resize → terminal:resize IPC → PTY resize
```

### 4. Companion PWA Connection

```
Desktop starts CompanionServer on port 3939
  → Generates auth token + QR code
  → Mobile scans QR / enters URL
  → HTTP GET /api/status (with Bearer token)
  → WebSocket connection (with token)
  → Real-time project state updates
  → Mobile can advance story phases, view terminal
```
