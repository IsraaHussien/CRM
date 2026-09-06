import { z } from "zod";
import { flexibleDateSchema } from "./common";

// reports-management Story 40/41: both report endpoints share the same
// from/to date-range shape (see common.ts's flexibleDateSchema — accepts a
// plain "YYYY-MM-DD" or a full ISO datetime, same as every other date-range
// filter in the app). `from`/`to` are optional here — the route handler
// applies the "last 30 days" default before calling the report service, so
// the default lives in one place rather than duplicated per-field.
const dateRangeShape = {
  from: flexibleDateSchema().optional(),
  to: flexibleDateSchema().optional(),
};

// Ticket reports (Story 40) — tickets only (see USER_STORIES.md Story 40:
// live chat is a route into ticket creation, not a second channel this
// report tracks). Category filter accepts one or many category NAMES —
// `Ticket.category` is a plain string snapshot, not an ObjectId reference
// (see backend/src/models/TicketCategory.ts's doc comment), so no id
// resolution is needed here.
export const ticketReportQuerySchema = z
  .object({
    ...dateRangeShape,
    grouping: z.enum(["day", "week", "month"]).optional().default("day"),
    category: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
  })
  .refine((v) => !v.from || !v.to || new Date(v.from) <= new Date(v.to), {
    message: "from must be before to",
  })
  .refine(
    (v) => !v.from || !v.to || (+new Date(v.to) - +new Date(v.from)) / 86_400_000 <= 365,
    { message: "date range cannot exceed 365 days" }
  );

export type TicketReportQuery = z.infer<typeof ticketReportQuerySchema>;

// SLA performance report (Story 41) — spans both tickets and conversations
// (SLA targets apply to both channels per sla-automation, unlike Story 40's
// tickets-only scope).
export const slaReportQuerySchema = z
  .object({
    ...dateRangeShape,
    scope: z.enum(["all", "tickets", "conversations"]).optional().default("all"),
  })
  .refine((v) => !v.from || !v.to || new Date(v.from) <= new Date(v.to), {
    message: "from must be before to",
  })
  .refine(
    (v) => !v.from || !v.to || (+new Date(v.to) - +new Date(v.from)) / 86_400_000 <= 366,
    { message: "date range cannot exceed 366 days" }
  );

export type SlaReportQuery = z.infer<typeof slaReportQuerySchema>;
