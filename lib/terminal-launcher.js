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
 * Open Terminal.app, change to the given project directory, and run a shell command in a new window.
 *
 * @param {string} projectPath - Absolute path to the project directory; single quotes in the path will be escaped for safe embedding in AppleScript.
 * @param {string} command - Shell command to execute in the new terminal window; single quotes in the command will be escaped for safe embedding in AppleScript.
 * @returns {Promise<void>} Resolves with no value when the launch attempt completes; rejects with an error if both the AppleScript launch and the fallback `open -a Terminal.app` fail.
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
 * Open Terminal.app in the given project directory and run the specified Claude CLI command.
 *
 * @param {string} projectPath - Absolute path to the project directory.
 * @param {string} claudeCommand - Full Claude CLI command to run (e.g., `claude "/implement story-1"`).
 */
function openClaudeWithCommand(projectPath, claudeCommand) {
  return openTerminal(projectPath, claudeCommand);
}

/**
 * Open Terminal.app in the specified project directory and run Claude's `/retrospective` command.
 *
 * @param {string} projectPath - Absolute path to the project directory.
 * @returns {Promise<void>} Resolves when a Terminal window has been opened and the command started; rejects if opening Terminal or starting the command fails.
 */
function openPartyMode(projectPath) {
  return openTerminal(projectPath, 'claude "/retrospective"');
}

/**
 * Override the internal command-execution function used by this module.
 * @param {Function} fn - Function compatible with Node's `child_process.exec` signature to use in place of the default executor (commonly used for testing or dependency injection).
 */
function _setExec(fn) {
  if (fn != null && typeof fn !== 'function') {
    throw new TypeError('_setExec expects a function or null');
  }
  _exec = fn || childProcess.exec;
}

module.exports = { openTerminal, openClaudeWithCommand, openPartyMode, _setExec };
