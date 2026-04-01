/**
 * @module terminal-launcher
 * @description Opens external Terminal.app windows with pre-configured commands.
 * macOS-specific — uses AppleScript (`osascript`) for reliable Terminal.app control,
 * with a fallback to `open -a Terminal.app`.
 *
 * Used by the main process to launch LLM CLI tools (Claude, Codex, etc.) in
 * a native terminal window when the user triggers a story phase command.
 */

const childProcess = require('child_process');

// Testable exec reference — override via _setExec for testing
let _exec = childProcess.exec;

/**
 * Open a new Terminal.app window, change to the specified project directory, and run the given shell command.
 *
 * @param {string} projectPath - Absolute path to the project directory; single quotes will be escaped for safe embedding.
 * @param {string} command - Shell command to execute in the terminal; single quotes will be escaped.
 * @returns {Promise<void>} No value.
 */
function openTerminal(projectPath, command) {
  // Escape single quotes for AppleScript
  const escapedPath = projectPath.replace(/'/g, "'\\''");
  const escapedCmd = command.replace(/'/g, "'\\''");

  const script = `
    tell application "Terminal"
      activate
      do script "cd '${escapedPath}' && ${escapedCmd}"
    end tell
  `;

  return new Promise((resolve, reject) => {
    _exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (error) => {
      if (error) {
        // Fallback: try open command
        _exec(`open -a Terminal.app`, (err2) => {
          if (err2) reject(err2);
          else resolve();
        });
      } else {
        resolve();
      }
    });
  });
}

/**
 * Open an external terminal and execute a Claude CLI command.
 * Convenience wrapper around {@link openTerminal}.
 *
 * @param {string} projectPath - Absolute path to the project directory.
 * @param {string} claudeCommand - The full Claude CLI command string (e.g. `claude "/implement story-1"`).
 * @returns {Promise<void>}
 */
function openClaudeWithCommand(projectPath, claudeCommand) {
  return openTerminal(projectPath, claudeCommand);
}

/**
 * Launches Terminal.app at the given project directory and runs Claude's "/retrospective" command.
 *
 * @param {string} projectPath - Absolute path to the project directory.
 * @returns {Promise<void>} Resolves when the terminal has been launched and the command started; rejects if both the AppleScript and fallback open attempts fail.
 */
function openPartyMode(projectPath) {
  return openTerminal(projectPath, 'claude "/retrospective"');
}

/**
 * Replace the internal exec implementation used to run shell commands.
 * This is primarily used to inject a custom exec function for testing.
 * Pass null/undefined to reset to the default.
 * @param {function|null} fn - A function compatible with Node's `child_process.exec` signature, or null to reset.
 */
function _setExec(fn) {
  if (fn != null && typeof fn !== 'function') {
    throw new TypeError('_setExec expects a function or null');
  }
  _exec = fn || childProcess.exec;
}

module.exports = { openTerminal, openClaudeWithCommand, openPartyMode, _setExec };
