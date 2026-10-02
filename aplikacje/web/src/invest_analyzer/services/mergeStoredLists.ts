/** Nakłada zmiany tej karty od ostatniego odczytu na bieżący stan magazynu. */
export function mergeStoredLists<T>(base: T[], local: T[], current: T[], key: (entry: T) => string): T[] {
  const before = new Map(base.map((entry) => [key(entry), entry]));
  const after = new Map(local.map((entry) => [key(entry), entry]));
  const result = new Map(current.map((entry) => [key(entry), entry]));
  for (const id of before.keys()) if (!after.has(id)) result.delete(id);
  for (const [id, entry] of after) {
    if (!before.has(id) || JSON.stringify(before.get(id)) !== JSON.stringify(entry)) result.set(id, entry);
  }
  return [...result.values()];
}
