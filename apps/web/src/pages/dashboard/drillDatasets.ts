/**
 * Wave 2 — drill-down dataset registry.
 *
 * Maps a `?dataset=` key (from a dashboard card's `drillTarget`) to the API
 * call, table columns, and detail route that resolve the underlying records.
 * One generic `/drilldown` page dispatches here, so a new dataset is a
 * one-line addition rather than a new route.
 */
import type { Column } from "../../shell/components/ui";
import {
  api,
  type ComplaintDashboardListItem,
  type FinanceTransactionRecord,
  type SurveyAssignment,
  type WorkOrderRow,
} from "../../lib/api";

export type DrillDataset = {
  titleKey: string;
  /** Fetch the filtered rows for this dataset. */
  apiCall: (token: string, params: Record<string, string>) => Promise<unknown[]>;
  columns: Column<unknown>[];
  keyOf: (row: unknown) => string;
  /** Route to the single-record detail page. Omit when no safe detail route
   * exists for this audience (e.g. survey assignments — the respondent detail
   * page is gated on `survey.respond`, which an analytics viewer may lack). */
  detailPath?: (row: unknown) => string;
};

const dateCell = (v: string | null) =>
  v ? new Date(v).toLocaleDateString() : "—";

export const DRILL_DATASETS: Record<string, DrillDataset> = {
  complaints: {
    titleKey: "drilldown.title.complaints",
    apiCall: async (token, params) =>
      (
        await api.complaintDashboardList(token, {
          status: (params.status as "open" | "closed") || undefined,
          severity: params.severity || undefined,
          category: params.category || undefined,
        })
      ).items,
    columns: [
      { header: "No.", cell: (r) => (r as ComplaintDashboardListItem).complaintNumber, mobileRole: "title" },
      { header: "Customer", cell: (r) => (r as ComplaintDashboardListItem).customerName ?? "—" },
      { header: "Category", cell: (r) => (r as ComplaintDashboardListItem).category },
      { header: "Severity", cell: (r) => (r as ComplaintDashboardListItem).severity, mobileRole: "status" },
      { header: "Status", cell: (r) => (r as ComplaintDashboardListItem).status, mobileRole: "status" },
      { header: "Created", cell: (r) => dateCell((r as ComplaintDashboardListItem).createdAt) },
    ],
    keyOf: (r) => (r as ComplaintDashboardListItem).id,
    detailPath: (r) => `/complaints/${(r as ComplaintDashboardListItem).id}`,
  },

  "work-orders": {
    titleKey: "drilldown.title.workOrders",
    apiCall: (token, params) => api.workOrders(token, { status: (params.status as "open" | "completed") || undefined }),
    columns: [
      { header: "Order", cell: (r) => (r as WorkOrderRow).workOrder.workOrderNumber, mobileRole: "title" },
      { header: "Title", cell: (r) => (r as WorkOrderRow).workOrder.title },
      { header: "Priority", cell: (r) => (r as WorkOrderRow).workOrder.priority ?? "—" },
      {
        header: "Status",
        cell: (r) => (r as WorkOrderRow).status?.instanceStatus ?? "—",
        mobileRole: "status",
      },
      { header: "Due", cell: (r) => dateCell((r as WorkOrderRow).workOrder.dueAt) },
    ],
    keyOf: (r) => (r as WorkOrderRow).workOrder.id,
    detailPath: (r) => `/work-orders/${(r as WorkOrderRow).workOrder.id}`,
  },

  "finance-transactions": {
    titleKey: "drilldown.title.financeTransactions",
    apiCall: (token, params) =>
      api.financeTransactions(token, {
        direction: params.direction || undefined,
      }),
    columns: [
      { header: "No.", cell: (r) => (r as FinanceTransactionRecord).transactionNumber, mobileRole: "title" },
      { header: "Direction", cell: (r) => (r as FinanceTransactionRecord).direction, mobileRole: "status" },
      { header: "Amount", cell: (r) => (r as FinanceTransactionRecord).amount },
      { header: "Date", cell: (r) => dateCell((r as FinanceTransactionRecord).transactionDate) },
      { header: "Description", cell: (r) => (r as FinanceTransactionRecord).description ?? "—" },
    ],
    keyOf: (r) => (r as FinanceTransactionRecord).id,
    detailPath: (r) => `/finance/transactions/${(r as FinanceTransactionRecord).id}`,
  },

  surveys: {
    titleKey: "drilldown.title.surveys",
    // The API has no status filter here; the dashboard card links with
    // status=submitted, so narrow the list client-side.
    apiCall: async (token, params) => {
      const rows = await api.surveyAssignments(token);
      return params.status ? rows.filter((r) => r.status === params.status) : rows;
    },
    columns: [
      { header: "Status", cell: (r) => (r as SurveyAssignment).status, mobileRole: "status" },
      { header: "Type", cell: (r) => (r as SurveyAssignment).respondentType },
      { header: "Score", cell: (r) => (r as SurveyAssignment).totalScore ?? "—" },
      { header: "Submitted", cell: (r) => dateCell((r as SurveyAssignment).submittedAt) },
    ],
    keyOf: (r) => (r as SurveyAssignment).id,
  },
};
