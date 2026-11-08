/**
 * Food-grade separation policy (catering WMS requirement).
 *
 * Items and warehouses may be classified 'food' or 'non_food'. A NULL grade on
 * either side means unclassified and is always allowed, so legacy master data
 * keeps working unchanged. Pure functions only — the DB lookups live in the
 * repository and the callers decide when to enforce.
 */
import { ConflictError } from "../../../../domain/shared-kernel/errors.js";
import type { ScmGrade } from "./supply-chain-advanced.entity.js";

export const GRADE_MISMATCH_CODE = "GRADE_MISMATCH";

/** True when the item may be stored in / moved through the warehouse. */
export function isGradeCompatible(itemGrade: ScmGrade | null, warehouseGrade: ScmGrade | null): boolean {
  if (itemGrade === null || warehouseGrade === null) return true;
  return itemGrade === warehouseGrade;
}

export interface GradeContext {
  itemCode: string;
  itemGrade: ScmGrade | null;
  warehouseCode: string;
  warehouseGrade: ScmGrade | null;
}

/** Rejects a movement that would put a food item in a non-food warehouse (or
 * a non-food item in a food warehouse). Maps to HTTP 409 via ConflictError. */
export function assertGradeCompatible(ctx: GradeContext): void {
  if (isGradeCompatible(ctx.itemGrade, ctx.warehouseGrade)) return;
  throw new ConflictError(
    `Grade mismatch: ${ctx.itemGrade} item ${ctx.itemCode} cannot be moved into or out of ` +
      `${ctx.warehouseGrade} warehouse ${ctx.warehouseCode}`,
    GRADE_MISMATCH_CODE,
  );
}

/** Rejects re-grading a warehouse while it holds stock of a conflicting item grade. */
export function assertWarehouseRegradeAllowed(
  warehouseCode: string,
  newGrade: ScmGrade | null,
  heldItemGrades: ScmGrade[],
): void {
  if (newGrade === null) return;
  const conflicting = heldItemGrades.filter((g) => g !== newGrade);
  if (conflicting.length === 0) return;
  throw new ConflictError(
    `Cannot set warehouse ${warehouseCode} to ${newGrade}: it currently holds stock of ${conflicting[0]} items`,
    GRADE_MISMATCH_CODE,
  );
}
