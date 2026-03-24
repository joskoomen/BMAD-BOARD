import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { scanProject } from '../lib/bmad-scanner.js';

// ── Test helpers ────────────────────────────────────────────────────────

let tmpDir;

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bmad-test-'));
}

function writeFile(relativePath, content) {
  const fullPath = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  return fullPath;
}

beforeEach(() => {
  tmpDir = createTmpDir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── No BMAD directory ───────────────────────────────────────────────────

describe('scanProject — no _bmad directory', () => {
  it('returns found: false when _bmad/ does not exist', () => {
    const result = scanProject(tmpDir);
    expect(result.found).toBe(false);
    expect(result.reason).toMatch(/_bmad/);
  });
});

// ── Empty _bmad (no config, no output) ──────────────────────────────────

describe('scanProject — empty _bmad', () => {
  it('returns found: true with warning when output folder missing', () => {
    fs.mkdirSync(path.join(tmpDir, '_bmad'));
    const result = scanProject(tmpDir);
    expect(result.found).toBe(true);
    expect(result.warning).toBeDefined();
    expect(result.epics).toEqual([]);
  });
});

// ── Config loading ──────────────────────────────────────────────────────

describe('scanProject — config loading', () => {
  it('reads project_name from bmm/config.yaml', () => {
    writeFile('_bmad/bmm/config.yaml', 'project_name: My Cool Project\n');
    writeFile('_bmad-output/.keep', '');
    const result = scanProject(tmpDir);
    expect(result.found).toBe(true);
    expect(result.config.projectName).toBe('My Cool Project');
  });

  it('falls back to core/config.yaml', () => {
    writeFile('_bmad/core/config.yaml', 'project_name: Core Project\n');
    writeFile('_bmad-output/.keep', '');
    const result = scanProject(tmpDir);
    expect(result.config.projectName).toBe('Core Project');
  });

  it('bmm config overrides core config', () => {
    writeFile('_bmad/core/config.yaml', 'project_name: Core\nuser_name: CoreUser\n');
    writeFile('_bmad/bmm/config.yaml', 'project_name: BMM Override\n');
    writeFile('_bmad-output/.keep', '');
    const result = scanProject(tmpDir);
    expect(result.config.projectName).toBe('BMM Override');
    expect(result.config.userName).toBe('CoreUser');
  });

  it('resolves {project-root} placeholders', () => {
    writeFile('_bmad/bmm/config.yaml', `output_folder: {project-root}/docs/bmad\n`);
    writeFile('docs/bmad/.keep', '');
    const result = scanProject(tmpDir);
    expect(result.config.outputFolder).toBe(path.join(tmpDir, 'docs', 'bmad'));
  });

  it('resolves relative output_folder against project root', () => {
    writeFile('_bmad/bmm/config.yaml', 'output_folder: custom-output\n');
    writeFile('custom-output/.keep', '');
    const result = scanProject(tmpDir);
    expect(result.config.outputFolder).toBe(path.join(tmpDir, 'custom-output'));
  });

  it('defaults planning/implementation to subdirs of output folder', () => {
    writeFile('_bmad/bmm/config.yaml', 'project_name: Test\n');
    writeFile('_bmad-output/.keep', '');
    const result = scanProject(tmpDir);
    expect(result.config.planningArtifacts).toBe(path.join(tmpDir, '_bmad-output', 'planning'));
    expect(result.config.implementationArtifacts).toBe(path.join(tmpDir, '_bmad-output', 'implementation'));
  });

  it('strips quotes from YAML values', () => {
    writeFile('_bmad/bmm/config.yaml', 'project_name: "Quoted Project"\n');
    writeFile('_bmad-output/.keep', '');
    const result = scanProject(tmpDir);
    expect(result.config.projectName).toBe('Quoted Project');
  });

  it('handles single-quoted YAML values', () => {
    writeFile('_bmad/bmm/config.yaml', "project_name: 'Single Quoted'\n");
    writeFile('_bmad-output/.keep', '');
    const result = scanProject(tmpDir);
    expect(result.config.projectName).toBe('Single Quoted');
  });

  it('ignores comment lines in YAML', () => {
    writeFile('_bmad/bmm/config.yaml', '# This is a comment\nproject_name: Real Value\n# Another comment\n');
    writeFile('_bmad-output/.keep', '');
    const result = scanProject(tmpDir);
    expect(result.config.projectName).toBe('Real Value');
  });
});

// ── Sprint status parsing ───────────────────────────────────────────────

describe('scanProject — sprint status parsing', () => {
  function setupProject(sprintStatusContent, extraFiles = {}) {
    writeFile('_bmad/bmm/config.yaml', 'project_name: Test\n');
    writeFile('_bmad-output/implementation/sprint-status.yaml', sprintStatusContent);
    for (const [filePath, content] of Object.entries(extraFiles)) {
      writeFile(filePath, content);
    }
  }

  it('parses epics from development_status section', () => {
    setupProject(`
project: Test Project
development_status:
  # Epic 1: First Epic
  epic-1: in-progress
  1-1-setup-project: done
  1-2-add-tests: in-progress
  # Epic 2: Second Epic
  epic-2: backlog
`);
    const result = scanProject(tmpDir);
    expect(result.epics).toHaveLength(2);
    expect(result.epics[0].number).toBe(1);
    expect(result.epics[0].title).toBe('First Epic');
    expect(result.epics[0].status).toBe('in-progress');
    expect(result.epics[0].stories).toHaveLength(2);
  });

  it('parses story slugs and statuses correctly', () => {
    setupProject(`
development_status:
  # Epic 1: Test
  epic-1: in-progress
  1-1-hello-world: done
  1-2-foo-bar: review
`);
    const result = scanProject(tmpDir);
    const stories = result.epics[0].stories;
    expect(stories[0].slug).toBe('1-1-hello-world');
    expect(stories[0].status).toBe('done');
    expect(stories[0].title).toBe('Hello World');
    expect(stories[1].slug).toBe('1-2-foo-bar');
    expect(stories[1].status).toBe('review');
  });

  it('defaults epic title when no comment is present', () => {
    setupProject(`
development_status:
  epic-3: backlog
`);
    const result = scanProject(tmpDir);
    expect(result.epics[0].title).toBe('Epic 3');
  });

  it('parses retrospective entries', () => {
    setupProject(`
development_status:
  # Epic 1: Done Epic
  epic-1: done
  1-1-something: done
  epic-1-retrospective: done
`);
    const result = scanProject(tmpDir);
    expect(result.epics[0].retrospective).toBeDefined();
    expect(result.epics[0].retrospective.status).toBe('done');
  });

  it('extracts project name from sprint-status.yaml', () => {
    setupProject(`
project: My BMAD Project
development_status:
  epic-1: backlog
`);
    const result = scanProject(tmpDir);
    expect(result.projectMeta.name).toBe('My BMAD Project');
  });

  it('handles sub-stories with compound numbers (e.g. 1-2-1)', () => {
    setupProject(`
development_status:
  # Epic 1: Test
  epic-1: in-progress
  1-2-1-sub-story-a: in-progress
`);
    const result = scanProject(tmpDir);
    const stories = result.epics[0].stories;
    expect(stories).toHaveLength(1);
    expect(stories[0].storyNumber).toBe('2-1');
  });
});

// ── Story file enrichment ───────────────────────────────────────────────

describe('scanProject — story enrichment', () => {
  it('enriches stories with markdown file content', () => {
    writeFile('_bmad/bmm/config.yaml', 'project_name: Test\n');
    writeFile('_bmad-output/implementation/sprint-status.yaml', `
development_status:
  # Epic 1: Test
  epic-1: in-progress
  1-1-setup-project: in-progress
`);
    writeFile('_bmad-output/implementation/1-1-setup-project.md', `# Story 1.1: Better Title Here

Status: done

Some content here.
`);

    const result = scanProject(tmpDir);
    const story = result.epics[0].stories[0];
    expect(story.filePath).toBeTruthy();
    expect(story.content).toContain('Some content here');
    expect(story.title).toBe('Better Title Here');
    expect(story.fileStatus).toBe('done');
  });

  it('enriches retrospective with file content', () => {
    writeFile('_bmad/bmm/config.yaml', 'project_name: Test\n');
    writeFile('_bmad-output/implementation/sprint-status.yaml', `
development_status:
  # Epic 1: Test
  epic-1: done
  epic-1-retrospective: done
`);
    writeFile('_bmad-output/implementation/epic-1-retrospective.md', '# Retrospective\n\nLessons learned.');

    const result = scanProject(tmpDir);
    expect(result.epics[0].retrospective.filePath).toBeTruthy();
    expect(result.epics[0].retrospective.content).toContain('Lessons learned');
  });
});

// ── Document collection ─────────────────────────────────────────────────

describe('scanProject — document collection', () => {
  it('collects planning documents', () => {
    writeFile('_bmad/bmm/config.yaml', 'project_name: Test\n');
    writeFile('_bmad-output/planning/prd.md', '# PRD\nProduct requirements');
    writeFile('_bmad-output/implementation/sprint-status.yaml', `
development_status:
  epic-1: backlog
`);

    const result = scanProject(tmpDir);
    const planDocs = result.documents.filter(d => d.category === 'Planning');
    expect(planDocs).toHaveLength(1);
    expect(planDocs[0].name).toBe('Prd');
    expect(planDocs[0].content).toContain('Product requirements');
  });

  it('collects root-level overview documents', () => {
    writeFile('_bmad/bmm/config.yaml', 'project_name: Test\n');
    writeFile('_bmad-output/overview.md', '# Overview');
    writeFile('_bmad-output/implementation/sprint-status.yaml', `
development_status:
  epic-1: backlog
`);

    const result = scanProject(tmpDir);
    const overviewDocs = result.documents.filter(d => d.category === 'Overview');
    expect(overviewDocs).toHaveLength(1);
  });

  it('skips story files in implementation artifacts', () => {
    writeFile('_bmad/bmm/config.yaml', 'project_name: Test\n');
    writeFile('_bmad-output/implementation/sprint-status.yaml', `
development_status:
  # Epic 1: Test
  epic-1: in-progress
  1-1-some-story: done
`);
    writeFile('_bmad-output/implementation/1-1-some-story.md', '# Story');
    writeFile('_bmad-output/implementation/architecture.md', '# Architecture');

    const result = scanProject(tmpDir);
    const implDocs = result.documents.filter(d => d.category === 'Implementation');
    expect(implDocs.some(d => d.filename === 'architecture.md')).toBe(true);
    expect(implDocs.some(d => d.filename === '1-1-some-story.md')).toBe(false);
  });

  it('collects retrospective documents from subfolder', () => {
    writeFile('_bmad/bmm/config.yaml', 'project_name: Test\n');
    writeFile('_bmad-output/retrospectives/sprint-1.md', '# Retro 1');
    writeFile('_bmad-output/implementation/sprint-status.yaml', `
development_status:
  epic-1: backlog
`);

    const result = scanProject(tmpDir);
    const retroDocs = result.documents.filter(d => d.category === 'Retrospectives');
    expect(retroDocs).toHaveLength(1);
  });
});

// ── slugToTitle (tested indirectly through story titles) ────────────────

describe('slug to title conversion', () => {
  it('converts slugs to readable titles', () => {
    writeFile('_bmad/bmm/config.yaml', 'project_name: Test\n');
    writeFile('_bmad-output/implementation/sprint-status.yaml', `
development_status:
  # Epic 1: Test
  epic-1: in-progress
  1-1-multi-addon-schema-support: backlog
`);

    const result = scanProject(tmpDir);
    const story = result.epics[0].stories[0];
    expect(story.title).toBe('Multi Addon Schema Support');
  });
});
