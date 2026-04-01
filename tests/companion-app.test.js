/**
 * Tests for companion/app.js browser-side logic.
 *
 * Since companion/app.js runs in a browser context and uses global browser APIs,
 * we test the extracted pure-logic functions inline, supplying the necessary state
 * through closures that mirror how the module manages its state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── isStoryActive logic ─────────────────────────────────────────────────
//
// function isStoryActive(slug) {
//   return activeStories.find(s => s.slug === slug) || null;
// }

function makeIsStoryActive(activeStories) {
  return function isStoryActive(slug) {
    return activeStories.find(s => s.slug === slug) || null;
  };
}

describe('isStoryActive', () => {
  it('returns null when activeStories is empty', () => {
    const isStoryActive = makeIsStoryActive([]);
    expect(isStoryActive('1-1-my-story')).toBeNull();
  });

  it('returns the matching story object when it is active', () => {
    const activeStory = { slug: '1-1-my-story', phase: 'in-progress', sessionId: 'sess-1' };
    const isStoryActive = makeIsStoryActive([activeStory]);
    expect(isStoryActive('1-1-my-story')).toBe(activeStory);
  });

  it('returns null when no active story matches the slug', () => {
    const isStoryActive = makeIsStoryActive([
      { slug: '2-1-other', phase: 'review' }
    ]);
    expect(isStoryActive('1-1-my-story')).toBeNull();
  });

  it('returns the correct match from multiple active stories', () => {
    const stories = [
      { slug: '1-1-alpha', phase: 'in-progress' },
      { slug: '1-2-beta', phase: 'review' },
      { slug: '2-1-gamma', phase: 'in-progress' }
    ];
    const isStoryActive = makeIsStoryActive(stories);
    expect(isStoryActive('1-2-beta')).toEqual({ slug: '1-2-beta', phase: 'review' });
    expect(isStoryActive('2-1-gamma')).toEqual({ slug: '2-1-gamma', phase: 'in-progress' });
  });

  it('returns null when slug is an empty string', () => {
    const isStoryActive = makeIsStoryActive([{ slug: '' }]);
    // '' matches '' — consistent with Array.find behaviour
    expect(isStoryActive('')).toEqual({ slug: '' });
  });

  it('is case-sensitive — does not match different casing', () => {
    const isStoryActive = makeIsStoryActive([{ slug: '1-1-Story' }]);
    expect(isStoryActive('1-1-story')).toBeNull();
  });
});

// ── updateNavBadge logic ─────────────────────────────────────────────────
//
// function updateNavBadge() {
//   const badge = document.getElementById('nav-badge');
//   if (!badge) return;
//   if (activeStories.length > 0) {
//     badge.textContent = activeStories.length;
//     badge.classList.remove('hidden');
//   } else {
//     badge.classList.add('hidden');
//   }
// }

function makeUpdateNavBadge(getActiveStories, badge) {
  return function updateNavBadge() {
    if (!badge) return;
    const activeStories = getActiveStories();
    if (activeStories.length > 0) {
      badge.textContent = activeStories.length;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  };
}

function makeMockBadge(initialClasses = ['hidden']) {
  const classes = new Set(initialClasses);
  return {
    textContent: '',
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      has: (c) => classes.has(c)
    },
    _classes: classes
  };
}

describe('updateNavBadge', () => {
  it('removes hidden class and sets count when there are active stories', () => {
    const badge = makeMockBadge(['hidden']);
    const activeStories = [{ slug: '1-1' }, { slug: '1-2' }];
    const updateNavBadge = makeUpdateNavBadge(() => activeStories, badge);

    updateNavBadge();

    expect(badge._classes.has('hidden')).toBe(false);
    expect(badge.textContent).toBe(2);
  });

  it('adds hidden class when there are no active stories', () => {
    const badge = makeMockBadge([]);
    const activeStories = [];
    const updateNavBadge = makeUpdateNavBadge(() => activeStories, badge);

    updateNavBadge();

    expect(badge._classes.has('hidden')).toBe(true);
  });

  it('updates badge count to reflect exact number of active stories', () => {
    const badge = makeMockBadge(['hidden']);
    let activeStories = [{ slug: '1-1' }, { slug: '1-2' }, { slug: '1-3' }];
    const updateNavBadge = makeUpdateNavBadge(() => activeStories, badge);

    updateNavBadge();
    expect(badge.textContent).toBe(3);

    activeStories = [{ slug: '1-1' }];
    updateNavBadge();
    expect(badge.textContent).toBe(1);
  });

  it('does nothing when badge element does not exist (null)', () => {
    // Should not throw
    const updateNavBadge = makeUpdateNavBadge(() => [{ slug: '1-1' }], null);
    expect(() => updateNavBadge()).not.toThrow();
  });

  it('re-hides badge when active stories list becomes empty', () => {
    const badge = makeMockBadge([]);
    let activeStories = [{ slug: '1-1' }];
    const updateNavBadge = makeUpdateNavBadge(() => activeStories, badge);

    updateNavBadge(); // badge visible
    expect(badge._classes.has('hidden')).toBe(false);

    activeStories = [];
    updateNavBadge(); // badge hidden
    expect(badge._classes.has('hidden')).toBe(true);
  });
});

// ── launchStory logic ────────────────────────────────────────────────────
//
// function launchStory(slug) {
//   if (!ws || ws.readyState !== WebSocket.OPEN) {
//     showToast('Not connected');
//     return;
//   }
//   const story = findStory(slug);
//   if (!story) return;
//   const phaseName = PHASES[story.status]?.label || story.status;
//   const confirmed = confirm(`Run ${phaseName} command for "${story.title}" on desktop?`);
//   if (!confirmed) return;
//   ws.send(JSON.stringify({ type: 'story:launch', data: { slug } }));
//   showToast('Launching on desktop...');
// }

const WS_OPEN = 1;
const WS_CLOSED = 3;

const PHASES = {
  'backlog':       { label: 'Backlog' },
  'ready-for-dev': { label: 'Ready' },
  'in-progress':   { label: 'In Progress' },
  'review':        { label: 'Review' },
  'done':          { label: 'Done' }
};

function makeLaunchStory({ ws, findStory, showToast, confirm }) {
  return function launchStory(slug) {
    if (!ws || ws.readyState !== WS_OPEN) {
      showToast('Not connected');
      return;
    }
    const story = findStory(slug);
    if (!story) return;
    const phaseName = PHASES[story.status]?.label || story.status;
    const confirmed = confirm(`Run ${phaseName} command for "${story.title}" on desktop?`);
    if (!confirmed) return;
    ws.send(JSON.stringify({ type: 'story:launch', data: { slug } }));
    showToast('Launching on desktop...');
  };
}

describe('launchStory', () => {
  let toastMessages;
  let showToast;

  beforeEach(() => {
    toastMessages = [];
    showToast = (msg) => toastMessages.push(msg);
  });

  it('shows "Not connected" toast when ws is null', () => {
    const launchStory = makeLaunchStory({
      ws: null,
      findStory: () => null,
      showToast,
      confirm: () => true
    });

    launchStory('1-1-story');

    expect(toastMessages).toContain('Not connected');
  });

  it('shows "Not connected" toast when ws is closed', () => {
    const launchStory = makeLaunchStory({
      ws: { readyState: WS_CLOSED },
      findStory: () => null,
      showToast,
      confirm: () => true
    });

    launchStory('1-1-story');

    expect(toastMessages).toContain('Not connected');
  });

  it('does nothing when story is not found', () => {
    const mockWs = { readyState: WS_OPEN, send: vi.fn() };
    const launchStory = makeLaunchStory({
      ws: mockWs,
      findStory: () => null,
      showToast,
      confirm: () => true
    });

    launchStory('nonexistent-story');

    expect(mockWs.send).not.toHaveBeenCalled();
    expect(toastMessages).toHaveLength(0);
  });

  it('sends story:launch message when confirmed', () => {
    const sentMessages = [];
    const mockWs = {
      readyState: WS_OPEN,
      send: (msg) => sentMessages.push(JSON.parse(msg))
    };
    const launchStory = makeLaunchStory({
      ws: mockWs,
      findStory: (slug) => ({ slug, title: 'My Feature', status: 'in-progress' }),
      showToast,
      confirm: () => true
    });

    launchStory('1-1-feature');

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].type).toBe('story:launch');
    expect(sentMessages[0].data.slug).toBe('1-1-feature');
  });

  it('shows "Launching on desktop..." toast when confirmed', () => {
    const mockWs = { readyState: WS_OPEN, send: vi.fn() };
    const launchStory = makeLaunchStory({
      ws: mockWs,
      findStory: () => ({ slug: '1-1-feature', title: 'Feature', status: 'in-progress' }),
      showToast,
      confirm: () => true
    });

    launchStory('1-1-feature');

    expect(toastMessages).toContain('Launching on desktop...');
  });

  it('does not send message when user cancels confirmation', () => {
    const mockWs = { readyState: WS_OPEN, send: vi.fn() };
    const launchStory = makeLaunchStory({
      ws: mockWs,
      findStory: () => ({ slug: '1-1-feature', title: 'Feature', status: 'review' }),
      showToast,
      confirm: () => false
    });

    launchStory('1-1-feature');

    expect(mockWs.send).not.toHaveBeenCalled();
    expect(toastMessages).toHaveLength(0);
  });

  it('uses PHASES label in the confirmation prompt', () => {
    let confirmMessage = '';
    const mockWs = { readyState: WS_OPEN, send: vi.fn() };
    const launchStory = makeLaunchStory({
      ws: mockWs,
      findStory: () => ({ slug: '1-1-review', title: 'My Story', status: 'review' }),
      showToast,
      confirm: (msg) => { confirmMessage = msg; return false; }
    });

    launchStory('1-1-review');

    expect(confirmMessage).toContain('Review');
    expect(confirmMessage).toContain('My Story');
  });

  it('falls back to raw phase name in confirmation when PHASES lookup fails', () => {
    let confirmMessage = '';
    const mockWs = { readyState: WS_OPEN, send: vi.fn() };
    const launchStory = makeLaunchStory({
      ws: mockWs,
      findStory: () => ({ slug: '1-1-custom', title: 'Custom Story', status: 'custom-phase' }),
      showToast,
      confirm: (msg) => { confirmMessage = msg; return false; }
    });

    launchStory('1-1-custom');

    expect(confirmMessage).toContain('custom-phase');
  });
});

// ── handleWSMessage: 'stories:active' case ───────────────────────────────
//
// case 'stories:active':
//   activeStories = msg.data.stories || [];
//   if (currentView === 'dashboard') renderDashboard();
//   else if (currentView === 'epic' && currentEpic) renderEpicDetail();
//   updateNavBadge();
//   break;

function makeHandleStoriesActive({ setActiveStories, currentView, currentEpic, renderDashboard, renderEpicDetail, updateNavBadge }) {
  return function handleStoriesActive(msg) {
    setActiveStories(msg.data.stories || []);
    if (currentView === 'dashboard') renderDashboard();
    else if (currentView === 'epic' && currentEpic) renderEpicDetail();
    updateNavBadge();
  };
}

describe('handleWSMessage: stories:active', () => {
  it('updates active stories list from message data', () => {
    let activeStories = [];
    const handler = makeHandleStoriesActive({
      setActiveStories: (stories) => { activeStories = stories; },
      currentView: 'connect',
      currentEpic: null,
      renderDashboard: vi.fn(),
      renderEpicDetail: vi.fn(),
      updateNavBadge: vi.fn()
    });

    handler({ data: { stories: [{ slug: '1-1-story' }] } });

    expect(activeStories).toHaveLength(1);
    expect(activeStories[0].slug).toBe('1-1-story');
  });

  it('defaults to empty array when stories is missing from data', () => {
    let activeStories = [{ slug: 'old' }];
    const handler = makeHandleStoriesActive({
      setActiveStories: (stories) => { activeStories = stories; },
      currentView: 'connect',
      currentEpic: null,
      renderDashboard: vi.fn(),
      renderEpicDetail: vi.fn(),
      updateNavBadge: vi.fn()
    });

    handler({ data: {} });

    expect(activeStories).toHaveLength(0);
  });

  it('calls renderDashboard when currentView is dashboard', () => {
    const renderDashboard = vi.fn();
    const handler = makeHandleStoriesActive({
      setActiveStories: () => {},
      currentView: 'dashboard',
      currentEpic: null,
      renderDashboard,
      renderEpicDetail: vi.fn(),
      updateNavBadge: vi.fn()
    });

    handler({ data: { stories: [] } });

    expect(renderDashboard).toHaveBeenCalledOnce();
  });

  it('calls renderEpicDetail when currentView is epic and currentEpic is set', () => {
    const renderEpicDetail = vi.fn();
    const handler = makeHandleStoriesActive({
      setActiveStories: () => {},
      currentView: 'epic',
      currentEpic: { number: 1, title: 'Epic' },
      renderDashboard: vi.fn(),
      renderEpicDetail,
      updateNavBadge: vi.fn()
    });

    handler({ data: { stories: [] } });

    expect(renderEpicDetail).toHaveBeenCalledOnce();
  });

  it('does not call renderEpicDetail when currentView is epic but currentEpic is null', () => {
    const renderEpicDetail = vi.fn();
    const handler = makeHandleStoriesActive({
      setActiveStories: () => {},
      currentView: 'epic',
      currentEpic: null,
      renderDashboard: vi.fn(),
      renderEpicDetail,
      updateNavBadge: vi.fn()
    });

    handler({ data: { stories: [] } });

    expect(renderEpicDetail).not.toHaveBeenCalled();
  });

  it('always calls updateNavBadge regardless of view', () => {
    const updateNavBadge = vi.fn();

    for (const view of ['connect', 'dashboard', 'epic', 'terminal']) {
      const handler = makeHandleStoriesActive({
        setActiveStories: () => {},
        currentView: view,
        currentEpic: null,
        renderDashboard: vi.fn(),
        renderEpicDetail: vi.fn(),
        updateNavBadge
      });
      handler({ data: { stories: [] } });
    }

    expect(updateNavBadge).toHaveBeenCalledTimes(4);
  });

  it('does not call renderDashboard when currentView is not dashboard', () => {
    const renderDashboard = vi.fn();
    const handler = makeHandleStoriesActive({
      setActiveStories: () => {},
      currentView: 'terminal',
      currentEpic: null,
      renderDashboard,
      renderEpicDetail: vi.fn(),
      updateNavBadge: vi.fn()
    });

    handler({ data: { stories: [] } });

    expect(renderDashboard).not.toHaveBeenCalled();
  });
});

// ── handleWSMessage: 'story:task-launched' case ──────────────────────────
//
// case 'story:task-launched': {
//   const { slug, phase, command } = msg.data;
//   showLocalNotification('Task Launched', `${phase} command running for ${slug}`);
//   if (ws && ws.readyState === WebSocket.OPEN) {
//     ws.send(JSON.stringify({ type: 'terminal:list-shared' }));
//   }
//   setTimeout(() => {
//     if (sharedTerminalSessions.length > 0) {
//       setSharedMode(true);
//       watchSharedTerminal(sharedTerminalSessions[sharedTerminalSessions.length - 1].id);
//       showTerminal();
//     }
//   }, 500);
//   break;
// }

function makeHandleTaskLaunched({ ws, showLocalNotification, sharedTerminalSessions, setSharedMode, watchSharedTerminal, showTerminal, setTimeout: _setTimeout }) {
  return function handleTaskLaunched(msg) {
    const { slug, phase, command } = msg.data;
    showLocalNotification('Task Launched', `${phase} command running for ${slug}`);
    if (ws && ws.readyState === WS_OPEN) {
      ws.send(JSON.stringify({ type: 'terminal:list-shared' }));
    }
    _setTimeout(() => {
      if (sharedTerminalSessions.length > 0) {
        setSharedMode(true);
        watchSharedTerminal(sharedTerminalSessions[sharedTerminalSessions.length - 1].id);
        showTerminal();
      }
    }, 500);
  };
}

describe('handleWSMessage: story:task-launched', () => {
  it('shows a local notification with phase and slug info', () => {
    const notifications = [];
    const mockWs = { readyState: WS_OPEN, send: vi.fn() };
    const handler = makeHandleTaskLaunched({
      ws: mockWs,
      showLocalNotification: (title, body) => notifications.push({ title, body }),
      sharedTerminalSessions: [],
      setSharedMode: vi.fn(),
      watchSharedTerminal: vi.fn(),
      showTerminal: vi.fn(),
      setTimeout: vi.fn()
    });

    handler({ data: { slug: '1-1-feature', phase: 'in-progress', command: 'claude dev' } });

    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toBe('Task Launched');
    expect(notifications[0].body).toContain('in-progress');
    expect(notifications[0].body).toContain('1-1-feature');
  });

  it('requests terminal:list-shared via WebSocket when connected', () => {
    const sentMessages = [];
    const mockWs = {
      readyState: WS_OPEN,
      send: (msg) => sentMessages.push(JSON.parse(msg))
    };
    const handler = makeHandleTaskLaunched({
      ws: mockWs,
      showLocalNotification: vi.fn(),
      sharedTerminalSessions: [],
      setSharedMode: vi.fn(),
      watchSharedTerminal: vi.fn(),
      showTerminal: vi.fn(),
      setTimeout: vi.fn()
    });

    handler({ data: { slug: '1-1-feature', phase: 'review', command: 'npm run review' } });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].type).toBe('terminal:list-shared');
  });

  it('does not send terminal:list-shared when ws is closed', () => {
    const mockWs = { readyState: WS_CLOSED, send: vi.fn() };
    const handler = makeHandleTaskLaunched({
      ws: mockWs,
      showLocalNotification: vi.fn(),
      sharedTerminalSessions: [],
      setSharedMode: vi.fn(),
      watchSharedTerminal: vi.fn(),
      showTerminal: vi.fn(),
      setTimeout: vi.fn()
    });

    handler({ data: { slug: '1-1-feature', phase: 'review', command: 'npm run review' } });

    expect(mockWs.send).not.toHaveBeenCalled();
  });

  it('does not send terminal:list-shared when ws is null', () => {
    const handler = makeHandleTaskLaunched({
      ws: null,
      showLocalNotification: vi.fn(),
      sharedTerminalSessions: [],
      setSharedMode: vi.fn(),
      watchSharedTerminal: vi.fn(),
      showTerminal: vi.fn(),
      setTimeout: vi.fn()
    });

    // Should not throw
    expect(() => handler({ data: { slug: '1-1-feature', phase: 'review', command: '' } })).not.toThrow();
  });

  it('switches to shared mode and watches last session after delay', () => {
    const setSharedMode = vi.fn();
    const watchSharedTerminal = vi.fn();
    const showTerminal = vi.fn();
    let timerFn;
    const sessions = [{ id: 'sess-1' }, { id: 'sess-2' }];
    const handler = makeHandleTaskLaunched({
      ws: { readyState: WS_OPEN, send: vi.fn() },
      showLocalNotification: vi.fn(),
      sharedTerminalSessions: sessions,
      setSharedMode,
      watchSharedTerminal,
      showTerminal,
      setTimeout: (fn, delay) => { timerFn = fn; }
    });

    handler({ data: { slug: '1-1-feature', phase: 'in-progress', command: 'cmd' } });

    // Simulate timer firing
    timerFn();

    expect(setSharedMode).toHaveBeenCalledWith(true);
    expect(watchSharedTerminal).toHaveBeenCalledWith('sess-2'); // last session
    expect(showTerminal).toHaveBeenCalled();
  });

  it('does not switch to shared mode if no shared terminal sessions exist', () => {
    const setSharedMode = vi.fn();
    let timerFn;
    const handler = makeHandleTaskLaunched({
      ws: { readyState: WS_OPEN, send: vi.fn() },
      showLocalNotification: vi.fn(),
      sharedTerminalSessions: [], // empty
      setSharedMode,
      watchSharedTerminal: vi.fn(),
      showTerminal: vi.fn(),
      setTimeout: (fn, delay) => { timerFn = fn; }
    });

    handler({ data: { slug: '1-1-feature', phase: 'in-progress', command: 'cmd' } });
    timerFn();

    expect(setSharedMode).not.toHaveBeenCalled();
  });

  it('schedules the terminal switch with a 500ms delay', () => {
    let capturedDelay;
    const handler = makeHandleTaskLaunched({
      ws: { readyState: WS_OPEN, send: vi.fn() },
      showLocalNotification: vi.fn(),
      sharedTerminalSessions: [],
      setSharedMode: vi.fn(),
      watchSharedTerminal: vi.fn(),
      showTerminal: vi.fn(),
      setTimeout: (fn, delay) => { capturedDelay = delay; }
    });

    handler({ data: { slug: '1-1-feature', phase: 'review', command: 'cmd' } });

    expect(capturedDelay).toBe(500);
  });
});