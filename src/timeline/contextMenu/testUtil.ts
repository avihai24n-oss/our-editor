import type { MenuItem } from './types';

/** Menu groups → labels with '-' between groups (empty groups skipped), for order checks. */
export function menuItemsForTest(groups: MenuItem[][]): string[] {
  const out: string[] = [];
  for (const g of groups) {
    if (!g.length) continue;
    if (out.length) out.push('-');
    out.push(...g.map((i) => i.label));
  }
  return out;
}
