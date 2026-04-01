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
 * Open a new Terminal.app window, change directory to the project, and run a command.
 * Uses AppleScript for reliable Terminal.app control on macOS.
 * Falls back to `open -a Terminal.app` if the AppleScript approach fails.
 *
 * @param {string} projectPath - Absolute path to the project directory.
 * @param {string} command - Shell command to execute in the terminal.
 * @returns {Promise<void>} Resolves when the terminal opens successfully.
 * @throws {Error} If both the AppleScript and fallback methods fail.
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
 * Open an external terminal for BMAD Party Mode (sprint retrospective).
 * Launches Claude with the `/retrospective` slash command.
 *
 * @param {string} projectPath - Absolute path to the project directory.
 * @returns {Promise<void>}
 */
function openPartyMode(projectPath) {
  return openTerminal(projectPath, 'claude "/retrospective"');
}

/**
 * Override the exec function (for testing).
 * @param {function} fn
 */
function _setExec(fn) {
  _exec = fn;
}

module.exports = { openTerminal, openClaudeWithCommand, openPartyMode, _setExec };
