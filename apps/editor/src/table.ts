/**
 * Where Tab (or Shift-Tab, `back`) goes from column `col` of a table row:
 * the text of the next cell, or the place to type in an empty one.
 * Undefined outside a row, or past its last cell, so Tab indents instead.
 */
export function nextCell(
  text: string,
  col: number,
  back = false,
): { from: number; to: number } | undefined {
  if (!/^\s*\|/.test(text)) return undefined;
  const bars: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && text[i + 1] === '|') i++;
    else if (text[i] === '|') bars.push(i);
  }
  // The cell the cursor is in: after the last bar before it.
  let cell = bars.filter((b) => b < col).length - 1;
  if (cell < 0) cell = back ? 0 : -1;
  const target = back ? cell - 1 : cell + 1;
  if (target < 0 || target >= bars.length - 1) return undefined;
  const start = bars[target]! + 1;
  const end = bars[target + 1]!;
  const inner = text.slice(start, end);
  const lead = inner.length - inner.trimStart().length;
  const content = inner.trim();
  if (!content) {
    const at = Math.min(start + 1, end);
    return { from: at, to: at };
  }
  return { from: start + lead, to: start + lead + content.length };
}
