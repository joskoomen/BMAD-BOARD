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
});
