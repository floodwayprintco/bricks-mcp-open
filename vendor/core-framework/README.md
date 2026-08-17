# Vendored Core Framework compiler

`cf-compiler.cjs` is a Node bundle of Core Framework's own CSS compiler, built
from the upstream sources so the MCP server can compile a preset to a stylesheet
the exact way the wp-admin app does. Core Framework's REST API never compiles
CSS — `PUT /preset` stores token JSON and `PUT /preset-css` accepts
already-compiled CSS — so any headless write path has to be its own compiler,
and the only correct compiler is Core Framework's.

## Provenance

- Upstream: https://github.com/CoreBunch/Core-Framework (MIT)
- Bundled at commit `67bbcaeef4d2e43b32497fe21f8eecac0500d305` (2026-08-14, app version 2.0.0)
- License: MIT — Copyright (c) 2026 David Babinec. This bundle contains that
  code plus its npm dependencies (postcss, postcss-preset-env, colord, and
  friends), each under their own permissive licenses.

## What the bundle exports

- `compilePreset(preset, { gutenbergEnabled })` → `{ css, cssMinified, cssObjects }`
  Mirrors `packages/wp/src/hooks/usePush.ts` (the app's save path) fed by
  `joinedStylesAtom` from `packages/wp/src/state/groupsAtoms.ts`: regenerates
  the css objects from `modulesData` + `styleSheetData`, runs `cssGenerator`
  with the app's exact options, appends the reduced-motion block and custom
  stylesheets, and minifies. The stored top-level `cssObjects` of the input
  preset is deliberately **never** read — it is a stale write-through cache
  (see floodway-assistant#190, the dead-palette trap).
- `buildJoinedCssObjects(preset)` — the regeneration step alone.
- `sanitizePreset(preset)` — the app's pre-save cleanup (strips `cssString`,
  drops legacy colour props, stamps `app_version`).
- `minifyCss(css)`

## Fidelity proof

Compiling local's live preset reproduced the site's served
`uploads/core-framework/css/core_framework.css` **byte-for-byte**
(43,410 bytes, md5 `628cb37e…`). Production compiled to the same stylesheet
except one rule where the served file carries a `-webkit-text-decoration`
prefix that newer browserslist data no longer emits — cosmetic drift from
whenever production's CSS was last compiled, not a compiler difference.

## Rebuilding

```
cd build
npm install
CF_SRC=/path/to/Core-Framework node build.mjs
cp dist/cf-compiler.cjs ..
```

`build/entry.ts` is the only hand-written source: it replicates the jotai
plumbing (atom wiring) that cannot be imported without React. Everything it
calls is bundled from upstream. When upstream moves, re-pin the commit here and
re-run the byte-fidelity check before shipping.
