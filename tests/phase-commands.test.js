import { describe, it, expect } from 'vitest';
import {
  PHASE_ORDER,
  PHASE_CONFIG,
  getPhaseConfig,
  getPhaseIndex,
  getNextPhase,
  buildCommand,
  buildClaudeCommand
} from '../lib/phase-commands.js';

// ── PHASE_ORDER ─────────────────────────────────────────────────────────

describe('PHASE_ORDER', () => {
  it('has 5 phases in correct order', () => {
    expect(PHASE_ORDER).toEqual(['backlog', 'ready-for-dev', 'in-progress', 'review', 'done']);
  });
});

// ── PHASE_CONFIG ────────────────────────────────────────────────────────

describe('PHASE_CONFIG', () => {
  it('has config for every phase in PHASE_ORDER', () => {
    for (const phase of PHASE_ORDER) {
      expect(PHASE_CONFIG[phase]).toBeDefined();
      expect(PHASE_CONFIG[phase].label).toBeTruthy();
      expect(PHASE_CONFIG[phase].color).toMatch(/^#[0-9a-f]{6}$/);
      expect(PHASE_CONFIG[phase].icon).toBeTruthy();
    }
  });

  it('done phase has no command', () => {
    expect(PHASE_CONFIG['done'].command).toBeNull();
  });

  it('backlog maps to /create-story', () => {
    expect(PHASE_CONFIG['backlog'].command).toBe('/create-story');
  });

  it('in-progress and ready-for-dev map to /dev-story', () => {
    expect(PHASE_CONFIG['ready-for-dev'].command).toBe('/dev-story');
    expect(PHASE_CONFIG['in-progress'].command).toBe('/dev-story');
  });

  it('review maps to /code-review', () => {
    expect(PHASE_CONFIG['review'].command).toBe('/code-review');
  });
});

// ── getPhaseConfig ──────────────────────────────────────────────────────

describe('getPhaseConfig', () => {
  it('returns correct config for known phase', () => {
    const config = getPhaseConfig('review');
    expect(config.label).toBe('Review');
    expect(config.command).toBe('/code-review');
  });

  it('falls back to backlog for unknown phase', () => {
    const config = getPhaseConfig('unknown-phase');
    expect(config.label).toBe('Backlog');
  });
});

// ── getPhaseIndex ───────────────────────────────────────────────────────

describe('getPhaseIndex', () => {
  it('returns 0 for backlog', () => {
    expect(getPhaseIndex('backlog')).toBe(0);
  });

  it('returns 4 for done', () => {
    expect(getPhaseIndex('done')).toBe(4);
  });

  it('returns 0 for unknown phase', () => {
    expect(getPhaseIndex('nonexistent')).toBe(0);
  });
});

// ── getNextPhase ────────────────────────────────────────────────────────

describe('getNextPhase', () => {
  it('backlog -> ready-for-dev', () => {
    expect(getNextPhase('backlog')).toBe('ready-for-dev');
  });

  it('ready-for-dev -> in-progress', () => {
    expect(getNextPhase('ready-for-dev')).toBe('in-progress');
  });

  it('in-progress -> review', () => {
    expect(getNextPhase('in-progress')).toBe('review');
  });

  it('review -> done', () => {
    expect(getNextPhase('review')).toBe('done');
  });

  it('done -> null (no next phase)', () => {
    expect(getNextPhase('done')).toBeNull();
  });

  it('unknown -> ready-for-dev (treated as index 0)', () => {
    expect(getNextPhase('mystery')).toBe('ready-for-dev');
  });
});

// ── buildCommand ────────────────────────────────────────────────────────

describe('buildCommand', () => {
  it('builds a claude command for backlog phase', () => {
    const cmd = buildCommand('backlog', '1-1-setup', '/path/story.md');
    expect(cmd).toContain('claude');
    expect(cmd).toContain('/create-story');
    expect(cmd).toContain('/path/story.md');
  });

  it('builds a claude command for review phase', () => {
    const cmd = buildCommand('review', '1-2-review', '/path/story.md');
    expect(cmd).toContain('/code-review');
  });

  it('returns null for done phase', () => {
    const cmd = buildCommand('done', '1-1-done', '/story.md');
    expect(cmd).toBeNull();
  });

  it('uses specified provider', () => {
    const cmd = buildCommand('backlog', '1-1-test', '/story.md', 'codex');
    expect(cmd).toContain('codex');
    expect(cmd).not.toContain('claude');
  });

  it('defaults to claude when no provider specified', () => {
    const cmd = buildCommand('in-progress', '1-1-x', '/s.md');
    expect(cmd).toContain('claude');
  });

  it('builds aider command with --message flag', () => {
    const cmd = buildCommand('backlog', '1-1-test', '/story.md', 'aider');
    expect(cmd).toContain('aider');
    expect(cmd).toContain('--message');
  });
});

// ── buildClaudeCommand (backward compat) ────────────────────────────────

describe('buildClaudeCommand', () => {
  it('works the same as buildCommand with claude provider', () => {
    const a = buildClaudeCommand('backlog', '1-1-x', '/story.md');
    const b = buildCommand('backlog', '1-1-x', '/story.md', 'claude');
    expect(a).toBe(b);
  });
});
