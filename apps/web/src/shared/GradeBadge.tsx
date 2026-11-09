import { useT } from "../i18n/LocaleProvider";
import type { ScmGrade } from "../lib/api";
import { Badge } from "../shell/components/ui";

/** Grade marker for items and warehouses; renders "—" when unrestricted. */
export function GradeBadge({ grade }: { grade: ScmGrade | null | undefined }) {
  const t = useT();
  if (!grade) return <span className="text-ink-faint">—</span>;
  return <Badge>{grade === "food" ? t("grade.food") : t("grade.nonFood")}</Badge>;
}

/** Select options for a nullable grade; the empty value maps to null. */
export function GradeOptions() {
  const t = useT();
  return (
    <>
      <option value="">{t("grade.unrestricted")}</option>
      <option value="food">{t("grade.food")}</option>
      <option value="non_food">{t("grade.nonFood")}</option>
    </>
  );
}

export function parseGrade(value: string): ScmGrade | null {
  return value === "food" || value === "non_food" ? value : null;
}
