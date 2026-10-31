// Packs the release artifacts into release/ (#49), after `npm run build`:
//
// - bpmn-text-<version>.tgz: the CLI and compile() API as one npm package,
//   with the workspace packages bundled in, since they are not published.
//   Install it with `npm install -g ./bpmn-text-<version>.tgz`.
// - bpmn-text-editor-<version>.zip: the static web editor.
// - the VS Code extension's .vsix, once apps/vscode has a `package` script.
//
// `--cli-only` makes only the CLI tarball, as the Docker build does.
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'tsup';

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const run = (command, args, cwd = '.') =>
  execFileSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

const out = resolve('release');
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
const cli = read('packages/cli/package.json');
const { version } = cli;

// The CLI package: workspace code bundled, npm dependencies kept external.
const workspaces = ['core', 'layout', 'bpmn', 'render', 'cli'].map((name) =>
  read(`packages/${name}/package.json`),
);
const external = (field) =>
  Object.fromEntries(
    workspaces
      .flatMap((p) => Object.entries(p[field] ?? {}))
      .filter(([name]) => !name.startsWith('@bpmn-text/'))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
const dependencies = external('dependencies');
const optionalDependencies = external('optionalDependencies');
const staging = join(out, 'cli');
await build({
  entry: ['packages/cli/src/index.ts', 'packages/cli/src/cli.ts'],
  outDir: join(staging, 'dist'),
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  noExternal: [/^@bpmn-text\//],
  external: [
    ...Object.keys(dependencies),
    ...Object.keys(optionalDependencies),
  ],
  dts: { resolve: [/^@bpmn-text\//], compilerOptions: { composite: false } },
  clean: true,
  tsconfig: 'packages/cli/tsconfig.json',
  silent: true,
});
writeFileSync(
  join(staging, 'package.json'),
  `${JSON.stringify(
    {
      name: cli.name,
      version,
      description: cli.description,
      type: 'module',
      exports: {
        '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      },
      types: './dist/index.d.ts',
      bin: cli.bin,
      files: ['dist'],
      engines: read('package.json').engines,
      dependencies,
      optionalDependencies,
    },
    null,
    2,
  )}\n`,
);
cpSync('README.md', join(staging, 'README.md'));
run('npm', ['pack', '--pack-destination', out], staging);
rmSync(staging, { recursive: true, force: true });

if (process.argv.includes('--cli-only')) process.exit(0);

// The web editor's static bundle.
const editor = 'apps/editor/dist';
if (!existsSync(join(editor, 'index.html'))) {
  throw new Error('Build the editor first: npm run build');
}
run('zip', ['-qr', join(out, `bpmn-text-editor-${version}.zip`), '.'], editor);

// The VS Code extension, when it can be packaged (milestone M6).
const vscode = read('apps/vscode/package.json');
if (vscode.scripts?.package) {
  run('npm', ['run', 'package', '-w', 'apps/vscode']);
  for (const f of readdirSync('apps/vscode').filter((f) => f.endsWith('.vsix')))
    cpSync(join('apps/vscode', f), join(out, f));
} else {
  console.log('apps/vscode has no package script yet: no .vsix (M6).');
}

console.log(`\nRelease artifacts in release/:\n${readdirSync(out).join('\n')}`);
