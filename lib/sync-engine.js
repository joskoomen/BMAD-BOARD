/**
 * Sync Engine
 *
 * Provider-agnostic sync orchestration for BMAD projects.
 * Manages sync state, conflict detection, and coordinates
 * push/pull operations through any registered sync provider.
 */

const fs = require('fs');
const path = require('path');
const { getSyncProvider, contentHash } = require('./sync-providers');

const SYNC_STATE_FILE = 'sync-state.json';

class SyncEngine {
  /**
   * @param {string} projectPath - Absolute path to the BMAD project
   * @param {function} scanProject - Function that returns scanned project data
   */
  constructor(projectPath, scanProject) {
    this.projectPath = projectPath;
    this.scanProject = scanProject;
    this.stateDir = path.join(projectPath, '.bmad-board');
    this.statePath = path.join(this.stateDir, SYNC_STATE_FILE);
    this.state = this._loadState();
  }

  // ── State Persistence ───────────────────────────────────────────────

  _loadState() {
    try {
      if (fs.existsSync(this.statePath)) {
        return JSON.parse(fs.readFileSync(this.statePath, 'utf-8'));
      }
    } catch { /* ignore corrupt state */ }
    return { provider: null, config: {}, lastFullSync: null, mappings: { epics: {}, stories: {}, documents: {} } };
  }

  _saveState() {
    if (!fs.existsSync(this.stateDir)) {
      fs.mkdirSync(this.stateDir, { recursive: true });
    }
    fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }

  // ── Configuration ───────────────────────────────────────────────────

  /**
   * Configure the sync engine with a provider and its config.
   * @param {string} providerKey - Provider key (notion, obsidian, linear)
   * @param {object} config - Provider-specific configuration
   */
  configure(providerKey, config) {
    const provider = getSyncProvider(providerKey);
    if (!provider) throw new Error(`Unknown sync provider: ${providerKey}`);

    this.state.provider = providerKey;
    this.state.config = config;
    this._saveState();
    return { ok: true };
  }

  /**
   * Get the currently configured provider instance.
   */
  _getProvider() {
    if (!this.state.provider) throw new Error('No sync provider configured');
    const provider = getSyncProvider(this.state.provider);
    if (!provider) throw new Error(`Unknown sync provider: ${this.state.provider}`);
    return provider;
  }

  /**
   * Validate provider configuration.
   */
  async validate(providerKey, config) {
    const key = providerKey || this.state.provider;
    const cfg = config || this.state.config;
    const provider = getSyncProvider(key);
    if (!provider) return { valid: false, errors: ['Unknown provider'] };
    return provider.validateConfig(cfg);
  }

  /**
   * Test connection to the remote service.
   */
  async testConnection(providerKey, config) {
    const key = providerKey || this.state.provider;
    const cfg = config || this.state.config;
    const provider = getSyncProvider(key);
    if (!provider) return { ok: false, message: 'Unknown provider' };
    return provider.testConnection(cfg);
  }

  // ── Setup ───────────────────────────────────────────────────────────

  /**
   * Initial remote setup (create databases, folders, etc.)
   */
  async setup() {
    const provider = this._getProvider();
    const projectData = await this.scanProject(this.projectPath);
    const result = await provider.setup(this.state.config, projectData);

    // Merge setup results into config (e.g. database IDs)
    Object.assign(this.state.config, result);
    this._saveState();
    return result;
  }

  // ── Sync Operations ─────────────────────────────────────────────────

  /**
   * Full bidirectional sync: push local changes, then pull remote changes.
   * @param {object} opts - { direction: 'both'|'push'|'pull', conflictStrategy: 'local-wins'|'remote-wins'|'last-modified-wins' }
   */
  async syncAll(opts = {}) {
    const direction = opts.direction || 'both';
    const conflictStrategy = opts.conflictStrategy || 'last-modified-wins';
    const provider = this._getProvider();
    const projectData = await this.scanProject(this.projectPath);

    const report = { pushed: 0, pulled: 0, conflicts: [], errors: [] };

    // Push
    if (direction === 'both' || direction === 'push') {
      try {
        const pushResults = await provider.push(this.state.config, this.state, projectData);
        // Merge push results into mappings
        for (const type of ['epics', 'stories', 'documents']) {
          this.state.mappings[type] = { ...this.state.mappings[type], ...pushResults[type] };
        }
        report.pushed = Object.keys(pushResults.epics || {}).length +
          Object.keys(pushResults.stories || {}).length +
          Object.keys(pushResults.documents || {}).length;
      } catch (err) {
        report.errors.push(`Push failed: ${err.message}`);
      }
    }

    // Pull
    if (direction === 'both' || direction === 'pull') {
      try {
        const remoteData = await provider.pull(this.state.config, this.state);
        const pullResult = await this._applyPull(remoteData, projectData, conflictStrategy);
        report.pulled = pullResult.applied;
        report.conflicts.push(...pullResult.conflicts);
      } catch (err) {
        report.errors.push(`Pull failed: ${err.message}`);
      }
    }

    this.state.lastFullSync = new Date().toISOString();
    this._saveState();
    return report;
  }

  /**
   * Push all local data to remote.
   */
  async pushAll() {
    return this.syncAll({ direction: 'push' });
  }

  /**
   * Pull all remote data to local.
   */
  async pullAll() {
    return this.syncAll({ direction: 'pull' });
  }

  /**
   * Sync a single item.
   * @param {'epic'|'story'|'document'} type
   * @param {string} key - Epic key, story slug, or document filename
   */
  async syncItem(type, key) {
    const provider = this._getProvider();
    const projectData = await this.scanProject(this.projectPath);

    // Find the item in project data
    let item;
    if (type === 'epic') {
      item = projectData.epics?.find(e => e.key === key);
    } else if (type === 'story') {
      for (const epic of (projectData.epics || [])) {
        item = epic.stories?.find(s => s.slug === key);
        if (item) { item._epic = epic; break; }
      }
    } else if (type === 'document') {
      item = projectData.documents?.find(d => d.filename === key);
    }

    if (!item) return { ok: false, error: `Item not found: ${type}/${key}` };

    // Build minimal project data for the provider push
    let miniProject;
    if (type === 'epic') {
      miniProject = { ...projectData, epics: [item] };
    } else if (type === 'story') {
      miniProject = { ...projectData, epics: [{ ...item._epic, stories: [item] }], documents: [] };
    } else {
      miniProject = { ...projectData, epics: [], documents: [item] };
    }

    const pushResults = await provider.push(this.state.config, this.state, miniProject);
    for (const t of ['epics', 'stories', 'documents']) {
      this.state.mappings[t] = { ...this.state.mappings[t], ...pushResults[t] };
    }
    this._saveState();

    return { ok: true, results: pushResults };
  }

  // ── Pull Application ────────────────────────────────────────────────

  /**
   * Apply pulled remote data to local files.
   * Detects conflicts by comparing content hashes and timestamps.
   */
  async _applyPull(remoteData, localData, conflictStrategy) {
    const applied = { applied: 0, conflicts: [] };

    // Apply story changes
    for (const remoteStory of (remoteData.stories || [])) {
      const mapping = this.state.mappings.stories?.[remoteStory.slug];
      if (!mapping) continue; // Unknown story — skip

      // Check if remote was modified since last sync
      if (mapping.lastSync && remoteStory.lastEdited) {
        const lastSyncDate = new Date(mapping.lastSync);
        const remoteDate = new Date(remoteStory.lastEdited);
        if (remoteDate <= lastSyncDate) continue; // No remote changes
      }

      // Find local story
      let localStory;
      for (const epic of (localData.epics || [])) {
        localStory = epic.stories?.find(s => s.slug === remoteStory.slug);
        if (localStory) break;
      }

      if (!localStory) continue;

      // Check for conflict
      const localHash = contentHash(localStory.content || '');
      const localChanged = localHash !== mapping.contentHash;
      const remoteChanged = true; // Already filtered above

      if (localChanged && remoteChanged) {
        // Conflict
        if (conflictStrategy === 'local-wins') continue;
        if (conflictStrategy === 'remote-wins') {
          // Fall through to apply remote
        } else {
          // last-modified-wins: compare timestamps
          const localMtime = localStory.filePath ? fs.statSync(localStory.filePath).mtime : new Date(0);
          const remoteMtime = new Date(remoteStory.lastEdited);
          if (localMtime > remoteMtime) {
            applied.conflicts.push({ type: 'story', key: remoteStory.slug, resolution: 'local-wins' });
            continue;
          }
        }
        applied.conflicts.push({ type: 'story', key: remoteStory.slug, resolution: 'remote-wins' });
      }

      // Apply remote content to local file
      if (localStory.filePath && remoteStory.content) {
        fs.writeFileSync(localStory.filePath, remoteStory.content, 'utf-8');
        // Update mapping
        this.state.mappings.stories[remoteStory.slug] = {
          ...mapping,
          lastSync: new Date().toISOString(),
          contentHash: contentHash(remoteStory.content)
        };
        applied.applied++;
      }

      // Apply status change to sprint-status.yaml
      if (remoteStory.status && remoteStory.status !== localStory.status) {
        this._updateStoryStatus(remoteStory.slug, remoteStory.status);
      }
    }

    return applied;
  }

  /**
   * Update story status in sprint-status.yaml.
   * Reuses the same regex approach as main.js updateStoryStatusInYaml.
   */
  _updateStoryStatus(slug, newStatus) {
    const { scanProject: _ignored, ...rest } = this; // avoid lint
    // Find sprint-status.yaml
    const candidates = [
      path.join(this.projectPath, '_bmad-output', 'implementation', 'sprint-status.yaml'),
      path.join(this.projectPath, '_bmad-output', 'sprint-status.yaml')
    ];

    for (const filePath of candidates) {
      if (!fs.existsSync(filePath)) continue;
      let content = fs.readFileSync(filePath, 'utf-8');
      const regex = new RegExp(`^(\\s*${slug}\\s*:\\s*)\\S+`, 'm');
      if (regex.test(content)) {
        content = content.replace(regex, `$1${newStatus}`);
        fs.writeFileSync(filePath, content, 'utf-8');
        return true;
      }
    }
    return false;
  }

  // ── Status ──────────────────────────────────────────────────────────

  /**
   * Get current sync status overview.
   */
  getSyncStatus() {
    const mappings = this.state.mappings;
    return {
      provider: this.state.provider,
      configured: !!this.state.provider,
      lastFullSync: this.state.lastFullSync,
      counts: {
        epics: Object.keys(mappings.epics || {}).length,
        stories: Object.keys(mappings.stories || {}).length,
        documents: Object.keys(mappings.documents || {}).length
      },
      config: this.state.config ? { ...this.state.config, apiKey: this.state.config.apiKey ? '***' : undefined } : {}
    };
  }

  /**
   * Get the full state (for MCP resources).
   */
  getState() {
    return { ...this.state };
  }
}

module.exports = { SyncEngine };
