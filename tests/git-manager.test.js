import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { GitManager } from '../lib/git-manager.js';

let tmpDir;

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'git-manager-test-'));
}

function gitInit(dir) {
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test User"', { cwd: dir, stdio: 'ignore' });
  execSync('git config commit.gpgsign false', { cwd: dir, stdio: 'ignore' });
}

function writeFile(relativePath, content) {
  const fullPath = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  return fullPath;
}

function gitAdd(dir, file) {
  execSync(`git add ${file}`, { cwd: dir, stdio: 'ignore' });
}

function gitCommit(dir, message) {
  execSync(`git commit -m "${message}"`, { cwd: dir, stdio: 'ignore' });
}

beforeEach(() => {
  tmpDir = createTmpDir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── isRepo ─────────────────────────────────────────────────────────────

describe('GitManager.isRepo', () => {
  it('returns true for a git repository', async () => {
    gitInit(tmpDir);
    const gm = new GitManager(tmpDir);
    expect(await gm.isRepo()).toBe(true);
  });

  it('returns false for a non-git directory', async () => {
    const gm = new GitManager(tmpDir);
    expect(await gm.isRepo()).toBe(false);
  });

  it('returns false for a non-existent path', async () => {
    const gm = new GitManager(path.join(tmpDir, 'nonexistent'));
    expect(await gm.isRepo()).toBe(false);
  });
});

// ── status ─────────────────────────────────────────────────────────────

describe('GitManager.status', () => {
  it('returns status for a clean repo', async () => {
    gitInit(tmpDir);
    writeFile('file.txt', 'hello');
    gitAdd(tmpDir, 'file.txt');
    gitCommit(tmpDir, 'initial commit');

    const gm = new GitManager(tmpDir);
    const status = await gm.status();

    expect(status.current).toBeTruthy();
    expect(status.isClean).toBe(true);
    expect(status.files).toEqual([]);
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
  });

  it('reports modified files', async () => {
    gitInit(tmpDir);
    writeFile('file.txt', 'hello');
    gitAdd(tmpDir, 'file.txt');
    gitCommit(tmpDir, 'initial commit');

    // Modify the file
    writeFile('file.txt', 'changed');

    const gm = new GitManager(tmpDir);
    const status = await gm.status();

    expect(status.isClean).toBe(false);
    expect(status.files.length).toBe(1);
    expect(status.files[0].path).toBe('file.txt');
  });

  it('reports untracked files', async () => {
    gitInit(tmpDir);
    writeFile('tracked.txt', 'hello');
    gitAdd(tmpDir, 'tracked.txt');
    gitCommit(tmpDir, 'initial commit');

    // Add untracked file
    writeFile('untracked.txt', 'new');

    const gm = new GitManager(tmpDir);
    const status = await gm.status();

    expect(status.isClean).toBe(false);
    expect(status.files.some(f => f.path === 'untracked.txt')).toBe(true);
  });
});

// ── branches ───────────────────────────────────────────────────────────

describe('GitManager.branches', () => {
  it('lists local branches and identifies current', async () => {
    gitInit(tmpDir);
    writeFile('file.txt', 'hello');
    gitAdd(tmpDir, 'file.txt');
    gitCommit(tmpDir, 'initial commit');

    const gm = new GitManager(tmpDir);
    const result = await gm.branches();

    expect(result.current).toBeTruthy();
    expect(result.local.length).toBeGreaterThanOrEqual(1);
    expect(result.local.some(b => b.current === true)).toBe(true);
    expect(Array.isArray(result.remote)).toBe(true);
  });

  it('lists multiple branches', async () => {
    gitInit(tmpDir);
    writeFile('file.txt', 'hello');
    gitAdd(tmpDir, 'file.txt');
    gitCommit(tmpDir, 'initial commit');

    execSync('git branch feature-test', { cwd: tmpDir, stdio: 'ignore' });

    const gm = new GitManager(tmpDir);
    const result = await gm.branches();

    expect(result.local.length).toBe(2);
    const branchNames = result.local.map(b => b.name);
    expect(branchNames).toContain('feature-test');
  });
});

// ── log ────────────────────────────────────────────────────────────────

describe('GitManager.log', () => {
  it('returns empty array for repo with no commits', async () => {
    gitInit(tmpDir);
    const gm = new GitManager(tmpDir);
    const log = await gm.log();
    expect(log).toEqual([]);
  });

  it('returns commits with expected fields', async () => {
    gitInit(tmpDir);
    writeFile('file.txt', 'hello');
    gitAdd(tmpDir, 'file.txt');
    gitCommit(tmpDir, 'initial commit');

    const gm = new GitManager(tmpDir);
    const log = await gm.log();

    expect(log.length).toBe(1);
    expect(log[0]).toHaveProperty('hash');
    expect(log[0]).toHaveProperty('hashShort');
    expect(log[0]).toHaveProperty('date');
    expect(log[0]).toHaveProperty('message', 'initial commit');
    expect(log[0]).toHaveProperty('author', 'Test User');
    expect(log[0].hashShort).toHaveLength(7);
  });

  it('respects the limit parameter', async () => {
    gitInit(tmpDir);
    for (let i = 1; i <= 5; i++) {
      writeFile(`file${i}.txt`, `content ${i}`);
      gitAdd(tmpDir, `file${i}.txt`);
      gitCommit(tmpDir, `commit ${i}`);
    }

    const gm = new GitManager(tmpDir);
    const log = await gm.log(3);

    expect(log.length).toBe(3);
    expect(log[0].message).toBe('commit 5'); // most recent first
  });

  it('returns commits in reverse chronological order', async () => {
    gitInit(tmpDir);
    for (let i = 1; i <= 3; i++) {
      writeFile(`file${i}.txt`, `content ${i}`);
      gitAdd(tmpDir, `file${i}.txt`);
      gitCommit(tmpDir, `commit ${i}`);
    }

    const gm = new GitManager(tmpDir);
    const log = await gm.log();

    expect(log[0].message).toBe('commit 3');
    expect(log[1].message).toBe('commit 2');
    expect(log[2].message).toBe('commit 1');
  });
});

// ── checkout ──────────────────────────────────────────────────────────

describe('GitManager.checkout', () => {
  it('switches to an existing branch', async () => {
    gitInit(tmpDir);
    writeFile('file.txt', 'hello');
    gitAdd(tmpDir, 'file.txt');
    gitCommit(tmpDir, 'initial commit');
    execSync('git branch feature', { cwd: tmpDir, stdio: 'ignore' });

    const gm = new GitManager(tmpDir);
    const status = await gm.checkout('feature');

    expect(status.current).toBe('feature');
  });

  it('throws when checking out non-existent branch', async () => {
    gitInit(tmpDir);
    writeFile('file.txt', 'hello');
    gitAdd(tmpDir, 'file.txt');
    gitCommit(tmpDir, 'initial commit');

    const gm = new GitManager(tmpDir);
    await expect(gm.checkout('nonexistent')).rejects.toThrow();
  });
});

// ── fetch ─────────────────────────────────────────────────────────────

describe('GitManager.fetch', () => {
  it('runs without error on a repo with no remotes', async () => {
    gitInit(tmpDir);
    writeFile('file.txt', 'hello');
    gitAdd(tmpDir, 'file.txt');
    gitCommit(tmpDir, 'initial commit');

    const gm = new GitManager(tmpDir);
    // fetch with no remotes should not throw
    await expect(gm.fetch()).resolves.not.toThrow();
  });
});

// ── pull ──────────────────────────────────────────────────────────────

describe('GitManager.pull', () => {
  it('pulls from a local remote', async () => {
    // Create a "remote" repo
    const remoteDir = createTmpDir();
    gitInit(remoteDir);
    fs.writeFileSync(path.join(remoteDir, 'file.txt'), 'hello');
    execSync('git add . && git commit -m "init"', { cwd: remoteDir, stdio: 'ignore' });

    // Clone it
    execSync(`git clone "${remoteDir}" cloned`, { cwd: tmpDir, stdio: 'ignore' });
    const clonedDir = path.join(tmpDir, 'cloned');
    execSync('git config user.email "test@test.com"', { cwd: clonedDir, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: clonedDir, stdio: 'ignore' });

    // Add a commit to the remote
    fs.writeFileSync(path.join(remoteDir, 'file.txt'), 'updated');
    execSync('git add . && git commit -m "update"', { cwd: remoteDir, stdio: 'ignore' });

    // Pull in the clone
    const gm = new GitManager(clonedDir);
    const result = await gm.pull();

    expect(result.files).toContain('file.txt');

    // Cleanup remote
    fs.rmSync(remoteDir, { recursive: true, force: true });
  });
});

// ── push ──────────────────────────────────────────────────────────────

describe('GitManager.push', () => {

  it('pushes to a local remote', async () => {
    // Create a bare "remote" repo
    const remoteDir = createTmpDir();
    execSync('git init --bare', { cwd: remoteDir, stdio: 'ignore' });

    // Clone it
    execSync(`git clone "${remoteDir}" cloned`, { cwd: tmpDir, stdio: 'ignore' });
    const clonedDir = path.join(tmpDir, 'cloned');
    execSync('git config user.email "test@test.com"', { cwd: clonedDir, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: clonedDir, stdio: 'ignore' });
    execSync('git config commit.gpgsign false', { cwd: clonedDir, stdio: 'ignore' });

    // Make a commit and push
    fs.writeFileSync(path.join(clonedDir, 'file.txt'), 'hello');
    execSync('git add . && git commit -m "init"', { cwd: clonedDir, stdio: 'ignore' });

    const gm = new GitManager(clonedDir);
    await expect(gm.push()).resolves.not.toThrow();

    // Verify remote got the commit
    const remoteLog = execSync('git log --oneline', { cwd: remoteDir }).toString();
    expect(remoteLog).toContain('init');

    // Cleanup remote
    fs.rmSync(remoteDir, { recursive: true, force: true });
  });
});

// ── stage / unstage ───────────────────────────────────────────────────

describe('GitManager.stage / unstage', () => {
  it('stages a specific file', async () => {
    gitInit(tmpDir);
    writeFile('a.txt', 'hello');
    gitAdd(tmpDir, 'a.txt');
    gitCommit(tmpDir, 'init');

    writeFile('a.txt', 'changed');
    writeFile('b.txt', 'new');

    const gm = new GitManager(tmpDir);
    await gm.stage(['a.txt']);
    const status = await gm.status();
    const staged = status.files.filter(f => f.index === 'M');
    expect(staged.some(f => f.path === 'a.txt')).toBe(true);
  });

  it('stages all files', async () => {
    gitInit(tmpDir);
    writeFile('a.txt', 'hello');
    gitAdd(tmpDir, 'a.txt');
    gitCommit(tmpDir, 'init');

    writeFile('a.txt', 'changed');
    writeFile('b.txt', 'new');

    const gm = new GitManager(tmpDir);
    await gm.stageAll();
    const status = await gm.status();
    const unstaged = status.files.filter(f => f.working_dir && f.working_dir !== ' ');
    expect(unstaged.length).toBe(0);
  });

  it('unstages a file', async () => {
    gitInit(tmpDir);
    writeFile('a.txt', 'hello');
    gitAdd(tmpDir, 'a.txt');
    gitCommit(tmpDir, 'init');

    writeFile('a.txt', 'changed');
    const gm = new GitManager(tmpDir);
    await gm.stage(['a.txt']);

    let status = await gm.status();
    expect(status.files.some(f => f.path === 'a.txt' && f.index === 'M')).toBe(true);

    await gm.unstage(['a.txt']);
    status = await gm.status();
    expect(status.files.some(f => f.path === 'a.txt' && f.index === 'M')).toBe(false);
  });
});

// ── diff ──────────────────────────────────────────────────────────────

describe('GitManager.diff', () => {
  it('returns diff summary', async () => {
    gitInit(tmpDir);
    writeFile('a.txt', 'hello');
    gitAdd(tmpDir, 'a.txt');
    gitCommit(tmpDir, 'init');

    writeFile('a.txt', 'changed');
    const gm = new GitManager(tmpDir);
    const diff = await gm.diff();
    expect(diff.unstaged).toContain('a.txt');
  });

  it('shows staged diff', async () => {
    gitInit(tmpDir);
    writeFile('a.txt', 'hello');
    gitAdd(tmpDir, 'a.txt');
    gitCommit(tmpDir, 'init');

    writeFile('a.txt', 'changed');
    const gm = new GitManager(tmpDir);
    await gm.stage(['a.txt']);
    const diff = await gm.diff();
    expect(diff.staged).toContain('a.txt');
  });
});

// ── diffFile ──────────────────────────────────────────────────────────

describe('GitManager.diffFile', () => {
  it('returns file diff content', async () => {
    gitInit(tmpDir);
    writeFile('a.txt', 'hello\n');
    gitAdd(tmpDir, 'a.txt');
    gitCommit(tmpDir, 'init');

    writeFile('a.txt', 'changed\n');
    const gm = new GitManager(tmpDir);
    const diff = await gm.diffFile('a.txt');
    expect(diff).toContain('-hello');
    expect(diff).toContain('+changed');
  });
});

// ── commit ────────────────────────────────────────────────────────────

describe('GitManager.commit', () => {
  it('creates a commit with given message', async () => {
    gitInit(tmpDir);
    writeFile('a.txt', 'hello');
    gitAdd(tmpDir, 'a.txt');
    gitCommit(tmpDir, 'init');

    writeFile('a.txt', 'changed');
    const gm = new GitManager(tmpDir);
    await gm.stage(['a.txt']);
    const result = await gm.commit('feat: update a');

    expect(result.hash).toBeTruthy();

    const log = await gm.log(1);
    expect(log[0].message).toBe('feat: update a');
  });

  it('returns empty hash with nothing staged', async () => {
    gitInit(tmpDir);
    writeFile('a.txt', 'hello');
    gitAdd(tmpDir, 'a.txt');
    gitCommit(tmpDir, 'init');

    const gm = new GitManager(tmpDir);
    const result = await gm.commit('empty');
    expect(result.hash).toBe('');
  });
});

// ── merge ─────────────────────────────────────────────────────────────

describe('GitManager.merge', () => {
  it('merges a branch into current', async () => {
    gitInit(tmpDir);
    writeFile('file.txt', 'hello');
    gitAdd(tmpDir, 'file.txt');
    gitCommit(tmpDir, 'init');

    // Create and commit on feature branch
    execSync('git checkout -b feature', { cwd: tmpDir, stdio: 'ignore' });
    writeFile('feature.txt', 'feature work');
    gitAdd(tmpDir, 'feature.txt');
    gitCommit(tmpDir, 'feature commit');

    // Switch back to main/master and merge
    execSync('git checkout master || git checkout main', { cwd: tmpDir, stdio: 'ignore', shell: true });

    const gm = new GitManager(tmpDir);
    const result = await gm.merge('feature');

    expect(result.success).toBe(true);

    // Verify feature file exists after merge
    const featureFile = fs.existsSync(path.join(tmpDir, 'feature.txt'));
    expect(featureFile).toBe(true);
  });

  it('reports conflicts on conflicting merge', async () => {
    gitInit(tmpDir);
    writeFile('file.txt', 'original');
    gitAdd(tmpDir, 'file.txt');
    gitCommit(tmpDir, 'init');

    // Create conflicting changes on feature branch
    execSync('git checkout -b conflict-branch', { cwd: tmpDir, stdio: 'ignore' });
    writeFile('file.txt', 'conflict version A');
    gitAdd(tmpDir, 'file.txt');
    gitCommit(tmpDir, 'conflict A');

    // Go back and make conflicting change on main
    execSync('git checkout master || git checkout main', { cwd: tmpDir, stdio: 'ignore', shell: true });
    writeFile('file.txt', 'conflict version B');
    gitAdd(tmpDir, 'file.txt');
    gitCommit(tmpDir, 'conflict B');

    const gm = new GitManager(tmpDir);
    const result = await gm.merge('conflict-branch');

    expect(result.success).toBe(false);
    expect(result.conflicts.length).toBeGreaterThan(0);

    // Status should show merging
    const status = await gm.status();
    expect(status.merging).toBe(true);

    // Abort merge to clean up
    await gm.abortMerge();
    const statusAfter = await gm.status();
    expect(statusAfter.merging).toBe(false);
  });
});

// ── tags ──────────────────────────────────────────────────────────────

describe('GitManager.tags', () => {
  it('returns empty array when no tags exist', async () => {
    gitInit(tmpDir);
    writeFile('file.txt', 'hello');
    gitAdd(tmpDir, 'file.txt');
    gitCommit(tmpDir, 'init');

    const gm = new GitManager(tmpDir);
    const tags = await gm.tags();
    expect(tags).toEqual([]);
  });

  it('lists tags after creation', async () => {
    gitInit(tmpDir);
    writeFile('file.txt', 'hello');
    gitAdd(tmpDir, 'file.txt');
    gitCommit(tmpDir, 'init');

    const gm = new GitManager(tmpDir);
    await gm.createTag('v1.0.0', 'First release');
    await gm.createTag('v1.1.0');

    const tags = await gm.tags();
    expect(tags).toContain('v1.0.0');
    expect(tags).toContain('v1.1.0');
    expect(tags.length).toBe(2);
  });

  it('creates an annotated tag with message', async () => {
    gitInit(tmpDir);
    writeFile('file.txt', 'hello');
    gitAdd(tmpDir, 'file.txt');
    gitCommit(tmpDir, 'init');

    const gm = new GitManager(tmpDir);
    await gm.createTag('v2.0.0', 'Major release');

    // Verify tag exists and is annotated
    const tagInfo = execSync('git tag -l -n1 v2.0.0', { cwd: tmpDir }).toString().trim();
    expect(tagInfo).toContain('Major release');
  });

  it('creates a lightweight tag without message', async () => {
    gitInit(tmpDir);
    writeFile('file.txt', 'hello');
    gitAdd(tmpDir, 'file.txt');
    gitCommit(tmpDir, 'init');

    const gm = new GitManager(tmpDir);
    await gm.createTag('v0.1.0');

    const tags = await gm.tags();
    expect(tags).toContain('v0.1.0');
  });

  it('deletes a tag', async () => {
    gitInit(tmpDir);
    writeFile('file.txt', 'hello');
    gitAdd(tmpDir, 'file.txt');
    gitCommit(tmpDir, 'init');

    const gm = new GitManager(tmpDir);
    await gm.createTag('v1.0.0', 'Release');

    let tags = await gm.tags();
    expect(tags).toContain('v1.0.0');

    await gm.deleteTag('v1.0.0');
    tags = await gm.tags();
    expect(tags).not.toContain('v1.0.0');
  });

  it('pushes a tag to remote', async () => {
    // Create a bare remote
    const remoteDir = createTmpDir();
    execSync('git init --bare', { cwd: remoteDir, stdio: 'ignore' });

    // Clone it
    execSync(`git clone "${remoteDir}" cloned`, { cwd: tmpDir, stdio: 'ignore' });
    const clonedDir = path.join(tmpDir, 'cloned');
    execSync('git config user.email "test@test.com"', { cwd: clonedDir, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: clonedDir, stdio: 'ignore' });
    execSync('git config commit.gpgsign false', { cwd: clonedDir, stdio: 'ignore' });

    fs.writeFileSync(path.join(clonedDir, 'file.txt'), 'hello');
    execSync('git add . && git commit -m "init"', { cwd: clonedDir, stdio: 'ignore' });
    execSync('git push', { cwd: clonedDir, stdio: 'ignore' });

    const gm = new GitManager(clonedDir);
    await gm.createTag('v1.0.0', 'Release');
    await gm.pushTag('v1.0.0');

    // Verify remote has the tag
    const remoteTags = execSync('git tag', { cwd: remoteDir }).toString().trim();
    expect(remoteTags).toContain('v1.0.0');

    fs.rmSync(remoteDir, { recursive: true, force: true });
  });

  it('pushes all tags to remote', async () => {
    const remoteDir = createTmpDir();
    execSync('git init --bare', { cwd: remoteDir, stdio: 'ignore' });

    execSync(`git clone "${remoteDir}" cloned`, { cwd: tmpDir, stdio: 'ignore' });
    const clonedDir = path.join(tmpDir, 'cloned');
    execSync('git config user.email "test@test.com"', { cwd: clonedDir, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: clonedDir, stdio: 'ignore' });
    execSync('git config commit.gpgsign false', { cwd: clonedDir, stdio: 'ignore' });

    fs.writeFileSync(path.join(clonedDir, 'file.txt'), 'hello');
    execSync('git add . && git commit -m "init"', { cwd: clonedDir, stdio: 'ignore' });
    execSync('git push', { cwd: clonedDir, stdio: 'ignore' });

    const gm = new GitManager(clonedDir);
    await gm.createTag('v1.0.0', 'First');
    await gm.createTag('v2.0.0', 'Second');
    await gm.pushAllTags();

    const remoteTags = execSync('git tag', { cwd: remoteDir }).toString().trim();
    expect(remoteTags).toContain('v1.0.0');
    expect(remoteTags).toContain('v2.0.0');

    fs.rmSync(remoteDir, { recursive: true, force: true });
  });
});

// ── hasGhCli ─────────────────────────────────────────────────────────

describe('GitManager.hasGhCli', () => {
  it('returns a boolean', async () => {
    gitInit(tmpDir);
    writeFile('file.txt', 'hello');
    gitAdd(tmpDir, 'file.txt');
    gitCommit(tmpDir, 'init');

    const gm = new GitManager(tmpDir);
    const result = await gm.hasGhCli();
    expect(typeof result).toBe('boolean');
  });
});

// ── getRemoteUrl ─────────────────────────────────────────────────────

describe('GitManager.getRemoteUrl', () => {
  it('returns null for repo with no remotes', async () => {
    gitInit(tmpDir);
    writeFile('file.txt', 'hello');
    gitAdd(tmpDir, 'file.txt');
    gitCommit(tmpDir, 'init');

    const gm = new GitManager(tmpDir);
    const url = await gm.getRemoteUrl();
    expect(url).toBeNull();
  });

  it('returns remote URL for cloned repo', async () => {
    const remoteDir = createTmpDir();
    execSync('git init --bare', { cwd: remoteDir, stdio: 'ignore' });

    execSync(`git clone "${remoteDir}" cloned`, { cwd: tmpDir, stdio: 'ignore' });
    const clonedDir = path.join(tmpDir, 'cloned');
    execSync('git config user.email "test@test.com"', { cwd: clonedDir, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: clonedDir, stdio: 'ignore' });
    execSync('git config commit.gpgsign false', { cwd: clonedDir, stdio: 'ignore' });

    fs.writeFileSync(path.join(clonedDir, 'file.txt'), 'hello');
    execSync('git add . && git commit -m "init"', { cwd: clonedDir, stdio: 'ignore' });
    execSync('git push', { cwd: clonedDir, stdio: 'ignore' });

    const gm = new GitManager(clonedDir);
    const url = await gm.getRemoteUrl();
    expect(url).toContain(remoteDir);

    fs.rmSync(remoteDir, { recursive: true, force: true });
  });
});
