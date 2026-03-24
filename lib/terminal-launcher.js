/**
 * Terminal Launcher — opens external Terminal.app with a command.
 * macOS-specific using `open -a Terminal.app` or `osascript`.
 */

const { exec } = require('child_process');

/**
 * Open a new Terminal.app window, cd to projectPath, and run command.
 * Uses osascript for reliable Terminal.app control on macOS.
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
    exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (error) => {
      if (error) {
        // Fallback: try open command
        exec(`open -a Terminal.app`, (err2) => {
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
 * Open terminal with Claude and a specific BMAD command.
 */
function openClaudeWithCommand(projectPath, claudeCommand) {
  return openTerminal(projectPath, claudeCommand);
}

/**
 * Open terminal for Party Mode (retrospective).
 */
function openPartyMode(projectPath) {
  return openTerminal(projectPath, 'claude "/retrospective"');
}

module.exports = { openTerminal, openClaudeWithCommand, openPartyMode };
