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
    const s = await this.git.status();
    return {
      current: s.current,
      tracking: s.tracking || null,
      ahead: s.ahead,
      behind: s.behind,
      isClean: s.isClean(),
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

  /** Checkout a branch. */
  async checkout(branch) {
    await this.git.checkout(branch);
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
