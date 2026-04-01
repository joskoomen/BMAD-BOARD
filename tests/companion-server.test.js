/**
 * Tests for the Companion Server (HTTP + WebSocket).
 */

const http = require('http');
const { WebSocket } = require('ws');
const { CompanionServer } = require('../lib/companion-server');

let portCounter = 14000 + Math.floor(Math.random() * 1000);
function nextPort() { return portCounter++; }

// Mock terminal manager
function createMockTerminalManager() {
  let nextId = 1;
  const sessions = new Map();
  return {
    sessions,
    create({ onData, onExit }) {
      const id = nextId++;
      sessions.set(id, { onData, onExit });
      return id;
    },
    write(id, data) { /* no-op */ },
    resize(id, cols, rows) { /* no-op */ },
    kill(id) { sessions.delete(id); },
    killAll() { sessions.clear(); },
    has(id) { return sessions.has(id); },
    emitData(id, data) {
      const s = sessions.get(id);
      if (s?.onData) s.onData(id, data);
    },
    emitExit(id, code) {
      const s = sessions.get(id);
      if (s?.onExit) s.onExit(id, code);
    }
  };
}

const mockProjectData = {
  found: true,
  projectPath: '/tmp/test-project',
  config: { implementationArtifacts: '/tmp/test-project/_bmad-output/implementation' },
  projectMeta: { name: 'Test Project' },
  epics: [
    {
      number: 1,
      title: 'Test Epic',
      status: 'in-progress',
      stories: [
        { slug: '1-1-test-story', title: 'Test Story', status: 'in-progress', storyNumber: '1', epicNumber: 1, filePath: null, content: 'Hello' },
        { slug: '1-2-done-story', title: 'Done Story', status: 'done', storyNumber: '2', epicNumber: 1, filePath: null, content: 'Done' }
      ],
      retrospective: null
    }
  ],
  documents: [
    { category: 'Planning', name: 'PRD', filename: 'prd.md', filePath: '/tmp/prd.md', content: '# PRD' }
  ]
};

function createServer(overrides = {}) {
  return new CompanionServer({
    terminalManager: createMockTerminalManager(),
    scanProject: () => ({ ...mockProjectData }),
    getProjectPath: () => '/tmp/test-project',
    getSettings: () => ({ defaultLlm: 'claude' }),
    buildCommand: () => 'claude "/dev-story"',
    updateStoryStatus: () => {},
    ...overrides
  });
}

function httpGet(port, path, token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port,
      path,
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    };
    http.get(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, body: data, json: () => JSON.parse(data) });
      });
    }).on('error', reject);
  });
}

function httpPost(port, path, token, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, body: data, json: () => JSON.parse(data) });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function connectWS(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${token}`);
    const messages = [];
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    ws.on('error', reject);
  });
}

function waitForMessage(messages, type, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const msg = messages.find(m => m.type === type);
      if (msg) return resolve(msg);
      if (Date.now() - start > timeout) return reject(new Error(`Timeout waiting for ${type}`));
      setTimeout(check, 50);
    };
    check();
  });
}

describe('CompanionServer', () => {
  let server;

  afterEach(async () => {
    if (server) {
      server.stop();
      server = null;
    }
  });

  describe('start/stop', () => {
    it('starts on the specified port', async () => {
      server = createServer();
      const info = await server.start(nextPort());
      expect(info.port).toBeGreaterThan(0);
      expect(info.token).toBeTruthy();
      expect(info.token.length).toBe(48); // 24 bytes hex
    });

    it('generates a random auth token', async () => {
      server = createServer();
      const info = await server.start(nextPort());
      const server2 = createServer();
      expect(server.token).not.toBe(server2.token);
    });
  });

  describe('HTTP API', () => {
    it('rejects requests without auth', async () => {
      server = createServer();
      await server.start(nextPort());
      const res = await httpGet(server.port, '/api/status');
      expect(res.status).toBe(401);
    });

    it('accepts requests with valid Bearer token', async () => {
      server = createServer();
      await server.start(nextPort());
      const res = await httpGet(server.port, '/api/status', server.token);
      expect(res.status).toBe(200);
      const data = res.json();
      expect(data.ok).toBe(true);
      expect(data.project).toBe('test-project');
    });

    it('accepts token as query param', async () => {
      server = createServer();
      await server.start(nextPort());
      const res = await httpGet(server.port, `/api/status?token=${server.token}`);
      expect(res.status).toBe(200);
    });

    it('GET /api/project returns lite project data', async () => {
      server = createServer();
      await server.start(nextPort());
      const res = await httpGet(server.port, '/api/project', server.token);
      const data = res.json();
      expect(data.found).toBe(true);
      expect(data.epics).toHaveLength(1);
      // Content should be stripped
      expect(data.epics[0].stories[0].content).toBeUndefined();
      expect(data.documents[0].content).toBeUndefined();
    });

    it('GET /api/epics returns epics array', async () => {
      server = createServer();
      await server.start(nextPort());
      const res = await httpGet(server.port, '/api/epics', server.token);
      const data = res.json();
      expect(data.epics).toHaveLength(1);
      expect(data.epics[0].title).toBe('Test Epic');
    });

    it('GET /api/story/:slug returns story detail', async () => {
      server = createServer();
      await server.start(nextPort());
      const res = await httpGet(server.port, '/api/story/1-1-test-story', server.token);
      const data = res.json();
      expect(data.story.title).toBe('Test Story');
      expect(data.epicNumber).toBe(1);
    });

    it('GET /api/story/:slug returns 404 for unknown slug', async () => {
      server = createServer();
      await server.start(nextPort());
      const res = await httpGet(server.port, '/api/story/unknown-slug', server.token);
      expect(res.status).toBe(404);
    });

    it('GET /api/documents returns documents', async () => {
      server = createServer();
      await server.start(nextPort());
      const res = await httpGet(server.port, '/api/documents', server.token);
      const data = res.json();
      expect(data.documents).toHaveLength(1);
      // Content should be stripped
      expect(data.documents[0].content).toBeUndefined();
    });

    it('returns 404 for no project', async () => {
      server = createServer({ getProjectPath: () => null });
      await server.start(nextPort());
      const res = await httpGet(server.port, '/api/project', server.token);
      expect(res.status).toBe(404);
    });
  });

  describe('story advance API', () => {
    it('POST /api/story/:slug/advance advances story phase', async () => {
      let updatedSlug, updatedPhase;
      server = createServer({
        updateStoryStatus: (projPath, slug, newPhase) => {
          updatedSlug = slug;
          updatedPhase = newPhase;
        }
      });
      await server.start(nextPort());

      const res = await httpPost(server.port, '/api/story/1-1-test-story/advance', server.token, {});
      const data = res.json();

      expect(res.status).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.oldPhase).toBe('in-progress');
      expect(data.newPhase).toBe('review');
      expect(updatedSlug).toBe('1-1-test-story');
      expect(updatedPhase).toBe('review');
    });

    it('returns 400 when story is already done', async () => {
      server = createServer();
      await server.start(nextPort());

      const res = await httpPost(server.port, '/api/story/1-2-done-story/advance', server.token, {});
      expect(res.status).toBe(400);
      const data = res.json();
      expect(data.error).toContain('already done');
    });

    it('returns 404 for unknown story slug', async () => {
      server = createServer();
      await server.start(nextPort());

      const res = await httpPost(server.port, '/api/story/unknown-slug/advance', server.token, {});
      expect(res.status).toBe(404);
    });

    it('returns 500 when updateStoryStatus throws', async () => {
      server = createServer({
        updateStoryStatus: () => { throw new Error('write failed'); }
      });
      await server.start(nextPort());

      const res = await httpPost(server.port, '/api/story/1-1-test-story/advance', server.token, {});
      expect(res.status).toBe(500);
    });
  });

  describe('push subscription API', () => {
    it('POST /api/push/subscribe stores subscription', async () => {
      server = createServer();
      await server.start(nextPort());

      const sub = { endpoint: 'https://example.com/push', keys: { p256dh: 'abc', auth: 'def' } };
      const res = await httpPost(server.port, '/api/push/subscribe', server.token, sub);
      const data = res.json();

      expect(res.status).toBe(200);
      expect(data.ok).toBe(true);
      expect(server.pushSubscriptions.size).toBe(1);
    });
  });

  describe('static files', () => {
    it('serves index.html at /', async () => {
      server = createServer();
      await server.start(nextPort());
      const res = await httpGet(server.port, '/');
      expect(res.status).toBe(200);
      expect(res.body).toContain('BMAD Board');
    });

    it('serves CSS files', async () => {
      server = createServer();
      await server.start(nextPort());
      const res = await httpGet(server.port, '/style.css');
      expect(res.status).toBe(200);
      expect(res.body).toContain('--bg-primary');
    });

    it('serves PNG icon files', async () => {
      server = createServer();
      await server.start(nextPort());
      const res = await httpGet(server.port, '/icon-192.png');
      expect(res.status).toBe(200);
    });
  });

  describe('getConnectionInfo', () => {
    it('returns addresses and urls', async () => {
      server = createServer();
      await server.start(nextPort());
      const info = server.getConnectionInfo();
      expect(info.port).toBe(server.port);
      expect(info.token).toBe(server.token);
      expect(Array.isArray(info.addresses)).toBe(true);
      expect(Array.isArray(info.urls)).toBe(true);
    });
  });

  describe('broadcast', () => {
    it('does not throw with no clients', async () => {
      server = createServer();
      await server.start(nextPort());
      expect(() => server.broadcast('test', {})).not.toThrow();
    });
  });

  describe('terminal sharing', () => {
    it('shareTerminalData broadcasts to clients', async () => {
      server = createServer();
      await server.start(nextPort());

      const { ws: client, messages } = await connectWS(server.port, server.token);

      // Wait for initial project:state message
      await waitForMessage(messages, 'project:state');

      // Share terminal data
      server.shareTerminalData(42, 'hello world');

      const msg = await waitForMessage(messages, 'terminal:shared-data');
      expect(msg.data.id).toBe(42);
      expect(msg.data.data).toBe('hello world');

      client.close();
    });

    it('shareTerminalExit broadcasts exit and notification', async () => {
      server = createServer();
      await server.start(nextPort());

      const { ws: client, messages } = await connectWS(server.port, server.token);
      await waitForMessage(messages, 'project:state');

      server.shareTerminalData(42, 'test'); // mark as active
      server.shareTerminalExit(42, 0);

      const exitMsg = await waitForMessage(messages, 'terminal:shared-exit');
      expect(exitMsg.data.id).toBe(42);
      expect(exitMsg.data.exitCode).toBe(0);

      const notifMsg = await waitForMessage(messages, 'notification');
      expect(notifMsg.data.title).toBe('Terminal Exited');

      client.close();
    });

    it('buffers terminal data for late joiners (max 50KB)', async () => {
      server = createServer();
      await server.start(nextPort());

      // Fill buffer
      const bigChunk = 'x'.repeat(30000);
      server.shareTerminalData(99, bigChunk);
      server.shareTerminalData(99, bigChunk);

      // Buffer should be capped at 50KB
      const session = server.sharedTerminals.get(99);
      expect(session.buffer.length).toBe(50000);
    });

    it('getSharedTerminals returns active sessions', async () => {
      server = createServer();
      await server.start(nextPort());

      server.shareTerminalData(1, 'test');
      server.shareTerminalData(2, 'test');
      server.shareTerminalExit(2, 0);

      const sessions = server.getSharedTerminals();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe(1);
    });
  });

  describe('WebSocket messages', () => {
    it('sends initial project state on connect', async () => {
      server = createServer();
      await server.start(nextPort());

      const { ws: client, messages } = await connectWS(server.port, server.token);
      const msg = await waitForMessage(messages, 'project:state');

      expect(msg.data.found).toBe(true);
      expect(msg.data.epics).toHaveLength(1);
      // Content should be stripped
      expect(msg.data.epics[0].stories[0].content).toBeUndefined();

      client.close();
    });

    it('rejects WebSocket with invalid token', async () => {
      server = createServer();
      await server.start(nextPort());

      const ws = new WebSocket(`ws://127.0.0.1:${server.port}?token=invalid`);
      await new Promise((resolve) => {
        ws.on('close', (code) => {
          expect(code).toBe(4001);
          resolve();
        });
      });
    });

    it('handles terminal:create message', async () => {
      server = createServer();
      await server.start(nextPort());

      const { ws: client, messages } = await connectWS(server.port, server.token);
      await waitForMessage(messages, 'project:state');

      client.send(JSON.stringify({ type: 'terminal:create', data: { cols: 80, rows: 24 } }));
      const msg = await waitForMessage(messages, 'terminal:created');
      expect(msg.data.id).toBeDefined();

      client.close();
    });

    it('handles project:refresh message', async () => {
      server = createServer();
      await server.start(nextPort());

      const { ws: client, messages } = await connectWS(server.port, server.token);
      await waitForMessage(messages, 'project:state');

      // Clear previous messages
      messages.length = 0;

      client.send(JSON.stringify({ type: 'project:refresh' }));
      const msg = await waitForMessage(messages, 'project:state');
      expect(msg.data.found).toBe(true);

      client.close();
    });

    it('handles terminal:list-shared message', async () => {
      server = createServer();
      await server.start(nextPort());

      // Create a shared terminal session
      server.shareTerminalData(42, 'test output');

      const { ws: client, messages } = await connectWS(server.port, server.token);
      await waitForMessage(messages, 'project:state');

      client.send(JSON.stringify({ type: 'terminal:list-shared' }));
      const msg = await waitForMessage(messages, 'terminal:shared-list');
      expect(msg.data.sessions).toHaveLength(1);
      expect(msg.data.sessions[0].id).toBe(42);

      client.close();
    });

    it('handles terminal:watch message with buffered data', async () => {
      server = createServer();
      await server.start(nextPort());

      // Pre-populate shared terminal
      server.shareTerminalData(42, 'buffered output');

      const { ws: client, messages } = await connectWS(server.port, server.token);
      await waitForMessage(messages, 'project:state');

      client.send(JSON.stringify({ type: 'terminal:watch', data: { id: 42 } }));
      const msg = await waitForMessage(messages, 'terminal:shared-data');
      expect(msg.data.id).toBe(42);
      expect(msg.data.data).toBe('buffered output');

      client.close();
    });

    it('handles story:advance via WebSocket', async () => {
      let advancedSlug, advancedPhase;
      server = createServer({
        updateStoryStatus: (projPath, slug, newPhase) => {
          advancedSlug = slug;
          advancedPhase = newPhase;
        }
      });
      await server.start(nextPort());

      const { ws: client, messages } = await connectWS(server.port, server.token);
      await waitForMessage(messages, 'project:state');

      client.send(JSON.stringify({ type: 'story:advance', data: { slug: '1-1-test-story' } }));
      const msg = await waitForMessage(messages, 'story:advanced');

      expect(msg.data.slug).toBe('1-1-test-story');
      expect(msg.data.oldPhase).toBe('in-progress');
      expect(msg.data.newPhase).toBe('review');
      expect(advancedSlug).toBe('1-1-test-story');
      expect(advancedPhase).toBe('review');

      client.close();
    });

    it('handles ping/pong heartbeat', async () => {
      server = createServer();
      await server.start(nextPort());

      const { ws: client, messages } = await connectWS(server.port, server.token);
      await waitForMessage(messages, 'project:state');

      client.send(JSON.stringify({ type: 'ping' }));
      const msg = await waitForMessage(messages, 'pong');
      expect(msg.type).toBe('pong');

      client.close();
    });

    it('cleans up terminal sessions on client disconnect', async () => {
      const tm = createMockTerminalManager();
      server = createServer({ terminalManager: tm });
      await server.start(nextPort());

      const { ws: client, messages } = await connectWS(server.port, server.token);
      await waitForMessage(messages, 'project:state');

      // Create a terminal session
      client.send(JSON.stringify({ type: 'terminal:create', data: { cols: 80, rows: 24 } }));
      const created = await waitForMessage(messages, 'terminal:created');
      const sessionId = created.data.id;
      expect(tm.sessions.has(sessionId)).toBe(true);

      // Disconnect
      client.close();

      // Wait a bit for cleanup
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(tm.sessions.has(sessionId)).toBe(false);
    });

    it('rejects terminal:input for unowned session', async () => {
      const tm = createMockTerminalManager();
      let writeCalledWith = null;
      const origWrite = tm.write;
      tm.write = (id, data) => { writeCalledWith = { id, data }; origWrite(id, data); };

      server = createServer({ terminalManager: tm });
      await server.start(nextPort());

      const { ws: client, messages } = await connectWS(server.port, server.token);
      await waitForMessage(messages, 'project:state');

      // Try to write to a session ID this client doesn't own
      client.send(JSON.stringify({ type: 'terminal:input', data: { id: 999, input: 'hack\n' } }));
      // Give time for message to be processed
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(writeCalledWith).toBeNull();

      client.close();
    });

    it('emitData/emitExit helpers work on mock terminal manager', () => {
      const tm = createMockTerminalManager();
      let dataReceived = null;
      let exitReceived = null;
      const id = tm.create({
        onData: (sid, d) => { dataReceived = { sid, d }; },
        onExit: (sid, c) => { exitReceived = { sid, c }; }
      });
      tm.emitData(id, 'hello');
      expect(dataReceived).toEqual({ sid: id, d: 'hello' });
      tm.emitExit(id, 0);
      expect(exitReceived).toEqual({ sid: id, c: 0 });
    });

    it('rotateToken disconnects existing clients', async () => {
      server = createServer();
      await server.start(nextPort());

      const { ws: client, messages } = await connectWS(server.port, server.token);
      await waitForMessage(messages, 'project:state');

      const oldToken = server.token;
      const newToken = server.rotateToken();

      expect(newToken).not.toBe(oldToken);

      // Client should be disconnected
      await new Promise((resolve) => {
        client.on('close', (code) => {
          expect(code).toBe(4001);
          resolve();
        });
      });
    });
  });

  // ── shareTerminalStart (new in this PR) ─────────────────────────────

  describe('shareTerminalStart', () => {
    it('registers a session with story metadata', () => {
      server = createServer();
      server.shareTerminalStart(100, { storySlug: '1-1-my-story', storyPhase: 'in-progress', command: 'claude dev' });

      const session = server.sharedTerminals.get(100);
      expect(session).toBeDefined();
      expect(session.storySlug).toBe('1-1-my-story');
      expect(session.storyPhase).toBe('in-progress');
      expect(session.command).toBe('claude dev');
      expect(session.active).toBe(true);
      expect(session.buffer).toBe('');
      expect(typeof session.startedAt).toBe('number');
    });

    it('registers a session with no story metadata when opts are omitted', () => {
      server = createServer();
      server.shareTerminalStart(200);

      const session = server.sharedTerminals.get(200);
      expect(session).toBeDefined();
      expect(session.storySlug).toBeNull();
      expect(session.storyPhase).toBeNull();
      expect(session.command).toBeNull();
      expect(session.active).toBe(true);
    });

    it('broadcasts stories:active to connected clients via broadcast()', () => {
      server = createServer();
      // Use a mock WS client to capture broadcast messages
      const sent = [];
      const mockWs = { readyState: 1, send: (msg) => sent.push(JSON.parse(msg)), on: () => {} };
      server.clients.add(mockWs);

      server.shareTerminalStart(77, { storySlug: '2-1-feature', storyPhase: 'review', command: 'claude review' });

      const activeMsg = sent.find(m => m.type === 'stories:active');
      expect(activeMsg).toBeDefined();
      expect(activeMsg.data.stories).toHaveLength(1);
      expect(activeMsg.data.stories[0].slug).toBe('2-1-feature');
      expect(activeMsg.data.stories[0].phase).toBe('review');
      expect(activeMsg.data.stories[0].sessionId).toBe(77);
    });

    it('replaces an existing session for the same sessionId', () => {
      server = createServer();
      server.shareTerminalStart(50, { storySlug: 'old-story', storyPhase: 'backlog' });
      server.shareTerminalStart(50, { storySlug: 'new-story', storyPhase: 'in-progress' });

      expect(server.sharedTerminals.size).toBe(1);
      expect(server.sharedTerminals.get(50).storySlug).toBe('new-story');
    });
  });

  // ── getActiveStories (new in this PR) ───────────────────────────────

  describe('getActiveStories', () => {
    it('returns empty array when no shared terminals', () => {
      server = createServer();
      expect(server.getActiveStories()).toEqual([]);
    });

    it('returns active stories with storySlug set', () => {
      server = createServer();
      server.shareTerminalStart(1, { storySlug: '1-1-foo', storyPhase: 'in-progress', command: 'cmd1' });
      server.shareTerminalStart(2, { storySlug: '1-2-bar', storyPhase: 'review', command: 'cmd2' });

      const active = server.getActiveStories();
      expect(active).toHaveLength(2);
      expect(active.map(s => s.slug)).toContain('1-1-foo');
      expect(active.map(s => s.slug)).toContain('1-2-bar');
    });

    it('excludes sessions without a storySlug', () => {
      server = createServer();
      server.shareTerminalStart(10, { storySlug: 'real-story', storyPhase: 'in-progress' });
      server.shareTerminalData(20, 'some output'); // creates session with null storySlug

      const active = server.getActiveStories();
      expect(active).toHaveLength(1);
      expect(active[0].slug).toBe('real-story');
    });

    it('excludes inactive sessions', () => {
      server = createServer();
      server.shareTerminalStart(30, { storySlug: 'story-a', storyPhase: 'in-progress' });
      server.shareTerminalExit(30, 0);

      expect(server.getActiveStories()).toHaveLength(0);
    });

    it('returns all required fields for each active story', () => {
      server = createServer();
      server.shareTerminalStart(5, { storySlug: 'the-slug', storyPhase: 'review', command: 'my-cmd' });

      const active = server.getActiveStories();
      expect(active).toHaveLength(1);
      const story = active[0];
      expect(story.slug).toBe('the-slug');
      expect(story.phase).toBe('review');
      expect(story.sessionId).toBe(5);
      expect(story.command).toBe('my-cmd');
      expect(typeof story.startedAt).toBe('number');
    });

    it('does not include session data after exit even if another session remains', () => {
      server = createServer();
      server.shareTerminalStart(1, { storySlug: 'active-story', storyPhase: 'in-progress' });
      server.shareTerminalStart(2, { storySlug: 'finished-story', storyPhase: 'review' });
      server.shareTerminalExit(2, 0);

      const active = server.getActiveStories();
      expect(active).toHaveLength(1);
      expect(active[0].slug).toBe('active-story');
    });
  });

  // ── shareTerminalExit updates (changed in this PR) ──────────────────

  describe('shareTerminalExit — story context', () => {
    function makeMockWs() {
      const sent = [];
      return {
        readyState: 1,
        send: (msg) => sent.push(JSON.parse(msg)),
        on: () => {},
        sent
      };
    }

    it('includes story slug in exit notification body', () => {
      server = createServer();
      const mockWs = makeMockWs();
      server.clients.add(mockWs);

      server.shareTerminalStart(42, { storySlug: '1-1-my-story', storyPhase: 'in-progress' });
      server.shareTerminalExit(42, 0);

      const notif = mockWs.sent.find(m => m.type === 'notification');
      expect(notif).toBeDefined();
      expect(notif.data.body).toContain('1-1-my-story');
    });

    it('uses generic notification body when no story slug', () => {
      server = createServer();
      const mockWs = makeMockWs();
      server.clients.add(mockWs);

      server.shareTerminalData(99, 'output'); // creates session with null storySlug
      server.shareTerminalExit(99, 1);

      const notif = mockWs.sent.find(m => m.type === 'notification');
      expect(notif).toBeDefined();
      expect(notif.data.body).toMatch(/Session ended with code/);
      expect(notif.data.body).not.toContain('(');
    });

    it('broadcasts stories:active after exit', () => {
      server = createServer();
      const mockWs = makeMockWs();
      server.clients.add(mockWs);

      server.shareTerminalStart(11, { storySlug: 'story-x', storyPhase: 'in-progress' });
      const beforeCount = mockWs.sent.length;
      server.shareTerminalExit(11, 0);

      const afterMessages = mockWs.sent.slice(beforeCount);
      const activeMsg = afterMessages.find(m => m.type === 'stories:active');
      expect(activeMsg).toBeDefined();
      expect(activeMsg.data.stories).toHaveLength(0);
    });

    it('sets notification type to success on exit code 0', () => {
      server = createServer();
      const mockWs = makeMockWs();
      server.clients.add(mockWs);

      server.shareTerminalStart(12, { storySlug: 'story-ok' });
      server.shareTerminalExit(12, 0);

      const notif = mockWs.sent.find(m => m.type === 'notification');
      expect(notif.data.type).toBe('success');
    });

    it('sets notification type to error on non-zero exit code', () => {
      server = createServer();
      const mockWs = makeMockWs();
      server.clients.add(mockWs);

      server.shareTerminalStart(13, { storySlug: 'story-fail' });
      server.shareTerminalExit(13, 1);

      const notif = mockWs.sent.find(m => m.type === 'notification');
      expect(notif.data.type).toBe('error');
    });
  });

  // ── getSharedTerminals updates (changed in this PR) ─────────────────

  describe('getSharedTerminals — story fields', () => {
    it('includes storySlug, storyPhase, command in active session listing', () => {
      server = createServer();
      server.shareTerminalStart(55, { storySlug: 'ep1-story', storyPhase: 'in-progress', command: 'claude' });
      server.shareTerminalData(55, 'output'); // ensure buffered

      const sessions = server.getSharedTerminals();
      expect(sessions).toHaveLength(1);
      const s = sessions[0];
      expect(s.id).toBe(55);
      expect(s.storySlug).toBe('ep1-story');
      expect(s.storyPhase).toBe('in-progress');
      expect(s.command).toBe('claude');
    });

    it('returns null for story fields on non-story sessions', () => {
      server = createServer();
      server.shareTerminalData(66, 'plain output');

      const sessions = server.getSharedTerminals();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].storySlug).toBeNull();
      expect(sessions[0].storyPhase).toBeNull();
      expect(sessions[0].command).toBeNull();
    });
  });

  // ── WS story:launch (new in this PR) ────────────────────────────────
  //
  // Tests call _handleWSMessage directly with a mock WebSocket to avoid
  // TCP connections (loopback is restricted in this environment).

  describe('WebSocket story:launch', () => {
    function makeMockClient() {
      const sent = [];
      const ws = {
        readyState: 1,
        send: (msg) => sent.push(JSON.parse(msg)),
        on: () => {},
        sent
      };
      return ws;
    }

    function registerMockClient(srv, mockWs) {
      srv.clients.add(mockWs);
      srv.clientTerminals.set(mockWs, new Set());
    }

    it('launches command and sends story:task-launched feedback', () => {
      let launchedCmd, launchedSlug, launchedPhase;
      server = createServer({
        launchOnDesktop: (cmd, slug, phase) => {
          launchedCmd = cmd;
          launchedSlug = slug;
          launchedPhase = phase;
        }
      });
      const mockWs = makeMockClient();
      registerMockClient(server, mockWs);

      server._handleWSMessage(mockWs, { type: 'story:launch', data: { slug: '1-1-test-story' } });

      const launched = mockWs.sent.find(m => m.type === 'story:task-launched');
      expect(launched).toBeDefined();
      expect(launched.data.slug).toBe('1-1-test-story');
      expect(launched.data.phase).toBe('in-progress');
      expect(launched.data.command).toBeTruthy();
      expect(launchedSlug).toBe('1-1-test-story');
      expect(launchedPhase).toBe('in-progress');
      expect(launchedCmd).toBeTruthy();
    });

    it('sends error when story slug is not found', () => {
      server = createServer({ launchOnDesktop: () => {} });
      const mockWs = makeMockClient();
      registerMockClient(server, mockWs);

      server._handleWSMessage(mockWs, { type: 'story:launch', data: { slug: 'nonexistent-story' } });

      const errMsg = mockWs.sent.find(m => m.type === 'error');
      expect(errMsg).toBeDefined();
      expect(errMsg.data.message).toMatch(/Story not found/);
    });

    it('sends error when buildCommand returns null', () => {
      server = createServer({
        launchOnDesktop: () => {},
        buildCommand: () => null
      });
      const mockWs = makeMockClient();
      registerMockClient(server, mockWs);

      server._handleWSMessage(mockWs, { type: 'story:launch', data: { slug: '1-1-test-story' } });

      const errMsg = mockWs.sent.find(m => m.type === 'error');
      expect(errMsg).toBeDefined();
      expect(errMsg.data.message).toMatch(/No command available/);
    });

    it('does nothing when launchOnDesktop is not configured', () => {
      server = createServer({ launchOnDesktop: null });
      const mockWs = makeMockClient();
      registerMockClient(server, mockWs);

      server._handleWSMessage(mockWs, { type: 'story:launch', data: { slug: '1-1-test-story' } });

      expect(mockWs.sent.filter(m => m.type === 'story:task-launched')).toHaveLength(0);
    });

    it('ignores message when slug is missing', () => {
      server = createServer({ launchOnDesktop: () => {} });
      const mockWs = makeMockClient();
      registerMockClient(server, mockWs);

      server._handleWSMessage(mockWs, { type: 'story:launch', data: {} });

      // slug is undefined, handler should break early without sending anything
      expect(mockWs.sent.filter(m => m.type === 'story:task-launched')).toHaveLength(0);
      expect(mockWs.sent.filter(m => m.type === 'error')).toHaveLength(0);
    });
  });

  // ── WS stories:list-active (new in this PR) ──────────────────────────

  describe('WebSocket stories:list-active', () => {
    function makeMockClient() {
      const sent = [];
      return {
        readyState: 1,
        send: (msg) => sent.push(JSON.parse(msg)),
        on: () => {},
        sent
      };
    }

    it('returns current active stories list', () => {
      server = createServer();
      server.shareTerminalStart(77, { storySlug: 'active-1', storyPhase: 'in-progress' });

      const mockWs = makeMockClient();
      server.clients.add(mockWs);
      server.clientTerminals.set(mockWs, new Set());

      server._handleWSMessage(mockWs, { type: 'stories:list-active' });

      const msg = mockWs.sent.find(m => m.type === 'stories:active');
      expect(msg).toBeDefined();
      expect(msg.data.stories).toHaveLength(1);
      expect(msg.data.stories[0].slug).toBe('active-1');
    });

    it('returns empty list when no active stories', () => {
      server = createServer();

      const mockWs = makeMockClient();
      server.clients.add(mockWs);
      server.clientTerminals.set(mockWs, new Set());

      server._handleWSMessage(mockWs, { type: 'stories:list-active' });

      const msg = mockWs.sent.find(m => m.type === 'stories:active');
      expect(msg).toBeDefined();
      expect(msg.data.stories).toHaveLength(0);
    });
  });

  // ── WS story:advance with launchOnDesktop (changed in this PR) ──────

  describe('WebSocket story:advance — task-launched feedback', () => {
    function makeMockClient() {
      const sent = [];
      return {
        readyState: 1,
        send: (msg) => sent.push(JSON.parse(msg)),
        on: () => {},
        sent
      };
    }

    it('sends story:task-launched after advancing when launchOnDesktop is configured', () => {
      let launchedArgs = null;
      server = createServer({
        updateStoryStatus: () => {},
        launchOnDesktop: (cmd, slug, phase) => { launchedArgs = { cmd, slug, phase }; }
      });

      const mockWs = makeMockClient();
      server.clients.add(mockWs);
      server.clientTerminals.set(mockWs, new Set());

      server._handleWSMessage(mockWs, { type: 'story:advance', data: { slug: '1-1-test-story' } });

      const advanced = mockWs.sent.find(m => m.type === 'story:advanced');
      expect(advanced).toBeDefined();
      expect(advanced.data.newPhase).toBe('review');

      const launched = mockWs.sent.find(m => m.type === 'story:task-launched');
      expect(launched).toBeDefined();
      expect(launched.data.slug).toBe('1-1-test-story');
      expect(launched.data.phase).toBe('review');
      expect(launched.data.command).toBeTruthy();
      expect(launchedArgs.slug).toBe('1-1-test-story');
    });

    it('does not send story:task-launched when launchOnDesktop is absent', () => {
      server = createServer({
        updateStoryStatus: () => {},
        launchOnDesktop: null
      });

      const mockWs = makeMockClient();
      server.clients.add(mockWs);
      server.clientTerminals.set(mockWs, new Set());

      server._handleWSMessage(mockWs, { type: 'story:advance', data: { slug: '1-1-test-story' } });

      const advanced = mockWs.sent.find(m => m.type === 'story:advanced');
      expect(advanced).toBeDefined(); // story was still advanced

      expect(mockWs.sent.filter(m => m.type === 'story:task-launched')).toHaveLength(0);
    });
  });

  // ── Initial WS connection sends stories:active (new in this PR) ─────

  describe('WebSocket initial connection — stories:active', () => {
    function makeMockRequest(token) {
      return { url: `/?token=${token}` };
    }

    it('sends stories:active on connect when active stories exist', () => {
      server = createServer();

      // Register an active story session before the client connects
      server.shareTerminalStart(88, { storySlug: 'already-running', storyPhase: 'in-progress' });

      const sent = [];
      const mockWs = {
        readyState: 1,
        _authToken: undefined,
        isAlive: undefined,
        send: (msg) => sent.push(JSON.parse(msg)),
        on: () => {},
        close: () => {}
      };

      server._handleWS(mockWs, makeMockRequest(server.token));

      const activeMsg = sent.find(m => m.type === 'stories:active');
      expect(activeMsg).toBeDefined();
      expect(activeMsg.data.stories).toHaveLength(1);
      expect(activeMsg.data.stories[0].slug).toBe('already-running');
    });

    it('does not send stories:active on connect when no active stories', () => {
      server = createServer();

      const sent = [];
      const mockWs = {
        readyState: 1,
        _authToken: undefined,
        isAlive: undefined,
        send: (msg) => sent.push(JSON.parse(msg)),
        on: () => {},
        close: () => {}
      };

      server._handleWS(mockWs, makeMockRequest(server.token));

      expect(sent.filter(m => m.type === 'stories:active')).toHaveLength(0);
      // project:state is sent instead
      expect(sent.find(m => m.type === 'project:state')).toBeDefined();
    });

    it('rejects connection with invalid token', () => {
      server = createServer();

      const closed = [];
      const mockWs = {
        readyState: 1,
        send: () => {},
        on: () => {},
        close: (code, msg) => closed.push({ code, msg })
      };

      server._handleWS(mockWs, { url: '/?token=wrong-token' });

      expect(closed).toHaveLength(1);
      expect(closed[0].code).toBe(4001);
    });
  });
});