import { describe, it, expect } from 'vitest';
import { LLM_PROVIDERS, getProvider, getProviderKeys, getProviderList } from '../lib/llm-providers.js';

// ── getProvider ─────────────────────────────────────────────────────────

describe('getProvider', () => {
  it('returns the claude provider by key', () => {
    const provider = getProvider('claude');
    expect(provider.name).toBe('Claude Code');
    expect(provider.binary).toBe('claude');
  });

  it('returns codex provider', () => {
    expect(getProvider('codex').name).toBe('Codex CLI');
  });

  it('returns cursor provider', () => {
    expect(getProvider('cursor').name).toBe('Cursor');
  });

  it('returns aider provider', () => {
    expect(getProvider('aider').name).toBe('Aider');
  });

  it('returns opencode provider', () => {
    expect(getProvider('opencode').name).toBe('Open Code');
    expect(getProvider('opencode').binary).toBe('oo');
  });

  it('falls back to claude for unknown keys', () => {
    const provider = getProvider('nonexistent');
    expect(provider.name).toBe('Claude Code');
  });
});

// ── getProviderKeys / getProviderList ───────────────────────────────────

describe('getProviderKeys', () => {
  it('returns all provider keys', () => {
    const keys = getProviderKeys();
    expect(keys).toContain('claude');
    expect(keys).toContain('codex');
    expect(keys).toContain('cursor');
    expect(keys).toContain('aider');
    expect(keys).toContain('opencode');
    expect(keys).toHaveLength(5);
  });
});

describe('getProviderList', () => {
  it('returns objects with key and name', () => {
    const list = getProviderList();
    expect(list).toHaveLength(5);
    expect(list[0]).toHaveProperty('key');
    expect(list[0]).toHaveProperty('name');
    const claude = list.find(p => p.key === 'claude');
    expect(claude.name).toBe('Claude Code');
  });
});

// ── Claude provider ─────────────────────────────────────────────────────

describe('Claude provider', () => {
  const claude = LLM_PROVIDERS.claude;

  it('supports session IDs and resume', () => {
    expect(claude.supportsSessionId).toBe(true);
    expect(claude.supportsResume).toBe(true);
  });

  it('buildCommand — plain (no args)', () => {
    expect(claude.buildCommand()).toBe('claude');
  });

  it('buildCommand — with slash command', () => {
    expect(claude.buildCommand('/dev-story')).toBe('claude "/dev-story"');
  });

  it('buildCommand — with session ID and command', () => {
    const cmd = claude.buildCommand('/dev-story', { sessionId: 'abc123' });
    expect(cmd).toBe('claude --session-id abc123 "/dev-story"');
  });

  it('buildCommand — resume with session ID', () => {
    const cmd = claude.buildCommand(null, { resume: true, sessionId: 'abc123' });
    expect(cmd).toBe('claude --resume abc123');
  });

  it('buildResumeCommand', () => {
    expect(claude.buildResumeCommand('sess-42')).toBe('claude --resume sess-42');
  });

  it('translateCommand — appends story file path', () => {
    expect(claude.translateCommand('/dev-story', '/path/to/story.md'))
      .toBe('/dev-story /path/to/story.md');
  });

  it('translateCommand — without file path', () => {
    expect(claude.translateCommand('/dev-story')).toBe('/dev-story');
  });

  it('detectState returns unknown', () => {
    expect(claude.detectState('some output')).toBe('unknown');
    expect(claude.detectState(null)).toBe('unknown');
  });
});

// ── Codex provider ──────────────────────────────────────────────────────

describe('Codex provider', () => {
  const codex = LLM_PROVIDERS.codex;

  it('does not support session/resume', () => {
    expect(codex.supportsSessionId).toBe(false);
    expect(codex.supportsResume).toBe(false);
    expect(codex.buildResumeCommand()).toBeNull();
  });

  it('buildCommand — plain', () => {
    expect(codex.buildCommand()).toBe('codex');
  });

  it('buildCommand — with prompt', () => {
    expect(codex.buildCommand('implement feature')).toBe('codex "implement feature"');
  });

  it('buildCommand — with extra args', () => {
    expect(codex.buildCommand('test', { extraArgs: '--model o3' }))
      .toBe('codex --model o3 "test"');
  });

  it('translateCommand — maps known BMAD commands', () => {
    const result = codex.translateCommand('/bmad-bmm-dev-story');
    expect(result).toBe('Read the BMAD workflow and implement the story');
  });

  it('translateCommand — unknown command gets Execute: prefix', () => {
    expect(codex.translateCommand('/unknown-cmd')).toBe('Execute: /unknown-cmd');
  });

  it('translateCommand — appends file path', () => {
    const result = codex.translateCommand('/bmad-bmm-dev-story', '/story.md');
    expect(result).toContain('at /story.md');
  });
});

// ── Cursor provider ─────────────────────────────────────────────────────

describe('Cursor provider', () => {
  const cursor = LLM_PROVIDERS.cursor;

  it('opens current directory by default', () => {
    expect(cursor.buildCommand()).toBe('cursor .');
  });

  it('opens a specific file', () => {
    expect(cursor.buildCommand('/path/to/file')).toBe('cursor "/path/to/file"');
  });

  it('translateCommand returns file path or dot', () => {
    expect(cursor.translateCommand('/any', '/file.md')).toBe('/file.md');
    expect(cursor.translateCommand('/any')).toBe('.');
  });
});

// ── Aider provider ──────────────────────────────────────────────────────

describe('Aider provider', () => {
  const aider = LLM_PROVIDERS.aider;

  it('buildCommand — plain', () => {
    expect(aider.buildCommand()).toBe('aider');
  });

  it('buildCommand — with message', () => {
    expect(aider.buildCommand('do stuff')).toBe('aider --message "do stuff"');
  });

  it('translateCommand — maps known commands', () => {
    expect(aider.translateCommand('/bmad-bmm-dev-story')).toBe('implement the story');
  });

  it('translateCommand — uses slash command as-is for unknown', () => {
    expect(aider.translateCommand('/something-new')).toBe('/something-new');
  });

  it('translateCommand — appends file with "per"', () => {
    const result = aider.translateCommand('/bmad-bmm-dev-story', '/story.md');
    expect(result).toBe('implement the story per /story.md');
  });
});

// ── Open Code provider ──────────────────────────────────────────────────

describe('Open Code provider', () => {
  const oo = LLM_PROVIDERS.opencode;

  it('uses "oo" binary', () => {
    expect(oo.binary).toBe('oo');
  });

  it('buildCommand — plain', () => {
    expect(oo.buildCommand()).toBe('oo');
  });

  it('buildCommand — with prompt', () => {
    expect(oo.buildCommand('do thing')).toBe('oo "do thing"');
  });

  it('translateCommand — maps additional commands like quick-spec', () => {
    expect(oo.translateCommand('/bmad-bmm-quick-spec')).toBe('Create a quick tech spec');
  });

  it('translateCommand — unknown gets Execute: prefix', () => {
    expect(oo.translateCommand('/weird')).toBe('Execute: /weird');
  });
});
