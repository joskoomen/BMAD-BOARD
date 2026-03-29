# Library Modules

The `lib/` directory contains the core business logic modules used by the main process. All modules use CommonJS (`module.exports`).

## bmad-scanner.js

Scans a project's `_bmad/` directory structure to discover epics, stories, documents, and configuration.

### Exported

```javascript
const { scanProject } = require('./lib/bmad-scanner');
```

### scanProject(projectPath)

Main entry point. Returns a structured object describing the project:

```javascript
const result = await scanProject('/path/to/project');
// Returns:
{
  found: true,              // Whether _bmad/ was found
  config: { ... },          // Parsed config.yaml
  epics: [                  // Array of epic objects
    {
      number: 1,
      title: 'Epic Title',
      status: 'in-progress',
      stories: [
        {
          storyNumber: 1,
          title: 'Story Title',
          slug: 'story-1-slug',
          status: 'ready-for-dev',
          filePath: '/path/to/story.md',
          content: '...'      // Full markdown content
        }
      ]
    }
  ],
  documents: [              // Array of document objects
    {
      category: 'planning',
      filename: 'prd.md',
      filePath: '/path/to/prd.md'
    }
  ],
  projectMeta: {
    name: 'Project Name',
    description: '...'
  },
  warning: null             // Optional warning message
}
```

### Internal Functions

| Function | Description |
|----------|-------------|
| `loadBmadConfig(bmadDir, projectPath)` | Loads and parses YAML config, resolves `{project-root}` placeholders |
| `parseSimpleYaml(content)` | Parses flat key-value YAML (not a full YAML parser) |
| `extractProjectMeta(config)` | Extracts project name and description from config |
| `findSprintStatus(config)` | Searches for `sprint-status.yaml` across candidate paths |
| `parseSprintStatus(filePath)` | Parses the epic/story YAML structure |
| `enrichStoriesFromFiles(epics, config)` | Loads markdown content for each story file |
| `collectDocuments(config)` | Collects non-story documents by category |
| `safeReaddir(dirPath)` | Directory read that returns `[]` on error |
| `slugToTitle(slug)` | Converts `kebab-case` to `Title Case` |

---

## phase-commands.js

Maps story phases (backlog → done) to LLM CLI commands.

### Exported

```javascript
const {
  PHASE_ORDER,
  PHASE_CONFIG,
  getPhaseConfig,
  getPhaseIndex,
  getNextPhase,
  buildCommand,
  buildClaudeCommand
} = require('./lib/phase-commands');
```

### Constants

```javascript
PHASE_ORDER = ['backlog', 'ready-for-dev', 'in-progress', 'review', 'done']

PHASE_CONFIG = {
  'backlog':       { label: 'Backlog',     color: '#6b7280', icon: '○', command: null },
  'ready-for-dev': { label: 'Ready',       color: '#f59e0b', icon: '◐', command: '/dev-planning' },
  'in-progress':   { label: 'In Progress', color: '#3b82f6', icon: '◑', command: '/implement' },
  'review':        { label: 'Review',      color: '#8b5cf6', icon: '◕', command: '/review' },
  'done':          { label: 'Done',        color: '#10b981', icon: '●', command: null }
}
```

### Functions

| Function | Description |
|----------|-------------|
| `getPhaseConfig(status)` | Returns phase metadata by status key |
| `getPhaseIndex(status)` | Returns zero-based index in PHASE_ORDER |
| `getNextPhase(status)` | Returns next phase key, or `null` if done |
| `buildCommand(phase, storySlug, storyFilePath, providerKey)` | Builds full CLI command for any LLM provider |
| `buildClaudeCommand(phase, storySlug, storyFilePath)` | Claude-specific convenience wrapper |

---

## llm-providers.js

Multi-LLM provider abstraction layer supporting Claude, Codex, Cursor, Aider, and OpenCode.

### Exported

```javascript
const {
  LLM_PROVIDERS,
  getProvider,
  getProviderKeys,
  getProviderList
} = require('./lib/llm-providers');
```

### Providers

| Key | Name | Binary | Session Support |
|-----|------|--------|-----------------|
| `claude` | Claude Code | `claude` | Yes (session ID + resume) |
| `codex` | Codex CLI | `codex` | No |
| `cursor` | Cursor | `cursor` | No |
| `aider` | Aider | `aider` | No |
| `opencode` | OpenCode | `opencode` | No |

### Provider Interface

Each provider implements:

```javascript
{
  name: 'Provider Name',
  binary: 'cli-command',
  supportsSessionId: true/false,
  supportsResume: true/false,
  buildCommand(slashCommand, opts) { ... },       // Build full terminal command
  buildResumeCommand(sessionId) { ... },          // Build resume command
  translateCommand(slashCommand, storyFilePath) { ... }, // Translate BMAD → provider format
  detectState(output) { ... }                     // Detect provider state from output
}
```

---

## git-manager.js (GitManager)

Full-featured git operations wrapper using [simple-git](https://github.com/nicedoc/simple-git).

### Exported

```javascript
const { GitManager } = require('./lib/git-manager');
const git = new GitManager('/path/to/repo');
```

### Methods (45+)

#### Repository

| Method | Description |
|--------|-------------|
| `isRepo()` | Check if path is a git repository |
| `status()` | Get status with ahead/behind counts |
| `fetch()` | Fetch from all remotes |

#### Branches

| Method | Description |
|--------|-------------|
| `branches()` | List local and remote branches with tracking info |
| `checkout(branch)` | Checkout branch (creates tracking for remote) |
| `createBranch(name, startPoint)` | Create and checkout a new branch |
| `deleteBranch(name, force)` | Delete a local branch |
| `deleteRemoteBranch(name, remote)` | Delete a remote branch |

#### Staging & Committing

| Method | Description |
|--------|-------------|
| `stage(files)` | Stage specific files |
| `stageAll()` | Stage all changes |
| `unstage(files)` | Unstage files |
| `commit(message)` | Create a commit |
| `amend(message)` | Amend the last commit |

#### Merging & Rebasing

| Method | Description |
|--------|-------------|
| `merge(branch)` | Merge a branch (detects conflicts) |
| `abortMerge()` | Abort an in-progress merge |
| `rebase(branch)` | Rebase onto a branch |
| `rebaseAbort()` | Abort a rebase |
| `rebaseContinue()` | Continue a rebase after conflict resolution |
| `isRebasing()` | Check if a rebase is in progress |

#### Diffs & History

| Method | Description |
|--------|-------------|
| `diff()` | Get diff summary |
| `diffFile(file, staged)` | Get diff for a specific file |
| `log(limit)` | Get commit history |
| `showCommit(hash)` | Show commit details with changed files |
| `commitDiff(hash)` | Get full diff for a commit |
| `commitFileDiff(hash, file)` | Get file-specific diff in a commit |
| `fileLog(file, limit)` | Get history for a specific file |

#### Stash

| Method | Description |
|--------|-------------|
| `stashList()` | List stash entries |
| `stash(message)` | Stash changes |
| `stashPop(index)` | Pop a stash entry |
| `stashDrop(index)` | Drop a stash entry |

#### Tags

| Method | Description |
|--------|-------------|
| `tags()` | List all tags |
| `createTag(name, message)` | Create an annotated tag |
| `deleteTag(name)` | Delete a tag |
| `pushTag(name, remote)` | Push a single tag |
| `pushAllTags(remote)` | Push all tags |

#### Remote & Misc

| Method | Description |
|--------|-------------|
| `pull(remote, branch)` | Pull from remote |
| `push(remote, branch)` | Push to remote |
| `getRemoteUrl(remote)` | Get remote URL |
| `hasGhCli()` | Check if `gh` CLI is available |
| `openMergeTool(file)` | Open configured merge tool |
| `discardFile(file)` | Discard changes to a file |
| `discardAll()` | Reset hard + clean |
| `revert(hash)` | Revert a commit |
| `readConflictFile(file)` | Read file content during merge conflict |
| `resolveConflict(file, content)` | Write resolved content for a conflict |

---

## markdown.js

Lightweight markdown-to-HTML renderer with no external dependencies.

### Exported

```javascript
const { MD } = require('./lib/markdown');
const html = MD.render('# Hello **world**');
const safe = MD.esc('<script>alert("xss")</script>');
```

### Supported Syntax

- Headers (h1-h4)
- Bold (`**text**`) and italic (`*text*`)
- Fenced code blocks with language hints
- Inline code
- Unordered and ordered lists
- Checkboxes (`- [x]` / `- [ ]`)
- Blockquotes
- Simple tables
- Links
- Horizontal rules

---

## terminal-manager.js (TerminalManager)

See [Terminal System](./terminal.md) for details.

---

## terminal-launcher.js

See [Terminal System](./terminal.md) for details.

---

## companion-server.js (CompanionServer)

See [Companion PWA](./companion.md) for details.
