/**
 * Phase Detection — detects story phase changes between two snapshots.
 *
 * Extracted from app.js so it can be tested independently and reused
 * in both the renderer and tests without duplication.
 */

/**
 * Detect phase changes between a previous state snapshot and current epics.
 * @param {Object<string, string>} previousStates - Map of slug -> previous status
 * @param {Array} currentEpics - Array of epic objects with stories
 * @returns {Array<{slug, title, epicNumber, storyNumber, from, to}>}
 */
function detectPhaseChanges(previousStates, currentEpics = []) {
  const changes = [];
  for (const epic of currentEpics) {
    for (const story of (epic.stories || [])) {
      const prev = previousStates[story.slug];
      if (prev && prev !== story.status) {
        changes.push({
          slug: story.slug,
          title: story.title,
          epicNumber: story.epicNumber,
          storyNumber: story.storyNumber,
          from: prev,
          to: story.status
        });
      }
    }
  }
  return changes;
}

/**
 * Create a snapshot of current story states from epics.
 * @param {Array} epics - Array of epic objects with stories
 * @returns {Object<string, string>} Map of slug -> status
 */
function snapshotStates(epics = []) {
  const states = {};
  for (const epic of epics) {
    for (const story of (epic.stories || [])) {
      states[story.slug] = story.status;
    }
  }
  return states;
}

module.exports = { detectPhaseChanges, snapshotStates };
