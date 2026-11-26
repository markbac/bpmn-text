import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { BpmnModdle } from 'bpmn-moddle';
import { DmnModdle } from 'dmn-moddle';
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

function launch(): Promise<Browser> {
  browser ??= chromium.launch().catch((error: unknown) => {
    browser = undefined;
    throw new Error(
      `Could not start headless Chromium for bpmn-js and dmn-js. Install ` +
        `it with "npx playwright-core install chromium".
${String(error)}`,
    );
  });
  return browser;
}

/**
 * Asserts that `xml` imports into the bpmn-js NavigatedViewer, running in
 * headless Chromium, without warnings. Call `closeBrowser()` when done.
 */
export async function expectBpmnJsImport(xml: string): Promise<void> {
  const page = await (await launch()).newPage();
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

/** Closes the Chromium instance started by `expectBpmnJsImport` or `expectDmnJsImport`. */
export async function closeBrowser(): Promise<void> {
  const current = browser;
  browser = undefined;
  await (await current)?.close();
}

const dmnXsdDir = new URL('../xsd/dmn/', import.meta.url);
const dmnSchemas = readdirSync(dmnXsdDir)
  .filter((fileName) => fileName.endsWith('.xsd'))
  .map((fileName) => ({
    fileName,
    contents: readFileSync(new URL(fileName, dmnXsdDir), 'utf8'),
  }));

/** Asserts that `xml` is valid against the OMG DMN 1.3 XSDs. */
export async function expectDmnSchemaValid(xml: string): Promise<void> {
  const result = await validateXML({
    xml: { fileName: 'decisions.dmn', contents: xml },
    schema: dmnSchemas.find((s) => s.fileName === 'DMN13.xsd')!,
    preload: dmnSchemas,
  });
  if (!result.valid) {
    fail(
      'DMN XML is not valid against the DMN 1.3 schema',
      result.errors.map((e) =>
        e.loc ? `line ${e.loc.lineNumber}: ${e.message}` : e.rawMessage,
      ),
    );
  }
}

/** Asserts that dmn-moddle reads `xml` without warnings. */
export async function expectDmnModdleImport(xml: string): Promise<void> {
  let warnings: Error[];
  try {
    ({ warnings } = await new DmnModdle().fromXML(xml));
  } catch (error) {
    fail('dmn-moddle could not read the DMN XML', [String(error)]);
  }
  if (warnings.length > 0) {
    fail(
      'dmn-moddle reported warnings',
      warnings.map((w) => w.message),
    );
  }
}

const dmnViewerScript = createRequire(import.meta.url).resolve(
  'dmn-js/dist/dmn-viewer.production.min.js',
);

/**
 * Asserts that `xml` imports into the dmn-js Viewer, running in headless
 * Chromium, without warnings, and that every view (the DRD, each decision
 * table and each literal expression) opens. Call `closeBrowser()` when done.
 */
export async function expectDmnJsImport(xml: string): Promise<void> {
  const page = await (await launch()).newPage();
  try {
    await page.setContent('<div id="canvas" style="height: 600px"></div>');
    await page.addScriptTag({ path: dmnViewerScript });
    const problems = await page.evaluate(async (source) => {
      interface View {
        type: string;
        element: { id: string };
      }
      const viewer = new (
        window as unknown as {
          DmnJS: new (options: { container: string }) => {
            importXML(xml: string): Promise<{ warnings: Error[] }>;
            getViews(): View[];
            open(view: View): Promise<{ warnings: Error[] }>;
            getActiveView(): View | undefined;
          };
        }
      ).DmnJS({ container: '#canvas' });
      const problems: string[] = [];
      try {
        const { warnings } = await viewer.importXML(source);
        problems.push(...warnings.map((w) => `warning: ${w.message}`));
        const first = viewer.getActiveView();
        for (const view of viewer.getViews()) {
          if (view === first) continue;
          const opened = await viewer.open(view);
          problems.push(
            ...opened.warnings.map(
              (w) => `warning in ${view.type} ${view.element.id}: ${w.message}`,
            ),
          );
        }
      } catch (error) {
        const { message, warnings = [] } = error as Error & {
          warnings?: Error[];
        };
        problems.push(
          `error: ${message}`,
          ...warnings.map((w) => `warning: ${w.message}`),
        );
      }
      return problems;
    }, xml);
    if (problems.length > 0) {
      fail('dmn-js could not import the DMN XML cleanly', problems);
    }
  } finally {
    await page.close();
  }
}
