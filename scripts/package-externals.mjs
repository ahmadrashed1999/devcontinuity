#!/usr/bin/env node
/**
 * Runs before "npm pack" / "npm publish" (prepack; logs go to stderr so "npm pack --json" stays parseable). Makes the production build in .next portable:
 *
 * Turbopack loads server-external packages (@prisma/client, archiver, yauzl) through hashed aliases
 * such as .next/node_modules/@prisma/client-2c3a…, which it creates as symlinks into this checkout's
 * node_modules. npm does not pack symlinks, so an installed package could not find them. Each link
 * is replaced by a two-file stub package that re-exports the real dependency, which Node then
 * resolves from wherever npm installed it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT } from './paths.mjs';

const dist = path.join(APP_ROOT, process.env.NEXT_DIST_DIR || '.next');
if (!fs.existsSync(path.join(dist, 'BUILD_ID'))) {
  console.error('No production build found. Run "npm run build" before packing.');
  process.exit(1);
}

const base = path.join(dist, 'node_modules');
const entries = [];
if (fs.existsSync(base)) {
  for (const e of fs.readdirSync(base, { withFileTypes: true })) {
    if (e.name.startsWith('@') && e.isDirectory()) for (const s of fs.readdirSync(path.join(base, e.name))) entries.push(`${e.name}/${s}`);
    else entries.push(e.name);
  }
}

let fixed = 0;
for (const alias of entries) {
  const m = alias.match(/^(.+)-[0-9a-f]{16}$/);
  if (!m) continue;
  const target = m[1];
  const dir = path.join(base, ...alias.split('/'));
  const stub = path.join(dir, 'package.json');
  const isLink = fs.lstatSync(dir).isSymbolicLink() || !fs.existsSync(stub) || !JSON.parse(fs.readFileSync(stub, 'utf8')).devcontinuityStub;
  if (!isLink) continue;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stub, `${JSON.stringify({ name: alias, private: true, main: 'index.js', devcontinuityStub: true }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'index.js'), `// Re-exports ${target} for the prebuilt server (see scripts/package-externals.mjs).\nmodule.exports = require(${JSON.stringify(target)});\n`);
  fixed++;
  console.error(`external ${alias} → ${target}`);
}
console.error(fixed ? `Replaced ${fixed} external link(s) with portable stubs.` : 'Externals already portable.');

// Next.js records the build machine's absolute project path in required-server-files (appDir,
// outputFileTracingRoot, turbopack root…). "next start" does not read them, but they would publish the
// maintainer's (or CI runner's) folder layout, so the path is replaced with ".".
const roots = [APP_ROOT, APP_ROOT.replace(/\\/g, '/')];
const scrub = (v) => {
  if (typeof v === 'string') return roots.reduce((s, r) => s.split(r).join('.'), v);
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]));
  return v;
};
const manifest = path.join(dist, 'required-server-files.json');
if (fs.existsSync(manifest)) {
  const clean = scrub(JSON.parse(fs.readFileSync(manifest, 'utf8')));
  fs.writeFileSync(manifest, JSON.stringify(clean, null, 2));
  const js = path.join(dist, 'required-server-files.js');
  if (fs.existsSync(js)) fs.writeFileSync(js, `self.__SERVER_FILES_MANIFEST=${JSON.stringify(clean, null, 2)}`);
  console.error('Removed the build folder path from required-server-files.');
}
