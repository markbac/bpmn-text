import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { BpmnModdle } from 'bpmn-moddle';
import { chromium, type Browser } from 'playwright-core';
import { validateXML } from 'xmllint-wasm';

const xsdDir = new URL('../xsd/', import.meta.url);
const schemas = readdirSync(xsdDir)
  .filter((fileName) => fileName.endsWith('.xsd'))
  .map((fileName) => ({
    fileName,
    contents: readFileSync(new URL(fileName, xsdDir), 'utf8'),
  }));

function fail(what: string, problems: string[]): never {
  const list = problems.map((p) => `  - ${p.replace(/\s*\n\s*/g, '\n    ')}`);
  throw new Error(`${what}:\n${list.join('\n')}`);
}

/** Asserts that `xml` is valid against the OMG BPMN 2.0 XSDs. */
export async function expectSchemaValid(xml: string): Promise<void> {
  const result = await validateXML({
    xml: { fileName: 'diagram.bpmn', contents: xml },
    schema: schemas.find((s) => s.fileName === 'BPMN20.xsd')!,
    preload: schemas,
  });
  if (!result.valid) {
    fail(
      'BPMN XML is not valid against the BPMN 2.0 schema',
      result.errors.map((e) =>
        e.loc ? `line ${e.loc.lineNumber}: ${e.message}` : e.rawMessage,
      ),
    );
  }
}

/** Asserts that bpmn-moddle reads `xml` without warnings. */
export async function expectModdleImport(xml: string): Promise<void> {
  let warnings: Error[];
  try {
    ({ warnings } = await new BpmnModdle().fromXML(xml));
  } catch (error) {
    fail('bpmn-moddle could not read the BPMN XML', [String(error)]);
  }
  if (warnings.length > 0) {
    fail(
      'bpmn-moddle reported warnings',
      warnings.map((w) => w.message),
    );
  }
}

const viewerScript = createRequire(import.meta.url).resolve(
  'bpmn-js/dist/bpmn-navigated-viewer.production.min.js',
);
let browser: Promise<Browser> | undefined;

/**
 * Asserts that `xml` imports into the bpmn-js NavigatedViewer, running in
 * headless Chromium, without warnings. Call `closeBrowser()` when done.
 */
export async function expectBpmnJsImport(xml: string): Promise<void> {
  browser ??= chromium.launch().catch((error: unknown) => {
    browser = undefined;
    throw new Error(
      `Could not start headless Chromium for bpmn-js. Install it with ` +
        `"npx playwright-core install chromium".\n${String(error)}`,
    );
  });
  const page = await (await browser).newPage();
  try {
    await page.setContent('<div id="canvas" style="height: 600px"></div>');
    await page.addScriptTag({ path: viewerScript });
    const problems = await page.evaluate(async (source) => {
      const viewer = new (
        window as unknown as {
          BpmnJS: new (options: { container: string }) => {
            importXML(xml: string): Promise<{ warnings: Error[] }>;
          };
        }
      ).BpmnJS({ container: '#canvas' });
      try {
        const { warnings } = await viewer.importXML(source);
        return warnings.map((w) => `warning: ${w.message}`);
      } catch (error) {
        const { message, warnings = [] } = error as Error & {
          warnings?: Error[];
        };
        return [
          `error: ${message}`,
          ...warnings.map((w) => `warning: ${w.message}`),
        ];
      }
    }, xml);
    if (problems.length > 0) {
      fail('bpmn-js could not import the BPMN XML cleanly', problems);
    }
  } finally {
    await page.close();
  }
}

/** Closes the Chromium instance started by `expectBpmnJsImport`. */
export async function closeBrowser(): Promise<void> {
  const current = browser;
  browser = undefined;
  await (await current)?.close();
}
