# bpmn-text web editor

A live, split-view editor for bpmn-text that runs entirely in the browser:
type on the left, see the laid-out diagram on the right. Nothing is sent to
a server.

- **Live compile** in a Web Worker, 150 ms after you stop typing, with
  errors and warnings underlined in the text. While there are errors, the
  last diagram without errors stays on screen, and zoom and scroll are kept
  between updates.
- **Highlighting and completion**: keywords, event types, attributes, lane
  names after `lane`, and element names after `->` and `~>` (Ctrl+Space).
- **Selection sync**: the cursor highlights its element in the diagram, and
  clicking an element selects its source. Hover an element to see its
  documentation.
- **Files**: download the source (`.bpmnt`), BPMN XML (`.bpmn`), SVG or PNG;
  open the bundled examples. The document is saved in the browser as you
  type.
- **Share links**: *Share link* puts the whole document, compressed, into
  the URL, so the link reopens it exactly in any browser.

## Develop

```bash
npm run dev -w apps/editor        # http://localhost:5173
npm run build -w apps/editor      # static bundle in apps/editor/dist
npm run preview -w apps/editor    # serve the bundle
```

## Self-host

The build is a static site: `index.html` and an `assets/` folder, with
relative paths, so it works from any directory of any static web server.
There is no server-side code and no configuration.

1. Get the bundle: run `npm ci && npm run build -w apps/editor`, or download
   the `editor` artifact of a CI run, or `bpmn-text-editor-<version>.zip`
   from a release.
1. Copy the contents of `apps/editor/dist` to the web server, for example:

    ```bash
    rsync -a apps/editor/dist/ user@intranet:/var/www/bpmn-text/
    ```

Any static host works: an intranet web server, an S3 bucket, Netlify or
Cloudflare Pages (publish directory `apps/editor/dist`, build command
`npm run build -w apps/editor`). GitHub Pages works too, but needs a public
repository or a paid plan for a private one.

The server must serve `.js` files as JavaScript (all common servers do);
the compiler runs in a module Web Worker, which every current browser
supports.
