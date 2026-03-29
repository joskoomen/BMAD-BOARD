/** Terminal Renderer — Warp-style embedded terminal with multi-tab support.
 *
 * Manages the full lifecycle of the embedded xterm.js terminal panel, including:
 * - Multi-tab PTY sessions, each backed by a node-pty process in the main process
 * - Tab titles with emoji derived from BMAD slash commands via COMMAND_TAB_INFO
 * - Automatic LLM startup (claude/codex/cursor/aider/opencode) in each new tab
 * - Warp-inspired command palette (Cmd+K) for browsing and launching BMAD commands
 * - Pinnable quick-action sidebar with persistent user customisation
 * - Session history: saves every tab to disk so sessions can be resumed later
 * - Activity monitoring: colour-coded dots that distinguish idle / working / exited tabs
 * - Next-step suggestion bar shown when a tab's process exits
 *
 * Communication with the main process is exclusively through `window.api`
 * (exposed by preload.js via contextBridge).  The renderer never calls Node APIs
 * directly.
 *
 * @module terminal-renderer
 */

/* global Terminal, FitAddon, WebLinksAddon */

// ── Tab State ────────────────────────────────────────────────────────────────

/** Map of all open terminal tabs, keyed by numeric tab ID.
 * @type {Map<number, object>}
 */
const tabs = new Map();

/** The tab ID of the currently visible/focused tab, or null when no tabs exist.
 * @type {number|null}
 */
let activeTabId = null;

/** Monotonically-increasing counter used to assign unique IDs to new tabs.
 * @type {number}
 */
let nextTabId = 1;

/** Whether the xterm.js scripts and CSS have already been injected into the page.
 * @type {boolean}
 */
let xtermLoaded = false;

/** Zero-based index of the currently highlighted item in the command palette.
 * @type {number}
 */
let paletteSelectedIndex = 0;

/** Shared xterm.js colour theme.  Inspired by Warp's dark palette with a purple
 * accent.  Applied to every Terminal instance created by {@link createTab}.
 * @type {object}
 */
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

/** Mapping from BMAD slash-command strings to the emoji and short label used in
 * the tab bar.  Consumed by {@link getTabInfo} and {@link toggleQuickAction}.
 *
 * Each key is a full slash command (e.g. `'/bmad-bmm-dev-story'`) and each
 * value is `{ emoji: string, label: string }`.
 *
 * @type {Object<string, {emoji: string, label: string}>}
 */
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

/** Workflow-aware next-step suggestions shown when a tab's process exits.
 * Maps a slash command to an ordered list of recommended follow-up actions.
 * Each suggestion has `{ emoji, label, command }`.
 * @type {Object<string, Array<{emoji: string, label: string, command: string}>>}
 */
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

/** Return the list of suggested next-step actions for the given slash command.
 * Strips any arguments so only the base command is looked up in NEXT_STEPS.
 * @param {string|null} slashCommand - The slash command that just finished (e.g. '/bmad-bmm-dev-story 2.1').
 * @returns {Array<{emoji: string, label: string, command: string}>} Suggested follow-up actions, or an empty array.
 */
function getNextSteps(slashCommand) {
  if (!slashCommand) return [];
  const baseCmd = slashCommand.split(' ')[0];
  return NEXT_STEPS[baseCmd] || [];
}

/** Derive a tab title from a slash command string.
 * Looks up the base command in {@link COMMAND_TAB_INFO} and appends any
 * trailing arguments to the label.
 * @example
 * getTabInfo('/bmad-bmm-dev-story 2.5.5')
 * // → { emoji: '▶', label: 'Dev Story 2.5.5' }
 * @param {string|null} slashCommand - Full slash command, optionally with arguments.
 * @returns {{emoji: string, label: string}} Display info for the tab, falling back to a generic Terminal entry.
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

/** Full catalogue of BMAD commands available in the command palette (Cmd+K).
 * Each entry has `{ id, title, desc, command, icon, category }` and is rendered
 * as a searchable row in {@link renderPaletteResults}.
 * @type {Array<{id: string, title: string, desc: string, command: string, icon: string, category: string}>}
 */
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

/** Lazily inject xterm.js and its addons into the page via dynamic script tags.
 * Loads them in dependency order: xterm core → FitAddon → WebLinksAddon →
 * Unicode11Addon.  Subsequent calls resolve immediately thanks to the
 * `xtermLoaded` guard, so it is safe to call before every {@link createTab}.
 * @returns {Promise<void>} Resolves once all scripts have loaded.
 */
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
        linksScript.onload = () => {
          const unicodeScript = document.createElement('script');
          unicodeScript.src = './node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js';
          unicodeScript.onload = () => { xtermLoaded = true; resolve(); };
          unicodeScript.onerror = () => { xtermLoaded = true; resolve(); };
          document.head.appendChild(unicodeScript);
        };
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
  // Pro feature gate: free tier limited to 1 terminal tab
  if (!window._isPro && tabs.length >= 1) {
    if (typeof window.showUpgradeModal === 'function') {
      window.showUpgradeModal('multi-tab');
    }
    return null;
  }

  // Always ensure a claudeSessionId so every session can be resumed
  const resume = (opts && opts.resume) || false;
  const claudeSessionId = (opts && opts.claudeSessionId) || (resume ? null : crypto.randomUUID());
  await loadXtermModules();

  const TerminalClass = window.Terminal || (window.exports && window.exports.Terminal);
  if (!TerminalClass) {
    console.error('xterm Terminal class not found');
    return null;
  }

  const tabId = nextTabId++;
  const tabInfo = (opts && opts.clean) ? {emoji: '$', label: 'Shell'} : getTabInfo(slashCommand);
  if (resume) tabInfo.label += ' \u21BB';

  // Create xterm instance
  const term = new TerminalClass({
    theme: warpTheme,
    fontFamily: "'JetBrains Mono', 'SF Mono', 'Menlo', 'Consolas', 'Fira Code', monospace",
    fontSize: 13,
    lineHeight: 1.2,
    letterSpacing: 0,
    cursorStyle: 'bar',
    cursorBlink: true,
    cursorWidth: 2,
    allowProposedApi: true,
    scrollback: 10000,
    tabStopWidth: 4,
    drawBoldTextInBrightColors: true,
    fontWeightBold: 'normal',
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
  const Unicode11AddonClass = window.Unicode11Addon?.Unicode11Addon || (window.exports && window.exports.Unicode11Addon);
  if (Unicode11AddonClass) {
    term.loadAddon(new Unicode11AddonClass());
    term.unicode.activeVersion = '11';
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
    activityState: 'idle', // 'working' | 'idle' | 'exited'
    // Auto-return to git view when this tab's process exits
    returnToGitView: opts?.returnToGitView || false
  };

  tabs.set(tabId, tab);

  // Save to session history (pass claudeSessionId explicitly since it may be auto-generated)
  saveTabToHistory(tab, slashCommand, {...opts, claudeSessionId});

  // Wire user input to PTY
  term.onData((data) => {
    if (tab.sessionId !== null) {
      window.api.terminalInput(tab.sessionId, data);
    }
  });

  term.onResize(({cols, rows}) => {
    if (tab.sessionId !== null) {
      window.api.terminalResize(tab.sessionId, cols, rows);
    }
  });

  // Resize observer
  const resizeObserver = new ResizeObserver(() => {
    if (tab.fitAddon && tab.term && tab.id === activeTabId) {
      try {
        tab.fitAddon.fit();
        tab.term.scrollToBottom();
      } catch { /* ignore */
      }
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
      } catch {
        provider = 'claude';
      }
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
  persistTabState();
  return tabId;
}

/** Spawn a new PTY session for an existing tab and wire up data/exit listeners.
 * Can also be called to replace a dead session on the same tab object — any
 * previous IPC listeners are torn down before the new session is created.
 * Sets `tab.sessionId` on success and marks `tab.alive = true`.
 * @param {object} tab - The tab object from the {@link tabs} map.
 * @returns {Promise<void>} Resolves once the PTY session has been created.
 */
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

      // If this tab was opened for merge conflict resolution, return to git view
      if (tab.returnToGitView) {
        setTimeout(() => {
          closeTab(tab.id);
          if (typeof window.showView === 'function') {
            window.showView('git');
          }
        }, 1500);
      }

      // Show next-step actions if this is the active tab
      if (tab.id === activeTabId) {
        showNextStepBar(tab);
      }
    }
  });

  tab.alive = true;
  updateStatusDot();
}

/** Make the given tab active, showing its xterm container and hiding all others.
 * Triggers a fit + focus after a short delay to let the layout settle.
 * Also shows the next-step bar if the tab's process has already exited.
 * @param {number} tabId - ID of the tab to switch to.
 */
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

  // Fit and focus — stagger to ensure layout has settled
  if (tab.fitAddon) {
    const doFit = () => {
      try { tab.fitAddon.fit(); } catch { /* ignore */ }
      tab.term.scrollToBottom();
    };
    setTimeout(() => { doFit(); tab.term.focus(); }, 50);
    setTimeout(doFit, 200);
  }

  updateStatusDot();
  renderTabs();
}

/** Close a terminal tab, killing its PTY session and removing its DOM elements.
 * If the closed tab was active, switches to the most recently opened remaining
 * tab; if no tabs remain, sets activeTabId to null and re-renders the tab bar.
 * @param {number} tabId - ID of the tab to close.
 */
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
  persistTabState();
}

// ── Tab State Persistence ───────────────────────────────────────────────────

/**
 * Serialize current tabs into a saveable format.
 */
function serializeTabState() {
  const tabList = [];
  let activeIndex = 0;
  let idx = 0;
  for (const [tabId, tab] of tabs) {
    tabList.push({
      slashCommand: tab.slashCommand || null,
      claudeSessionId: null, // sessions can't be resumed after close
      label: tab.label,
      emoji: tab.emoji,
      storySlug: tab.storySlug || null,
      storyPhase: tab.storyPhase || null,
      clean: !tab.slashCommand
    });
    if (tabId === activeTabId) activeIndex = idx;
    idx++;
  }
  return {
    tabs: tabList,
    activeIndex,
    savedAt: new Date().toISOString()
  };
}

/**
 * Async persist current tab state to disk via IPC.
 */
function persistTabState() {
  if (!terminalSetupDone) return;
  const state = serializeTabState();
  window.api.saveTabState(state).catch(() => { /* ignore */ });
}

/**
 * Close all open tabs (used when switching projects).
 */
function closeAllTabs() {
  const tabIds = [...tabs.keys()];
  for (const tabId of tabIds) {
    const tab = tabs.get(tabId);
    if (!tab) continue;
    if (tab.sessionId !== null) {
      window.api.terminalKill(tab.sessionId);
    }
    if (tab.cleanupData) tab.cleanupData();
    if (tab.cleanupExit) tab.cleanupExit();
    if (tab._resizeObserver) tab._resizeObserver.disconnect();
    tab.term.dispose();
    tab.containerEl.remove();
    tabs.delete(tabId);
  }
  activeTabId = null;
  renderTabs();
}
window.closeAllTabs = closeAllTabs;

/**
 * Restore tabs from saved per-project tab state.
 * If no saved state, creates a single default tab.
 */
async function restoreTabState() {
  const state = await window.api.getTabState();
  if (!state || !Array.isArray(state.tabs) || state.tabs.length === 0) {
    // No saved state — create default tab only if terminal is initialized
    if (terminalSetupDone) {
      await createTab(null);
    }
    return;
  }

  // Ensure terminal is initialized before restoring
  if (!terminalSetupDone) {
    terminalSetupDone = true;
    setupToolbar();
    setupCommandPalette();
    updateCwdDisplay();
  }

  for (let i = 0; i < state.tabs.length; i++) {
    const saved = state.tabs[i];
    await createTab(saved.slashCommand, {
      clean: saved.clean || false,
      storySlug: saved.storySlug || null,
      storyPhase: saved.storyPhase || null
    });
  }

  // Switch to previously active tab
  const allTabIds = [...tabs.keys()];
  const targetIdx = Math.min(state.activeIndex || 0, allTabIds.length - 1);
  if (allTabIds.length > 0 && targetIdx >= 0) {
    switchTab(allTabIds[targetIdx]);
  }
}
window.restoreTabState = restoreTabState;

// ── Tab Bar Rendering ────────────────────────────────────────────────────────

/** Re-render the tab bar from the current contents of the {@link tabs} map.
 * Generates one `<div class="terminal-tab">` per tab with activity dot, close
 * button, and a "+ " button to open a new tab.  Idempotent — safe to call
 * after any state change.
 */
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

// Global handlers for onclick — these are called from inline HTML generated by renderTabs()
/** Switch to the specified tab (called from inline onclick in the tab bar).
 * @param {number} tabId - ID of the tab to switch to.
 */
window.switchTerminalTab = function(tabId) { switchTab(tabId); };

/** Close the specified tab (called from inline onclick in the tab bar).
 * @param {number} tabId - ID of the tab to close.
 */
window.closeTerminalTab = function(tabId) { closeTab(tabId); };

/** Open a new plain terminal tab (called from the "+" button in the tab bar). */
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

/** Periodic activity monitor that downgrades a tab's state from 'working' to
 * 'idle' once 3 seconds have passed with no new PTY output.  Runs every 2 s
 * and only triggers a {@link renderTabs} call when at least one tab changes
 * state, keeping unnecessary DOM updates to a minimum.
 */
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

/** Return the active tab object, or null if no tab is currently active.
 * @returns {object|null} The tab from {@link tabs}, or null.
 */
function getActiveTab() {
  return activeTabId ? tabs.get(activeTabId) : null;
}

/** Force-fit the active terminal to its current container size.
 * Called by the split-pane resize handler in app.js whenever the pane layout
 * changes so the PTY column/row count stays in sync with the visible area.
 */
window.refitActiveTerminal = function() {
  const tab = getActiveTab();
  if (tab && tab.fitAddon) {
    try { tab.fitAddon.fit(); } catch { /* ignore */ }
  }
};

/** Send a command string to the active tab's PTY as if the user typed it.
 * A carriage return is appended automatically.  Does nothing if no tab is
 * active or the session has already exited.
 * @param {string} command - The text to send (without a trailing newline).
 */
function executeCommand(command) {
  const tab = getActiveTab();
  if (tab && tab.sessionId !== null && command) {
    window.api.terminalInput(tab.sessionId, command + '\r');
  }
}

/** Update the small status indicator dot in the terminal toolbar to reflect
 * whether the active tab has a live PTY session (connected vs. disconnected).
 */
function updateStatusDot() {
  const dot = document.getElementById('terminal-status-dot');
  if (!dot) return;
  const tab = getActiveTab();
  const connected = tab && tab.sessionId !== null;
  dot.classList.toggle('disconnected', !connected);
}

// ── Next Step Action Bar ─────────────────────────────────────────────────────

/** Inject the "what's next?" action bar above the status bar for a just-exited tab.
 * Looks up workflow suggestions from {@link NEXT_STEPS} and renders one button
 * per suggestion plus a "Close Tab" button.  Removes any existing bar first.
 * @param {object} tab - The tab whose `slashCommand` is used to look up suggestions.
 */
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

/** Remove the next-step action bar from the DOM if it is currently visible. */
function hideNextStepBar() {
  const existing = document.getElementById('terminal-next-steps');
  if (existing) existing.remove();
}

/** Handle a click on a next-step suggestion button.
 * Closes the current (dead) tab and opens a new one with the given command.
 * @param {string} command - The slash command to launch in the new tab.
 */
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

/** Handle a click on the "Close Tab" button in the next-step bar.
 * Hides the bar and closes the active (dead) tab.
 */
window.nextStepClose = function() {
  hideNextStepBar();
  if (activeTabId) closeTab(activeTabId);
};

// ── Public API: Send command to terminal ─────────────────────────────────────

/** Send a slash command to the terminal, creating a new tab.
 * If the terminal has not been initialized yet, stores the command as a
 * pending value that {@link initTerminal} will pick up on first load.
 * @param {string|null} slashCommand - The slash command to run (e.g. '/bmad-bmm-dev-story'), or null for a plain shell.
 * @param {object} [opts] - Options forwarded to {@link createTab}.
 * @param {string} [opts.claudeSessionId] - Existing Claude session UUID for resume.
 * @param {boolean} [opts.resume] - If true, pass `--resume` to claude instead of `--session-id`.
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

/** Attach event listeners to the terminal toolbar buttons.
 * Currently wires the "Clear" button to call `term.clear()` on the active tab.
 */
function setupToolbar() {
  const clearBtn = document.getElementById('btn-terminal-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      const tab = getActiveTab();
      if (tab && tab.term) tab.term.clear();
    });
  }
}

/** Fetch the current project path and display a shortened version (last two
 * path segments prefixed with `~/`) in the `#terminal-cwd` element.
 * @returns {Promise<void>}
 */
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

/** Initialise the command palette UI: wire the search input (live filtering),
 * keyboard navigation (↑↓ to move, Enter to launch, Escape to close), and
 * dismiss-on-outside-click behaviour.  Should be called once during
 * {@link initTerminal}.
 */
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

/** Render a list of BMAD commands into the palette results container.
 * Each row shows an icon, title, description, and a pin button that toggles
 * the command's membership in the quick-actions sidebar.
 * @param {Array<{id: string, title: string, desc: string, command: string, icon: string, category: string}>} commands - Commands to display.
 * @param {HTMLElement} container - The `.command-palette-results` element to populate.
 */
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

/** Create a new tab for the given command and close the palette.
 * Called from inline `onclick` handlers inside {@link renderPaletteResults}.
 * @param {string} command - The slash command to run in the new tab.
 */
window.paletteCreateTab = function(command) {
  createTab(command);
  hidePalette();
};

/** Toggle a command's presence in the quick-actions sidebar.
 * If the command is already pinned it is removed; otherwise it is appended.
 * Persists the new list via {@link saveQuickActions} and refreshes both the
 * sidebar and the palette pin-button states.
 * @param {string} command - The slash command to pin or unpin.
 */
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

/** Highlight the item at {@link paletteSelectedIndex} and scroll it into view.
 * @param {NodeList} items - All `.command-palette-item` elements in the results list.
 */
function updatePaletteSelection(items) {
  items.forEach((item, i) => {
    item.classList.toggle('selected', i === paletteSelectedIndex);
  });
  const selected = items[paletteSelectedIndex];
  if (selected) selected.scrollIntoView({ block: 'nearest' });
}

/** Show the command palette, clear any previous search text, reset the
 * selection index, and focus the search input.
 */
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

/** Hide the command palette and return keyboard focus to the active terminal. */
function hidePalette() {
  const palette = document.getElementById('command-palette');
  if (palette) palette.classList.add('hidden');
  const tab = getActiveTab();
  if (tab) tab.term.focus();
}

// ── BMAD Quick Actions (sidebar) — dynamic & editable ────────────────────────

/** Factory-default set of quick-action buttons shown in the sidebar before the
 * user customises them.  Loaded by {@link loadQuickActions} when no saved list
 * is found in preferences.
 * @type {Array<{emoji: string, label: string, command: string}>}
 */
const DEFAULT_QUICK_ACTIONS = [
  { emoji: '\uD83D\uDCD3', label: 'Create Story', command: '/bmad-bmm-create-story' },
  { emoji: '\uD83D\uDCBB', label: 'Dev Story',    command: '/bmad-bmm-dev-story' },
  { emoji: '\uD83D\uDD75\uFE0F', label: 'Code Review',  command: '/bmad-bmm-code-review' },
  { emoji: '\uD83C\uDF89', label: 'Party Mode',   command: '/bmad-party-mode' },
];

/** Currently pinned quick-action entries shown in the sidebar.  Loaded from
 * persistent storage by {@link loadQuickActions} and mutated by
 * {@link toggleQuickAction} / {@link showAddCommandForm}.
 * @type {Array<{emoji: string, label: string, command: string}>}
 */
let quickActions = [];

/** Whether the sidebar quick-actions list is in edit mode (shows remove buttons
 * and the "Add Command" form trigger).
 * @type {boolean}
 */
let quickActionsEditing = false;

/** Load persisted quick-actions from the main process and render them.
 * Falls back to {@link DEFAULT_QUICK_ACTIONS} if nothing has been saved yet.
 * @returns {Promise<void>}
 */
async function loadQuickActions() {
  const saved = await window.api.getQuickActions();
  quickActions = saved || [...DEFAULT_QUICK_ACTIONS];
  renderQuickActions();
}

/** Persist the current {@link quickActions} array to the main process.
 * @returns {Promise<void>}
 */
async function saveQuickActions() {
  await window.api.saveQuickActions(quickActions);
}

/** Re-render the quick-actions sidebar list from {@link quickActions}.
 * In edit mode adds remove buttons on each entry and an "Add Command" row.
 * Always appends the non-removable "More Actions" button at the bottom.
 * Calls {@link wireQuickActionClicks} after updating the DOM.
 */
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

/** Attach click handlers to all quick-action buttons after a
 * {@link renderQuickActions} call.  Handles remove-button clicks,
 * the "More Actions" shortcut (opens the palette), the "Add Command" form
 * trigger, and normal command-launch clicks.
 */
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

/** Inject an inline form at the bottom of the quick-actions list that lets
 * the user supply an emoji, label, and command string, then appends the new
 * entry to {@link quickActions} and persists it.  The form is idempotent —
 * calling this a second time while the form is already visible is a no-op.
 */
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

/** Add a command to the quick-actions sidebar from an external caller (e.g.
 * the command palette).  Looks up emoji and label from {@link COMMAND_TAB_INFO}.
 * Silently ignores duplicate commands.
 * @param {string} command - The slash command to add.
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

/** Initialise the BMAD sidebar: load persisted quick actions and wire the
 * edit-mode toggle button.  Called once on `DOMContentLoaded`.
 */
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

/** Global keyboard shortcut handler.
 * - `Cmd/Ctrl+K` — toggle the command palette (switches to terminal view first if needed).
 * - `Cmd/Ctrl+T` — open a new plain terminal tab (terminal view only).
 * - `Cmd/Ctrl+W` — close the active terminal tab (terminal view only).
 */
document.addEventListener('keydown', (e) => {
  // Cmd+K = Command palette (works from any view)
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    if (currentView !== 'terminal') {
      const sv = window.showView || function() {};
      sv('terminal');
    }
    const palette = document.getElementById('command-palette');
    if (palette && !palette.classList.contains('hidden')) {
      hidePalette();
    } else {
      showPalette();
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

/** Guards against {@link initTerminal} being called more than once.
 * Set to `true` at the very start of the first `initTerminal` invocation.
 * @type {boolean}
 */
let terminalSetupDone = false;

/** One-time initialisation routine for the terminal panel.
 * Sets up the toolbar and command palette, refreshes the CWD label, and
 * creates the first tab (picking up any pending command stored by
 * {@link window.sendToTerminal} before the terminal was ready).
 * @returns {Promise<void>}
 */
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

// ── Companion: launch command from mobile ─────────────────────────────────────

/** IPC listener for companion (mobile) launch-command events.
 * Switches to the terminal view and opens a new tab with the requested
 * command and optional story metadata.
 */
window.api.onCompanionLaunchCommand(({ command, storySlug, phase }) => {
  // Switch to terminal view and open a new tab with the command
  if (typeof window.showView === 'function') {
    window.showView('terminal');
  }
  window.sendToTerminal(command, { storySlug, storyPhase: phase });
});

// ── Integration with main app.js view system ─────────────────────────────────

/** Snapshot of the `window.showView` function defined by app.js before this
 * module wraps it.  Called at the end of {@link terminalAwareShowView} to
 * preserve the original layout-switching behaviour.
 * @type {Function|undefined}
 */
const originalShowView = window.showView;

/** Wraps `window.showView` to add terminal-specific side-effects.
 * - Toggles visibility of the BMAD actions sidebar and Git sidebar based on
 *   the active view.
 * - Lazily initialises the terminal on first navigation to the terminal view.
 * - Picks up any pending command queued before the terminal was ready.
 * - Refits the active terminal after every view switch (split-pane size may
 *   have changed).
 * @param {string} view - The view identifier (e.g. `'terminal'`, `'git'`, `'epics'`).
 */
function terminalAwareShowView(view) {
  // Show/hide BMAD actions sidebar section
  const bmadActions = document.getElementById('bmad-actions');
  if (bmadActions) {
    bmadActions.classList.toggle('hidden', view !== 'terminal');
  }

  // Show/hide Git branches sidebar section
  const gitSidebar = document.getElementById('git-sidebar');
  if (gitSidebar) {
    gitSidebar.classList.toggle('hidden', view !== 'git');
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
          const doFit = () => { try { tab.fitAddon.fit(); } catch { /* ignore */ } tab.term.scrollToBottom(); };
          setTimeout(() => { doFit(); tab.term.focus(); }, 50);
          setTimeout(doFit, 200);
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
      const doFit = () => { try { tab.fitAddon.fit(); } catch { /* ignore */ } tab.term.scrollToBottom(); };
      setTimeout(doFit, 50);
      setTimeout(doFit, 200);
    }
  }
}

// ── Session History ──────────────────────────────────────────────────────────

/** Persist a newly-created tab's metadata to the per-project session history
 * so it can be resumed later from the History view.
 * @param {object} tab - The tab object (used for `tab.id`).
 * @param {string|null} slashCommand - The slash command the tab was opened with.
 * @param {object} [opts] - Options that may include `claudeSessionId`.
 * @param {string} [opts.claudeSessionId] - UUID of the Claude session to save for future `--resume`.
 * @returns {Promise<void>}
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

/** Fetch and render the session history list in the History view.
 * Displays up to the 5 most recent entries as cards with Resume/Restart and
 * delete buttons.  Shows an empty-state prompt when no history exists.
 * @returns {Promise<void>}
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

/** Resume or restart a session from the History view.
 * If `claudeSessionId` is present the session is resumed via `--resume`;
 * otherwise the command is restarted as a fresh session.
 * @param {string} entryId - History entry ID (currently unused, reserved for future use).
 * @param {string} command - The slash command associated with this history entry.
 * @param {string} claudeSessionId - Claude session UUID, or empty string if unavailable.
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

/** Restart a command from history as a brand-new session (no `--resume`).
 * @param {string} command - The slash command to run in the new session.
 */
window.historyRestartSession = function(command) {
  window.sendToTerminal(command || null);
  window.showView('terminal');
};

/** Remove a single session entry from persistent history and refresh the view.
 * @param {string} entryId - The unique ID of the history entry to remove.
 * @returns {Promise<void>}
 */
window.historyRemoveSession = async function(entryId) {
  await window.api.removeSessionHistory(entryId);
  window.renderSessionHistory();
};

// ── History Helpers ──────────────────────────────────────────────────────────

/** Convert an ISO 8601 timestamp to a human-readable relative time string.
 * Examples: "just now", "5m ago", "3h ago", "yesterday", "Mar 12".
 * @param {string} isoString - ISO 8601 date string (e.g. from `new Date().toISOString()`).
 * @returns {string} Relative time description.
 */
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

/** Escape a string for safe insertion into HTML text content.
 * Replaces `&`, `<`, `>`, and `"` with their HTML entity equivalents.
 * @param {string} str - Raw string to escape.
 * @returns {string} HTML-safe string, or an empty string if falsy.
 */
function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Escape a string for safe embedding inside an HTML attribute value delimited
 * by single quotes (as used in inline `onclick` handlers in this file).
 * @param {string} str - Raw string to escape.
 * @returns {string} Attribute-safe string, or an empty string if falsy.
 */
function escAttr(str) {
  if (!str) return '';
  return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// ── Init ────────────────────────────────────────────────────────────────────

/** Bootstrap the terminal renderer once the DOM is ready.
 * Sets up the BMAD sidebar immediately, then wraps `window.showView` with
 * {@link terminalAwareShowView} (deferred one microtask so app.js has time
 * to assign its own `showView` first) and attaches a click listener on the
 * terminal nav item.
 */
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
