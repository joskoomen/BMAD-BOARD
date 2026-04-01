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
 * Activate Terminal.app, change to the specified project directory, and run the given shell command in a new Terminal window.
 *
 * @param {string} projectPath - Absolute path to the project directory. Single quotes within the path are escaped for safe embedding in AppleScript.
 * @param {string} command - Shell command to execute in the new Terminal window. Single quotes within the command are escaped for safe embedding in AppleScript.
 * @returns {Promise<void>} Resolves to undefined on success; rejects with the underlying error if both the AppleScript invocation and the fallback `open -a Terminal.app` fail.
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
 * Open Terminal.app and run a Claude CLI command in the given project directory.
 *
 * @param {string} projectPath - Absolute path to the directory where the command will run.
 * @param {string} claudeCommand - The Claude CLI command to execute (e.g. `claude "/implement story-1"`).
 * @returns {Promise<void>} A promise that resolves with no value when the terminal has been launched or the fallback succeeded; rejects if both the AppleScript attempt and the fallback fail.
 */
function openClaudeWithCommand(projectPath, claudeCommand) {
  return openTerminal(projectPath, claudeCommand);
}

/**
 * Open Terminal.app in the specified project directory and run Claude's "/retrospective" command.
 *
 * @param {string} projectPath - Absolute path to the project directory.
 * @returns {Promise<void>} `undefined` when the terminal has been launched and the command started; rejects with the underlying error if both the AppleScript and fallback open attempts fail.
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
