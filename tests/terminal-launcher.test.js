/**
 * Tests for terminal-launcher — macOS Terminal.app control via AppleScript.
 *
 * Uses _setExec to inject a mock exec function, avoiding CJS mocking issues.
 */

import { openTerminal, openClaudeWithCommand, openPartyMode, _setExec } from '../lib/terminal-launcher.js';

describe('terminal-launcher', () => {
  let execMock;

  beforeEach(() => {
    execMock = vi.fn();
    _setExec(execMock);
  });

  afterEach(() => {
    _setExec(null);
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

  describe('openClaudeWithCommand', () => {
    it('delegates to openTerminal', async () => {
      execMock.mockImplementation((cmd, cb) => cb(null));
      await openClaudeWithCommand('/tmp/proj', 'claude "/dev"');
      expect(execMock.mock.calls[0][0]).toContain('/tmp/proj');
      expect(execMock.mock.calls[0][0]).toContain('claude');
    });
  });

  describe('openPartyMode', () => {
    it('launches with retrospective command', async () => {
      execMock.mockImplementation((cmd, cb) => cb(null));
      await openPartyMode('/tmp/proj');
      expect(execMock.mock.calls[0][0]).toContain('retrospective');
    });
  });
});
