import express, { Request, Response } from "express";
import { requireAuth, requirePermission } from "../middleware/auth";
import { ticketReportQuerySchema, slaReportQuerySchema } from "../validation/report.schema";
import { buildTicketReport, buildTicketReportCsv } from "../services/ticketReport.service";
import { buildSlaReport } from "../services/slaReport.service";

const router = express.Router();

const DEFAULT_RANGE_DAYS = 30;

function resolveRange(from?: string, to?: string): { from: Date; to: Date } {
  const toDate = to ? new Date(to) : new Date();
  // Exclusive upper bound, per every other date-range filter in the app —
  // "to" means "through the end of that day".
  toDate.setUTCHours(24, 0, 0, 0);
  const fromDate = from
    ? new Date(new Date(from).toISOString().slice(0, 10) + "T00:00:00.000Z")
    : new Date(toDate.getTime() - DEFAULT_RANGE_DAYS * 86_400_000);
  return { from: fromDate, to: toDate };
}

// reports-management Story 40: tickets-only volume/type/source report.
// Gated on the existing reports:view / reports:export permission keys
// (backend/src/constants/permissions.ts) — reports:view is already
// agent-grantable by default (DEFAULT_PERMISSIONS_BY_ROLE), so this
// deliberately does NOT also require requireRole("admin"); requirePermission
// alone already rejects customers and un-granted agents/subadmins, same
// pattern as audit.routes.ts.
router.get("/tickets", requireAuth, requirePermission("reports:view"), async (req: Request, res: Response) => {
  const parsed = ticketReportQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid query" });
    return;
  }
  const { from, to } = resolveRange(parsed.data.from, parsed.data.to);
  const report = await buildTicketReport({ from, to, grouping: parsed.data.grouping, categories: parsed.data.category });
  res.status(200).json({ filters: { from: from.toISOString(), to: to.toISOString(), grouping: parsed.data.grouping }, ...report });
});

router.get("/tickets/export.csv", requireAuth, requirePermission("reports:export"), async (req: Request, res: Response) => {
  const parsed = ticketReportQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid query" });
    return;
  }
  const { from, to } = resolveRange(parsed.data.from, parsed.data.to);
  const report = await buildTicketReport({ from, to, grouping: parsed.data.grouping, categories: parsed.data.category });
  const csv = buildTicketReportCsv(report);
  const filename = `tickets-report-${from.toISOString().slice(0, 10)}-to-${to.toISOString().slice(0, 10)}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.status(200).send(csv);
});

// reports-management Story 41: SLA compliance report, spanning both tickets
// and conversations (see slaReport.service.ts's doc comment for why this
// one isn't scoped to tickets alone the way Story 40 is). No export route in
// this story — deferred, see the story plan's explicit scope note.
router.get("/sla", requireAuth, requirePermission("reports:view"), async (req: Request, res: Response) => {
  const parsed = slaReportQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid query" });
    return;
  }
  const { from, to } = resolveRange(parsed.data.from, parsed.data.to);
  const report = await buildSlaReport({ from, to, scope: parsed.data.scope });
  res.status(200).json({ filters: { from: from.toISOString(), to: to.toISOString(), scope: parsed.data.scope }, ...report });
});

export default router;
