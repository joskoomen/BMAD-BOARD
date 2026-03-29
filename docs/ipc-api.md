# IPC API Reference

All communication between the renderer process and the main process goes through Electron's IPC system, exposed via the `window.api` bridge in `preload.js`.

## Communication Patterns

### Request-Reply (invoke/handle)

Most operations use the request-reply pattern:

```javascript
// Renderer (via window.api)
const result = await window.api.scanProject();

// Preload bridge
scanProject: () => ipcRenderer.invoke('scan-project')

// Main process handler
ipcMain.handle('scan-project', (event) => {
  const projectPath = getWindowProjectPath(event);
  return scanProject(projectPath);
});
```

### One-Way Events (send/on)

Terminal I/O and menu events use one-way messaging:

```javascript
// Renderer → Main (terminal input)
window.api.terminalInput(id, data);
// Maps to: ipcRenderer.send('terminal:input', { id, data })

// Main → Renderer (terminal output)
senderContents.send('terminal:data', { id, data });
// Received via: window.api.onTerminalData((id, data) => { ... })
```

## Complete API Reference

### App

| Method | Channel | Returns | Description |
|--------|---------|---------|-------------|
| `getAppVersion()` | `get-app-version` | `string` | App version from package.json |
| `newWindow()` | `new-window` | `boolean` | Opens a new BrowserWindow |

### Project

| Method | Channel | Returns | Description |
|--------|---------|---------|-------------|
| `openProject()` | `open-project` | `Object\|null` | Opens directory picker, returns scan result |
| `loadLastProject()` | `load-last-project` | `Object\|null` | Loads last project from preferences |
| `scanProject()` | `scan-project` | `Object\|null` | Re-scans current project |
| `readFile(filePath)` | `read-file` | `string\|null` | Reads file content (UTF-8) |
| `writeFile(filePath, content)` | `write-file` | `{success}\|{error}` | Writes file with version snapshot |
| `getFileVersions(filePath)` | `get-file-versions` | `Array` | Gets version history for a file |
| `restoreFileVersion(filePath, index)` | `restore-file-version` | `{success, content}\|{error}` | Restores file to previous version |
| `getProjectPath()` | `get-project-path` | `string\|null` | Current project directory path |
| `getProjectList()` | `get-project-list` | `Array` | All known projects |
| `loadProjectByPath(path)` | `load-project-by-path` | `Object\|null` | Loads a project by absolute path |
| `removeProjectFromList(path)` | `remove-project-from-list` | `boolean` | Removes project from list |
| `getQuickActions()` | `get-quick-actions` | `Array` | User-defined quick actions |
| `saveQuickActions(actions)` | `save-quick-actions` | `void` | Saves quick actions |
| `showNotification(opts)` | `show-notification` | `void` | Shows OS notification |
| `openExternal(url)` | `open-external` | `void` | Opens URL in default browser |
| `getStorySession(slug, phase)` | `get-story-session` | `string\|null` | Gets LLM session ID for story+phase |
| `saveStorySession(slug, phase, id)` | `save-story-session` | `void` | Saves LLM session ID |

### Settings

| Method | Channel | Returns | Description |
|--------|---------|---------|-------------|
| `getSettings()` | `settings:get` | `Object` | User settings from preferences |
| `saveSettings(settings)` | `settings:save` | `void` | Saves settings |
| `getProviders()` | `settings:get-providers` | `Array<{key, name}>` | Available LLM providers |

### BMAD Config

| Method | Channel | Returns | Description |
|--------|---------|---------|-------------|
| `readBmadConfig()` | `bmad-config:read` | `Object\|null` | Reads project BMAD config |
| `writeBmadConfig(updates)` | `bmad-config:write` | `{success}\|{error}` | Writes config updates |
| `readBmadManifest()` | `bmad-manifest:read` | `Object\|null` | Reads BMAD manifest |

### Project Archiving

| Method | Channel | Returns | Description |
|--------|---------|---------|-------------|
| `archiveProject(path)` | `project:archive` | `boolean` | Archives a project |
| `unarchiveProject(path)` | `project:unarchive` | `boolean` | Unarchives a project |

### Session History

| Method | Channel | Returns | Description |
|--------|---------|---------|-------------|
| `saveSessionHistory(entry)` | `session-history:save` | `void` | Adds/updates session entry |
| `getSessionHistory()` | `session-history:get` | `Array` | All session history entries |
| `removeSessionHistory(entryId)` | `session-history:remove` | `void` | Removes entry by ID |
| `clearSessionHistory()` | `session-history:clear` | `void` | Clears all history |

### Terminal / Claude (External)

| Method | Channel | Returns | Description |
|--------|---------|---------|-------------|
| `launchPhaseCommand(opts)` | `launch-phase-command` | `{success, command}\|{error}` | Launches phase command in Terminal.app |
| `launchPartyMode()` | `launch-party-mode` | `{success}\|{error}` | Opens retrospective in Terminal.app |
| `openTerminal(command)` | `open-terminal` | `{success}\|{error}` | Opens Terminal.app with command |

### Embedded Terminal (PTY)

| Method | Channel | Direction | Description |
|--------|---------|-----------|-------------|
| `terminalCreate(opts)` | `terminal:create` | invoke | Creates PTY session → `{id}` |
| `terminalInput(id, data)` | `terminal:input` | send | Writes to PTY stdin |
| `terminalResize(id, cols, rows)` | `terminal:resize` | send | Resizes PTY |
| `terminalKill(id)` | `terminal:kill` | invoke | Kills PTY session |
| `onTerminalData(callback)` | `terminal:data` | on (main→renderer) | PTY output stream |
| `onTerminalExit(callback)` | `terminal:exit` | on (main→renderer) | PTY session exit |

### Git

| Method | Channel | Returns | Description |
|--------|---------|---------|-------------|
| `gitIsRepo()` | `git:is-repo` | `boolean` | Check if project is a git repo |
| `gitStatus()` | `git:status` | `Object` | Status with ahead/behind counts |
| `gitBranches()` | `git:branches` | `Object` | Local and remote branches |
| `gitLog(limit)` | `git:log` | `Array` | Commit history |
| `gitCheckout(branch)` | `git:checkout` | `void` | Checkout branch |
| `gitCreateBranch(name, startPoint)` | `git:create-branch` | `void` | Create and checkout branch |
| `gitFetch()` | `git:fetch` | `void` | Fetch from remotes |
| `gitPull(remote, branch)` | `git:pull` | `Object` | Pull from remote |
| `gitPush(remote, branch)` | `git:push` | `void` | Push to remote |
| `gitMerge(branch)` | `git:merge` | `Object` | Merge branch |
| `gitAbortMerge()` | `git:abort-merge` | `void` | Abort merge |
| `gitStage(files)` | `git:stage` | `void` | Stage files |
| `gitStageAll()` | `git:stage-all` | `void` | Stage all changes |
| `gitUnstage(files)` | `git:unstage` | `void` | Unstage files |
| `gitDiff()` | `git:diff` | `Object` | Diff summary |
| `gitDiffFile(file, staged)` | `git:diff-file` | `string` | File diff |
| `gitCommit(message)` | `git:commit` | `Object` | Create commit |
| `gitAmend(message)` | `git:amend` | `Object` | Amend last commit |
| `gitRevert(hash)` | `git:revert` | `void` | Revert a commit |
| `gitRebase(branch)` | `git:rebase` | `void` | Rebase onto branch |
| `gitRebaseAbort()` | `git:rebase-abort` | `void` | Abort rebase |
| `gitRebaseContinue()` | `git:rebase-continue` | `void` | Continue rebase |
| `gitIsRebasing()` | `git:is-rebasing` | `boolean` | Check rebase state |
| `gitTags()` | `git:tags` | `Array` | List tags |
| `gitCreateTag(name, message)` | `git:create-tag` | `void` | Create annotated tag |
| `gitDeleteTag(name)` | `git:delete-tag` | `void` | Delete tag |
| `gitPushTag(name)` | `git:push-tag` | `void` | Push single tag |
| `gitPushAllTags()` | `git:push-all-tags` | `void` | Push all tags |
| `gitStashList()` | `git:stash-list` | `Array` | List stash entries |
| `gitStash(message)` | `git:stash` | `void` | Stash changes |
| `gitStashPop(index)` | `git:stash-pop` | `void` | Pop stash entry |
| `gitStashDrop(index)` | `git:stash-drop` | `void` | Drop stash entry |
| `gitDeleteBranch(name, force)` | `git:delete-branch` | `void` | Delete local branch |
| `gitDeleteRemoteBranch(name)` | `git:delete-remote-branch` | `void` | Delete remote branch |
| `gitShowCommit(hash)` | `git:show-commit` | `Object` | Commit details + files |
| `gitCommitDiff(hash)` | `git:commit-diff` | `string` | Full diff for commit |
| `gitCommitFileDiff(hash, file)` | `git:commit-file-diff` | `string` | File diff in commit |
| `gitDiscardFile(file)` | `git:discard-file` | `void` | Discard file changes |
| `gitDiscardAll()` | `git:discard-all` | `void` | Reset hard + clean |
| `gitOpenMergeTool(file)` | `git:open-merge-tool` | `void` | Open merge tool |
| `gitHasGhCli()` | `git:has-gh-cli` | `boolean` | Check gh CLI available |
| `gitRemoteUrl()` | `git:remote-url` | `string\|null` | Get remote URL |
| `gitFileLog(file, limit)` | `git:file-log` | `Array` | File-specific history |
| `gitReadConflictFile(file)` | `git:read-conflict-file` | `string` | Read conflicted file |
| `gitResolveConflict(file, content)` | `git:resolve-conflict` | `void` | Write resolved content |

### Companion Server

| Method | Channel | Returns | Description |
|--------|---------|---------|-------------|
| `getCompanionInfo()` | `companion:get-info` | `Object` | Connection info (URL, token, QR) |
| `toggleCompanion(enabled)` | `companion:toggle` | `Object` | Enable/disable server |
| `regenerateCompanionToken()` | `companion:regenerate-token` | `Object` | New auth token |

### Menu Events (main → renderer)

| Method | Channel | Description |
|--------|---------|-------------|
| `onCloseActiveTab(cb)` | `close-active-tab` | Cmd+W pressed |
| `onNewTerminalTab(cb)` | `new-terminal-tab` | Cmd+T pressed |
| `onShowSettings(cb)` | `show-settings` | Cmd+, pressed |
| `onCompanionLaunchCommand(cb)` | `companion-launch-command` | Mobile companion triggered a command |

All `on*` methods return an unsubscribe function: `const unsub = window.api.onTerminalData(cb); unsub();`
