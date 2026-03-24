/**
 * Companion Server — HTTP + WebSocket server for the mobile PWA companion.
 *
 * Serves the PWA static files and provides REST API + WebSocket for
 * real-time project data and terminal streaming.
 *
 * Usage:
 *   const { CompanionServer } = require('./companion-server');
 *   const server = new CompanionServer({ terminalManager, getProjectData, getSettings });
 *   server.start(3939);
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { PHASE_ORDER } = require('./phase-commands');

const STATIC_DIR = path.join(__dirname, '..', 'companion');

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

class CompanionServer {
  /**
   * @param {object} opts
   * @param {import('./terminal-manager').TerminalManager} opts.terminalManager
   * @param {function} opts.scanProject - () => project scan result
   * @param {function} opts.getProjectPath - () => current project path
   * @param {function} opts.getSettings - () => settings object
   * @param {function} opts.buildCommand - (phase, storySlug, storyFilePath) => command string
   */
  constructor(opts) {
    this.terminalManager = opts.terminalManager;
    this.scanProject = opts.scanProject;
    this.getProjectPath = opts.getProjectPath;
    this.getSettings = opts.getSettings;
    this.buildCommand = opts.buildCommand;

    this.token = crypto.randomBytes(24).toString('hex');
    this.port = 3939;
    this.httpServer = null;
    this.wss = null;
    this.clients = new Set();

    // Track terminal sessions created by companion clients
    // Maps ws client -> Set of terminal session IDs
    this.clientTerminals = new Map();

    // Desktop terminal sharing: maps desktop session id -> latest buffer
    this.sharedTerminals = new Map();

    // Push subscriptions for notifications
    this.pushSubscriptions = new Set();

    // Callback for writing sprint-status.yaml updates
    this.updateStoryStatus = opts.updateStoryStatus || null;
  }

  /**
   * Start the HTTP + WebSocket server.
   * @param {number} [port=3939]
   * @returns {Promise<{ port: number, token: string }>}
   */
  start(port) {
    this.port = port || this.port;

    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer((req, res) => this._handleHTTP(req, res));

      this.wss = new WebSocketServer({ server: this.httpServer });
      this.wss.on('connection', (ws, req) => this._handleWS(ws, req));

      this.httpServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.log(`[companion] Port ${this.port} in use, trying ${this.port + 1}`);
          this.port++;
          this.httpServer.listen(this.port, '0.0.0.0');
        } else {
          reject(err);
        }
      });

      this.httpServer.listen(this.port, '0.0.0.0', () => {
        console.log(`[companion] Server running on http://0.0.0.0:${this.port}`);
        resolve({ port: this.port, token: this.token });
      });
    });
  }

  /**
   * Stop the server.
   */
  stop() {
    // Kill all companion-created terminal sessions
    for (const [, sessionIds] of this.clientTerminals) {
      for (const id of sessionIds) {
        this.terminalManager.kill(id);
      }
    }
    this.clientTerminals.clear();

    if (this.wss) {
      for (const client of this.clients) {
        client.close();
      }
      this.wss.close();
    }
    if (this.httpServer) {
      this.httpServer.close();
    }
  }

  /**
   * Get the connection info for QR code generation.
   */
  getConnectionInfo() {
    const addresses = this._getLocalIPs();
    return {
      port: this.port,
      token: this.token,
      addresses,
      urls: addresses.map(ip => `http://${ip}:${this.port}?token=${this.token}`)
    };
  }

  /**
   * Broadcast a message to all authenticated WebSocket clients.
   */
  broadcast(type, data) {
    const msg = JSON.stringify({ type, data });
    for (const client of this.clients) {
      if (client.readyState === 1) { // OPEN
        client.send(msg);
      }
    }
  }

  // ── HTTP Handler ──────────────────────────────────────────────────────

  _handleHTTP(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // CORS headers for development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // API routes
    if (pathname.startsWith('/api/')) {
      return this._handleAPI(req, res, url);
    }

    // Static file serving for PWA
    this._serveStatic(req, res, pathname);
  }

  _handleAPI(req, res, url) {
    // Auth check
    if (!this._checkAuth(req, url)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const pathname = url.pathname;

    // Route: GET /api/status
    if (pathname === '/api/status' && req.method === 'GET') {
      return this._json(res, {
        ok: true,
        project: this.getProjectPath() ? path.basename(this.getProjectPath()) : null,
        hasProject: !!this.getProjectPath()
      });
    }

    // Route: GET /api/project
    if (pathname === '/api/project' && req.method === 'GET') {
      const projectPath = this.getProjectPath();
      if (!projectPath) {
        return this._json(res, { error: 'No project loaded' }, 404);
      }
      const data = this.scanProject(projectPath);
      // Strip file contents for lighter payload (send separately on demand)
      const lite = this._lightProjectData(data);
      return this._json(res, lite);
    }

    // Route: GET /api/epics
    if (pathname === '/api/epics' && req.method === 'GET') {
      const projectPath = this.getProjectPath();
      if (!projectPath) return this._json(res, { error: 'No project loaded' }, 404);
      const data = this.scanProject(projectPath);
      return this._json(res, { epics: data.epics || [] });
    }

    // Route: GET /api/story/:slug
    const storyMatch = pathname.match(/^\/api\/story\/(.+)$/);
    if (storyMatch && req.method === 'GET') {
      const slug = decodeURIComponent(storyMatch[1]);
      const projectPath = this.getProjectPath();
      if (!projectPath) return this._json(res, { error: 'No project loaded' }, 404);
      const data = this.scanProject(projectPath);
      for (const epic of (data.epics || [])) {
        const story = epic.stories.find(s => s.slug === slug);
        if (story) {
          return this._json(res, { story, epicNumber: epic.number, epicTitle: epic.title });
        }
      }
      return this._json(res, { error: 'Story not found' }, 404);
    }

    // Route: GET /api/documents
    if (pathname === '/api/documents' && req.method === 'GET') {
      const projectPath = this.getProjectPath();
      if (!projectPath) return this._json(res, { error: 'No project loaded' }, 404);
      const data = this.scanProject(projectPath);
      const lite = (data.documents || []).map(doc => ({ ...doc, content: undefined }));
      return this._json(res, { documents: lite });
    }

    // Route: GET /api/settings
    if (pathname === '/api/settings' && req.method === 'GET') {
      return this._json(res, { settings: this.getSettings() });
    }

    // Route: POST /api/terminal/create
    if (pathname === '/api/terminal/create' && req.method === 'POST') {
      return this._readBody(req, (body) => {
        // Terminal creation is handled via WebSocket for real-time streaming
        return this._json(res, { error: 'Use WebSocket for terminal operations' }, 400);
      });
    }

    // Route: POST /api/launch-command
    if (pathname === '/api/launch-command' && req.method === 'POST') {
      return this._readBody(req, (body) => {
        try {
          const { phase, storySlug, storyFilePath } = JSON.parse(body);
          const cmd = this.buildCommand(phase, storySlug, storyFilePath);
          if (!cmd) return this._json(res, { error: 'No command for this phase' }, 400);
          return this._json(res, { command: cmd });
        } catch (e) {
          return this._json(res, { error: e.message }, 400);
        }
      });
    }

    // Route: POST /api/story/:slug/advance — advance story to next phase
    const advanceMatch = pathname.match(/^\/api\/story\/(.+)\/advance$/);
    if (advanceMatch && req.method === 'POST') {
      const slug = decodeURIComponent(advanceMatch[1]);
      return this._handleStoryAdvance(req, res, slug);
    }

    // Route: POST /api/push/subscribe — register push notification subscription
    if (pathname === '/api/push/subscribe' && req.method === 'POST') {
      return this._readBody(req, (body) => {
        try {
          const sub = JSON.parse(body);
          this.pushSubscriptions.add(JSON.stringify(sub));
          return this._json(res, { ok: true });
        } catch (e) {
          return this._json(res, { error: e.message }, 400);
        }
      });
    }

    // 404
    this._json(res, { error: 'Not found' }, 404);
  }

  _serveStatic(req, res, pathname) {
    // Default to index.html
    if (pathname === '/' || pathname === '') {
      pathname = '/index.html';
    }

    const filePath = path.join(STATIC_DIR, pathname);

    // Security: prevent directory traversal
    if (!filePath.startsWith(STATIC_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
      if (err) {
        // Fallback to index.html for SPA routing
        if (pathname !== '/index.html') {
          return this._serveStatic(req, res, '/index.html');
        }
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      // Cache static assets (but not HTML)
      if (ext !== '.html') {
        res.setHeader('Cache-Control', 'public, max-age=3600');
      }

      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  }

  // ── WebSocket Handler ─────────────────────────────────────────────────

  _handleWS(ws, req) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    if (token !== this.token) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    this.clients.add(ws);
    this.clientTerminals.set(ws, new Set());
    console.log(`[companion] Client connected (${this.clients.size} total)`);

    // Send initial state
    const projectPath = this.getProjectPath();
    if (projectPath) {
      const data = this.scanProject(projectPath);
      ws.send(JSON.stringify({
        type: 'project:state',
        data: this._lightProjectData(data)
      }));
    }

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        this._handleWSMessage(ws, msg);
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', data: { message: e.message } }));
      }
    });

    ws.on('close', () => {
      this.clients.delete(ws);
      // Kill terminal sessions owned by this client
      const sessions = this.clientTerminals.get(ws) || new Set();
      for (const id of sessions) {
        this.terminalManager.kill(id);
      }
      this.clientTerminals.delete(ws);
      console.log(`[companion] Client disconnected (${this.clients.size} total)`);
    });

    // Heartbeat
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
  }

  _handleWSMessage(ws, msg) {
    switch (msg.type) {
      case 'terminal:create': {
        const cwd = this.getProjectPath() || require('os').homedir();
        const id = this.terminalManager.create({
          cwd,
          cols: msg.data?.cols || 120,
          rows: msg.data?.rows || 30,
          onData: (sessionId, data) => {
            ws.send(JSON.stringify({
              type: 'terminal:data',
              data: { id: sessionId, data }
            }));
          },
          onExit: (sessionId, exitCode) => {
            ws.send(JSON.stringify({
              type: 'terminal:exit',
              data: { id: sessionId, exitCode }
            }));
            const sessions = this.clientTerminals.get(ws);
            if (sessions) sessions.delete(sessionId);
          }
        });
        // Track this session for cleanup
        const sessions = this.clientTerminals.get(ws);
        if (sessions) sessions.add(id);

        ws.send(JSON.stringify({ type: 'terminal:created', data: { id } }));
        break;
      }

      case 'terminal:input': {
        if (msg.data?.id && msg.data?.input) {
          this.terminalManager.write(msg.data.id, msg.data.input);
        }
        break;
      }

      case 'terminal:resize': {
        if (msg.data?.id && msg.data?.cols && msg.data?.rows) {
          this.terminalManager.resize(msg.data.id, msg.data.cols, msg.data.rows);
        }
        break;
      }

      case 'terminal:kill': {
        if (msg.data?.id) {
          this.terminalManager.kill(msg.data.id);
          const sessions = this.clientTerminals.get(ws);
          if (sessions) sessions.delete(msg.data.id);
        }
        break;
      }

      case 'project:refresh': {
        const projectPath = this.getProjectPath();
        if (projectPath) {
          const data = this.scanProject(projectPath);
          ws.send(JSON.stringify({
            type: 'project:state',
            data: this._lightProjectData(data)
          }));
        }
        break;
      }

      case 'terminal:watch': {
        // Client wants to watch a shared desktop terminal session
        const sessionId = msg.data?.id;
        const session = this.sharedTerminals.get(sessionId);
        if (session) {
          // Send buffered output
          ws.send(JSON.stringify({
            type: 'terminal:shared-data',
            data: { id: sessionId, data: session.buffer }
          }));
        }
        break;
      }

      case 'terminal:list-shared': {
        // List all active shared desktop terminals
        ws.send(JSON.stringify({
          type: 'terminal:shared-list',
          data: { sessions: this.getSharedTerminals() }
        }));
        break;
      }

      case 'story:advance': {
        // Advance story phase via WebSocket
        const slug = msg.data?.slug;
        if (!slug) break;

        const projectPath = this.getProjectPath();
        if (!projectPath) break;

        const data = this.scanProject(projectPath);
        let targetStory = null;
        for (const epic of (data.epics || [])) {
          const story = epic.stories.find(s => s.slug === slug);
          if (story) { targetStory = story; break; }
        }
        if (!targetStory) break;

        const currentIdx = PHASE_ORDER.indexOf(targetStory.status);
        if (currentIdx >= 0 && currentIdx < PHASE_ORDER.length - 1) {
          const newPhase = PHASE_ORDER[currentIdx + 1];
          if (this.updateStoryStatus) {
            try {
              this.updateStoryStatus(projectPath, slug, newPhase);
              const updated = this.scanProject(projectPath);
              this.broadcast('project:state', this._lightProjectData(updated));
              ws.send(JSON.stringify({
                type: 'story:advanced',
                data: { slug, oldPhase: targetStory.status, newPhase }
              }));
            } catch (e) {
              ws.send(JSON.stringify({
                type: 'error',
                data: { message: `Failed to advance: ${e.message}` }
              }));
            }
          }
        }
        break;
      }

      case 'ping': {
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
      }
    }
  }

  // ── Story Phase Advance ──────────────────────────────────────────────

  _handleStoryAdvance(req, res, slug) {
    this._readBody(req, (body) => {
      const projectPath = this.getProjectPath();
      if (!projectPath) return this._json(res, { error: 'No project loaded' }, 404);

      const data = this.scanProject(projectPath);
      let targetStory = null;
      let targetEpic = null;

      for (const epic of (data.epics || [])) {
        const story = epic.stories.find(s => s.slug === slug);
        if (story) {
          targetStory = story;
          targetEpic = epic;
          break;
        }
      }

      if (!targetStory) return this._json(res, { error: 'Story not found' }, 404);

      const currentIdx = PHASE_ORDER.indexOf(targetStory.status);
      if (currentIdx === -1 || currentIdx >= PHASE_ORDER.length - 1) {
        return this._json(res, { error: 'Story is already done or has unknown status' }, 400);
      }

      const newPhase = PHASE_ORDER[currentIdx + 1];

      // Update sprint-status.yaml
      if (this.updateStoryStatus) {
        try {
          this.updateStoryStatus(projectPath, slug, newPhase);
        } catch (e) {
          return this._json(res, { error: `Failed to update: ${e.message}` }, 500);
        }
      }

      // Broadcast updated project state to all clients
      const updatedData = this.scanProject(projectPath);
      this.broadcast('project:state', this._lightProjectData(updatedData));

      return this._json(res, {
        ok: true,
        story: slug,
        oldPhase: targetStory.status,
        newPhase
      });
    });
  }

  // ── Desktop Terminal Sharing ────────────────────────────────────────

  /**
   * Share a desktop terminal session's output with all companion clients.
   * Call this from the main process when a desktop terminal produces data.
   */
  shareTerminalData(sessionId, data) {
    // Buffer the latest data for late-joiners
    if (!this.sharedTerminals.has(sessionId)) {
      this.sharedTerminals.set(sessionId, { buffer: '', active: true });
    }
    const session = this.sharedTerminals.get(sessionId);
    session.buffer += data;
    // Keep buffer size reasonable (last 50KB)
    if (session.buffer.length > 50000) {
      session.buffer = session.buffer.slice(-50000);
    }

    this.broadcast('terminal:shared-data', { id: sessionId, data });
  }

  /**
   * Notify companion clients that a desktop terminal session ended.
   */
  shareTerminalExit(sessionId, exitCode) {
    const session = this.sharedTerminals.get(sessionId);
    if (session) session.active = false;

    this.broadcast('terminal:shared-exit', { id: sessionId, exitCode });

    // Send notification about terminal exit
    this.broadcast('notification', {
      title: 'Terminal Exited',
      body: `Session ended with code ${exitCode}`,
      type: exitCode === 0 ? 'success' : 'error'
    });
  }

  /**
   * Get list of active shared terminal sessions.
   */
  getSharedTerminals() {
    const result = [];
    for (const [id, session] of this.sharedTerminals) {
      if (session.active) {
        result.push({ id, bufferSize: session.buffer.length });
      }
    }
    return result;
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  _checkAuth(req, url) {
    // Check Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader === `Bearer ${this.token}`) {
      return true;
    }
    // Check query param
    const queryToken = url.searchParams.get('token');
    if (queryToken === this.token) {
      return true;
    }
    return false;
  }

  _json(res, data, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  _readBody(req, callback) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => callback(body));
  }

  /**
   * Strip heavy content from project data for lighter payloads.
   * Story content and document content sent separately on demand.
   */
  _lightProjectData(data) {
    if (!data) return data;
    return {
      ...data,
      epics: (data.epics || []).map(epic => ({
        ...epic,
        stories: epic.stories.map(story => ({
          ...story,
          content: undefined // Strip full markdown content
        })),
        retrospective: epic.retrospective ? {
          ...epic.retrospective,
          content: undefined
        } : null
      })),
      documents: (data.documents || []).map(doc => ({
        ...doc,
        content: undefined // Strip document content
      }))
    };
  }

  _getLocalIPs() {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    const addresses = [];
    for (const iface of Object.values(interfaces)) {
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) {
          addresses.push(addr.address);
        }
      }
    }
    return addresses;
  }
}

// Heartbeat interval to clean up dead connections
function startHeartbeat(server) {
  return setInterval(() => {
    for (const client of server.clients) {
      if (!client.isAlive) {
        client.terminate();
        server.clients.delete(client);
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, 30000);
}

module.exports = { CompanionServer, startHeartbeat };
