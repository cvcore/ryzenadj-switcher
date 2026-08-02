// Drag-reorder semantics shared by the profile rows and the panel content
// chips, so the same gesture means the same thing in both editors.
// No gi:// imports — unit-testable under gjs or node.

/**
 * Move the item keyed `draggedId` next to the item keyed `targetId`.
 *
 * `placement` says which side of the target the item lands on; the callers
 * derive it from the pointer position within the drop widget, so dropping on
 * a target's leading half inserts before it and on its trailing half after it.
 *
 * @param {Array} list source order (never mutated)
 * @param {*} draggedId key of the item being moved
 * @param {*} targetId key of the item being dropped onto
 * @param {'before'|'after'} placement side of the target to insert at
 * @param {(item: *) => *} keyOf key extractor; the default handles both
 *     objects with an `id` (profiles) and plain strings (chip token ids)
 * @returns {Array} a new array; unknown or identical ids leave the order as is
 */
export function moveItem(list, draggedId, targetId, placement = 'before', keyOf = x => x?.id ?? x) {
    const out = [...(list ?? [])];
    if (draggedId === targetId)
        return out;
    const from = out.findIndex(x => keyOf(x) === draggedId);
    const to = out.findIndex(x => keyOf(x) === targetId);
    if (from < 0 || to < 0)
        return out;
    const [moved] = out.splice(from, 1);
    // Locate the target again: removing the dragged item shifts every index
    // after it by one, which is exactly the off-by-one this helper replaces.
    const at = out.findIndex(x => keyOf(x) === targetId);
    out.splice(placement === 'after' ? at + 1 : at, 0, moved);
    return out;
}
