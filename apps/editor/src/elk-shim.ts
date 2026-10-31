// elkjs's bundled build thinks it is its own worker when it loads where
// there is `self` but no `document`, as in our compile worker, and then
// takes over `onmessage` instead of running in-thread. It loads parts of
// itself lazily, on the first layout, so the placeholder `document` stays.
Object.assign(self, { document: {} });
