/**
 * Pure helpers for memory_search's compound-question support.
 *
 * Kept in its own module so unit tests can import the merge logic without
 * pulling in the full MCP server (which starts a stdio transport at import
 * time). No I/O here -- just constants and a pure function.
 */

/** Hard ceiling on how many ';'-separated sub-queries one memory_search call
 * can fan out into. Above this we drop the extras and log a warning. */
export const MAX_SUBQUERIES_MEMORY = 5;

/** Round-robin merge with inline dedup by 'id'. Tier `t` takes element t
 * from each per-part list in order, skipping exhausted parts and any item
 * whose id has already been emitted (first-occurrence wins).
 *
 * The interleaving keeps every sub-query represented in the first slots of
 * the returned list, which matters when the caller caps total tokens before
 * passing the merged list to an LLM. */
export function mergeRoundRobin(perPartLists: unknown[][]): unknown[] {
  const merged: unknown[] = [];
  const seen = new Set<string>();
  const maxLen = perPartLists.reduce(
    (m, l) => (l.length > m ? l.length : m),
    0
  );
  for (let tier = 0; tier < maxLen; tier++) {
    for (const lst of perPartLists) {
      if (tier >= lst.length) continue;
      const item = lst[tier] as { id?: unknown };
      const id = typeof item?.id === "string" ? item.id : undefined;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      merged.push(item);
    }
  }
  return merged;
}
