export interface AllocationItem {
  name: string;
  value: number;
  amountPLN: number;
  count: number;
  color: string;
}

export interface PositionAllocationSource {
  category: string;
  currentValuePLN: number;
}

export function buildAssetAllocationData(
  positions: readonly PositionAllocationSource[],
  totalValuePLN: number,
  categoryMeta: Record<string, { label: string; color: string }>,
): AllocationItem[] {
  const map = new Map<string, AllocationItem>();
  for (const position of positions) {
    const metadata = categoryMeta[position.category] ?? { label: position.category, color: '#94A3B8' };
    const item = map.get(position.category) ?? {
      name: metadata.label,
      value: 0,
      amountPLN: 0,
      count: 0,
      color: metadata.color,
    };
    item.amountPLN += position.currentValuePLN;
    item.count += 1;
    map.set(position.category, item);
  }
  return [...map.values()]
    .map((item) => ({
      ...item,
      value: totalValuePLN > 0 ? Number(((item.amountPLN / totalValuePLN) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.amountPLN - a.amountPLN);
}
