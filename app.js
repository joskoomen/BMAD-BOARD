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

// ── Phase Config (mirror of lib/phase-commands.js for renderer) ─────────

const PHASES = {
  'backlog':       { label: 'Backlog',     icon: '○' },
  'ready-for-dev': { label: 'Ready',       icon: '◐' },
  'in-progress':   { label: 'In Progress', icon: '◑' },
  'review':        { label: 'Review',      icon: '◕' },
  'done':          { label: 'Done',        icon: '●' }
};

const PHASE_ORDER = ['backlog', 'ready-for-dev', 'in-progress', 'review', 'done'];

// ── Init ────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  setupNavigation();
  setupKeyboardShortcuts();
  setupProjectSelector();
  setupSplitResize();
  setupToastContainer();

  // Try loading last project
  const data = await window.api.loadLastProject();
  if (data && data.found) {
    projectData = data;
    snapshotStoryStates();
    await refreshProjectList();
    showView('epics');
    startPhasePoller();
  } else {
    await refreshProjectList();
    showView('welcome');
  }
});

// ── Split Pane Resize ────────────────────────────────────────────────────

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
        sv('history');
      } else if (view === 'settings') {
        sv('settings');
      } else if (view === 'terminal') {
        sv('terminal');
      }
    });
  });

  document.getElementById('btn-add-epic').addEventListener('click', openProject);
}

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
      window.api.newWindow();
    }
  });

  // Cmd+, = Settings (from menu)
  window.api.onShowSettings(() => {
    showView('settings');
  });
}

async function openProject() {
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
  showView('epics');
  startPhasePoller();
}

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

// ── Toast Notifications ─────────────────────────────────────────────────

function setupToastContainer() {
  if (document.getElementById('toast-container')) return;
  const container = document.createElement('div');
  container.id = 'toast-container';
  document.body.appendChild(container);
}

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

function snapshotStoryStates() {
  previousStoryStates = {};
  if (!projectData || !projectData.epics) return;
  for (const epic of projectData.epics) {
    for (const story of (epic.stories || [])) {
      previousStoryStates[story.slug] = story.status;
    }
  }
}

async function getNotificationSettings() {
  const settings = await window.api.getSettings();
  return settings.notifications || { toast: true, os: true, sound: false, pollInterval: 30 };
}

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

function startPhasePoller() {
  stopPhasePoller();
  getNotificationSettings().then(settings => {
    const interval = (settings.pollInterval || 30) * 1000;
    pollTimer = setInterval(pollForPhaseChanges, interval);
  });
}

function stopPhasePoller() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ── View Router ─────────────────────────────────────────────────────────

window.showView = showView;
function showView(view) {
  currentView = view;

  // Hide all views in split-top
  document.querySelectorAll('#split-top .view').forEach(v => v.classList.remove('active'));

  // Update nav
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  // Terminal-only mode: hide top pane + handle, let bottom fill the space
  const splitTop = document.getElementById('split-top');
  const splitHandle = document.getElementById('split-handle');
  const splitBottom = document.getElementById('split-bottom');
  if (view === 'terminal') {
    if (splitTop) splitTop.style.display = 'none';
    if (splitHandle) splitHandle.style.display = 'none';
    if (splitBottom) splitBottom.style.flex = '1';
  } else {
    if (splitTop) splitTop.style.display = '';
    if (splitHandle) splitHandle.style.display = '';
    if (splitBottom) splitBottom.style.flex = '';
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
    case 'settings':
      document.querySelector('[data-view="settings"]')?.classList.add('active');
      document.getElementById('view-settings')?.classList.add('active');
      renderSettings();
      break;
  }
}

// ── Welcome Screen ──────────────────────────────────────────────────────

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

function showWarning(message) {
  const el = document.getElementById('welcome-warning');
  if (el) {
    el.innerHTML = `<div class="warning-box">${message}</div>`;
  }
}

// ── Epics Grid ──────────────────────────────────────────────────────────

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

/**
 * Find existing documents matching a key document definition.
 */
function findKeyDoc(keyDoc) {
  if (!projectData || !projectData.documents) return null;
  return projectData.documents.find(doc =>
    keyDoc.categories.includes(doc.category) &&
    keyDoc.patterns.some(p => p.test(doc.filename || doc.name))
  );
}

/**
 * Render a key document card — either with content or as a placeholder.
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

function setupProjectSelector() {
  const select = document.getElementById('project-select');
  select.addEventListener('change', async (e) => {
    const selectedPath = e.target.value;
    if (!selectedPath) return;

    const data = await window.api.loadProjectByPath(selectedPath);
    if (data && data.found) {
      projectData = data;
      snapshotStoryStates();
      await refreshProjectList();
      showView('epics');
      startPhasePoller();
    } else {
      projectData = null;
      stopPhasePoller();
      showView('welcome');
      showWarning('Could not load project — BMAD files not found.');
    }
  });
}

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

function setupInlineProjectSelect(selectId) {
  const select = document.getElementById(selectId);
  if (!select) return;
  select.addEventListener('change', async (e) => {
    const selectedPath = e.target.value;
    if (!selectedPath) return;
    const data = await window.api.loadProjectByPath(selectedPath);
    if (data && data.found) {
      projectData = data;
      snapshotStoryStates();
      await refreshProjectList();
      showView('epics');
      startPhasePoller();
    }
  });
}

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

async function renderSettings() {
  const container = document.getElementById('settings-content');
  if (!container) return;

  // Load all data in parallel
  const [settings, providers, projects, bmadConfig, bmadManifest] = await Promise.all([
    window.api.getSettings(),
    window.api.getProviders(),
    window.api.getProjectList(),
    window.api.readBmadConfig(),
    window.api.readBmadManifest()
  ]);

  settingsData = { ...settings };

  const providerOptions = providers.map(p =>
    `<option value="${p.key}"${p.key === settings.defaultLlm ? ' selected' : ''}>${p.name}</option>`
  ).join('');

  const reviewOptions = providers.map(p =>
    `<option value="${p.key}"${p.key === settings.reviewLlm ? ' selected' : ''}>${p.name}</option>`
  ).join('');

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

      <!-- Mobile Companion -->
      <div class="settings-section">
        <h3 class="settings-section-title">Mobile Companion</h3>
        <p class="settings-hint" style="margin-bottom:12px">Access your BMAD Board from your phone. Open the URL below or scan the QR code.</p>
        <div id="companion-section">
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

  // Render companion section
  renderCompanionSection();
}

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
 * Minimal QR code matrix generator (Version 2, ECC-L, byte mode).
 * Returns a 2D boolean array of modules or null on failure.
 */
function generateQRMatrix(text) {
  const data = new TextEncoder().encode(text);
  if (data.length > 32) return null; // Version 2 capacity limit

  // Version 2: 25x25 modules, ECC-L: 34 data codewords, 10 EC codewords
  const version = 2, size = 25;
  const totalDataCW = 34, ecCW = 10;
  const dataCW = totalDataCW - ecCW; // 24 usable after EC

  // Build data bitstream: mode(4) + count(8) + data + terminator + padding
  let bits = '';
  bits += '0100'; // Byte mode indicator
  bits += data.length.toString(2).padStart(8, '0'); // Character count
  for (const b of data) bits += b.toString(2).padStart(8, '0');
  bits += '0000'; // Terminator
  while (bits.length % 8 !== 0) bits += '0';
  while (bits.length < dataCW * 8) {
    bits += '11101100'; // Pad byte 0xEC
    if (bits.length < dataCW * 8) bits += '00010001'; // Pad byte 0x11
  }

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    codewords.push(parseInt(bits.slice(i, i + 8), 2));
  }

  // Reed-Solomon error correction (GF(2^8) with primitive poly 0x11d)
  const ec = reedSolomon(codewords, ecCW);
  const allCW = [...codewords, ...ec];

  // Initialize module grid
  const grid = Array.from({ length: size }, () => Array(size).fill(null));
  const reserved = Array.from({ length: size }, () => Array(size).fill(false));

  // Place finder patterns
  placeFinder(grid, reserved, 0, 0);
  placeFinder(grid, reserved, size - 7, 0);
  placeFinder(grid, reserved, 0, size - 7);

  // Place alignment pattern (version 2: center at 18,18)
  placeAlignment(grid, reserved, 18, 18);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    grid[6][i] = i % 2 === 0; reserved[6][i] = true;
    grid[i][6] = i % 2 === 0; reserved[i][6] = true;
  }

  // Dark module + reserved format info areas
  grid[size - 8][8] = true; reserved[size - 8][8] = true;
  reserveFormatArea(reserved, size);

  // Place data bits
  placeData(grid, reserved, allCW, size);

  // Apply mask 0 (checkerboard: (row + col) % 2 === 0)
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!reserved[r][c]) {
        if ((r + c) % 2 === 0) grid[r][c] = !grid[r][c];
      }
    }
  }

  // Place format info (mask 0, ECC-L)
  // Pre-computed: ECC-L + mask 0 => format bits 111011111000100
  const formatBits = '111011111000100';
  placeFormatInfo(grid, formatBits, size);

  return grid;
}

function placeFinder(grid, reserved, row, col) {
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
      if (gr < 0 || gr >= grid.length || gc < 0 || gc >= grid.length) continue;
      if (r >= 0 && r < 7 && c >= 0 && c < 7) {
        grid[gr][gc] = !!pattern[r][c];
      } else {
        grid[gr][gc] = false; // Separator
      }
      reserved[gr][gc] = true;
    }
  }
}

function placeAlignment(grid, reserved, centerR, centerC) {
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const gr = centerR + r, gc = centerC + c;
      grid[gr][gc] = Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0);
      reserved[gr][gc] = true;
    }
  }
}

function reserveFormatArea(reserved, size) {
  for (let i = 0; i < 8; i++) {
    reserved[8][i] = true; reserved[8][size - 1 - i] = true;
    reserved[i][8] = true; reserved[size - 1 - i][8] = true;
  }
  reserved[8][8] = true;
}

function placeFormatInfo(grid, bits, size) {
  const positions1 = [[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
  const positions2 = [[size-1,8],[size-2,8],[size-3,8],[size-4,8],[size-5,8],[size-6,8],[size-7,8],[8,size-8],[8,size-7],[8,size-6],[8,size-5],[8,size-4],[8,size-3],[8,size-2],[8,size-1]];
  for (let i = 0; i < 15; i++) {
    const bit = bits[i] === '1';
    grid[positions1[i][0]][positions1[i][1]] = bit;
    grid[positions2[i][0]][positions2[i][1]] = bit;
  }
}

function placeData(grid, reserved, codewords, size) {
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  let col = size - 1;
  let goingUp = true;

  while (col >= 0) {
    if (col === 6) col--; // Skip timing column
    const rows = goingUp ? Array.from({ length: size }, (_, i) => size - 1 - i) : Array.from({ length: size }, (_, i) => i);
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

function reedSolomon(data, ecCount) {
  // Generator polynomial coefficients for ecCount error correction codewords
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

  // Build generator polynomial
  let gen = [1];
  for (let i = 0; i < ecCount; i++) {
    const newGen = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      newGen[j] ^= gen[j];
      newGen[j + 1] ^= gfMul(gen[j], gfExp[i]);
    }
    gen = newGen;
  }

  // Polynomial division
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

  // Merge companion state from existing settings
  if (existingSettings?.companion) {
    settings.companion = existingSettings.companion;
  }

  await window.api.saveSettings(settings);

  // Restart poller with new interval
  startPhasePoller();

  const status = document.getElementById('settings-save-status');
  if (status) {
    status.textContent = 'Saved!';
    status.style.color = 'var(--success)';
    setTimeout(() => { status.textContent = ''; }, 2000);
  }
}

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
