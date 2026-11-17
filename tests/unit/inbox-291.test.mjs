// Unit tests for floodway-inbox#291. Run: node --test tests/unit/
//
// 1. A template read through the tools must be writable back unmodified: a preserve
//    save may not hand site-authored "0px" to a validator that rejects it.
// 2. bricks_patch_page must report from the server's result and fail when the
//    element count is unknown or nothing matched.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { autofix, stripPxValues } from '../../utils/autofix.js';
import { validateContent, findPxValues } from '../../utils/validator.js';
import { summarizePatchResult } from '../../utils/patch-result.js';

// Shaped like what bricks_get_template returned in the issue.
function templateAsRead() {
  return [
    { id: 'aaa111', name: 'section', parent: 0, children: ['bbb222', 'ccc333'], settings: { _margin: { top: '0px' } } },
    { id: 'bbb222', name: 'accordion', parent: 'aaa111', children: [], settings: { titleHeight: '50px' } },
    { id: 'ccc333', name: 'icon', parent: 'aaa111', children: [], settings: { icon: { library: 'themify', icon: 'ti-menu', height: '20px', width: '20px' }, text: 'Gap of 10px' } },
  ];
}

test('#291: a template read back is writable unmodified (preserve save validates)', () => {
  const { content, log } = autofix(templateAsRead(), { mode: 'preserve' });
  const v = validateContent(content);
  assert.equal(v.valid, true, `expected valid, got: ${v.errors.join('; ')}`);
  // Site-authored px on ordinary keys is normalized to what Bricks stores...
  assert.equal(content[0].settings._margin.top, '0');
  assert.equal(content[1].settings.titleHeight, '50');
  // ...and every change is reported by its full path.
  assert.ok(log.some(l => l.includes('"_margin.top"')), log.join('\n'));
  assert.ok(log.some(l => l.includes('"titleHeight"')), log.join('\n'));
});

test('#291: nested values under a px-safe key are kept (icon.height)', () => {
  const { content } = autofix(templateAsRead(), { mode: 'preserve' });
  assert.equal(content[2].settings.icon.height, '20px');
  assert.equal(content[2].settings.icon.width, '20px');
  assert.equal(content[2].settings.text, 'Gap of 10px');
  assert.deepEqual(findPxValues(content[2].settings), []);
});

test('normalize mode still strips generated px', () => {
  const { content } = autofix([
    { id: 'ddd444', name: 'section', parent: 0, children: [], settings: { _padding: { top: '60px' } } },
  ]);
  assert.equal(content[0].settings._padding.top, '60');
});

test('stripPxValues keeps its direct-call signature', () => {
  const log = [];
  assert.equal(stripPxValues('20px', 'height', log, 'x'), '20');
  assert.equal(stripPxValues('20px', 'icon', log, 'x'), '20px');
  assert.deepEqual(stripPxValues({ height: '20px' }, 'icon', log, 'x'), { height: '20px' });
});

test('validator still rejects bare px that reaches it outside a safe key', () => {
  const v = validateContent([
    { id: 'eee555', name: 'section', parent: 0, children: [], settings: { _margin: { top: '0px' } } },
  ]);
  assert.equal(v.valid, false);
  assert.match(v.errors.join('\n'), /_margin\.top: Bare px value/);
});

// ── bricks_patch_page result ──

const base = { pageId: 190680, contentArea: 'content', add: [], remove: [] };

test('#291 repro (current plugin): footer template patched as content fails', () => {
  // What the live plugin returns: echoes the request, element_count 0 on an empty area.
  const r = summarizePatchResult({
    ...base,
    update: [{ id: 'osdswe', settings: { text: 'x' } }],
    result: { success: true, element_count: 0, added: 0, updated: 1, removed: 0 },
  });
  assert.equal(r.ok, false);
  assert.match(r.text, /^Error: nothing was patched/);
  assert.match(r.text, /osdswe/);
  assert.match(r.text, /content_area: "header" or "footer"/);
  assert.doesNotMatch(r.text, /Updated 1/);
});

test('unknown element count is a failure, not "Total elements: unknown"', () => {
  for (const result of [{}, { success: true }, { element_count: null }, undefined]) {
    const r = summarizePatchResult({ ...base, update: [{ id: 'osdswe' }], result });
    assert.equal(r.ok, false);
    assert.match(r.text, /not confirmed/);
    assert.doesNotMatch(r.text, /unknown/);
  }
});

test('fixed plugin: nothing matched is a failure', () => {
  const r = summarizePatchResult({
    ...base,
    update: [{ id: 'osdswe' }],
    remove: ['zzz999'],
    result: { element_count: 12, updated: 0, updated_ids: [], unmatched_update_ids: ['osdswe'], removed: 0, removed_ids: [], unmatched_remove_ids: ['zzz999'] },
  });
  assert.equal(r.ok, false);
  assert.match(r.text, /No requested id exists in content_area "content" \(12 elements there\)/);
});

test('fixed plugin: names only the ids that matched, warns on the rest', () => {
  const r = summarizePatchResult({
    ...base,
    contentArea: 'footer',
    update: [{ id: 'osdswe' }, { id: 'nopeee' }],
    result: { element_count: 81, updated: 1, updated_ids: ['osdswe'], unmatched_update_ids: ['nopeee'], removed: 0, removed_ids: [], unmatched_remove_ids: [] },
  });
  assert.equal(r.ok, true);
  assert.match(r.text, /Updated 1: osdswe/);
  assert.match(r.text, /Not found in content_area "footer", left untouched: nopeee/);
  assert.match(r.text, /Total elements: 81/);
});

test('fixed plugin: removal reports cascaded children', () => {
  const r = summarizePatchResult({
    ...base,
    remove: ['aaa111'],
    result: { element_count: 4, removed: 1, removed_ids: ['aaa111'], removed_total: 3, updated_ids: [], unmatched_update_ids: [], unmatched_remove_ids: [] },
  });
  assert.equal(r.ok, true);
  assert.match(r.text, /Removed 1: aaa111 \(3 elements including children\)/);
});

test('current plugin with a real count: does not claim the ids matched', () => {
  const r = summarizePatchResult({
    ...base,
    update: [{ id: 'osdswe' }],
    result: { success: true, element_count: 40, updated: 1 },
  });
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.text, /Updated 1/);
  assert.match(r.text, /Update requested for 1: osdswe/);
  assert.match(r.text, /does not report which ids matched/);
});

test('add-only patch is fine, including into an area that was empty', () => {
  const r = summarizePatchResult({
    ...base,
    add: [{ id: 'new111' }],
    result: { element_count: 1, added: 1 },
  });
  assert.equal(r.ok, true);
  assert.match(r.text, /Added 1: new111/);
});
