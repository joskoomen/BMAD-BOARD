/**
 * Tests for TerminalManager — PTY session lifecycle management.
 *
 * Uses dependency injection (ptyProvider) to avoid needing to mock the
 * native node-pty module, which is difficult to mock via vitest with CJS.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TerminalManager } from '../lib/terminal-manager.js';

// ── Mock PTY factory ───────────────────────────────────────────────────

let lastSpawnArgs;

function createMockPty() {
  const listeners = { data: [], exit: [] };
  return {
    onData: (cb) => listeners.data.push(cb),
    onExit: (cb) => listeners.exit.push(cb),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    _emit(event, ...args) {
      for (const cb of listeners[event]) cb(...args);
    }
  };
}

function createMockPtyProvider(getMockPty) {
  return {
    spawn: (...args) => {
      lastSpawnArgs = args;
      return getMockPty();
    }
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('TerminalManager', () => {
  let manager;
  let mockPty;

  beforeEach(() => {
    mockPty = createMockPty();
    lastSpawnArgs = null;
    manager = new TerminalManager({ ptyProvider: createMockPtyProvider(() => mockPty) });
  });

  describe('constructor', () => {
    it('initializes with empty sessions', () => {
      expect(manager.sessions.size).toBe(0);
    });

    it('starts nextId at 1', () => {
      expect(manager.nextId).toBe(1);
    });
  });

  describe('create', () => {
    it('returns incrementing session IDs', () => {
      const id1 = manager.create({ cwd: '/tmp' });
      const id2 = manager.create({ cwd: '/tmp' });
      const id3 = manager.create({ cwd: '/tmp' });
      expect(id1).toBe(1);
      expect(id2).toBe(2);
      expect(id3).toBe(3);
    });

    it('stores session in sessions map', () => {
      const id = manager.create({ cwd: '/tmp' });
      expect(manager.sessions.has(id)).toBe(true);
      expect(manager.sessions.get(id).pty).toBe(mockPty);
    });

    it('passes cols and rows to pty.spawn', () => {
      manager.create({ cwd: '/tmp', cols: 100, rows: 40 });
      expect(lastSpawnArgs[2].cols).toBe(100);
      expect(lastSpawnArgs[2].rows).toBe(40);
    });

    it('uses default cols=120 and rows=30', () => {
      manager.create({ cwd: '/tmp' });
      expect(lastSpawnArgs[2].cols).toBe(120);
      expect(lastSpawnArgs[2].rows).toBe(30);
    });

    it('clamps cols=0 to 1', () => {
      manager.create({ cwd: '/tmp', cols: 0, rows: 10 });
      expect(lastSpawnArgs[2].cols).toBe(1);
    });

    it('clamps negative cols to 1', () => {
      manager.create({ cwd: '/tmp', cols: -5, rows: 10 });
      expect(lastSpawnArgs[2].cols).toBe(1);
    });

    it('floors fractional dimensions', () => {
      manager.create({ cwd: '/tmp', cols: 80.7, rows: 24.3 });
      expect(lastSpawnArgs[2].cols).toBe(80);
      expect(lastSpawnArgs[2].rows).toBe(24);
    });

    it('falls back to 120 cols when NaN', () => {
      manager.create({ cwd: '/tmp', cols: NaN, rows: 10 });
      expect(lastSpawnArgs[2].cols).toBe(120);
    });

    it('falls back to 30 rows when NaN', () => {
      manager.create({ cwd: '/tmp', cols: 80, rows: NaN });
      expect(lastSpawnArgs[2].rows).toBe(30);
    });

    it('sets TERM and COLORTERM env vars', () => {
      manager.create({ cwd: '/tmp' });
      expect(lastSpawnArgs[2].env.TERM).toBe('xterm-256color');
      expect(lastSpawnArgs[2].env.COLORTERM).toBe('truecolor');
    });

    it('sets xterm-256color as terminal name', () => {
      manager.create({ cwd: '/tmp' });
      expect(lastSpawnArgs[2].name).toBe('xterm-256color');
    });

    it('fires onData callback with session ID and data', () => {
      const onData = vi.fn();
      const id = manager.create({ cwd: '/tmp', onData });
      mockPty._emit('data', 'hello world');
      expect(onData).toHaveBeenCalledWith(id, 'hello world');
    });

    it('fires onExit callback with session ID, exitCode, signal', () => {
      const onExit = vi.fn();
      const id = manager.create({ cwd: '/tmp', onExit });
      mockPty._emit('exit', { exitCode: 0, signal: 0 });
      expect(onExit).toHaveBeenCalledWith(id, 0, 0);
    });

    it('removes session from map on exit', () => {
      const id = manager.create({ cwd: '/tmp', onExit: vi.fn() });
      expect(manager.sessions.has(id)).toBe(true);
      mockPty._emit('exit', { exitCode: 0, signal: 0 });
      expect(manager.sessions.has(id)).toBe(false);
    });

    it('does not throw when onData is undefined', () => {
      manager.create({ cwd: '/tmp' });
      expect(() => mockPty._emit('data', 'test')).not.toThrow();
    });

    it('does not throw when onExit is undefined', () => {
      manager.create({ cwd: '/tmp' });
      expect(() => mockPty._emit('exit', { exitCode: 1, signal: 9 })).not.toThrow();
    });
  });

  describe('write', () => {
    it('sends data to pty', () => {
      const id = manager.create({ cwd: '/tmp' });
      manager.write(id, 'ls -la\n');
      expect(mockPty.write).toHaveBeenCalledWith('ls -la\n');
    });

    it('is a no-op for nonexistent session', () => {
      expect(() => manager.write(999, 'test')).not.toThrow();
    });
  });

  describe('resize', () => {
    it('delegates to pty.resize with valid dimensions', () => {
      const id = manager.create({ cwd: '/tmp' });
      manager.resize(id, 200, 50);
      expect(mockPty.resize).toHaveBeenCalledWith(200, 50);
    });

    it('clamps dimensions same as create', () => {
      const id = manager.create({ cwd: '/tmp' });
      manager.resize(id, 0, -3);
      expect(mockPty.resize).toHaveBeenCalledWith(1, 1);
    });

    it('floors fractional dimensions on resize', () => {
      const id = manager.create({ cwd: '/tmp' });
      manager.resize(id, 80.9, 24.1);
      expect(mockPty.resize).toHaveBeenCalledWith(80, 24);
    });

    it('falls back to defaults when NaN', () => {
      const id = manager.create({ cwd: '/tmp' });
      manager.resize(id, NaN, NaN);
      expect(mockPty.resize).toHaveBeenCalledWith(120, 30);
    });

    it('is a no-op for nonexistent session', () => {
      expect(() => manager.resize(999, 80, 24)).not.toThrow();
    });
  });

  describe('kill', () => {
    it('kills the pty and removes session', () => {
      const id = manager.create({ cwd: '/tmp' });
      manager.kill(id);
      expect(mockPty.kill).toHaveBeenCalled();
      expect(manager.sessions.has(id)).toBe(false);
    });

    it('is a no-op for nonexistent session', () => {
      expect(() => manager.kill(999)).not.toThrow();
    });
  });

  describe('killAll', () => {
    it('kills all sessions', () => {
      const mocks = [];
      for (let i = 0; i < 3; i++) {
        const m = createMockPty();
        mocks.push(m);
        mockPty = m;
        manager = new TerminalManager({ ptyProvider: createMockPtyProvider(() => m) });
      }
      // Recreate with a provider that cycles through mocks
      let idx = 0;
      manager = new TerminalManager({
        ptyProvider: createMockPtyProvider(() => mocks[idx++])
      });

      manager.create({ cwd: '/tmp' });
      manager.create({ cwd: '/tmp' });
      manager.create({ cwd: '/tmp' });

      expect(manager.sessions.size).toBe(3);
      manager.killAll();
      expect(manager.sessions.size).toBe(0);
      for (const m of mocks) {
        expect(m.kill).toHaveBeenCalled();
      }
    });

    it('is a no-op when no sessions exist', () => {
      expect(() => manager.killAll()).not.toThrow();
      expect(manager.sessions.size).toBe(0);
    });
  });

  describe('has', () => {
    it('returns true for existing session', () => {
      const id = manager.create({ cwd: '/tmp' });
      expect(manager.has(id)).toBe(true);
    });

    it('returns false for nonexistent session', () => {
      expect(manager.has(999)).toBe(false);
    });

    it('returns false after session is killed', () => {
      const id = manager.create({ cwd: '/tmp' });
      manager.kill(id);
      expect(manager.has(id)).toBe(false);
    });
  });
});
