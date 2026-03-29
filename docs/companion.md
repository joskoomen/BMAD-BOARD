# Companion PWA

The Companion is a mobile-friendly Progressive Web App (PWA) that connects to the BMAD Board desktop app over the local network. It allows you to monitor and interact with your project from a phone or tablet.

## Architecture

```
┌──────────────────────────────┐         ┌──────────────────────────────┐
│  Desktop (Electron)          │         │  Mobile (PWA)                │
│                              │  HTTP   │                              │
│  CompanionServer             │◄───────►│  companion/app.js            │
│  (lib/companion-server.js)   │  + WS   │  companion/index.html        │
│                              │         │  companion/sw.js             │
│  ├── HTTP static server      │         │                              │
│  ├── REST API endpoints      │         │  Features:                   │
│  ├── WebSocket handler       │         │  ├── Epic/story dashboard    │
│  └── Terminal session sharing│         │  ├── Terminal viewer          │
│                              │         │  ├── Phase advancement        │
│  Port 3939 (configurable)    │         │  ├── Push notifications       │
│  Token-based auth            │         │  └── Offline support (SW)     │
└──────────────────────────────┘         └──────────────────────────────┘
```

## Server (companion-server.js)

### CompanionServer Class

```javascript
const server = new CompanionServer({
  terminalManager,                    // TerminalManager instance
  scanProject: (path) => { ... },     // Project scanner function
  getProjectPath: () => path,         // Current project path getter
  getSettings: () => settings,        // Settings getter
  buildCommand: (phase, slug, file) => cmd, // Command builder
  updateStoryStatus: (path, slug, phase) => { ... }, // Phase updater
  launchOnDesktop: (cmd, slug, phase) => { ... }     // Desktop launcher
});

await server.start(3939);            // Start on port 3939
const info = server.getConnectionInfo(); // { url, token, qrDataUrl }
server.rotateToken();                // Generate new auth token
server.broadcast('notification', { title, body }); // Send to all clients
server.stop();                       // Shutdown
```

### Authentication

All requests require a Bearer token in the `Authorization` header:

```
Authorization: Bearer <token>
```

The token is auto-generated on first start and persisted in preferences. It can be regenerated from the settings UI. The connection URL with token is displayed as a QR code for easy mobile scanning.

### REST API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/status` | Server status (also used for auth check) |
| `GET` | `/api/project` | Current project data (epics, stories, documents) |
| `GET` | `/api/epics` | List of epics |
| `GET` | `/api/story/:slug` | Single story details |
| `GET` | `/api/documents` | Document list |
| `GET` | `/api/settings` | App settings |
| `POST` | `/api/launch-command` | Build an LLM command for a story phase |
| `POST` | `/api/story/:slug/advance` | Advance a story to the next phase |
| `POST` | `/api/push/subscribe` | Register for push notifications |

### WebSocket Messages

#### Client → Server

| Type | Data | Description |
|------|------|-------------|
| `terminal:create` | `{ cols, rows }` | Create a new PTY session |
| `terminal:input` | `{ id, input }` | Send input to terminal |
| `terminal:resize` | `{ id, cols, rows }` | Resize terminal |
| `terminal:kill` | `{ id }` | Kill terminal session |
| `terminal:list-shared` | — | Request list of desktop terminal sessions |
| `terminal:watch` | `{ id }` | Subscribe to a shared desktop terminal |
| `project:refresh` | — | Request project data refresh |
| `story:advance` | `{ slug }` | Advance story to next phase |

#### Server → Client

| Type | Data | Description |
|------|------|-------------|
| `project:state` | `{ epics, documents, ... }` | Full project state update |
| `terminal:created` | `{ id }` | Terminal session created |
| `terminal:data` | `{ data }` | Terminal output stream |
| `terminal:exit` | `{ exitCode }` | Terminal session ended |
| `terminal:shared-data` | `{ data }` | Shared desktop terminal output |
| `terminal:shared-exit` | `{ exitCode }` | Shared desktop terminal ended |
| `terminal:shared-list` | `{ sessions }` | Available shared terminals |
| `story:advanced` | `{ slug, oldPhase, newPhase }` | Story phase changed |
| `notification` | `{ title, body }` | Push notification |
| `pong` | — | Heartbeat response |

## PWA Client (companion/app.js)

### Connection Flow

1. User scans QR code → Opens `http://<ip>:3939?token=<token>`
2. Client extracts token from URL params
3. `apiFetch('/api/status')` — Validates authentication
4. Saves credentials to `localStorage` for auto-reconnect
5. Opens WebSocket connection: `ws://<ip>:3939?token=<token>`
6. Loads project data and renders dashboard

### Auto-Reconnect

If the WebSocket connection drops, the client uses exponential backoff:
- Delay: `min(1000 * 2^attempts, 30000)` ms
- Max attempts: 10
- Resets on successful connection

### Views

| View | Description |
|------|-------------|
| `connect` | Login screen with URL input |
| `dashboard` | Epic cards with progress bars and phase dots |
| `epic` | Story list for a single epic with advance buttons |
| `terminal` | Terminal output viewer (own session or shared desktop) |

### Terminal Modes

The companion supports two terminal modes:

1. **Own Session** — Creates a PTY session on the server; user can type commands
2. **Shared (Desktop)** — Watches an active desktop terminal session (read-only); useful for monitoring LLM output

Toggle between modes with the mode button in the terminal view.

## Service Worker (companion/sw.js)

### Caching Strategy

- **App Shell** — Cached on install for offline "Add to Home Screen" support
- **API Calls** — Always go to network (never cached)
- **Static Files** — Stale-while-revalidate (serve cached, update in background)

### Push Notifications

The service worker handles:
- Displaying push notifications from the server
- Notification click handling (focuses app window, navigates to relevant view)
- Background message forwarding from the main thread

### Cached Files

```javascript
const SHELL_FILES = [
  '/', '/index.html', '/style.css', '/app.js',
  '/manifest.json', '/icon.svg', '/icon-192.png', '/icon-512.png'
];
```
