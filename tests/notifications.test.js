/**
 * Tests for phase change detection logic.
 *
 * Imports from lib/phase-detection.js — the shared module used by
 * both the renderer (app.js) and these tests.
 */

import { describe, it, expect } from 'vitest';
import { detectPhaseChanges, snapshotStates } from '../lib/phase-detection.js';

// ── Tests ───────────────────────────────────────────────────────────────

describe('Phase change detection', () => {
  const makeEpics = (stories) => [{ number: 1, stories }];
  const makeStory = (slug, status) => ({
    slug,
    title: slug.replace(/-/g, ' '),
    epicNumber: 1,
    storyNumber: slug.split('-')[0],
    status
  });

  it('detects no changes when states are identical', () => {
    const epics = makeEpics([
      makeStory('1-1-auth', 'in-progress'),
      makeStory('1-2-profile', 'backlog')
    ]);
    const prev = snapshotStates(epics);
    const changes = detectPhaseChanges(prev, epics);
    expect(changes).toEqual([]);
  });

  it('detects a single phase change', () => {
    const epics = makeEpics([
      makeStory('1-1-auth', 'in-progress'),
      makeStory('1-2-profile', 'backlog')
    ]);
    const prev = snapshotStates(epics);

    // Story moves to review
    const updatedEpics = makeEpics([
      makeStory('1-1-auth', 'review'),
      makeStory('1-2-profile', 'backlog')
    ]);

    const changes = detectPhaseChanges(prev, updatedEpics);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      slug: '1-1-auth',
      from: 'in-progress',
      to: 'review'
    });
  });

  it('detects multiple phase changes', () => {
    const epics = makeEpics([
      makeStory('1-1-auth', 'in-progress'),
      makeStory('1-2-profile', 'ready-for-dev')
    ]);
    const prev = snapshotStates(epics);

    const updatedEpics = makeEpics([
      makeStory('1-1-auth', 'review'),
      makeStory('1-2-profile', 'in-progress')
    ]);

    const changes = detectPhaseChanges(prev, updatedEpics);
    expect(changes).toHaveLength(2);
    expect(changes[0].slug).toBe('1-1-auth');
    expect(changes[1].slug).toBe('1-2-profile');
  });

  it('ignores new stories not in previous state', () => {
    const prev = { '1-1-auth': 'backlog' };
    const epics = makeEpics([
      makeStory('1-1-auth', 'backlog'),
      makeStory('1-3-new', 'backlog')
    ]);
    const changes = detectPhaseChanges(prev, epics);
    expect(changes).toEqual([]);
  });

  it('ignores stories removed from current data', () => {
    const prev = { '1-1-auth': 'backlog', '1-2-removed': 'in-progress' };
    const epics = makeEpics([makeStory('1-1-auth', 'backlog')]);
    const changes = detectPhaseChanges(prev, epics);
    expect(changes).toEqual([]);
  });

  it('detects done transition', () => {
    const prev = { '1-1-auth': 'review' };
    const epics = makeEpics([makeStory('1-1-auth', 'done')]);
    const changes = detectPhaseChanges(prev, epics);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ from: 'review', to: 'done' });
  });

  it('works across multiple epics', () => {
    const epics = [
      { number: 1, stories: [makeStory('1-1-a', 'backlog')] },
      { number: 2, stories: [makeStory('2-1-b', 'in-progress')] }
    ];
    const prev = snapshotStates(epics);

    const updated = [
      { number: 1, stories: [makeStory('1-1-a', 'ready-for-dev')] },
      { number: 2, stories: [makeStory('2-1-b', 'review')] }
    ];

    const changes = detectPhaseChanges(prev, updated);
    expect(changes).toHaveLength(2);
  });
});

describe('State snapshot', () => {
  it('creates a map of slug -> status', () => {
    const epics = [
      { number: 1, stories: [
        { slug: '1-1-a', status: 'backlog' },
        { slug: '1-2-b', status: 'in-progress' }
      ]},
      { number: 2, stories: [
        { slug: '2-1-c', status: 'done' }
      ]}
    ];
    const snapshot = snapshotStates(epics);
    expect(snapshot).toEqual({
      '1-1-a': 'backlog',
      '1-2-b': 'in-progress',
      '2-1-c': 'done'
    });
  });

  it('handles empty epics', () => {
    expect(snapshotStates([])).toEqual({});
  });

  it('handles epics without stories', () => {
    expect(snapshotStates([{ number: 1 }])).toEqual({});
  });

  it('last writer wins when same slug appears in multiple epics', () => {
    // Edge case: duplicate slug across epics — last one wins
    const epics = [
      { number: 1, stories: [{ slug: 'dupe', status: 'backlog' }] },
      { number: 2, stories: [{ slug: 'dupe', status: 'in-progress' }] }
    ];
    const snapshot = snapshotStates(epics);
    // second epic overwrites first
    expect(snapshot.dupe).toBe('in-progress');
  });
});

// ── Additional edge cases for detectPhaseChanges ─────────────────────

describe('detectPhaseChanges edge cases', () => {
  it('returns empty array when previousStates is empty', () => {
    const epics = [{ number: 1, stories: [{ slug: 'x', status: 'done' }] }];
    expect(detectPhaseChanges({}, epics)).toEqual([]);
  });

  it('returns empty array when currentEpics is empty', () => {
    const prev = { 'x': 'in-progress' };
    expect(detectPhaseChanges(prev, [])).toEqual([]);
  });

  it('includes title, epicNumber, storyNumber in change objects', () => {
    const prev = { '1-2-impl': 'backlog' };
    const epics = [{
      number: 1,
      stories: [{
        slug: '1-2-impl',
        title: 'Implement Feature',
        epicNumber: 1,
        storyNumber: 2,
        status: 'in-progress'
      }]
    }];
    const changes = detectPhaseChanges(prev, epics);
    expect(changes[0]).toMatchObject({
      title: 'Implement Feature',
      epicNumber: 1,
      storyNumber: 2
    });
  });

  it('does not emit change when status is same as previous', () => {
    const prev = { 'x': 'done' };
    const epics = [{ number: 1, stories: [{ slug: 'x', title: 'X', status: 'done' }] }];
    expect(detectPhaseChanges(prev, epics)).toEqual([]);
  });

  it('handles epics with null/undefined stories gracefully', () => {
    const prev = { 'x': 'backlog' };
    const epics = [
      { number: 1, stories: null },
      { number: 2 }
    ];
    expect(() => detectPhaseChanges(prev, epics)).not.toThrow();
    expect(detectPhaseChanges(prev, epics)).toEqual([]);
  });
});