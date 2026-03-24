/**
 * LLM Provider Abstraction
 *
 * Defines provider interfaces for supported LLMs (Claude, Codex, Cursor, Aider, Open Code).
 * Each provider specifies how to build commands, whether it supports session resume,
 * and how to translate BMAD slash commands.
 */

const LLM_PROVIDERS = {
  claude: {
    name: 'Claude Code',
    binary: 'claude',
    supportsSessionId: true,
    supportsResume: true,
    buildCommand(slashCommand, opts) {
      const { sessionId, resume } = opts || {};
      if (resume && sessionId) {
        return `${this.binary} --resume ${sessionId}`;
      }
      if (sessionId && slashCommand) {
        return `${this.binary} --session-id ${sessionId} "${slashCommand}"`;
      }
      if (slashCommand) {
        return `${this.binary} "${slashCommand}"`;
      }
      return this.binary;
    },
    buildResumeCommand(sessionId) {
      return `${this.binary} --resume ${sessionId}`;
    },
    translateCommand(slashCommand, storyFilePath) {
      // Claude supports BMAD slash commands natively
      if (storyFilePath) {
        return `${slashCommand} ${storyFilePath}`;
      }
      return slashCommand;
    },
    detectState(output) {
      // Basic heuristic: if recent output contains thinking indicators
      if (!output) return 'unknown';
      return 'unknown';
    }
  },

  codex: {
    name: 'Codex CLI',
    binary: 'codex',
    supportsSessionId: false,
    supportsResume: false,
    buildCommand(prompt, opts) {
      const extra = opts?.extraArgs || '';
      if (prompt) {
        return `${this.binary}${extra ? ' ' + extra : ''} "${prompt}"`;
      }
      return `${this.binary}${extra ? ' ' + extra : ''}`;
    },
    buildResumeCommand() {
      return null; // Not supported
    },
    translateCommand(slashCommand, storyFilePath) {
      // Translate BMAD slash commands to Codex prompts
      const cmdMap = {
        '/bmad-bmm-dev-story': 'Read the BMAD workflow and implement the story',
        '/bmad-bmm-create-story': 'Create a new story specification',
        '/bmad-bmm-code-review': 'Perform a thorough code review',
        '/bmad-bmm-sprint-status': 'Summarize the current sprint status',
      };
      const baseCmd = slashCommand.split(' ')[0];
      const prompt = cmdMap[baseCmd] || `Execute: ${slashCommand}`;
      if (storyFilePath) {
        return `${prompt} at ${storyFilePath}`;
      }
      return prompt;
    },
    detectState() {
      return 'unknown';
    }
  },

  cursor: {
    name: 'Cursor',
    binary: 'cursor',
    supportsSessionId: false,
    supportsResume: false,
    buildCommand(filePath) {
      if (filePath) {
        return `${this.binary} "${filePath}"`;
      }
      return `${this.binary} .`;
    },
    buildResumeCommand() {
      return null; // Not supported
    },
    translateCommand(slashCommand, storyFilePath) {
      // Cursor opens files in the IDE
      return storyFilePath || '.';
    },
    detectState() {
      return 'unknown';
    }
  },

  aider: {
    name: 'Aider',
    binary: 'aider',
    supportsSessionId: false,
    supportsResume: false,
    buildCommand(prompt, opts) {
      if (prompt) {
        return `${this.binary} --message "${prompt}"`;
      }
      return this.binary;
    },
    buildResumeCommand() {
      return null; // Not supported
    },
    translateCommand(slashCommand, storyFilePath) {
      const cmdMap = {
        '/bmad-bmm-dev-story': 'implement the story',
        '/bmad-bmm-create-story': 'create a story specification',
        '/bmad-bmm-code-review': 'review the code changes',
      };
      const baseCmd = slashCommand.split(' ')[0];
      const prompt = cmdMap[baseCmd] || slashCommand;
      if (storyFilePath) {
        return `${prompt} per ${storyFilePath}`;
      }
      return prompt;
    },
    detectState() {
      return 'unknown';
    }
  },

  opencode: {
    name: 'Open Code',
    binary: 'opencode',
    supportsSessionId: false,
    supportsResume: false,
    buildCommand(prompt, opts) {
      if (prompt) {
        return `${this.binary} "${prompt}"`;
      }
      return this.binary;
    },
    buildResumeCommand() {
      return null; // Not supported
    },
    translateCommand(slashCommand, storyFilePath) {
      // Translate BMAD slash commands to natural language prompts for Open Code
      const cmdMap = {
        '/bmad-bmm-dev-story': 'Implement the story according to the spec',
        '/bmad-bmm-create-story': 'Create a new story specification',
        '/bmad-bmm-code-review': 'Perform a thorough code review',
        '/bmad-bmm-sprint-status': 'Summarize the current sprint status',
        '/bmad-bmm-quick-spec': 'Create a quick tech spec',
        '/bmad-bmm-quick-dev': 'Implement this quick spec',
      };
      const baseCmd = slashCommand.split(' ')[0];
      const prompt = cmdMap[baseCmd] || `Execute: ${slashCommand}`;
      if (storyFilePath) {
        return `${prompt} at ${storyFilePath}`;
      }
      return prompt;
    },
    detectState() {
      return 'unknown';
    }
  }
};

/**
 * Get a provider by key.
 * @param {string} key - Provider key (claude, codex, cursor, aider)
 * @returns {object} Provider object
 */
function getProvider(key) {
  return LLM_PROVIDERS[key] || LLM_PROVIDERS.claude;
}

/**
 * Get all provider keys.
 * @returns {string[]}
 */
function getProviderKeys() {
  return Object.keys(LLM_PROVIDERS);
}

/**
 * Get provider list with names for UI dropdowns.
 * @returns {Array<{key: string, name: string}>}
 */
function getProviderList() {
  return Object.entries(LLM_PROVIDERS).map(([key, p]) => ({
    key,
    name: p.name
  }));
}

module.exports = { LLM_PROVIDERS, getProvider, getProviderKeys, getProviderList };
