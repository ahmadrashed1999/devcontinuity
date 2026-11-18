import fs from 'node:fs';
import path from 'node:path';
import { clip } from '../adapters/types';
import { redactSecrets } from '../security/redact';

/** Facts read directly from the project folder as it exists now. Everything here is verified, never inferred. */
export interface RepoFacts {
  exists: boolean;
  root: string;
  topLevel: { name: string; dir: boolean }[];
  modules: { area: string; entries: string[] }[];
  stack: { name: string; evidence: string }[];
  manifests: string[];
  readmeExcerpt?: string;
  database: string[];
  api: string[];
  tests: string[];
  scripts: Record<string, string>;
}

const IGNORE = new Set(['node_modules', '.git', 'vendor', 'build', 'dist', '.dart_tool', '.next', '.gradle', '.idea', '.vscode', 'Library', 'Temp', 'obj', 'bin', '.venv', 'venv', '__pycache__', 'Pods', '.claude', '.devcontinuity', 'coverage', 'storage']);

function read(file: string, max = 200_000): string | undefined {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 5_000_000) return undefined;
    return fs.readFileSync(file, 'utf8').slice(0, max);
  } catch {
    return undefined;
  }
}

function list(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function countFiles(dir: string, match: RegExp, depth = 0, cap = 5000): number {
  if (depth > 6) return 0;
  let n = 0;
  for (const e of list(dir)) {
    if (n >= cap) break;
    if (e.isDirectory()) {
      if (!IGNORE.has(e.name)) n += countFiles(path.join(dir, e.name), match, depth + 1, cap - n);
    } else if (match.test(e.name)) n++;
  }
  return n;
}

const JS_STACK: [RegExp, string][] = [
  [/^next$/, 'Next.js'], [/^react$/, 'React'], [/^react-native$/, 'React Native'], [/^expo$/, 'Expo'], [/^vue$/, 'Vue'], [/^@angular\/core$/, 'Angular'],
  [/^svelte$/, 'Svelte'], [/^express$/, 'Express'], [/^@nestjs\/core$/, 'NestJS'], [/^tailwindcss$/, 'Tailwind CSS'], [/^prisma$|^@prisma\/client$/, 'Prisma'],
  [/^typescript$/, 'TypeScript'], [/^vite$/, 'Vite'], [/^electron$/, 'Electron'], [/^firebase$/, 'Firebase'], [/^@supabase\/supabase-js$/, 'Supabase'],
  [/^vitest$/, 'Vitest'], [/^jest$/, 'Jest'], [/^playwright$|^@playwright\/test$/, 'Playwright'],
];
const DART_STACK: [RegExp, string][] = [[/^\s+firebase_core:/m, 'Firebase'], [/^\s+flutter_riverpod:|^\s+riverpod:/m, 'Riverpod'], [/^\s+flutter_bloc:|^\s+bloc:/m, 'BLoC'], [/^\s+get:/m, 'GetX'], [/^\s+provider:/m, 'Provider'], [/^\s+dio:/m, 'Dio'], [/^\s+supabase_flutter:/m, 'Supabase']];

export function inspectRepository(root: string): RepoFacts {
  const facts: RepoFacts = { exists: false, root, topLevel: [], modules: [], stack: [], manifests: [], database: [], api: [], tests: [], scripts: {} };
  try {
    if (!fs.statSync(root).isDirectory()) return facts;
  } catch {
    return facts;
  }
  facts.exists = true;
  const top = list(root);
  facts.topLevel = top.filter((e) => !e.name.startsWith('.') || ['.github', '.env.example'].includes(e.name)).filter((e) => !IGNORE.has(e.name)).map((e) => ({ name: e.name, dir: e.isDirectory() })).slice(0, 80);
  const has = (name: string) => top.some((e) => e.name === name);
  const add = (name: string, evidence: string) => {
    if (!facts.stack.some((s) => s.name === name)) facts.stack.push({ name, evidence });
  };

  const pkgRaw = read(path.join(root, 'package.json'));
  if (pkgRaw) {
    facts.manifests.push('package.json');
    try {
      const pkg = JSON.parse(pkgRaw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      add('Node.js', 'package.json present');
      for (const [dep, ver] of Object.entries(deps)) for (const [re, name] of JS_STACK) if (re.test(dep)) add(name, `package.json: ${dep}@${ver}`);
      for (const [k, v] of Object.entries(pkg.scripts ?? {}).slice(0, 25)) facts.scripts[k] = clip(redactSecrets(String(v)), 160);
    } catch {
      /* invalid package.json: listed as a manifest only */
    }
  }
  const pubspec = read(path.join(root, 'pubspec.yaml'));
  if (pubspec) {
    facts.manifests.push('pubspec.yaml');
    add(/^\s+flutter:\s*$/m.test(pubspec) || /sdk:\s*flutter/.test(pubspec) ? 'Flutter' : 'Dart', 'pubspec.yaml present');
    for (const [re, name] of DART_STACK) if (re.test(pubspec)) add(name, 'pubspec.yaml dependency');
  }
  const composer = read(path.join(root, 'composer.json'));
  if (composer) {
    facts.manifests.push('composer.json');
    add('PHP', 'composer.json present');
    if (/"laravel\/framework"/.test(composer)) add('Laravel', 'composer.json: laravel/framework');
    if (/"livewire\/livewire"/.test(composer)) add('Livewire', 'composer.json: livewire/livewire');
  }
  if (has('artisan')) add('Laravel', 'artisan file present');
  for (const f of ['requirements.txt', 'pyproject.toml']) {
    const c = read(path.join(root, f));
    if (c) {
      facts.manifests.push(f);
      add('Python', `${f} present`);
      for (const [re, name] of [[/django/i, 'Django'], [/fastapi/i, 'FastAPI'], [/flask/i, 'Flask']] as [RegExp, string][]) if (re.test(c)) add(name, `${f} mentions ${name.toLowerCase()}`);
    }
  }
  const unity = read(path.join(root, 'ProjectSettings', 'ProjectVersion.txt'));
  if (unity) add('Unity', `ProjectSettings/ProjectVersion.txt: ${clip(unity.split('\n')[0].trim(), 60)}`);
  for (const [file, name] of [['Cargo.toml', 'Rust'], ['go.mod', 'Go'], ['Dockerfile', 'Docker'], ['docker-compose.yml', 'Docker Compose'], ['firebase.json', 'Firebase'], ['wrangler.toml', 'Cloudflare Workers'], ['wrangler.jsonc', 'Cloudflare Workers']] as const) {
    if (has(file)) {
      add(name, `${file} present`);
      facts.manifests.push(file);
    }
  }
  if (top.some((e) => /\.(sln|csproj)$/i.test(e.name))) add('.NET', 'solution/project file present');
  if (has('android') && has('ios')) add('Mobile (Android + iOS targets)', 'android/ and ios/ folders present');

  for (const name of ['README.md', 'readme.md', 'README.MD', 'README']) {
    const c = read(path.join(root, name), 6000);
    if (c) {
      facts.readmeExcerpt = clip(redactSecrets(c.replace(/\r/g, '').trim()), 1800);
      break;
    }
  }

  for (const area of ['src', 'lib', 'app', 'packages', 'apps', 'Assets', 'resources', 'routes', 'database']) {
    if (!has(area)) continue;
    const entries = list(path.join(root, area)).filter((e) => !IGNORE.has(e.name) && !e.name.startsWith('.')).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).slice(0, 40);
    if (entries.length) facts.modules.push({ area, entries });
  }

  const prismaSchema = read(path.join(root, 'prisma', 'schema.prisma'));
  if (prismaSchema) {
    const provider = prismaSchema.match(/datasource\s+\w+\s*{[^}]*provider\s*=\s*"([^"]+)"/)?.[1];
    facts.database.push(`prisma/schema.prisma: provider "${provider ?? 'unknown'}", ${(prismaSchema.match(/^model\s+\w+/gm) ?? []).length} model(s)`);
  }
  for (const dir of ['database/migrations', 'migrations', 'prisma/migrations', 'supabase/migrations', 'db/migrate']) {
    const n = list(path.join(root, dir)).length;
    if (n) facts.database.push(`${dir}/: ${n} entr${n === 1 ? 'y' : 'ies'}`);
  }
  const envExample = read(path.join(root, '.env.example'), 20_000);
  const conn = envExample?.match(/^DB_CONNECTION=(\w+)/m)?.[1];
  if (conn) facts.database.push(`.env.example: DB_CONNECTION=${conn}`);
  const sql = top.filter((e) => /\.sql$/i.test(e.name)).map((e) => e.name);
  if (sql.length) facts.database.push(`SQL files at the root: ${sql.slice(0, 8).join(', ')}${sql.length > 8 ? ` (+${sql.length - 8} more)` : ''}`);
  if (has('supabase')) facts.database.push('supabase/ folder present');

  const apiPhp = read(path.join(root, 'routes', 'api.php'));
  if (apiPhp) facts.api.push(`routes/api.php: ${(apiPhp.match(/Route::/g) ?? []).length} Route:: declaration(s)`);
  const webPhp = read(path.join(root, 'routes', 'web.php'));
  if (webPhp) facts.api.push(`routes/web.php: ${(webPhp.match(/Route::/g) ?? []).length} Route:: declaration(s)`);
  for (const dir of ['src/app/api', 'app/api', 'pages/api', 'src/pages/api']) {
    const n = countFiles(path.join(root, dir), /^(route|index|\[.*\])\.(ts|js|tsx)$|\.(ts|js)$/);
    if (n) facts.api.push(`${dir}/: ${n} handler file(s)`);
  }
  for (const f of ['openapi.yaml', 'openapi.yml', 'openapi.json', 'swagger.json', 'swagger.yaml']) if (has(f)) facts.api.push(`${f} present (API specification)`);

  for (const dir of ['test', 'tests', '__tests__', 'spec', 'integration_test']) {
    if (has(dir)) facts.tests.push(`${dir}/: ${countFiles(path.join(root, dir), /\.(dart|ts|tsx|js|php|py|cs|go|rs)$/)} source file(s)`);
  }
  for (const f of ['phpunit.xml', 'pytest.ini', 'playwright.config.ts', 'playwright.config.js']) if (has(f)) facts.tests.push(`${f} present`);
  for (const e of top) if (/^(jest|vitest)\.config\./.test(e.name)) facts.tests.push(`${e.name} present`);
  return facts;
}
