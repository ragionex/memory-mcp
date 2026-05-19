export const MAX_SUBQUERIES_MEMORY = 5;
export function mergeRoundRobin(perPartLists) {
    const merged = [];
    const seen = new Set();
    const maxLen = perPartLists.reduce((m, l) => (l.length > m ? l.length : m), 0);
    for (let tier = 0; tier < maxLen; tier++) {
        for (const lst of perPartLists) {
            if (tier >= lst.length)
                continue;
            const item = lst[tier];
            const id = typeof item?.id === "string" ? item.id : undefined;
            if (id && seen.has(id))
                continue;
            if (id)
                seen.add(id);
            merged.push(item);
        }
    }
    return merged;
}
