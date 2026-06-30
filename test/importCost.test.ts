import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  estimateLocalPackageSize,
  findImportReferences,
  formatBytes,
  formatImportCost,
  getPackageName,
  getPackageSpec
} from '../src/importCost.js';

test('extracts static, dynamic, re-export, and require package imports', () => {
  const text = [
    "import React from 'react';",
    "import { debounce } from 'lodash-es';",
    "import type { Foo } from '@scope/pkg/subpath';",
    "export { x } from 'date-fns';",
    "const mod = await import('nanoid');",
    "const fs = require('fs');",
    "const local = require('./local');"
  ].join('\n');

  const references = findImportReferences(text);

  assert.deepEqual(references.map((reference) => reference.source), [
    'react',
    'lodash-es',
    '@scope/pkg/subpath',
    'date-fns',
    'nanoid'
  ]);
  assert.deepEqual(references.map((reference) => reference.packageName), [
    'react',
    'lodash-es',
    '@scope/pkg',
    'date-fns',
    'nanoid'
  ]);
});

test('ignores relative, aliased, and node built-in imports', () => {
  assert.equal(getPackageName('./button'), undefined);
  assert.equal(getPackageName('@/components/button'), undefined);
  assert.equal(getPackageName('node:path'), undefined);
  assert.equal(getPackageName('path'), undefined);
});

test('creates package specs from package manifests', () => {
  assert.equal(getPackageSpec('react', {
    dependencies: {
      react: '^18.2.0'
    }
  }), 'react@^18.2.0');

  assert.equal(getPackageSpec('workspace-lib', {
    dependencies: {
      'workspace-lib': 'workspace:*'
    }
  }), 'workspace-lib');
});

test('formats import sizes for inline display', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(16 * 1024), '16 kB');
  assert.equal(formatBytes(1536), '1.5 kB');
  assert.equal(formatImportCost({ size: 16 * 1024, gzip: 4.25 * 1024 }), '16k (gzipped: 4.25k)');
  assert.equal(formatImportCost({ size: 910, gzip: 558 }), '910 (gzipped: 558)');
});

test('estimates local package size from installed node_modules package', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frontend-helper-pro-import-cost-'));
  const packageDirectory = path.join(root, 'node_modules', '@scope', 'pkg');
  await fs.mkdir(path.join(packageDirectory, 'dist'), { recursive: true });
  await fs.writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({
    name: '@scope/pkg',
    version: '1.2.3',
    module: './dist/index.js',
    dependencies: {
      leftpad: '^1.0.0'
    }
  }));
  await fs.writeFile(path.join(packageDirectory, 'dist', 'index.js'), 'export const answer = 42;\n');

  const size = await estimateLocalPackageSize(root, '@scope/pkg');

  assert.equal(size?.name, '@scope/pkg');
  assert.equal(size?.version, '1.2.3');
  assert.equal(size?.source, 'local');
  assert.equal(size?.dependencyCount, 1);
  assert.equal(size?.size, 26);
  assert.equal(typeof size?.gzip, 'number');
});
