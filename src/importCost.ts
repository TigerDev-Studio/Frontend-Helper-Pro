import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

export interface ImportReference {
  source: string;
  packageName: string;
  start: number;
  end: number;
  line: number;
}

export interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export interface ImportCostSize {
  packageSpec: string;
  name: string;
  version?: string;
  size: number;
  gzip?: number;
  dependencyCount?: number;
  source?: 'bundlephobia' | 'local';
}

const IMPORT_PATTERNS = [
  /\bimport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bexport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
];

const NODE_BUILTINS = new Set([
  'assert',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'timers',
  'tls',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'worker_threads',
  'zlib'
]);

export function findImportReferences(text: string): ImportReference[] {
  const references = new Map<number, ImportReference>();
  const lineStarts = getLineStarts(text);

  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const source = match[1];
      const sourceStart = (match.index ?? 0) + match[0].lastIndexOf(source);
      const packageName = getPackageName(source);
      if (!packageName) {
        continue;
      }

      references.set(sourceStart, {
        source,
        packageName,
        start: sourceStart,
        end: sourceStart + source.length,
        line: getLineNumber(lineStarts, sourceStart)
      });
    }
  }

  return [...references.values()].sort((left, right) => left.start - right.start);
}

export function getPackageName(source: string): string | undefined {
  if (!source || source.startsWith('.') || source.startsWith('/') || source.startsWith('#') || source.startsWith('~') || source.startsWith('@/')) {
    return undefined;
  }

  const normalizedSource = source.startsWith('node:') ? source.slice(5) : source;
  const parts = normalizedSource.split('/');
  const packageName = normalizedSource.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  if (!packageName || NODE_BUILTINS.has(packageName)) {
    return undefined;
  }

  return packageName;
}

export function getPackageSpec(packageName: string, manifest?: PackageManifest): string {
  const version = getDependencyVersion(packageName, manifest);
  return version ? `${packageName}@${version}` : packageName;
}

export function getDependencyVersion(packageName: string, manifest?: PackageManifest): string | undefined {
  const dependencyGroups = [
    manifest?.dependencies,
    manifest?.peerDependencies,
    manifest?.optionalDependencies,
    manifest?.devDependencies
  ];

  for (const dependencies of dependencyGroups) {
    const version = dependencies?.[packageName];
    const normalizedVersion = version ? normalizeVersionRange(version) : undefined;
    if (normalizedVersion) {
      return normalizedVersion;
    }
  }

  return undefined;
}

export function formatImportCost(size: Pick<ImportCostSize, 'size' | 'gzip'>, showGzip = true): string {
  const minified = formatCompactBytes(size.size);
  if (!showGzip || size.gzip === undefined) {
    return minified;
  }

  return `${minified} (gzipped: ${formatCompactBytes(size.gzip)})`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return 'unknown';
  }

  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }

  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) {
    return `${formatNumber(kilobytes)} kB`;
  }

  return `${formatNumber(kilobytes / 1024)} MB`;
}

export async function estimateLocalPackageSize(projectDirectory: string, packageName: string): Promise<ImportCostSize | undefined> {
  const packageDirectory = getNodeModulesPackagePath(projectDirectory, packageName);
  const manifest = await readPackageManifest(packageDirectory);
  if (!manifest) {
    return undefined;
  }

  const entrypoints = await getPackageEntrypoints(packageDirectory, manifest);
  if (!entrypoints.length) {
    return undefined;
  }

  const files: Buffer[] = [];
  for (const entrypoint of entrypoints) {
    const file = await fs.readFile(entrypoint).catch(() => undefined);
    if (file) {
      files.push(file);
    }
  }
  if (!files.length) {
    return undefined;
  }

  const merged = Buffer.concat(files);
  return {
    packageSpec: packageName,
    name: manifest.name ?? packageName,
    version: manifest.version,
    size: merged.byteLength,
    gzip: zlib.gzipSync(merged).byteLength,
    dependencyCount: Object.keys(manifest.dependencies ?? {}).length,
    source: 'local'
  };
}

export function getNodeModulesPackagePath(projectDirectory: string, packageName: string): string {
  return path.join(projectDirectory, 'node_modules', ...packageName.split('/'));
}

interface LocalPackageManifest extends PackageManifest {
  name?: string;
  version?: string;
  main?: string;
  module?: string;
  browser?: string | Record<string, string | false>;
  exports?: unknown;
}

async function readPackageManifest(packageDirectory: string): Promise<LocalPackageManifest | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(packageDirectory, 'package.json'), 'utf8')) as LocalPackageManifest;
  } catch {
    return undefined;
  }
}

async function getPackageEntrypoints(packageDirectory: string, manifest: LocalPackageManifest): Promise<string[]> {
  const candidates = [
    getExportEntrypoint(manifest.exports),
    typeof manifest.browser === 'string' ? manifest.browser : undefined,
    manifest.module,
    manifest.main,
    'index.js',
    'index.mjs',
    'dist/index.js',
    'dist/index.mjs'
  ].filter((candidate): candidate is string => Boolean(candidate));

  const entrypoints: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const entrypoint = await resolveEntrypoint(packageDirectory, candidate);
    if (entrypoint && !seen.has(entrypoint)) {
      seen.add(entrypoint);
      entrypoints.push(entrypoint);
    }
  }

  return entrypoints.slice(0, 3);
}

async function resolveEntrypoint(packageDirectory: string, candidate: string): Promise<string | undefined> {
  const normalizedCandidate = candidate.replace(/^\.\//, '');
  const absoluteCandidate = path.resolve(packageDirectory, normalizedCandidate);
  if (!absoluteCandidate.startsWith(packageDirectory)) {
    return undefined;
  }

  const extensions = ['', '.js', '.mjs', '.cjs', '.css'];
  for (const extension of extensions) {
    const file = `${absoluteCandidate}${extension}`;
    if (await isFile(file)) {
      return file;
    }
  }

  for (const indexFile of ['index.js', 'index.mjs', 'index.cjs', 'index.css']) {
    const file = path.join(absoluteCandidate, indexFile);
    if (await isFile(file)) {
      return file;
    }
  }

  return undefined;
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function getExportEntrypoint(exportsField: unknown): string | undefined {
  if (typeof exportsField === 'string') {
    return exportsField;
  }

  if (!exportsField || typeof exportsField !== 'object') {
    return undefined;
  }

  const record = exportsField as Record<string, unknown>;
  const rootExport = record['.'] ?? record;
  return getConditionalExportEntrypoint(rootExport);
}

function getConditionalExportEntrypoint(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }

  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  for (const key of ['browser', 'import', 'module', 'default', 'require']) {
    const entrypoint = getConditionalExportEntrypoint(record[key]);
    if (entrypoint) {
      return entrypoint;
    }
  }

  return undefined;
}

function normalizeVersionRange(version: string): string | undefined {
  const normalizedVersion = version.trim();
  if (!normalizedVersion || /^(workspace:|file:|link:|portal:|npm:|git\+|https?:)/.test(normalizedVersion)) {
    return undefined;
  }

  return normalizedVersion;
}

function getLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      starts.push(index + 1);
    }
  }

  return starts;
}

function getLineNumber(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStarts[mid] <= offset && (mid === lineStarts.length - 1 || lineStarts[mid + 1] > offset)) {
      return mid;
    }

    if (lineStarts[mid] > offset) {
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  return 0;
}

function formatNumber(value: number): string {
  return value >= 10 ? value.toFixed(1).replace(/\.0$/, '') : value.toFixed(2).replace(/0$/, '').replace(/\.0$/, '');
}

function formatCompactBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return 'unknown';
  }

  if (bytes < 1024) {
    return `${Math.round(bytes)}`;
  }

  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) {
    return `${formatNumber(kilobytes)}k`;
  }

  return `${formatNumber(kilobytes / 1024)}m`;
}
