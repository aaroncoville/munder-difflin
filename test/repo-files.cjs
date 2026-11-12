'use strict';
/**
 * The repository's files, for tests that scan the source.
 *
 * From `git ls-files` when git is there, so an untracked scratch file cannot
 * change a result; with no git (an unpacked source archive, a machine
 * without it) from the disk, skipping what a build or an install writes, so
 * the scan still runs instead of erroring.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SKIP = new Set(['.git', 'node_modules', 'out', 'dist', 'release']);

/** Paths relative to the repository root, `/`-separated, under `prefix`. */
function repoFiles(prefix = '', { git = true } = {}) {
  const under = (f) => !prefix || f === prefix || f.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
  if (git) {
    try {
      const { execFileSync } = require('node:child_process');
      return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n').filter((f) => f && under(f));
    } catch { /* no git here: read the disk */ }
  }
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(rel); } else if (e.isFile()) out.push(rel);
    }
  };
  walk('');
  return out.filter(under);
}

module.exports = { repoFiles };
