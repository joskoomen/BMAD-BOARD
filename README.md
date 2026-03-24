# BMAD Board

Visual dashboard for [BMAD-method](https://github.com/bmad-method) projects. Manage epics, track stories through development phases, and launch LLM-powered workflows — all from a single Electron app with an embedded terminal.

![Electron](https://img.shields.io/badge/Electron-41-47848F?logo=electron&logoColor=white)
![License](https://img.shields.io/badge/license-GPL--3.0-blue)

## Features

- **Epic & Story Board** — Browse epics and stories from your project's `_bmad/` directory with phase tracking (Backlog → Ready → In Progress → Review → Done)
- **Embedded Terminal** — Warp-style terminal with tabs, powered by xterm.js and node-pty
- **Multi-LLM Support** — Launch BMAD slash commands with Claude Code, Codex, Cursor, Aider, or OpenCode
- **Command Palette** — Quick access to BMAD commands via `Cmd+K`
- **Session History** — Track and resume past LLM sessions per project
- **Document Viewer** — Browse and edit BMAD planning and implementation artifacts with built-in markdown rendering
- **File Versioning** — Automatic snapshots before edits with one-click restore
- **Multi-Window** — Open multiple projects simultaneously
- **Party Mode** — Run parallel LLM sessions for maximum velocity

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- An LLM CLI tool installed (e.g., [Claude Code](https://docs.anthropic.com/en/docs/claude-code))
- A project set up with the [BMAD method](https://github.com/bmad-method) (`_bmad/` directory)

### Install

```bash
git clone https://github.com/your-username/bmad-board.git
cd bmad-board
npm install
```

### Run

```bash
npm start
```

Or in dev mode:

```bash
npm run dev
```

### Build

```bash
# All platforms
npm run dist

# macOS only
npm run dist:mac

# Windows only
npm run dist:win

# Linux only
npm run dist:linux
```

## Project Structure

```
bmad-board/
├── main.js                 # Electron main process
├── preload.js              # Context bridge (IPC API)
├── app.js                  # Renderer — UI logic
├── index.html              # App shell
├── styles.css              # Main styles
├── terminal.css            # Terminal styles
├── terminal-renderer.js    # xterm.js terminal setup
├── lib/
│   ├── bmad-scanner.js     # Scans _bmad/ for project artifacts
│   ├── phase-commands.js   # Maps phases to BMAD slash commands
│   ├── llm-providers.js    # Multi-LLM provider abstraction
│   ├── terminal-manager.js # PTY session management
│   ├── terminal-launcher.js# External terminal launcher
│   └── markdown.js         # Markdown renderer
├── tests/                  # Vitest test suite
├── assets/                 # App icons
└── docs/                   # Documentation
```

## How It Works

1. **Open a project** — Select a folder containing a `_bmad/` directory
2. **Browse epics** — The scanner reads your BMAD config and discovers epics and stories
3. **Advance stories** — Click a story phase to launch the corresponding BMAD command in the embedded terminal
4. **Track progress** — Session history records each LLM interaction per story

## Testing

```bash
npm test
```

## Author

Jos Koomen

## License

This project is licensed under the [GNU General Public License v3.0](LICENSE).
