/**
 * Maps story phases to BMAD workflow commands.
 *
 * When a user clicks a phase, we open a terminal with the appropriate
 * LLM provider and BMAD slash command.
 */

const { getProvider } = require('./llm-providers');

const PHASE_ORDER = ['backlog', 'ready-for-dev', 'in-progress', 'review', 'done'];

const PHASE_CONFIG = {
  'backlog': {
    label: 'Backlog',
    color: '#6b7280',
    icon: '○',
    command: '/create-story',
    description: 'Create the story specification'
  },
  'ready-for-dev': {
    label: 'Ready',
    color: '#f59e0b',
    icon: '◐',
    command: '/dev-story',
    description: 'Start developing the story'
  },
  'in-progress': {
    label: 'In Progress',
    color: '#3b82f6',
    icon: '◑',
    command: '/dev-story',
    description: 'Continue development'
  },
  'review': {
    label: 'Review',
    color: '#8b5cf6',
    icon: '◕',
    command: '/code-review',
    description: 'Run code review'
  },
  'done': {
    label: 'Done',
    color: '#10b981',
    icon: '●',
    command: null,
    description: 'Story completed'
  }
};

function getPhaseConfig(status) {
  return PHASE_CONFIG[status] || PHASE_CONFIG['backlog'];
}

function getPhaseIndex(status) {
  const idx = PHASE_ORDER.indexOf(status);
  return idx === -1 ? 0 : idx;
}

function getNextPhase(status) {
  const idx = getPhaseIndex(status);
  if (idx >= PHASE_ORDER.length - 1) return null;
  return PHASE_ORDER[idx + 1];
}

/**
 * Build a command for the given provider and phase.
 * @param {string} phase - Story phase
 * @param {string} storySlug - Story slug
 * @param {string} storyFilePath - Path to story file
 * @param {string} [providerKey='claude'] - LLM provider key
 * @returns {string|null} Command string or null
 */
function buildCommand(phase, storySlug, storyFilePath, providerKey) {
  const config = getPhaseConfig(phase);
  if (!config.command) return null;

  const provider = getProvider(providerKey || 'claude');
  const translated = provider.translateCommand(config.command, storyFilePath);
  return provider.buildCommand(translated);
}

// Backward compatibility
function buildClaudeCommand(phase, storySlug, storyFilePath) {
  return buildCommand(phase, storySlug, storyFilePath, 'claude');
}

module.exports = { PHASE_ORDER, PHASE_CONFIG, getPhaseConfig, getPhaseIndex, getNextPhase, buildCommand, buildClaudeCommand };
