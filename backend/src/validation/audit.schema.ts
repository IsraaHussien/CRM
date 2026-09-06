import { z } from "zod";
import { AUDIT_ACTIONS, AUDIT_CATEGORIES } from "../models/AuditLog";
import { paginationQuerySchema, flexibleDateSchema } from "./common";

const SEARCH_QUERY_MAX_LENGTH = 200;

// Mirrors admin.schema.ts's listStaffAccountsQuerySchema — pagination +
// q (free-text actor name/email search) + a createdAt date range, same
// shape as ticket.schema.ts's createdFrom/createdTo (see ticket.routes.ts's
// GET / handler). Two independent filters narrow by action-granularity:
// `category` (matches the chosen UI's "filter by action-category" framing,
// a short Select) and `action` (the concrete action strings, more precise,
// exposed for API completeness/tests even though the frontend filter bar
// only surfaces `category`).
export const listAuditLogsQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().min(1).max(SEARCH_QUERY_MAX_LENGTH).optional(),
  action: z.enum(AUDIT_ACTIONS as [string, ...string[]]).optional(),
  category: z.enum(AUDIT_CATEGORIES as [string, ...string[]]).optional(),
  dateFrom: flexibleDateSchema().optional(),
  dateTo: flexibleDateSchema().optional(),
});
