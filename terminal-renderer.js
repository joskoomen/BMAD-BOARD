/**
 * Terminal Renderer — Warp-style embedded terminal with multi-tab support
 *
 * Features:
 * - Multiple terminal tabs, each with its own PTY session
 * - Tab titles with emoji based on command type
 * - Auto-starts claude in each new session
 * - Warp-inspired command palette (Cmd+K)
 * - BMAD quick-action sidebar integration
 */

/* global Terminal, FitAddon, WebLinksAddon */

// ── Tab State ────────────────────────────────────────────────────────────────

const tabs = new Map();   // tabId -> tab object
let activeTabId = null;
let nextTabId = 1;
let xtermLoaded = false;
let paletteSelectedIndex = 0;

// Shared xterm theme
const warpTheme = {
  background: '#0a0a1a',
  foreground: '#e4e4f0',
  cursor: '#6c5ce7',
  cursorAccent: '#0a0a1a',
  selectionBackground: 'rgba(108, 92, 231, 0.35)',
  selectionForeground: '#ffffff',
  black: '#1a1a2e',
  red: '#ff6b6b',
  green: '#51cf66',
  yellow: '#fcc419',
  blue: '#6c5ce7',
  magenta: '#cc5de8',
  cyan: '#22b8cf',
  white: '#e4e4f0',
  brightBlack: '#4a4a6a',
  brightRed: '#ff8787',
  brightGreen: '#69db7c',
  brightYellow: '#ffd43b',
  brightBlue: '#845ef7',
  brightMagenta: '#da77f2',
  brightCyan: '#3bc9db',
  brightWhite: '#ffffff'
};

// ── Command → Tab Title Mapping ──────────────────────────────────────────────

const COMMAND_TAB_INFO = {
  '/bmad-bmm-dev-story':           { emoji: '\u25B6',  label: 'Dev Story' },
  '/bmad-bmm-create-story':        { emoji: '\u2795',  label: 'Create Story' },
  '/bmad-bmm-code-review':         { emoji: '\u2713',  label: 'Code Review' },
  '/bmad-bmm-quick-spec':          { emoji: '\u270E',  label: 'Quick Spec' },
  '/bmad-bmm-quick-dev':           { emoji: '\u26A1',  label: 'Quick Dev' },
  '/bmad-bmm-sprint-status':       { emoji: '\uD83D\uDCCA', label: 'Sprint Status' },
  '/bmad-bmm-sprint-planning':     { emoji: '\uD83D\uDDD3', label: 'Sprint Planning' },
  '/bmad-bmm-correct-course':      { emoji: '\u21BA',  label: 'Correct Course' },
  '/bmad-bmm-retrospective':       { emoji: '\uD83C\uDF89', label: 'Retrospective' },
  '/bmad-bmm-create-prd':          { emoji: '\uD83D\uDCC4', label: 'Create PRD' },
  '/bmad-bmm-edit-prd':            { emoji: '\u270E',  label: 'Edit PRD' },
  '/bmad-bmm-validate-prd':        { emoji: '\u2713',  label: 'Validate PRD' },
  '/bmad-bmm-create-architecture': { emoji: '\u2699',  label: 'Architecture' },
  '/bmad-bmm-create-ux-design':    { emoji: '\u2606',  label: 'UX Design' },
  '/bmad-bmm-create-epics-and-stories': { emoji: '\u2630', label: 'Epics & Stories' },
  '/bmad-bmm-create-product-brief': { emoji: '\uD83D\uDCDD', label: 'Product Brief' },
  '/bmad-bmm-check-implementation-readiness': { emoji: '\u2705', label: 'Check Readiness' },
  '/bmad-bmm-market-research':     { emoji: '\uD83D\uDCC8', label: 'Market Research' },
  '/bmad-bmm-domain-research':     { emoji: '\uD83D\uDCDA', label: 'Domain Research' },
  '/bmad-bmm-technical-research':  { emoji: '\uD83D\uDD2C', label: 'Tech Research' },
  '/bmad-review-adversarial-general': { emoji: '\uD83D\uDC41', label: 'Adversarial Review' },
  '/bmad-review-edge-case-hunter': { emoji: '\uD83D\uDD0E', label: 'Edge Cases' },
  '/bmad-editorial-review-prose':  { emoji: '\uD83D\uDCD6', label: 'Prose Review' },
  '/bmad-editorial-review-structure': { emoji: '\uD83D\uDCD1', label: 'Structure Review' },
  '/bmad-bmm-qa-generate-e2e-tests': { emoji: '\u26A0', label: 'E2E Tests' },
  '/bmad-bmm-document-project':    { emoji: '\uD83D\uDCC4', label: 'Document Project' },
  '/bmad-bmm-generate-project-context': { emoji: '\uD83D\uDEE0', label: 'Project Context' },
  '/bmad-party-mode':              { emoji: '\uD83C\uDF89', label: 'Party Mode' },
  '/bmad-brainstorming':           { emoji: '\uD83D\uDCA1', label: 'Brainstorming' },
  '/bmad-help':                    { emoji: '\u2753',  label: 'BMAD Help' },
};

// ── Next Step Suggestions ────────────────────────────────────────────────────

const NEXT_STEPS = {
  '/bmad-bmm-create-story':    [
    { emoji: '\uD83D\uDCBB', label: 'Dev Story',     command: '/bmad-bmm-dev-story' },
    { emoji: '\uD83D\uDCCA', label: 'Sprint Status',  command: '/bmad-bmm-sprint-status' },
  ],
  '/bmad-bmm-dev-story':       [
    { emoji: '\uD83D\uDD75\uFE0F', label: 'Code Review',  command: '/bmad-bmm-code-review' },
    { emoji: '\uD83D\uDCCA', label: 'Sprint Status',  command: '/bmad-bmm-sprint-status' },
  ],
  '/bmad-bmm-code-review':     [
    { emoji: '\uD83D\uDCCA', label: 'Sprint Status',  command: '/bmad-bmm-sprint-status' },
    { emoji: '\uD83D\uDCD3', label: 'Next Story',     command: '/bmad-bmm-create-story' },
  ],
  '/bmad-bmm-sprint-status':   [
    { emoji: '\uD83D\uDCD3', label: 'Create Story',   command: '/bmad-bmm-create-story' },
    { emoji: '\uD83D\uDCBB', label: 'Dev Story',      command: '/bmad-bmm-dev-story' },
  ],
  '/bmad-bmm-sprint-planning': [
    { emoji: '\uD83D\uDCD3', label: 'Create Story',   command: '/bmad-bmm-create-story' },
  ],
  '/bmad-bmm-create-prd':      [
    { emoji: '\u2699\uFE0F',  label: 'Architecture',   command: '/bmad-bmm-create-architecture' },
    { emoji: '\u2606',        label: 'UX Design',      command: '/bmad-bmm-create-ux-design' },
  ],
  '/bmad-bmm-create-architecture': [
    { emoji: '\u2630',        label: 'Epics & Stories', command: '/bmad-bmm-create-epics-and-stories' },
    { emoji: '\u2705',        label: 'Check Readiness', command: '/bmad-bmm-check-implementation-readiness' },
  ],
  '/bmad-bmm-create-epics-and-stories': [
    { emoji: '\u2705',        label: 'Check Readiness', command: '/bmad-bmm-check-implementation-readiness' },
    { emoji: '\uD83D\uDDD3',  label: 'Sprint Planning', command: '/bmad-bmm-sprint-planning' },
  ],
  '/bmad-bmm-retrospective':   [
    { emoji: '\uD83D\uDDD3',  label: 'Sprint Planning', command: '/bmad-bmm-sprint-planning' },
  ],
  '/bmad-bmm-quick-spec':      [
    { emoji: '\u26A1',        label: 'Quick Dev',      command: '/bmad-bmm-quick-dev' },
  ],
  '/bmad-bmm-quick-dev':       [
    { emoji: '\uD83D\uDD75\uFE0F', label: 'Code Review',  command: '/bmad-bmm-code-review' },
  ],
};

function getNextSteps(slashCommand) {
  if (!slashCommand) return [];
  const baseCmd = slashCommand.split(' ')[0];
  return NEXT_STEPS[baseCmd] || [];
}

/**
 * Derive a tab title from a slash command string.
 * e.g. "/bmad-bmm-dev-story 2.5.5" → { emoji: "▶", label: "Dev Story 2.5.5" }
 */
function getTabInfo(slashCommand) {
  if (!slashCommand) return { emoji: '\u25B7', label: 'Terminal' };

  // Extract the base command and any arguments
  const parts = slashCommand.split(' ');
  const baseCmd = parts[0];
  const args = parts.slice(1).join(' ');

  const info = COMMAND_TAB_INFO[baseCmd];
  if (info) {
    const label = args ? `${info.label} ${args}` : info.label;
    return { emoji: info.emoji, label };
  }

  return { emoji: '\u25B7', label: 'Terminal' };
}

// ── BMAD Commands for palette ────────────────────────────────────────────────

const BMAD_COMMANDS = [
  // ── Development ──
  { id: 'dev-story',       title: 'Dev Story',           desc: 'Implement a story from its spec file',           command: '/bmad-bmm-dev-story',           icon: '&#9654;',   category: 'dev' },
  { id: 'create-story',    title: 'Create Story',        desc: 'Create a story file with full context',          command: '/bmad-bmm-create-story',        icon: '+',         category: 'dev' },
  { id: 'code-review',     title: 'Code Review',         desc: 'Adversarial code review finding issues',         command: '/bmad-bmm-code-review',         icon: '&#10003;',  category: 'dev' },
  { id: 'quick-spec',      title: 'Quick Spec',          desc: 'Create a quick tech spec for small changes',     command: '/bmad-bmm-quick-spec',          icon: '&#9998;',   category: 'dev' },
  { id: 'quick-dev',       title: 'Quick Dev',           desc: 'Implement a quick tech spec',                    command: '/bmad-bmm-quick-dev',           icon: '&#9889;',   category: 'dev' },

  // ── Sprint & Project ──
  { id: 'sprint-status',   title: 'Sprint Status',       desc: 'Summarize sprint status and surface risks',      command: '/bmad-bmm-sprint-status',       icon: '&#9776;',   category: 'sprint' },
  { id: 'sprint-planning', title: 'Sprint Planning',     desc: 'Generate sprint plan from epics',                command: '/bmad-bmm-sprint-planning',     icon: '&#9783;',   category: 'sprint' },
  { id: 'correct-course',  title: 'Correct Course',      desc: 'Propose sprint change for significant shifts',   command: '/bmad-bmm-correct-course',      icon: '&#8634;',   category: 'sprint' },
  { id: 'retrospective',   title: 'Retrospective',       desc: 'Post-epic review to extract lessons',            command: '/bmad-bmm-retrospective',       icon: '&#127881;', category: 'sprint' },

  // ── Planning & Design ──
  { id: 'create-prd',      title: 'Create PRD',          desc: 'Create a product requirements document',         command: '/bmad-bmm-create-prd',          icon: '&#128196;', category: 'planning' },
  { id: 'edit-prd',        title: 'Edit PRD',            desc: 'Edit an existing PRD',                           command: '/bmad-bmm-edit-prd',            icon: '&#9998;',   category: 'planning' },
  { id: 'validate-prd',    title: 'Validate PRD',        desc: 'Validate PRD against standards',                 command: '/bmad-bmm-validate-prd',        icon: '&#10003;',  category: 'planning' },
  { id: 'create-arch',     title: 'Create Architecture', desc: 'Create architecture and solution design',        command: '/bmad-bmm-create-architecture', icon: '&#9881;',   category: 'planning' },
  { id: 'create-ux',       title: 'Create UX Design',    desc: 'Plan UX patterns and design specs',              command: '/bmad-bmm-create-ux-design',    icon: '&#9734;',   category: 'planning' },
  { id: 'create-epics',    title: 'Create Epics & Stories', desc: 'Break requirements into epics and stories',   command: '/bmad-bmm-create-epics-and-stories', icon: '&#9776;', category: 'planning' },
  { id: 'create-brief',    title: 'Create Product Brief', desc: 'Collaborative product brief discovery',         command: '/bmad-bmm-create-product-brief', icon: '&#128221;', category: 'planning' },
  { id: 'check-readiness', title: 'Check Readiness',     desc: 'Validate specs are complete for implementation', command: '/bmad-bmm-check-implementation-readiness', icon: '&#9989;', category: 'planning' },

  // ── Research ──
  { id: 'market-research', title: 'Market Research',     desc: 'Research competition and customers',             command: '/bmad-bmm-market-research',     icon: '&#128200;', category: 'research' },
  { id: 'domain-research', title: 'Domain Research',     desc: 'Research domain and industry',                   command: '/bmad-bmm-domain-research',     icon: '&#128218;', category: 'research' },
  { id: 'tech-research',   title: 'Technical Research',  desc: 'Research technologies and architecture',         command: '/bmad-bmm-technical-research',  icon: '&#128300;', category: 'research' },

  // ── Review ──
  { id: 'adversarial',     title: 'Adversarial Review',  desc: 'Cynical review producing findings report',       command: '/bmad-review-adversarial-general', icon: '&#128065;', category: 'review' },
  { id: 'edge-cases',      title: 'Edge Case Hunter',    desc: 'Find unhandled edge cases and boundary conditions', command: '/bmad-review-edge-case-hunter', icon: '&#128270;', category: 'review' },
  { id: 'prose-review',    title: 'Prose Review',        desc: 'Clinical copy-edit for communication issues',    command: '/bmad-editorial-review-prose',  icon: '&#128214;', category: 'review' },
  { id: 'structure-review', title: 'Structure Review',   desc: 'Propose cuts, reorganization, simplification',   command: '/bmad-editorial-review-structure', icon: '&#128209;', category: 'review' },

  // ── Other ──
  { id: 'qa-e2e',          title: 'Generate E2E Tests',  desc: 'Create automated end-to-end tests',              command: '/bmad-bmm-qa-generate-e2e-tests', icon: '&#9888;', category: 'other' },
  { id: 'doc-project',     title: 'Document Project',    desc: 'Generate project docs for AI context',           command: '/bmad-bmm-document-project',    icon: '&#128196;', category: 'other' },
  { id: 'gen-context',     title: 'Generate Context',    desc: 'Create project-context.md with AI rules',        command: '/bmad-bmm-generate-project-context', icon: '&#128736;', category: 'other' },
  { id: 'party-mode',      title: 'Party Mode',          desc: 'Multi-agent group discussion',                   command: '/bmad-party-mode',              icon: '&#127881;', category: 'other' },
  { id: 'brainstorm',      title: 'Brainstorming',       desc: 'Facilitate creative ideation session',           command: '/bmad-brainstorming',           icon: '&#128161;', category: 'other' },
  { id: 'bmad-help',       title: 'BMAD Help',           desc: 'Get advice on what to do next',                  command: '/bmad-help',                    icon: '?',         category: 'other' },
];

// ── Load xterm.js modules (once) ─────────────────────────────────────────────

function loadXtermModules() {
  if (xtermLoaded) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = './node_modules/@xterm/xterm/css/xterm.css';
    document.head.appendChild(link);

    const xtermScript = document.createElement('script');
    xtermScript.src = './node_modules/@xterm/xterm/lib/xterm.js';
    xtermScript.onload = () => {
      const fitScript = document.createElement('script');
      fitScript.src = './node_modules/@xterm/addon-fit/lib/addon-fit.js';
      fitScript.onload = () => {
        const linksScript = document.createElement('script');
        linksScript.src = './node_modules/@xterm/addon-web-links/lib/addon-web-links.js';
        linksScript.onload = () => { xtermLoaded = true; resolve(); };
        linksScript.onerror = () => { xtermLoaded = true; resolve(); };
        document.head.appendChild(linksScript);
      };
      fitScript.onerror = reject;
      document.head.appendChild(fitScript);
    };
    xtermScript.onerror = reject;
    document.head.appendChild(xtermScript);
  });
}

// ── Tab Management ───────────────────────────────────────────────────────────

/**
 * Create a new terminal tab.
 * @param {string|null} slashCommand - Command to run after claude starts (null = plain terminal)
 * @param {object} [opts] - Options for session persistence
 * @param {string} [opts.claudeSessionId] - Claude session UUID (for --session-id or --resume)
 * @param {boolean} [opts.resume] - If true, resume an existing session instead of starting new
 * @returns {number} The new tab ID
 */
async function createTab(slashCommand, opts) {
  // Always ensure a claudeSessionId so every session can be resumed
  const resume = (opts && opts.resume) || false;
  const claudeSessionId = (opts && opts.claudeSessionId) || (resume ? null : crypto.randomUUID());
  await loadXtermModules();

  const TerminalClass = window.Terminal || (window.exports && window.exports.Terminal);
  if (!TerminalClass) { console.error('xterm Terminal class not found'); return null; }

  const tabId = nextTabId++;
  const tabInfo = (opts && opts.clean) ? { emoji: '$', label: 'Shell' } : getTabInfo(slashCommand);
  if (resume) tabInfo.label += ' \u21BB';

  // Create xterm instance
  const term = new TerminalClass({
    theme: warpTheme,
    fontFamily: "'JetBrains Mono', 'SF Mono', 'Menlo', 'Consolas', 'Fira Code', monospace",
    fontSize: 13,
    lineHeight: 1.4,
    letterSpacing: 0,
    cursorStyle: 'bar',
    cursorBlink: true,
    cursorWidth: 2,
    allowProposedApi: true,
    scrollback: 10000,
    tabStopWidth: 4,
    drawBoldTextInBrightColors: true,
    minimumContrastRatio: 1
  });

  // Addons
  let fitAddon = null;
  const FitAddonClass = window.FitAddon?.FitAddon || (window.exports && window.exports.FitAddon);
  if (FitAddonClass) {
    fitAddon = new FitAddonClass();
    term.loadAddon(fitAddon);
  }
  const WebLinksAddonClass = window.WebLinksAddon?.WebLinksAddon || (window.exports && window.exports.WebLinksAddon);
  if (WebLinksAddonClass) {
    term.loadAddon(new WebLinksAddonClass());
  }

  // Create container element
  const containerEl = document.createElement('div');
  containerEl.className = 'terminal-xterm';
  containerEl.id = `terminal-xterm-${tabId}`;
  containerEl.style.display = 'none';
  document.getElementById('terminal-body').appendChild(containerEl);

  // Open xterm in the container
  term.open(containerEl);

  // Extract story info from slash command opts
  const storySlug = (opts && opts.storySlug) || null;
  const storyPhase = (opts && opts.storyPhase) || null;

  // Build tab object
  const tab = {
    id: tabId,
    term,
    fitAddon,
    sessionId: null,
    cleanupData: null,
    cleanupExit: null,
    containerEl,
    emoji: tabInfo.emoji,
    label: tabInfo.label,
    slashCommand,
    alive: true,
    // Live process tracking
    storySlug,
    storyPhase,
    // Activity monitoring
    lastDataAt: null,
    activityState: 'idle' // 'working' | 'idle' | 'exited'
  };

  tabs.set(tabId, tab);

  // Save to session history (pass claudeSessionId explicitly since it may be auto-generated)
  saveTabToHistory(tab, slashCommand, { ...opts, claudeSessionId });

  // Wire user input to PTY
  term.onData((data) => {
    if (tab.sessionId !== null) {
      window.api.terminalInput(tab.sessionId, data);
    }
  });

  term.onResize(({ cols, rows }) => {
    if (tab.sessionId !== null) {
      window.api.terminalResize(tab.sessionId, cols, rows);
    }
  });

  // Resize observer
  const resizeObserver = new ResizeObserver(() => {
    if (tab.fitAddon && tab.term && tab.id === activeTabId) {
      try { tab.fitAddon.fit(); } catch { /* ignore */ }
    }
  });
  resizeObserver.observe(containerEl);
  tab._resizeObserver = resizeObserver;

  // Switch to this tab FIRST so container is visible and fitAddon can measure
  switchTab(tabId);

  // Now create PTY with the correct fitted dimensions
  await createPtyForTab(tab);

    if (!(opts && opts.clean)) {
  // Auto-start LLM with command (provider-aware)
  let cmd;
  let provider = (opts && opts.provider) || null;
  if (!provider) {
    try {
      const settings = await window.api.getSettings();
      provider = (settings && settings.defaultLlm) || 'claude';
    } catch { provider = 'claude'; }
  }
  if (provider === 'claude') {
    if (resume && claudeSessionId) {
      cmd = `claude --resume ${claudeSessionId}`;
    } else if (claudeSessionId && slashCommand) {
      cmd = `claude --session-id ${claudeSessionId} "${slashCommand}"`;
    } else if (claudeSessionId) {
      cmd = `claude --session-id ${claudeSessionId}`;
    } else if (slashCommand) {
      cmd = `claude "${slashCommand}"`;
    } else {
      cmd = 'claude';
    }
  } else if (provider === 'codex') {
    if (slashCommand) {
      cmd = `codex "${slashCommand}"`;
    } else {
      cmd = 'codex';
    }
  } else if (provider === 'cursor') {
    cmd = slashCommand ? `cursor "${slashCommand}"` : 'cursor .';
  } else if (provider === 'aider') {
    cmd = slashCommand ? `aider --message "${slashCommand}"` : 'aider';
  } else if (provider === 'opencode') {
    cmd = slashCommand ? `opencode "${slashCommand}"` : 'opencode';
  } else {
    cmd = slashCommand ? `claude "${slashCommand}"` : 'claude';
  }
  setTimeout(() => {
    if (tab.sessionId !== null) {
      window.api.terminalInput(tab.sessionId, cmd + '\r');
    }
  }, 500);
}
  renderTabs();
  return tabId;
}

async function createPtyForTab(tab) {
  // Clean up old listeners
  if (tab.cleanupData) tab.cleanupData();
  if (tab.cleanupExit) tab.cleanupExit();

  const cols = tab.term ? tab.term.cols : 120;
  const rows = tab.term ? tab.term.rows : 30;

  const result = await window.api.terminalCreate({ cols, rows });
  tab.sessionId = result.id;

  tab.cleanupData = window.api.onTerminalData((id, data) => {
    if (id === tab.sessionId && tab.term) {
      tab.term.write(data);
      // Activity tracking
      tab.lastDataAt = Date.now();
      tab.activityState = 'working';
    }
  });

  tab.cleanupExit = window.api.onTerminalExit((id, exitCode) => {
    if (id === tab.sessionId && tab.term) {
      tab.term.writeln(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m`);
      tab.sessionId = null;
      tab.alive = false;
      updateStatusDot();
      renderTabs();
      // Show next-step actions if this is the active tab
      if (tab.id === activeTabId) {
        showNextStepBar(tab);
      }
    }
  });

  tab.alive = true;
  updateStatusDot();
}

function switchTab(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;

  hideNextStepBar();

  // Hide all containers
  for (const [, t] of tabs) {
    t.containerEl.style.display = 'none';
  }

  // Show this tab's container
  tab.containerEl.style.display = '';
  activeTabId = tabId;

  // Show next step bar if this tab is dead
  if (!tab.alive) {
    showNextStepBar(tab);
  }

  // Fit and focus
  if (tab.fitAddon) {
    setTimeout(() => {
      try { tab.fitAddon.fit(); } catch { /* ignore */ }
      tab.term.focus();
    }, 50);
  }

  updateStatusDot();
  renderTabs();
}

function closeTab(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;

  // Kill PTY
  if (tab.sessionId !== null) {
    window.api.terminalKill(tab.sessionId);
  }
  if (tab.cleanupData) tab.cleanupData();
  if (tab.cleanupExit) tab.cleanupExit();
  if (tab._resizeObserver) tab._resizeObserver.disconnect();

  // Remove DOM
  tab.term.dispose();
  tab.containerEl.remove();
  tabs.delete(tabId);

  // Switch to another tab or create a new one
  if (activeTabId === tabId) {
    const remaining = [...tabs.keys()];
    if (remaining.length > 0) {
      switchTab(remaining[remaining.length - 1]);
    } else {
      activeTabId = null;
      renderTabs();
    }
  } else {
    renderTabs();
  }
}

// ── Tab Bar Rendering ────────────────────────────────────────────────────────

function renderTabs() {
  const container = document.getElementById('terminal-tabs');
  if (!container) return;

  let html = '';
  for (const [, tab] of tabs) {
    const isActive = tab.id === activeTabId;
    const deadClass = !tab.alive ? ' dead' : '';
    const activityClass = tab.activityState || 'idle';
    html += `
      <div class="terminal-tab${isActive ? ' active' : ''}${deadClass}" data-tab-id="${tab.id}" onclick="switchTerminalTab(${tab.id})">
        <span class="terminal-tab-icon">${tab.emoji}</span>
        <span class="terminal-tab-title">${tab.label}</span>
        <span class="activity-dot ${activityClass}" title="${activityClass}"></span>
        <span class="terminal-tab-close" onclick="event.stopPropagation(); closeTerminalTab(${tab.id})" title="Close">&times;</span>
      </div>
    `;
  }
  html += `<button class="terminal-new-tab" onclick="newTerminalTab()" title="New terminal tab (Cmd+T)">+</button>`;
  container.innerHTML = html;
}

// Global handlers for onclick
window.switchTerminalTab = function(tabId) { switchTab(tabId); };
window.closeTerminalTab = function(tabId) { closeTab(tabId); };
window.newTerminalTab = function() { createTab(null); };

// ── Active Stories Tracking ─────────────────────────────────────────────────

/**
 * Get list of stories that are currently active in terminal tabs.
 * Used by app.js to add pulsing animation to phase pills.
 */
function getActiveStories() {
  const active = [];
  for (const [, tab] of tabs) {
    if (tab.alive && tab.storySlug) {
      active.push({ slug: tab.storySlug, phase: tab.storyPhase, tabId: tab.id });
    }
  }
  return active;
}
window.getActiveStories = getActiveStories;

// ── Activity Monitor ────────────────────────────────────────────────────────

setInterval(() => {
  let changed = false;
  for (const [, tab] of tabs) {
    const prev = tab.activityState;
    if (!tab.alive) {
      tab.activityState = 'exited';
    } else if (tab.lastDataAt && Date.now() - tab.lastDataAt > 3000) {
      tab.activityState = 'idle';
    }
    if (tab.activityState !== prev) changed = true;
  }
  if (changed) renderTabs();
}, 2000);

// ── Active Tab Helpers ───────────────────────────────────────────────────────

function getActiveTab() {
  return activeTabId ? tabs.get(activeTabId) : null;
}

window.refitActiveTerminal = function() {
  const tab = getActiveTab();
  if (tab && tab.fitAddon) {
    try { tab.fitAddon.fit(); } catch { /* ignore */ }
  }
};

function executeCommand(command) {
  const tab = getActiveTab();
  if (tab && tab.sessionId !== null && command) {
    window.api.terminalInput(tab.sessionId, command + '\r');
  }
}

function updateStatusDot() {
  const dot = document.getElementById('terminal-status-dot');
  if (!dot) return;
  const tab = getActiveTab();
  const connected = tab && tab.sessionId !== null;
  dot.classList.toggle('disconnected', !connected);
}

// ── Next Step Action Bar ─────────────────────────────────────────────────────

function showNextStepBar(tab) {
  hideNextStepBar();

  const steps = getNextSteps(tab.slashCommand);
  const bar = document.createElement('div');
  bar.id = 'terminal-next-steps';
  bar.className = 'terminal-next-steps';

  let html = '<span class="terminal-next-steps-label">Done!</span>';

  steps.forEach(step => {
    html += `<button class="terminal-next-step-btn" onclick="nextStepAction('${step.command.replace(/'/g, "\\'")}')">${step.emoji} ${step.label}</button>`;
  });

  html += `<button class="terminal-next-step-btn close-btn" onclick="nextStepClose()">Close Tab</button>`;

  bar.innerHTML = html;

  // Insert before the status bar
  const statusBar = document.querySelector('.terminal-status');
  if (statusBar) {
    statusBar.parentNode.insertBefore(bar, statusBar);
  }
}

function hideNextStepBar() {
  const existing = document.getElementById('terminal-next-steps');
  if (existing) existing.remove();
}

window.nextStepAction = function(command) {
  hideNextStepBar();
  // Close the current dead tab
  if (activeTabId) {
    const tab = tabs.get(activeTabId);
    if (tab && !tab.alive) {
      closeTab(activeTabId);
    }
  }
  // Open new tab with the next command
  createTab(command);
};

window.nextStepClose = function() {
  hideNextStepBar();
  if (activeTabId) closeTab(activeTabId);
};

// ── Public API: Send command to terminal ─────────────────────────────────────

/**
 * Send a slash command to the terminal.
 * Creates a new tab with the command as its title.
 * @param {string|null} slashCommand
 * @param {object} [opts] - { claudeSessionId, resume }
 */
window.sendToTerminal = function(slashCommand, opts) {
  if (terminalSetupDone) {
    // Terminal is ready — create tab directly, no pending state needed
    createTab(slashCommand, opts);
  } else {
    // Terminal not yet initialized — store for pending pickup by initTerminal()
    window._pendingTerminalCommand = slashCommand;
    window._pendingTerminalOpts = opts || null;
  }
};

// ── Toolbar Controls ─────────────────────────────────────────────────────────

function setupToolbar() {
  const clearBtn = document.getElementById('btn-terminal-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      const tab = getActiveTab();
      if (tab && tab.term) tab.term.clear();
    });
  }
}

async function updateCwdDisplay() {
  const cwdEl = document.getElementById('terminal-cwd');
  if (!cwdEl) return;

  const projectPath = await window.api.getProjectPath();
  if (projectPath) {
    const parts = projectPath.split('/');
    const short = parts.slice(-2).join('/');
    cwdEl.textContent = '~/' + short;
  } else {
    cwdEl.textContent = '~/';
  }
}

// ── Command Palette (Cmd+K) ─────────────────────────────────────────────────

function setupCommandPalette() {
  const palette = document.getElementById('command-palette');
  if (!palette) return;

  const input = palette.querySelector('.command-palette-input');
  const results = palette.querySelector('.command-palette-results');

  renderPaletteResults(BMAD_COMMANDS, results);

  input.addEventListener('input', () => {
    const query = input.value.toLowerCase();
    const filtered = BMAD_COMMANDS.filter(cmd =>
      cmd.title.toLowerCase().includes(query) ||
      cmd.desc.toLowerCase().includes(query) ||
      cmd.command.toLowerCase().includes(query)
    );
    paletteSelectedIndex = 0;
    renderPaletteResults(filtered, results);
  });

  input.addEventListener('keydown', (e) => {
    const items = results.querySelectorAll('.command-palette-item');

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      paletteSelectedIndex = Math.min(paletteSelectedIndex + 1, items.length - 1);
      updatePaletteSelection(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      paletteSelectedIndex = Math.max(paletteSelectedIndex - 1, 0);
      updatePaletteSelection(items);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const selected = items[paletteSelectedIndex];
      if (selected) {
        const cmd = selected.dataset.command;
        // Commands from palette create a new tab
        createTab(cmd);
        hidePalette();
      }
    } else if (e.key === 'Escape') {
      hidePalette();
    }
  });

  // Close palette on Escape from anywhere (not just input)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !palette.classList.contains('hidden')) {
      hidePalette();
    }
  });

  // Close palette when clicking outside it
  document.addEventListener('mousedown', (e) => {
    if (!palette.classList.contains('hidden') && !palette.contains(e.target)) {
      hidePalette();
    }
  });
}

function renderPaletteResults(commands, container) {
  container.innerHTML = commands.map((cmd, i) => {
    const inQuickMenu = quickActions.some(a => a.command === cmd.command);
    return `
      <div class="command-palette-item ${i === paletteSelectedIndex ? 'selected' : ''}"
           data-command="${cmd.command}">
        <div class="command-palette-item-icon">${cmd.icon}</div>
        <div class="command-palette-item-content" onclick="paletteCreateTab('${cmd.command.replace(/'/g, "\\'")}')">
          <div class="command-palette-item-title">${cmd.title}</div>
          <div class="command-palette-item-desc">${cmd.desc}</div>
        </div>
        <button class="command-palette-pin-btn ${inQuickMenu ? 'pinned' : ''}"
                onclick="event.stopPropagation(); toggleQuickAction('${cmd.command.replace(/'/g, "\\'")}')"
                title="${inQuickMenu ? 'Remove from quick menu' : 'Add to quick menu'}">
          ${inQuickMenu ? '\u2605' : '\u2606'}
        </button>
      </div>
    `;
  }).join('');
}

window.paletteCreateTab = function(command) {
  createTab(command);
  hidePalette();
};

window.toggleQuickAction = function(command) {
  const idx = quickActions.findIndex(a => a.command === command);
  if (idx !== -1) {
    quickActions.splice(idx, 1);
  } else {
    const info = COMMAND_TAB_INFO[command];
    const bmadCmd = BMAD_COMMANDS.find(c => c.command === command);
    const emoji = info ? info.emoji : '\u25B7';
    const label = info ? info.label : (bmadCmd ? bmadCmd.title : command);
    quickActions.push({ emoji, label, command });
  }
  saveQuickActions();
  renderQuickActions();
  // Re-render palette to update pin states
  const results = document.querySelector('.command-palette-results');
  const input = document.querySelector('.command-palette-input');
  if (results && input) {
    const query = input.value.toLowerCase();
    const filtered = query
      ? BMAD_COMMANDS.filter(cmd => cmd.title.toLowerCase().includes(query) || cmd.desc.toLowerCase().includes(query) || cmd.command.toLowerCase().includes(query))
      : BMAD_COMMANDS;
    renderPaletteResults(filtered, results);
  }
};

function updatePaletteSelection(items) {
  items.forEach((item, i) => {
    item.classList.toggle('selected', i === paletteSelectedIndex);
  });
  const selected = items[paletteSelectedIndex];
  if (selected) selected.scrollIntoView({ block: 'nearest' });
}

function showPalette() {
  const palette = document.getElementById('command-palette');
  if (!palette) return;
  palette.classList.remove('hidden');
  const input = palette.querySelector('.command-palette-input');
  input.value = '';
  input.focus();
  paletteSelectedIndex = 0;
  renderPaletteResults(BMAD_COMMANDS, palette.querySelector('.command-palette-results'));
}

function hidePalette() {
  const palette = document.getElementById('command-palette');
  if (palette) palette.classList.add('hidden');
  const tab = getActiveTab();
  if (tab) tab.term.focus();
}

// ── BMAD Quick Actions (sidebar) — dynamic & editable ────────────────────────

const DEFAULT_QUICK_ACTIONS = [
  { emoji: '\uD83D\uDCD3', label: 'Create Story', command: '/bmad-bmm-create-story' },
  { emoji: '\uD83D\uDCBB', label: 'Dev Story',    command: '/bmad-bmm-dev-story' },
  { emoji: '\uD83D\uDD75\uFE0F', label: 'Code Review',  command: '/bmad-bmm-code-review' },
  { emoji: '\uD83C\uDF89', label: 'Party Mode',   command: '/bmad-party-mode' },
];

let quickActions = [];
let quickActionsEditing = false;

async function loadQuickActions() {
  const saved = await window.api.getQuickActions();
  quickActions = saved || [...DEFAULT_QUICK_ACTIONS];
  renderQuickActions();
}

async function saveQuickActions() {
  await window.api.saveQuickActions(quickActions);
}

function renderQuickActions() {
  const list = document.getElementById('bmad-action-list');
  if (!list) return;

  list.className = 'bmad-action-list' + (quickActionsEditing ? ' editing' : '');

  let html = '';
  quickActions.forEach((action, i) => {
    html += `
      <button class="bmad-action-btn" data-index="${i}" title="${action.command}">
        <span class="bmad-action-icon">${action.emoji}</span>
        <span>${action.label}</span>
        <span class="bmad-remove-btn" data-remove="${i}" title="Remove">&times;</span>
      </button>
    `;
  });

  // "More Actions" is always present and not removable
  html += `
    <button class="bmad-action-btn" data-action="more-actions" title="All BMAD commands (Cmd+K)">
      <span class="bmad-action-icon">\uD83C\uDFA8</span>
      <span>More Actions</span>
    </button>
  `;

  // Add form (visible in edit mode)
  if (quickActionsEditing) {
    html += `
      <button class="bmad-action-btn" data-action="add-custom" title="Add custom command" style="color:var(--accent)">
        <span class="bmad-action-icon" style="color:var(--accent)">+</span>
        <span>Add Command</span>
      </button>
    `;
  }

  list.innerHTML = html;
  wireQuickActionClicks();
}

function wireQuickActionClicks() {
  const list = document.getElementById('bmad-action-list');
  if (!list) return;

  list.querySelectorAll('.bmad-action-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      // Handle remove button
      const removeBtn = e.target.closest('.bmad-remove-btn');
      if (removeBtn) {
        e.stopPropagation();
        const idx = parseInt(removeBtn.dataset.remove, 10);
        quickActions.splice(idx, 1);
        saveQuickActions();
        renderQuickActions();
        return;
      }

      const action = btn.dataset.action;
      if (action === 'more-actions') {
        if (typeof window.showView === 'function') {
          window.showView('terminal');
        }
        setTimeout(() => showPalette(), 150);
        return;
      }

      if (action === 'add-custom') {
        showAddCommandForm();
        return;
      }

      // Normal command button
      const idx = parseInt(btn.dataset.index, 10);
      const qa = quickActions[idx];
      if (qa) {
        window.sendToTerminal(qa.command);
        if (typeof window.showView === 'function') {
          window.showView('terminal');
        }
      }
    });
  });
}

function showAddCommandForm() {
  // Check if form already exists
  if (document.getElementById('qa-add-form')) return;

  const list = document.getElementById('bmad-action-list');
  const form = document.createElement('div');
  form.id = 'qa-add-form';
  form.className = 'quick-action-form';
  form.innerHTML = `
    <div class="quick-action-form-row">
      <input type="text" class="qa-emoji-input" placeholder="\uD83D\uDE80" maxlength="4" id="qa-new-emoji">
      <input type="text" class="qa-label-input" placeholder="Label" id="qa-new-label">
    </div>
    <input type="text" class="qa-command-input" placeholder="Command (e.g. /bmad-help or git status)" id="qa-new-command">
    <div class="quick-action-form-actions">
      <button class="btn btn-ghost btn-sm" id="qa-cancel-btn">Cancel</button>
      <button class="btn btn-primary btn-sm" id="qa-save-btn">Add</button>
    </div>
  `;
  list.appendChild(form);

  document.getElementById('qa-new-emoji').focus();

  document.getElementById('qa-cancel-btn').addEventListener('click', () => form.remove());
  document.getElementById('qa-save-btn').addEventListener('click', () => {
    const emoji = document.getElementById('qa-new-emoji').value.trim() || '\u25B7';
    const label = document.getElementById('qa-new-label').value.trim();
    const command = document.getElementById('qa-new-command').value.trim();
    if (!label || !command) return;
    quickActions.push({ emoji, label, command });
    saveQuickActions();
    form.remove();
    renderQuickActions();
  });

  // Enter to save
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('qa-save-btn').click();
    } else if (e.key === 'Escape') {
      form.remove();
    }
  });
}

/**
 * Add a command to quick actions from the palette.
 */
window.addToQuickActions = function(command) {
  // Find matching BMAD command for label/emoji
  const info = COMMAND_TAB_INFO[command];
  const emoji = info ? info.emoji : '\u25B7';
  const label = info ? info.label : command;

  // Don't add duplicates
  if (quickActions.some(a => a.command === command)) return;

  quickActions.push({ emoji, label, command });
  saveQuickActions();
  renderQuickActions();
};

function setupBmadActions() {
  // Load and render quick actions
  loadQuickActions();

  // Edit button
  const editBtn = document.getElementById('btn-edit-quick-actions');
  if (editBtn) {
    editBtn.addEventListener('click', () => {
      quickActionsEditing = !quickActionsEditing;
      editBtn.classList.toggle('active', quickActionsEditing);
      renderQuickActions();
    });
  }
}

// ── Keyboard Shortcuts ───────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  // Cmd+K = Command palette (when terminal view is active)
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    if (currentView === 'terminal') {
      e.preventDefault();
      const palette = document.getElementById('command-palette');
      if (palette && !palette.classList.contains('hidden')) {
        hidePalette();
      } else {
        showPalette();
      }
    }
  }

  // Cmd+T = New terminal tab (when in terminal view)
  if ((e.metaKey || e.ctrlKey) && e.key === 't' && currentView === 'terminal') {
    e.preventDefault();
    createTab(null);
  }

  // Cmd+W = Close active tab (when in terminal view)
  if ((e.metaKey || e.ctrlKey) && e.key === 'w' && currentView === 'terminal') {
    e.preventDefault();
    if (activeTabId) closeTab(activeTabId);
  }
});

// ── Terminal Initialization (called once when terminal view is first shown) ──

let terminalSetupDone = false;

async function initTerminal() {
  if (terminalSetupDone) return;
  terminalSetupDone = true;

  setupToolbar();
  setupCommandPalette();
  updateCwdDisplay();

  // Create first tab — check for pending command
  const pending = window._pendingTerminalCommand;
  const pendingOpts = window._pendingTerminalOpts;
  window._pendingTerminalCommand = null;
  window._pendingTerminalOpts = null;
  await createTab(pending || null, pendingOpts || undefined);
}

// ── Integration with main app.js view system ─────────────────────────────────

const originalShowView = window.showView;

function terminalAwareShowView(view) {
  // Show/hide BMAD actions sidebar section
  const bmadActions = document.getElementById('bmad-actions');
  if (bmadActions) {
    bmadActions.classList.toggle('hidden', view !== 'terminal');
  }

  // Let the original showView handle layout (split-top/bottom visibility)
  if (typeof originalShowView === 'function') {
    originalShowView(view);
  }

  if (view === 'terminal') {
    if (!terminalSetupDone) {
      initTerminal();
    } else {
      // If there's a pending command, create a new tab for it
      const pending = window._pendingTerminalCommand;
      const pendingOpts = window._pendingTerminalOpts;
      if (pending) {
        window._pendingTerminalCommand = null;
        window._pendingTerminalOpts = null;
        createTab(pending, pendingOpts || undefined);
      } else {
        // Just focus the active tab
        const tab = getActiveTab();
        if (tab && tab.fitAddon) {
          setTimeout(() => {
            try { tab.fitAddon.fit(); } catch { /* ignore */ }
            tab.term.focus();
          }, 50);
        }
        // If no tabs exist, create one
        if (tabs.size === 0) {
          createTab(null);
        }
      }
    }
    return;
  }

  // Ensure terminal is initialized even in split mode (lazy init)
  if (!terminalSetupDone) {
    initTerminal();
  } else {
    // Refit terminal when switching views (split size may have changed)
    const tab = getActiveTab();
    if (tab && tab.fitAddon) {
      setTimeout(() => {
        try { tab.fitAddon.fit(); } catch { /* ignore */ }
      }, 50);
    }
  }
}

// ── Session History ──────────────────────────────────────────────────────────

/**
 * Save a tab entry to persistent session history.
 */
async function saveTabToHistory(tab, slashCommand, opts) {
  const { claudeSessionId } = opts || {};
  const tabInfo = getTabInfo(slashCommand);

  await window.api.saveSessionHistory({
    id: `session-${Date.now()}-${tab.id}`,
    tabId: tab.id,
    command: slashCommand || null,
    label: tabInfo.label,
    emoji: tabInfo.emoji,
    claudeSessionId: claudeSessionId || null,
    createdAt: new Date().toISOString()
    // projectPath and projectName are added server-side
  });
}

/**
 * Render the session history view (called from app.js showView).
 */
window.renderSessionHistory = async function() {
  const listEl = document.getElementById('history-list');
  if (!listEl) return;

  const history = await window.api.getSessionHistory();

  // Show max 5 most recent
  const recent = history.slice(0, 5);

  if (recent.length === 0) {
    listEl.innerHTML = `
      <div class="history-empty">
        <div class="history-empty-icon">&#128336;</div>
        <h3>No sessions yet</h3>
        <p>Start a terminal session from the Terminal view or via a BMAD command. Your recent sessions will appear here.</p>
        <button class="btn btn-primary" onclick="window.showView('terminal')">Open Terminal</button>
      </div>
    `;
    return;
  }

  listEl.innerHTML = recent.map(entry => {
    const timeAgo = formatTimeAgo(entry.createdAt);
    const hasClaudeSession = !!entry.claudeSessionId;
    const commandDisplay = entry.command || 'claude';

    return `
      <div class="history-card" onclick="historyResumeSession('${escAttr(entry.id)}', '${escAttr(entry.command || '')}', '${escAttr(entry.claudeSessionId || '')}')">
        <div class="history-card-header">
          <div class="history-card-emoji">${entry.emoji || '&#9002;'}</div>
          <div class="history-card-info">
            <div class="history-card-title">${escHtml(entry.label || 'Terminal')}</div>
            <div class="history-card-meta">
              <span class="history-card-meta-item">
                <span class="history-card-command">${escHtml(commandDisplay)}</span>
              </span>
              <span class="history-card-meta-item">${timeAgo}</span>
              ${entry.projectName ? `<span class="history-card-meta-item">${escHtml(entry.projectName)}</span>` : ''}
            </div>
          </div>
          <div class="history-card-actions">
            ${hasClaudeSession
              ? `<button class="history-card-btn resume" onclick="event.stopPropagation(); historyResumeSession('${escAttr(entry.id)}', '${escAttr(entry.command || '')}', '${escAttr(entry.claudeSessionId)}')">Resume</button>`
              : `<button class="history-card-btn" onclick="event.stopPropagation(); historyRestartSession('${escAttr(entry.command || '')}')">Restart</button>`
            }
            <button class="history-card-btn delete" onclick="event.stopPropagation(); historyRemoveSession('${escAttr(entry.id)}')" title="Remove from history">&times;</button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Wire clear history button
  const clearBtn = document.getElementById('btn-clear-history');
  if (clearBtn) {
    clearBtn.onclick = async () => {
      await window.api.clearSessionHistory();
      window.renderSessionHistory();
    };
  }
};

/**
 * Resume a Claude session from history (uses --resume).
 */
window.historyResumeSession = function(entryId, command, claudeSessionId) {
  if (claudeSessionId) {
    // Resume existing Claude session
    window.sendToTerminal(command || null, { claudeSessionId, resume: true });
  } else {
    // No Claude session ID, restart command
    window.sendToTerminal(command || null);
  }
  window.showView('terminal');
};

/**
 * Restart a command from history (fresh session, same command).
 */
window.historyRestartSession = function(command) {
  window.sendToTerminal(command || null);
  window.showView('terminal');
};

/**
 * Remove a single session from history.
 */
window.historyRemoveSession = async function(entryId) {
  await window.api.removeSessionHistory(entryId);
  window.renderSessionHistory();
};

// ── History Helpers ──────────────────────────────────────────────────────────

function formatTimeAgo(isoString) {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay === 1) return 'yesterday';
  if (diffDay < 7) return `${diffDay}d ago`;

  return new Date(isoString).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(str) {
  if (!str) return '';
  return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// ── Init ────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
  // Wire up BMAD sidebar buttons immediately (before terminal is opened)
  setupBmadActions();

  setTimeout(() => {
    window.showView = terminalAwareShowView;

    const termNav = document.querySelector('[data-view="terminal"]');
    if (termNav) {
      termNav.addEventListener('click', () => {
        window.showView('terminal');
      });
    }
  }, 0);
});
