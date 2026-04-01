/**
 * Tests for the terminal:tab-meta IPC handler logic (main.js)
 * and the createPtyForTab story-context notification (terminal-renderer.js).
 *
 * These tests extract and verify the logic independently of Electron/xterm.js.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── terminal:tab-meta handler logic (extracted from main.js) ────────────
//
// The handler in main.js is:
//   ipcMain.on('terminal:tab-meta', (event, data) => {
//     if (companionServer && data?.sessionId) {
//       companionServer.shareTerminalStart(data.sessionId, {
//         storySlug: data.storySlug,
//         storyPhase: data.storyPhase
//       });
//     }
//   });

function handleTerminalTabMeta(companionServer, data) {
  if (companionServer && data?.sessionId) {
    companionServer.shareTerminalStart(data.sessionId, {
      storySlug: data.storySlug,
      storyPhase: data.storyPhase
    });
  }
}

describe('terminal:tab-meta IPC handler logic', () => {
  let mockCompanionServer;

  beforeEach(() => {
    mockCompanionServer = {
      shareTerminalStartCalls: [],
      shareTerminalStart(sessionId, opts) {
        this.shareTerminalStartCalls.push({ sessionId, opts });
      }
    };
  });

  it('calls shareTerminalStart with sessionId and story metadata', () => {
    handleTerminalTabMeta(mockCompanionServer, {
      sessionId: 42,
      storySlug: '1-1-my-story',
      storyPhase: 'in-progress'
    });

    expect(mockCompanionServer.shareTerminalStartCalls).toHaveLength(1);
    const call = mockCompanionServer.shareTerminalStartCalls[0];
    expect(call.sessionId).toBe(42);
    expect(call.opts.storySlug).toBe('1-1-my-story');
    expect(call.opts.storyPhase).toBe('in-progress');
  });

  it('does not call shareTerminalStart when companionServer is null', () => {
    handleTerminalTabMeta(null, {
      sessionId: 42,
      storySlug: '1-1-my-story',
      storyPhase: 'in-progress'
    });
    // No error thrown — silent no-op
  });

  it('does not call shareTerminalStart when companionServer is undefined', () => {
    handleTerminalTabMeta(undefined, {
      sessionId: 42,
      storySlug: '1-1-my-story'
    });
    // No error thrown — silent no-op
  });

  it('does not call shareTerminalStart when data has no sessionId', () => {
    handleTerminalTabMeta(mockCompanionServer, {
      storySlug: '1-1-my-story',
      storyPhase: 'review'
      // no sessionId
    });

    expect(mockCompanionServer.shareTerminalStartCalls).toHaveLength(0);
  });

  it('does not call shareTerminalStart when data is null', () => {
    handleTerminalTabMeta(mockCompanionServer, null);
    expect(mockCompanionServer.shareTerminalStartCalls).toHaveLength(0);
  });

  it('does not call shareTerminalStart when data is undefined', () => {
    handleTerminalTabMeta(mockCompanionServer, undefined);
    expect(mockCompanionServer.shareTerminalStartCalls).toHaveLength(0);
  });

  it('passes storyPhase correctly even when storySlug is absent', () => {
    handleTerminalTabMeta(mockCompanionServer, {
      sessionId: 99,
      storyPhase: 'review'
      // no storySlug
    });

    expect(mockCompanionServer.shareTerminalStartCalls).toHaveLength(1);
    const call = mockCompanionServer.shareTerminalStartCalls[0];
    expect(call.opts.storySlug).toBeUndefined();
    expect(call.opts.storyPhase).toBe('review');
  });

  it('passes sessionId 0 as falsy — does not invoke shareTerminalStart', () => {
    // sessionId of 0 is falsy, the guard `data?.sessionId` prevents the call
    handleTerminalTabMeta(mockCompanionServer, {
      sessionId: 0,
      storySlug: '1-1-story'
    });

    expect(mockCompanionServer.shareTerminalStartCalls).toHaveLength(0);
  });
});

// ── createPtyForTab story-context notification (terminal-renderer.js) ────
//
// The change in createPtyForTab:
//   if (tab.storySlug) {
//     window.api.terminalTabMeta({
//       sessionId: result.id,
//       storySlug: tab.storySlug,
//       storyPhase: tab.storyPhase
//     });
//   }

// Extract the notification logic as a standalone function matching the PR diff.
async function notifyTabMetaIfNeeded(tab, result, api) {
  if (tab.storySlug) {
    api.terminalTabMeta({
      sessionId: result.id,
      storySlug: tab.storySlug,
      storyPhase: tab.storyPhase
    });
  }
}

describe('createPtyForTab story-context notification logic', () => {
  it('calls terminalTabMeta with correct payload when tab has storySlug', async () => {
    const mockApi = { terminalTabMeta: vi.fn() };
    const tab = { storySlug: '2-3-feature', storyPhase: 'in-progress' };
    const result = { id: 7 };

    await notifyTabMetaIfNeeded(tab, result, mockApi);

    expect(mockApi.terminalTabMeta).toHaveBeenCalledTimes(1);
    expect(mockApi.terminalTabMeta).toHaveBeenCalledWith({
      sessionId: 7,
      storySlug: '2-3-feature',
      storyPhase: 'in-progress'
    });
  });

  it('does NOT call terminalTabMeta when tab has no storySlug', async () => {
    const mockApi = { terminalTabMeta: vi.fn() };
    const tab = { storyPhase: 'in-progress' }; // no storySlug
    const result = { id: 8 };

    await notifyTabMetaIfNeeded(tab, result, mockApi);

    expect(mockApi.terminalTabMeta).not.toHaveBeenCalled();
  });

  it('does NOT call terminalTabMeta when storySlug is empty string', async () => {
    const mockApi = { terminalTabMeta: vi.fn() };
    const tab = { storySlug: '', storyPhase: 'in-progress' };
    const result = { id: 9 };

    await notifyTabMetaIfNeeded(tab, result, mockApi);

    expect(mockApi.terminalTabMeta).not.toHaveBeenCalled();
  });

  it('passes storyPhase as undefined when tab has no storyPhase', async () => {
    const mockApi = { terminalTabMeta: vi.fn() };
    const tab = { storySlug: '1-1-story' }; // no storyPhase
    const result = { id: 10 };

    await notifyTabMetaIfNeeded(tab, result, mockApi);

    expect(mockApi.terminalTabMeta).toHaveBeenCalledWith({
      sessionId: 10,
      storySlug: '1-1-story',
      storyPhase: undefined
    });
  });

  it('uses the sessionId from the PTY creation result', async () => {
    const mockApi = { terminalTabMeta: vi.fn() };
    const tab = { storySlug: '3-2-bugfix', storyPhase: 'review' };
    const result = { id: 42 };

    await notifyTabMetaIfNeeded(tab, result, mockApi);

    expect(mockApi.terminalTabMeta.mock.calls[0][0].sessionId).toBe(42);
  });
});

// ── preload.js: terminalTabMeta bridge ───────────────────────────────────
//
// The change in preload.js adds:
//   terminalTabMeta: (data) => ipcRenderer.send('terminal:tab-meta', data)
//
// This is a thin wrapper; we test the contract it fulfils.

describe('preload terminalTabMeta bridge contract', () => {
  it('forwards data payload to ipcRenderer.send with correct channel', () => {
    const mockIpcRenderer = { send: vi.fn() };

    // Simulate the preload binding
    const terminalTabMeta = (data) => mockIpcRenderer.send('terminal:tab-meta', data);

    const payload = { sessionId: 5, storySlug: '4-1-task', storyPhase: 'done' };
    terminalTabMeta(payload);

    expect(mockIpcRenderer.send).toHaveBeenCalledTimes(1);
    expect(mockIpcRenderer.send).toHaveBeenCalledWith('terminal:tab-meta', payload);
  });

  it('sends undefined data when called without arguments', () => {
    const mockIpcRenderer = { send: vi.fn() };
    const terminalTabMeta = (data) => mockIpcRenderer.send('terminal:tab-meta', data);

    terminalTabMeta(undefined);

    expect(mockIpcRenderer.send).toHaveBeenCalledWith('terminal:tab-meta', undefined);
  });
});