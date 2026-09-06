import { Ticket, type TicketCreationChannel } from "../models/Ticket";

// reports-management Story 40: first report in the feature, establishes the
// aggregation pattern Stories 41-44 each build their own version of (no
// shared generic "report builder" abstraction — each report's shape differs
// enough, per-report is simpler than one leaky generic).

export type ReportGrouping = "day" | "week" | "month";

export interface TicketReportFilters {
  from: Date; // inclusive
  to: Date; // exclusive
  categories?: string[]; // Ticket.category values (plain strings, not ids); empty/undefined = all
  grouping: ReportGrouping;
}

export interface TicketVolumePoint {
  bucket: string; // YYYY-MM-DD (day/week start) or YYYY-MM (month), UTC
  count: number;
}

export interface TicketCategoryBreakdownRow {
  category: string | null; // null = uncategorized
  count: number;
}

export interface TicketSourceBreakdownRow {
  createdVia: TicketCreationChannel | null; // null = legacy pre-Story-63 rows
  count: number;
}

export interface TicketReport {
  totals: { count: number };
  trend: TicketVolumePoint[];
  byCategory: TicketCategoryBreakdownRow[];
  bySource: TicketSourceBreakdownRow[];
}

interface FacetRow {
  _id: unknown;
  count: number;
}

function bucketKey(date: Date, grouping: ReportGrouping): string {
  const iso = date.toISOString();
  return grouping === "month" ? iso.slice(0, 7) : iso.slice(0, 10);
}

// Mongo's $group only emits buckets that have at least one document — a
// day/week/month with zero tickets is silently absent, which would make the
// trend chart's x-axis skip gaps instead of showing a real zero. Walk the
// whole requested range up front and merge the aggregation's rows into it.
function zeroFilledBuckets(from: Date, to: Date, grouping: ReportGrouping, rows: FacetRow[]): TicketVolumePoint[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row._id instanceof Date) counts.set(bucketKey(row._id, grouping), row.count);
  }

  const points: TicketVolumePoint[] = [];
  const cursor = new Date(from.getTime());
  while (cursor < to) {
    const key = bucketKey(cursor, grouping);
    if (!points.some((p) => p.bucket === key)) {
      points.push({ bucket: key, count: counts.get(key) ?? 0 });
    }
    if (grouping === "month") cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    else if (grouping === "week") cursor.setUTCDate(cursor.getUTCDate() + 7);
    else cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return points;
}

export async function buildTicketReport(filters: TicketReportFilters): Promise<TicketReport> {
  const match: Record<string, unknown> = { createdAt: { $gte: filters.from, $lt: filters.to } };
  if (filters.categories && filters.categories.length > 0) {
    match.category = { $in: filters.categories };
  }

  const [result] = await Ticket.aggregate([
    { $match: match },
    {
      $facet: {
        totals: [{ $count: "count" }],
        trend: [
          {
            $group: {
              _id: {
                $dateTrunc: {
                  date: "$createdAt",
                  unit: filters.grouping,
                  timezone: "UTC",
                  ...(filters.grouping === "week" ? { startOfWeek: "monday" } : {}),
                },
              },
              count: { $sum: 1 },
            },
          },
        ],
        byCategory: [
          { $group: { _id: "$category", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ],
        bySource: [
          { $group: { _id: "$createdVia", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ],
      },
    },
  ]);

  const trendRows: FacetRow[] = result?.trend ?? [];
  const byCategoryRows: FacetRow[] = result?.byCategory ?? [];
  const bySourceRows: FacetRow[] = result?.bySource ?? [];

  return {
    totals: { count: result?.totals?.[0]?.count ?? 0 },
    trend: zeroFilledBuckets(filters.from, filters.to, filters.grouping, trendRows),
    byCategory: byCategoryRows.map((r) => ({ category: (r._id as string | null) ?? null, count: r.count })),
    bySource: bySourceRows.map((r) => ({ createdVia: (r._id as TicketCreationChannel | null) ?? null, count: r.count })),
  };
}

// ---------- CSV ----------

function csvEscape(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// TODO(reports-pdf): PDF export was in Story 40's acceptance criteria but is
// deferred to a follow-up story — no PDF-generation dependency exists in
// this project yet. CSV alone ships for now.
export function buildTicketReportCsv(report: TicketReport): string {
  const lines: string[] = [];
  lines.push("Volume");
  lines.push("period,count");
  for (const point of report.trend) lines.push(`${csvEscape(point.bucket)},${point.count}`);
  lines.push("");
  lines.push("ByCategory");
  lines.push("category,count");
  for (const row of report.byCategory) lines.push(`${csvEscape(row.category ?? "Uncategorized")},${row.count}`);
  lines.push("");
  lines.push("BySource");
  lines.push("source,count");
  for (const row of report.bySource) lines.push(`${csvEscape(row.createdVia ?? "unknown")},${row.count}`);
  // Leading BOM so Excel opens UTF-8 (Arabic category names) correctly
  // instead of mis-detecting the encoding.
  return `﻿${lines.join("\n")}`;
}
