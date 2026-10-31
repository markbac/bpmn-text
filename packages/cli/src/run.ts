import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { format as formatSource, parse } from '@bpmn-text/core';
import type { Renderer } from '@bpmn-text/render';
import { watch } from 'chokidar';
import {
  Command,
  CommanderError,
  InvalidArgumentError,
  Option,
} from 'commander';
import { glob, isDynamicPattern } from 'tinyglobby';
import { codeFrame, paint, summary } from './frame.js';
import { check, compile } from './index.js';

/** Where the CLI reads and writes, so that tests can run it in-process. */
export interface Io {
  cwd: string;
  env: Record<string, string | undefined>;
  stdin: { isTTY?: boolean; read(): Promise<string> };
  stdout: { isTTY?: boolean; write(chunk: string | Uint8Array): void };
  stderr: { isTTY?: boolean; write(chunk: string): void };
  /** Ends `--watch`. */
  signal?: AbortSignal;
}

/** Exit codes (architecture §11.1). */
const OK = 0;
const INPUT_ERRORS = 1;
const USAGE = 2;

class UsageError extends Error {}

interface Input {
  /** As shown in messages: the path as given, or `<stdin>`. */
  name: string;
  /** Absolute path; absent for stdin. */
  path?: string;
}

const { version } = createRequire(import.meta.url)('../package.json') as {
  version: string;
};

/**
 * Runs the CLI with `args` (without `node` and the script) and returns the
 * exit code: 0 ok, 1 errors in the input, 2 usage or internal error.
 */
export async function run(args: string[], io: Io): Promise<number> {
  const color = (stream: { isTTY?: boolean }) =>
    paint(Boolean(stream.isTTY) && !io.env.NO_COLOR);
  const err = color(io.stderr);
  let code = OK;
  const fail = (c: number) => (code = Math.max(code, c));

  async function inputs(patterns: string[]): Promise<Input[]> {
    if (patterns.length === 0) {
      if (io.stdin.isTTY) {
        throw new UsageError(
          'No input files. Pass files, globs or - for stdin.',
        );
      }
      return [{ name: '<stdin>' }];
    }
    const result: Input[] = [];
    for (const pattern of patterns) {
      if (pattern === '-') {
        result.push({ name: '<stdin>' });
      } else if (isDynamicPattern(pattern)) {
        const files = await glob(pattern, { cwd: io.cwd });
        if (files.length === 0) {
          throw new UsageError(`No files match ${pattern}.`);
        }
        for (const f of files.sort()) {
          result.push({ name: f, path: resolve(io.cwd, f) });
        }
      } else {
        const path = resolve(io.cwd, pattern);
        if (!existsSync(path))
          throw new UsageError(`${pattern}: no such file.`);
        result.push({ name: pattern, path });
      }
    }
    return result;
  }
  let stdin: Promise<string> | undefined;
  const read = (input: Input) =>
    input.path ? readFile(input.path, 'utf8') : (stdin ??= io.stdin.read());

  const program = new Command('bpmn-text')
    .description('Write BPMN diagrams as text and get laid-out BPMN 2.0 XML.')
    .version(version)
    .exitOverride()
    .configureOutput({
      writeOut: (s) => io.stdout.write(s),
      writeErr: (s) => io.stderr.write(s),
    });

  program
    .command('build')
    .description('Compile .bpmnt files to .bpmn, .svg or .png.')
    .argument('[files...]', 'files or globs; - or none for stdin')
    .option('-o, --out <path>', 'output file or directory (default: stdout)')
    .addOption(
      new Option('-f, --format <format>', 'output format')
        .choices(['bpmn', 'svg', 'png'])
        .default('bpmn'),
    )
    .option('--scale <n>', 'PNG pixels per diagram unit', parseScale, 1)
    .option('-w, --watch', 'rebuild when a file changes')
    .action(
      async (
        patterns: string[],
        opts: {
          out?: string;
          format: 'bpmn' | 'svg' | 'png';
          scale: number;
          watch?: boolean;
        },
      ) => {
        const files = await inputs(patterns);
        if (opts.watch && files.some((f) => !f.path)) {
          throw new UsageError('--watch needs files, not stdin.');
        }
        const toDirectory =
          opts.out !== undefined &&
          (files.length > 1 ||
            /[\\/]$/.test(opts.out) ||
            (existsSync(resolve(io.cwd, opts.out)) &&
              statSync(resolve(io.cwd, opts.out)).isDirectory()));
        if (files.length > 1 && opts.out === undefined) {
          throw new UsageError('Use -o <directory> to build several files.');
        }
        if (toDirectory && files.some((f) => !f.path)) {
          throw new UsageError('Use -o <file> to build from stdin.');
        }
        let renderer: Promise<Renderer> | undefined;
        const render = async (xml: string): Promise<string | Uint8Array> => {
          if (opts.format === 'bpmn') return xml;
          renderer ??= import('@bpmn-text/render').then((r) =>
            r.createRenderer(),
          );
          const r = await renderer;
          return opts.format === 'svg'
            ? r.svg(xml)
            : r.png(xml, { scale: opts.scale });
        };

        async function buildOne(input: Input): Promise<number> {
          const source = await read(input);
          const result = await compile(source);
          const shown = result.diagnostics.filter((d) => d.severity !== 'info');
          for (const d of shown) {
            io.stderr.write(codeFrame(d, source, input.name, err));
          }
          if (result.diagnostics.some((d) => d.severity === 'error')) {
            return INPUT_ERRORS;
          }
          const output = await render(result.xml);
          if (opts.out === undefined) {
            io.stdout.write(output);
          } else {
            const target = toDirectory
              ? join(
                  resolve(io.cwd, opts.out),
                  `${basename(input.path!, extname(input.path!))}.${opts.format}`,
                )
              : resolve(io.cwd, opts.out);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, output);
          }
          return OK;
        }

        try {
          for (const f of files) fail(await buildOne(f));
          if (!opts.watch) return;
          const byPath = new Map(files.map((f) => [f.path!, f]));
          const watcher = watch([...byPath.keys()], { ignoreInitial: true });
          io.stderr.write(
            `Watching ${files.length} file(s). Press Ctrl+C to stop.\n`,
          );
          watcher.on('change', (path) => {
            const input = byPath.get(resolve(path))!;
            buildOne(input).then(
              (c) =>
                io.stderr.write(
                  `${c === OK ? 'Built' : 'Not built'} ${input.name}\n`,
                ),
              (error: unknown) => io.stderr.write(`${String(error)}\n`),
            );
          });
          await new Promise<void>((done) => {
            if (io.signal?.aborted) return done();
            io.signal?.addEventListener('abort', () => done());
          });
          await watcher.close();
          code = OK;
        } finally {
          await (await renderer)?.close();
        }
      },
    );

  program
    .command('check')
    .description('Check .bpmnt files and report problems.')
    .argument('[files...]', 'files or globs; - or none for stdin')
    .addOption(
      new Option('-f, --format <format>', 'report format')
        .choices(['text', 'json'])
        .default('text'),
    )
    .action(async (patterns: string[], opts: { format: 'text' | 'json' }) => {
      const out = color(io.stdout);
      const report: { file: string; diagnostics: unknown[] }[] = [];
      for (const input of await inputs(patterns)) {
        const source = await read(input);
        const { diagnostics } = check(source);
        if (diagnostics.some((d) => d.severity === 'error')) fail(INPUT_ERRORS);
        if (opts.format === 'json') {
          report.push({ file: input.name, diagnostics });
          continue;
        }
        for (const d of diagnostics) {
          io.stdout.write(`${codeFrame(d, source, input.name, out)}\n`);
        }
        io.stdout.write(summary(input.name, diagnostics, out));
      }
      if (opts.format === 'json') {
        io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      }
    });

  program
    .command('fmt')
    .description('Rewrite .bpmnt files in canonical style.')
    .argument('[files...]', 'files or globs; - or none for stdin to stdout')
    .option('--check', 'list files that are not formatted, without writing')
    .action(async (patterns: string[], opts: { check?: boolean }) => {
      for (const input of await inputs(patterns)) {
        const source = await read(input);
        const errors = parse(source).diagnostics.filter(
          (d) => d.severity === 'error',
        );
        if (errors.length > 0) {
          for (const d of errors) {
            io.stderr.write(codeFrame(d, source, input.name, err));
          }
          fail(INPUT_ERRORS);
          continue;
        }
        const formatted = formatSource(source);
        if (opts.check) {
          if (formatted !== source) {
            io.stdout.write(`${input.name}\n`);
            fail(INPUT_ERRORS);
          }
        } else if (!input.path) {
          io.stdout.write(formatted);
        } else if (formatted !== source) {
          await writeFile(input.path, formatted);
        }
      }
    });

  try {
    await program.parseAsync(args, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? OK : USAGE;
    }
    const message =
      error instanceof Error && error.name === 'RenderUnavailableError'
        ? error.message
        : error instanceof UsageError
          ? error.message
          : `Internal error: ${error instanceof Error ? error.message : String(error)}`;
    io.stderr.write(`${err('red', 'error')}: ${message}\n`);
    return USAGE;
  }
  return code;
}

function parseScale(value: string): number {
  const n = Number(value);
  if (!(n > 0 && n <= 10)) {
    throw new InvalidArgumentError('Use a number above 0, up to 10.');
  }
  return n;
}
