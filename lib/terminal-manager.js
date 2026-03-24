/**
 * Terminal Manager — manages PTY sessions for the embedded Warp-style terminal.
 *
 * Uses node-pty for real terminal emulation with full color, cursor control,
 * and interactive program support.
 */

const os = require('os');
const pty = require('node-pty');

class TerminalManager {
  constructor() {
    this.sessions = new Map(); // id -> { pty, listeners }
    this.nextId = 1;
  }

  /**
   * Create a new PTY session.
   * @param {object} opts
   * @param {string} opts.cwd - Working directory
   * @param {number} opts.cols - Terminal columns
   * @param {number} opts.rows - Terminal rows
   * @param {function} opts.onData - Callback for PTY output data
   * @param {function} opts.onExit - Callback when PTY exits
   * @returns {number} Session ID
   */
  create({ cwd, cols = 120, rows = 30, onData, onExit }) {
    const id = this.nextId++;
    const shell = process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : '/bin/bash');

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: cwd || os.homedir(),
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        LANG: process.env.LANG || 'en_US.UTF-8'
      }
    });

    const session = {
      pty: ptyProcess,
      cwd
    };

    ptyProcess.onData((data) => {
      if (onData) onData(id, data);
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      this.sessions.delete(id);
      if (onExit) onExit(id, exitCode, signal);
    });

    this.sessions.set(id, session);
    return id;
  }

  /**
   * Write data to a PTY session (user input).
   */
  write(id, data) {
    const session = this.sessions.get(id);
    if (session) session.pty.write(data);
  }

  /**
   * Resize a PTY session.
   */
  resize(id, cols, rows) {
    const session = this.sessions.get(id);
    if (session) session.pty.resize(cols, rows);
  }

  /**
   * Kill a PTY session.
   */
  kill(id) {
    const session = this.sessions.get(id);
    if (session) {
      session.pty.kill();
      this.sessions.delete(id);
    }
  }

  /**
   * Kill all sessions.
   */
  killAll() {
    for (const [id] of this.sessions) {
      this.kill(id);
    }
  }

  /**
   * Check if a session exists.
   */
  has(id) {
    return this.sessions.has(id);
  }
}

module.exports = { TerminalManager };
