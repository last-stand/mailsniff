// Installs the packed tarball into a throwaway project and uses it the way a real consumer
// would: ESM import, CommonJS require, and TypeScript against the shipped declarations.
// Requires a prior build: `pnpm run build && pnpm run smoke`.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const useShell = process.platform === 'win32'; // `.cmd` shims on Windows need a shell

const REQUIRED_FILES = [
  'package.json',
  'README.md',
  'LICENSE',
  'dist/index.js',
  'dist/index.mjs',
  'dist/index.d.ts',
  'dist/index.d.mts',
];
const FORBIDDEN_PREFIXES = ['src/', 'test/', 'scripts/', '.github/'];

const TYPE_FIXTURE = `import { createMailSniff, ValidationError } from 'mailsniff';
import type { MailSniff, MailSniffOptions, MailSniffStatus, RefreshResult } from 'mailsniff';

const options: MailSniffOptions = {
  refreshInterval: '1d',
  matchSubdomains: true,
  dataset: { minDomains: 5 },
};
const sniff: MailSniff = createMailSniff(options);

export const detection: Promise<boolean> = sniff.isDisposableEmail('a@mailinator.com');
export const refreshed: Promise<RefreshResult> = sniff.refresh();
export const current: MailSniffStatus = sniff.status();
export const rejected: readonly string[] = new ValidationError('x', ['y']).invalid;

// @ts-expect-error the email must be a string
void sniff.isDisposableEmail(42);

// @ts-expect-error unsupported interval unit
export const invalid: MailSniffOptions = { refreshInterval: '1s' };
`;

function step(message) {
  console.log(`\n> ${message}`);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: false,
    ...options,
  });
}

function runNpm(args, cwd) {
  return run('npm', args, { cwd, shell: useShell });
}

function packPackage(destination) {
  mkdirSync(destination); // `npm pack --pack-destination` requires an existing directory
  const output = runNpm(
    ['pack', '--json', '--ignore-scripts', '--pack-destination', destination],
    root,
  );
  const [result] = JSON.parse(output);
  assert.ok(result?.filename, 'npm pack did not report a tarball');
  return result;
}

function assertTarballContents(files) {
  const paths = files.map((file) => file.path);

  for (const required of REQUIRED_FILES) {
    assert.ok(paths.includes(required), `the tarball is missing "${required}"`);
  }
  for (const path of paths) {
    assert.ok(
      !FORBIDDEN_PREFIXES.some((prefix) => path.startsWith(prefix)),
      `the tarball must not contain "${path}"`,
    );
  }
  console.log(`  ${paths.length} files, no source or test files included`);
}

function createConsumer(directory, tarball) {
  mkdirSync(directory);
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'mailsniff-smoke', version: '0.0.0', private: true }),
  );
  runNpm(
    ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error', tarball],
    directory,
  );

  assert.ok(existsSync(join(directory, 'node_modules', 'mailsniff', 'package.json')));
  // Redis must stay optional: installing MailSniff must not pull in ioredis.
  assert.ok(!existsSync(join(directory, 'node_modules', 'ioredis')), 'ioredis was installed');
}

function writeConsumerFiles(directory) {
  copyFileSync(join(root, 'scripts', 'smoke', 'checks.cjs'), join(directory, 'checks.cjs'));

  writeFileSync(
    join(directory, 'esm.mjs'),
    [
      "import assert from 'node:assert/strict';",
      "import * as mailsniff from 'mailsniff';",
      "import checks from './checks.cjs';",
      '',
      'await checks(mailsniff, assert);',
      "console.log('  ESM import OK');",
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(directory, 'cjs.cjs'),
    [
      "const assert = require('node:assert/strict');",
      "const mailsniff = require('mailsniff');",
      "const checks = require('./checks.cjs');",
      '',
      'checks(mailsniff, assert).then(',
      "  () => console.log('  CommonJS require OK'),",
      '  (error) => {',
      '    console.error(error);',
      '    process.exitCode = 1;',
      '  },',
      ');',
      '',
    ].join('\n'),
  );

  writeFileSync(join(directory, 'types.mts'), TYPE_FIXTURE);
  writeFileSync(join(directory, 'types.cts'), TYPE_FIXTURE);
  writeFileSync(
    join(directory, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ES2022',
        lib: ['ES2022'],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        // The consumer project has no node_modules of its own; borrow this repo's Node typings.
        typeRoots: [join(root, 'node_modules', '@types')],
        types: ['node'],
      },
      files: ['types.mts', 'types.cts'],
    }),
  );
}

function runConsumer(directory) {
  step('Runtime: ESM import');
  run(process.execPath, ['esm.mjs'], { cwd: directory, stdio: 'inherit' });

  step('Runtime: CommonJS require');
  run(process.execPath, ['cjs.cjs'], { cwd: directory, stdio: 'inherit' });

  step('Types: TypeScript (NodeNext) against the shipped .d.ts, ESM and CJS');
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  run(process.execPath, [tsc, '--project', 'tsconfig.json'], { cwd: directory, stdio: 'inherit' });
  console.log('  types OK');
}

function main() {
  if (!existsSync(join(root, 'dist', 'index.js'))) {
    throw new Error('dist/ not found. Run `pnpm run build` before `pnpm run smoke`.');
  }

  const base = mkdtempSync(join(tmpdir(), 'mailsniff-smoke-'));
  try {
    step('Packing the package');
    const packed = packPackage(join(base, 'pack'));
    assertTarballContents(packed.files);

    step('Installing the tarball into a clean project');
    createConsumer(join(base, 'consumer'), join(base, 'pack', packed.filename));
    writeConsumerFiles(join(base, 'consumer'));

    runConsumer(join(base, 'consumer'));
    console.log('\nSmoke test passed.');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

main();
