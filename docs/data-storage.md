# Data Storage

BMAD Board stores data in several locations depending on the scope and purpose.

## Storage Locations

| Data | Location | Scope |
|------|----------|-------|
| User preferences | `~/.config/bmad-board/preferences.json` | Global (all projects) |
| File versions | `~/.config/bmad-board/file-versions.json` | Global |
| Session history | `<project>/.bmad-board/session-history.json` | Per-project |
| BMAD config | `<project>/_bmad/bmm/config.yaml` | Per-project |
| Sprint status | `<project>/_bmad-output/implementation/sprint-status.yaml` | Per-project |
| Story files | `<project>/_bmad-output/implementation/*.md` | Per-project |

> `~/.config/bmad-board/` is Electron's `userData` directory. On macOS this is `~/Library/Application Support/bmad-board/`.

## Preferences (preferences.json)

User-wide settings stored in Electron's userData directory.

### Structure

```json
{
  "lastProjectPath": "/path/to/last/project",
  "projects": [
    {
      "name": "My Project",
      "path": "/path/to/project",
      "archived": false,
      "addedAt": "2025-01-15T10:00:00.000Z",
      "lastOpenedAt": "2025-03-20T14:30:00.000Z"
    }
  ],
  "settings": {
    "llm": {
      "provider": "claude",
      "autoLaunch": true
    },
    "terminal": {
      "fontSize": 14,
      "theme": "dark"
    },
    "notifications": {
      "enabled": true,
      "sound": true,
      "phaseChanges": true
    },
    "companion": {
      "enabled": true,
      "port": 3939,
      "token": "auto-generated-token"
    },
    "git": {
      "autoFetchInterval": 5
    }
  },
  "storySessions": {
    "story-1:in-progress": "session-abc123",
    "story-2:review": "session-def456"
  },
  "quickActions": [
    { "label": "Run Tests", "command": "npm test" }
  ]
}
```

### Key Fields

| Field | Type | Description |
|-------|------|-------------|
| `lastProjectPath` | `string` | Path to auto-load on startup |
| `projects` | `Array` | All known projects with metadata |
| `settings` | `Object` | User configuration (LLM, terminal, notifications, companion, git) |
| `storySessions` | `Object` | Maps `storySlug:phase` to LLM session IDs for resume support |
| `quickActions` | `Array` | User-defined terminal quick actions |

### API

```javascript
// Main process
const prefs = loadPrefs();     // Returns {} if file doesn't exist
savePrefs(prefs);              // Creates directory if needed

// Renderer (via IPC)
const settings = await window.api.getSettings();
await window.api.saveSettings(settings);
```

## File Versioning (file-versions.json)

Automatic snapshots of file content before overwrites, providing undo capability.

### Structure

```json
{
  "/absolute/path/to/file.md": [
    {
      "savedAt": "2025-03-20T14:30:00.000Z",
      "content": "file content before change...",
      "preview": "First 200 characters of content..."
    }
  ]
}
```

### Behavior

- A version is saved **before** every file write via `write-file` IPC
- Maximum **20 versions** per file (oldest are dropped)
- Only saves if content actually changed
- Indexed by **absolute file path**

### API

```javascript
// Main process
saveVersion(filePath, oldContent);     // Create snapshot
const versions = getVersions(filePath); // Get all versions

// Renderer (via IPC)
const versions = await window.api.getFileVersions(filePath);
const result = await window.api.restoreFileVersion(filePath, versionIndex);
// result.content contains the restored content
```

## Session History (session-history.json)

Per-project log of terminal sessions and LLM interactions, stored in `<project>/.bmad-board/session-history.json`.

### Structure

```json
[
  {
    "id": "uuid-string",
    "type": "phase-command",
    "storySlug": "story-1-setup",
    "phase": "in-progress",
    "command": "claude \"/implement story-1-setup\"",
    "startedAt": "2025-03-20T14:30:00.000Z",
    "endedAt": "2025-03-20T15:00:00.000Z",
    "sessionId": "claude-session-abc123",
    "notes": "Optional user notes"
  }
]
```

### Legacy Migration

Session history was originally stored globally in `preferences.json`. The `migrateSessionHistory()` function automatically migrates entries to per-project storage on first access.

### API

```javascript
// Renderer (via IPC)
await window.api.saveSessionHistory(entry);
const history = await window.api.getSessionHistory();
await window.api.removeSessionHistory(entryId);
await window.api.clearSessionHistory();
```

## BMAD Project Structure

BMAD Board expects projects to have a `_bmad/` directory with this structure:

```
project/
├── _bmad/
│   └── bmm/
│       └── config.yaml          # Project configuration
│
├── _bmad-output/
│   ├── implementation/
│   │   ├── sprint-status.yaml   # Epic/story phase tracking
│   │   ├── story-1-setup.md     # Story files
│   │   └── story-2-auth.md
│   │
│   └── planning/
│       ├── prd.md               # Product requirements
│       └── architecture.md      # Architecture document
│
└── .bmad-board/
    └── session-history.json     # BMAD Board session tracking
```

### config.yaml

The BMAD config file defines paths and project metadata. It supports a `{project-root}` placeholder that resolves to the project directory:

```yaml
projectName: My Project
projectDescription: A cool project
implementationArtifacts: "{project-root}/_bmad-output/implementation"
planningArtifacts: "{project-root}/_bmad-output/planning"
```

### sprint-status.yaml

Tracks which phase each story is in:

```yaml
epic-1:
  title: User Authentication
  status: in-progress
  stories:
    story-1-setup: ready-for-dev
    story-2-auth: in-progress
    story-3-tests: backlog

epic-2:
  title: Dashboard
  status: backlog
  stories:
    story-4-layout: backlog
```

Phase values: `backlog`, `ready-for-dev`, `in-progress`, `review`, `done`
