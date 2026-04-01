/**
 * Phase Detection — detects story phase changes between two snapshots.
 *
 * Extracted from app.js so it can be tested independently and reused
 * in both the renderer and tests without duplication.
 */

/**
 * Find stories whose status changed between a previous slug→status map and the current epics.
 * @param {Object<string, string>} previousStates - Mapping of story `slug` to its previous `status`.
 * @param {Array<Object>} [currentEpics=[]] - Array of epic objects; each epic may include a `stories` array of story objects.
 * @returns {Array<{slug: string, title: string, epicNumber: number, storyNumber: number, from: string, to: string}>} Array of change records with `from` (previous status) and `to` (current status).
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
 * Produce a mapping of story slugs to their current statuses from a list of epics.
 * @param {Array} epics - Array of epic objects; each epic may include a `stories` array of story objects.
 * @returns {Object<string,string>} An object mapping each story `slug` to its `status`.
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
