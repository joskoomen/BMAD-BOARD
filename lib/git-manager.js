/**
 * GitManager — Git operations abstraction using simple-git.
 *
 * Provides a clean async API for git operations scoped to a project path.
 * Used by IPC handlers in main.js to serve the renderer's Git view.
 */
const simpleGit = require('simple-git');

class GitManager {
  /**
   * @param {string} projectPath - Absolute path to the git repository
   */
  constructor(projectPath) {
    this.projectPath = projectPath;
    this.git = null;
    try {
      this.git = simpleGit(projectPath);
    } catch {
      // Invalid or non-existent path — git stays null
    }
  }

  /**
   * Check if the project path is a git repository.
   * @returns {Promise<boolean>}
   */
  async isRepo() {
    if (!this.git) return false;
    try {
      return await this.git.checkIsRepo();
    } catch {
      return false;
    }
  }

  /**
   * Get the current repository status.
   * @returns {Promise<{current: string, tracking: string|null, files: Array, ahead: number, behind: number, isClean: boolean}>}
   */
  async status() {
    const fs = require('fs');
    const path = require('path');
    const s = await this.git.status();
    const merging = fs.existsSync(path.join(this.projectPath, '.git', 'MERGE_HEAD'));
    return {
      current: s.current,
      tracking: s.tracking || null,
      ahead: s.ahead,
      behind: s.behind,
      isClean: s.isClean(),
      merging,
      conflicted: s.conflicted || [],
      files: s.files.map(f => ({
        path: f.path,
        index: f.index,
        working_dir: f.working_dir
      }))
    };
  }

  /**
   * Get all branches (local and remote).
   * @returns {Promise<{current: string, local: Array<{name: string, current: boolean}>, remote: Array<{name: string, tracking: string}>}>}
   */
  async branches() {
    const b = await this.git.branch(['-a', '--no-color']);
    const local = [];
    const remote = [];

    for (const [name, info] of Object.entries(b.branches)) {
      if (name.startsWith('remotes/')) {
        // Skip HEAD pointer references like remotes/origin/HEAD
        if (name.endsWith('/HEAD')) continue;
        remote.push({
          name: name.replace(/^remotes\//, ''),
          tracking: name
        });
      } else {
        local.push({
          name,
          current: info.current
        });
      }
    }

    return { current: b.current, local, remote };
  }

  /** Checkout a branch. For remote branches, creates a local tracking branch. */
  async checkout(branch) {
    try {
      await this.git.checkout(branch);
    } catch {
      // If plain checkout fails, try creating a tracking branch from remote
      await this.git.checkout(['-b', branch, `origin/${branch}`]);
    }
    return this.status();
  }

  /** Fetch from all remotes. */
  async fetch() {
    await this.git.fetch(['--all', '--prune']);
  }

  /** Pull from remote (defaults to tracking remote/branch). */
  async pull(remote, branch) {
    const args = [];
    if (remote && branch) {
      args.push(remote, branch);
    }
    const result = await this.git.pull(...args);
    return {
      summary: result.summary,
      files: result.files || [],
    };
  }

  /** Push to remote (defaults to tracking remote/branch). */
  async push(remote, branch) {
    const args = [];
    if (remote && branch) {
      args.push(remote, branch);
    }
    await this.git.push(...args);
  }

  /** Merge a branch into the current branch. */
  async merge(branch) {
    try {
      const result = await this.git.merge([branch]);
      return { success: true, result: result?.result || 'success', conflicts: [] };
    } catch (err) {
      // Check for merge conflicts
      if (err.git) {
        const conflicts = err.git.conflicts || [];
        return { success: false, conflicts, message: err.message };
      }
      throw err;
    }
  }

  /** Abort an in-progress merge. */
  async abortMerge() {
    await this.git.merge(['--abort']);
  }

  /** Stage specific files. */
  async stage(files) {
    await this.git.add(files);
  }

  /** Stage all changes. */
  async stageAll() {
    await this.git.add('-A');
  }

  /** Unstage specific files. */
  async unstage(files) {
    await this.git.reset(['HEAD', '--', ...files]);
  }

  /** Get the diff summary (staged + unstaged). */
  async diff() {
    const [staged, unstaged] = await Promise.all([
      this.git.diff(['--cached', '--stat']),
      this.git.diff(['--stat']),
    ]);
    return { staged, unstaged };
  }

  /** Get diff for a specific file. */
  async diffFile(file, staged = false) {
    const args = staged ? ['--cached', '--', file] : ['--', file];
    return this.git.diff(args);
  }

  /** Create a commit with the given message. */
  async commit(message) {
    const result = await this.git.commit(message);
    return {
      hash: result.commit || '',
      summary: result.summary || {},
    };
  }

  /**
   * Get recent commit log for the current branch.
   * @param {number} [limit=25] - Maximum number of commits to return
   * @returns {Promise<Array<{hash: string, hashShort: string, date: string, message: string, author: string}>>}
   */
  async log(limit = 25) {
    try {
      const result = await this.git.log({ maxCount: limit });
      return (result.all || []).map(c => ({
        hash: c.hash,
        hashShort: c.hash.substring(0, 7),
        date: c.date,
        message: c.message,
        author: c.author_name
      }));
    } catch {
      // Empty repo with no commits
      return [];
    }
  }
}

module.exports = { GitManager };
