/**
 * Phase Detection — detects story phase changes between two snapshots.
 *
 * Extracted from app.js so it can be tested independently and reused
 * in both the renderer and tests without duplication.
 */

/**
 * Identify stories whose status changed by comparing a previous slug->status snapshot to current epics.
 *
 * Only stories that have an entry in `previousStates` and whose current `status` differs from the previous one are reported.
 * @param {Object<string, string>} previousStates - Mapping from story `slug` to its previous status.
 * @param {Array} currentEpics - Array of epic objects; each epic may include a `stories` array (treated as empty if missing).
 * @returns {Array<{slug: string, title: string, epicNumber: *, storyNumber: *, from: string, to: string}>} Array of change records containing `slug`, `title`, `epicNumber`, `storyNumber`, `from` (previous status), and `to` (current status).
 */
function detectPhaseChanges(previousStates, currentEpics) {
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
 * Build a lookup map of story statuses keyed by story slug.
 * @param {Array} epics - Array of epic objects; each may include a `stories` array of story objects.
 * @returns {Object<string, string>} Map where keys are story slugs and values are their current status.
 */
function snapshotStates(epics) {
  const states = {};
  for (const epic of epics) {
    for (const story of (epic.stories || [])) {
      states[story.slug] = story.status;
    }
  }
  return states;
}

module.exports = { detectPhaseChanges, snapshotStates };
