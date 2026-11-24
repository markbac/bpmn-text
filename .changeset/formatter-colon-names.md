---
'@bpmn-text/core': patch
---

The formatter quotes a name that ends in a colon, such as `Every morning :`
before `[non-interrupting]`. Without quotes, the space it puts after the name
made the colon end the name and the line no longer parsed.
