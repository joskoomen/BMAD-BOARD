# Renderer Process (app.js)

The renderer process runs in the browser context of each Electron window. It manages the entire UI: navigation, views, epic/story rendering, document viewing, git operations, settings, and phase polling.

## Architecture

`app.js` is a single-page application that manages multiple views within one HTML page. It communicates with the main process exclusively through `window.api` (see [IPC API Reference](./ipc-api.md)).

The file also contains an inline copy of the markdown renderer (`MD` object) since the renderer process cannot `require()` Node.js modules.

## State Management

All state is held in module-level variables:

```javascript
let projectData = null;        // Result from bmad-scanner
let currentView = 'welcome';   // Active view name
let currentEpic = null;        // Selected epic object
let expandedStories = {};      // story slug → expanded boolean
let viewMode = {};             // key → 'rendered' | 'edit' | 'raw'
let editorDirty = {};          // key → boolean (unsaved changes)
let editorContent = {};        // key → current editor text
let searchQuery = '';           // Current search filter
let previousStoryStates = {};  // slug → status (for change detection)
let pollTimer = null;           // Phase change polling interval
let isGitRepo = false;          // Whether current project has git
let gitAutoFetchTimer = null;   // Auto-fetch interval timer
```

## Views

The application has these main views, controlled by `showView(name)`:

| View | Description |
|------|-------------|
| `welcome` | Landing screen shown when no project is loaded |
| `epics` | Main dashboard showing all epics as cards with progress bars |
| `epic-detail` | Detail view for a single epic with its stories |
| `documents` | Document browser organized by category |
| `terminal` | Embedded terminal (managed by terminal-renderer.js) |
| `history` | Session history log |
| `git` | Full git UI (branches, commits, diffs, merge, stash) |
| `settings` | App settings and BMAD configuration |
| `party` | Party mode / retrospective view |

### View Switching

```javascript
showView(name)
  → Hides all .view elements
  → Shows the target view
  → Updates sidebar navigation active state
  → Triggers view-specific rendering (renderEpics, renderGitView, etc.)
```

## Key Function Groups

### Initialization

| Function | Description |
|----------|-------------|
| `DOMContentLoaded` handler | Sets up navigation, shortcuts, project selector, split pane; loads last project |
| `setupNavigation()` | Binds click handlers to sidebar navigation items |
| `setupKeyboardShortcuts()` | Registers Cmd+O (open), Cmd+R (refresh), Escape (back) |
| `setupSplitResize()` | Makes the split pane handle draggable for resizing top/bottom |
| `setupProjectSelector()` | Initializes the project dropdown in the sidebar |
| `setupToastContainer()` | Creates the toast notification container element |

### Project Management

| Function | Description |
|----------|-------------|
| `openProject()` | Opens directory picker; asks about new window if project already loaded |
| `refreshProject()` | Re-scans current project and updates the active view |
| `buildProjectOptions()` | Builds the HTML for the project selector dropdown |
| `refreshProjectList()` | Reloads the project list from preferences |

### Epic & Story Rendering

| Function | Description |
|----------|-------------|
| `renderEpics()` | Renders epic cards with progress bars, phase dots, and search filtering |
| `renderEpicDetail()` | Renders a single epic's stories with expandable detail panels |
| `renderStoryCard(story, epicNumber)` | Creates a story card with phase pill, actions, and expandable content |
| `renderRetroCard(story)` | Creates a retrospective/party-mode card for a story |

### Document Viewer

| Function | Description |
|----------|-------------|
| `renderDocuments()` | Lists all documents grouped by category (config, planning, implementation) |
| `showDocumentReader(doc)` | Opens a document in the reader with rendered/raw/edit modes |

### Git Integration

| Function | Description |
|----------|-------------|
| `detectGitRepo()` | Checks if current project is a git repo; shows/hides git nav |
| `startGitAutoFetch()` | Starts periodic `git fetch` based on settings interval |
| `stopGitAutoFetch()` | Stops the auto-fetch timer |
| `renderGitView()` | Renders the full git UI (branches, status, log, stash, tags) |
| `performMerge(branch)` | Executes a git merge with conflict detection |
| `buildCommitMessage()` | Builds commit message from the git form inputs |
| `showGitContextMenu(branch, event)` | Shows a right-click context menu for branch operations |

### Conflict Resolution

| Function | Description |
|----------|-------------|
| `parseConflicts(content)` | Parses git conflict markers into structured blocks |
| `renderConflictViewer(fileName, blocks)` | Renders an interactive conflict resolution UI |
| `escapeHtml(str)` | Escapes HTML special characters |
| `formatDiff(diff)` | Formats a git diff with color-coded lines |

### Settings

| Function | Description |
|----------|-------------|
| `renderSettings()` | Renders the settings form (LLM provider, terminal, notifications, companion) |
| `renderCompanionSection()` | Renders the companion server status and QR code |
| `saveSettingsFromForm()` | Saves settings from the form to the main process |
| `saveBmadConfigFromForm()` | Saves BMAD config changes |

### Phase Polling

The renderer polls for story phase changes to detect when LLM tools update `sprint-status.yaml`:

| Function | Description |
|----------|-------------|
| `startPhasePoller()` | Starts a 10-second interval that checks for phase changes |
| `stopPhasePoller()` | Stops the polling interval |
| `snapshotStoryStates()` | Captures current story statuses for comparison |
| `pollForPhaseChanges()` | Compares current statuses against snapshot; shows toasts on changes |

### UI Utilities

| Function | Description |
|----------|-------------|
| `showView(name)` | Switches the visible view and updates navigation |
| `showWarning(msg)` | Displays a warning message in the welcome view |
| `showToast(msg, type)` | Shows a brief notification toast (info, success, error) |

## Split Pane Layout

The app uses a vertical split layout:
- **Top pane**: Main view content (epics, documents, git, etc.)
- **Bottom pane**: Embedded terminal (always visible)
- **Resize handle**: Draggable divider between the two panes

The split pane state persists during the session and the terminal is refitted when the pane is resized.
