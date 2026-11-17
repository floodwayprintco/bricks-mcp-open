/**
 * Turn the plugin's PATCH /pages/{id} response into the bricks_patch_page report.
 *
 * The report used to be built from the REQUEST: "Updated 1: osdswe" was printed for
 * every id the caller sent, whether or not it existed. A patch aimed at the wrong
 * content_area (a footer template patched as 'content') matched nothing, wrote
 * nothing, and still said it updated a named element. The only tell was
 * "Total elements: unknown" (floodway-inbox#291).
 *
 * Now the report comes from the server's result, and the patch is reported as a
 * failure when:
 *   - the server gives no element count, so nothing can be shown to have landed, or
 *   - nothing requested matched. With a plugin that reports matched ids
 *     (updated_ids / removed_ids), that's exact. With an older plugin that only
 *     echoes the request, an area holding 0 elements after an update-only patch is
 *     the evidence: none of the ids can have existed there.
 *
 * Pure, so it's testable without a site.
 *
 * @param {Object} p
 * @param {number|string} p.pageId
 * @param {string} p.contentArea
 * @param {Array<Object>} p.add       - Elements sent in add[] (after autofix).
 * @param {Array<Object>} p.update    - Elements sent in update[].
 * @param {Array<string>} p.remove    - Ids sent in remove[].
 * @param {Object} p.result           - Parsed server response.
 * @param {string[]} [p.addFixLog]
 * @returns {{ ok: boolean, text: string }}
 */
function summarizePatchResult({ pageId, contentArea, add = [], update = [], remove = [], result, addFixLog = [] }) {
  const area = contentArea || 'content';
  const res = result && typeof result === 'object' ? result : {};
  const requestedUpdateIds = update.map(e => e && e.id).filter(Boolean);
  const requestedIds = [...requestedUpdateIds, ...remove];
  const areaHint = area === 'content'
    ? ' If this is a header or footer template, pass content_area: "header" or "footer".'
    : '';

  const count = res.element_count;
  if (typeof count !== 'number' || !Number.isFinite(count)) {
    return {
      ok: false,
      text: `Error: patch of page ${pageId} not confirmed. The server reported no element count for content_area "${area}", so nothing can be shown to have been written.${areaHint}\nRequested: ${describeRequest(add, requestedUpdateIds, remove)}\nRe-read the page before assuming anything changed.`,
    };
  }

  const reportsMatches = Array.isArray(res.updated_ids) || Array.isArray(res.removed_ids);
  let updatedIds;
  let unmatchedUpdate;
  let removedIds;
  let unmatchedRemove;

  if (reportsMatches) {
    updatedIds = Array.isArray(res.updated_ids) ? res.updated_ids : [];
    unmatchedUpdate = Array.isArray(res.unmatched_update_ids)
      ? res.unmatched_update_ids
      : requestedUpdateIds.filter(id => !updatedIds.includes(id));
    removedIds = Array.isArray(res.removed_ids) ? res.removed_ids : [];
    unmatchedRemove = Array.isArray(res.unmatched_remove_ids)
      ? res.unmatched_remove_ids
      : remove.filter(id => !removedIds.includes(id));
  } else {
    // Older plugin: it echoes the request, so per-id matches are unknown.
    if (add.length === 0 && requestedUpdateIds.length > 0 && count === 0) {
      return {
        ok: false,
        text: `Error: nothing was patched on page ${pageId}. content_area "${area}" holds 0 elements, so none of the requested ids exist there: ${requestedIds.join(', ')}.${areaHint}`,
      };
    }
    updatedIds = null;
    removedIds = null;
    unmatchedUpdate = [];
    unmatchedRemove = [];
  }

  if (reportsMatches && add.length === 0 && requestedIds.length > 0 && updatedIds.length === 0 && removedIds.length === 0) {
    return {
      ok: false,
      text: `Error: nothing was patched on page ${pageId}. No requested id exists in content_area "${area}" (${count} elements there): ${requestedIds.join(', ')}.${areaHint}`,
    };
  }

  const lines = [`Page ${pageId} patched (content_area: ${area}).`];
  if (add.length > 0) lines.push(`Added ${add.length}: ${add.map(e => e.id).join(', ')}`);

  if (updatedIds) {
    if (updatedIds.length > 0) lines.push(`Updated ${updatedIds.length}: ${updatedIds.join(', ')}`);
    if (removedIds.length > 0) {
      const cascade = typeof res.removed_total === 'number' && res.removed_total > removedIds.length
        ? ` (${res.removed_total} elements including children)`
        : '';
      lines.push(`Removed ${removedIds.length}: ${removedIds.join(', ')}${cascade}`);
    }
    const missing = [...unmatchedUpdate, ...unmatchedRemove];
    if (missing.length > 0) {
      lines.push(`⚠️ Not found in content_area "${area}", left untouched: ${missing.join(', ')}.${areaHint}`);
    }
  } else {
    // Can't tell which ids matched; say so instead of claiming them.
    if (requestedUpdateIds.length > 0) lines.push(`Update requested for ${requestedUpdateIds.length}: ${requestedUpdateIds.join(', ')}`);
    if (remove.length > 0) lines.push(`Removal requested for ${remove.length}: ${remove.join(', ')}`);
    if (requestedIds.length > 0) {
      lines.push('⚠️ This bricks-api-bridge version does not report which ids matched. Read the element back to confirm the change landed.');
    }
  }

  lines.push(`Total elements: ${count}`);
  if (addFixLog.length > 0) lines.push(`Auto-fixed ${addFixLog.length} issue(s) in added elements.`);

  return { ok: true, text: lines.join('\n') };
}

function describeRequest(add, updateIds, remove) {
  const parts = [];
  if (add.length > 0) parts.push(`add ${add.map(e => e && e.id).join(', ')}`);
  if (updateIds.length > 0) parts.push(`update ${updateIds.join(', ')}`);
  if (remove.length > 0) parts.push(`remove ${remove.join(', ')}`);
  return parts.join('; ') || '(nothing)';
}

export { summarizePatchResult };
