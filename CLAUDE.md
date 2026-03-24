# BMAD Board

Electron desktop app for managing BMAD-method projects. Provides a visual dashboard for epics, stories, and documents with an embedded terminal for running LLM-powered development workflows.

## Architecture

- **Electron app** with main process (`main.js`), preload (`preload.js`), and renderer (`app.js`)
- **Main process**: IPC handlers for project management, file I/O, terminal (PTY via node-pty), settings, and session history
- **Renderer**: Single-page app with sidebar navigation, views for epics/stories/terminal/history/settings, and a split-pane layout with persistent terminal
- **Lib modules** (`lib/`):
  - `bmad-scanner.js` — Scans project `_bmad/` directories for epics, stories, and config
  - `phase-commands.js` — Maps story phases (backlog → done) to BMAD slash commands
  - `llm-providers.js` — Multi-LLM provider abstraction (Claude, Codex, Cursor, Aider, OpenCode)
  - `terminal-manager.js` — PTY session lifecycle management
  - `terminal-launcher.js` — Opens external terminals with LLM commands
  - `markdown.js` — Lightweight markdown renderer

## Commands

- `npm start` — Launch the app
- `npm run dev` — Launch in dev mode
- `npm test` — Run tests (vitest)
- `npm run test:watch` — Run tests in watch mode
- `npm run dist` — Build distributables for all platforms
- `npm run dist:mac` — Build macOS DMG only

## Code Conventions

- CommonJS modules throughout (no ESM in main/lib code)
- Vitest for testing with `globals: true` (no explicit imports needed)
- Tests live in `tests/` directory, named `*.test.js`
- IPC communication via `preload.js` contextBridge — renderer never accesses Node directly
- Preferences stored in Electron `userData` path as `preferences.json`
- Per-project data stored in `<project>/.bmad-board/`
- BMAD project structure expected: `_bmad/` directory with config, epics, and story files

## Key Patterns

- Multi-window support: each window tracks its own project path via `windowProjectPaths` map
- File versioning: automatic snapshots before overwrites, stored in `file-versions.json`
- Session history: per-project, stored in `.bmad-board/session-history.json`, with migration from legacy global storage
- Terminal: xterm.js in renderer, node-pty in main process, connected via IPC events
