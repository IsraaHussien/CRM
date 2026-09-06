import { Types } from "mongoose";
import { Ticket, type TicketPriority } from "../models/Ticket";
import { Conversation } from "../models/Conversation";
import { User } from "../models/User";

// reports-management Story 41. Unlike Story 40 (ticket-reports), this report
// spans BOTH tickets and conversations — SLA targets are tracked on both
// channels (sla-automation Stories 25-27), so compliance reporting can't be
// scoped to tickets alone the way volume/type reporting was.
//
// Known asymmetry (sla-automation Story 28 only instrumented Ticket, not
// Conversation, with a slaHistory event log): the ticket breach trend below
// counts real breach EVENTS (when they happened); the conversation breach
// trend is a same-day SNAPSHOT (conversations created on a day that are
// *currently* flagged breached). Both are surfaced with that distinction
// intact rather than silently presented as the same kind of number.

export type SlaReportScope = "all" | "tickets" | "conversations";

export interface SlaReportFilters {
  from: Date; // inclusive
  to: Date; // exclusive
  scope: SlaReportScope;
}

export interface SlaBreakdownRow {
  key: string; // agentId ("__unassigned__" for null), category, or priority
  label: string;
  total: number;
  breached: number;
}

export interface SlaTrendPoint {
  bucket: string; // YYYY-MM-DD, UTC
  breaches: number;
}

export interface SlaEntityReport {
  total: number;
  breached: number;
  complianceRate: number | null; // null when total === 0
  byAgent: SlaBreakdownRow[];
  byCategory?: SlaBreakdownRow[]; // tickets only
  byPriority?: SlaBreakdownRow[]; // tickets only
  trend: SlaTrendPoint[];
}

export interface SlaReport {
  tickets: SlaEntityReport | null;
  conversations: SlaEntityReport | null;
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function zeroFilledTrend(from: Date, to: Date, counts: Map<string, number>): SlaTrendPoint[] {
  const points: SlaTrendPoint[] = [];
  const cursor = new Date(from.getTime());
  while (cursor < to) {
    const key = dayKey(cursor);
    points.push({ bucket: key, breaches: counts.get(key) ?? 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return points;
}

async function resolveAgentNames(agentIds: string[]): Promise<Map<string, string>> {
  const objectIds = agentIds.filter((id) => Types.ObjectId.isValid(id));
  const users = await User.find({ _id: { $in: objectIds } }).select("name");
  const map = new Map<string, string>();
  for (const u of users) map.set(String(u._id), u.name);
  return map;
}

async function buildTicketEntityReport(filters: SlaReportFilters): Promise<SlaEntityReport> {
  const match = { createdAt: { $gte: filters.from, $lt: filters.to } };

  const [result] = await Ticket.aggregate([
    { $match: match },
    {
      $facet: {
        totals: [{ $count: "count" }],
        breached: [{ $match: { "sla.breached": true } }, { $count: "count" }],
        byAgent: [
          { $group: { _id: "$assignedAgent", total: { $sum: 1 }, breached: { $sum: { $cond: ["$sla.breached", 1, 0] } } } },
        ],
        byCategory: [
          { $group: { _id: "$category", total: { $sum: 1 }, breached: { $sum: { $cond: ["$sla.breached", 1, 0] } } } },
        ],
        byPriority: [
          { $group: { _id: "$priority", total: { $sum: 1 }, breached: { $sum: { $cond: ["$sla.breached", 1, 0] } } } },
        ],
      },
    },
  ]);

  const total: number = result?.totals?.[0]?.count ?? 0;
  const breached: number = result?.breached?.[0]?.count ?? 0;

  const byAgentRows: Array<{ _id: string | null; total: number; breached: number }> = result?.byAgent ?? [];
  const agentIds = byAgentRows.map((r) => r._id).filter((id): id is string => Boolean(id));
  const agentNames = await resolveAgentNames(agentIds.map(String));

  const byAgent: SlaBreakdownRow[] = byAgentRows.map((r) => ({
    key: r._id ? String(r._id) : "__unassigned__",
    label: r._id ? (agentNames.get(String(r._id)) ?? "Deleted user") : "Unassigned",
    total: r.total,
    breached: r.breached,
  }));

  const byCategoryRows: Array<{ _id: string | null; total: number; breached: number }> = result?.byCategory ?? [];
  const byCategory: SlaBreakdownRow[] = byCategoryRows.map((r) => ({
    key: r._id ?? "__uncategorized__",
    label: r._id ?? "Uncategorized",
    total: r.total,
    breached: r.breached,
  }));

  const byPriorityRows: Array<{ _id: TicketPriority; total: number; breached: number }> = result?.byPriority ?? [];
  const byPriority: SlaBreakdownRow[] = byPriorityRows.map((r) => ({
    key: r._id,
    label: r._id,
    total: r.total,
    breached: r.breached,
  }));

  // Trend: real breach EVENTS from slaHistory, keyed by when the breach
  // actually happened — independent of whether the ticket was CREATED
  // inside the window (a ticket created before the window can still
  // contribute a breach event that falls inside it).
  const trendRows = await Ticket.aggregate([
    { $unwind: "$slaHistory" },
    { $match: { "slaHistory.event": "breached", "slaHistory.at": { $gte: filters.from, $lt: filters.to } } },
    { $group: { _id: { $dateTrunc: { date: "$slaHistory.at", unit: "day", timezone: "UTC" } }, count: { $sum: 1 } } },
  ]);
  const trendCounts = new Map<string, number>();
  for (const row of trendRows as Array<{ _id: Date; count: number }>) {
    trendCounts.set(dayKey(row._id), row.count);
  }

  return {
    total,
    breached,
    complianceRate: total > 0 ? 1 - breached / total : null,
    byAgent,
    byCategory,
    byPriority,
    trend: zeroFilledTrend(filters.from, filters.to, trendCounts),
  };
}

async function buildConversationEntityReport(filters: SlaReportFilters): Promise<SlaEntityReport> {
  const match = { createdAt: { $gte: filters.from, $lt: filters.to } };

  const [result] = await Conversation.aggregate([
    { $match: match },
    {
      $facet: {
        totals: [{ $count: "count" }],
        breached: [{ $match: { "sla.breached": true } }, { $count: "count" }],
        byAgent: [
          { $group: { _id: "$assignedAgent", total: { $sum: 1 }, breached: { $sum: { $cond: ["$sla.breached", 1, 0] } } } },
        ],
        // Snapshot trend: conversations CREATED on a given day that are
        // currently flagged breached — Conversation has no slaHistory event
        // log yet (sla-automation's known gap), so this is the closest
        // available proxy, and is labelled as such in the API response.
        breachedByDay: [
          { $match: { "sla.breached": true } },
          { $group: { _id: { $dateTrunc: { date: "$createdAt", unit: "day", timezone: "UTC" } }, count: { $sum: 1 } } },
        ],
      },
    },
  ]);

  const total: number = result?.totals?.[0]?.count ?? 0;
  const breached: number = result?.breached?.[0]?.count ?? 0;

  const byAgentRows: Array<{ _id: string | null; total: number; breached: number }> = result?.byAgent ?? [];
  const agentIds = byAgentRows.map((r) => r._id).filter((id): id is string => Boolean(id));
  const agentNames = await resolveAgentNames(agentIds.map(String));

  const byAgent: SlaBreakdownRow[] = byAgentRows.map((r) => ({
    key: r._id ? String(r._id) : "__unassigned__",
    label: r._id ? (agentNames.get(String(r._id)) ?? "Deleted user") : "Unassigned",
    total: r.total,
    breached: r.breached,
  }));

  const trendCounts = new Map<string, number>();
  for (const row of (result?.breachedByDay ?? []) as Array<{ _id: Date; count: number }>) {
    trendCounts.set(dayKey(row._id), row.count);
  }

  return {
    total,
    breached,
    complianceRate: total > 0 ? 1 - breached / total : null,
    byAgent,
    trend: zeroFilledTrend(filters.from, filters.to, trendCounts),
  };
}

export async function buildSlaReport(filters: SlaReportFilters): Promise<SlaReport> {
  const [tickets, conversations] = await Promise.all([
    filters.scope !== "conversations" ? buildTicketEntityReport(filters) : Promise.resolve(null),
    filters.scope !== "tickets" ? buildConversationEntityReport(filters) : Promise.resolve(null),
  ]);
  return { tickets, conversations };
}
