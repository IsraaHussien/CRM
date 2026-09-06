import express, { Request, Response } from "express";
import crypto from "crypto";
import { Types } from "mongoose";
import { requireAuth, requireRole } from "../middleware/auth";
import { User } from "../models/User";
import { Ticket } from "../models/Ticket";
import { Conversation } from "../models/Conversation";
import { Notification } from "../models/Notification";
import { sendEmail, renderEmailHtml } from "../services/email.service";
import { isActiveAccount } from "../services/permissions";
import { recordAuditLog } from "../services/auditLog.service";
import { computeSlaStatus, type SlaStatus } from "../services/sla.service";
import { contactBodySchema, availabilityBodySchema, notificationHistoryQuerySchema } from "../validation/me.schema";

const router = express.Router();

const CONFIRM_TOKEN_TTL_MS = 24 * 3600 * 1000;
const APP_BASE_URL = process.env.APP_BASE_URL || "http://localhost:4000";
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:3000";

// GET /api/v1/me/status — self-read of the live role/isActive/permissions,
// so a page that decides what to show (the dashboard's tiles) doesn't have
// to trust the access token's baked-in claims, which go stale the moment an
// admin changes the caller's permissions or deactivates them mid-session
// (the token itself stays validly signed until its own ~15min expiry
// regardless — see services/permissions.ts's isActiveAccount comment for
// the same staleness problem on the API-enforcement side). Self-scoped, so
// no permission key needed — same reasoning as GET /contact below.
router.get("/status", requireAuth, async (req: Request, res: Response) => {
  const user = await User.findById(req.user!.id).select("role isActive permissions isOnline");
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res
    .status(200)
    .json({ role: user.role, isActive: user.isActive, permissions: user.permissions ?? [], isOnline: user.isOnline });
});

// GET /api/v1/me/support-summary — customer-portal Story 37: the "My
// Support" stat strip's data source (frontend/app/tickets/page.tsx's
// customer branch, via CustomerSupportSummary). Self-scoped, so
// requireRole("customer") + no permission key, same convention as
// /workspace below (its agent-facing equivalent) — just three counts, no
// item lists.
const RESOLVED_RECENTLY_WINDOW_DAYS = 30;

router.get("/support-summary", requireAuth, requireRole("customer"), async (req: Request, res: Response) => {
  const customerId = new Types.ObjectId(req.user!.id);
  const since = new Date(Date.now() - RESOLVED_RECENTLY_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [openTickets, activeChats, resolvedTicketsRecently, resolvedChatsRecently] = await Promise.all([
    Ticket.countDocuments({ customer: customerId, status: { $ne: "closed" } }),
    Conversation.countDocuments({ customer: customerId, status: { $ne: "resolved" } }),
    Ticket.countDocuments({ customer: customerId, status: "closed", updatedAt: { $gte: since } }),
    Conversation.countDocuments({ customer: customerId, status: "resolved", updatedAt: { $gte: since } }),
  ]);

  res.status(200).json({
    openTickets,
    activeChats,
    resolvedRecently: resolvedTicketsRecently + resolvedChatsRecently,
  });
});

// PATCH /api/v1/me/availability — agent self-flip of isOnline (Story 21,
// scoped down to just the flag + a minimal toggle, not the full dashboard —
// see .squad/stories/agent-workspace/agent-availability-toggle/intake.md).
// Self-scoped, so requireAuth only (no permission key), matching
// /me/contact's precedent. Guarded so only role === "agent" can go online:
// admins/sub-admins/customers are never auto-assigned to tickets or chats,
// so isOnline is meaningless for them; reject with 403 rather than silently
// no-op'ing. Deactivated users (isActive === false) also cannot go online —
// admin.routes.ts already forces isOnline=false on deactivation and this
// must not let it bounce back on afterwards.
router.patch("/availability", requireAuth, async (req: Request, res: Response) => {
  const parsed = availabilityBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
    return;
  }
  const user = await User.findById(req.user!.id);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (user.role !== "agent") {
    res.status(403).json({ error: "Only agents can set availability" });
    return;
  }
  if (parsed.data.isOnline && !user.isActive) {
    res.status(403).json({ error: "Deactivated account cannot go online" });
    return;
  }
  user.isOnline = parsed.data.isOnline;
  await user.save();
  // security-admin Story 47: an agent's own online/offline toggle is
  // account-state, same category as staff activation/deactivation.
  await recordAuditLog({
    actor: user.id,
    action: "agent_availability_changed",
    targetType: "User",
    targetId: user.id,
    metadata: { isOnline: user.isOnline },
    ipAddress: req.ip,
  });
  res.status(200).json({ isOnline: user.isOnline });
});

// agent-workspace Story 35: the Triage Board's data source — the caller's
// own assigned open tickets AND live chats, merged and grouped by the SLA
// status sla.service.ts derives, so the frontend's three columns are a
// straight read of `columns`, not a client-side re-derivation of the
// at-risk threshold.
//
// Self-scoped ("my assignments"), so requireAuth + requireRole only, no
// permission key — same convention as /status, /availability and /contact
// above, and the documented dashboard exception to the project's
// every-route-needs-a-permission rule. Because requireRole alone does NOT
// re-check isActive (see middleware/auth.ts's requireAuth doc comment), the
// deactivation check is done explicitly in the handler below.
const OPEN_TICKET_STATUSES = ["new", "in_progress", "answered", "escalated"] as const;
// A claimed, still-open chat is always "with_agent" — conversation:claim
// sets assignedAgent + "with_agent" atomically and conversation:unclaim
// reverts both (sockets/chat.socket.ts). "escalated"/"ai_handling" chats
// are by construction unassigned; "resolved" is done. Deliberately NOT the
// union filter conversation.routes.ts's staff list uses — the board shows
// only work this agent has actually claimed.
const OPEN_CHAT_STATUSES = ["with_agent"] as const;

// Safety bound on a pathological assignment count, not a product cap (and
// not the paging story): an agent's open assigned workload is tens of items,
// and COLUMN_CAP below is what the UI actually enforces.
const FETCH_CAP = 200;
const COLUMN_CAP = 25;

interface WorkspaceItem {
  id: string;
  type: "ticket" | "chat";
  // "TCK-1234" for tickets (same format as ticket.routes.ts's
  // toTicketListItem), null for chats — a conversation has no reference
  // number, so the card falls back to its customer name.
  reference: string | null;
  title: string | null;
  priority: "low" | "medium" | "high" | "urgent" | null; // chats carry no priority
  status: string;
  customer: { id: string; name: string } | null;
  assignedAgent: { id: string; name: string } | null;
  slaStatus: SlaStatus;
  // The single timestamp the column sorts on and the card counts down to:
  // the earliest DEFINED target on the item. Null when the item predates
  // sla-automation; those sort last.
  urgencyAt: string | null;
  responseTargetAt: string | null;
  resolutionTargetAt: string | null; // always null for chats
  createdAt: string;
  updatedAt: string;
}

// The earliest DEFINED target. Mirrors slaMonitor.service.ts's
// `activeTarget` rule (responseTargetAt, when present, is always the nearer
// deadline — resolutionMinutes >= responseMinutes is enforced at the
// SlaTarget level), generalised so a ticket missing one of the two still
// sorts correctly.
function earliestTarget(...targets: Array<Date | undefined | null>): Date | null {
  const defined = targets.filter((d): d is Date => Boolean(d));
  if (defined.length === 0) return null;
  return defined.reduce((a, b) => (a.getTime() < b.getTime() ? a : b));
}

// Ascending by urgency, nulls (no SLA target at all) last, ties broken by
// createdAt so the order is deterministic across requests.
function byUrgency(a: WorkspaceItem, b: WorkspaceItem): number {
  if (a.urgencyAt !== b.urgencyAt) {
    if (a.urgencyAt === null) return 1;
    if (b.urgencyAt === null) return -1;
    const delta = a.urgencyAt.localeCompare(b.urgencyAt);
    if (delta !== 0) return delta;
  }
  return a.createdAt.localeCompare(b.createdAt);
}

router.get(
  "/workspace",
  requireAuth,
  requireRole("agent", "admin", "subadmin"),
  async (req: Request, res: Response) => {
    if (!(await isActiveAccount(req.user!.id))) {
      res.status(403).json({ error: "You do not have permission to perform this action" });
      return;
    }

    const agentId = new Types.ObjectId(req.user!.id);
    // One `now` for the whole request: two rows evaluated microseconds apart
    // must never land in different columns from the same snapshot.
    const now = new Date();

    const [tickets, conversations] = await Promise.all([
      Ticket.find({ assignedAgent: agentId, status: { $in: [...OPEN_TICKET_STATUSES] } })
        .select("ticketNumber subject status priority customer assignedAgent sla createdAt updatedAt")
        .populate<{ customer: { _id: Types.ObjectId; name: string } | null }>("customer", "name")
        .populate<{ assignedAgent: { _id: Types.ObjectId; name: string } | null }>("assignedAgent", "name")
        .limit(FETCH_CAP)
        .lean(),
      Conversation.find({ assignedAgent: agentId, status: { $in: [...OPEN_CHAT_STATUSES] } })
        .select("status customer assignedAgent sla createdAt updatedAt")
        .populate<{ customer: { _id: Types.ObjectId; name: string } | null }>("customer", "name")
        .populate<{ assignedAgent: { _id: Types.ObjectId; name: string } | null }>("assignedAgent", "name")
        .limit(FETCH_CAP)
        .lean(),
    ]);

    const ticketItems: WorkspaceItem[] = tickets.map((ticket) => {
      const urgencyAt = earliestTarget(ticket.sla?.responseTargetAt, ticket.sla?.resolutionTargetAt);
      return {
        id: ticket._id.toString(),
        type: "ticket",
        reference: `TCK-${ticket.ticketNumber}`,
        title: ticket.subject,
        priority: ticket.priority,
        status: ticket.status,
        customer: ticket.customer ? { id: ticket.customer._id.toString(), name: ticket.customer.name } : null,
        assignedAgent: ticket.assignedAgent
          ? { id: ticket.assignedAgent._id.toString(), name: ticket.assignedAgent.name }
          : null,
        slaStatus: computeSlaStatus({
          responseTargetAt: ticket.sla?.responseTargetAt,
          resolutionTargetAt: ticket.sla?.resolutionTargetAt,
          currentStatus: ticket.status,
          now,
        }),
        urgencyAt: urgencyAt ? urgencyAt.toISOString() : null,
        responseTargetAt: ticket.sla?.responseTargetAt ? ticket.sla.responseTargetAt.toISOString() : null,
        resolutionTargetAt: ticket.sla?.resolutionTargetAt ? ticket.sla.resolutionTargetAt.toISOString() : null,
        createdAt: ticket.createdAt.toISOString(),
        updatedAt: ticket.updatedAt.toISOString(),
      };
    });

    // No resolutionTargetAt and no currentStatus passed — a conversation's
    // SLA sub-document has a response target only (models/Conversation.ts),
    // exactly as conversation.routes.ts's list mapping does it.
    const chatItems: WorkspaceItem[] = conversations.map((conversation) => {
      const urgencyAt = earliestTarget(conversation.sla?.responseTargetAt);
      return {
        id: conversation._id.toString(),
        type: "chat",
        reference: null,
        title: null,
        priority: null,
        status: conversation.status,
        customer: conversation.customer
          ? { id: conversation.customer._id.toString(), name: conversation.customer.name }
          : null,
        assignedAgent: conversation.assignedAgent
          ? { id: conversation.assignedAgent._id.toString(), name: conversation.assignedAgent.name }
          : null,
        slaStatus: computeSlaStatus({ responseTargetAt: conversation.sla?.responseTargetAt, now }),
        urgencyAt: urgencyAt ? urgencyAt.toISOString() : null,
        responseTargetAt: conversation.sla?.responseTargetAt
          ? conversation.sla.responseTargetAt.toISOString()
          : null,
        resolutionTargetAt: null,
        createdAt: conversation.createdAt.toISOString(),
        updatedAt: conversation.updatedAt.toISOString(),
      };
    });

    const merged = [...ticketItems, ...chatItems];
    const breached = merged.filter((item) => item.slaStatus === "breached").sort(byUrgency);
    const atRisk = merged.filter((item) => item.slaStatus === "at_risk").sort(byUrgency);
    const onTrack = merged.filter((item) => item.slaStatus === "on_track").sort(byUrgency);

    // All three keys are always present, even when every items array is
    // empty — the frontend must never have to invent a missing column.
    res.status(200).json({
      columns: {
        breached: { items: breached.slice(0, COLUMN_CAP), total: breached.length },
        at_risk: { items: atRisk.slice(0, COLUMN_CAP), total: atRisk.length },
        on_track: { items: onTrack.slice(0, COLUMN_CAP), total: onTrack.length },
      },
      generatedAt: now.toISOString(),
    });
  }
);

// live-chat: a notification now carries exactly one of ticketId/
// conversationId (never both — see notification.service.ts's two creation
// helpers), so `ticket`/`conversation` in the response are each nullable,
// and the caller picks whichever is non-null to build its link. Unlike
// ticket (reference + subject), a conversation has no equivalent
// human-readable label to surface here — the frontend renders a generic
// "Live chat" subtext for those instead.
function toNotificationItem(n: {
  _id: Types.ObjectId;
  type: string;
  read: boolean;
  createdAt: Date;
  ticketId: { _id: Types.ObjectId; ticketNumber: number; subject: string } | null;
  conversationId: { _id: Types.ObjectId } | null;
}) {
  return {
    id: n._id.toString(),
    type: n.type,
    read: n.read,
    createdAt: n.createdAt,
    ticket: n.ticketId
      ? { id: n.ticketId._id.toString(), reference: `TCK-${n.ticketId.ticketNumber}`, subject: n.ticketId.subject }
      : null,
    conversation: n.conversationId ? { id: n.conversationId._id.toString() } : null,
  };
}

// Story 54 (ticket-management): "my notifications" — every authenticated
// staff account reads/marks-read only its own, same self-scoped shape as
// /me/status and /me/contact above, so requireAuth only, no permission key
// (see this story's intake for why: it's "my own data," not a resource
// gated by role/permission).
//
// Two modes on one route, not two routes: with no query params at all
// (the bell's plain fetchNotifications() call), this keeps its ORIGINAL
// behavior exactly — unread-first then newest-first, capped at 50, a plain
// array — so the existing dropdown is untouched. The moment ANY of
// page/limit/from/to is present (the "view all" history page's call),
// it switches to a paginated, newest-first-only, optionally date-filtered
// mode returning { notifications, total, page, limit } instead. Checked
// against the RAW query, not the schema-defaulted parsed result, same
// "presence vs. value" reasoning ticket.routes.ts's PATCH /:id uses for its
// optional fields — the schema defaults page/limit even when the caller
// sent neither.
router.get("/notifications", requireAuth, async (req: Request, res: Response) => {
  const isHistoryMode = ["page", "limit", "from", "to"].some((key) => key in req.query);

  if (!isHistoryMode) {
    const notifications = await Notification.find({ recipient: req.user!.id })
      .sort({ read: 1, createdAt: -1 })
      .limit(50)
      .populate<{ ticketId: { _id: Types.ObjectId; ticketNumber: number; subject: string } | null }>(
        "ticketId",
        "ticketNumber subject"
      )
      .populate<{ conversationId: { _id: Types.ObjectId } | null }>("conversationId", "_id")
      .lean();

    // A notification whose ticket/conversation was hard-deleted (never
    // happens today for tickets; conversations are never hard-deleted
    // either — but populate() nulling a dangling ref is cheaper to guard
    // than to assume away) is dropped rather than shown with a broken link.
    res.status(200).json(notifications.filter((n) => n.ticketId || n.conversationId).map(toNotificationItem));
    return;
  }

  const parsed = notificationHistoryQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid query" });
    return;
  }
  const { page, limit, from, to } = parsed.data;

  const filter: Record<string, unknown> = { recipient: req.user!.id };
  if (from || to) {
    filter.createdAt = {
      ...(from ? { $gte: new Date(from) } : {}),
      ...(to ? { $lte: new Date(to) } : {}),
    };
  }

  const [notifications, total] = await Promise.all([
    Notification.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate<{ ticketId: { _id: Types.ObjectId; ticketNumber: number; subject: string } | null }>(
        "ticketId",
        "ticketNumber subject"
      )
      .populate<{ conversationId: { _id: Types.ObjectId } | null }>("conversationId", "_id")
      .lean(),
    Notification.countDocuments(filter),
  ]);

  res.status(200).json({
    notifications: notifications.filter((n) => n.ticketId || n.conversationId).map(toNotificationItem),
    total,
    page,
    limit,
  });
});

router.patch("/notifications/:id/read", requireAuth, async (req: Request<{ id: string }>, res: Response) => {
  if (!Types.ObjectId.isValid(req.params.id)) {
    res.status(404).json({ error: "Notification not found" });
    return;
  }
  // recipient must match the caller in the filter itself, not checked after
  // the fact — a 404 either way (wrong id or someone else's notification)
  // never reveals that another user's notification exists.
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.id, recipient: req.user!.id },
    { $set: { read: true } },
    { new: true }
  );
  if (!notification) {
    res.status(404).json({ error: "Notification not found" });
    return;
  }
  res.status(200).json({ id: notification._id.toString(), read: notification.read });
});

// GET /api/v1/me/contact — self-read, so the settings page (Task 5) has a
// data source for the current phone/email/pendingEmail on load. Neither
// Story 4's endpoint nor decoding the JWT (which only carries { sub, role })
// can supply pendingEmail, so this endpoint is required, not optional.
router.get("/contact", requireAuth, async (req: Request, res: Response) => {
  const user = await User.findById(req.user!.id).select("phone email pendingEmail");
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.status(200).json({ phone: user.phone ?? null, email: user.email, pendingEmail: user.pendingEmail });
});

router.patch("/contact", requireAuth, async (req: Request, res: Response) => {
  const rawBody = (req.body ?? {}) as Record<string, unknown>;
  const parsed = contactBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
    return;
  }
  const { phone, email } = parsed.data;

  const user = await User.findById(req.user!.id);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  // Phone is optional on the User model (models/User.ts) — an empty string
  // clears it, matching customer.routes.ts's PATCH /customers/:id handling
  // of the same field.
  let phoneChanged = false;
  if ("phone" in rawBody && phone !== user.phone) {
    phoneChanged = true;
    user.phone = phone;
  }

  let emailChangeRequested = false;
  if ("email" in rawBody) {
    const normalizedEmail = email as string;
    if (normalizedEmail === user.email) {
      res.status(400).json({ error: "This is already your current email" });
      return;
    }
    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      res.status(409).json({ error: "Email already in use" });
      return;
    }

    const token = crypto.randomBytes(32).toString("hex");
    user.pendingEmail = normalizedEmail;
    user.emailConfirmToken = token;
    user.emailConfirmTokenExpiresAt = new Date(Date.now() + CONFIRM_TOKEN_TTL_MS);

    try {
      const confirmUrl = `${APP_BASE_URL}/api/v1/me/email/confirm?token=${token}`;
      await sendEmail({
        to: normalizedEmail,
        subject: "Confirm your new email address",
        text: `Confirm your new email address for AzmSquad.\n\nOpen this link to complete the change:\n${confirmUrl}\n\nThis link expires in 24 hours. If you didn't request this, you can ignore this email — your email address won't change.`,
        html: renderEmailHtml({
          heading: "Confirm your new email address",
          bodyHtml:
            "You asked to change the email on your AzmSquad account to this address. Confirm it below to finish the change.<br><br>This link expires in 24 hours. If you didn't request this, you can ignore this email — your email address won't change.",
          ctaText: "Confirm email address",
          ctaUrl: confirmUrl,
        }),
      });
    } catch (err) {
      user.pendingEmail = null;
      user.emailConfirmToken = null;
      user.emailConfirmTokenExpiresAt = null;
      await user.save();
      res.status(502).json({ error: "Could not send confirmation email" });
      return;
    }
    emailChangeRequested = true;
  }

  // Single save for both fields — avoids two round-trips when both
  // phone and email are present in the same request.
  await user.save();

  if (phoneChanged) {
    await recordAuditLog({
      actor: req.user!.id,
      action: "customer_contact_updated",
      targetType: "User",
      targetId: user.id,
      metadata: { field: "phone" },
      ipAddress: req.ip,
    });
  }
  if (emailChangeRequested) {
    await recordAuditLog({
      actor: req.user!.id,
      action: "customer_email_change_requested",
      targetType: "User",
      targetId: user.id,
      metadata: { pendingEmail: user.pendingEmail },
      ipAddress: req.ip,
    });
  }

  res.status(200).json({ phone: user.phone ?? null, email: user.email, pendingEmail: user.pendingEmail });
});

// This is a link a human clicks from their email client, not an API call a
// script makes — it must land somewhere a browser can render, not JSON.
// Redirects to a public frontend page (frontend/app/email-confirmed/page.tsx)
// rather than /settings directly: whoever clicks it may not be authenticated
// in that browser at all (e.g. opening the email on a different device), so
// a page requiring a session isn't a safe landing target.
router.get("/email/confirm", async (req: Request, res: Response) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const user = await User.findOne({ emailConfirmToken: token });

  if (!user || !user.emailConfirmTokenExpiresAt || user.emailConfirmTokenExpiresAt < new Date()) {
    res.redirect(`${CLIENT_ORIGIN}/email-confirmed?status=invalid`);
    return;
  }

  const existing = await User.findOne({ email: user.pendingEmail });
  if (existing) {
    user.pendingEmail = null;
    user.emailConfirmToken = null;
    user.emailConfirmTokenExpiresAt = null;
    await user.save();
    res.redirect(`${CLIENT_ORIGIN}/email-confirmed?status=conflict`);
    return;
  }

  user.email = user.pendingEmail as string;
  user.pendingEmail = null;
  user.emailConfirmToken = null;
  user.emailConfirmTokenExpiresAt = null;

  try {
    await user.save();
  } catch (err) {
    // Race: someone else confirmed the same address in the TOCTOU window
    // between the findOne check above and this save() — email's unique
    // index throws E11000 rather than letting a silent duplicate through.
    if ((err as { code?: number }).code === 11000) {
      res.redirect(`${CLIENT_ORIGIN}/email-confirmed?status=conflict`);
      return;
    }
    throw err;
  }

  await recordAuditLog({
    actor: user.id,
    action: "customer_email_change_confirmed",
    targetType: "User",
    targetId: user.id,
    metadata: { email: user.email },
    ipAddress: req.ip,
  });

  res.redirect(`${CLIENT_ORIGIN}/email-confirmed?status=success&email=${encodeURIComponent(user.email)}`);
});

export default router;
