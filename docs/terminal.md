# Terminal System

BMAD Board includes a full embedded terminal powered by [xterm.js](https://xtermjs.org/) and [node-pty](https://github.com/nicedoc/node-pty). It supports multi-tab sessions, a command palette, and tight integration with BMAD workflows.

## Architecture

```
┌─────────────────────────────────┐
│  terminal-renderer.js           │
│  (Renderer Process)             │
│                                 │
│  ┌───────────────────────────┐  │
│  │  xterm.js Terminal        │  │
│  │  ├── Multi-tab support    │  │
│  │  ├── Theme/styling        │  │
│  │  ├── FitAddon (auto-size) │  │
│  │  └── WebLinksAddon        │  │
│  └───────────────────────────┘  │
│                                 │
│  ┌───────────────────────────┐  │
│  │  Command Palette (Cmd+K)  │  │
│  │  ├── BMAD commands        │  │
│  │  ├── Quick actions        │  │
│  │  └── Fuzzy matching       │  │
│  └───────────────────────────┘  │
│                                 │
│  ┌───────────────────────────┐  │
│  │  Tab Bar                  │  │
│  │  ├── Create / close tabs  │  │
│  │  ├── Tab switching        │  │
│  │  └── Tab context menus    │  │
│  └───────────────────────────┘  │
└────────────────┬────────────────┘
                 │ IPC
┌────────────────┴────────────────┐
│  terminal-manager.js            │
│  (Main Process)                 │
│                                 │
│  TerminalManager class          │
│  ├── create(opts) → id         │
│  ├── write(id, data)           │
│  ├── resize(id, cols, rows)    │
│  ├── kill(id)                  │
│  └── killAll()                 │
│                                 │
│  node-pty spawns shell process  │
└─────────────────────────────────┘
```

## terminal-renderer.js

This file manages the entire terminal UI in the renderer process.

### State

```javascript
let tabs = [];           // Array of tab objects { id, name, terminal, fitAddon, pid }
let activeTabId = null;  // Currently active tab ID
let nextTabId = 1;       // Auto-incrementing tab ID counter
```

### Tab Lifecycle

1. **Create**: A new xterm.js Terminal instance is created, attached to a DOM element, and a PTY session is requested via IPC
2. **Data Flow**: PTY output → `terminal:data` IPC → xterm.js `write()`; User keystrokes → `terminal:input` IPC → PTY stdin
3. **Resize**: FitAddon auto-sizes the terminal; resize events are forwarded to the PTY via `terminal:resize`
4. **Close**: Tab is removed from the UI; PTY session is killed via `terminal:kill`

### Command Palette (Cmd+K)

The command palette provides quick access to BMAD slash commands and custom actions:

- Triggered by `Cmd+K` (or `Ctrl+K` on non-macOS)
- Shows a searchable list of available commands
- Supports keyboard navigation (arrow keys, Enter, Escape)
- Commands are executed by writing them directly to the active terminal

### COMMAND_TAB_INFO

A mapping of 30+ BMAD slash commands to display metadata:

```javascript
const COMMAND_TAB_INFO = {
  '/implement': { label: 'Implement', icon: '🔨', category: 'dev' },
  '/test':      { label: 'Test',      icon: '🧪', category: 'dev' },
  '/review':    { label: 'Review',    icon: '👀', category: 'dev' },
  // ... etc
};
```

### Auto-Launch Claude

When a new terminal tab is created, it can auto-launch the Claude CLI. This is controlled by user settings and the context (e.g., launching from a story phase button).

## terminal-manager.js (TerminalManager)

The `TerminalManager` class in the main process manages PTY session lifecycles.

### API

```javascript
const manager = new TerminalManager();

// Create a new PTY session
const id = manager.create({
  cwd: '/path/to/project',
  cols: 120,
  rows: 30,
  onData: (data) => { /* stream output */ },
  onExit: (exitCode) => { /* handle exit */ }
});

// Write user input to the session
manager.write(id, 'ls -la\n');

// Resize the session
manager.resize(id, 150, 40);

// Check if a session exists
manager.has(id);  // true

// Kill a specific session
manager.kill(id);

// Kill all sessions (on app quit)
manager.killAll();
```

### PTY Configuration

Sessions are spawned using `node-pty` with the user's default shell (`$SHELL` or fallback to `/bin/zsh`). The working directory is set to the current project path.

## terminal-launcher.js

For **external** terminal windows (macOS Terminal.app), used when launching LLM commands outside the embedded terminal.

### API

```javascript
// Open Terminal.app with a command
await openTerminal('/path/to/project', 'npm test');

// Open Terminal.app with a Claude command
await openClaudeWithCommand('/path/to/project', 'claude "/implement story-1"');

// Open Terminal.app for party mode (retrospective)
await openPartyMode('/path/to/project');
```

Uses AppleScript (`osascript`) for reliable Terminal.app control, with a fallback to `open -a Terminal.app`.

## IPC Channels

| Channel | Direction | Description |
|---------|-----------|-------------|
| `terminal:create` | renderer → main | Create PTY session, returns `{ id }` |
| `terminal:input` | renderer → main | Send keystrokes to PTY |
| `terminal:resize` | renderer → main | Resize PTY dimensions |
| `terminal:kill` | renderer → main | Kill a PTY session |
| `terminal:data` | main → renderer | Stream PTY output |
| `terminal:exit` | main → renderer | Notify of PTY session exit |
