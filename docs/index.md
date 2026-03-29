# BMAD Board Documentation

BMAD Board is an Electron desktop application for managing [BMAD-method](https://github.com/bmad-method) projects. It provides a visual dashboard for epics, stories, and documents with an embedded terminal for running LLM-powered development workflows.

## Table of Contents

- [Architecture Overview](./architecture.md) — How the app is structured
- [Main Process](./main-process.md) — Electron main process, IPC handlers, preferences
- [Renderer Process](./renderer.md) — UI views, navigation, state management
- [Terminal System](./terminal.md) — Embedded terminal, PTY sessions, command palette
- [Library Modules](./lib-modules.md) — Core libraries (scanner, git, LLM providers, etc.)
- [IPC API Reference](./ipc-api.md) — Complete list of IPC channels and their payloads
- [Companion PWA](./companion.md) — Mobile companion server and progressive web app
- [Git Integration](./git-integration.md) — Git operations and UI
- [Data Storage](./data-storage.md) — Preferences, sessions, file versioning

## Quick Start

```bash
# Install dependencies
npm install

# Launch the app
npm start

# Launch in development mode (with DevTools)
npm run dev

# Run tests
npm test
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Desktop framework | Electron 41 |
| Terminal emulation | xterm.js 5.5 |
| PTY backend | node-pty |
| Git operations | simple-git |
| WebSocket server | ws |
| Module system | CommonJS |
| Testing | Vitest |
| Build | electron-builder |

## Project Structure

```
bmad-board/
├── main.js                  # Electron main process
├── preload.js               # IPC bridge (contextBridge)
├── app.js                   # Renderer process UI
├── terminal-renderer.js     # Embedded terminal (xterm.js)
├── index.html               # App shell
├── styles.css               # Main styles
├── terminal.css             # Terminal styles
│
├── lib/                     # Core library modules
│   ├── bmad-scanner.js      # BMAD project file scanner
│   ├── companion-server.js  # HTTP/WebSocket companion server
│   ├── git-manager.js       # Git operations wrapper
│   ├── llm-providers.js     # Multi-LLM provider abstraction
│   ├── markdown.js          # Lightweight markdown renderer
│   ├── phase-commands.js    # Story phase → CLI command mapping
│   ├── terminal-launcher.js # External terminal launcher (macOS)
│   └── terminal-manager.js  # PTY session lifecycle
│
├── companion/               # Mobile PWA companion
│   ├── app.js               # PWA client logic
│   ├── index.html           # PWA interface
│   ├── style.css            # PWA styles
│   ├── manifest.json        # PWA manifest
│   └── sw.js                # Service worker
│
├── tests/                   # Vitest test suite
└── docs/                    # This documentation
```
