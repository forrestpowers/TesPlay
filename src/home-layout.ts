/** The account's home screen arrangement, saved with its preferences. */
export type HomeLayout = { order: string[]; hidden: string[] };

/**
 * Orders the sections present now by the saved arrangement. Sections the saved
 * arrangement does not know yet (a new subscription row, a new connection) keep
 * their default place: right after the default section that precedes them.
 */
export function arrangeHomeSections(defaultIds: string[], layout?: HomeLayout | null): string[] {
  const present = new Set(defaultIds);
  const result = (layout?.order || []).filter((id, index, list) => present.has(id) && list.indexOf(id) === index);
  defaultIds.forEach((id, index) => {
    if (result.includes(id)) return;
    let position = 0;
    for (let previous = index - 1; previous >= 0; previous--) {
      const at = result.indexOf(defaultIds[previous]);
      if (at >= 0) { position = at + 1; break; }
    }
    result.splice(position, 0, id);
  });
  return result;
}

/** Moves one section up (-1) or down (+1) in the arranged order. */
export function moveHomeSection(order: string[], id: string, step: -1 | 1): string[] {
  const from = order.indexOf(id), to = from + step;
  if (from < 0 || to < 0 || to >= order.length) return order;
  const next = [...order];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/** Shows or hides one section. */
export function toggleHomeSection(hidden: string[], id: string): string[] {
  return hidden.includes(id) ? hidden.filter((value) => value !== id) : [...hidden, id];
}

/**
 * The order to save: the sections shown now in their new order, with sections
 * absent at the moment (an empty Continue watching row) kept where they were,
 * after the saved section that preceded them.
 */
export function persistHomeOrder(saved: string[] = [], arranged: string[]): string[] {
  const result = [...arranged];
  saved.forEach((id, index) => {
    if (result.includes(id)) return;
    let position = 0;
    for (let previous = index - 1; previous >= 0; previous--) {
      const at = result.indexOf(saved[previous]);
      if (at >= 0) { position = at + 1; break; }
    }
    result.splice(position, 0, id);
  });
  return result;
}
