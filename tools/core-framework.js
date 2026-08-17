/**
 * Core Framework Tools — READ ONLY
 *
 * Core Framework is the design system behind the site: colour tokens, the fluid
 * type scale, spacing, layouts. Until CF 2.0 (MIT, 2026-08-13) none of it was
 * reachable from here, so token changes were manual wp-admin clicks with no
 * snapshot and no rollback record. These tools close the read half of that gap.
 *
 * Auth
 * ----
 * CF exposes two REST auth models under `core-framework/v2`:
 *
 *   verify_nonce   — 21 routes. Needs an X-WP-Nonce header plus manage_options.
 *                    Browser-session bound, so an application password does NOT
 *                    satisfy it. Unusable from here.
 *   verify_api_key — 8 routes. Takes a `key` request param and hash_equals its
 *                    FIRST 24 CHARACTERS against the core_framework_api_key
 *                    option. No cookie, no nonce, no user.
 *
 * So everything here goes through the api-key channel. The key is minted in the
 * CF panel in wp-admin and belongs in the per-site config, never the repo:
 *
 *   ~/mcp-config/bricks-sites.json → sites.<key>.cfApiKey
 *   or the CORE_FRAMEWORK_API_KEY env var as a fallback
 *
 * The full key is `<24 random chars><url-encoded site url>`. Either the full
 * string or just the 24-char head authenticates, since only the head is compared.
 *
 * Deliberately read-only
 * ----------------------
 * There are no write tools in this module, and that is not an oversight.
 * **The CF server never compiles CSS.** `PUT /preset` stores token JSON in the
 * presets table; `PUT /preset-css` accepts ALREADY-COMPILED CSS and writes the
 * stylesheet. The client is the compiler. So a token write that does not also
 * ship freshly compiled CSS leaves the stored data and the served stylesheet
 * disagreeing, silently, with the site rendering the stale one. Writes wait
 * until the compiler from packages/core is ported and a round-trip is proven on
 * local. See floodway-assistant#190.
 */
import { createHash } from 'crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getActiveSite, getActiveSiteKey } from '../site-manager.js';

const CF_NAMESPACE = '/wp-json/core-framework/v2';
const SNAPSHOT_ROOT = join(homedir(), '.bricks-mcp', 'cf-snapshots');
const REQUEST_TIMEOUT = 20000; // the preset runs ~120 KB, so allow more than the 10s default

/* ------------------------------------------------------------------ *
 * Credentials
 * ------------------------------------------------------------------ */

/**
 * Resolve the CF API key for the active site.
 * Never returns the key in an error message — a bad key must not leak into logs.
 */
function resolveCfKey() {
  const site = getActiveSite();
  const key = (site.cfApiKey || process.env.CORE_FRAMEWORK_API_KEY || '').trim();

  if (!key) {
    throw new Error(
      `No Core Framework API key for site "${site.key}" (${site.label}).\n\n` +
      `Mint one in wp-admin → Core Framework, then add it to the site entry:\n` +
      `  ~/mcp-config/bricks-sites.json → sites.${site.key}.cfApiKey\n` +
      `or set CORE_FRAMEWORK_API_KEY in the environment.\n\n` +
      `It is a credential — per-machine config only, never the repo.`
    );
  }

  if (key.length < 24) {
    throw new Error(
      `The Core Framework API key for site "${site.key}" is too short ` +
      `(${key.length} chars, needs at least 24). CF compares the first 24 ` +
      `characters, so a truncated key can never authenticate. Re-copy it from ` +
      `wp-admin → Core Framework.`
    );
  }

  return key;
}

/**
 * GET a CF api-key route on the active site.
 * Bypasses utils/wp-api.js on purpose: that client sends Basic Auth against the
 * bricks-api-bridge namespace, and this channel authenticates by key instead.
 */
async function cfGet(route) {
  const site = getActiveSite();
  const key = resolveCfKey();
  const url = `${site.url}${CF_NAMESPACE}${route}?key=${encodeURIComponent(key)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip, br' },
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Core Framework rejected the API key for site "${site.key}" (HTTP ${response.status}).\n` +
        `Check that sites.${site.key}.cfApiKey matches the key shown in ` +
        `wp-admin → Core Framework on ${site.url}. Keys are per-site: a key from ` +
        `another site will always fail here.`
      );
    }

    if (response.status === 404) {
      throw new Error(
        `No Core Framework REST route at ${site.url}${CF_NAMESPACE}${route} (HTTP 404).\n` +
        `Either Core Framework is not active on this site, or it predates the ` +
        `v2 namespace. Floodway's production and local are both on CF 2.0.`
      );
    }

    if (!response.ok) {
      throw new Error(`Core Framework API error ${response.status} on ${route}`);
    }

    const text = await response.text();
    if (!text) throw new Error(`Core Framework returned an empty body for ${route}`);

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        `Core Framework returned non-JSON for ${route} (${text.length} bytes). ` +
        `First 200 chars: ${text.slice(0, 200)}`
      );
    }

    if (parsed.success === false) {
      throw new Error(`Core Framework reported failure on ${route}: ${parsed.message || '(no message)'}`);
    }

    return { data: parsed.data ?? parsed, bytes: Buffer.byteLength(text) };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Core Framework request timed out after ${REQUEST_TIMEOUT}ms on ${route}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * Summarising
 * ------------------------------------------------------------------ */

const MODULE_SECTIONS = {
  typography: 'FLUID_TYPOGRAPHY',
  colors: 'COLOR_SYSTEM',
  colours: 'COLOR_SYSTEM',
  spacing: 'FLUID_SPACING',
  components: 'COMPONENTS',
  fonts: 'FONTS',
  stylesheets: 'STYLESHEETS',
};

function flattenColors(preset) {
  const groups = preset?.modulesData?.COLOR_SYSTEM?.groups || [];
  const out = [];
  for (const group of groups) {
    for (const colour of group.colors || []) {
      out.push({
        group: group.name,
        name: colour.name,
        value: colour.value,
        shades: (colour.shades || []).length,
        tints: (colour.tints || []).length,
      });
    }
  }
  return out;
}

/**
 * Summarise the type scale, and flag any step whose max is below its min.
 *
 * That inversion is real and currently expected on Floodway: steps below the
 * base index invert whenever the max ratio exceeds the min ratio, and CSS
 * resolves clamp(MIN, VAL, MAX) with MAX < MIN to MIN, so the step is pinned
 * rather than fluid. Settled as accept-and-document — see floodway-assistant#192.
 * Surfaced here so a future scale change does not reintroduce it unnoticed.
 *
 * 🚨 manualSizes is a PRECOMPUTED CACHE and can be stale. On Floodway both
 * sites store text-2xl as calc(1.84vw + 1.69rem) while actually serving
 * 1.9vw (production) and 1.55vw (local) — it was never regenerated after
 * max_screen_width last changed. Comparing two sites' manualSizes therefore
 * showed zero difference while the served stylesheets differed by 8.6px on
 * text-4xl, which nearly buried floodway-assistant#196. So the summary carries
 * an explicit staleness warning: for anything about RENDERED output, read the
 * served stylesheet, never this.
 */
function summariseTypography(preset) {
  const groups = preset?.modulesData?.FLUID_TYPOGRAPHY?.groups || [];
  return groups.map(group => {
    const steps = (group.manualSizes || []).map(step => ({
      name: step.name,
      min: step.min,
      max: step.max,
      pinned: typeof step.min === 'number' && typeof step.max === 'number' && step.max < step.min,
    }));
    return {
      name: group.name,
      min: group.min,
      max: group.max,
      baseScaleIndex: group.baseScaleIndex,
      namingConvention: group.namingConvention,
      mode: group.mode,
      steps,
      pinnedSteps: steps.filter(s => s.pinned).map(s => s.name),
      sourceWarning:
        'These figures come from the preset\'s precomputed manualSizes cache, which is ' +
        'NOT regenerated when max_screen_width changes and is currently stale on both ' +
        'Floodway sites. For rendered output, read the served stylesheet ' +
        '(uploads/core-framework/css/core_framework.css) instead. See floodway-assistant#196.',
    };
  });
}

function summarise(preset, bytes) {
  const sheet = preset.styleSheetData || {};
  const typography = summariseTypography(preset);
  const colours = flattenColors(preset);

  return {
    preset: {
      id: preset.id,
      name: preset.name,
      appVersion: preset.app_version,
      updatedAt: preset.updatedAt ? new Date(preset.updatedAt).toISOString() : null,
      bytes,
    },
    preferences: preset.preferences,
    breakpoints: preset.breakpoints,
    styleSheetCounts: Object.fromEntries(
      Object.entries(sheet).map(([k, v]) => [k, Array.isArray(v) ? v.length : null])
    ),
    colours,
    typography,
    modules: Object.keys(preset.modulesData || {}),
    fonts: summariseFonts(preset),
    cssObjects: summariseCssObjects(preset),
  };
}

/**
 * CF's FONTS module holds font *configuration* independently of whether the
 * files exist. Local carries a full Raleway import (18 @font-face across nine
 * weights) pointing at uploads/core-framework/fonts/Raleway-*.woff2 — files
 * that are no longer on disk. So "does CF have fonts" and "does the site serve
 * them" are different questions, and reading one for the other is how this got
 * recorded wrong once already.
 */
function summariseFonts(preset) {
  const fonts = preset?.modulesData?.FONTS?.fonts || [];
  return {
    count: fonts.length,
    families: fonts.map(f => ({
      family: (f.cssPreview?.match(/font-family:\s*'([^']+)'/) || [])[1] || f.id,
      category: f.category,
      faces: (f.cssPreview?.match(/@font-face/g) || []).length,
      referencedFiles: [...new Set((f.cssPreview?.match(/url\('([^']+)'\)/g) || []))].length,
    })),
  };
}

/**
 * cssObjects is the compiled CSS representation stored inside the preset, and
 * it can be badly stale: on Floodway production it is 154 KB carrying a :root
 * with CF's default blue --primary (#2364a9) while the token data and the
 * served stylesheet both say the brand gold. Harmless today because nothing
 * recompiles from it, but it matters for any future write path, so surface its
 * size and whether its --primary agrees with COLOR_SYSTEM rather than hiding
 * 57% of the payload behind a summary.
 */
function summariseCssObjects(preset) {
  const objects = preset?.cssObjects;
  if (!Array.isArray(objects)) return { present: false };

  const roots = objects.filter(o => o.selector === ':root');
  let compiledPrimary = null;
  for (const root of roots) {
    const decl = (root.declarations || []).find(d => d.property === '--primary');
    if (decl) { compiledPrimary = decl.value; break; }
  }

  const tokenPrimary = flattenColors(preset).find(c => c.name === 'primary')?.value ?? null;
  const agrees = compiledPrimary && tokenPrimary
    ? compiledPrimary.toLowerCase() === tokenPrimary.toLowerCase()
    : null;

  return {
    present: true,
    entries: objects.length,
    bytes: JSON.stringify(objects).length,
    rootBlocks: roots.length,
    compiledPrimary,
    tokenPrimary,
    agreesWithTokens: agrees,
    ...(agrees === false && {
      warning: 'Compiled cssObjects disagrees with COLOR_SYSTEM. Stale compiled data — ' +
               'check the served stylesheet before trusting either, and do not round-trip ' +
               'this blob through a future PUT /preset.',
    }),
  };
}

/* ------------------------------------------------------------------ *
 * Snapshots
 * ------------------------------------------------------------------ */

function snapshotDir() {
  return join(SNAPSHOT_ROOT, getActiveSiteKey());
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function listSnapshots() {
  const dir = snapshotDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();
}

function readSnapshot(filename) {
  const path = join(snapshotDir(), filename);
  if (!existsSync(path)) {
    const available = listSnapshots();
    throw new Error(
      `No snapshot "${filename}" for site "${getActiveSiteKey()}".` +
      (available.length
        ? `\nAvailable (newest first):\n  ${available.slice(0, 10).join('\n  ')}`
        : `\nNo snapshots taken for this site yet — run cf_snapshot_preset first.`)
    );
  }
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/* ------------------------------------------------------------------ *
 * Diffing
 * ------------------------------------------------------------------ */

/**
 * Recursive structural diff, returning dotted paths.
 * Arrays are compared by index; that is right for CF, whose arrays are ordered
 * token lists rather than sets.
 */
function diffValues(before, after, path = '', out = [], limit = 500) {
  if (out.length >= limit) return out;

  const bothObjects = before && after &&
    typeof before === 'object' && typeof after === 'object' &&
    Array.isArray(before) === Array.isArray(after);

  if (!bothObjects) {
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      out.push({ path: path || '(root)', before, after });
    }
    return out;
  }

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (out.length >= limit) break;
    const next = path ? `${path}.${key}` : key;
    if (!(key in before)) { out.push({ path: next, before: undefined, after: after[key] }); continue; }
    if (!(key in after))  { out.push({ path: next, before: before[key], after: undefined }); continue; }
    diffValues(before[key], after[key], next, out, limit);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Tools
 * ------------------------------------------------------------------ */

const coreFrameworkTools = [
  {
    name: 'cf_get_preset',
    description:
      'Read the Core Framework design system (colour tokens, fluid type scale, spacing, layouts) from the active site. ' +
      'Returns a compact summary by default — the full preset runs ~120 KB, so ask for it deliberately. ' +
      'Use section to pull one module in full, or full=true for everything. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          description: 'Return one module in full instead of the summary.',
          enum: ['typography', 'colors', 'colours', 'spacing', 'components', 'fonts', 'stylesheets'],
        },
        full: {
          type: 'boolean',
          description: 'Return the entire preset JSON (~120 KB). Prefer a section or the summary.',
          default: false,
        },
      },
    },
    handler: async (args = {}) => {
      try {
        const { section, full = false } = args;
        const { data: preset, bytes } = await cfGet('/preset');

        if (full) {
          return { content: [{ type: 'text', text: JSON.stringify(preset, null, 2) }] };
        }

        if (section) {
          const moduleKey = MODULE_SECTIONS[section];
          const moduleData = preset?.modulesData?.[moduleKey];
          if (moduleData === undefined) {
            return { content: [{ type: 'text', text: `Core Framework has no "${moduleKey}" module on this site. Present: ${Object.keys(preset.modulesData || {}).join(', ')}` }] };
          }
          return { content: [{ type: 'text', text: `${moduleKey}:\n\n${JSON.stringify(moduleData, null, 2)}` }] };
        }

        const summary = summarise(preset, bytes);
        const site = getActiveSite();
        const pinned = summary.typography.flatMap(g => g.pinnedSteps);
        const notes = pinned.length
          ? `\n\nNote: ${pinned.length} type step(s) pinned rather than fluid (max below min): ${pinned.join(', ')}. ` +
            `Expected on Floodway — see floodway-assistant#192.`
          : '';

        return {
          content: [{
            type: 'text',
            text: `Core Framework preset on ${site.label} [${site.key}]${notes}\n\n${JSON.stringify(summary, null, 2)}`,
          }],
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `Error reading Core Framework preset: ${error.message}` }], isError: true };
      }
    },
  },

  {
    name: 'cf_snapshot_preset',
    description:
      'Write the current Core Framework preset to disk as a timestamped snapshot, so token changes have a rollback record and can be diffed later. ' +
      'Snapshots live under ~/.bricks-mcp/cf-snapshots/<site>/ and are per-site. Read-only against the site.',
    inputSchema: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          description: 'Short slug appended to the filename, e.g. "before-colour-retune".',
        },
      },
    },
    handler: async (args = {}) => {
      try {
        const { label } = args;
        const { data: preset, bytes } = await cfGet('/preset');

        const dir = snapshotDir();
        mkdirSync(dir, { recursive: true });

        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const slug = label ? '-' + String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : '';
        const filename = `${stamp}${slug}.json`;
        const path = join(dir, filename);

        const serialised = JSON.stringify(preset, null, 2);
        writeFileSync(path, serialised, 'utf-8');

        const site = getActiveSite();
        const summary = summarise(preset, bytes);

        return {
          content: [{
            type: 'text',
            text:
              `Snapshot written for ${site.label} [${site.key}]\n\n` +
              `  file:    ${path}\n` +
              `  size:    ${serialised.length.toLocaleString()} bytes\n` +
              `  sha256:  ${sha256(serialised).slice(0, 16)}\n` +
              `  preset:  ${preset.name} (${preset.id})\n` +
              `  colours: ${summary.colours.length}\n` +
              `  updated: ${summary.preset.updatedAt}\n\n` +
              `Diff a later state against it with cf_diff_preset { against: "${filename}" }.`,
          }],
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `Error snapshotting Core Framework preset: ${error.message}` }], isError: true };
      }
    },
  },

  {
    name: 'cf_diff_preset',
    description:
      'Diff the live Core Framework preset against a saved snapshot, or two snapshots against each other. ' +
      'Reports changed token paths with before/after values. Call with no arguments to list available snapshots.',
    inputSchema: {
      type: 'object',
      properties: {
        against: {
          type: 'string',
          description: 'Snapshot filename to compare against. Omit to list what is available.',
        },
        from: {
          type: 'string',
          description: 'Optional second snapshot filename. When set, compares from → against instead of live → against.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of changed paths to report (default 100).',
          default: 100,
        },
      },
    },
    handler: async (args = {}) => {
      try {
        const { against, from, limit = 100 } = args;
        const siteKey = getActiveSiteKey();

        if (!against) {
          const available = listSnapshots();
          if (!available.length) {
            return { content: [{ type: 'text', text: `No Core Framework snapshots for site "${siteKey}" yet. Take one with cf_snapshot_preset.` }] };
          }
          return {
            content: [{
              type: 'text',
              text: `Snapshots for "${siteKey}" (newest first):\n\n  ${available.join('\n  ')}\n\nDiff with cf_diff_preset { against: "<filename>" }.`,
            }],
          };
        }

        const baseline = readSnapshot(against);
        let current, currentLabel;
        if (from) {
          current = readSnapshot(from);
          currentLabel = from;
        } else {
          current = (await cfGet('/preset')).data;
          currentLabel = 'live';
        }

        const changes = diffValues(baseline, current, '', [], Math.max(1, limit));

        if (!changes.length) {
          return { content: [{ type: 'text', text: `No differences: ${currentLabel} matches ${against} exactly.` }] };
        }

        const truncated = changes.length >= limit;
        const rendered = changes.slice(0, limit).map(c => {
          const before = JSON.stringify(c.before);
          const after = JSON.stringify(c.after);
          const clip = (s) => (s === undefined ? '(absent)' : s.length > 120 ? s.slice(0, 117) + '...' : s);
          return `  ${c.path}\n      ${clip(before)}  →  ${clip(after)}`;
        }).join('\n');

        return {
          content: [{
            type: 'text',
            text:
              `${changes.length}${truncated ? '+' : ''} change(s), ${against} → ${currentLabel}\n\n${rendered}` +
              (truncated ? `\n\n(Truncated at ${limit}. Raise limit to see more.)` : ''),
          }],
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `Error diffing Core Framework preset: ${error.message}` }], isError: true };
      }
    },
  },
];

export { coreFrameworkTools };
