import express, { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { requireAuth, requirePermission, requireRole } from "../middleware/auth";
import { Conversation } from "../models/Conversation";
import { Message } from "../models/Message";
import { validateBody } from "../middleware/validate";
import { createConversationSchema } from "../validation/conversation.schema";
import { hasPermission } from "../services/permissions";
import { resolveConversationSlaTargets, computeSlaStatus } from "../services/sla.service";
import { summarizeConversation, summaryOutcomeStatus } from "../services/summary.service";
import { recordAuditLog } from "../services/auditLog.service";
import type { PermissionKey } from "../constants/permissions";

const router = express.Router();

// customer-portal Story 37: same composer as ticket.routes.ts's
// customerOrPermitted — a customer needs no permission concept at all
// (self-service, scoped to their own data inside the handler), while every
// other role goes through the real requirePermission middleware.
function customerOrPermitted(key: PermissionKey) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.user!.role === "customer") {
      next();
      return;
    }
    requirePermission(key)(req, res, next);
  };
}

// Shared with chat.socket.ts's isAuthorizedOnConversation (Story 18): the
// conversation's own customer, its assignedAgent, or any admin — plus a
// sub-admin holding chats:manage, who (per that permission's scope) can act
// on any conversation the same way admin does, not just ones assigned to
// them (sub-admins are never auto-assignment candidates in the first
// place — see assignment.service.ts). Kept as a separate small helper here
// rather than importing the socket module's version, so this route file
// never depends on Socket.io wiring. Async (a live DB check for the
// sub-admin branch), unlike the old sync version — every call site below
// already awaits it.
async function callerAuthorizedOnConversation(
  user: { id: string; role: string },
  conversation: { customer: unknown; assignedAgent: unknown }
): Promise<boolean> {
  if (user.role === "admin") return true;
  if (user.role === "subadmin") return hasPermission(user.id, "chats:manage");
  if (user.id === String(conversation.customer) || user.id === String(conversation.assignedAgent)) return true;
  // An unclaimed conversation (assignedAgent: null) is visible to any agent
  // holding chats:manage — same scope the GET / list route and the claim
  // action itself already use. Without this, the chat_needs_agent
  // notification/toast (sent to every chats:manage agent, not just whoever
  // ends up claiming it) links to a page that 403s for everyone until one
  // of them claims it first.
  if (user.role === "agent" && conversation.assignedAgent == null) {
    return hasPermission(user.id, "chats:manage");
  }
  return false;
}

// live-chat Story 14: customer starts a new conversation. Real-time messaging
// itself is handled over Socket.io (see sockets/chat.socket.ts) — this route
// only creates the parent Conversation document the socket handlers attach to.
//
// Reopening the chat widget (page refresh, closing and reopening the tab,
// navigating away and back) resumes the customer's own still-open session
// instead of creating a fresh one every time — same behavior as Zendesk/
// Intercom's chat widgets, where the conversation persists until it's
// actually closed. Without this, every remount orphaned the previous
// Conversation document (never resolved, message history lost from the
// widget's perspective) and logged a duplicate chat_started audit entry.
router.post(
  "/",
  requireAuth,
  requireRole("customer"),
  validateBody(createConversationSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await Conversation.findOne({
        customer: req.user!.id,
        status: { $ne: "resolved" },
      }).sort({ createdAt: -1 });

      if (existing) {
        const messages = await Message.find({ parentType: "conversation", parentId: existing._id })
          .sort({ createdAt: 1 })
          .limit(500)
          .lean();
        res.status(200).json({ conversation: existing, messages });
        return;
      }

      // sla-automation Story 26: stamp the first-response deadline at
      // creation time. No resolutionTargetAt — chats have no "resolution"
      // SLA concept (see IConversationSla).
      const slaTargets = await resolveConversationSlaTargets({});
      const conversation = await Conversation.create({
        customer: req.user!.id,
        // status defaults to "ai_handling" per the model; explicit here for readability.
        status: "ai_handling",
        assignedAgent: null,
        sla: { responseTargetAt: slaTargets.responseTargetAt, breached: false },
      });

      await recordAuditLog({
        actor: req.user!.id,
        action: "chat_started",
        targetType: "Conversation",
        targetId: conversation.id,
        ipAddress: req.ip,
      });

      res.status(201).json({ conversation, messages: [] });
    } catch (err) {
      next(err);
    }
  }
);

// live-chat: read-only check for the customer's own currently-active
// (non-resolved) conversation — used by the chat widget on mount to decide
// whether to resume a real in-progress session or start with a blank slate.
// Deliberately does NOT count a conversation with zero messages as "active"
// here (unlike POST / above, which resumes it regardless) — simply opening
// the widget and never typing anything must not surface as a resumable
// session, or as an entry in the customer's own chat history (GET /) later.
// Registered before GET /:id so "active" is never swallowed as an :id value.
router.get("/active", requireAuth, requireRole("customer"), async (req: Request, res: Response) => {
  const conversation = await Conversation.findOne({
    customer: req.user!.id,
    status: { $ne: "resolved" },
  }).sort({ createdAt: -1 });

  if (!conversation) {
    res.status(200).json({ conversation: null, messages: [] });
    return;
  }

  const messages = await Message.find({ parentType: "conversation", parentId: conversation._id })
    .sort({ createdAt: 1 })
    .limit(500)
    .lean();

  if (messages.length === 0) {
    res.status(200).json({ conversation: null, messages: [] });
    return;
  }

  res.status(200).json({ conversation, messages });
});

// Story 16 ("Escalate to a human agent") is socket-only, not a REST route —
// see backend/src/sockets/chat.socket.ts's conversation:escalate handler.
// conversation:message is already the customer's only real-time channel into
// the conversation, so escalation reuses that same authenticated/authorized
// transport rather than introducing a second parallel one.

// Story 18: staff-scoped list of active conversations — an admin or a
// sub-admin holding chats:manage sees every active one (same "sees
// everything" scope as admin, per that permission — a sub-admin is never a
// claim candidate on its own, so restricting to "own claimed ones" would
// always be empty for them). Gated by chats:manage rather than a bare role
// check (admin passes implicitly via requirePermission) — this is the piece
// that used to be hardcoded to requireRole("agent", "admin") with no
// permission-delegation path at all, so a sub-admin could never reach live
// chat regardless of what was granted; every agent had unconditional access
// with no way to revoke it.
//
// A plain agent sees the union of "chats I'm currently handling" (their own
// assignedAgent) and "unclaimed chats waiting for someone" (assignedAgent:
// null) — never another agent's claimed chat. This is what makes an
// unclaimed conversation actually reachable to claim (conversation:claim):
// without the null branch, a plain agent could never even see a chat before
// someone else's socket had already claimed it.
//
// Not paginated yet (platform Story 59 covers that consistently once it's
// this route's turn). Story 19 (close a live chat) intentionally does NOT
// widen the STAFF filter to include "resolved" — a closed conversation
// drops out of the staff list on purpose; the agent who closed it still has
// the URL, and GET /:id stays readable regardless of status. customer-portal
// Story 37 is the "closed chats" history view flagged as separate, later
// scope back then — it's the customer branch below, deliberately WITHOUT
// that status restriction, since a customer's own history should show
// resolved conversations too.
router.get("/", requireAuth, customerOrPermitted("chats:manage"), async (req: Request, res: Response) => {
  const filter =
    req.user!.role === "customer"
      ? { customer: new Types.ObjectId(req.user!.id) }
      : req.user!.role === "admin" || req.user!.role === "subadmin"
        ? { status: { $in: ["escalated", "with_agent"] } }
        : {
            status: { $in: ["escalated", "with_agent"] },
            $or: [{ assignedAgent: new Types.ObjectId(req.user!.id) }, { assignedAgent: null }],
          };
  // Populated so the staff list can show who the agent is actually talking
  // to, not just a status/timestamp row. assignedAgent is now who has
  // actively claimed the chat (conversation:claim), not an auto-picked
  // agent — populated so the list can show "Handled by X" / "Unclaimed"
  // per row without a second round-trip.
  const conversations = await Conversation.find(filter)
    .populate<{ customer: { _id: Types.ObjectId; name: string } }>("customer", "name")
    .populate<{ assignedAgent: { _id: Types.ObjectId; name: string } | null }>("assignedAgent", "name")
    .sort({ updatedAt: -1 })
    .lean();
  // sla-automation Story 26: derived on read, not stored — see sla.service.ts.
  const withSla = conversations.map((conversation) => ({
    ...conversation,
    slaStatus: computeSlaStatus({ responseTargetAt: conversation.sla?.responseTargetAt }),
    responseTargetAt: conversation.sla?.responseTargetAt ?? null,
  }));
  res.status(200).json({ conversations: withSla });
});

// Story 18: the agent-facing transcript read — full history including prior
// AI messages, so the agent has context before replying. Also reachable by
// the conversation's own customer (same authorization rule as the socket
// handlers) so this one endpoint can later back a customer-side view too,
// though only the staff path is built out this story.
router.get(
  "/:id",
  requireAuth,
  requireRole("agent", "admin", "subadmin", "customer"),
  async (req: Request<{ id: string }>, res: Response) => {
    if (!Types.ObjectId.isValid(req.params.id)) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    const conversation = await Conversation.findById(req.params.id);
    if (!conversation) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    // 403, not 404 — unlike a customer probing a foreign ticket id, a
    // wrong-conversation agent/admin case is a real permission question the
    // caller is allowed to know about (no customer-identity leak risk here).
    // Checked BEFORE the populate below — callerAuthorizedOnConversation
    // compares assignedAgent as a plain ObjectId (String(...) against
    // user.id), which would silently break if it ran against an already-
    // populated { _id, name } object instead.
    if (!(await callerAuthorizedOnConversation({ id: req.user!.id, role: req.user!.role }, conversation))) {
      res.status(403).json({ error: "You do not have permission to view this conversation" });
      return;
    }
    // Populated so the chat detail page can show who currently holds the
    // claim without a second round-trip.
    await conversation.populate<{ assignedAgent: { _id: Types.ObjectId; name: string } | null }>(
      "assignedAgent",
      "name"
    );
    const messages = await Message.find({ parentType: "conversation", parentId: conversation._id })
      .sort({ createdAt: 1 })
      .limit(500)
      .lean();
    // sla-automation Story 26: derived on read, not stored — see sla.service.ts.
    // Built as a plain object rather than mutating the Mongoose document.
    res.status(200).json({
      conversation: {
        ...conversation.toObject(),
        slaStatus: computeSlaStatus({ responseTargetAt: conversation.sla?.responseTargetAt }),
        responseTargetAt: conversation.sla?.responseTargetAt ?? null,
      },
      messages,
    });
  }
);

// ai-features Story 32: one-click, never-persisted AI summary of the
// conversation's message thread. Same 404/409/503/200 shape as the ticket
// route in ticket.routes.ts — see summary.service.ts.
router.post(
  "/:id/summarize",
  requireAuth,
  requireRole("agent", "admin", "subadmin"),
  requirePermission("ai:summarize"),
  async (req: Request<{ id: string }>, res: Response) => {
    if (!Types.ObjectId.isValid(req.params.id)) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    const conversation = await Conversation.findById(req.params.id).select("_id");
    if (!conversation) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    const outcome = await summarizeConversation(req.params.id);
    if (!outcome.ok) {
      res.status(summaryOutcomeStatus(outcome)).json({ error: outcome.reason });
      return;
    }

    await recordAuditLog({
      actor: req.user!.id,
      action: "chat_summarized",
      targetType: "Conversation",
      targetId: String(conversation._id),
      ipAddress: req.ip,
    });

    res.status(200).json({ summary: outcome.summary });
  }
);

export default router;
