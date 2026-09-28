// Dead-code report: source files nothing imports, and exports whose name appears
// in no other file. Heuristic (name-based, relative imports only) — always
// confirm with grep before deleting. Run: npm run deadcode
import fs from 'fs';
import path from 'path';

const ROOTS = ['server', 'src', 'scripts'];
// Files that are entry points or loaded by tooling rather than imported.
const ENTRY = /^(server\/index\.ts|src\/main\.tsx|server\/db\/(migrate|seed|testSetup|testWorker)\.ts|server\/seed-world\.ts|scripts\/)/;
const isTest = (f) => /__tests__|\.test\./.test(f);
const norm = (p) => p.split(path.sep).join('/');

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
    else if (/\.(ts|tsx|mjs|cjs)$/.test(e.name) && !e.name.endsWith('.d.ts')) files.push(norm(p));
  }
})('.');
const scoped = files.filter((f) => ROOTS.some((r) => f.startsWith(r + '/')));
const src = Object.fromEntries(scoped.map((f) => [f, fs.readFileSync(f, 'utf8')]));

// ── Orphan files ─────────────────────────────────────────────────────────────
const importedBy = new Map(scoped.map((f) => [f, []]));
const importRe = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;
for (const f of scoped) {
  for (const m of src[f].matchAll(importRe)) {
    const spec = m[1] || m[2] || m[3] || m[4];
    if (!spec.startsWith('.')) continue;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(f), spec)).replace(/\.(ts|tsx|js)$/, '');
    for (const c of ['.ts', '.tsx', '/index.ts', '/index.tsx', '.mjs', '.cjs'].map((x) => base + x)) {
      if (importedBy.has(c)) importedBy.get(c).push(f);
    }
  }
}
const orphans = [];
for (const [f, by] of importedBy) {
  if (ENTRY.test(f) || isTest(f)) continue;
  if (by.filter((b) => !isTest(b)).length === 0) orphans.push(by.length ? `${f}  (tests only)` : f);
}

// ── Unused exports ───────────────────────────────────────────────────────────
const exportRe = /export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
const unused = [];
for (const f of scoped) {
  if (isTest(f) || !/\.(ts|tsx)$/.test(f)) continue;
  for (const [, name] of src[f].matchAll(exportRe)) {
    const word = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g');
    if (scoped.some((o) => o !== f && !isTest(o) && word.test(src[o]))) continue;
    const testUse = scoped.some((o) => o !== f && isTest(o) && new RegExp(word.source).test(src[o]));
    const ownUses = (src[f].match(word) || []).length;
    // Used in its own file (or by tests) is fine — only report names nothing uses.
    if (ownUses <= 1 && !testUse) unused.push(`${f}  ${name}`);
  }
}

console.log(`Orphan files (${orphans.length}):`);
orphans.forEach((o) => console.log('  ' + o));
console.log(`\nExports used nowhere (${unused.length}):`);
unused.forEach((u) => console.log('  ' + u));
