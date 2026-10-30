# Test fixtures

`examples/` holds the user-facing example corpus. `test/fixtures/` holds edge
cases. Both are inputs to the golden, diagnostics and layout tests, and
`test/corpus.test.ts` checks the conventions below.

## Layout

| Path | Contents |
|---|---|
| `examples/NN-name.bpmnt` | Complete, realistic processes, referenced from notation §13 |
| `test/fixtures/valid/name.bpmnt` | Small valid files for features the examples do not show |
| `test/fixtures/diagnostics/BTxxx-name.bpmnt` | One file per diagnostic code in notation §11 |

Expected outputs (such as golden `.bpmn` files) will sit next to their source
with the same base name when the generator exists.

## Header

Every file starts with a comment block:

```text
# BT302: A new start event leaves the previous chain open.
# expect: BT302 @ 4:1
# covers: §5
```

- **First line:** what the file shows. A diagnostics fixture starts with its
  code.
- **`# expect: CODE @ line:col`:** one line per diagnostic the compiler must
  report. The list is the **exact** set, of every severity, in any order: a
  missing or an extra diagnostic fails the test.
- **`# covers: §x, §y.z`:** the notation sections the file exercises. Every
  section from §4 to §10 must be covered by at least one example or valid
  fixture. Covering a subsection (§4.2) also covers its section (§4).

Rules for each kind of file:

| Kind | `expect` lines | `covers` line |
|---|---|---|
| Example | None. Must compile with no errors or warnings; `info` diagnostics are allowed. | Required |
| Valid fixture | None. Must compile with no diagnostics at all. | Required |
| Diagnostics fixture | At least one, including one for the code in its file name. | Optional |

Keep fixtures minimal and give every process a start and an end event, so
that unrelated diagnostics (such as BT303) do not appear.

## Positions

Lines and columns are 1-based and count the header lines. Columns count
characters; fixtures stay ASCII so the encoding never matters. A diagnostic
points at:

| Diagnostic | Position |
|---|---|
| Syntax and lexical errors (BT001, BT004) | The first character that cannot be accepted, or the opening `[` or `"` that is never closed |
| BT002 | The tab character |
| BT003 | The first non-blank character of the line |
| Element errors (BT101, BT102, BT222, BT230, BT250, BT301, BT302, BT304) | The keyword or word in error: the statement keyword, or the event type for BT102 |
| Attribute errors (BT103, BT104, BT240, BT251) | The attribute key, or the value for BT104 |
| Reference and flow errors (BT201, BT202, BT210, BT211, BT212) | The target reference |
| `@id` errors (BT203) | The `@` of the duplicate ID |
| Branch errors (BT220, BT221) | The first token of the offending branch content (`task`, `else`) |
| BT224 | The `fork` keyword |
| BT241 | The keyword of the last element of the open chain |
| BT303 | The first statement of the process: its `pool` keyword, or the first statement of a document without pools |

## Error recovery

The diagnostics fixtures rely on these recovery rules, so each file reports
the same set of diagnostics whatever else the parser does:

- **BT001:** the rest of the line is skipped and parsing continues on the next
  line.
- **BT002:** after reporting, a tab counts as two spaces.
- **BT003:** the line belongs to the block of the nearest preceding header
  line with smaller indentation.
- **BT004:** the string runs to the end of the line.
- **BT101:** the line is skipped.
- **BT102:** the event is treated as untyped.
- **BT224:** the `fork` branches are still declared, with no incoming flow, so
  their first elements are also reported as BT301.
