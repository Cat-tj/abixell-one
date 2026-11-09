import type { WorkOrderRow } from "../../lib/api";

/** Work the field team no longer has to act on. */
export function isFinished(row: WorkOrderRow): boolean {
  return Boolean(row.workOrder.completedAt);
}

const time = (v: string | null | undefined, fallback: number) => (v ? new Date(v).getTime() : fallback);

/**
 * Open work first, most urgent due date on top (no due date last); finished
 * work after it, most recently completed first. A year of history must not
 * bury today's jobs under last November's closed ones.
 */
export function sortWorkOrders(rows: WorkOrderRow[]): WorkOrderRow[] {
  return [...rows].sort((a, b) => {
    const fa = isFinished(a);
    const fb = isFinished(b);
    if (fa !== fb) return fa ? 1 : -1;
    if (!fa) {
      const da = time(a.workOrder.dueAt ?? a.workOrder.plannedStartAt, Number.MAX_SAFE_INTEGER);
      const db = time(b.workOrder.dueAt ?? b.workOrder.plannedStartAt, Number.MAX_SAFE_INTEGER);
      return da - db;
    }
    return time(b.workOrder.completedAt, 0) - time(a.workOrder.completedAt, 0);
  });
}
