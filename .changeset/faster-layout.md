---
'@bpmn-text/layout': patch
---

Run elkjs directly instead of through its in-thread worker API, which waited
on two zero-delay timers per layout. On Windows each of those takes about
15 ms, so a small diagram compiled in about 30 ms instead of 8, and one with
several subprocesses took up to 190 ms instead of 14. The layouts are the same.
