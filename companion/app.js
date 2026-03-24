/**
 * BMAD Board Companion — Mobile PWA Client
 *
 * Connects to the desktop Electron app via HTTP REST + WebSocket.
 * Provides epic/story dashboard, terminal access, desktop terminal sharing,
 * story phase management, and push notifications.
 */

// ── State ───────────────────────────────────────────────────────────────

let serverUrl = '';   // e.g. http://192.168.1.5:3939
let authToken = '';
let ws = null;
let projectData = null;
let currentView = 'connect';
let currentEpic = null;
let terminalSessionId = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// Desktop terminal sharing state
let watchingSharedTerminal = null;
let sharedTerminalSessions = [];

const PHASES = {
  'backlog':       { label: 'Backlog',     icon: '\u25CB', color: 'var(--phase-backlog)' },
  'ready-for-dev': { label: 'Ready',       icon: '\u25D0', color: 'var(--phase-ready)' },
  'in-progress':   { label: 'In Progress', icon: '\u25D1', color: 'var(--phase-progress)' },
  'review':        { label: 'Review',      icon: '\u25D5', color: 'var(--phase-review)' },
  'done':          { label: 'Done',        icon: '\u25CF', color: 'var(--phase-done)' }
};

const PHASE_ORDER = ['backlog', 'ready-for-dev', 'in-progress', 'review', 'done'];

// ── Init ────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  registerServiceWorker();
  setupEventListeners();
  tryAutoConnect();
});

/** Register the service worker for PWA support and push notification handling. */
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      // Listen for push notification clicks
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data?.type === 'notification-click') {
          handleNotificationClick(event.data);
        }
      });
    }).catch(() => {});
  }
}

/** Bind all UI event listeners for navigation, forms, and terminal input. */
function setupEventListeners() {
  // Connect form
  document.getElementById('btn-connect').addEventListener('click', handleConnect);
  document.getElementById('input-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleConnect();
  });

  // Navigation
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      if (view === 'dashboard') showDashboard();
      else if (view === 'terminal') showTerminal();
    });
  });

  // Back button
  document.getElementById('btn-back').addEventListener('click', handleBack);

  // Refresh
  document.getElementById('btn-refresh').addEventListener('click', handleRefresh);

  // Terminal input
  document.getElementById('terminal-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendTerminalInput();
  });
  document.getElementById('btn-send').addEventListener('click', sendTerminalInput);

  // Terminal mode toggle (own vs shared)
  document.getElementById('btn-terminal-mode').addEventListener('click', toggleTerminalMode);
}

// ── Auto-connect ────────────────────────────────────────────────────────

/** Attempt automatic connection using URL params (QR code) or saved credentials. */
function tryAutoConnect() {
  // Check URL params first (from QR code scan)
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');

  if (token) {
    // We're loaded from the companion server itself
    serverUrl = window.location.origin;
    authToken = token;
    connect();
    // Clean URL
    window.history.replaceState({}, '', '/');
    return;
  }

  // Check localStorage for previous connection
  const saved = localStorage.getItem('bmad-companion');
  if (saved) {
    try {
      const { url, token: savedToken } = JSON.parse(saved);
      if (url && savedToken) {
        serverUrl = url;
        authToken = savedToken;
        document.getElementById('input-url').value = `${url}?token=${savedToken}`;
        connect();
        return;
      }
    } catch {}
  }
}

// ── Connection ──────────────────────────────────────────────────────────

/** Parse the URL input field and initiate connection to the desktop server. */
function handleConnect() {
  const input = document.getElementById('input-url').value.trim();
  if (!input) return;

  try {
    const url = new URL(input);
    serverUrl = url.origin;
    authToken = url.searchParams.get('token') || '';
    connect();
  } catch {
    showConnectError('Invalid URL. Use the format: http://192.168.x.x:3939?token=...');
  }
}

/** Authenticate with the server, open a WebSocket, and load project data. */
async function connect() {
  setConnectionState('connecting');
  hideConnectError();

  try {
    const res = await apiFetch('/api/status');
    if (!res.ok) throw new Error('Auth failed');

    // Save connection for next time
    localStorage.setItem('bmad-companion', JSON.stringify({ url: serverUrl, token: authToken }));

    // Connect WebSocket
    connectWebSocket();

    // Load project data
    await loadProject();

    // Request notification permission
    requestNotificationPermission();

    setConnectionState('connected');
    showDashboard();
  } catch (err) {
    setConnectionState('disconnected');
    showConnectError('Cannot connect. Check that BMAD Board is running and the URL/token is correct.');
    showView('connect');
  }
}

/** Open a WebSocket connection to the server for real-time events. */
function connectWebSocket() {
  if (ws) {
    ws.close();
    ws = null;
  }

  const wsUrl = serverUrl.replace(/^http/, 'ws') + `?token=${authToken}`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('[companion] WebSocket connected');
    reconnectAttempts = 0;
    setConnectionState('connected');
    // Request list of shared desktop terminals
    ws.send(JSON.stringify({ type: 'terminal:list-shared' }));
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleWSMessage(msg);
    } catch {}
  };

  ws.onclose = () => {
    console.log('[companion] WebSocket closed');
    terminalSessionId = null;
    setConnectionState('disconnected');
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose will fire after this
  };
}

/** Schedule a WebSocket reconnection with exponential backoff. */
function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return;

  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      connectWebSocket();
    }
  }, delay);
}

/**
 * Dispatch an incoming WebSocket message to the appropriate handler.
 * @param {Object} msg - Parsed JSON message with a `type` field.
 */
function handleWSMessage(msg) {
  switch (msg.type) {
    case 'project:state':
      projectData = msg.data;
      if (currentView === 'dashboard') renderDashboard();
      else if (currentView === 'epic' && currentEpic) renderEpicDetail();
      break;

    case 'terminal:created':
      terminalSessionId = msg.data.id;
      appendTerminalLine('--- Terminal session started ---', 'ansi-dim');
      break;

    case 'terminal:data':
      appendTerminalData(msg.data.data);
      break;

    case 'terminal:exit':
      appendTerminalLine(`--- Session exited (code ${msg.data.exitCode}) ---`, 'ansi-dim');
      terminalSessionId = null;
      break;

    // Desktop terminal sharing
    case 'terminal:shared-data':
      if (currentView === 'terminal' && isSharedMode()) {
        appendTerminalData(msg.data.data);
      }
      break;

    case 'terminal:shared-exit':
      if (currentView === 'terminal' && isSharedMode()) {
        appendTerminalLine(`--- Desktop session exited (code ${msg.data.exitCode}) ---`, 'ansi-dim');
        watchingSharedTerminal = null;
      }
      showLocalNotification('Terminal Exited', `Desktop session ended with code ${msg.data.exitCode}`);
      break;

    case 'terminal:shared-list':
      sharedTerminalSessions = msg.data.sessions || [];
      updateTerminalModeIndicator();
      break;

    // Story phase advance
    case 'story:advanced':
      showToast(`${msg.data.slug}: ${msg.data.oldPhase} \u2192 ${msg.data.newPhase}`);
      break;

    // Notifications from server
    case 'notification':
      showLocalNotification(msg.data.title, msg.data.body);
      break;

    case 'pong':
      break;
  }
}

// ── API Helper ──────────────────────────────────────────────────────────

/**
 * Fetch wrapper that prepends the server URL and injects the auth token.
 * @param {string} path - API path (e.g. '/api/project').
 * @param {RequestInit} [opts] - Additional fetch options.
 * @returns {Promise<Response>}
 */
function apiFetch(path, opts = {}) {
  return fetch(`${serverUrl}${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
}

// ── Project Data ────────────────────────────────────────────────────────

/** Fetch the current project data from the server and store it locally. */
async function loadProject() {
  try {
    const res = await apiFetch('/api/project');
    if (res.ok) {
      projectData = await res.json();
    }
  } catch {}
}

// ── Views ───────────────────────────────────────────────────────────────

/**
 * Switch the visible view panel and update navigation state.
 * @param {string} name - View name ('connect', 'dashboard', 'epic', 'terminal').
 */
function showView(name) {
  currentView = name;
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById(`view-${name === 'epic' ? 'epic' : name}`).classList.remove('hidden');

  // Update nav active state
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === name || (name === 'epic' && btn.dataset.view === 'dashboard'));
  });

  // Back button visibility
  document.getElementById('btn-back').classList.toggle('hidden', name !== 'epic');

  // Header title
  if (name === 'connect') {
    document.getElementById('header-title').textContent = 'BMAD Board';
  } else if (name === 'terminal') {
    document.getElementById('header-title').textContent = 'Terminal';
  }
}

/** Navigate to the dashboard view and render the epics grid. */
function showDashboard() {
  showView('dashboard');
  document.getElementById('header-title').textContent = projectData?.projectMeta?.name || 'BMAD Board';
  renderDashboard();
}

/**
 * Navigate to the detail view for a specific epic.
 * @param {number} epicNumber - The epic number to display.
 */
function showEpicDetail(epicNumber) {
  const epic = (projectData?.epics || []).find(e => e.number === epicNumber);
  if (!epic) return;
  currentEpic = epic;
  showView('epic');
  document.getElementById('header-title').textContent = `Epic ${epic.number}`;
  renderEpicDetail();
}

/** Navigate to the terminal view, starting a session or watching a shared one. */
function showTerminal() {
  showView('terminal');
  // If shared terminals available, default to shared mode
  if (sharedTerminalSessions.length > 0 && !terminalSessionId && !watchingSharedTerminal) {
    setSharedMode(true);
    watchSharedTerminal(sharedTerminalSessions[0].id);
  } else if (!terminalSessionId && !isSharedMode() && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'terminal:create', data: { cols: 80, rows: 24 } }));
  }
  // Focus input
  setTimeout(() => document.getElementById('terminal-input').focus(), 100);
}

/** Handle the back button press, returning from epic detail to dashboard. */
function handleBack() {
  if (currentView === 'epic') {
    showDashboard();
  }
}

/** Request a project data and shared terminal list refresh from the server. */
function handleRefresh() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'project:refresh' }));
    ws.send(JSON.stringify({ type: 'terminal:list-shared' }));
    showToast('Refreshing...');
  }
}

// ── Renderers ───────────────────────────────────────────────────────────

/** Render the epic cards grid on the dashboard from current project data. */
function renderDashboard() {
  if (!projectData) return;

  document.getElementById('project-name').textContent = projectData.projectMeta?.name || 'Project';
  const epicCount = (projectData.epics || []).length;
  const totalStories = (projectData.epics || []).reduce((sum, e) => sum + e.stories.length, 0);
  document.getElementById('project-meta').textContent = `${epicCount} epics, ${totalStories} stories`;

  const grid = document.getElementById('epics-grid');
  grid.innerHTML = '';

  for (const epic of (projectData.epics || [])) {
    const card = document.createElement('div');
    card.className = 'epic-card';
    card.addEventListener('click', () => showEpicDetail(epic.number));

    const doneCount = epic.stories.filter(s => s.status === 'done').length;
    const totalCount = epic.stories.length;
    const pct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

    // Header
    const header = document.createElement('div');
    header.className = 'epic-card-header';
    const epicNum = document.createElement('span');
    epicNum.className = 'epic-number';
    epicNum.textContent = `EPIC ${epic.number}`;
    const pill = document.createElement('span');
    pill.className = 'phase-pill';
    pill.setAttribute('data-phase', epic.status);
    pill.textContent = PHASES[epic.status]?.label || epic.status;
    header.appendChild(epicNum);
    header.appendChild(pill);

    // Title
    const title = document.createElement('div');
    title.className = 'epic-card-title';
    title.textContent = epic.title;

    // Progress
    const progress = document.createElement('div');
    progress.className = 'epic-progress';
    const bar = document.createElement('div');
    bar.className = 'progress-bar';
    const fill = document.createElement('div');
    fill.className = 'progress-fill';
    fill.style.width = `${pct}%`;
    bar.appendChild(fill);
    const pText = document.createElement('span');
    pText.className = 'progress-text';
    pText.textContent = `${doneCount}/${totalCount}`;
    progress.appendChild(bar);
    progress.appendChild(pText);

    // Phase dots
    const summary = document.createElement('div');
    summary.className = 'phase-summary';
    for (const s of epic.stories) {
      const dot = document.createElement('div');
      dot.className = 'phase-dot';
      dot.style.background = PHASES[s.status]?.color || 'var(--phase-backlog)';
      dot.title = s.title;
      summary.appendChild(dot);
    }

    card.appendChild(header);
    card.appendChild(title);
    card.appendChild(progress);
    card.appendChild(summary);
    grid.appendChild(card);
  }
}

/** Render the story list for the currently selected epic. */
function renderEpicDetail() {
  if (!currentEpic) return;

  // Re-find epic in case data refreshed
  const epic = (projectData?.epics || []).find(e => e.number === currentEpic.number) || currentEpic;
  currentEpic = epic;

  document.getElementById('epic-status').setAttribute('data-phase', epic.status);
  document.getElementById('epic-status').textContent = PHASES[epic.status]?.label || epic.status;
  document.getElementById('epic-title').textContent = epic.title;

  const list = document.getElementById('stories-list');
  list.innerHTML = '';

  for (const story of epic.stories) {
    const card = document.createElement('div');
    card.className = 'story-card';

    const canAdvance = story.status !== 'done';
    const nextPhase = canAdvance ? PHASE_ORDER[PHASE_ORDER.indexOf(story.status) + 1] : null;

    // Story number
    const num = document.createElement('div');
    num.className = 'story-number';
    num.textContent = `Story ${story.storyNumber}`;

    // Header row
    const header = document.createElement('div');
    header.className = 'story-header';
    const titleSpan = document.createElement('span');
    titleSpan.className = 'story-title';
    titleSpan.textContent = story.title;
    const pill = document.createElement('span');
    pill.className = 'phase-pill';
    pill.setAttribute('data-phase', story.status);
    pill.textContent = PHASES[story.status]?.label || story.status;
    header.appendChild(titleSpan);
    header.appendChild(pill);

    card.appendChild(num);
    card.appendChild(header);

    // Advance button
    if (canAdvance && nextPhase) {
      const actions = document.createElement('div');
      actions.className = 'story-actions';
      const btn = document.createElement('button');
      btn.className = 'btn-advance';
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>';
      btn.appendChild(document.createTextNode(` ${PHASES[nextPhase]?.label || nextPhase}`));
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        advanceStory(story.slug);
      });
      actions.appendChild(btn);
      card.appendChild(actions);
    }

    list.appendChild(card);
  }
}

// ── Story Phase Advance ─────────────────────────────────────────────────

/**
 * Advance a story to its next phase after user confirmation.
 * @param {string} slug - The story slug identifier.
 */
function advanceStory(slug) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Not connected');
    return;
  }

  // Confirm on mobile
  const story = findStory(slug);
  if (!story) return;

  const currentIdx = PHASE_ORDER.indexOf(story.status);
  if (currentIdx < 0 || currentIdx >= PHASE_ORDER.length - 1) return;

  const nextPhase = PHASE_ORDER[currentIdx + 1];
  const confirmed = confirm(`Move "${story.title}" to ${PHASES[nextPhase]?.label || nextPhase}?`);
  if (!confirmed) return;

  ws.send(JSON.stringify({
    type: 'story:advance',
    data: { slug }
  }));

  showToast('Advancing...');
}

/**
 * Find a story by slug across all epics.
 * @param {string} slug - The story slug to search for.
 * @returns {Object|null} The story object, or null if not found.
 */
function findStory(slug) {
  for (const epic of (projectData?.epics || [])) {
    const story = epic.stories.find(s => s.slug === slug);
    if (story) return story;
  }
  return null;
}

// ── Terminal ────────────────────────────────────────────────────────────

let terminalMode = 'own'; // 'own' or 'shared'

/** @returns {boolean} Whether the terminal is in shared (desktop watching) mode. */
function isSharedMode() {
  return terminalMode === 'shared';
}

/**
 * Set the terminal mode and update the UI toggle button.
 * @param {boolean} shared - True for desktop sharing mode, false for own session.
 */
function setSharedMode(shared) {
  terminalMode = shared ? 'shared' : 'own';
  const btn = document.getElementById('btn-terminal-mode');
  btn.textContent = shared ? 'Desktop' : 'Own';
  btn.title = shared ? 'Watching desktop terminal' : 'Own terminal session';

  // Show/hide input row based on mode
  const inputRow = document.querySelector('.terminal-input-row');
  if (inputRow) {
    inputRow.style.display = shared ? 'none' : 'flex';
  }
}

/** Toggle between own terminal session and watching a shared desktop terminal. */
function toggleTerminalMode() {
  if (isSharedMode()) {
    // Switch to own terminal
    setSharedMode(false);
    watchingSharedTerminal = null;
    clearTerminalOutput();
    if (!terminalSessionId && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'terminal:create', data: { cols: 80, rows: 24 } }));
    }
  } else {
    // Switch to shared desktop terminal
    if (sharedTerminalSessions.length === 0) {
      showToast('No active desktop terminal to watch');
      return;
    }
    setSharedMode(true);
    clearTerminalOutput();
    watchSharedTerminal(sharedTerminalSessions[0].id);
  }
}

/**
 * Subscribe to a shared desktop terminal session via WebSocket.
 * @param {string} sessionId - The terminal session ID to watch.
 */
function watchSharedTerminal(sessionId) {
  watchingSharedTerminal = sessionId;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'terminal:watch', data: { id: sessionId } }));
  }
}

/** Show the terminal mode toggle button when shared sessions are available. */
function updateTerminalModeIndicator() {
  const btn = document.getElementById('btn-terminal-mode');
  if (sharedTerminalSessions.length > 0) {
    btn.classList.remove('hidden');
  }
}

/** Clear all content from the terminal output element. */
function clearTerminalOutput() {
  document.getElementById('terminal-output').innerHTML = '';
}

/** Send the terminal input field value to the active PTY session. */
function sendTerminalInput() {
  const input = document.getElementById('terminal-input');
  const text = input.value;
  if (!text || !terminalSessionId || !ws || ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify({
    type: 'terminal:input',
    data: { id: terminalSessionId, input: text + '\n' }
  }));

  input.value = '';
}

/**
 * Append raw terminal data to the output, stripping ANSI escape codes.
 * @param {string} rawData - Raw terminal output potentially containing ANSI sequences.
 */
function appendTerminalData(rawData) {
  const output = document.getElementById('terminal-output');
  // Simple ANSI stripping + basic color support
  const cleaned = stripAnsi(rawData);
  const span = document.createElement('span');
  span.textContent = cleaned;
  output.appendChild(span);
  output.scrollTop = output.scrollHeight;
}

/**
 * Append a styled line to the terminal output.
 * @param {string} text - Line text content.
 * @param {string} [className] - Optional CSS class for styling.
 */
function appendTerminalLine(text, className) {
  const output = document.getElementById('terminal-output');
  const div = document.createElement('div');
  div.className = `line ${className || ''}`;
  div.textContent = text;
  output.appendChild(div);
  output.scrollTop = output.scrollHeight;
}

/**
 * Strip ANSI escape sequences for simple text display.
 * A full xterm.js renderer would be overkill for a mobile companion.
 */
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
            .replace(/\x1b\][^\x07]*\x07/g, '')   // OSC sequences
            .replace(/\x1b[()][AB012]/g, '')         // Character set
            .replace(/\r/g, '');
}

// ── Notifications ───────────────────────────────────────────────────────

/** Prompt the user for notification permission if not already granted or denied. */
function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

/**
 * Show an in-app toast and, if permitted, an OS notification.
 * @param {string} title - Notification title.
 * @param {string} body - Notification body text.
 */
function showLocalNotification(title, body) {
  // In-app toast
  showToast(`${title}: ${body}`);

  // OS notification if permitted and app is in background
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    try {
      const notification = new Notification(title, {
        body,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: 'bmad-companion',
        renotify: true
      });
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
    } catch {
      // Notification constructor may not work in all contexts
      if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: 'show-notification',
          title,
          body
        });
      }
    }
  }
}

/**
 * Navigate to the relevant view when a push notification is clicked.
 * @param {Object} data - Notification payload with an optional `view` field.
 */
function handleNotificationClick(data) {
  // Navigate to relevant view when notification is clicked
  if (data.view === 'terminal') {
    showTerminal();
  }
}

// ── UI Helpers ──────────────────────────────────────────────────────────

/**
 * Update the connection status indicator dot.
 * @param {string} state - One of 'connecting', 'connected', or 'disconnected'.
 */
function setConnectionState(state) {
  const dot = document.getElementById('connection-dot');
  dot.className = `dot dot-${state}`;
  dot.title = state.charAt(0).toUpperCase() + state.slice(1);
}

/**
 * Display an error message on the connect screen.
 * @param {string} msg - Error message to show.
 */
function showConnectError(msg) {
  const el = document.getElementById('connect-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

/** Hide the connect screen error message. */
function hideConnectError() {
  document.getElementById('connect-error').classList.add('hidden');
}

/**
 * Show a brief toast notification that auto-dismisses after 3 seconds.
 * @param {string} msg - Message to display.
 */
function showToast(msg) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

/**
 * Escape a string for safe HTML insertion.
 * @param {string} str - Raw string to escape.
 * @returns {string} HTML-escaped string.
 */
function esc(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
