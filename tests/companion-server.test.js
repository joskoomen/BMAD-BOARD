/**
 * Tests for the Companion Server (HTTP + WebSocket).
 */

const http = require('http');
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
    has(id) { return sessions.has(id); }
  };
}

function createServer(overrides = {}) {
  return new CompanionServer({
    terminalManager: createMockTerminalManager(),
    scanProject: () => ({
      found: true,
      projectPath: '/tmp/test-project',
      config: {},
      projectMeta: { name: 'Test Project' },
      epics: [
        {
          number: 1,
          title: 'Test Epic',
          status: 'in-progress',
          stories: [
            { slug: '1-1-test-story', title: 'Test Story', status: 'done', storyNumber: '1', epicNumber: 1, filePath: null, content: 'Hello' }
          ],
          retrospective: null
        }
      ],
      documents: [
        { category: 'Planning', name: 'PRD', filename: 'prd.md', filePath: '/tmp/prd.md', content: '# PRD' }
      ]
    }),
    getProjectPath: () => '/tmp/test-project',
    getSettings: () => ({ defaultLlm: 'claude' }),
    buildCommand: () => 'claude "/dev-story"',
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
      const info = await server.start(nextPort()); // port 0 = random
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
});
