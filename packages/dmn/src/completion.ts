import type { Suggestion } from '@bpmn-text/core';
import { dmnVocabulary } from './parser.js';

export interface DmnCompletionData {
  /** The names of the file's elements, from the last compile. */
  names: string[];
}

const TOP = ['input', 'decision', 'knowledge', 'source', 'title'];
const BODY = ['doc', 'table', 'literal'];

/** A name as it must be written in `[requires: …]`: quoted where needed. */
export function dmnReferenceText(name: string): string {
  return /[[\],"]|:(\s|$)|\s#/.test(name) ? JSON.stringify(name) : name;
}

/**
 * Completions for the text of a `.dmnt` line before the cursor: keywords
 * at the start of a line, attribute names in `[…]`, element names after
 * `requires:`, types after `type:` and after `:` in a table heading, hit
 * policies after `hit:`, and element names in a table heading. Returns
 * the column the completed word starts at, or undefined where nothing
 * fits. `previous` is the line above, which tells a heading from a rule.
 */
export function suggestDmn(
  before: string,
  data: DmnCompletionData,
  previous = '',
): { from: number; options: Suggestion[] } | undefined {
  const at = (typed: string) => before.length - typed.length;
  const open = before.lastIndexOf('[');
  if (open > before.lastIndexOf(']') && !/^\s*\|/.test(before)) {
    const inside = before.slice(open + 1);
    const value = /(?:^|,)\s*([\w-]+):\s*(?:[^,:]*,\s*)*([^,:]*)$/.exec(inside);
    const key = /(?:^|,)\s*([\w-]*)$/.exec(inside);
    // `key: value, value` — the last key before the cursor decides.
    const keys = [...inside.matchAll(/([\w-]+):/g)];
    const current = keys.at(-1)?.[1];
    const afterKey = keys.length
      ? inside.slice(keys.at(-1)!.index! + current!.length + 1)
      : undefined;
    if (current && afterKey !== undefined && value) {
      const typed = /\s*([^,]*)$/.exec(afterKey)![1]!;
      if (current === 'type') return { from: at(typed), options: types() };
      if (current === 'hit')
        return {
          from: at(typed),
          options: dmnVocabulary.hitPolicies.map((h) => ({
            label: h,
            type: 'type' as const,
          })),
        };
      if (current === 'requires' || current === 'params') {
        // After a comma, a new attribute may start instead.
        const names = data.names.map((n) => ({
          label: n,
          type: 'variable' as const,
          ...(dmnReferenceText(n) !== n ? { apply: dmnReferenceText(n) } : {}),
        }));
        const fresh = /,\s*[\w-]*$/.test(afterKey);
        return {
          from: at(typed),
          options: fresh ? [...names, ...attributes()] : names,
        };
      }
      if (/,\s*[\w-]*$/.test(afterKey))
        return { from: at(key?.[1] ?? ''), options: attributes() };
      return undefined;
    }
    if (key) return { from: at(key[1]!), options: attributes() };
    return undefined;
  }
  const row = /^\s*\|/.test(before);
  if (row) {
    const heading = /^\s*table\b/.test(previous);
    const cell = /\|\s*(->\s*)?([^|]*)$/.exec(before)!;
    const typed = cell[2]!;
    const type = /:\s*(\w*)$/.exec(typed);
    if (heading && type) return { from: at(type[1]!), options: types() };
    if (heading && !typed.includes(':'))
      return {
        from: at(typed),
        options: data.names.map((n) => ({ label: n, type: 'variable' })),
      };
    return undefined;
  }
  const word = /^(\s*)([\w-]*)$/.exec(before);
  if (word) {
    const words = word[1]!.length > 0 ? BODY : TOP;
    return {
      from: at(word[2]!),
      options: words.map((k) => ({ label: k, type: 'keyword' })),
    };
  }
  return undefined;
}

const types = (): Suggestion[] =>
  dmnVocabulary.types.map((t) => ({ label: t, type: 'type' }));
const attributes = (): Suggestion[] =>
  dmnVocabulary.attributes.map((a) => ({
    label: a,
    type: 'property',
    apply: `${a}: `,
  }));
