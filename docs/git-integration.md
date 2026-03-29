# Git Integration

BMAD Board includes a full-featured git UI powered by the `GitManager` class (which wraps [simple-git](https://github.com/nicedoc/simple-git)).

## Features

- Branch management (create, checkout, delete, rename)
- Staging area with file-level control
- Commit with message editor
- Merge with interactive conflict resolution
- Rebase (start, abort, continue)
- Stash management (save, pop, drop)
- Tag management (create, delete, push)
- Diff viewer with syntax highlighting
- Commit history browser
- Auto-fetch on configurable interval
- Remote push/pull

## Architecture

```
┌────────────────────────────────────────┐
│  app.js — Git View (Renderer)          │
│                                        │
│  renderGitView()                       │
│  ├── Branch selector + current branch  │
│  ├── Status (ahead/behind/conflicts)   │
│  ├── Changed files with staging        │
│  ├── Commit form                       │
│  ├── Diff viewer (inline)              │
│  ├── Merge/rebase controls             │
│  ├── Stash list                        │
│  ├── Tag list                          │
│  ├── Commit history log                │
│  └── Conflict resolution UI            │
│                                        │
│  performMerge(branch)                  │
│  showGitContextMenu(branch, event)     │
│  parseConflicts(content)               │
│  renderConflictViewer(file, blocks)    │
└──────────────────┬─────────────────────┘
                   │ window.api.git*()
                   │
┌──────────────────┴─────────────────────┐
│  main.js — Git IPC Handlers            │
│                                        │
│  30+ ipcMain.handle('git:*') handlers  │
│  Each creates a GitManager instance    │
│  for the current window's project path │
└──────────────────┬─────────────────────┘
                   │
┌──────────────────┴─────────────────────┐
│  lib/git-manager.js — GitManager       │
│                                        │
│  Wraps simple-git with 45+ methods     │
│  All methods are async                 │
│  Returns structured data objects       │
└────────────────────────────────────────┘
```

## Git View Sections

### Branch Management

The top section shows:
- Current branch name with remote tracking info
- Ahead/behind commit counts
- Branch selector dropdown
- Create branch button
- Fetch, pull, push buttons

Right-clicking a branch opens a context menu with:
- Checkout
- Merge into current branch
- Delete (local/remote)

### Changed Files

Files are grouped by status:
- **Staged** — Ready to commit (green)
- **Modified** — Changed but not staged (yellow)
- **Untracked** — New files (grey)

Each file has:
- Stage/unstage toggle button
- Diff viewer (click to expand)
- Discard changes option

### Commit Form

- Multi-line commit message textarea
- Commit button (disabled if no staged files)
- Amend checkbox to modify the last commit

### Diff Viewer

Inline diff display with:
- Green highlighting for additions (`+`)
- Red highlighting for deletions (`-`)
- Blue highlighting for hunk headers (`@@`)

### Conflict Resolution

When a merge produces conflicts:

1. Conflicted files are listed with a warning icon
2. Clicking a file opens the **Conflict Viewer**
3. Each conflict block shows "ours" vs "theirs" side by side
4. User can accept ours, accept theirs, or edit manually
5. "Accept All Ours" / "Accept All Theirs" buttons for bulk resolution
6. After resolving, the file is staged and the merge can be completed

### Stash

- List of stash entries with messages
- Pop (apply + remove) and drop (remove) buttons
- Create stash with optional message

### Tags

- List of all tags
- Create annotated tag with name and message
- Delete tags
- Push individual or all tags to remote

### Commit History

- Scrollable log of recent commits
- Each entry shows hash, message, author, date
- Click to expand and see changed files + diff

## Auto-Fetch

BMAD Board periodically fetches from remotes to keep the branch status up to date:

- Default interval: 5 minutes (configurable in settings)
- Set to 0 to disable
- Runs silently in the background
- Refreshes the git view if it's currently visible

## Settings

Git-related settings in the Settings view:

| Setting | Default | Description |
|---------|---------|-------------|
| Auto-fetch interval | 5 min | How often to fetch from remotes (0 = disabled) |

## IPC Channels

See [IPC API Reference](./ipc-api.md#git) for the complete list of 40+ git IPC channels.
