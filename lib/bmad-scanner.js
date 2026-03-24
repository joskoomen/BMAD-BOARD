/**
 * BMAD Scanner — scans a project folder for BMAD artifacts
 *
 * Reads _bmad/bmm/config.yaml (or _bmad/core/config.yaml) to discover
 * the actual output paths. The default output folder is `_bmad-output`,
 * but projects can override it (e.g. `docs/bmad`).
 *
 * Config keys used:
 *   - output_folder              — root for all BMAD output
 *   - planning_artifacts         — where PRDs, product briefs live
 *   - implementation_artifacts   — where stories, sprint status, tech specs live
 */

const fs = require('fs');
const path = require('path');

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Scan a project folder for BMAD structure.
 * Returns { found, config, epics, documents, projectMeta } or { found: false, reason }.
 */
function scanProject(projectPath) {
  const bmadDir = path.join(projectPath, '_bmad');

  if (!fs.existsSync(bmadDir)) {
    return { found: false, reason: 'No _bmad/ directory found in this project.' };
  }

  // Read BMAD config to discover output paths
  const config = loadBmadConfig(bmadDir, projectPath);

  if (!config.outputFolder || !fs.existsSync(config.outputFolder)) {
    // Check if the output folder simply hasn't been created yet
    return {
      found: true,
      projectPath,
      config,
      projectMeta: extractProjectMeta(config),
      epics: [],
      documents: [],
      warning: `Output folder not found: ${config.outputFolder}. Run your BMAD workflow to generate output.`
    };
  }

  const result = {
    found: true,
    projectPath,
    config,
    projectMeta: extractProjectMeta(config),
    epics: [],
    documents: []
  };

  // Parse sprint-status.yaml for authoritative epic/story structure
  const sprintStatusPath = findSprintStatus(config);
  if (sprintStatusPath) {
    result.epics = parseSprintStatus(sprintStatusPath);
  }

  // Enrich epics with story file content
  enrichStoriesFromFiles(result.epics, config);

  // Collect documents (PRD, architecture, retros, etc.)
  result.documents = collectDocuments(config);

  return result;
}

// ── Config Loading ──────────────────────────────────────────────────────

/**
 * Load BMAD config from _bmad/bmm/config.yaml, falling back to
 * _bmad/core/config.yaml. Resolves {project-root} placeholders.
 */
function loadBmadConfig(bmadDir, projectPath) {
  const configCandidates = [
    path.join(bmadDir, 'bmm', 'config.yaml'),
    path.join(bmadDir, 'core', 'config.yaml')
  ];

  // Merge: core first (defaults), then bmm (overrides)
  const merged = {};
  for (const candidate of [...configCandidates].reverse()) {
    if (!fs.existsSync(candidate)) continue;
    const parsed = parseSimpleYaml(fs.readFileSync(candidate, 'utf-8'));
    Object.assign(merged, parsed);
  }

  // Resolve {project-root} in all values
  const resolve = (val) => {
    if (typeof val !== 'string') return val;
    return val
      .replace(/"\{project-root\}/g, '{project-root}')
      .replace(/\{project-root\}"/g, '')
      .replace(/\{project-root\}/g, projectPath);
  };

  const config = {
    projectPath,
    bmadDir,
    projectName: merged.project_name || '',
    userName: merged.user_name || '',
    outputFolder: resolve(merged.output_folder || '_bmad-output'),
    planningArtifacts: resolve(merged.planning_artifacts || ''),
    implementationArtifacts: resolve(merged.implementation_artifacts || ''),
    projectKnowledge: resolve(merged.project_knowledge || ''),
    communicationLanguage: merged.communication_language || 'English',
    documentOutputLanguage: merged.document_output_language || 'English'
  };

  // If output_folder is relative, resolve against project root
  if (!path.isAbsolute(config.outputFolder)) {
    config.outputFolder = path.join(projectPath, config.outputFolder);
  }
  if (config.planningArtifacts && !path.isAbsolute(config.planningArtifacts)) {
    config.planningArtifacts = path.join(projectPath, config.planningArtifacts);
  }
  if (config.implementationArtifacts && !path.isAbsolute(config.implementationArtifacts)) {
    config.implementationArtifacts = path.join(projectPath, config.implementationArtifacts);
  }
  if (config.projectKnowledge && !path.isAbsolute(config.projectKnowledge)) {
    config.projectKnowledge = path.join(projectPath, config.projectKnowledge);
  }

  // Default planning/implementation to subdirs of output folder if not set
  if (!config.planningArtifacts) {
    config.planningArtifacts = path.join(config.outputFolder, 'planning');
  }
  if (!config.implementationArtifacts) {
    config.implementationArtifacts = path.join(config.outputFolder, 'implementation');
  }

  return config;
}

/**
 * Simple YAML parser for flat key-value configs (no nesting needed).
 * Handles comments, quoted values, and {project-root} placeholders.
 */
function parseSimpleYaml(content) {
  const result = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([a-z_]+)\s*:\s*(.+)/);
    if (!match) continue;
    let value = match[2].trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}

// ── Project Meta ────────────────────────────────────────────────────────

/**
 * Extract project metadata from config and sprint-status.yaml.
 * @param {object} config - Resolved BMAD config
 * @returns {{ name: string, userName: string, language: string }}
 */
function extractProjectMeta(config) {
  const meta = {
    name: config.projectName,
    userName: config.userName,
    language: config.communicationLanguage
  };

  // Try to read project name from sprint status (may be more descriptive)
  const sprintStatusPath = findSprintStatus(config);
  if (sprintStatusPath) {
    const content = fs.readFileSync(sprintStatusPath, 'utf-8');
    const projectMatch = content.match(/^project:\s*(.+)/m);
    if (projectMatch) meta.name = projectMatch[1].trim();
  }

  return meta;
}

// ── Sprint Status ───────────────────────────────────────────────────────

/**
 * Find the sprint-status.yaml file across known candidate paths.
 * @param {object} config - Resolved BMAD config
 * @returns {string|null} Absolute path to sprint-status.yaml, or null
 */
function findSprintStatus(config) {
  const candidates = [
    path.join(config.implementationArtifacts, 'sprint-status.yaml'),
    path.join(config.outputFolder, 'implementation', 'sprint-status.yaml'),
    path.join(config.outputFolder, 'sprint-status.yaml')
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

/**
 * Parse sprint-status.yaml to extract epic/story structure.
 * The file uses a flat key-value map under `development_status:`.
 * Epic titles come from comments like `# Epic 1: Multi-Addon Composition`.
 */
function parseSprintStatus(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const epics = [];
  let currentEpic = null;

  // Extract comments that describe epic titles (may be indented)
  const epicTitles = {};
  const titleRegex = /^\s*#\s*Epic\s+(\d+):\s*(.+)/gm;
  let match;
  while ((match = titleRegex.exec(content)) !== null) {
    epicTitles[parseInt(match[1])] = match[2].trim();
  }

  // Extract comment descriptions for backlog-only epics (description line before epic-N: backlog)
  const descRegex = /^\s*#\s*(.+)\n\s*epic-(\d+):\s*backlog$/gm;
  while ((match = descRegex.exec(content)) !== null) {
    const epicNum = parseInt(match[2]);
    if (!epicTitles[epicNum]) {
      epicTitles[epicNum] = match[1].trim();
    }
  }

  // Also extract story_location if present
  const storyLocMatch = content.match(/^story_location:\s*(.+)/m);
  const storyLocation = storyLocMatch ? storyLocMatch[1].trim() : null;

  // Parse the development_status section
  const lines = content.split('\n');
  let inDevStatus = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === 'development_status:') {
      inDevStatus = true;
      continue;
    }

    if (!inDevStatus) continue;
    if (trimmed.startsWith('#') || trimmed === '') continue;

    // Stop if we hit another top-level key
    if (!line.startsWith(' ') && !line.startsWith('\t') && trimmed.includes(':')) {
      break;
    }

    const kvMatch = trimmed.match(/^([a-z0-9_-]+):\s*(.+)/);
    if (!kvMatch) continue;

    const [, key, status] = kvMatch;

    // Epic entry
    const epicMatch = key.match(/^epic-(\d+)$/);
    if (epicMatch) {
      const epicNum = parseInt(epicMatch[1]);
      currentEpic = {
        number: epicNum,
        key: key,
        title: epicTitles[epicNum] || `Epic ${epicNum}`,
        status: status.trim(),
        stories: [],
        retrospective: null
      };
      epics.push(currentEpic);
      continue;
    }

    // Retrospective entry
    const retroMatch = key.match(/^epic-(\d+)-retrospective$/);
    if (retroMatch && currentEpic && currentEpic.number === parseInt(retroMatch[1])) {
      currentEpic.retrospective = { status: status.trim() };
      continue;
    }

    // Story entry (e.g., 1-1-multi-addon-schema-...)
    const storyMatch = key.match(/^(\d+)-(\d+(?:-\d+)?)-(.+)/);
    if (storyMatch && currentEpic) {
      currentEpic.stories.push({
        epicNumber: parseInt(storyMatch[1]),
        storyNumber: storyMatch[2],
        slug: key,
        title: slugToTitle(storyMatch[3]),
        status: status.trim(),
        filePath: null,
        content: null
      });
    }
  }

  return epics;
}

// ── Story File Enrichment ───────────────────────────────────────────────

/**
 * Find and read actual story markdown files to enrich the epic data.
 * Searches in implementation_artifacts, output_folder/sprint, and
 * output_folder/implementation.
 */
function enrichStoriesFromFiles(epics, config) {
  const searchDirs = [
    config.implementationArtifacts,
    path.join(config.outputFolder, 'sprint'),
    path.join(config.outputFolder, 'implementation')
  ];

  // Deduplicate
  const uniqueDirs = [...new Set(searchDirs.map(d => path.resolve(d)))];

  // Build an index of all markdown files in search dirs
  const mdFiles = {};
  for (const dir of uniqueDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      const baseName = file.replace('.md', '');
      mdFiles[baseName] = path.join(dir, file);
    }
  }

  for (const epic of epics) {
    for (const story of epic.stories) {
      if (mdFiles[story.slug]) {
        story.filePath = mdFiles[story.slug];
        const content = fs.readFileSync(story.filePath, 'utf-8');
        story.content = content;

        // Extract better title from file heading
        const titleMatch = content.match(/^#\s+Story\s+[\d.]+:\s*(.+)/m);
        if (titleMatch) {
          story.title = titleMatch[1].trim();
        }

        // Extract status from file (may differ from yaml)
        const statusMatch = content.match(/^Status:\s*(.+)/m);
        if (statusMatch) {
          story.fileStatus = statusMatch[1].trim().toLowerCase();
        }
      }
    }

    // Look for retrospective file
    const retroSlug = `epic-${epic.number}-retrospective`;
    if (mdFiles[retroSlug]) {
      epic.retrospective = epic.retrospective || {};
      epic.retrospective.filePath = mdFiles[retroSlug];
      epic.retrospective.content = fs.readFileSync(mdFiles[retroSlug], 'utf-8');
    }
  }
}

// ── Document Collection ─────────────────────────────────────────────────

/**
 * Collect non-story documents organized by category.
 * Scans output_folder root, planning_artifacts, implementation_artifacts,
 * and a retrospectives/ subfolder.
 */
function collectDocuments(config) {
  const docs = [];
  const outputFolder = config.outputFolder;

  if (!fs.existsSync(outputFolder)) return docs;

  // Root-level docs in output folder
  const rootFiles = safeReaddir(outputFolder).filter(f => f.endsWith('.md'));
  for (const file of rootFiles) {
    docs.push(makeDoc('Overview', file, path.join(outputFolder, file)));
  }

  // Planning artifacts
  if (fs.existsSync(config.planningArtifacts)) {
    const files = safeReaddir(config.planningArtifacts).filter(f => f.endsWith('.md'));
    for (const file of files) {
      docs.push(makeDoc('Planning', file, path.join(config.planningArtifacts, file)));
    }
  }

  // Implementation artifacts (non-story files)
  if (fs.existsSync(config.implementationArtifacts)) {
    const files = safeReaddir(config.implementationArtifacts)
      .filter(f => (f.endsWith('.md') || f.endsWith('.yaml')));
    for (const file of files) {
      // Skip story files (they're handled in epics)
      if (file.match(/^\d+-\d+.*\.md$/)) continue;
      docs.push(makeDoc('Implementation', file, path.join(config.implementationArtifacts, file)));
    }
  }

  // Retrospectives subfolder (check multiple possible locations)
  const retroDirs = [
    path.join(outputFolder, 'retrospectives'),
    path.join(config.implementationArtifacts, 'retrospectives')
  ];
  const retroDir = retroDirs.find(d => fs.existsSync(d));
  if (retroDir) {
    const files = safeReaddir(retroDir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      docs.push(makeDoc('Retrospectives', file, path.join(retroDir, file)));
    }
  }

  // Sprint subfolder (if separate from implementation)
  const sprintDir = path.join(outputFolder, 'sprint');
  if (fs.existsSync(sprintDir) && path.resolve(sprintDir) !== path.resolve(config.implementationArtifacts)) {
    const files = safeReaddir(sprintDir).filter(f => f.endsWith('.md') || f.endsWith('.yaml'));
    for (const file of files) {
      // Skip story files
      if (file.match(/^\d+-\d+.*\.md$/)) continue;
      docs.push(makeDoc('Sprint', file, path.join(sprintDir, file)));
    }
  }

  return docs;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Create a document entry with category, filename, path, and content.
 * @param {string} category - Document category (e.g. 'Planning', 'Overview')
 * @param {string} filename - File basename
 * @param {string} filePath - Absolute path to the file
 * @returns {{ category: string, name: string, filename: string, filePath: string, content: string }}
 */
function makeDoc(category, filename, filePath) {
  return {
    category,
    name: slugToTitle(filename.replace(/\.(md|yaml)$/, '')),
    filename,
    filePath,
    content: fs.readFileSync(filePath, 'utf-8')
  };
}

/**
 * Read a directory, returning an empty array on error.
 * @param {string} dirPath
 * @returns {string[]}
 */
function safeReaddir(dirPath) {
  try {
    return fs.readdirSync(dirPath);
  } catch {
    return [];
  }
}

/**
 * Convert a kebab-case slug to a Title Case string.
 * @param {string} slug
 * @returns {string}
 */
function slugToTitle(slug) {
  return slug
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

module.exports = { scanProject };
