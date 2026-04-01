/**
 * Tests for terminal-launcher — macOS Terminal.app control via AppleScript.
 *
 * Uses _setExec to inject a mock exec function, avoiding CJS mocking issues.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openTerminal, openClaudeWithCommand, openPartyMode, _setExec } from '../lib/terminal-launcher.js';

describe('terminal-launcher', () => {
  let execMock;

  beforeEach(() => {
    execMock = vi.fn();
    _setExec(execMock);
  });

  describe('openTerminal', () => {
    it('calls osascript with AppleScript', async () => {
      execMock.mockImplementation((cmd, cb) => cb(null));
      await openTerminal('/tmp/project', 'ls');
      expect(execMock).toHaveBeenCalledOnce();
      expect(execMock.mock.calls[0][0]).toContain('osascript');
      expect(execMock.mock.calls[0][0]).toContain('Terminal');
    });

    it('includes cd to project path in script', async () => {
      execMock.mockImplementation((cmd, cb) => cb(null));
      await openTerminal('/tmp/my-project', 'npm test');
      expect(execMock.mock.calls[0][0]).toContain('/tmp/my-project');
      expect(execMock.mock.calls[0][0]).toContain('npm test');
    });

    it('falls back to open -a Terminal.app on osascript failure', async () => {
      execMock
        .mockImplementationOnce((cmd, cb) => cb(new Error('osascript failed')))
        .mockImplementationOnce((cmd, cb) => cb(null));
      await openTerminal('/tmp/project', 'ls');
      expect(execMock).toHaveBeenCalledTimes(2);
      expect(execMock.mock.calls[1][0]).toBe('open -a Terminal.app');
    });

    it('rejects when both methods fail', async () => {
      const err = new Error('all failed');
      execMock
        .mockImplementationOnce((cmd, cb) => cb(new Error('osascript failed')))
        .mockImplementationOnce((cmd, cb) => cb(err));
      await expect(openTerminal('/tmp/project', 'ls')).rejects.toThrow('all failed');
    });

    it('resolves on successful osascript', async () => {
      execMock.mockImplementation((cmd, cb) => cb(null));
      await expect(openTerminal('/tmp/project', 'ls')).resolves.toBeUndefined();
    });
  });

  describe('single-quote escaping', () => {
    it('resolves without error when project path contains single quotes', async () => {
      execMock.mockImplementation((cmd, cb) => cb(null));
      await expect(openTerminal("/tmp/O'Brien's project", 'ls')).resolves.toBeUndefined();
      expect(execMock).toHaveBeenCalledOnce();
    });

    it("applies the shell escape sequence \\' to single quotes in paths", async () => {
      execMock.mockImplementation((cmd, cb) => cb(null));
      await openTerminal("/tmp/O'Brien", 'ls');
      const cmd = execMock.mock.calls[0][0];
      // The shell escape replaces ' with '\'' in the embedded AppleScript
      expect(cmd).toContain("'\\''");
    });

    it('escapes single quotes in command without rejecting', async () => {
      execMock.mockImplementation((cmd, cb) => cb(null));
      await expect(openTerminal('/tmp/proj', "echo 'hello world'")).resolves.toBeUndefined();
      expect(execMock).toHaveBeenCalledOnce();
    });
  });

  describe('_setExec', () => {
    it('swaps exec implementation so new calls use the injected function', async () => {
      const first = vi.fn((cmd, cb) => cb(null));
      const second = vi.fn((cmd, cb) => cb(null));
      _setExec(first);
      await openTerminal('/tmp/a', 'ls');
      expect(first).toHaveBeenCalledOnce();
      expect(second).not.toHaveBeenCalled();

      _setExec(second);
      await openTerminal('/tmp/b', 'ls');
      expect(second).toHaveBeenCalledOnce();
      // first should still only have been called once
      expect(first).toHaveBeenCalledOnce();
    });
  });

  describe('openClaudeWithCommand', () => {
    it('delegates to openTerminal', async () => {
      execMock.mockImplementation((cmd, cb) => cb(null));
      await openClaudeWithCommand('/tmp/proj', 'claude "/dev"');
      expect(execMock.mock.calls[0][0]).toContain('/tmp/proj');
      expect(execMock.mock.calls[0][0]).toContain('claude');
    });

    it('passes the full claude command string through', async () => {
      execMock.mockImplementation((cmd, cb) => cb(null));
      await openClaudeWithCommand('/tmp/proj', 'claude "/implement 1-1-auth"');
      const cmd = execMock.mock.calls[0][0];
      expect(cmd).toContain('implement');
      expect(cmd).toContain('1-1-auth');
    });
  });

  describe('openPartyMode', () => {
    it('launches with retrospective command', async () => {
      execMock.mockImplementation((cmd, cb) => cb(null));
      await openPartyMode('/tmp/proj');
      expect(execMock.mock.calls[0][0]).toContain('retrospective');
    });

    it('uses the provided project path', async () => {
      execMock.mockImplementation((cmd, cb) => cb(null));
      await openPartyMode('/home/user/my-project');
      expect(execMock.mock.calls[0][0]).toContain('/home/user/my-project');
    });
  });
});