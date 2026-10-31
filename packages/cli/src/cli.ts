#!/usr/bin/env node
import { run } from './run.js';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());

process.exitCode = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdin: {
    isTTY: process.stdin.isTTY,
    async read() {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    },
  },
  stdout: process.stdout,
  stderr: process.stderr,
  signal: controller.signal,
});
