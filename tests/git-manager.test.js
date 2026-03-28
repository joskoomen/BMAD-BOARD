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
