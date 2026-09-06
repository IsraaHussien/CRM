import express, { Request, Response } from "express";
import { requireAuth, requirePermission } from "../middleware/auth";
import { AuditLog } from "../models/AuditLog";
import { User } from "../models/User";
import { Ticket } from "../models/Ticket";
import { Conversation } from "../models/Conversation";
import { TicketCategory } from "../models/TicketCategory";
import { SlaTarget } from "../models/SlaTarget";
import { Faq } from "../models/Faq";
import { HelpArticle } from "../models/HelpArticle";
import { Feedback } from "../models/Feedback";
import { listAuditLogsQuerySchema } from "../validation/audit.schema";
import { escapeRegex } from "../utils/regex";

const router = express.Router();

interface PopulatedActor {
  _id: unknown;
  name: string;
  email: string;
  role: string;
}

function isPopulatedActor(actor: unknown): actor is PopulatedActor {
  return Boolean(actor) && typeof actor === "object" && "name" in (actor as object);
}

// security-admin Story 47: read-only, filterable audit log — the ONLY route
// this resource exposes (no create/update/delete HTTP surface at all; every
// AuditLog document is written internally via services/auditLog.service.ts).
// Gated on requirePermission("audit:view") — admin always passes, a
// sub-admin needs the key granted, an agent can never hold it (see
// constants/permissions.ts's SUBADMIN_ONLY_PERMISSIONS).
router.get("/", requireAuth, requirePermission("audit:view"), async (req: Request, res: Response) => {
  const parsed = listAuditLogsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid query" });
    return;
  }
  const { page, limit, q, action, category, dateFrom, dateTo } = parsed.data;
  const skip = (page - 1) * limit;

  const filter: Record<string, unknown> = {};
  if (action) filter.action = action;
  if (category) filter.category = category;
  if (dateFrom || dateTo) {
    // Plain-date values (YYYY-MM-DD) parse as UTC midnight via `new Date`,
    // same as ticket.routes.ts's identical createdFrom/createdTo pattern —
    // a `dateTo` of a plain date therefore excludes same-day entries after
    // UTC midnight. Inherited quirk, not fixed here to keep every
    // date-range filter in the app behaving consistently.
    filter.createdAt = {
      ...(dateFrom ? { $gte: new Date(dateFrom) } : {}),
      ...(dateTo ? { $lte: new Date(dateTo) } : {}),
    };
  }

  // `q` searches the RESOLVED actor's name/email — AuditLog.actor is an
  // ObjectId ref, not a denormalized name/email snapshot (see the plan's
  // Product rules), so matching users are looked up first and the audit
  // filter narrows to their ids. An empty match set must still return zero
  // rows, not "filter ignored" — `$in: []` does this correctly in Mongo.
  if (q) {
    const regex = new RegExp(escapeRegex(q), "i");
    const matchingUsers = await User.find({ $or: [{ name: regex }, { email: regex }] }).select("_id");
    filter.actor = { $in: matchingUsers.map((u) => u._id) };
  }

  const [entries, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate("actor", "name email role"),
    AuditLog.countDocuments(filter),
  ]);

  // Resolve targetId -> a small display object in one extra query per
  // collection, same reasoning as the populated actor — keeps the response
  // usable for the frontend's "{actor} did X to {target}" lines (and its
  // target link) without a second round trip per row. Which collection a
  // targetId lives in depends on targetType (User vs. Ticket), so each is
  // looked up separately rather than via a single populate() (targetId has
  // no static `ref`, on purpose — see AuditLog.ts's schema comment).
  const idsFor = (targetType: string) =>
    entries.filter((e) => e.targetType === targetType && e.targetId).map((e) => e.targetId);

  const [targetUsers, targetTickets, targetConversations, targetCategories, targetSlaTargets, targetFaqs, targetArticles, targetFeedback] =
    await Promise.all([
      User.find({ _id: { $in: idsFor("User") } }).select("name email role"),
      Ticket.find({ _id: { $in: idsFor("Ticket") } }).select("subject ticketNumber"),
      Conversation.find({ _id: { $in: idsFor("Conversation") } }).select("createdAt"),
      TicketCategory.find({ _id: { $in: idsFor("TicketCategory") } }).select("name"),
      SlaTarget.find({ _id: { $in: idsFor("SlaTarget") } }).select("priority category"),
      Faq.find({ _id: { $in: idsFor("Faq") } }).select("question"),
      HelpArticle.find({ _id: { $in: idsFor("HelpArticle") } }).select("title slug"),
      Feedback.find({ _id: { $in: idsFor("Feedback") } }).select("parentType parentId rating"),
    ]);

  const userTargetMap = new Map(
    targetUsers.map((u) => [String(u._id), { id: u.id, name: u.name, email: u.email, role: u.role }])
  );
  const ticketTargetMap = new Map(
    targetTickets.map((t) => [String(t._id), { id: t.id, reference: `TCK-${t.ticketNumber}`, subject: t.subject }])
  );
  const conversationTargetMap = new Map(
    targetConversations.map((c) => [String(c._id), { id: c.id, reference: `Chat — ${new Date(c.createdAt).toLocaleDateString()}` }])
  );
  const categoryTargetMap = new Map(targetCategories.map((c) => [String(c._id), { id: c.id, name: c.name }]));
  const slaTargetMap = new Map(
    targetSlaTargets.map((s) => [String(s._id), { id: s.id, name: `${s.priority ?? "Any priority"} / ${s.category ?? "Any category"}` }])
  );
  const faqTargetMap = new Map(targetFaqs.map((f) => [String(f._id), { id: f.id, name: f.question?.en ?? f.question?.ar ?? "FAQ" }]));
  const articleTargetMap = new Map(
    targetArticles.map((a) => [String(a._id), { id: a.id, name: a.title?.en ?? a.title?.ar ?? a.slug }])
  );
  const feedbackTargetMap = new Map(
    targetFeedback.map((f) => [String(f._id), { id: f.id, name: `${f.parentType} feedback (${f.rating}★)` }])
  );

  const TARGET_MAPS: Record<string, Map<string, unknown>> = {
    User: userTargetMap,
    Ticket: ticketTargetMap,
    Conversation: conversationTargetMap,
    TicketCategory: categoryTargetMap,
    SlaTarget: slaTargetMap,
    Faq: faqTargetMap,
    HelpArticle: articleTargetMap,
    Feedback: feedbackTargetMap,
  };

  function resolveTarget(entry: (typeof entries)[number]) {
    if (!entry.targetId) return null;
    // SlaSystemSettings is a fixed singleton ("default") with nothing to
    // look up in a collection — synthesize its display object directly.
    if (entry.targetType === "SlaSystemSettings") return { id: "default", name: "SLA settings" };
    return TARGET_MAPS[entry.targetType]?.get(String(entry.targetId)) ?? null;
  }

  res.status(200).json({
    entries: entries.map((e) => ({
      id: e.id,
      actor: isPopulatedActor(e.actor) ? { id: String(e.actor._id), name: e.actor.name, email: e.actor.email, role: e.actor.role } : null,
      action: e.action,
      category: e.category,
      targetType: e.targetType,
      targetId: e.targetId ? String(e.targetId) : null,
      target: resolveTarget(e),
      metadata: e.metadata,
      ipAddress: e.ipAddress,
      createdAt: e.createdAt,
    })),
    total,
    page,
    limit,
  });
});

export default router;
