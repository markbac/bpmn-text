import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectSchemaValid } from '@bpmn-text/test-utils';
import { describe, expect, it } from 'vitest';
import { run, type Io } from '../src/run.js';

const root = join(import.meta.dirname, '../../..');
const temp = () => mkdtempSync(join(tmpdir(), 'bpmn-text-'));

/** Runs the CLI in-process, collecting what it writes. */
async function cli(
  args: string[],
  options: {
    stdin?: string;
    tty?: boolean;
    env?: Io['env'];
    cwd?: string;
    signal?: AbortSignal;
    onStderr?: (text: string) => void;
  } = {},
) {
  let stdout = '';
  let stderr = '';
  const code = await run(args, {
    cwd: options.cwd ?? root,
    env: options.env ?? {},
    stdin: {
      isTTY: options.stdin === undefined,
      read: async () => options.stdin ?? '',
    },
    stdout: {
      isTTY: options.tty ?? false,
      write: (chunk) =>
        (stdout +=
          typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()),
    },
    stderr: {
      isTTY: options.tty ?? false,
      write: (chunk) => {
        stderr += chunk;
        options.onStderr?.(stderr);
      },
    },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { code, stdout, stderr };
}

const diagnosticsFixtures = readdirSync(
  join(root, 'test/fixtures/diagnostics'),
).filter((f) => f.endsWith('.bpmnt'));

describe('bpmn-text build', () => {
  it('builds every example into a directory', async () => {
    const out = temp();
    const { code, stderr } = await cli([
      'build',
      'examples/*.bpmnt',
      '-o',
      out,
    ]);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    const files = readdirSync(out).sort();
    expect(files).toEqual([
      '01-simple.bpmn',
      '02-gateways.bpmn',
      '03-lanes.bpmn',
      '04-collaboration.bpmn',
      '05-events.bpmn',
      '06-subprocess-data.bpmn',
    ]);
    for (const f of files) {
      await expectSchemaValid(readFileSync(join(out, f), 'utf8'));
    }
  });

  it('reads stdin and writes stdout', async () => {
    const { code, stdout } = await cli(['build'], {
      stdin: 'start\ntask Work\nend\n',
    });
    expect(code).toBe(0);
    expect(stdout).toContain('<bpmn:task id="Activity_work" name="Work">');
  });

  it('writes one file to an -o path', async () => {
    const out = join(temp(), 'nested/order.bpmn');
    const { code } = await cli([
      'build',
      'examples/01-simple.bpmnt',
      '-o',
      out,
    ]);
    expect(code).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(
      readFileSync(join(root, 'examples/01-simple.bpmn'), 'utf8'),
    );
  });

  it('writes SVG', async () => {
    const { code, stdout } = await cli([
      'build',
      'examples/01-simple.bpmnt',
      '--format',
      'svg',
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain('<svg');
  });

  it('reports errors with exit code 1 and writes nothing', async () => {
    const out = temp();
    const { code, stderr } = await cli(
      ['build', '-', '-o', join(out, 'x.bpmn')],
      {
        stdin: 'start\ntask A -> Nowhere\nend\n',
      },
    );
    expect(code).toBe(1);
    expect(stderr).toContain('error[BT202]');
    expect(readdirSync(out)).toEqual([]);
  });

  it('exits with 2 on usage errors', async () => {
    expect((await cli(['build', 'missing.bpmnt'])).code).toBe(2);
    expect((await cli(['build', 'examples/*.bpmnt'])).stderr).toContain(
      'Use -o <directory>',
    );
    expect((await cli(['build', 'x', '--format', 'pdf'])).code).toBe(2);
    expect((await cli(['frobnicate'])).code).toBe(2);
    expect((await cli(['build'])).code).toBe(2); // stdin is a terminal
  });

  it('rebuilds on change with --watch', async () => {
    const dir = temp();
    const file = join(dir, 'p.bpmnt');
    writeFileSync(file, 'start\ntask One\nend\n');
    const controller = new AbortController();
    let changed = false;
    const result = cli(['build', 'p.bpmnt', '-o', 'p.bpmn', '--watch'], {
      cwd: dir,
      signal: controller.signal,
      onStderr: (text) => {
        if (text.includes('Watching') && !changed) {
          changed = true;
          // Give the watcher a moment to settle before changing the file.
          setTimeout(() => writeFileSync(file, 'start\ntask Two\nend\n'), 200);
        }
        if (text.includes('Built p.bpmnt')) controller.abort();
      },
    });
    const { code } = await result;
    expect(code).toBe(0);
    expect(readFileSync(join(dir, 'p.bpmn'), 'utf8')).toContain('name="Two"');
  }, 15_000);
});

describe('bpmn-text check', () => {
  it.each(diagnosticsFixtures)('prints code frames for %s', async (f) => {
    const { stdout } = await cli(['check', `test/fixtures/diagnostics/${f}`]);
    expect(stdout).toMatchSnapshot();
  });

  it('exits with 1 on errors and 0 on warnings only', async () => {
    const errors = await cli([
      'check',
      'test/fixtures/diagnostics/BT202-unknown-reference.bpmnt',
    ]);
    expect(errors.code).toBe(1);
    const warnings = await cli([
      'check',
      'test/fixtures/diagnostics/BT222-single-branch.bpmnt',
    ]);
    expect(warnings.stdout).toContain('1 warning');
    expect(warnings.code).toBe(0);
    expect((await cli(['check', 'examples/*.bpmnt'])).code).toBe(0);
  });

  it('writes JSON', async () => {
    const { stdout } = await cli([
      'check',
      '--format',
      'json',
      'test/fixtures/diagnostics/BT202-unknown-reference.bpmnt',
    ]);
    const [report] = JSON.parse(stdout) as {
      file: string;
      diagnostics: { code: string }[];
    }[];
    expect(report!.file).toBe(
      'test/fixtures/diagnostics/BT202-unknown-reference.bpmnt',
    );
    expect(report!.diagnostics.map((d) => d.code)).toEqual(['BT202']);
  });

  it('uses colours only on a terminal without NO_COLOR', async () => {
    const file = 'test/fixtures/diagnostics/BT202-unknown-reference.bpmnt';
    expect((await cli(['check', file], { tty: true })).stdout).toContain(
      '\x1b[31m',
    );
    expect(
      (await cli(['check', file], { tty: true, env: { NO_COLOR: '1' } }))
        .stdout,
    ).not.toContain('\x1b[');
    expect((await cli(['check', file])).stdout).not.toContain('\x1b[');
  });
});

describe('bpmn-text fmt', () => {
  it('finds every example formatted', async () => {
    const { code, stdout } = await cli(['fmt', '--check', 'examples/*.bpmnt']);
    expect(stdout).toBe('');
    expect(code).toBe(0);
  });

  it('formats stdin to stdout', async () => {
    const { stdout } = await cli(['fmt'], { stdin: 'start\ntask   A\nend\n' });
    expect(stdout).toBe('start\ntask A\nend\n');
  });

  it('rewrites files, or lists them with --check', async () => {
    const dir = temp();
    writeFileSync(join(dir, 'a.bpmnt'), 'start\ntask   A\nend\n');
    const checked = await cli(['fmt', '--check', 'a.bpmnt'], { cwd: dir });
    expect(checked).toMatchObject({ code: 1, stdout: 'a.bpmnt\n' });
    expect((await cli(['fmt', 'a.bpmnt'], { cwd: dir })).code).toBe(0);
    expect(readFileSync(join(dir, 'a.bpmnt'), 'utf8')).toBe(
      'start\ntask A\nend\n',
    );
  });

  it('refuses to format source with syntax errors', async () => {
    const { code, stderr } = await cli(['fmt'], { stdin: 'start [\n' });
    expect(code).toBe(1);
    expect(stderr).toContain('error[BT001]');
  });
});
