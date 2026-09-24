const fs = require('fs');

/**
 * Re-key or remove project-cwd entries in the landing page's JSON stores
 * (favorites: array of cwd strings; categories: { assignments: {cwd: cat}, order: [] }).
 * Callers pass the store file path so tests can use temp files. Missing or
 * corrupt files are silently skipped — the stores are best-effort caches.
 */

function readJson(file) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn(`[store-migrate] ${file} unreadable — skipping:`, err.message);
  }
  return null;
}

function writeJson(file, value) {
  try {
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
  } catch (err) {
    console.warn(`[store-migrate] Failed to write ${file}:`, err.message);
  }
}

function renameCwdInFavorites(file, oldCwd, newCwd) {
  const favs = readJson(file);
  if (!Array.isArray(favs)) return;
  if (!favs.includes(oldCwd)) return;
  writeJson(file, favs.map((c) => (c === oldCwd ? newCwd : c)));
}

function removeCwdFromFavorites(file, cwd) {
  const favs = readJson(file);
  if (!Array.isArray(favs)) return;
  if (!favs.includes(cwd)) return;
  writeJson(file, favs.filter((c) => c !== cwd));
}

function renameCwdInCategories(file, oldCwd, newCwd) {
  const cats = readJson(file);
  if (!cats || typeof cats !== 'object' || !cats.assignments
    || typeof cats.assignments !== 'object' || Array.isArray(cats.assignments)) return;
  if (!(oldCwd in cats.assignments)) return;
  cats.assignments[newCwd] = cats.assignments[oldCwd];
  delete cats.assignments[oldCwd];
  writeJson(file, cats);
}

function removeCwdFromCategories(file, cwd) {
  const cats = readJson(file);
  if (!cats || typeof cats !== 'object' || !cats.assignments
    || typeof cats.assignments !== 'object' || Array.isArray(cats.assignments)) return;
  if (!(cwd in cats.assignments)) return;
  delete cats.assignments[cwd];
  writeJson(file, cats);
}

module.exports = {
  renameCwdInFavorites,
  removeCwdFromFavorites,
  renameCwdInCategories,
  removeCwdFromCategories,
};
