/**
 * BMAD Board — Renderer Process
 *
 * Visual dashboard for BMAD project files.
 * Reads epics, stories, and documents from a project's _bmad/ and docs/bmad/ folders.
 */

// ── Markdown Renderer (extracted to lib/markdown.js for testability) ────
// In Electron renderer, we load via require from preload or inline.
// Since this file runs in a renderer context without node integration,
// we include a bundled copy. The canonical source is lib/markdown.js.

const MD = {
  render(text) {
    if (!text) return '';
    let html = text
      // Code blocks (fenced)
      .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
        `<pre><code class="lang-${lang}">${this.esc(code.trim())}</code></pre>`)
      // Inline code
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      // Headers
      .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      // Bold & italic
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      // Checkboxes
      .replace(/^(\s*)- \[x\] (.+)$/gm, '$1<li style="list-style:none"><input type="checkbox" checked disabled> $2</li>')
      .replace(/^(\s*)- \[ \] (.+)$/gm, '$1<li style="list-style:none"><input type="checkbox" disabled> $2</li>')
      // Unordered lists
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      // Ordered lists
      .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
      // Blockquotes
      .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
      // Horizontal rules
      .replace(/^---$/gm, '<hr>')
      // Tables (simple)
      .replace(/^\|(.+)\|$/gm, (match) => {
        const cells = match.split('|').filter(c => c.trim());
        if (cells.every(c => c.trim().match(/^[-:]+$/))) return '<!--table-sep-->';
        const tag = 'td';
        return '<tr>' + cells.map(c => `<${tag}>${c.trim()}</${tag}>`).join('') + '</tr>';
      })
      // Links
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:var(--accent)">$1</a>')
      // Paragraphs (blank lines)
      .replace(/\n\n/g, '</p><p>')
      // Line breaks
      .replace(/\n/g, '<br>');

    // Wrap loose <li> in <ul>
    html = html.replace(/((?:<li[^>]*>.*?<\/li>\s*(?:<br>)?)+)/g, '<ul>$1</ul>');
    // Wrap <tr> in <table>
    html = html.replace(/((?:<tr>.*?<\/tr>\s*(?:<!--table-sep-->)?\s*(?:<br>)?)+)/g, (m) => {
      const cleaned = m.replace(/<!--table-sep-->/g, '').replace(/<br>/g, '');
      // Make first row headers
      const first = cleaned.replace(/<tr>(.*?)<\/tr>/, (_, inner) =>
        '<thead><tr>' + inner.replace(/<td>/g, '<th>').replace(/<\/td>/g, '</th>') + '</tr></thead>');
      return '<table>' + first + '</table>';
    });

    return '<p>' + html + '</p>';
  },

  esc(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
};

// ── State ───────────────────────────────────────────────────────────────

let projectData = null;     // Result from bmad-scanner
let currentView = 'welcome'; // welcome, epics, epic-detail, documents, party
let currentEpic = null;      // Selected epic object
let expandedStories = {};    // story slug -> expanded boolean
let viewMode = {};           // key -> 'rendered' | 'edit' | 'raw'
let editorDirty = {};        // key -> boolean (unsaved changes)
let editorContent = {};      // key -> current editor text
let searchQuery = '';
let previousStoryStates = {};  // slug -> status, for change detection
let pollTimer = null;
let isGitRepo = false;         // whether the current project is a git repo
let gitAutoFetchTimer = null;  // auto-fetch interval timer
let licenseStatus = { active: false, plan: null }; // Pro license state

// ── Phase Config (mirror of lib/phase-commands.js for renderer) ─────────

const PHASES = {
  'backlog':       { label: 'Backlog',     icon: '○' },
  'ready-for-dev': { label: 'Ready',       icon: '◐' },
  'in-progress':   { label: 'In Progress', icon: '◑' },
  'review':        { label: 'Review',      icon: '◕' },
  'done':          { label: 'Done',        icon: '●' }
};

const PHASE_ORDER = ['backlog', 'ready-for-dev', 'in-progress', 'review', 'done'];

// ── Pro License ────────────────────────────────────────────────────────

const PRO_FEATURES = {
  'git': 'Git integration lets you manage branches, commits, merges, and more — all from within BMAD Board.',
  'session-history': 'Session history lets you track and resume your development sessions across stories.',
  'multi-tab': 'Multi-tab terminal lets you run multiple terminal sessions side by side.',
  'multi-window': 'Multi-window lets you open several BMAD Board windows simultaneously.',
  'providers': 'Access all 5 LLM providers: Claude Code, Codex, Cursor, Aider, and OpenCode.',
  'file-versioning': 'File versioning automatically snapshots your files before each save.',
  'notifications': 'Get OS notifications when story phases change.',
};

/** Check if current license is active (Pro). */
function isPro() {
  return licenseStatus.active === true;
}

/**
 * Require Pro for a feature — if not Pro, show upgrade modal.
 * @param {string} featureName - Key from PRO_FEATURES
 * @returns {boolean} true if Pro, false if blocked
 */
function requirePro(featureName) {
  if (isPro()) return true;
  showUpgradeModal(featureName);
  return false;
}

/** Initialize license status and update UI badges. */
async function initLicense() {
  try {
    licenseStatus = await window.api.getLicenseStatus();
  } catch {
    licenseStatus = { active: false, plan: null };
  }
  updateProBadges();

  // Listen for activation events from checkout window
  window.api.onLicenseActivated(() => {
    window.api.getLicenseStatus().then(status => {
      licenseStatus = status;
      updateProBadges();
    });
  });

  // Expose for terminal-renderer
  window._isPro = isPro();
}

/** Show/hide Pro badges in nav based on license status. */
function updateProBadges() {
  const pro = isPro();
  window._isPro = pro;

  const gitBadge = document.getElementById('git-pro-badge');
  const historyBadge = document.getElementById('history-pro-badge');
  const navGit = document.getElementById('nav-git');
  const navHistory = document.getElementById('nav-history');

  if (gitBadge) gitBadge.classList.toggle('hidden', pro);
  if (historyBadge) historyBadge.classList.toggle('hidden', pro);
  if (navGit) navGit.classList.toggle('pro-locked', !pro);
  if (navHistory) navHistory.classList.toggle('pro-locked', !pro);
}

/** Show the upgrade modal with context about which feature was requested. */
function showUpgradeModal(featureName) {
  const modal = document.getElementById('upgrade-modal');
  const desc = document.getElementById('upgrade-feature-desc');
  if (!modal) return;

  if (featureName && PRO_FEATURES[featureName]) {
    desc.textContent = PRO_FEATURES[featureName];
  } else {
    desc.textContent = 'Unlock all Pro features including Git integration, multi-tab terminal, session history, and more.';
  }

  // Reset state
  const licenseGroup = document.getElementById('license-input-group');
  const licenseError = document.getElementById('license-error');
  const licenseSuccess = document.getElementById('license-success');
  const trialSection = document.getElementById('trial-section');
  if (licenseGroup) licenseGroup.classList.add('hidden');
  if (licenseError) licenseError.classList.add('hidden');
  if (licenseSuccess) licenseSuccess.classList.add('hidden');

  // Hide trial if already used (expired or active)
  if (trialSection) {
    trialSection.classList.toggle('hidden', licenseStatus.trialUsed === true);
  }

  modal.classList.remove('hidden');
}

/** Hide the upgrade modal. */
function hideUpgradeModal() {
  const modal = document.getElementById('upgrade-modal');
  if (modal) modal.classList.add('hidden');
}

/** Setup upgrade modal event handlers. */
function setupUpgradeModal() {
  // Close button
  const closeBtn = document.getElementById('upgrade-modal-close');
  if (closeBtn) closeBtn.addEventListener('click', hideUpgradeModal);

  // Click outside to close
  const modal = document.getElementById('upgrade-modal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) hideUpgradeModal();
    });
  }

  // Plan toggle
  const monthlyBtn = document.getElementById('plan-monthly');
  const annualBtn = document.getElementById('plan-annual');
  if (monthlyBtn && annualBtn) {
    monthlyBtn.addEventListener('click', () => {
      monthlyBtn.classList.add('active');
      annualBtn.classList.remove('active');
    });
    annualBtn.addEventListener('click', () => {
      annualBtn.classList.add('active');
      monthlyBtn.classList.remove('active');
    });
  }

  // Subscribe button
  const subscribeBtn = document.getElementById('btn-subscribe');
  if (subscribeBtn) {
    subscribeBtn.addEventListener('click', async () => {
      const plan = document.querySelector('.plan-btn.active')?.dataset.plan || 'monthly';
      subscribeBtn.disabled = true;
      subscribeBtn.textContent = 'Opening checkout...';
      try {
        const result = await window.api.openCheckout(plan);
        if (result.success) {
          licenseStatus = await window.api.getLicenseStatus();
          updateProBadges();
          hideUpgradeModal();
          showToast('Welcome to BMAD Board Pro!', 'success');
        } else if (result.error && result.error !== 'Checkout window closed') {
          showToast(result.error, 'error');
        }
      } catch (err) {
        showToast('Failed to open checkout', 'error');
      }
      subscribeBtn.disabled = false;
      subscribeBtn.textContent = 'Subscribe to Pro';
    });
  }

  // Toggle license key input
  const toggleBtn = document.getElementById('toggle-license-input');
  const licenseGroup = document.getElementById('license-input-group');
  if (toggleBtn && licenseGroup) {
    toggleBtn.addEventListener('click', () => {
      licenseGroup.classList.toggle('hidden');
    });
  }

  // Activate license key
  const activateBtn = document.getElementById('btn-activate-key');
  const keyInput = document.getElementById('license-key-input');
  const errorEl = document.getElementById('license-error');
  const successEl = document.getElementById('license-success');
  if (activateBtn && keyInput) {
    activateBtn.addEventListener('click', async () => {
      const key = keyInput.value.trim();
      if (!key) return;

      activateBtn.disabled = true;
      activateBtn.textContent = 'Activating...';
      if (errorEl) errorEl.classList.add('hidden');
      if (successEl) successEl.classList.add('hidden');

      try {
        const result = await window.api.activateLicense(key);
        if (result.success) {
          licenseStatus = await window.api.getLicenseStatus();
          updateProBadges();
          if (successEl) successEl.classList.remove('hidden');
          setTimeout(() => hideUpgradeModal(), 1500);
          showToast('Welcome to BMAD Board Pro!', 'success');
        } else {
          if (errorEl) {
            errorEl.textContent = result.error || 'Activation failed';
            errorEl.classList.remove('hidden');
          }
        }
      } catch {
        if (errorEl) {
          errorEl.textContent = 'Network error — please try again';
          errorEl.classList.remove('hidden');
        }
      }
      activateBtn.disabled = false;
      activateBtn.textContent = 'Activate';
    });
  }

  // Start trial
  const trialBtn = document.getElementById('btn-start-trial');
  const trialEmail = document.getElementById('trial-email-input');
  if (trialBtn && trialEmail) {
    trialBtn.addEventListener('click', async () => {
      const email = trialEmail.value.trim();
      if (!email || !email.includes('@')) {
        showToast('Please enter a valid email address', 'error');
        return;
      }

      trialBtn.disabled = true;
      trialBtn.textContent = 'Starting...';

      try {
        const result = await window.api.startTrial(email);
        if (result.success) {
          licenseStatus = await window.api.getLicenseStatus();
          updateProBadges();
          hideUpgradeModal();
          showToast('Pro trial started — 14 days free!', 'success');
        } else {
          showToast(result.error || 'Could not start trial', 'error');
        }
      } catch {
        showToast('Failed to start trial', 'error');
      }
      trialBtn.disabled = false;
      trialBtn.textContent = 'Start Free Trial';
    });
  }
}

// Expose for terminal-renderer
window.showUpgradeModal = showUpgradeModal;

// ── Init ────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Load license status first (affects UI rendering)
  await initLicense();

  setupNavigation();
  setupKeyboardShortcuts();
  setupProjectSelector();
  setupSplitResize();
  setupToastContainer();
  setupUpgradeModal();

  // Try loading last project
  const data = await window.api.loadLastProject();
  if (data && data.found) {
    projectData = data;
    snapshotStoryStates();
    await refreshProjectList();
    await detectGitRepo();
    showView('epics');
    startPhasePoller();
  } else {
    await refreshProjectList();
    showView('welcome');
  }
});

// ── Split Pane Resize ────────────────────────────────────────────────────

/** Set up the drag-to-resize handle between the top content pane and the bottom terminal pane.
 * Tracks mousedown/mousemove/mouseup to compute a flex-height percentage and refits the
 * active terminal after each drag.
 */
function setupSplitResize() {
  const handle = document.getElementById('split-handle');
  const splitLayout = document.getElementById('split-layout');
  const splitTop = document.getElementById('split-top');
  const splitBottom = document.getElementById('split-bottom');
  if (!handle || !splitLayout || !splitTop || !splitBottom) return;

  let dragging = false;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = splitLayout.getBoundingClientRect();
    const topHeight = e.clientY - rect.top;
    const totalHeight = rect.height;
    const pct = Math.max(10, Math.min(90, (topHeight / totalHeight) * 100));
    splitTop.style.flex = 'none';
    splitTop.style.height = pct + '%';
    splitBottom.style.flex = 'none';
    splitBottom.style.height = (100 - pct) + '%';

    // Refit terminal
    if (typeof window.refitActiveTerminal === 'function') {
      window.refitActiveTerminal();
    }
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // Final refit
    if (typeof window.refitActiveTerminal === 'function') {
      window.refitActiveTerminal();
    }
  });
}

// ── Navigation ──────────────────────────────────────────────────────────

/** Wire click handlers for all sidebar nav items and the "Add Epic / Open Project" button. */
function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const view = item.dataset.view;
      // Use window.showView so terminal-renderer's override is respected
      const sv = window.showView || showView;
      if (view === 'epics') {
        if (projectData) sv('epics');
        else sv('welcome');
      } else if (view === 'party') {
        window.sendToTerminal('/bmad-party-mode');
        sv('terminal');
      } else if (view === 'documents') {
        if (projectData) sv('documents');
      } else if (view === 'history') {
        if (!requirePro('session-history')) return;
        sv('history');
      } else if (view === 'git') {
        if (!requirePro('git')) return;
        if (isGitRepo) sv('git');
      } else if (view === 'terminal') {
        sv('terminal');
      }
    });
  });

  document.getElementById('btn-add-epic').addEventListener('click', openProject);
}

/** Register global keyboard shortcuts (Cmd+O to open project, Escape to go back,
 * Cmd+R to refresh, Cmd+N for new window) and listen for the show-settings IPC event.
 */
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Cmd+O = Open project
    if ((e.metaKey || e.ctrlKey) && e.key === 'o') {
      e.preventDefault();
      openProject();
    }
    // Escape = go back
    if (e.key === 'Escape') {
      if (currentView === 'epic-detail') showView('epics');
    }
    // Cmd+R = refresh
    if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
      e.preventDefault();
      refreshProject();
    }
    // Cmd+N = new window (handled by menu accelerator, but keep as fallback)
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'n') {
      e.preventDefault();
      if (requirePro('multi-window')) window.api.newWindow();
    }
  });

  // Cmd+, = Settings (from menu)
  window.api.onShowSettings(() => {
    showView('settings');
  });
}

/** Prompt the user to open a project folder via the native file dialog.
 * If a project is already loaded, offers to open the new one in a new window instead.
 * On success, loads the project data, refreshes the project list, detects git, and
 * navigates to the Epics view. On failure, shows the welcome screen with a warning.
 * @returns {Promise<void>}
 */
async function openProject() {
  // If a project is already loaded, ask whether to open in a new window
  if (projectData) {
    const openNew = confirm('Open in a new window?');
    if (openNew) {
      window.api.newWindow();
      return;
    }
  }

  const data = await window.api.openProject();
  if (!data) return;

  if (!data.found) {
    projectData = null;
    showView('welcome');
    showWarning(data.reason);
    return;
  }

  projectData = data;
  snapshotStoryStates();
  await refreshProjectList();
  await detectGitRepo();
  showView('epics');
  startPhasePoller();
}

/** Re-scan the current project and re-render whichever view is active (epics, epic-detail,
 * or documents). Does nothing if no project is loaded.
 * @returns {Promise<void>}
 */
async function refreshProject() {
  if (!projectData) return;
  const data = await window.api.scanProject();
  if (data && data.found) {
    projectData = data;
    if (currentView === 'epics') renderEpics();
    else if (currentView === 'epic-detail' && currentEpic) {
      const updated = projectData.epics.find(e => e.number === currentEpic.number);
      if (updated) { currentEpic = updated; renderEpicDetail(); }
    } else if (currentView === 'documents') renderDocuments();
  }
}

// ── Git Repo Detection ──────────────────────────────────────────────────

/** Detect whether the current project directory is a git repository and update the
 * `isGitRepo` flag and the visibility of the git nav item accordingly.
 * Starts the auto-fetch timer if git is detected.
 * @returns {Promise<void>}
 */
async function detectGitRepo() {
  try {
    isGitRepo = await window.api.gitIsRepo();
  } catch {
    isGitRepo = false;
  }
  const navGit = document.getElementById('nav-git');
  if (navGit) navGit.classList.toggle('hidden', !isGitRepo);

  // Start auto-fetch if enabled
  if (isGitRepo) startGitAutoFetch();
}

/** Start (or restart) the periodic git auto-fetch timer using the interval from settings.
 * Silently refreshes the git view if it is currently active. A value of 0 disables
 * auto-fetch. Any previously running timer is stopped first.
 * @returns {Promise<void>}
 */
async function startGitAutoFetch() {
  stopGitAutoFetch();
  try {
    const settings = await window.api.getSettings();
    const interval = settings?.git?.autoFetchInterval ?? 5;
    if (interval <= 0) return; // disabled
    gitAutoFetchTimer = setInterval(async () => {
      if (!isGitRepo) return;
      try {
        await window.api.gitFetch();
        // If we're on the git view, refresh silently
        const activeView = document.querySelector('.view.active');
        if (activeView?.id === 'view-git') {
          renderGitView();
        }
      } catch { /* silent fail */ }
    }, interval * 60 * 1000);
  } catch { /* no settings yet */ }
}

/** Clear the git auto-fetch interval timer if one is running. */
function stopGitAutoFetch() {
  if (gitAutoFetchTimer) {
    clearInterval(gitAutoFetchTimer);
    gitAutoFetchTimer = null;
  }
}

// ── Git View ────────────────────────────────────────────────────────────

/** Escape HTML special characters to prevent XSS when inserting arbitrary strings into markup.
 * @param {string} str - Raw string to escape.
 * @returns {string} HTML-safe string with &, <, and > replaced by entities.
 */
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Convert a unified diff string into HTML with color-coded addition, deletion, and hunk spans.
 * @param {string} diff - Raw unified diff text.
 * @returns {string} HTML string where added lines have class `git-diff-add`, removed lines
 *   have `git-diff-del`, and hunk headers have `git-diff-hunk`.
 */
function formatDiff(diff) {
  return diff.split('\n').map(line => {
    const escaped = escapeHtml(line);
    if (line.startsWith('+') && !line.startsWith('+++')) {
      return `<span class="git-diff-add">${escaped}</span>`;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      return `<span class="git-diff-del">${escaped}</span>`;
    } else if (line.startsWith('@@')) {
      return `<span class="git-diff-hunk">${escaped}</span>`;
    }
    return escaped;
  }).join('\n');
}

/** Parse git conflict markers in a file's content into structured blocks.
 * @param {string} content - Raw file content containing `<<<<<<<`/`=======`/`>>>>>>>` markers.
 * @returns {Array<{type: 'clean'|'conflict', content?: string, ours?: string, theirs?: string}>}
 *   Array of blocks — clean blocks have a `content` string; conflict blocks have `ours` and `theirs`.
 */
function parseConflicts(content) {
  const blocks = [];
  const lines = content.split('\n');
  let current = [];
  let inConflict = false;
  let ours = [];
  let theirs = [];
  let inTheirs = false;

  for (const line of lines) {
    if (line.startsWith('<<<<<<<')) {
      // Flush any clean lines
      if (current.length) {
        blocks.push({ type: 'clean', content: current.join('\n') });
        current = [];
      }
      inConflict = true;
      inTheirs = false;
      ours = [];
      theirs = [];
    } else if (line.startsWith('=======') && inConflict) {
      inTheirs = true;
    } else if (line.startsWith('>>>>>>>') && inConflict) {
      blocks.push({
        type: 'conflict',
        ours: ours.join('\n'),
        theirs: theirs.join('\n')
      });
      inConflict = false;
      inTheirs = false;
    } else if (inConflict) {
      if (inTheirs) {
        theirs.push(line);
      } else {
        ours.push(line);
      }
    } else {
      current.push(line);
    }
  }

  if (current.length) {
    blocks.push({ type: 'clean', content: current.join('\n') });
  }

  return blocks;
}

/** Build the HTML for the interactive conflict resolution viewer.
 * Renders clean sections (abbreviated if long) and side-by-side conflict blocks
 * with "Accept Ours / Both / Theirs" buttons and a save button.
 * @param {string} fileName - Display name of the conflicted file.
 * @param {Array<{type: string, content?: string, ours?: string, theirs?: string}>} blocks
 *   Parsed conflict blocks as returned by `parseConflicts`.
 * @returns {string} HTML string to inject into the conflict viewer element.
 */
function renderConflictViewer(fileName, blocks) {
  let html = `<div class="git-diff-header">
    <span>Conflicts: ${escapeHtml(fileName)}</span>
    <div class="git-conflict-header-actions">
      <button class="btn btn-ghost btn-xs" data-conflict-accept-all="ours" title="Accept all ours">Accept All Ours</button>
      <button class="btn btn-ghost btn-xs" data-conflict-accept-all="theirs" title="Accept all theirs">Accept All Theirs</button>
      <button class="btn btn-ghost btn-xs" id="btn-close-conflict">&times;</button>
    </div>
  </div>`;

  html += '<div class="git-conflict-blocks">';

  blocks.forEach((block, i) => {
    if (block.type === 'clean') {
      const lines = block.content.split('\n');
      // Show abbreviated clean blocks (first/last 3 lines if long)
      if (lines.length > 6) {
        html += `<pre class="git-conflict-clean">${escapeHtml(lines.slice(0, 3).join('\n'))}\n<span class="git-conflict-fold">... ${lines.length - 6} lines hidden ...</span>\n${escapeHtml(lines.slice(-3).join('\n'))}</pre>`;
      } else {
        html += `<pre class="git-conflict-clean">${escapeHtml(block.content)}</pre>`;
      }
    } else {
      html += `<div class="git-conflict-block" data-conflict-index="${i}">
        <div class="git-conflict-actions">
          <button class="btn btn-sm git-conflict-btn-ours" data-resolve-block="${i}" data-resolve-choice="ours">Accept Ours</button>
          <button class="btn btn-sm git-conflict-btn-both" data-resolve-block="${i}" data-resolve-choice="both">Accept Both</button>
          <button class="btn btn-sm git-conflict-btn-theirs" data-resolve-block="${i}" data-resolve-choice="theirs">Accept Theirs</button>
        </div>
        <div class="git-conflict-sides">
          <div class="git-conflict-side git-conflict-ours">
            <div class="git-conflict-side-label">Ours (current)</div>
            <pre>${escapeHtml(block.ours)}</pre>
          </div>
          <div class="git-conflict-side git-conflict-theirs">
            <div class="git-conflict-side-label">Theirs (incoming)</div>
            <pre>${escapeHtml(block.theirs)}</pre>
          </div>
        </div>
      </div>`;
    }
  });

  html += '</div>';
  html += `<div class="git-conflict-save">
    <button class="btn btn-primary btn-sm" id="btn-git-save-conflict" data-conflict-file="${escapeHtml(fileName)}">Save &amp; Mark Resolved</button>
  </div>`;

  return html;
}

/** Put a git action button into a loading/disabled state with a spinner.
 * @param {HTMLButtonElement} btn - The button element to update.
 * @param {string} label - Text to display next to the spinner.
 */
function gitBtnLoading(btn, label) {
  btn.disabled = true;
  btn.innerHTML = `<span class="git-spinner"></span> ${label}`;
  btn.classList.add('git-btn-loading');
}

/** Restore a git action button to its normal enabled state after an operation completes.
 * @param {HTMLButtonElement} btn - The button element to restore.
 * @param {string} label - Label text to restore on the button.
 */
function gitBtnDone(btn, label) {
  btn.disabled = false;
  btn.textContent = label;
  btn.classList.remove('git-btn-loading');
}

/** Format a date string as a human-readable relative time (e.g. "5m ago", "3d ago").
 * @param {string} dateStr - ISO 8601 date string or any string parseable by `new Date()`.
 * @returns {string} Relative time label such as "just now", "12m ago", "2h ago", "4d ago",
 *   or "3mo ago".
 */
function formatTimeAgo(dateStr) {
  const now = new Date();
  const date = new Date(dateStr);
  const seconds = Math.floor((now - date) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

/** Fetch all git data (branches, status, log, tags, stashes, rebase state) in parallel and
 * render the full git view into `#git-content`, including the branch sidebar, staged/unstaged
 * file panels, commit box, stash list, recent commits, tags, and (if `gh` is available) the
 * pull-request form. Preserves any commit message the user was typing.
 * @returns {Promise<void>}
 */
async function renderGitView() {
  const container = document.getElementById('git-content');
  if (!container) return;

  if (!isGitRepo) {
    container.innerHTML = '<p class="git-empty">This project is not a git repository.</p>';
    return;
  }

  container.innerHTML = '<div class="git-loading"><span class="git-spinner git-spinner-lg"></span> Loading git data...</div>';

  try {
    const [branches, status, log, tags, hasGh, stashList, isRebasing] = await Promise.all([
      window.api.gitBranches(),
      window.api.gitStatus(),
      window.api.gitLog(25),
      window.api.gitTags(),
      window.api.gitHasGhCli(),
      window.api.gitStashList(),
      window.api.gitIsRebasing()
    ]);

    if (branches.error || status.error) {
      container.innerHTML = `<p class="git-empty">Error: ${branches.error || status.error}</p>`;
      return;
    }

    // ── Render branches in sidebar ──
    const currentBranch = branches.current;
    const sidebarBranches = document.getElementById('git-sidebar-branches');
    if (sidebarBranches) {
      const localHtml = branches.local.map(b => {
        const arrows = [];
        if (b.ahead > 0) arrows.push(`<span class="git-branch-ahead" title="${b.ahead} ahead">&uarr;${b.ahead}</span>`);
        if (b.behind > 0) arrows.push(`<span class="git-branch-behind" title="${b.behind} behind">&darr;${b.behind}</span>`);
        return `
        <div class="git-sidebar-branch ${b.current ? 'git-sidebar-branch-current git-merge-drop-target' : 'git-sidebar-branch-clickable'}"
             ${b.current ? '' : `data-branch="${b.name}"`}
             ${!b.current ? `draggable="true" data-drag-branch="${b.name}"` : ''}
             data-context-branch="${b.name}"
             title="${b.current ? 'Current branch (drop here to merge)' : `Checkout ${b.name}`}">
          <span class="git-sidebar-branch-icon">${b.current ? '&#9679;' : '&#9675;'}</span>
          <span class="git-sidebar-branch-name">${b.name}</span>
          ${arrows.length ? `<span class="git-branch-arrows">${arrows.join(' ')}</span>` : ''}
          ${b.current ? '<span class="git-branch-tag">HEAD</span>' : ''}
        </div>
      `}).join('');

      const remoteHtml = branches.remote.map(b => {
        const localName = b.name.replace(/^[^/]+\//, '');
        const hasLocal = branches.local.some(lb => lb.name === localName);
        return `
          <div class="git-sidebar-branch git-sidebar-branch-remote ${hasLocal ? '' : 'git-sidebar-branch-clickable'}"
               ${hasLocal ? '' : `data-remote-branch="${b.name}"`}
               draggable="true" data-drag-branch="${b.name}"
               data-context-branch="${b.name}"
               title="${hasLocal ? 'Tracked locally' : `Checkout ${localName}`}">
            <span class="git-sidebar-branch-icon">&#9675;</span>
            <span class="git-sidebar-branch-name">${b.name}</span>
          </div>
        `;
      }).join('');

      sidebarBranches.innerHTML = `
        <div class="git-sidebar-group">
          <div class="git-sidebar-group-title">Local <span class="git-panel-count">${branches.local.length}</span>
            <button class="btn btn-ghost btn-xs git-sidebar-new-branch-btn" id="btn-git-new-branch" title="New branch">+</button>
          </div>
          <div id="git-new-branch-form" class="git-new-branch-form hidden">
            <select id="git-branch-prefix" class="git-branch-prefix-select">
              <option value="">no prefix</option>
              <option value="feature/">feature/</option>
              <option value="bugfix/">bugfix/</option>
              <option value="hotfix/">hotfix/</option>
              <option value="release/">release/</option>
              <option value="chore/">chore/</option>
              <option value="refactor/">refactor/</option>
            </select>
            <input type="text" id="git-branch-name" class="git-branch-name-input" placeholder="branch-name">
            <div class="git-branch-start-row">
              <label class="git-branch-start-label">from</label>
              <select id="git-branch-start" class="git-branch-start-select">
                ${branches.local.map(b => `<option value="${b.name}" ${b.current ? 'selected' : ''}>${b.name}${b.current ? ' (HEAD)' : ''}</option>`).join('')}
              </select>
            </div>
            <div class="git-branch-form-actions">
              <button class="btn btn-ghost btn-xs" id="btn-git-cancel-branch">Cancel</button>
              <button class="btn btn-primary btn-xs" id="btn-git-create-branch">Create</button>
            </div>
          </div>
          ${localHtml}
        </div>
        <div class="git-sidebar-group">
          <div class="git-sidebar-group-title">Remote <span class="git-panel-count">${branches.remote.length}</span></div>
          ${remoteHtml}
        </div>
      `;

      // Wire drag & drop for merge
      setupBranchDragDrop(sidebarBranches, currentBranch);
    }

    // ── Classify files into staged / unstaged ──
    const staged = [];
    const unstaged = [];
    for (const f of status.files) {
      // index: staged status, working_dir: unstaged status
      if (f.index && f.index !== ' ' && f.index !== '?') {
        staged.push(f);
      }
      if (f.working_dir && f.working_dir !== ' ') {
        unstaged.push(f);
      }
      // Untracked files (? in both)
      if (f.index === '?' && f.working_dir === '?') {
        if (!unstaged.includes(f)) unstaged.push(f);
      }
    }

    const fileStatusLabel = (code) => {
      const labels = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', '?': 'untracked' };
      return labels[code] || code;
    };

    const stagedHtml = staged.map(f => `
      <div class="git-file-item git-file-staged">
        <input type="checkbox" class="git-file-check" checked data-unstage-file="${f.path}">
        <span class="git-file-status git-file-status-${f.index.toLowerCase()}">${f.index}</span>
        <span class="git-file-name" data-diff-file="${f.path}" data-diff-staged="true" title="Click to view diff">${f.path}</span>
      </div>
    `).join('');

    const unstagedHtml = unstaged.map(f => `
      <div class="git-file-item git-file-unstaged">
        <input type="checkbox" class="git-file-check" data-stage-file="${f.path}">
        <span class="git-file-status git-file-status-${(f.working_dir || '?').toLowerCase()}">${f.working_dir || '?'}</span>
        <span class="git-file-name" data-diff-file="${f.path}" data-diff-staged="false" title="Click to view diff">${f.path}</span>
        <button class="btn btn-ghost btn-xs git-discard-file" data-discard-file="${f.path}" title="Discard changes">&#8630;</button>
      </div>
    `).join('');

    // ── Render main content ──
    const aheadBehind = [];
    if (status.ahead > 0) aheadBehind.push(`<span class="git-ahead" title="Commits ahead of remote">&uarr;${status.ahead}</span>`);
    if (status.behind > 0) aheadBehind.push(`<span class="git-behind" title="Commits behind remote">&darr;${status.behind}</span>`);
    const syncIndicator = aheadBehind.length ? aheadBehind.join(' ') : '<span class="git-synced">in sync</span>';

    const hasPushTarget = !!status.tracking;

    const commitsHtml = log.map(c => `
      <div class="git-commit-item git-commit-clickable" data-show-commit="${c.hash}">
        <span class="git-commit-hash">${c.hashShort}</span>
        <span class="git-commit-message">${c.message}</span>
        <span class="git-commit-meta">${c.author} &middot; ${formatTimeAgo(c.date)}</span>
      </div>
    `).join('');

    // Preserve commit message if user was typing
    const existingMsg = document.getElementById('git-commit-message');
    const preservedMsg = existingMsg ? existingMsg.value : '';
    const existingConv = document.getElementById('git-conventional-toggle');
    const preservedConv = existingConv ? existingConv.checked : false;
    const existingType = document.getElementById('git-conv-type');
    const preservedType = existingType ? existingType.value : 'feat';
    const existingScope = document.getElementById('git-conv-scope');
    const preservedScope = existingScope ? existingScope.value : '';

    container.innerHTML = `
      <div class="git-toolbar">
        <button class="btn btn-ghost btn-sm" id="btn-git-fetch" title="Fetch all remotes">Fetch</button>
        <button class="btn btn-ghost btn-sm" id="btn-git-pull" ${hasPushTarget ? '' : 'disabled'} title="${hasPushTarget ? `Pull from ${status.tracking}` : 'No tracking branch'}">
          Pull${status.behind > 0 ? ` <span class="git-btn-badge">&darr;${status.behind}</span>` : ''}
        </button>
        <button class="btn btn-ghost btn-sm" id="btn-git-push" ${hasPushTarget ? '' : 'disabled'} title="${hasPushTarget ? `Push to ${status.tracking}` : 'No tracking branch'}">
          Push${status.ahead > 0 ? ` <span class="git-btn-badge">&uarr;${status.ahead}</span>` : ''}
        </button>
      </div>

      <div class="git-status-bar">
        <div class="git-status-branch">
          <span class="git-status-label">Branch:</span>
          <strong>${status.current}</strong>
          ${status.tracking ? `<span class="git-tracking">&rarr; ${status.tracking}</span>` : ''}
        </div>
        <div class="git-status-indicators">
          ${syncIndicator}
        </div>
      </div>

      ${status.merging ? `
      <div class="git-merge-banner">
        <span class="git-merge-banner-text">Merge in progress${status.conflicted.length > 0 ? ` — ${status.conflicted.length} conflict(s)` : ''}</span>
        <div class="git-merge-banner-actions">
          ${status.conflicted.length > 0 ? '<button class="btn btn-primary btn-sm" id="btn-git-resolve-llm">Resolve with LLM</button>' : ''}
          <button class="btn btn-ghost btn-sm" id="btn-git-abort-merge">Abort Merge</button>
        </div>
        ${status.conflicted.length > 0 ? `
        <div class="git-conflict-files">
          ${status.conflicted.map(f => `
            <div class="git-conflict-file" data-conflict-file="${f}">
              <span class="git-file-status git-file-status-u">U</span>
              <span class="git-file-name">${f}</span>
            </div>
          `).join('')}
        </div>` : ''}
      </div>
      ` : ''}

      ${isRebasing ? `
      <div class="git-rebase-banner">
        <span class="git-merge-banner-text">Rebase in progress${status.conflicted.length > 0 ? ` — ${status.conflicted.length} conflict(s)` : ''}</span>
        <div class="git-merge-banner-actions">
          ${status.conflicted.length > 0 ? '<button class="btn btn-primary btn-sm" id="btn-git-resolve-llm">Resolve with LLM</button>' : ''}
          <button class="btn btn-primary btn-sm" id="btn-git-rebase-continue">Continue Rebase</button>
          <button class="btn btn-ghost btn-sm" id="btn-git-rebase-abort">Abort Rebase</button>
        </div>
        ${status.conflicted.length > 0 ? `
        <div class="git-conflict-files">
          ${status.conflicted.map(f => `
            <div class="git-conflict-file" data-conflict-file="${f}">
              <span class="git-file-status git-file-status-u">U</span>
              <span class="git-file-name">${f}</span>
            </div>
          `).join('')}
        </div>` : ''}
      </div>
      ` : ''}

      <div id="git-conflict-viewer" class="git-conflict-viewer hidden"></div>

      <div class="git-panels">
        ${status.files.length > 0 || staged.length > 0 ? `
        <div class="git-panel">
          <div class="git-panel-header">
            <h3>Staged</h3>
            <span class="git-panel-count">${staged.length}</span>
          </div>
          <div class="git-file-list">
            ${stagedHtml || '<p class="git-empty-sm">No staged files</p>'}
          </div>
        </div>

        <div class="git-panel">
          <div class="git-panel-header">
            <h3>Changes</h3>
            <div class="git-panel-header-actions">
              <span class="git-panel-count">${unstaged.length}</span>
              ${unstaged.length > 0 ? '<button class="btn btn-ghost btn-xs git-discard-all-btn" id="btn-git-discard-all" title="Discard all changes">Discard All</button>' : ''}
              ${unstaged.length > 0 ? '<button class="btn btn-ghost btn-xs" id="btn-git-stage-all" title="Stage all changes">Stage All</button>' : ''}
            </div>
          </div>
          <div class="git-file-list">
            ${unstagedHtml || '<p class="git-empty-sm">No unstaged changes</p>'}
          </div>
        </div>

        <div class="git-commit-box">
          <div class="git-commit-box-header">
            <label class="git-conventional-label">
              <input type="checkbox" id="git-conventional-toggle" ${preservedConv ? 'checked' : ''}>
              Conventional Commit
            </label>
          </div>
          <div class="git-conventional-fields ${preservedConv ? '' : 'hidden'}" id="git-conv-fields">
            <select id="git-conv-type" class="git-conv-select">
              ${['feat', 'fix', 'docs', 'style', 'refactor', 'test', 'chore', 'perf', 'ci', 'build'].map(t =>
                `<option value="${t}" ${t === preservedType ? 'selected' : ''}>${t}</option>`
              ).join('')}
            </select>
            <input type="text" id="git-conv-scope" class="git-conv-input" placeholder="scope (optional)" value="${preservedScope}">
          </div>
          <textarea id="git-commit-message" class="git-commit-textarea" placeholder="Commit message..." rows="3">${preservedMsg}</textarea>
          <div class="git-commit-actions">
            <label class="git-amend-label">
              <input type="checkbox" id="git-amend-toggle"> Amend
            </label>
            <button class="btn btn-ghost btn-sm" id="btn-git-generate-msg" title="Generate commit message with LLM">Generate Message</button>
            <button class="btn btn-primary btn-sm" id="btn-git-commit" ${staged.length === 0 ? 'disabled' : ''} title="${staged.length === 0 ? 'Stage files first' : 'Commit staged changes'}">Commit</button>
          </div>
        </div>
        ` : '<div class="git-clean-state"><span class="git-clean-badge">Working tree clean</span></div>'}

        <div id="git-diff-viewer" class="git-diff-viewer hidden"></div>

        <div class="git-panel">
          <div class="git-panel-header">
            <h3>Stash</h3>
            <div class="git-panel-header-actions">
              <span class="git-panel-count">${stashList.length}</span>
              <button class="btn btn-ghost btn-xs" id="btn-git-stash" title="Stash current changes">Stash</button>
            </div>
          </div>
          ${stashList.length > 0 ? `<div class="git-stash-list">
            ${stashList.map(s => `
              <div class="git-stash-item">
                <span class="git-stash-index">stash@{${s.index}}</span>
                <span class="git-stash-message">${s.message}</span>
                <div class="git-stash-actions">
                  <button class="btn btn-ghost btn-xs" data-stash-pop="${s.index}" title="Pop (apply & remove)">Pop</button>
                  <button class="btn btn-ghost btn-xs git-tag-delete" data-stash-drop="${s.index}" title="Drop (discard)">Drop</button>
                </div>
              </div>
            `).join('')}
          </div>` : '<p class="git-empty-sm">No stashes</p>'}
        </div>

        <div class="git-panel">
          <div class="git-panel-header">
            <h3>Recent Commits</h3>
            <span class="git-panel-count">${log.length}</span>
          </div>
          <div class="git-commit-list">
            ${commitsHtml || '<p class="git-empty">No commits yet</p>'}
          </div>
          <div id="git-commit-detail" class="git-commit-detail hidden"></div>
        </div>

        <div class="git-panel">
          <div class="git-panel-header">
            <h3>Tags</h3>
            <div class="git-panel-header-actions">
              <span class="git-panel-count">${tags.length}</span>
              <button class="btn btn-ghost btn-xs" id="btn-git-new-tag">+ New Tag</button>
              ${tags.length > 0 ? '<button class="btn btn-ghost btn-xs" id="btn-git-push-all-tags" title="Push all tags to remote">Push All</button>' : ''}
            </div>
          </div>
          <div id="git-new-tag-form" class="git-new-tag-form hidden">
            <input type="text" id="git-tag-name" class="git-conv-input" placeholder="Tag name (e.g. v1.0.0)">
            <input type="text" id="git-tag-message" class="git-conv-input" placeholder="Message (optional, for annotated tag)">
            <div class="git-commit-actions">
              <button class="btn btn-ghost btn-sm" id="btn-git-cancel-tag">Cancel</button>
              <button class="btn btn-primary btn-sm" id="btn-git-create-tag">Create Tag</button>
            </div>
          </div>
          <div class="git-tag-list">
            ${tags.length > 0 ? tags.slice().reverse().map(t => `
              <div class="git-tag-item">
                <span class="git-tag-icon">&#127991;</span>
                <span class="git-tag-name">${t}</span>
                <div class="git-tag-actions">
                  <button class="btn btn-ghost btn-xs" data-push-tag="${t}" title="Push to remote">Push</button>
                  <button class="btn btn-ghost btn-xs git-tag-delete" data-delete-tag="${t}" title="Delete tag">&#10005;</button>
                </div>
              </div>
            `).join('') : '<p class="git-empty-sm">No tags</p>'}
          </div>
        </div>

        ${hasGh ? `
        <div class="git-panel">
          <div class="git-panel-header">
            <h3>Pull Request</h3>
          </div>
          <div class="git-pr-form">
            <input type="text" id="git-pr-title" class="git-conv-input" placeholder="PR title (leave empty for interactive mode)">
            <textarea id="git-pr-body" class="git-commit-textarea" rows="3" placeholder="PR description (optional)"></textarea>
            <div class="git-pr-options">
              <label class="git-pr-option">
                <input type="checkbox" id="git-pr-draft"> Draft PR
              </label>
              <select id="git-pr-base" class="git-conv-select git-pr-base-select">
                ${branches.local.filter(b => !b.current).map(b =>
                  `<option value="${b.name}" ${b.name === 'main' || b.name === 'master' ? 'selected' : ''}>${b.name}</option>`
                ).join('')}
              </select>
            </div>
            <div class="git-commit-actions">
              <button class="btn btn-primary btn-sm" id="btn-git-create-pr">Create Pull Request</button>
            </div>
          </div>
        </div>
        ` : `
        <div class="git-panel">
          <div class="git-panel-header">
            <h3>Pull Request</h3>
          </div>
          <div class="git-gh-install">
            <p class="git-empty-sm">The <code>gh</code> CLI is required to create PRs.</p>
            <div class="git-gh-install-cmds">
              <div class="git-gh-cmd"><span class="git-gh-os">macOS</span><code>brew install gh && gh auth login</code></div>
              <div class="git-gh-cmd"><span class="git-gh-os">Linux</span><code>sudo apt install gh && gh auth login</code></div>
              <div class="git-gh-cmd"><span class="git-gh-os">Windows</span><code>winget install GitHub.cli && gh auth login</code></div>
            </div>
            <p class="git-empty-sm" style="margin-top:8px">After installing, restart the app or <a href="#" id="btn-gh-install-info" class="git-link">visit cli.github.com</a></p>
          </div>
        </div>
        `}
      </div>
    `;

    // Restore conventional commit field visibility
    const convToggle = document.getElementById('git-conventional-toggle');
    const convFields = document.getElementById('git-conv-fields');
    if (convToggle && convFields) {
      convToggle.addEventListener('change', () => {
        convFields.classList.toggle('hidden', !convToggle.checked);
      });
    }
  } catch (err) {
    container.innerHTML = `<p class="git-empty">Failed to load git data: ${err.message}</p>`;
  }
}

/** Build the final commit message from the textarea and optional conventional commit fields.
 * If the conventional commit toggle is checked, prepends `type(scope): ` to the message
 * unless it already starts with that prefix.
 * @returns {string} The complete commit message, or an empty string if the textarea is empty.
 */
function buildCommitMessage() {
  const msg = document.getElementById('git-commit-message')?.value?.trim();
  if (!msg) return '';
  const convToggle = document.getElementById('git-conventional-toggle');
  if (!convToggle || !convToggle.checked) return msg;
  const type = document.getElementById('git-conv-type')?.value || 'feat';
  const scope = document.getElementById('git-conv-scope')?.value?.trim();
  const prefix = scope ? `${type}(${scope}): ` : `${type}: `;
  // Don't double-prefix
  if (msg.startsWith(prefix) || msg.match(/^\w+(\(.+\))?: /)) return msg;
  return prefix + msg;
}

// ── Git Drag & Drop Merge ───────────────────────────────────────────────

/** Wire drag-and-drop merge onto the current-branch (HEAD) drop target inside the branch
 * sidebar. Dragging any non-current branch onto the HEAD item triggers a merge confirmation
 * and calls `performMerge`.
 * @param {HTMLElement} container - The sidebar element that contains all branch items.
 * @param {string} currentBranch - Name of the currently checked-out branch.
 */
function setupBranchDragDrop(container, currentBranch) {
  // Drag start
  container.addEventListener('dragstart', (e) => {
    const el = e.target.closest('[data-drag-branch]');
    if (!el) return;
    e.dataTransfer.setData('text/plain', el.dataset.dragBranch);
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('git-dragging');
  });

  container.addEventListener('dragend', (e) => {
    const el = e.target.closest('[data-drag-branch]');
    if (el) el.classList.remove('git-dragging');
    // Remove all drop highlights
    container.querySelectorAll('.git-drop-hover').forEach(el => el.classList.remove('git-drop-hover'));
  });

  // Drop target = current branch (HEAD)
  const dropTarget = container.querySelector('.git-merge-drop-target');
  if (!dropTarget) return;

  dropTarget.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    dropTarget.classList.add('git-drop-hover');
  });

  dropTarget.addEventListener('dragleave', () => {
    dropTarget.classList.remove('git-drop-hover');
  });

  dropTarget.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropTarget.classList.remove('git-drop-hover');
    const branch = e.dataTransfer.getData('text/plain');
    if (!branch || branch === currentBranch) return;
    if (!confirm(`Merge "${branch}" into "${currentBranch}"?`)) return;
    await performMerge(branch, currentBranch);
  });
}

/** Merge a source branch into the current branch via the git IPC API, then refresh the git
 * view. Shows a success, warning (conflicts), or error toast as appropriate.
 * @param {string} branch - Name of the source branch to merge in.
 * @param {string} currentBranch - Name of the branch being merged into (for the toast message).
 * @returns {Promise<void>}
 */
async function performMerge(branch, currentBranch) {
  try {
    const result = await window.api.gitMerge(branch);
    if (result.success) {
      showToast(`Merged ${branch} into ${currentBranch}`, 'success');
    } else if (result.conflicts && result.conflicts.length > 0) {
      showToast(`Merge conflicts in ${result.conflicts.length} file(s)`, 'warning');
    } else {
      showToast(`Merge failed: ${result.message || 'unknown error'}`, 'error');
    }
    renderGitView();
  } catch (err) {
    showToast(`Merge failed: ${err.message}`, 'error');
  }
}

// ── Git Context Menu ────────────────────────────────────────────────────

let gitContextMenu = null;

/** Display a floating context menu near the given screen coordinates with git actions for
 * a branch (checkout, merge, rebase, delete). Only actions valid for the branch type
 * (local vs. remote, current vs. other) are shown. Closes on any outside click.
 * @param {number} x - Horizontal position in viewport pixels.
 * @param {number} y - Vertical position in viewport pixels.
 * @param {string} branch - The branch the context menu was opened for.
 * @param {string} currentBranch - The currently checked-out branch name.
 */
function showGitContextMenu(x, y, branch, currentBranch) {
  removeGitContextMenu();

  const menu = document.createElement('div');
  menu.className = 'git-context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const isCurrentBranch = branch === currentBranch;
  const isRemote = branch.includes('/');
  const items = [];

  if (!isCurrentBranch) {
    items.push({ label: `Checkout ${branch}`, action: 'checkout' });
    items.push({ label: `Merge ${branch} into ${currentBranch}`, action: 'merge' });
    items.push({ label: `Rebase ${currentBranch} onto ${branch}`, action: 'rebase' });
    if (isRemote) {
      items.push({ label: `Delete remote branch`, action: 'delete-remote', cls: 'danger' });
    } else {
      items.push({ label: `Delete branch`, action: 'delete', cls: 'danger' });
    }
  }

  menu.innerHTML = items.map(item =>
    `<div class="git-context-menu-item${item.cls ? ` git-context-menu-${item.cls}` : ''}" data-action="${item.action}">${item.label}</div>`
  ).join('');

  if (items.length === 0) {
    menu.innerHTML = '<div class="git-context-menu-item disabled">No actions</div>';
  }

  document.body.appendChild(menu);
  gitContextMenu = menu;

  // Position adjustment if off-screen
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 8}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 8}px`;

  menu.addEventListener('click', async (e) => {
    const item = e.target.closest('[data-action]');
    if (!item) return;
    removeGitContextMenu();

    if (item.dataset.action === 'checkout') {
      try {
        await window.api.gitCheckout(branch);
        showToast(`Switched to ${branch}`, 'success');
        renderGitView();
      } catch (err) {
        showToast(`Checkout failed: ${err.message}`, 'error');
      }
    } else if (item.dataset.action === 'merge') {
      if (!confirm(`Merge "${branch}" into "${currentBranch}"?`)) return;
      await performMerge(branch, currentBranch);
    } else if (item.dataset.action === 'delete') {
      if (!confirm(`Delete local branch "${branch}"?`)) return;
      try {
        await window.api.gitDeleteBranch(branch);
        showToast(`Branch ${branch} deleted`, 'success');
        renderGitView();
      } catch (err) {
        // Offer force delete for unmerged branches
        if (err.message && err.message.includes('not fully merged')) {
          if (confirm(`Branch "${branch}" is not fully merged. Force delete?`)) {
            try {
              await window.api.gitDeleteBranch(branch, true);
              showToast(`Branch ${branch} force deleted`, 'success');
              renderGitView();
            } catch (err2) {
              showToast(`Delete failed: ${err2.message}`, 'error');
            }
          }
        } else {
          showToast(`Delete failed: ${err.message}`, 'error');
        }
      }
    } else if (item.dataset.action === 'rebase') {
      if (!confirm(`Rebase "${currentBranch}" onto "${branch}"?`)) return;
      try {
        const result = await window.api.gitRebase(branch);
        if (result.success) {
          showToast(`Rebased onto ${branch}`, 'success');
        } else {
          showToast(`Rebase conflicts: ${result.conflicts.length} file(s)`, 'warning');
        }
        renderGitView();
      } catch (err) {
        showToast(`Rebase failed: ${err.message}`, 'error');
      }
    } else if (item.dataset.action === 'delete-remote') {
      if (!confirm(`Delete remote branch "${branch}"? This cannot be undone.`)) return;
      try {
        await window.api.gitDeleteRemoteBranch(branch);
        showToast(`Remote branch ${branch} deleted`, 'success');
        renderGitView();
      } catch (err) {
        showToast(`Delete remote failed: ${err.message}`, 'error');
      }
    }
  });

  // Close on click outside
  setTimeout(() => {
    document.addEventListener('click', removeGitContextMenu, { once: true });
  }, 0);
}

/** Remove the currently open git context menu from the DOM, if any. */
function removeGitContextMenu() {
  if (gitContextMenu) {
    gitContextMenu.remove();
    gitContextMenu = null;
  }
}

// Right-click on branch
document.addEventListener('contextmenu', (e) => {
  const branchEl = e.target.closest('[data-context-branch]');
  if (!branchEl) return;
  e.preventDefault();
  const branch = branchEl.dataset.contextBranch;
  // Find current branch from the HEAD-tagged item
  const headItem = document.querySelector('.git-sidebar-branch-current [data-context-branch]') ||
                   document.querySelector('.git-sidebar-branch-current');
  const currentBranch = headItem?.dataset?.contextBranch || '';
  showGitContextMenu(e.clientX, e.clientY, branch, currentBranch);
});

// ── Git View Event Handlers ─────────────────────────────────────────────

document.addEventListener('click', async (e) => {
  // Refresh
  if (e.target.id === 'btn-git-refresh' || e.target.closest('#btn-git-refresh')) {
    renderGitView();
    return;
  }

  // Resolve merge conflicts with LLM
  if (e.target.id === 'btn-git-resolve-llm' || e.target.closest('#btn-git-resolve-llm')) {
    try {
      const status = await window.api.gitStatus();
      const conflictFiles = status.conflicted || [];
      const fileList = conflictFiles.join(', ');
      const prompt = `There are merge conflicts in the following files: ${fileList}. Please help me resolve these merge conflicts. Look at each file, understand both sides of the conflict, and resolve them appropriately.`;
      window.sendToTerminal(prompt, { returnToGitView: true });
      showView('terminal');
    } catch (err) {
      showToast(`Failed to start LLM: ${err.message}`, 'error');
    }
    return;
  }

  // Abort merge
  if (e.target.id === 'btn-git-abort-merge' || e.target.closest('#btn-git-abort-merge')) {
    if (!confirm('Abort the current merge?')) return;
    try {
      await window.api.gitAbortMerge();
      showToast('Merge aborted', 'success');
      renderGitView();
    } catch (err) {
      showToast(`Abort failed: ${err.message}`, 'error');
    }
    return;
  }

  // Fetch
  if (e.target.id === 'btn-git-fetch' || e.target.closest('#btn-git-fetch')) {
    const btn = document.getElementById('btn-git-fetch');
    gitBtnLoading(btn, 'Fetch');
    try {
      await window.api.gitFetch();
      showToast('Fetch complete', 'success');
      renderGitView();
    } catch (err) {
      showToast(`Fetch failed: ${err.message}`, 'error');
      gitBtnDone(btn, 'Fetch');
    }
    return;
  }

  // Pull
  if (e.target.id === 'btn-git-pull' || e.target.closest('#btn-git-pull')) {
    const btn = document.getElementById('btn-git-pull');
    if (btn.disabled) return;
    gitBtnLoading(btn, 'Pull');
    try {
      const result = await window.api.gitPull();
      const count = result.summary?.changes ?? 0;
      showToast(`Pull complete (${count} change${count !== 1 ? 's' : ''})`, 'success');
      renderGitView();
    } catch (err) {
      showToast(`Pull failed: ${err.message}`, 'error');
      gitBtnDone(btn, 'Pull');
    }
    return;
  }

  // Push
  if (e.target.id === 'btn-git-push' || e.target.closest('#btn-git-push')) {
    const btn = document.getElementById('btn-git-push');
    if (btn.disabled) return;
    gitBtnLoading(btn, 'Push');
    try {
      await window.api.gitPush();
      showToast('Push complete', 'success');
      renderGitView();
    } catch (err) {
      showToast(`Push failed: ${err.message}`, 'error');
      gitBtnDone(btn, 'Push');
    }
    return;
  }

  // Stage file (checkbox unchecked→checked, or row click)
  const stageCheck = e.target.closest('.git-file-unstaged');
  if (stageCheck) {
    const file = stageCheck.dataset.stageFile;
    if (file) {
      try {
        await window.api.gitStage([file]);
        renderGitView();
      } catch (err) {
        showToast(`Stage failed: ${err.message}`, 'error');
      }
    }
    return;
  }

  // Unstage file (checkbox checked→unchecked, or row click)
  const unstageCheck = e.target.closest('.git-file-staged');
  if (unstageCheck) {
    const file = unstageCheck.dataset.unstageFile;
    if (file) {
      try {
        await window.api.gitUnstage([file]);
        renderGitView();
      } catch (err) {
        showToast(`Unstage failed: ${err.message}`, 'error');
      }
    }
    return;
  }

  // Stage all
  if (e.target.id === 'btn-git-stage-all' || e.target.closest('#btn-git-stage-all')) {
    try {
      await window.api.gitStageAll();
      renderGitView();
    } catch (err) {
      showToast(`Stage all failed: ${err.message}`, 'error');
    }
    return;
  }

  // Commit
  if (e.target.id === 'btn-git-commit' || e.target.closest('#btn-git-commit')) {
    const isAmend = document.getElementById('git-amend-toggle')?.checked;
    const message = buildCommitMessage();
    if (!message && !isAmend) {
      showToast('Please enter a commit message', 'warning');
      return;
    }
    const btn = document.getElementById('btn-git-commit');
    btn.disabled = true;
    btn.textContent = isAmend ? 'Amending...' : 'Committing...';
    try {
      let result;
      if (isAmend) {
        result = await window.api.gitAmend(message || undefined);
        showToast(`Amended ${result.hash?.substring(0, 7) || ''}`, 'success');
      } else {
        result = await window.api.gitCommit(message);
        showToast(`Committed ${result.hash?.substring(0, 7) || ''}`, 'success');
      }
      renderGitView();
    } catch (err) {
      showToast(`${isAmend ? 'Amend' : 'Commit'} failed: ${err.message}`, 'error');
      btn.disabled = false;
      btn.textContent = 'Commit';
    }
    return;
  }

  // Generate commit message with LLM
  if (e.target.id === 'btn-git-generate-msg' || e.target.closest('#btn-git-generate-msg')) {
    const btn = document.getElementById('btn-git-generate-msg');
    btn.disabled = true;
    btn.textContent = 'Generating...';
    try {
      const diff = await window.api.gitDiff();
      const diffText = (diff.staged || diff.unstaged || '').substring(0, 4000);
      if (!diffText.trim()) {
        showToast('No diff available to generate message from', 'warning');
        btn.disabled = false;
        btn.textContent = 'Generate Message';
        return;
      }
      // Build a simple summary from the diff stat
      const lines = diffText.split('\n').filter(l => l.trim());
      const summary = lines.slice(0, 20).join('\n');
      const textarea = document.getElementById('git-commit-message');
      if (textarea) {
        textarea.value = summary;
        textarea.focus();
      }
      showToast('Diff summary inserted — edit as needed', 'success');
    } catch (err) {
      showToast(`Generate failed: ${err.message}`, 'error');
    }
    btn.disabled = false;
    btn.textContent = 'Generate Message';
    return;
  }

  // ── Tag actions ──

  // New tag form toggle
  if (e.target.id === 'btn-git-new-tag' || e.target.closest('#btn-git-new-tag')) {
    const form = document.getElementById('git-new-tag-form');
    if (form) form.classList.toggle('hidden');
    return;
  }

  // Cancel new tag
  if (e.target.id === 'btn-git-cancel-tag' || e.target.closest('#btn-git-cancel-tag')) {
    const form = document.getElementById('git-new-tag-form');
    if (form) form.classList.add('hidden');
    return;
  }

  // Create tag
  if (e.target.id === 'btn-git-create-tag' || e.target.closest('#btn-git-create-tag')) {
    const name = document.getElementById('git-tag-name')?.value?.trim();
    const message = document.getElementById('git-tag-message')?.value?.trim();
    if (!name) {
      showToast('Tag name is required', 'warning');
      return;
    }
    try {
      await window.api.gitCreateTag(name, message || undefined);
      showToast(`Tag ${name} created`, 'success');
      renderGitView();
    } catch (err) {
      showToast(`Create tag failed: ${err.message}`, 'error');
    }
    return;
  }

  // Push single tag
  const pushTagBtn = e.target.closest('[data-push-tag]');
  if (pushTagBtn) {
    const name = pushTagBtn.dataset.pushTag;
    pushTagBtn.disabled = true;
    pushTagBtn.textContent = '...';
    try {
      await window.api.gitPushTag(name);
      showToast(`Tag ${name} pushed`, 'success');
    } catch (err) {
      showToast(`Push tag failed: ${err.message}`, 'error');
    }
    pushTagBtn.disabled = false;
    pushTagBtn.textContent = 'Push';
    return;
  }

  // Delete tag
  const deleteTagBtn = e.target.closest('[data-delete-tag]');
  if (deleteTagBtn) {
    const name = deleteTagBtn.dataset.deleteTag;
    if (!confirm(`Delete tag "${name}"?`)) return;
    try {
      await window.api.gitDeleteTag(name);
      showToast(`Tag ${name} deleted`, 'success');
      renderGitView();
    } catch (err) {
      showToast(`Delete tag failed: ${err.message}`, 'error');
    }
    return;
  }

  // Push all tags
  if (e.target.id === 'btn-git-push-all-tags' || e.target.closest('#btn-git-push-all-tags')) {
    const btn = document.getElementById('btn-git-push-all-tags');
    btn.disabled = true;
    btn.textContent = 'Pushing...';
    try {
      await window.api.gitPushAllTags();
      showToast('All tags pushed', 'success');
    } catch (err) {
      showToast(`Push all tags failed: ${err.message}`, 'error');
    }
    btn.disabled = false;
    btn.textContent = 'Push All';
    return;
  }

  // Create Pull Request
  if (e.target.id === 'btn-git-create-pr' || e.target.closest('#btn-git-create-pr')) {
    const title = document.getElementById('git-pr-title')?.value?.trim();
    const body = document.getElementById('git-pr-body')?.value?.trim();
    const isDraft = document.getElementById('git-pr-draft')?.checked;
    const base = document.getElementById('git-pr-base')?.value;

    let cmd = 'gh pr create';
    if (title) cmd += ` --title "${title.replace(/"/g, '\\"')}"`;
    if (body) cmd += ` --body "${body.replace(/"/g, '\\"')}"`;
    if (isDraft) cmd += ' --draft';
    if (base) cmd += ` --base ${base}`;
    if (!title) cmd += ' --fill';

    // Show terminal and run the command
    window.sendToTerminal(cmd, { returnToGitView: true });
    return;
  }

  // gh CLI install info
  if (e.target.id === 'btn-gh-install-info' || e.target.closest('#btn-gh-install-info')) {
    e.preventDefault();
    window.api.openExternal('https://cli.github.com/');
    return;
  }

  // New branch form toggle
  if (e.target.id === 'btn-git-new-branch' || e.target.closest('#btn-git-new-branch')) {
    const form = document.getElementById('git-new-branch-form');
    if (form) form.classList.toggle('hidden');
    return;
  }

  // Cancel new branch
  if (e.target.id === 'btn-git-cancel-branch' || e.target.closest('#btn-git-cancel-branch')) {
    const form = document.getElementById('git-new-branch-form');
    if (form) form.classList.add('hidden');
    return;
  }

  // Create branch
  if (e.target.id === 'btn-git-create-branch' || e.target.closest('#btn-git-create-branch')) {
    const prefix = document.getElementById('git-branch-prefix')?.value || '';
    const name = document.getElementById('git-branch-name')?.value?.trim();
    const startPoint = document.getElementById('git-branch-start')?.value;
    if (!name) {
      showToast('Branch name is required', 'warning');
      return;
    }
    const fullName = prefix + name;
    try {
      await window.api.gitCreateBranch(fullName, startPoint || undefined);
      showToast(`Branch ${fullName} created and checked out`, 'success');
      renderGitView();
    } catch (err) {
      showToast(`Create branch failed: ${err.message}`, 'error');
    }
    return;
  }

  // Checkout local branch
  const localItem = e.target.closest('[data-branch]');
  if (localItem) {
    const branch = localItem.dataset.branch;
    if (!confirm(`Checkout branch "${branch}"?`)) return;
    try {
      await window.api.gitCheckout(branch);
      showToast(`Switched to ${branch}`, 'success');
      renderGitView();
    } catch (err) {
      showToast(`Checkout failed: ${err.message}`, 'error');
    }
    return;
  }

  // Checkout remote branch (creates local tracking branch)
  const remoteItem = e.target.closest('[data-remote-branch]');
  if (remoteItem) {
    const remoteBranch = remoteItem.dataset.remoteBranch;
    const localName = remoteBranch.replace(/^[^/]+\//, '');
    if (!confirm(`Checkout remote branch "${remoteBranch}" as local "${localName}"?`)) return;
    try {
      await window.api.gitCheckout(localName);
      showToast(`Switched to ${localName}`, 'success');
      renderGitView();
    } catch (err) {
      showToast(`Checkout failed: ${err.message}`, 'error');
    }
    return;
  }

  // ── Stash ──
  if (e.target.id === 'btn-git-stash' || e.target.closest('#btn-git-stash')) {
    const message = prompt('Stash message (optional):');
    if (message === null) return; // cancelled
    try {
      await window.api.gitStash(message || undefined);
      showToast('Changes stashed', 'success');
      renderGitView();
    } catch (err) {
      showToast(`Stash failed: ${err.message}`, 'error');
    }
    return;
  }

  const popBtn = e.target.closest('[data-stash-pop]');
  if (popBtn) {
    const index = parseInt(popBtn.dataset.stashPop);
    try {
      await window.api.gitStashPop(index);
      showToast('Stash popped', 'success');
      renderGitView();
    } catch (err) {
      showToast(`Stash pop failed: ${err.message}`, 'error');
    }
    return;
  }

  const dropBtn = e.target.closest('[data-stash-drop]');
  if (dropBtn) {
    const index = parseInt(dropBtn.dataset.stashDrop);
    if (!confirm(`Drop stash@{${index}}?`)) return;
    try {
      await window.api.gitStashDrop(index);
      showToast('Stash dropped', 'success');
      renderGitView();
    } catch (err) {
      showToast(`Stash drop failed: ${err.message}`, 'error');
    }
    return;
  }

  // ── Inline Diff Viewer ──
  const diffTarget = e.target.closest('[data-diff-file]');
  if (diffTarget && !e.target.classList.contains('git-file-check')) {
    const file = diffTarget.dataset.diffFile;
    const staged = diffTarget.dataset.diffStaged === 'true';
    const viewer = document.getElementById('git-diff-viewer');
    if (!viewer) return;

    // Toggle off if already showing this file
    if (viewer.dataset.currentFile === file && !viewer.classList.contains('hidden')) {
      viewer.classList.add('hidden');
      viewer.dataset.currentFile = '';
      return;
    }

    viewer.innerHTML = '<p class="git-loading">Loading diff...</p>';
    viewer.classList.remove('hidden');
    viewer.dataset.currentFile = file;

    try {
      const diff = await window.api.gitDiffFile(file, staged);
      if (!diff.trim()) {
        viewer.innerHTML = `<div class="git-diff-header"><span>${file}</span><button class="btn btn-ghost btn-xs" id="btn-close-diff">&times;</button></div><p class="git-empty-sm">No diff available (new untracked file)</p>`;
      } else {
        viewer.innerHTML = `<div class="git-diff-header"><span>${file} ${staged ? '(staged)' : ''}</span><button class="btn btn-ghost btn-xs" id="btn-close-diff">&times;</button></div><pre class="git-diff-content">${formatDiff(diff)}</pre>`;
      }
    } catch (err) {
      viewer.innerHTML = `<div class="git-diff-header"><span>${file}</span><button class="btn btn-ghost btn-xs" id="btn-close-diff">&times;</button></div><p class="git-empty-sm">Could not load diff</p>`;
    }
    return;
  }

  // Close diff viewer
  if (e.target.id === 'btn-close-diff' || e.target.closest('#btn-close-diff')) {
    const viewer = document.getElementById('git-diff-viewer');
    if (viewer) { viewer.classList.add('hidden'); viewer.dataset.currentFile = ''; }
    return;
  }

  // ── Commit Detail ──
  const commitItem = e.target.closest('[data-show-commit]');
  if (commitItem) {
    const hash = commitItem.dataset.showCommit;
    const detail = document.getElementById('git-commit-detail');
    if (!detail) return;

    // Toggle off if already showing this commit
    if (detail.dataset.currentHash === hash && !detail.classList.contains('hidden')) {
      detail.classList.add('hidden');
      detail.dataset.currentHash = '';
      return;
    }

    detail.innerHTML = '<p class="git-loading">Loading commit...</p>';
    detail.classList.remove('hidden');
    detail.dataset.currentHash = hash;

    try {
      const info = await window.api.gitShowCommit(hash);
      const filesHtml = info.files.map(f => {
        const statusCls = { A: 'a', M: 'm', D: 'd', R: 'r' }[f.status] || '';
        return `<div class="git-commit-file-item" data-commit-file-diff="${hash}" data-commit-file="${f.path}">
          <span class="git-file-status git-file-status-${statusCls}">${f.status}</span>
          <span class="git-file-name">${f.path}</span>
          <button class="btn btn-ghost btn-xs git-file-history-btn" data-file-history="${f.path}" title="File history">&circlearrowleft;</button>
        </div>`;
      }).join('');

      detail.innerHTML = `
        <div class="git-commit-detail-header">
          <button class="btn btn-ghost btn-xs" id="btn-close-commit-detail">&times;</button>
          <strong>${info.subject}</strong>
          <div class="git-commit-detail-meta">${info.hashShort} &middot; ${info.author} &middot; ${info.date}</div>
          ${info.body ? `<pre class="git-commit-detail-body">${info.body}</pre>` : ''}
          <div class="git-commit-detail-actions">
            <button class="btn btn-ghost btn-xs" data-revert-commit="${hash}" title="Create a new commit that undoes this one">Revert</button>
          </div>
        </div>
        <div class="git-commit-detail-files">${filesHtml}</div>
        <div id="git-commit-file-diff-viewer" class="git-diff-viewer hidden"></div>
      `;
    } catch (err) {
      detail.innerHTML = `<p class="git-empty-sm">Could not load commit: ${err.message}</p>`;
    }
    return;
  }

  // Close commit detail
  if (e.target.id === 'btn-close-commit-detail' || e.target.closest('#btn-close-commit-detail')) {
    const detail = document.getElementById('git-commit-detail');
    if (detail) { detail.classList.add('hidden'); detail.dataset.currentHash = ''; }
    return;
  }

  // Commit file diff
  const commitFileDiffEl = e.target.closest('[data-commit-file-diff]');
  if (commitFileDiffEl) {
    const hash = commitFileDiffEl.dataset.commitFileDiff;
    const file = commitFileDiffEl.dataset.commitFile;
    const viewer = document.getElementById('git-commit-file-diff-viewer');
    if (!viewer) return;

    if (viewer.dataset.currentFile === file && !viewer.classList.contains('hidden')) {
      viewer.classList.add('hidden');
      viewer.dataset.currentFile = '';
      return;
    }

    viewer.innerHTML = '<p class="git-loading">Loading diff...</p>';
    viewer.classList.remove('hidden');
    viewer.dataset.currentFile = file;

    try {
      const diff = await window.api.gitCommitFileDiff(hash, file);
      viewer.innerHTML = `<div class="git-diff-header"><span>${file}</span><button class="btn btn-ghost btn-xs btn-close-commit-file-diff">&times;</button></div><pre class="git-diff-content">${formatDiff(diff)}</pre>`;
    } catch (err) {
      viewer.innerHTML = `<div class="git-diff-header"><span>${file}</span><button class="btn btn-ghost btn-xs btn-close-commit-file-diff">&times;</button></div><p class="git-empty-sm">Could not load diff</p>`;
    }
    return;
  }

  // Close commit file diff
  if (e.target.classList.contains('btn-close-commit-file-diff') || e.target.closest('.btn-close-commit-file-diff')) {
    const viewer = document.getElementById('git-commit-file-diff-viewer');
    if (viewer) { viewer.classList.add('hidden'); viewer.dataset.currentFile = ''; }
    return;
  }

  // ── Discard ──
  const discardBtn = e.target.closest('[data-discard-file]');
  if (discardBtn) {
    const file = discardBtn.dataset.discardFile;
    if (!confirm(`Discard changes in "${file}"?`)) return;
    try {
      await window.api.gitDiscardFile(file);
      showToast(`Discarded changes in ${file}`, 'success');
      renderGitView();
    } catch (err) {
      showToast(`Discard failed: ${err.message}`, 'error');
    }
    return;
  }

  if (e.target.id === 'btn-git-discard-all' || e.target.closest('#btn-git-discard-all')) {
    if (!confirm('Discard ALL local changes? This cannot be undone.')) return;
    try {
      await window.api.gitDiscardAll();
      showToast('All changes discarded', 'success');
      renderGitView();
    } catch (err) {
      showToast(`Discard all failed: ${err.message}`, 'error');
    }
    return;
  }

  // ── Revert Commit ──
  const revertBtn = e.target.closest('[data-revert-commit]');
  if (revertBtn) {
    const hash = revertBtn.dataset.revertCommit;
    if (!confirm(`Revert commit ${hash.substring(0, 7)}? This will create a new commit.`)) return;
    try {
      await window.api.gitRevert(hash);
      showToast('Commit reverted', 'success');
      renderGitView();
    } catch (err) {
      showToast(`Revert failed: ${err.message}`, 'error');
    }
    return;
  }

  // ── Rebase Controls ──
  if (e.target.id === 'btn-git-rebase-continue' || e.target.closest('#btn-git-rebase-continue')) {
    try {
      await window.api.gitRebaseContinue();
      showToast('Rebase continued', 'success');
      renderGitView();
    } catch (err) {
      showToast(`Rebase continue failed: ${err.message}`, 'error');
    }
    return;
  }

  if (e.target.id === 'btn-git-rebase-abort' || e.target.closest('#btn-git-rebase-abort')) {
    try {
      await window.api.gitRebaseAbort();
      showToast('Rebase aborted', 'success');
      renderGitView();
    } catch (err) {
      showToast(`Rebase abort failed: ${err.message}`, 'error');
    }
    return;
  }

  // ── File History ──
  const fileHistoryBtn = e.target.closest('[data-file-history]');
  if (fileHistoryBtn) {
    e.stopPropagation();
    const file = fileHistoryBtn.dataset.fileHistory;
    const viewer = document.getElementById('git-commit-file-diff-viewer') || document.getElementById('git-diff-viewer');
    if (!viewer) return;

    viewer.innerHTML = '<p class="git-loading">Loading file history...</p>';
    viewer.classList.remove('hidden');

    try {
      const history = await window.api.gitFileLog(file, 20);
      if (history.length === 0) {
        viewer.innerHTML = `<div class="git-diff-header"><span>History: ${file}</span><button class="btn btn-ghost btn-xs btn-close-commit-file-diff">&times;</button></div><p class="git-empty-sm">No history found</p>`;
      } else {
        const historyHtml = history.map(c => `
          <div class="git-commit-item git-commit-clickable" data-show-commit="${c.hash}">
            <span class="git-commit-hash">${c.hashShort}</span>
            <span class="git-commit-message">${c.message}</span>
            <span class="git-commit-meta">${c.author} &middot; ${formatTimeAgo(c.date)}</span>
          </div>
        `).join('');
        viewer.innerHTML = `<div class="git-diff-header"><span>History: ${file} (${history.length} commits)</span><button class="btn btn-ghost btn-xs btn-close-commit-file-diff">&times;</button></div><div class="git-commit-list">${historyHtml}</div>`;
      }
    } catch (err) {
      viewer.innerHTML = `<div class="git-diff-header"><span>History: ${file}</span><button class="btn btn-ghost btn-xs btn-close-commit-file-diff">&times;</button></div><p class="git-empty-sm">Could not load history</p>`;
    }
    return;
  }

  // ── Conflict Viewer ──
  const conflictFileEl = e.target.closest('[data-conflict-file]');
  if (conflictFileEl && !conflictFileEl.closest('.git-conflict-save')) {
    const file = conflictFileEl.dataset.conflictFile;
    const viewer = document.getElementById('git-conflict-viewer');
    if (!viewer) return;

    // Toggle off if already showing
    if (viewer.dataset.currentFile === file && !viewer.classList.contains('hidden')) {
      viewer.classList.add('hidden');
      viewer.dataset.currentFile = '';
      return;
    }

    viewer.innerHTML = '<div class="git-loading"><span class="git-spinner"></span> Loading conflict...</div>';
    viewer.classList.remove('hidden');
    viewer.dataset.currentFile = file;

    try {
      const content = await window.api.gitReadConflictFile(file);
      const blocks = parseConflicts(content);
      viewer.innerHTML = renderConflictViewer(file, blocks);
      // Store blocks and original content for resolution
      viewer._blocks = blocks;
      viewer._fileName = file;
      viewer._resolutions = {};
    } catch (err) {
      viewer.innerHTML = `<div class="git-diff-header"><span>${file}</span><button class="btn btn-ghost btn-xs" id="btn-close-conflict">&times;</button></div><p class="git-empty-sm">Could not load file: ${err.message}</p>`;
    }
    return;
  }

  // Close conflict viewer
  if (e.target.id === 'btn-close-conflict' || e.target.closest('#btn-close-conflict')) {
    const viewer = document.getElementById('git-conflict-viewer');
    if (viewer) { viewer.classList.add('hidden'); viewer.dataset.currentFile = ''; }
    return;
  }

  // Resolve single conflict block
  const resolveBtn = e.target.closest('[data-resolve-block]');
  if (resolveBtn) {
    const index = parseInt(resolveBtn.dataset.resolveBlock);
    const choice = resolveBtn.dataset.resolveChoice;
    const viewer = document.getElementById('git-conflict-viewer');
    if (!viewer || !viewer._blocks) return;

    viewer._resolutions[index] = choice;

    // Visual feedback — highlight chosen, dim the block
    const block = viewer.querySelector(`[data-conflict-index="${index}"]`);
    if (block) {
      block.classList.add('git-conflict-resolved');
      block.dataset.resolvedChoice = choice;
      // Update button states
      block.querySelectorAll('[data-resolve-block]').forEach(b => {
        b.classList.toggle('git-conflict-btn-active', b.dataset.resolveChoice === choice);
      });
    }
    return;
  }

  // Accept all ours/theirs
  const acceptAllBtn = e.target.closest('[data-conflict-accept-all]');
  if (acceptAllBtn) {
    const choice = acceptAllBtn.dataset.conflictAcceptAll;
    const viewer = document.getElementById('git-conflict-viewer');
    if (!viewer || !viewer._blocks) return;

    viewer._blocks.forEach((block, i) => {
      if (block.type === 'conflict') {
        viewer._resolutions[i] = choice;
        const el = viewer.querySelector(`[data-conflict-index="${i}"]`);
        if (el) {
          el.classList.add('git-conflict-resolved');
          el.dataset.resolvedChoice = choice;
          el.querySelectorAll('[data-resolve-block]').forEach(b => {
            b.classList.toggle('git-conflict-btn-active', b.dataset.resolveChoice === choice);
          });
        }
      }
    });
    showToast(`All conflicts set to "${choice}"`, 'info');
    return;
  }

  // Save resolved conflict
  if (e.target.id === 'btn-git-save-conflict' || e.target.closest('#btn-git-save-conflict')) {
    const viewer = document.getElementById('git-conflict-viewer');
    if (!viewer || !viewer._blocks) return;

    // Check all conflicts are resolved
    const conflictBlocks = viewer._blocks.map((b, i) => ({ ...b, index: i })).filter(b => b.type === 'conflict');
    const unresolved = conflictBlocks.filter(b => !viewer._resolutions[b.index]);
    if (unresolved.length > 0) {
      showToast(`${unresolved.length} conflict(s) not yet resolved`, 'warning');
      return;
    }

    // Build resolved content
    const resolved = viewer._blocks.map((block, i) => {
      if (block.type === 'clean') return block.content;
      const choice = viewer._resolutions[i];
      if (choice === 'ours') return block.ours;
      if (choice === 'theirs') return block.theirs;
      if (choice === 'both') return block.ours + '\n' + block.theirs;
      return block.ours; // fallback
    }).join('\n');

    const file = viewer._fileName;
    try {
      await window.api.gitResolveConflict(file, resolved);
      showToast(`${file} resolved and staged`, 'success');
      viewer.classList.add('hidden');
      viewer.dataset.currentFile = '';
      renderGitView();
    } catch (err) {
      showToast(`Save failed: ${err.message}`, 'error');
    }
    return;
  }
});

// ── Toast Notifications ─────────────────────────────────────────────────

/** Create the `#toast-container` element and append it to `<body>` if it does not already
 * exist. Must be called once before any `showToast` calls.
 */
function setupToastContainer() {
  if (document.getElementById('toast-container')) return;
  const container = document.createElement('div');
  container.id = 'toast-container';
  document.body.appendChild(container);
}

/** Show a transient toast notification that slides in and auto-dismisses after a timeout.
 * @param {string} message - Text content to display in the toast.
 * @param {'info'|'success'|'warning'|'error'|'phase'} [type='info'] - Visual style and icon.
 * @param {number} [duration=5000] - Milliseconds before the toast begins its exit animation.
 */
function showToast(message, type = 'info', duration = 5000) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${type === 'phase' ? '&#9654;' : type === 'success' ? '&#10003;' : 'ℹ'}</span>
    <span class="toast-message">${message}</span>
    <button class="toast-close" onclick="this.parentElement.remove()">&times;</button>
  `;

  container.appendChild(toast);

  // Trigger enter animation
  requestAnimationFrame(() => toast.classList.add('show'));

  // Auto-remove
  setTimeout(() => {
    toast.classList.remove('show');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    // Fallback removal if transitionend doesn't fire
    setTimeout(() => toast.remove(), 500);
  }, duration);
}

// ── Phase Change Poller ─────────────────────────────────────────────────

/** Capture the current status of every story across all epics into `previousStoryStates`.
 * Called after loading or refreshing project data so that subsequent polls can detect changes.
 */
function snapshotStoryStates() {
  previousStoryStates = {};
  if (!projectData || !projectData.epics) return;
  for (const epic of projectData.epics) {
    for (const story of (epic.stories || [])) {
      previousStoryStates[story.slug] = story.status;
    }
  }
}

/** Fetch the notification sub-object from persisted settings, with safe defaults.
 * @returns {Promise<{toast: boolean, os: boolean, sound: boolean, pollInterval: number}>}
 *   Notification preferences.
 */
async function getNotificationSettings() {
  const settings = await window.api.getSettings();
  return settings.notifications || { toast: true, os: true, sound: false, pollInterval: 30 };
}

/** Scan the current project for story status changes since the last snapshot.
 * For each changed story, re-renders the active view and fires toast and/or OS
 * notifications according to user preferences. Updates `projectData` and snapshots
 * the new state on every poll, regardless of whether changes were found.
 * @returns {Promise<void>}
 */
async function pollForPhaseChanges() {
  if (!projectData) return;

  const data = await window.api.scanProject();
  if (!data || !data.found) return;

  const changes = [];
  for (const epic of data.epics) {
    for (const story of (epic.stories || [])) {
      const prev = previousStoryStates[story.slug];
      if (prev && prev !== story.status) {
        changes.push({
          slug: story.slug,
          title: story.title,
          epicNumber: story.epicNumber,
          storyNumber: story.storyNumber,
          from: prev,
          to: story.status
        });
      }
    }
  }

  // Update project data + snapshot
  projectData = data;
  snapshotStoryStates();

  if (changes.length > 0) {
    // Re-render current view
    if (currentView === 'epics') renderEpics();
    else if (currentView === 'epic-detail' && currentEpic) {
      const updated = projectData.epics.find(e => e.number === currentEpic.number);
      if (updated) { currentEpic = updated; renderEpicDetail(); }
    }

    const notifSettings = await getNotificationSettings();

    for (const change of changes) {
      const fromLabel = PHASES[change.from]?.label || change.from;
      const toLabel = PHASES[change.to]?.label || change.to;
      const msg = `Story ${change.epicNumber}.${change.storyNumber} "${change.title}" moved from ${fromLabel} to ${toLabel}`;

      if (notifSettings.toast) {
        showToast(msg, 'phase', 8000);
      }

      if (notifSettings.os) {
        window.api.showNotification({
          title: `Phase Change: ${toLabel}`,
          body: `${change.epicNumber}.${change.storyNumber} ${change.title}`
        });
      }

      if (notifSettings.sound) {
        playNotificationSound();
      }
    }
  }
}

/** Play a short 880 Hz sine-wave notification chime using the Web Audio API.
 * Silently no-ops if the Audio API is unavailable or throws.
 */
function playNotificationSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    osc.type = 'sine';
    gain.gain.value = 0.15;
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.stop(ctx.currentTime + 0.3);
  } catch { /* audio not available */ }
}

/** Start (or restart) the periodic phase-change poll timer using the configured poll interval.
 * Stops any existing timer first, then reads the interval from notification settings and
 * schedules `pollForPhaseChanges` accordingly.
 */
function startPhasePoller() {
  stopPhasePoller();
  getNotificationSettings().then(settings => {
    const interval = (settings.pollInterval || 30) * 1000;
    pollTimer = setInterval(pollForPhaseChanges, interval);
  });
}

/** Clear the phase-change poll interval timer if one is running. */
function stopPhasePoller() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ── View Router ─────────────────────────────────────────────────────────

window.showView = showView;
/** Switch the active content view and update navigation highlight and split-pane layout.
 * Views `'git'` and `'settings'` hide the terminal pane; `'terminal'` hides the top pane;
 * all other views show the standard split layout. Calls the appropriate render function
 * for the selected view.
 * @param {'welcome'|'epics'|'epic-detail'|'documents'|'party'|'history'|'git'|'terminal'|'settings'} view
 *   Identifier of the view to activate.
 */
function showView(view) {
  currentView = view;

  // Hide all views in split-top
  document.querySelectorAll('#split-top .view').forEach(v => v.classList.remove('active'));

  // Update nav
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  // Terminal-only mode: hide top pane + handle, let bottom fill the space
  // Full-content mode (git, settings): hide bottom pane + handle, let top fill
  const splitTop = document.getElementById('split-top');
  const splitHandle = document.getElementById('split-handle');
  const splitBottom = document.getElementById('split-bottom');
  const hideTerminal = view === 'git' || view === 'settings';

  if (view === 'terminal') {
    if (splitTop) splitTop.style.display = 'none';
    if (splitHandle) splitHandle.style.display = 'none';
    if (splitBottom) { splitBottom.style.flex = '1'; splitBottom.style.display = ''; }
  } else if (hideTerminal) {
    if (splitTop) { splitTop.style.display = ''; splitTop.style.flex = '1'; }
    if (splitHandle) splitHandle.style.display = 'none';
    if (splitBottom) splitBottom.style.display = 'none';
  } else {
    if (splitTop) { splitTop.style.display = ''; splitTop.style.flex = ''; }
    if (splitHandle) splitHandle.style.display = '';
    if (splitBottom) { splitBottom.style.flex = ''; splitBottom.style.display = ''; }
  }

  switch (view) {
    case 'welcome':
      renderWelcome();
      break;
    case 'epics':
      document.querySelector('[data-view="epics"]').classList.add('active');
      document.getElementById('view-epics').classList.add('active');
      renderEpics();
      break;
    case 'epic-detail':
      document.querySelector('[data-view="epics"]').classList.add('active');
      document.getElementById('view-epic-detail').classList.add('active');
      renderEpicDetail();
      break;
    case 'documents':
      document.querySelector('[data-view="documents"]').classList.add('active');
      document.getElementById('view-party').classList.add('active');
      renderDocuments();
      break;
    case 'party':
      document.querySelector('[data-view="party"]').classList.add('active');
      document.getElementById('view-party').classList.add('active');
      renderPartyMode();
      break;
    case 'history':
      document.querySelector('[data-view="history"]')?.classList.add('active');
      document.getElementById('view-history')?.classList.add('active');
      if (typeof window.renderSessionHistory === 'function') window.renderSessionHistory();
      break;
    case 'git':
      document.querySelector('[data-view="git"]')?.classList.add('active');
      document.getElementById('view-git')?.classList.add('active');
      renderGitView();
      break;
    case 'settings':
      document.querySelector('[data-view="settings"]')?.classList.add('active');
      document.getElementById('view-settings')?.classList.add('active');
      renderSettings();
      break;
  }
}

// ── Welcome Screen ──────────────────────────────────────────────────────

/** Render the welcome screen into `#view-epics`, showing the app name, tagline, and
 * an "Open Project Folder" button. Also creates a placeholder for warning messages.
 */
function renderWelcome() {
  const container = document.getElementById('view-epics');
  container.classList.add('active');
  container.innerHTML = `
    <div class="welcome-screen">
      <h2>BMAD Board</h2>
      <p>A visual dashboard for your BMAD project files. Open a project folder to get started.</p>
      <button class="btn btn-primary" onclick="openProject()">Open Project Folder</button>
      <div id="welcome-warning"></div>
    </div>
  `;
}

/** Display a warning message in the `#welcome-warning` element on the welcome screen.
 * @param {string} message - Warning text to show (rendered as innerHTML inside a `.warning-box`).
 */
function showWarning(message) {
  const el = document.getElementById('welcome-warning');
  if (el) {
    el.innerHTML = `<div class="warning-box">${message}</div>`;
  }
}

// ── Epics Grid ──────────────────────────────────────────────────────────

/** Render the Epics view header (title, search input, project switcher, refresh button)
 * and then delegate to `renderEpicCards` to populate the grid.
 * Does nothing if no project data is loaded.
 * @returns {Promise<void>}
 */
async function renderEpics() {
  if (!projectData) return;

  const header = document.querySelector('#view-epics .view-header');
  if (header) {
    const projectOptions = await buildProjectOptions();
    header.innerHTML = `
      <h2>Epics</h2>
      <div class="view-actions">
        <input type="text" id="search-epics" placeholder="Search epics..." class="search-input" value="${searchQuery}">
        <select id="epics-project-select" class="project-select project-select-inline" title="Switch project">${projectOptions}</select>
        <button class="btn btn-ghost btn-sm" onclick="refreshProject()" title="Cmd+R">Refresh</button>
      </div>
    `;
    document.getElementById('search-epics').addEventListener('input', (e) => {
      searchQuery = e.target.value.toLowerCase();
      renderEpicCards();
    });
    setupInlineProjectSelect('epics-project-select');
  }

  renderEpicCards();
}

/** Populate or rebuild the `#epics-grid` with one card per epic, applying the current
 * `searchQuery` filter. Builds the full view scaffold first if the grid element is absent.
 * @returns {Promise<void>}
 */
async function renderEpicCards() {
  const grid = document.getElementById('epics-grid');
  if (!grid) {
    const projectOptions = await buildProjectOptions();
    const container = document.getElementById('view-epics');
    container.innerHTML = `
      <div class="view-header">
        <h2>Epics</h2>
        <div class="view-actions">
          <input type="text" id="search-epics" placeholder="Search epics..." class="search-input" value="${searchQuery}">
          <select id="epics-project-select" class="project-select project-select-inline" title="Switch project">${projectOptions}</select>
          <button class="btn btn-ghost btn-sm" onclick="refreshProject()" title="Cmd+R">Refresh</button>
        </div>
      </div>
      <div id="epics-grid" class="epics-grid"></div>
    `;
    setupInlineProjectSelect('epics-project-select');
    document.getElementById('search-epics').addEventListener('input', (e) => {
      searchQuery = e.target.value.toLowerCase();
      renderEpicCards();
    });
  }

  const gridEl = document.getElementById('epics-grid');
  let epics = projectData.epics || [];

  if (searchQuery) {
    epics = epics.filter(e =>
      e.title.toLowerCase().includes(searchQuery) ||
      e.stories.some(s => s.title.toLowerCase().includes(searchQuery))
    );
  }

  gridEl.innerHTML = epics.map(epic => {
    const total = epic.stories.length;
    const done = epic.stories.filter(s => s.status === 'done').length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    return `
      <div class="epic-card" onclick="openEpic(${epic.number})">
        <div class="epic-card-number">Epic ${epic.number}</div>
        <div class="epic-card-title">${epic.title}</div>
        <div class="epic-card-meta">
          <span class="epic-card-stories">${total > 0 ? `${done}/${total} stories` : 'No stories yet'}</span>
          <span class="epic-card-status ${epic.status}">${epic.status.replace('-', ' ')}</span>
        </div>
        ${total > 0 ? `
          <div class="epic-progress-bar">
            <div class="epic-progress-fill" style="width: ${pct}%"></div>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

// ── Epic Detail (Stories) ───────────────────────────────────────────────

window.openEpic = function(epicNumber) {
  currentEpic = projectData.epics.find(e => e.number === epicNumber);
  if (!currentEpic) return;
  expandedStories = {};
  showView('epic-detail');
};

/** Render the Epic Detail view for `currentEpic`, including the back button, epic header,
 * per-story cards, and (if present) the retrospective card.
 */
function renderEpicDetail() {
  if (!currentEpic) return;

  // Back button
  document.getElementById('btn-back-epics').onclick = () => showView('epics');

  // Header
  const headerEl = document.getElementById('epic-detail-header');
  const total = currentEpic.stories.length;
  const done = currentEpic.stories.filter(s => s.status === 'done').length;

  headerEl.innerHTML = `
    <h2>Epic ${currentEpic.number}: ${currentEpic.title}</h2>
    <div class="meta">
      <span class="epic-card-status ${currentEpic.status}">${currentEpic.status.replace('-', ' ')}</span>
      <span>${done}/${total} stories completed</span>
    </div>
  `;

  // Actions
  const actionsDiv = document.querySelector('#view-epic-detail .view-actions');
  actionsDiv.innerHTML = `
    <button class="btn btn-ghost btn-sm" onclick="refreshProject()">Refresh</button>
  `;

  // Stories
  const listEl = document.getElementById('stories-list');
  listEl.innerHTML = currentEpic.stories.map(story => renderStoryCard(story)).join('');

  // Retrospective card
  if (currentEpic.retrospective) {
    listEl.innerHTML += renderRetroCard(currentEpic);
  }
}

/** Generate the HTML for a single story card, including the phase-pill progress bar,
 * expand/collapse toggle, optional inline markdown editor, and launch button.
 * @param {object} story - Story object from the BMAD scanner result.
 * @param {string} story.slug - Unique story identifier (e.g. `"2-5-5"`).
 * @param {string} story.title - Human-readable story title.
 * @param {string} story.status - Current phase key (e.g. `"in-progress"`).
 * @param {string} [story.filePath] - Absolute path to the story markdown file.
 * @param {string} [story.content] - Raw markdown content of the story file.
 * @param {number} story.epicNumber - Parent epic number.
 * @param {number} story.storyNumber - Story number within the epic.
 * @returns {string} HTML string for the story card element.
 */
function renderStoryCard(story) {
  const isExpanded = expandedStories[story.slug] || false;
  const phaseIndex = PHASE_ORDER.indexOf(story.status);

  // Check if this story is actively running in a terminal tab
  const activeStories = typeof window.getActiveStories === 'function' ? window.getActiveStories() : [];
  const activeEntry = activeStories.find(s => s.slug === story.slug);

  const phasePills = PHASE_ORDER.map((phase, i) => {
    const isActive = phase === story.status;
    const isCompleted = i < phaseIndex;
    const isClickable = isActive && phase !== 'done';
    const isPulsing = activeEntry && isActive;
    const connector = i < PHASE_ORDER.length - 1
      ? `<span class="phase-connector ${isCompleted || isActive ? 'completed' : ''}"></span>`
      : '';

    return `
      <span class="phase-pill ${phase} ${isActive ? 'active' : ''} ${isClickable ? 'clickable' : ''} ${isPulsing ? 'pulsing' : ''}"
            ${isClickable ? `onclick="event.stopPropagation(); launchPhase('${story.status}', '${story.slug}', '${story.filePath || ''}')"` : ''}
            title="${isPulsing ? 'Running in terminal' : isClickable ? 'Click to launch Claude with this phase command' : PHASES[phase].label}">
        ${PHASES[phase].label}
      </span>${connector}
    `;
  }).join('');

  const contentKey = `story-${story.slug}`;
  const mode = viewMode[contentKey] || 'rendered';
  const isDirty = editorDirty[contentKey] || false;
  const escapedFilePath = (story.filePath || '').replace(/'/g, "\\'");

  let contentHtml = '';
  if (story.content) {
    if (mode === 'edit') {
      const editText = editorContent[contentKey] !== undefined ? editorContent[contentKey] : story.content;
      contentHtml = `<div class="story-content edit-mode">
        <textarea class="md-editor" data-key="${contentKey}" data-filepath="${escapedFilePath}" oninput="onEditorInput('${contentKey}')">${MD.esc(editText)}</textarea>
      </div>`;
    } else if (mode === 'raw') {
      contentHtml = `<div class="story-content raw">${MD.esc(story.content)}</div>`;
    } else {
      contentHtml = `<div class="story-content">${MD.render(story.content)}</div>`;
    }
  } else {
    contentHtml = `<div class="story-content"><p style="color:var(--text-muted)">No story file found. Click the active phase to create it.</p></div>`;
  }

  const canLaunch = story.status !== 'done';
  const launchLabel = PHASES[story.status]?.label || 'Phase';

  return `
    <div class="story-card ${isExpanded ? 'expanded' : ''}" data-slug="${story.slug}">
      <div class="story-header">
        <span class="story-expand-icon" onclick="toggleStory('${story.slug}')" title="Expand/collapse">&#9654;</span>
        <span class="story-number" onclick="toggleStory('${story.slug}')">${story.epicNumber}.${story.storyNumber}</span>
        <span class="story-title" onclick="toggleStory('${story.slug}')">${story.title}</span>
        <div class="phase-pills">${phasePills}</div>
        ${canLaunch ? `
          <button class="story-launch-btn" onclick="event.stopPropagation(); launchPhase('${story.status}', '${story.slug}', '${story.filePath || ''}')" title="Launch ${launchLabel}">&#9654;</button>
        ` : '<span class="story-done-icon" title="Done">&#10003;</span>'}
      </div>
      <div class="story-detail">
        <div class="story-actions">
          ${story.content ? `
            ${renderToggleGroup(contentKey, mode, escapedFilePath)}
            ${mode === 'edit' ? `
              <button class="btn btn-save btn-sm ${isDirty ? '' : 'disabled'}" onclick="event.stopPropagation(); saveEditor('${contentKey}', '${escapedFilePath}')" ${isDirty ? '' : 'disabled'}>Save</button>
              <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); showVersions('${contentKey}', '${escapedFilePath}')" title="Version history">Versions</button>
            ` : ''}
          ` : ''}
          ${story.status !== 'done' ? `
            <button class="btn btn-primary btn-sm" onclick="event.stopPropagation(); launchPhase('${story.status}', '${story.slug}', '${story.filePath || ''}')">
              Launch ${PHASES[story.status]?.label || 'Phase'}
            </button>
          ` : ''}
        </div>
        ${contentHtml}
      </div>
    </div>
  `;
}

/** Generate the HTML for the retrospective card shown at the bottom of an epic detail view.
 * Handles absent retro files gracefully and supports rendered/edit/raw modes like story cards.
 * @param {object} epic - Epic object from the BMAD scanner result.
 * @param {number} epic.number - Epic number.
 * @param {object} [epic.retrospective] - Retrospective data, if present.
 * @param {string} [epic.retrospective.content] - Raw markdown content.
 * @param {string} [epic.retrospective.filePath] - Absolute path to the retro file.
 * @param {string} [epic.retrospective.status] - Display status (e.g. `"optional"`).
 * @returns {string} HTML string for the retrospective card element.
 */
function renderRetroCard(epic) {
  const retro = epic.retrospective;
  const hasContent = retro && retro.content;
  const status = retro ? retro.status : 'optional';
  const isExpanded = expandedStories[`retro-${epic.number}`] || false;
  const contentKey = `retro-${epic.number}`;
  const mode = viewMode[contentKey] || 'rendered';
  const isDirty = editorDirty[contentKey] || false;
  const escapedFilePath = (retro?.filePath || '').replace(/'/g, "\\'");

  let contentHtml = '';
  if (hasContent) {
    if (mode === 'edit') {
      const editText = editorContent[contentKey] !== undefined ? editorContent[contentKey] : retro.content;
      contentHtml = `<div class="story-content edit-mode">
        <textarea class="md-editor" data-key="${contentKey}" data-filepath="${escapedFilePath}" oninput="onEditorInput('${contentKey}')">${MD.esc(editText)}</textarea>
      </div>`;
    } else if (mode === 'raw') {
      contentHtml = `<div class="story-content raw">${MD.esc(retro.content)}</div>`;
    } else {
      contentHtml = `<div class="story-content">${MD.render(retro.content)}</div>`;
    }
  }

  return `
    <div class="retro-card ${isExpanded ? 'expanded' : ''}">
      <div class="retro-card-header" onclick="toggleRetro(${epic.number})">
        ${hasContent ? `<span class="story-expand-icon">&#9654;</span>` : ''}
        <div class="retro-card-title">
          <span>&#127881;</span>
          <span>Epic ${epic.number} Retrospective</span>
        </div>
        <span class="retro-card-status ${status}">${status}</span>
      </div>
      ${hasContent && isExpanded ? `
        <div class="retro-card-detail">
          <div class="story-actions">
            ${renderToggleGroup(contentKey, mode, escapedFilePath)}
            ${mode === 'edit' ? `
              <button class="btn btn-save btn-sm ${isDirty ? '' : 'disabled'}" onclick="event.stopPropagation(); saveEditor('${contentKey}', '${escapedFilePath}')" ${isDirty ? '' : 'disabled'}>Save</button>
              <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); showVersions('${contentKey}', '${escapedFilePath}')" title="Version history">Versions</button>
            ` : ''}
          </div>
          ${contentHtml}
        </div>
      ` : ''}
    </div>
  `;
}

window.toggleRetro = function(epicNumber) {
  const key = `retro-${epicNumber}`;
  expandedStories[key] = !expandedStories[key];
  renderEpicDetail();
};

// ── Story Interactions ──────────────────────────────────────────────────

window.toggleStory = function(slug) {
  expandedStories[slug] = !expandedStories[slug];
  renderEpicDetail();
};

// ── Toggle Group Helper ──────────────────────────────────────────────────

/** Render a three-button Rendered / Edit / Raw toggle group for a content area.
 * @param {string} contentKey - State key used to track view mode and dirty state.
 * @param {'rendered'|'edit'|'raw'} mode - The currently active mode.
 * @param {string} escapedFilePath - Single-quote-escaped file path passed to the handler.
 * @param {string} [handler] - Name of the JS function to call on click.
 *   Defaults to `'setViewMode'`; pass `'setDocViewMode'` for the document reader.
 * @returns {string} HTML string for the toggle group `<div>`.
 */
function renderToggleGroup(contentKey, mode, escapedFilePath, handler) {
  const fn = handler || 'setViewMode';
  const extra = handler === 'setDocViewMode' ? `, '${escapedFilePath}'` : '';
  return `<div class="toggle-group">
    <button class="toggle-btn ${mode === 'rendered' ? 'active' : ''}" onclick="event.stopPropagation(); ${fn}('${contentKey}'${extra}, 'rendered')">Rendered</button>
    <button class="toggle-btn ${mode === 'edit' ? 'active' : ''}" onclick="event.stopPropagation(); ${fn}('${contentKey}'${extra}, 'edit')">Edit</button>
    <button class="toggle-btn ${mode === 'raw' ? 'active' : ''}" onclick="event.stopPropagation(); ${fn}('${contentKey}'${extra}, 'raw')">Raw</button>
  </div>`;
}

// ── Editor Functions ────────────────────────────────────────────────────

window.setViewMode = function(key, mode) {
  // Warn if leaving edit mode with unsaved changes
  if (viewMode[key] === 'edit' && mode !== 'edit' && editorDirty[key]) {
    if (!confirm('You have unsaved changes. Discard them?')) return;
    editorDirty[key] = false;
    delete editorContent[key];
  }
  viewMode[key] = mode;
  renderCurrentView();
};

window.onEditorInput = function(key) {
  const textarea = document.querySelector(`.md-editor[data-key="${key}"]`);
  if (!textarea) return;
  editorContent[key] = textarea.value;
  editorDirty[key] = true;
  // Update save button state without full re-render
  const saveBtn = textarea.closest('.story-detail, .retro-card-detail, .doc-detail-reader')?.querySelector('.btn-save');
  if (saveBtn) {
    saveBtn.classList.remove('disabled');
    saveBtn.disabled = false;
  }
};

window.saveEditor = async function(key, filePath) {
  if (!filePath || !editorContent[key]) return;
  const result = await window.api.writeFile(filePath, editorContent[key]);
  if (result.error) {
    alert('Save failed: ' + result.error);
    return;
  }
  editorDirty[key] = false;
  // Reload project data to reflect changes
  projectData = await window.api.scanProject();
  renderCurrentView();
};

window.showVersions = async function(key, filePath) {
  if (!filePath) return;
  const versions = await window.api.getFileVersions(filePath);
  if (!versions || versions.length === 0) {
    alert('No previous versions found.');
    return;
  }

  // Build version list modal
  const overlay = document.createElement('div');
  overlay.className = 'version-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  const modal = document.createElement('div');
  modal.className = 'version-modal';
  modal.innerHTML = `
    <div class="version-modal-header">
      <h3>Version History</h3>
      <button class="btn btn-ghost btn-sm" onclick="this.closest('.version-overlay').remove()">&times;</button>
    </div>
    <div class="version-list">
      ${versions.map((v, i) => {
        const date = new Date(v.savedAt);
        const timeStr = date.toLocaleString();
        const preview = v.preview.replace(/</g, '&lt;').replace(/\n/g, ' ');
        return `<div class="version-item" onclick="restoreVersion('${key}', '${filePath.replace(/'/g, "\\'")}', ${i})">
          <div class="version-time">${timeStr}</div>
          <div class="version-preview">${preview}...</div>
        </div>`;
      }).join('')}
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
};

window.restoreVersion = async function(key, filePath, versionIndex) {
  if (!confirm('Restore this version? Current content will be saved as a new version.')) return;
  const result = await window.api.restoreFileVersion(filePath, versionIndex);
  if (result.error) {
    alert('Restore failed: ' + result.error);
    return;
  }
  // Close modal
  document.querySelector('.version-overlay')?.remove();
  // Update editor content
  editorContent[key] = result.content;
  editorDirty[key] = false;
  // Reload project data
  projectData = await window.api.scanProject();
  renderCurrentView();
};

/** Re-render the currently active content view (epic-detail or documents) in place.
 * Used after saves or view-mode changes to refresh content without a full view switch.
 */
function renderCurrentView() {
  if (currentView === 'epic-detail') {
    renderEpicDetail();
  } else if (currentView === 'documents') {
    renderDocuments();
    // Re-show active doc if any
    const activeDoc = document.querySelector('.doc-item.active');
    if (activeDoc) activeDoc.click();
  }
}

// Legacy compatibility
window.toggleRawMode = function(key, raw) {
  viewMode[key] = raw ? 'raw' : 'rendered';
  renderEpicDetail();
};

window.launchPhase = async function(phase, storySlug, storyFilePath) {
  // Build the slash command for the phase
  const phaseCommands = {
    'backlog': '/bmad-bmm-create-story',
    'ready-for-dev': '/bmad-bmm-dev-story',
    'in-progress': '/bmad-bmm-dev-story',
    'review': '/bmad-bmm-code-review'
  };

  const slashCmd = phaseCommands[phase];
  if (!slashCmd) return;

  // Build command with story id (e.g. "/bmad-bmm-dev-story 2.5.5")
  let command = slashCmd;
  if (storySlug) {
    const match = storySlug.match(/^(\d+(?:-\d+)+)/);
    if (match) {
      command += ' ' + match[1].replace(/-/g, '.');
    }
  }

  // Check for an existing Claude session for this story+phase
  const existingSessionId = storySlug ? await window.api.getStorySession(storySlug, phase) : null;

  if (existingSessionId) {
    // Resume the previous conversation
    window.sendToTerminal(command, { claudeSessionId: existingSessionId, resume: true, storySlug, storyPhase: phase });
  } else {
    // New session — generate UUID and save it
    const newSessionId = crypto.randomUUID();
    if (storySlug) {
      await window.api.saveStorySession(storySlug, phase, newSessionId);
    }
    window.sendToTerminal(command, { claudeSessionId: newSessionId, storySlug, storyPhase: phase });
  }

  showView('terminal');
};

window.openRetro = function(epicNumber) {
  const epic = projectData.epics.find(e => e.number === epicNumber);
  if (!epic || !epic.retrospective || !epic.retrospective.content) return;

  // Switch to documents view with retro content
  showDocumentReader({
    name: `Epic ${epicNumber} Retrospective`,
    content: epic.retrospective.content
  });
};

// ── Documents View ──────────────────────────────────────────────────────

// ── Key Document Definitions ─────────────────────────────────────────────
// Each key document has: patterns to match existing files, commands to create/edit,
// and display metadata.

const KEY_DOCUMENTS = [
  {
    id: 'prd',
    emoji: '\uD83D\uDCCB',
    title: 'Product Requirements',
    desc: 'PRD defining features, user stories, and acceptance criteria',
    patterns: [/prd/i, /product.?req/i, /product.?requirements/i],
    categories: ['Overview', 'Planning'],
    createCommand: '/bmad-bmm-create-prd',
    editCommand: '/bmad-bmm-edit-prd',
    validateCommand: '/bmad-bmm-validate-prd',
  },
  {
    id: 'architecture',
    emoji: '\u2699\uFE0F',
    title: 'Architecture',
    desc: 'Technical architecture, solution design, and system decisions',
    patterns: [/architect/i, /solution.?design/i, /tech.?design/i],
    categories: ['Overview', 'Implementation'],
    createCommand: '/bmad-bmm-create-architecture',
  },
  {
    id: 'ux',
    emoji: '\uD83C\uDFA8',
    title: 'UX Design',
    desc: 'UX patterns, wireframes, and design specifications',
    patterns: [/ux/i, /user.?experience/i, /design.?spec/i],
    categories: ['Overview', 'Planning', 'Implementation'],
    createCommand: '/bmad-bmm-create-ux-design',
  },
];

const DOC_CATEGORY_META = {
  'Overview':        { emoji: '\uD83D\uDCCB', desc: 'Project overview and context' },
  'Planning':        { emoji: '\uD83D\uDCD0', desc: 'PRD, product briefs, research' },
  'Implementation':  { emoji: '\u2699\uFE0F',  desc: 'Architecture, tech specs, design decisions' },
  'Sprint':          { emoji: '\uD83C\uDFC3',  desc: 'Story specs and sprint artifacts' },
  'Retrospectives':  { emoji: '\uD83C\uDF89',  desc: 'Post-epic reviews and lessons learned' },
};

let activeDocPath = null;

/** Find the first document in the loaded project data that matches a key document definition.
 * Matches on both the document's `category` field and one of the key doc's filename patterns.
 * @param {object} keyDoc - A key document definition from `KEY_DOCUMENTS`.
 * @param {string[]} keyDoc.categories - Accepted document category values.
 * @param {RegExp[]} keyDoc.patterns - Filename patterns to test against `doc.filename` or `doc.name`.
 * @returns {object|null} The matching document object, or `null` if not found.
 */
function findKeyDoc(keyDoc) {
  if (!projectData || !projectData.documents) return null;
  return projectData.documents.find(doc =>
    keyDoc.categories.includes(doc.category) &&
    keyDoc.patterns.some(p => p.test(doc.filename || doc.name))
  );
}

/** Render the card for a key document slot.
 * If the document exists in the project, shows View / Edit / Validate action buttons.
 * If missing, shows a description and a "+ Create" button that launches the BMAD command.
 * @param {object} keyDoc - A key document definition from `KEY_DOCUMENTS`.
 * @returns {string} HTML string for the key document card element.
 */
function renderKeyDocCard(keyDoc) {
  const doc = findKeyDoc(keyDoc);

  if (doc) {
    // Document exists — show card with view + action buttons
    const actionsHtml = [];
    actionsHtml.push(`<button class="btn btn-ghost btn-sm" onclick="viewKeyDocument('${keyDoc.id}')">View</button>`);
    if (keyDoc.editCommand) {
      actionsHtml.push(`<button class="btn btn-ghost btn-sm" onclick="launchDocCommand('${keyDoc.editCommand}')">Edit</button>`);
    }
    if (keyDoc.validateCommand) {
      actionsHtml.push(`<button class="btn btn-ghost btn-sm" onclick="launchDocCommand('${keyDoc.validateCommand}')">Validate</button>`);
    }

    return `
      <div class="key-doc-card key-doc-card--exists" data-doc-id="${keyDoc.id}">
        <div class="key-doc-card-header">
          <span class="key-doc-card-emoji">${keyDoc.emoji}</span>
          <span class="key-doc-card-title">${keyDoc.title}</span>
          <span class="key-doc-card-badge">Found</span>
        </div>
        <div class="key-doc-card-filename">${doc.name}</div>
        <div class="key-doc-card-actions">${actionsHtml.join('')}</div>
      </div>
    `;
  } else {
    // Document missing — placeholder with create button
    return `
      <div class="key-doc-card key-doc-card--missing" data-doc-id="${keyDoc.id}">
        <div class="key-doc-card-header">
          <span class="key-doc-card-emoji">${keyDoc.emoji}</span>
          <span class="key-doc-card-title">${keyDoc.title}</span>
        </div>
        <div class="key-doc-card-desc">${keyDoc.desc}</div>
        <div class="key-doc-card-actions">
          <button class="btn btn-primary btn-sm" onclick="launchDocCommand('${keyDoc.createCommand}')">+ Create</button>
        </div>
      </div>
    `;
  }
}

/** Render the Documents view, including the key document grid, other-document category cards
 * (grouped by category, excluding already-shown key docs), and BMAD resource links.
 * Replaces the entire `#view-party` container HTML.
 */
function renderDocuments() {
  const container = document.getElementById('view-party');
  const hasDocs = projectData && projectData.documents && projectData.documents.length > 0;

  // Key documents section
  const keyDocsHtml = KEY_DOCUMENTS.map(kd => renderKeyDocCard(kd)).join('');

  // Group remaining docs by category (exclude ones already shown as key docs)
  const keyDocFiles = new Set();
  for (const kd of KEY_DOCUMENTS) {
    const doc = findKeyDoc(kd);
    if (doc) keyDocFiles.add(doc.filePath);
  }

  const categories = {};
  if (hasDocs) {
    for (const doc of projectData.documents) {
      if (keyDocFiles.has(doc.filePath)) continue;
      if (!categories[doc.category]) categories[doc.category] = [];
      categories[doc.category].push(doc);
    }
  }

  const hasOtherDocs = Object.keys(categories).length > 0;

  // Other documents as category cards
  const categoryCardsHtml = Object.entries(categories).map(([cat, docs]) => {
    const meta = DOC_CATEGORY_META[cat] || { emoji: '\uD83D\uDCC4', desc: '' };
    return `
      <div class="doc-category-card" onclick="showDocCategory('${cat}')">
        <div class="doc-category-card-emoji">${meta.emoji}</div>
        <div class="doc-category-card-body">
          <div class="doc-category-card-title">${cat}</div>
          <div class="doc-category-card-desc">${meta.desc}</div>
          <div class="doc-category-card-count">${docs.length} document${docs.length !== 1 ? 's' : ''}</div>
        </div>
      </div>
    `;
  }).join('');

  // BMAD resources
  const resourcesHtml = `
    <div class="doc-resources">
      <div class="doc-resources-title">\uD83D\uDCDA BMAD Resources</div>
      <div class="doc-resources-grid">
        <a class="doc-resource-link" onclick="openExternal('https://www.youtube.com/@anthropic-ai')">
          <span class="doc-resource-icon">\uD83C\uDFAC</span>
          <span>BMAD YouTube Channel</span>
        </a>
        <a class="doc-resource-link" onclick="openExternal('https://github.com/bmadcode/BMAD-METHOD')">
          <span class="doc-resource-icon">\uD83D\uDCBB</span>
          <span>BMAD GitHub Repo</span>
        </a>
        <a class="doc-resource-link" onclick="openExternal('https://docs.bmad-method.org/')">
          <span class="doc-resource-icon">\uD83D\uDCD6</span>
          <span>BMAD Documentation</span>
        </a>
      </div>
    </div>
  `;

  container.innerHTML = `
    <div class="view-header">
      <h2>Documents</h2>
      <div class="view-actions">
        <button class="btn btn-ghost btn-sm" onclick="refreshProject()" title="Cmd+R">Refresh</button>
      </div>
    </div>
    <div id="doc-overview" class="doc-overview">
      <div class="key-doc-grid">${keyDocsHtml}</div>
      ${hasOtherDocs ? `
        <div class="doc-section-label">Other Documents</div>
        <div class="doc-category-grid">${categoryCardsHtml}</div>
      ` : ''}
      ${resourcesHtml}
    </div>
    <div id="doc-detail" class="doc-detail" style="display:none">
      <div class="doc-detail-header">
        <button class="btn btn-ghost btn-sm" onclick="backToDocOverview()">&larr; Back</button>
        <h3 id="doc-detail-title"></h3>
      </div>
      <div class="party-container">
        <div class="doc-list" id="doc-detail-list"></div>
        <div class="doc-reader" id="doc-detail-reader">
          <div class="doc-reader-placeholder">
            <p>Select a document to read</p>
          </div>
        </div>
      </div>
    </div>
  `;
  container.classList.add('active');
}

/**
 * Launch a BMAD command in a new terminal tab.
 */
window.launchDocCommand = function(command) {
  window.sendToTerminal(command);
  showView('terminal');
};

/**
 * View a key document in the detail reader.
 */
window.viewKeyDocument = function(keyDocId) {
  const keyDoc = KEY_DOCUMENTS.find(kd => kd.id === keyDocId);
  if (!keyDoc) return;
  const doc = findKeyDoc(keyDoc);
  if (!doc) return;

  document.getElementById('doc-overview').style.display = 'none';
  const detail = document.getElementById('doc-detail');
  detail.style.display = '';

  document.getElementById('doc-detail-title').textContent = `${keyDoc.emoji} ${keyDoc.title}`;

  // Single doc — show it directly in the reader, no list
  const list = document.getElementById('doc-detail-list');
  list.innerHTML = `<div class="doc-item active">${doc.name}</div>`;
  activeDocPath = doc.filePath;
  showDocumentReader(doc);
};

window.showDocCategory = function(category) {
  if (!projectData || !projectData.documents) return;
  const docs = projectData.documents.filter(d => d.category === category);
  const meta = DOC_CATEGORY_META[category] || { emoji: '\uD83D\uDCC4' };

  document.getElementById('doc-overview').style.display = 'none';
  const detail = document.getElementById('doc-detail');
  detail.style.display = '';

  document.getElementById('doc-detail-title').textContent = `${meta.emoji} ${category}`;

  const list = document.getElementById('doc-detail-list');
  list.innerHTML = docs.map(doc => `
    <div class="doc-item" data-path="${doc.filePath.replace(/"/g, '&quot;')}" onclick="selectDocument(this, '${doc.filePath.replace(/'/g, "\\'")}')">${doc.name}</div>
  `).join('');

  // Reset reader
  document.getElementById('doc-detail-reader').innerHTML = `
    <div class="doc-reader-placeholder">
      <p>Select a document to read</p>
    </div>
  `;
  activeDocPath = null;

  // Auto-select first doc
  if (docs.length > 0) {
    const firstItem = list.querySelector('.doc-item');
    if (firstItem) firstItem.click();
  }
};

window.backToDocOverview = function() {
  document.getElementById('doc-overview').style.display = '';
  document.getElementById('doc-detail').style.display = 'none';
  activeDocPath = null;
};

window.selectDocument = function(el, filePath) {
  const doc = projectData.documents.find(d => d.filePath === filePath);
  if (!doc) return;

  activeDocPath = filePath;

  // Highlight active
  document.querySelectorAll('#doc-detail-list .doc-item').forEach(item => item.classList.remove('active'));
  el.classList.add('active');

  showDocumentReader(doc);
};

/** Render the document reader panel for a selected document, respecting the current view
 * mode (rendered / edit / raw) and showing Save / Versions buttons in edit mode.
 * @param {object} doc - Document object from the project data.
 * @param {string} doc.name - Display name of the document.
 * @param {string} doc.content - Raw markdown content.
 * @param {string} [doc.filePath] - Absolute path for save/version operations.
 */
function showDocumentReader(doc) {
  const reader = document.getElementById('doc-detail-reader');
  if (!reader) return;

  const contentKey = `doc-${doc.name}`;
  const mode = viewMode[contentKey] || 'rendered';
  const isDirty = editorDirty[contentKey] || false;
  const escapedFilePath = (doc.filePath || '').replace(/'/g, "\\'");

  let contentHtml;
  if (mode === 'edit') {
    const editText = editorContent[contentKey] !== undefined ? editorContent[contentKey] : doc.content;
    contentHtml = `<div class="doc-reader-content edit-mode">
      <textarea class="md-editor" data-key="${contentKey}" data-filepath="${escapedFilePath}" oninput="onEditorInput('${contentKey}')">${MD.esc(editText)}</textarea>
    </div>`;
  } else if (mode === 'raw') {
    contentHtml = `<div class="doc-reader-content raw">${MD.esc(doc.content)}</div>`;
  } else {
    contentHtml = `<div class="doc-reader-content">${MD.render(doc.content)}</div>`;
  }

  reader.innerHTML = `
    <div class="doc-reader-header">
      <h3>${doc.name}</h3>
      <div style="display:flex;gap:8px;align-items:center">
        ${renderToggleGroup(contentKey, mode, escapedFilePath, 'setDocViewMode')}
        ${mode === 'edit' ? `
          <button class="btn btn-save btn-sm ${isDirty ? '' : 'disabled'}" onclick="event.stopPropagation(); saveDocEditor('${contentKey}', '${escapedFilePath}')" ${isDirty ? '' : 'disabled'}>Save</button>
          <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); showVersions('${contentKey}', '${escapedFilePath}')" title="Version history">Versions</button>
        ` : ''}
      </div>
    </div>
    ${contentHtml}
  `;
}

window.setDocViewMode = function(key, filePath, mode) {
  if (viewMode[key] === 'edit' && mode !== 'edit' && editorDirty[key]) {
    if (!confirm('You have unsaved changes. Discard them?')) return;
    editorDirty[key] = false;
    delete editorContent[key];
  }
  viewMode[key] = mode;
  const doc = projectData.documents.find(d => d.filePath === filePath);
  if (doc) showDocumentReader(doc);
};

window.saveDocEditor = async function(key, filePath) {
  if (!filePath || !editorContent[key]) return;
  const result = await window.api.writeFile(filePath, editorContent[key]);
  if (result.error) {
    alert('Save failed: ' + result.error);
    return;
  }
  editorDirty[key] = false;
  projectData = await window.api.scanProject();
  const doc = projectData.documents.find(d => d.filePath === filePath);
  if (doc) showDocumentReader(doc);
};

window.toggleDocRaw = function(key, filePath, raw) {
  viewMode[key] = raw ? 'raw' : 'rendered';
  const doc = projectData.documents.find(d => d.filePath === filePath);
  if (doc) showDocumentReader(doc);
};

window.openExternal = function(url) {
  window.api.openExternal(url);
};

// ── Party Mode ──────────────────────────────────────────────────────────

/** Render the Party Mode screen with launch instructions and a "Start Retrospective" button. */
function renderPartyMode() {
  const container = document.getElementById('view-party');
  container.innerHTML = `
    <div class="view-header">
      <h2>Party Mode <span class="party-emoji">&#127881;</span></h2>
    </div>
    <div class="party-launch">
      <div class="party-launch-icon">&#127881;</div>
      <h3>Ready for a Retrospective?</h3>
      <p>Launch a terminal session with Claude and the BMAD retrospective workflow.
         Bob the Scrum Master will facilitate the team through the retro process.</p>
      <button class="btn btn-primary" onclick="startPartyMode()">Start Retrospective</button>
      <p style="margin-top: 16px">
        <button class="btn btn-ghost btn-sm" onclick="showView('documents')">Browse Documents Instead</button>
      </p>
    </div>
  `;
  container.classList.add('active');
}

window.startPartyMode = async function() {
  const result = await window.api.launchPartyMode();
  if (result.error) {
    alert(`Failed to launch party mode: ${result.error}`);
  }
};

// ── Project Selector ─────────────────────────────────────────────────────

/** Wire the sidebar `#project-select` dropdown so that choosing a project loads it,
 * refreshes the project list and git state, and navigates to the Epics view (or Welcome on failure).
 */
function setupProjectSelector() {
  const select = document.getElementById('project-select');
  select.addEventListener('change', async (e) => {
    const selectedPath = e.target.value;
    if (!selectedPath) return;

    // Close old project's tabs
    if (typeof window.closeAllTabs === 'function') {
      window.closeAllTabs();
    }

    const data = await window.api.loadProjectByPath(selectedPath);
    if (data && data.found) {
      projectData = data;
      snapshotStoryStates();
      await refreshProjectList();
      await detectGitRepo();
      showView('epics');
      startPhasePoller();
      // Restore new project's saved tabs
      if (typeof window.restoreTabState === 'function') {
        window.restoreTabState();
      }
    } else {
      projectData = null;
      stopPhasePoller();
      await detectGitRepo();
      showView('welcome');
      showWarning('Could not load project — BMAD files not found.');
    }
  });
}

/** Build an HTML `<option>` list for all non-archived projects, marking the currently
 * loaded project as selected.
 * @returns {Promise<string>} HTML string of `<option>` elements ready to inject into a `<select>`.
 */
async function buildProjectOptions() {
  const projects = await window.api.getProjectList();
  const currentPath = await window.api.getProjectPath();
  let html = '';
  for (const proj of projects) {
    if (proj.archived === true) continue;
    const selected = proj.path === currentPath ? ' selected' : '';
    html += `<option value="${proj.path}" title="${proj.path}"${selected}>${proj.name}</option>`;
  }
  return html;
}

/** Wire a project `<select>` embedded in a view header (e.g. Epics) so that selecting a
 * project loads it and navigates to the Epics view, mirroring the sidebar selector.
 * @param {string} selectId - The `id` attribute of the `<select>` element to wire.
 */
function setupInlineProjectSelect(selectId) {
  const select = document.getElementById(selectId);
  if (!select) return;
  select.addEventListener('change', async (e) => {
    const selectedPath = e.target.value;
    if (!selectedPath) return;

    // Close old project's tabs
    if (typeof window.closeAllTabs === 'function') {
      window.closeAllTabs();
    }

    const data = await window.api.loadProjectByPath(selectedPath);
    if (data && data.found) {
      projectData = data;
      snapshotStoryStates();
      await refreshProjectList();
      await detectGitRepo();
      showView('epics');
      startPhasePoller();
      // Restore new project's saved tabs
      if (typeof window.restoreTabState === 'function') {
        window.restoreTabState();
      }
    }
  });
}

/** Rebuild the sidebar `#project-select` dropdown from the current project list, filtering
 * out archived projects and marking the active project as selected.
 * @returns {Promise<void>}
 */
async function refreshProjectList() {
  const select = document.getElementById('project-select');
  const projects = await window.api.getProjectList();
  const currentPath = await window.api.getProjectPath();

  select.innerHTML = '<option value="" disabled>-- Select project --</option>';

  for (const proj of projects) {
    // Filter out archived projects from dropdown
    if (proj.archived === true) continue;
    const opt = document.createElement('option');
    opt.value = proj.path;
    opt.textContent = proj.name;
    opt.title = proj.path;
    if (proj.path === currentPath) opt.selected = true;
    select.appendChild(opt);
  }
}

// ── Settings View ────────────────────────────────────────────────────────

let settingsData = null;

/** Fetch all settings, providers, projects, BMAD config, and app version in parallel, then
 * render the full Settings view into `#settings-content`. Wires Save, BMAD-save, and
 * companion-section event handlers after rendering.
 * @returns {Promise<void>}
 */
async function renderSettings() {
  const container = document.getElementById('settings-content');
  if (!container) return;

  // Load all data in parallel
  const [settings, providers, projects, bmadConfig, bmadManifest, appVersion] = await Promise.all([
    window.api.getSettings(),
    window.api.getProviders(),
    window.api.getProjectList(),
    window.api.readBmadConfig(),
    window.api.readBmadManifest(),
    window.api.getAppVersion()
  ]);

  settingsData = { ...settings };

  const providerOptions = providers.map(p => {
    const locked = !isPro() && p.key !== 'claude';
    return `<option value="${p.key}"${p.key === settings.defaultLlm ? ' selected' : ''}${locked ? ' disabled' : ''}>${p.name}${locked ? ' (Pro)' : ''}</option>`;
  }).join('');

  const reviewOptions = providers.map(p => {
    const locked = !isPro() && p.key !== 'claude';
    return `<option value="${p.key}"${p.key === settings.reviewLlm ? ' selected' : ''}${locked ? ' disabled' : ''}>${p.name}${locked ? ' (Pro)' : ''}</option>`;
  }).join('');

  const llmConfig = settings.llmConfig || {};
  const termSettings = settings.terminal || {};
  const notifSettings = settings.notifications || { toast: true, os: true, sound: false, pollInterval: 30 };

  // Build LLM path configs
  let llmPathsHtml = '';
  for (const p of providers) {
    const cfg = llmConfig[p.key] || {};
    llmPathsHtml += `
      <div class="settings-llm-path">
        <label class="settings-label-sm">${p.name}</label>
        <div class="settings-row">
          <input type="text" class="settings-input" id="llm-binary-${p.key}" value="${cfg.binary || p.key}" placeholder="Binary path">
          <input type="text" class="settings-input" id="llm-args-${p.key}" value="${cfg.extraArgs || ''}" placeholder="Extra arguments">
        </div>
      </div>
    `;
  }

  // Build projects list
  let projectsHtml = '';
  for (const proj of projects) {
    const isArchived = proj.archived === true;
    projectsHtml += `
      <div class="settings-project ${isArchived ? 'archived' : ''}">
        <div class="settings-project-info">
          <span class="settings-project-name">${proj.name}</span>
          ${isArchived ? '<span class="settings-badge archived">Archived</span>' : ''}
          <span class="settings-project-path">${proj.path}</span>
        </div>
        <div class="settings-project-actions">
          <button class="btn btn-ghost btn-sm" onclick="toggleArchiveProject('${proj.path.replace(/'/g, "\\'")}', ${!isArchived})">
            ${isArchived ? 'Unarchive' : 'Archive'}
          </button>
          <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="removeProject('${proj.path.replace(/'/g, "\\'")}')">Remove</button>
        </div>
      </div>
    `;
  }

  // Build BMAD config section
  let bmadHtml = '';
  if (bmadConfig) {
    const editableFields = ['project_name', 'user_name', 'user_skill_level', 'communication_language', 'document_output_language'];
    const readonlyFields = ['output_folder', 'planning_artifacts', 'implementation_artifacts'];

    for (const field of editableFields) {
      if (bmadConfig[field] !== undefined) {
        const val = bmadConfig[field];
        if (field === 'user_skill_level') {
          bmadHtml += `
            <div class="settings-field">
              <label class="settings-label">${formatFieldLabel(field)}</label>
              <select class="settings-input" id="bmad-${field}">
                <option value="beginner"${val === 'beginner' ? ' selected' : ''}>Beginner</option>
                <option value="intermediate"${val === 'intermediate' ? ' selected' : ''}>Intermediate</option>
                <option value="advanced"${val === 'advanced' ? ' selected' : ''}>Advanced</option>
                <option value="expert"${val === 'expert' ? ' selected' : ''}>Expert</option>
              </select>
            </div>
          `;
        } else if (field.includes('language')) {
          bmadHtml += `
            <div class="settings-field">
              <label class="settings-label">${formatFieldLabel(field)}</label>
              <select class="settings-input" id="bmad-${field}">
                <option value="English"${val === 'English' ? ' selected' : ''}>English</option>
                <option value="Nederlands"${val === 'Nederlands' ? ' selected' : ''}>Nederlands</option>
                <option value="Deutsch"${val === 'Deutsch' ? ' selected' : ''}>Deutsch</option>
                <option value="Fran\u00e7ais"${val === 'Fran\u00e7ais' ? ' selected' : ''}>Fran\u00e7ais</option>
                <option value="Espa\u00f1ol"${val === 'Espa\u00f1ol' ? ' selected' : ''}>Espa\u00f1ol</option>
              </select>
            </div>
          `;
        } else {
          bmadHtml += `
            <div class="settings-field">
              <label class="settings-label">${formatFieldLabel(field)}</label>
              <input type="text" class="settings-input" id="bmad-${field}" value="${val}">
            </div>
          `;
        }
      }
    }

    for (const field of readonlyFields) {
      if (bmadConfig[field] !== undefined) {
        bmadHtml += `
          <div class="settings-field">
            <label class="settings-label">${formatFieldLabel(field)}</label>
            <input type="text" class="settings-input readonly" value="${bmadConfig[field]}" readonly title="Read-only (change via BMAD CLI)">
          </div>
        `;
      }
    }
  }

  // BMAD manifest info
  let manifestHtml = '';
  if (bmadManifest) {
    manifestHtml = `
      <div class="settings-manifest">
        ${bmadManifest.version ? `<div class="settings-manifest-item"><span>Version</span><span>${bmadManifest.version}</span></div>` : ''}
        ${bmadManifest.install_date ? `<div class="settings-manifest-item"><span>Installed</span><span>${bmadManifest.install_date}</span></div>` : ''}
        ${bmadManifest.configured_ides ? `<div class="settings-manifest-item"><span>IDEs</span><span>${bmadManifest.configured_ides}</span></div>` : ''}
        ${bmadManifest.loaded_modules ? `<div class="settings-manifest-item"><span>Modules</span><span>${bmadManifest.loaded_modules}</span></div>` : ''}
      </div>
    `;
  }

  container.innerHTML = `
    <div class="settings-sections">
      <!-- LLM Settings -->
      <div class="settings-section">
        <h3 class="settings-section-title">LLM Configuration</h3>
        <div class="settings-field">
          <label class="settings-label">Default LLM</label>
          <select class="settings-input" id="settings-default-llm">${providerOptions}</select>
          <span class="settings-hint">Used for all dev/story terminal tabs</span>
        </div>
        <div class="settings-field">
          <label class="settings-label">Review LLM</label>
          <select class="settings-input" id="settings-review-llm">${reviewOptions}</select>
          <span class="settings-hint">Used for code reviews (ideally a different model for independence)</span>
        </div>
        <h4 class="settings-subsection-title">LLM Paths & Arguments</h4>
        ${llmPathsHtml}
      </div>

      <!-- Terminal Settings -->
      <div class="settings-section">
        <h3 class="settings-section-title">Terminal</h3>
        <div class="settings-field">
          <label class="settings-label">Font Size</label>
          <input type="number" class="settings-input settings-input-sm" id="settings-font-size" value="${termSettings.fontSize || 13}" min="8" max="24">
        </div>
        <div class="settings-field">
          <label class="settings-label">Font Family</label>
          <input type="text" class="settings-input" id="settings-font-family" value="${termSettings.fontFamily || "'JetBrains Mono', 'SF Mono', 'Menlo', 'Consolas', monospace"}">
        </div>
        <div class="settings-field">
          <label class="settings-label">Scrollback Lines</label>
          <input type="number" class="settings-input settings-input-sm" id="settings-scrollback" value="${termSettings.scrollback || 10000}" min="1000" max="100000" step="1000">
        </div>
      </div>

      <!-- Notifications -->
      <div class="settings-section">
        <h3 class="settings-section-title">Notifications</h3>
        <div class="settings-field settings-field-row">
          <label class="settings-label">In-app toast</label>
          <label class="settings-toggle">
            <input type="checkbox" id="settings-notif-toast" ${notifSettings.toast ? 'checked' : ''}>
            <span class="settings-toggle-slider"></span>
          </label>
        </div>
        <div class="settings-field settings-field-row">
          <label class="settings-label">OS notification</label>
          <label class="settings-toggle">
            <input type="checkbox" id="settings-notif-os" ${notifSettings.os ? 'checked' : ''}>
            <span class="settings-toggle-slider"></span>
          </label>
        </div>
        <div class="settings-field settings-field-row">
          <label class="settings-label">Sound</label>
          <label class="settings-toggle">
            <input type="checkbox" id="settings-notif-sound" ${notifSettings.sound ? 'checked' : ''}>
            <span class="settings-toggle-slider"></span>
          </label>
        </div>
        <div class="settings-field">
          <label class="settings-label">Poll interval (seconds)</label>
          <input type="number" class="settings-input settings-input-sm" id="settings-notif-poll" value="${notifSettings.pollInterval || 30}" min="5" max="300" step="5">
        </div>
      </div>

      <!-- Git -->
      <div class="settings-section">
        <h3 class="settings-section-title">Git</h3>
        <div class="settings-field">
          <label class="settings-label">Auto-fetch interval</label>
          <select class="settings-select" id="settings-git-auto-fetch">
            ${[
              { value: '0', label: 'Off' },
              { value: '1', label: 'Every 1 minute' },
              { value: '5', label: 'Every 5 minutes' },
              { value: '15', label: 'Every 15 minutes' },
              { value: '60', label: 'Every 60 minutes' }
            ].map(o =>
              `<option value="${o.value}" ${o.value === String(settings.git?.autoFetchInterval ?? 5) ? 'selected' : ''}>${o.label}</option>`
            ).join('')}
          </select>
        </div>
        <div class="settings-field">
          <label class="settings-label">Merge tool</label>
          <select class="settings-select" id="settings-git-merge-tool">
            ${['default', 'vscode', 'webstorm', 'opendiff', 'meld', 'kdiff3', 'vimdiff'].map(t =>
              `<option value="${t}" ${t === (settings.git?.mergeTool || 'default') ? 'selected' : ''}>${t === 'default' ? 'Default (git mergetool)' : t}</option>`
            ).join('')}
          </select>
        </div>
      </div>

      <!-- Mobile Companion -->
      <div class="settings-section">
        <h3 class="settings-section-title">Mobile Companion</h3>
        <p class="settings-hint" style="margin-bottom:12px">Access your BMAD Board from your phone. Open the URL below or scan the QR code.</p>
        <div id="companion-section">
          <p class="settings-hint">Loading...</p>
        </div>
      </div>

      <!-- Sync Providers -->
      <div class="settings-section">
        <h3 class="settings-section-title">Sync Providers</h3>
        <p class="settings-hint" style="margin-bottom:12px">Sync your epics, stories and documents to Notion, Obsidian or Linear.</p>
        <div id="sync-section">
          <p class="settings-hint">Loading...</p>
        </div>
      </div>

      <!-- Projects -->
      <div class="settings-section">
        <h3 class="settings-section-title">Projects</h3>
        <div class="settings-projects-list">
          ${projectsHtml || '<p class="settings-hint">No projects added yet. Use "Open Project" to add one.</p>'}
        </div>
      </div>

      ${bmadConfig ? `
      <!-- BMAD Config -->
      <div class="settings-section">
        <h3 class="settings-section-title">BMAD Configuration</h3>
        ${manifestHtml}
        ${bmadHtml}
        <button class="btn btn-primary btn-sm" id="btn-save-bmad" disabled>Save BMAD Config</button>
      </div>
      ` : ''}

      <!-- License -->
      <div class="settings-section">
        <h3 class="settings-section-title">License</h3>
        ${isPro() && licenseStatus.trial ? `
          <div class="upgrade-trial-banner">
            <span>&#9889;</span>
            <span>Pro Trial — ${licenseStatus.trialDaysLeft} day${licenseStatus.trialDaysLeft !== 1 ? 's' : ''} remaining</span>
          </div>
          <p class="settings-hint" style="margin-top:8px">Subscribe to keep Pro features after your trial ends.</p>
          <button class="btn btn-primary btn-sm" id="btn-upgrade-from-settings" style="margin-top:8px">Subscribe to Pro</button>
        ` : isPro() ? `
          <div class="settings-manifest">
            <div class="settings-manifest-item"><span>Status</span><span style="color:#22c55e">&#10003; BMAD Board Pro</span></div>
            ${licenseStatus.plan ? `<div class="settings-manifest-item"><span>Plan</span><span>${licenseStatus.plan}</span></div>` : ''}
            ${licenseStatus.customerEmail ? `<div class="settings-manifest-item"><span>Email</span><span>${licenseStatus.customerEmail}</span></div>` : ''}
          </div>
          <button class="btn btn-ghost btn-sm" id="btn-deactivate-license" style="color:var(--danger);margin-top:8px">Deactivate License</button>
        ` : `
          <p class="settings-hint">You're using the free version. Upgrade to unlock Git integration, multi-tab terminal, and more.</p>
          <button class="btn btn-primary btn-sm" id="btn-upgrade-from-settings" style="margin-top:8px">Upgrade to Pro</button>
        `}
      </div>

      <!-- About -->
      <div class="settings-section">
        <h3 class="settings-section-title">About</h3>
        <div class="settings-manifest">
          <div class="settings-manifest-item"><span>BMAD Board</span><span>v${appVersion || '?'}</span></div>
        </div>
      </div>

      <!-- Save Button -->
      <div class="settings-actions">
        <button class="btn btn-primary" id="btn-save-settings">Save Settings</button>
        <span class="settings-save-status" id="settings-save-status"></span>
      </div>
    </div>
  `;

  // Wire save button
  document.getElementById('btn-save-settings').addEventListener('click', saveSettingsFromForm);

  // Wire BMAD save button
  const bmadSaveBtn = document.getElementById('btn-save-bmad');
  if (bmadSaveBtn) {
    // Enable on any change
    const bmadInputs = container.querySelectorAll('[id^="bmad-"]');
    bmadInputs.forEach(input => {
      input.addEventListener('change', () => bmadSaveBtn.disabled = false);
      input.addEventListener('input', () => bmadSaveBtn.disabled = false);
    });
    bmadSaveBtn.addEventListener('click', saveBmadConfigFromForm);
  }

  // Wire license buttons
  const upgradeBtn = document.getElementById('btn-upgrade-from-settings');
  if (upgradeBtn) {
    upgradeBtn.addEventListener('click', () => showUpgradeModal());
  }
  const deactivateBtn = document.getElementById('btn-deactivate-license');
  if (deactivateBtn) {
    deactivateBtn.addEventListener('click', async () => {
      if (!confirm('Deactivate your Pro license on this machine?')) return;
      await window.api.deactivateLicense();
      licenseStatus = await window.api.getLicenseStatus();
      updateProBadges();
      renderSettings();
      showToast('License deactivated', 'info');
    });
  }

  // Render companion section
  renderCompanionSection();

  // Render sync section
  renderSyncSection();
}

/** Fetch companion server info and render the mobile companion sub-section inside
 * `#companion-section`. Shows an enable toggle when the server is off, or a QR code,
 * connection URL, copy button, and token-regeneration button when running.
 * @returns {Promise<void>}
 */
async function renderCompanionSection() {
  const section = document.getElementById('companion-section');
  if (!section) return;

  try {
    const info = await window.api.getCompanionInfo();
    if (!info.enabled) {
      section.innerHTML = `
        <div class="settings-field settings-field-row">
          <label class="settings-label">Enable companion server</label>
          <label class="settings-toggle">
            <input type="checkbox" id="companion-toggle">
            <span class="settings-toggle-slider"></span>
          </label>
        </div>
      `;
      document.getElementById('companion-toggle').addEventListener('change', async (e) => {
        await window.api.toggleCompanion(e.target.checked);
        renderCompanionSection();
      });
      return;
    }

    const url = info.urls && info.urls[0] ? info.urls[0] : `http://localhost:${info.port}?token=${info.token}`;

    // Generate QR code as SVG using a minimal inline generator
    const qrSvg = generateQRPlaceholder(url);

    section.innerHTML = `
      <div class="settings-field settings-field-row">
        <label class="settings-label">Companion server</label>
        <label class="settings-toggle">
          <input type="checkbox" id="companion-toggle" checked>
          <span class="settings-toggle-slider"></span>
        </label>
      </div>
      <div class="companion-info">
        <div class="companion-qr" id="companion-qr">
          ${qrSvg}
        </div>
        <div class="companion-details">
          <div class="companion-url-group">
            <label class="settings-label-sm">Connection URL</label>
            <div class="companion-url-row">
              <input type="text" class="settings-input settings-input-readonly" id="companion-url" value="${url}" readonly>
              <button class="btn btn-ghost btn-sm" id="btn-copy-url" title="Copy URL">Copy</button>
            </div>
          </div>
          <div class="companion-meta">
            <span class="settings-hint">Port: ${info.port}</span>
            ${info.addresses ? `<span class="settings-hint">IP: ${info.addresses.join(', ')}</span>` : ''}
            <span class="settings-hint">Clients can connect on the same WiFi network</span>
          </div>
          <button class="btn btn-ghost btn-sm" id="btn-regen-token" style="margin-top:8px">Regenerate Token</button>
        </div>
      </div>
    `;

    document.getElementById('companion-toggle').addEventListener('change', async (e) => {
      await window.api.toggleCompanion(e.target.checked);
      renderCompanionSection();
    });

    document.getElementById('btn-copy-url').addEventListener('click', () => {
      navigator.clipboard.writeText(url).then(() => {
        const btn = document.getElementById('btn-copy-url');
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
      });
    });

    document.getElementById('btn-regen-token').addEventListener('click', async () => {
      await window.api.regenerateCompanionToken();
      renderCompanionSection();
    });

  } catch (err) {
    section.innerHTML = `<p class="settings-hint" style="color:var(--danger)">Failed to load companion info</p>`;
  }
}

async function renderSyncSection() {
  const section = document.getElementById('sync-section');
  if (!section) return;

  try {
    const [providers, status] = await Promise.all([
      window.api.syncListProviders(),
      window.api.syncStatus()
    ]);

    const currentProvider = status.provider || '';
    const isConfigured = status.configured;

    section.innerHTML = `
      <div class="settings-field settings-field-row">
        <label class="settings-label">Provider</label>
        <select class="settings-select" id="sync-provider">
          <option value="">— Select —</option>
          ${providers.map(p => `<option value="${p.key}" ${p.key === currentProvider ? 'selected' : ''}>${p.name}</option>`).join('')}
        </select>
      </div>
      <div id="sync-config-fields"></div>
      <div id="sync-actions" style="margin-top:12px">
        ${isConfigured ? `
          <div class="sync-status-bar">
            <span class="sync-status-badge sync-status-${isConfigured ? 'connected' : 'disconnected'}">
              ${isConfigured ? 'Configured' : 'Not configured'}
            </span>
            ${status.lastFullSync ? `<span class="settings-hint">Last sync: ${new Date(status.lastFullSync).toLocaleString()}</span>` : ''}
            ${status.counts ? `<span class="settings-hint">Synced: ${status.counts.epics} epics, ${status.counts.stories} stories, ${status.counts.documents} docs</span>` : ''}
          </div>
          <div style="display:flex;gap:8px;margin-top:8px">
            <button class="btn btn-primary btn-sm" id="btn-sync-push">Push to ${providers.find(p => p.key === currentProvider)?.name || 'Remote'}</button>
            <button class="btn btn-ghost btn-sm" id="btn-sync-pull">Pull from Remote</button>
            <button class="btn btn-ghost btn-sm" id="btn-sync-full">Full Sync</button>
            <button class="btn btn-ghost btn-sm" id="btn-sync-test">Test Connection</button>
          </div>
          <div id="sync-result" style="margin-top:8px"></div>
        ` : ''}
      </div>
    `;

    // Render config fields for selected provider
    const renderConfigFields = (providerKey) => {
      const fieldsContainer = document.getElementById('sync-config-fields');
      const provider = providers.find(p => p.key === providerKey);
      if (!provider || !provider.configFields) {
        fieldsContainer.innerHTML = '';
        return;
      }
      const existingConfig = status.config || {};
      fieldsContainer.innerHTML = provider.configFields.map(f => `
        <div class="settings-field settings-field-row">
          <label class="settings-label">${f.label}</label>
          <input type="${f.type === 'password' ? 'password' : 'text'}"
                 class="settings-input" id="sync-cfg-${f.key}"
                 value="${existingConfig[f.key] && f.type !== 'password' ? existingConfig[f.key] : ''}"
                 placeholder="${f.hint || ''}" />
        </div>
      `).join('') + `
        <div style="margin-top:8px">
          <button class="btn btn-primary btn-sm" id="btn-sync-configure">Save & Configure</button>
          <button class="btn btn-ghost btn-sm" id="btn-sync-setup">Setup Remote</button>
          <span id="sync-configure-status" class="settings-save-status"></span>
        </div>
      `;

      document.getElementById('btn-sync-configure')?.addEventListener('click', async () => {
        const config = {};
        for (const f of provider.configFields) {
          const input = document.getElementById(\`sync-cfg-\${f.key}\`);
          if (input && input.value) config[f.key] = input.value;
        }
        const statusEl = document.getElementById('sync-configure-status');
        try {
          await window.api.syncConfigure(providerKey, config);
          statusEl.textContent = 'Saved!';
          statusEl.style.color = 'var(--success)';
          setTimeout(() => renderSyncSection(), 1000);
        } catch (err) {
          statusEl.textContent = err.message;
          statusEl.style.color = 'var(--danger)';
        }
      });

      document.getElementById('btn-sync-setup')?.addEventListener('click', async () => {
        const statusEl = document.getElementById('sync-configure-status');
        try {
          statusEl.textContent = 'Setting up...';
          statusEl.style.color = 'var(--text-secondary)';
          const result = await window.api.syncSetup();
          statusEl.textContent = 'Remote setup complete!';
          statusEl.style.color = 'var(--success)';
          setTimeout(() => renderSyncSection(), 1500);
        } catch (err) {
          statusEl.textContent = err.message;
          statusEl.style.color = 'var(--danger)';
        }
      });
    };

    if (currentProvider) renderConfigFields(currentProvider);

    document.getElementById('sync-provider').addEventListener('change', (e) => {
      renderConfigFields(e.target.value);
    });

    // Sync action buttons
    const wireBtn = (id, action) => {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.addEventListener('click', async () => {
        const resultEl = document.getElementById('sync-result');
        btn.disabled = true;
        resultEl.innerHTML = '<span class="settings-hint">Syncing...</span>';
        try {
          const result = await action();
          const msg = result.errors?.length
            ? `<span style="color:var(--danger)">${result.errors.join(', ')}</span>`
            : `<span style="color:var(--success)">Done! Pushed: ${result.pushed || 0}, Pulled: ${result.pulled || 0}${result.conflicts?.length ? `, Conflicts: ${result.conflicts.length}` : ''}</span>`;
          resultEl.innerHTML = msg;
          setTimeout(() => renderSyncSection(), 3000);
        } catch (err) {
          resultEl.innerHTML = \`<span style="color:var(--danger)">\${err.message}</span>\`;
        }
        btn.disabled = false;
      });
    };

    wireBtn('btn-sync-push', () => window.api.syncPush());
    wireBtn('btn-sync-pull', () => window.api.syncPull());
    wireBtn('btn-sync-full', () => window.api.syncAll());

    document.getElementById('btn-sync-test')?.addEventListener('click', async () => {
      const resultEl = document.getElementById('sync-result');
      try {
        const res = await window.api.syncTestConnection();
        resultEl.innerHTML = res.ok
          ? \`<span style="color:var(--success)">\${res.message}</span>\`
          : \`<span style="color:var(--danger)">\${res.message}</span>\`;
      } catch (err) {
        resultEl.innerHTML = \`<span style="color:var(--danger)">\${err.message}</span>\`;
      }
    });

  } catch (err) {
    section.innerHTML = \`<p class="settings-hint" style="color:var(--danger)">Failed to load sync providers</p>\`;
  }
}

/**
 * Generate a QR code for the given URL using a minimal inline generator.
 * Falls back to a visual placeholder if generation fails.
 */
function generateQRPlaceholder(url) {
  // Minimal QR code generator — produces a data matrix as a table of modules.
  // Uses alphanumeric mode with error correction level L for short URLs.
  // For a robust QR, consider a library; this covers typical companion URLs.
  try {
    const modules = generateQRMatrix(url);
    if (modules && modules.length > 0) {
      const size = modules.length;
      const scale = Math.max(2, Math.floor(160 / size));
      const totalSize = size * scale;
      let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalSize}" height="${totalSize}" viewBox="0 0 ${size} ${size}" style="border-radius:8px;background:white;padding:4px">`;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (modules[y][x]) {
            svg += `<rect x="${x}" y="${y}" width="1" height="1" fill="#0f0f23"/>`;
          }
        }
      }
      svg += '</svg>';
      return svg;
    }
  } catch {}

  // Fallback: copy-only instructions (no misleading QR visual)
  return `
    <div style="width:160px;height:160px;background:white;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-direction:column;padding:12px;text-align:center">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#0f0f23" stroke-width="1.5">
        <rect x="9" y="9" width="13" height="13" rx="2"/>
        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
      </svg>
      <span style="color:#0f0f23;font-size:10px;margin-top:8px">Copy the URL below<br>and open on your phone</span>
    </div>
  `;
}

/**
 * QR code matrix generator supporting versions 1-6, ECC-L, byte mode.
 * Automatically selects the smallest version that fits the data.
 * Returns a 2D boolean array of modules or null on failure.
 */
function generateQRMatrix(text) {
  const data = new TextEncoder().encode(text);

  // Version table: [size, totalDataCW, ecCW, alignmentCenters[]]
  const VERSIONS = [
    null, // index 0 unused
    [21, 26, 7,  []],          // V1: 19 data bytes
    [25, 44, 10, [18]],        // V2: 34 data bytes
    [29, 70, 15, [22]],        // V3: 55 data bytes
    [33, 100, 20, [26]],       // V4: 80 data bytes
    [37, 134, 26, [30]],       // V5: 108 data bytes
    [41, 172, 36, [34]],       // V6: 136 data bytes
  ];

  // Pre-computed format info strings (ECC-L + mask 0, BCH encoded + XOR mask)
  const FORMAT_BITS = '111011111000100';

  // Find smallest version that fits
  let version = null;
  for (let v = 1; v <= 6; v++) {
    const [, totalCW, ecCW] = VERSIONS[v];
    const dataCW = totalCW - ecCW;
    // Byte mode overhead: 4 bits mode + 8 bits count (v1-9) = 12 bits = 1.5 bytes
    // Available payload = dataCW - 2 (mode+count overhead rounded up)
    const countBits = v <= 9 ? 8 : 16;
    const overhead = Math.ceil((4 + countBits) / 8);
    if (data.length <= dataCW - overhead) {
      version = v;
      break;
    }
  }
  if (!version) return null;

  const [size, totalDataCW, ecCW, alignCenters] = VERSIONS[version];
  const dataCW = totalDataCW - ecCW;

  // Build data bitstream: mode(4) + count(8) + data + terminator + padding
  let bits = '';
  bits += '0100'; // Byte mode indicator
  bits += data.length.toString(2).padStart(8, '0');
  for (const b of data) bits += b.toString(2).padStart(8, '0');
  // Terminator (up to 4 bits, don't exceed capacity)
  const terminatorLen = Math.min(4, dataCW * 8 - bits.length);
  bits += '0'.repeat(terminatorLen);
  while (bits.length % 8 !== 0) bits += '0';
  while (bits.length < dataCW * 8) {
    bits += '11101100';
    if (bits.length < dataCW * 8) bits += '00010001';
  }

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    codewords.push(parseInt(bits.slice(i, i + 8), 2));
  }

  // Reed-Solomon error correction
  const ec = reedSolomon(codewords, ecCW);
  const allCW = [...codewords, ...ec];

  // Initialize module grid
  const grid = Array.from({ length: size }, () => Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => Array(size).fill(false));

  // Place finder patterns (3 corners)
  qrPlaceFinder(grid, reserved, 0, 0, size);
  qrPlaceFinder(grid, reserved, size - 7, 0, size);
  qrPlaceFinder(grid, reserved, 0, size - 7, size);

  // Place alignment patterns (skip if overlapping finder)
  if (alignCenters.length > 0) {
    const positions = [6, ...alignCenters];
    for (const r of positions) {
      for (const c of positions) {
        // Skip if overlapping finder patterns
        if (r <= 8 && c <= 8) continue;
        if (r <= 8 && c >= size - 8) continue;
        if (r >= size - 8 && c <= 8) continue;
        qrPlaceAlignment(grid, reserved, r, c);
      }
    }
  }

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    if (!reserved[6][i]) { grid[6][i] = i % 2 === 0; reserved[6][i] = true; }
    if (!reserved[i][6]) { grid[i][6] = i % 2 === 0; reserved[i][6] = true; }
  }

  // Dark module + reserved format info areas
  grid[size - 8][8] = true; reserved[size - 8][8] = true;
  qrReserveFormatArea(reserved, size);

  // Version info (only for version >= 7, not needed here)

  // Place data bits
  qrPlaceData(grid, reserved, allCW, size);

  // Apply mask 0 (checkerboard: (row + col) % 2 === 0)
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!reserved[r][c]) {
        if ((r + c) % 2 === 0) grid[r][c] = !grid[r][c];
      }
    }
  }

  // Place format info (ECC-L + mask 0)
  qrPlaceFormatInfo(grid, FORMAT_BITS, size);

  return grid;
}

/** Place a 7×7 finder pattern (plus 1-module quiet separator) at a given corner of the QR grid.
 * @param {boolean[][]} grid - Module grid to write into.
 * @param {boolean[][]} reserved - Parallel grid tracking reserved (non-data) positions.
 * @param {number} row - Top-left row of the finder pattern.
 * @param {number} col - Top-left column of the finder pattern.
 * @param {number} size - Total grid size (used for bounds checking).
 */
function qrPlaceFinder(grid, reserved, row, col, size) {
  const pattern = [
    [1,1,1,1,1,1,1],
    [1,0,0,0,0,0,1],
    [1,0,1,1,1,0,1],
    [1,0,1,1,1,0,1],
    [1,0,1,1,1,0,1],
    [1,0,0,0,0,0,1],
    [1,1,1,1,1,1,1]
  ];
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const gr = row + r, gc = col + c;
      if (gr < 0 || gr >= size || gc < 0 || gc >= size) continue;
      if (r >= 0 && r < 7 && c >= 0 && c < 7) {
        grid[gr][gc] = !!pattern[r][c];
      } else {
        grid[gr][gc] = false;
      }
      reserved[gr][gc] = true;
    }
  }
}

/** Place a 5×5 alignment pattern centered at the given cell.
 * @param {boolean[][]} grid - Module grid to write into.
 * @param {boolean[][]} reserved - Parallel reserved-positions grid.
 * @param {number} centerR - Center row of the alignment pattern.
 * @param {number} centerC - Center column of the alignment pattern.
 */
function qrPlaceAlignment(grid, reserved, centerR, centerC) {
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const gr = centerR + r, gc = centerC + c;
      grid[gr][gc] = Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0);
      reserved[gr][gc] = true;
    }
  }
}

/** Mark the format information areas (around finder patterns) as reserved in the grid.
 * @param {boolean[][]} reserved - Parallel reserved-positions grid to update.
 * @param {number} size - Total grid size.
 */
function qrReserveFormatArea(reserved, size) {
  for (let i = 0; i < 8; i++) {
    reserved[8][i] = true; reserved[8][size - 1 - i] = true;
    reserved[i][8] = true; reserved[size - 1 - i][8] = true;
  }
  reserved[8][8] = true;
}

/** Write the 15-bit format information string into both format info regions of the QR grid.
 * @param {boolean[][]} grid - Module grid to write into.
 * @param {string} bits - 15-character binary string (e.g. `FORMAT_BITS`).
 * @param {number} size - Total grid size.
 */
function qrPlaceFormatInfo(grid, bits, size) {
  const p1 = [[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
  const p2 = [[size-1,8],[size-2,8],[size-3,8],[size-4,8],[size-5,8],[size-6,8],[size-7,8],[8,size-8],[8,size-7],[8,size-6],[8,size-5],[8,size-4],[8,size-3],[8,size-2],[8,size-1]];
  for (let i = 0; i < 15; i++) {
    const bit = bits[i] === '1';
    grid[p1[i][0]][p1[i][1]] = bit;
    grid[p2[i][0]][p2[i][1]] = bit;
  }
}

/** Write data and error-correction codeword bits into the QR module grid using the
 * standard two-column upward/downward zigzag placement order, skipping reserved cells.
 * @param {boolean[][]} grid - Module grid to write into.
 * @param {boolean[][]} reserved - Parallel reserved-positions grid.
 * @param {number[]|Uint8Array} codewords - Combined data + EC codeword bytes.
 * @param {number} size - Total grid size.
 */
function qrPlaceData(grid, reserved, codewords, size) {
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  let col = size - 1;
  let goingUp = true;

  while (col >= 0) {
    if (col === 6) col--;
    const rows = goingUp
      ? Array.from({ length: size }, (_, i) => size - 1 - i)
      : Array.from({ length: size }, (_, i) => i);
    for (const row of rows) {
      for (const dc of [0, -1]) {
        const c = col + dc;
        if (c < 0 || reserved[row][c]) continue;
        if (bitIdx < totalBits) {
          const byteIdx = Math.floor(bitIdx / 8);
          const bitPos = 7 - (bitIdx % 8);
          grid[row][c] = !!((codewords[byteIdx] >> bitPos) & 1);
          bitIdx++;
        } else {
          grid[row][c] = false;
        }
      }
    }
    col -= 2;
    goingUp = !goingUp;
  }
}

/** Compute Reed-Solomon error correction codewords for a data block using GF(256)
 * arithmetic with the QR code generator polynomial.
 * @param {number[]} data - Data codeword byte values.
 * @param {number} ecCount - Number of error correction codewords to generate.
 * @returns {Uint8Array} Array of `ecCount` error correction codeword bytes.
 */
function reedSolomon(data, ecCount) {
  const gfExp = new Uint8Array(512);
  const gfLog = new Uint8Array(256);
  let v = 1;
  for (let i = 0; i < 255; i++) {
    gfExp[i] = v;
    gfLog[v] = i;
    v <<= 1;
    if (v >= 256) v ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) gfExp[i] = gfExp[i - 255];

  const gfMul = (a, b) => (a === 0 || b === 0) ? 0 : gfExp[gfLog[a] + gfLog[b]];

  let gen = [1];
  for (let i = 0; i < ecCount; i++) {
    const newGen = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      newGen[j] ^= gen[j];
      newGen[j + 1] ^= gfMul(gen[j], gfExp[i]);
    }
    gen = newGen;
  }

  const result = new Uint8Array(ecCount);
  const msg = [...data, ...result];
  for (let i = 0; i < data.length; i++) {
    const coef = msg[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        msg[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  return msg.slice(data.length);
}

/** Read all settings form fields, merge in the existing companion state to avoid
 * overwriting it, persist via `window.api.saveSettings`, restart the phase poller and
 * git auto-fetch timer with new intervals, then flash a "Saved!" status message.
 * @returns {Promise<void>}
 */
async function saveSettingsFromForm() {
  const providers = await window.api.getProviders();
  const llmConfig = {};
  for (const p of providers) {
    llmConfig[p.key] = {
      binary: document.getElementById(`llm-binary-${p.key}`)?.value || p.key,
      extraArgs: document.getElementById(`llm-args-${p.key}`)?.value || ''
    };
  }

  // Preserve existing companion state so it isn't overwritten
  const existingSettings = await window.api.getSettings();

  const settings = {
    defaultLlm: document.getElementById('settings-default-llm')?.value || 'claude',
    reviewLlm: document.getElementById('settings-review-llm')?.value || 'claude',
    llmConfig,
    terminal: {
      fontSize: parseInt(document.getElementById('settings-font-size')?.value) || 13,
      fontFamily: document.getElementById('settings-font-family')?.value || "'JetBrains Mono', monospace",
      scrollback: parseInt(document.getElementById('settings-scrollback')?.value) || 10000
    },
    notifications: {
      toast: document.getElementById('settings-notif-toast')?.checked ?? true,
      os: document.getElementById('settings-notif-os')?.checked ?? true,
      sound: document.getElementById('settings-notif-sound')?.checked ?? false,
      pollInterval: parseInt(document.getElementById('settings-notif-poll')?.value) || 30
    }
  };

  // Git settings
  const mergeTool = document.getElementById('settings-git-merge-tool')?.value;
  const autoFetchInterval = parseInt(document.getElementById('settings-git-auto-fetch')?.value ?? '5');
  settings.git = {
    mergeTool: mergeTool || 'default',
    autoFetchInterval
  };

  // Merge companion state from existing settings
  if (existingSettings?.companion) {
    settings.companion = existingSettings.companion;
  }

  await window.api.saveSettings(settings);

  // Restart pollers with new intervals
  startPhasePoller();
  startGitAutoFetch();

  const status = document.getElementById('settings-save-status');
  if (status) {
    status.textContent = 'Saved!';
    status.style.color = 'var(--success)';
    setTimeout(() => { status.textContent = ''; }, 2000);
  }
}

/** Read the editable BMAD config fields from the settings form and persist them via
 * `window.api.writeBmadConfig`. Updates the Save button label to "Saved!" on success
 * or shows an error message on failure.
 * @returns {Promise<void>}
 */
async function saveBmadConfigFromForm() {
  const fields = ['project_name', 'user_name', 'user_skill_level', 'communication_language', 'document_output_language'];
  const updates = {};
  for (const field of fields) {
    const el = document.getElementById(`bmad-${field}`);
    if (el) updates[field] = el.value;
  }

  const result = await window.api.writeBmadConfig(updates);
  const btn = document.getElementById('btn-save-bmad');
  if (result.success) {
    btn.disabled = true;
    btn.textContent = 'Saved!';
    setTimeout(() => { btn.textContent = 'Save BMAD Config'; }, 2000);
  } else {
    btn.textContent = 'Error: ' + (result.error || 'Unknown');
    setTimeout(() => { btn.textContent = 'Save BMAD Config'; }, 3000);
  }
}

/** Convert a snake_case field name to a title-cased human-readable label.
 * @param {string} field - Snake_case field name (e.g. `"user_skill_level"`).
 * @returns {string} Title-cased label (e.g. `"User Skill Level"`).
 */
function formatFieldLabel(field) {
  return field.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

window.toggleArchiveProject = async function(projectPath, archive) {
  if (archive) {
    await window.api.archiveProject(projectPath);
  } else {
    await window.api.unarchiveProject(projectPath);
  }
  renderSettings();
};

window.removeProject = async function(projectPath) {
  await window.api.removeProjectFromList(projectPath);
  await refreshProjectList();
  renderSettings();
};

// ── Helpers ──────────────────────────────────────────────────────────────

// Expose for inline onclick handlers
window.openProject = openProject;
window.refreshProject = refreshProject;
window.showView = showView;
