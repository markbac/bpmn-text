---
'bpmn-text': minor
---

Add `option colors types|lanes|all`, which colours elements by type and lanes in
turn. Allow `[color:]` and `[stroke:]` on `data`, `store` and `note`. A pool's colour
now looks the same as on a lane and reaches its lanes, so `.bpmn` files hold a paler
fill for coloured pools than before. Add `bpmn-text legend` and `build --legend`,
which draw a key to the symbols a diagram uses as a separate image, with the same in
the web editor's Download menu and `legend()` and `composeLegend()` in the API.
