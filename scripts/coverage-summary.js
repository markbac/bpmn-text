// Prints coverage/coverage-summary.json as a Markdown table, for the
// GitHub Actions job summary.
import { readFileSync } from 'node:fs';

const { total } = JSON.parse(
  readFileSync('coverage/coverage-summary.json', 'utf8'),
);
const rows = ['lines', 'statements', 'functions', 'branches'].map(
  (k) => `| ${k} | ${total[k].pct}% | ${total[k].covered}/${total[k].total} |`,
);
console.log(
  [
    '## Coverage',
    '',
    '| Metric | % | Covered |',
    '|---|---|---|',
    ...rows,
  ].join('\n'),
);
