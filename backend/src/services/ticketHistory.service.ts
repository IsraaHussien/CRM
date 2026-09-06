import { Types } from "mongoose";
import { Ticket } from "../models/Ticket";
import { Message } from "../models/Message";
import { User } from "../models/User";

// ticket-management Story 13 (+ follow-up): aggregates every meaningful
// thing that has happened on a ticket (creation, status/category/priority/
// assignee changes, replies, internal notes) into one chronological
// timeline.
export type TicketHistoryEventKind =
  | "created"
  | "status_changed"
  | "category_changed"
  | "priority_changed"
  | "assignee_changed"
  | "reply_posted"
  | "internal_note_added"
  | "chat_participant_joined"
  | "chat_participant_left"
  | "chat_inquiry"
  | "sla_at_risk"
  | "sla_breached";

export interface TicketHistoryEvent {
  kind: TicketHistoryEventKind;
  at: Date;
  actor: { id: string; name: string | null; role: string } | null;
  data: Record<string, unknown>;
}

export class TicketNotFoundError extends Error {
  constructor() {
    super("Ticket not found");
    this.name = "TicketNotFoundError";
  }
}

export interface BuildTicketHistoryOptions {
  // Set when the caller is the ticket's own customer: internal notes are
  // agent-only (see Message.ts's doc comment) and must never reach this
  // branch, even though customers can't reach the export route at all.
  viewerRole?: string;
  // Reserved for a future customer-portal reuse of this aggregator (Story
  // 37 mirrors Story 6's query pattern the same way) — defaults to false
  // since nothing consumes it yet.
  redactInternalBodies?: boolean;
}

type UserLean = { _id: Types.ObjectId; name: string; role: string };

export async function buildTicketHistory(
  ticketId: Types.ObjectId,
  options: BuildTicketHistoryOptions = {}
): Promise<TicketHistoryEvent[]> {
  const ticket = await Ticket.findById(ticketId)
    .populate<{ customer: { _id: Types.ObjectId; name: string } | null }>("customer", "name")
    .populate<{ escalatedTo: { _id: Types.ObjectId; name: string } | null }>("escalatedTo", "name")
    .populate<{ createdBy: { _id: Types.ObjectId; name: string; role: string } | null }>("createdBy", "name role");
  if (!ticket) {
    throw new TicketNotFoundError();
  }

  const events: TicketHistoryEvent[] = [];

  // ticket-management Story 63: prefer createdBy (the actual creator — a
  // staff member for a create-on-behalf-of ticket) over ticket.customer
  // (just the ticket's owner, not necessarily who created it). Falls back
  // to customer for a ticket created before Story 63 shipped, when
  // createdBy is still null — the only provenance available for those.
  const creator = ticket.createdBy
    ? { _id: ticket.createdBy._id, name: ticket.createdBy.name, role: ticket.createdBy.role }
    : ticket.customer
      ? { _id: ticket.customer._id, name: ticket.customer.name, role: "customer" }
      : null;
  events.push({
    kind: "created",
    at: ticket.createdAt,
    actor: creator ? { id: creator._id.toString(), name: creator.name, role: creator.role } : null,
    // createdVia rides along so the frontend can render a channel-aware
    // label ("via AI suggestion", "via phone", ...) instead of a generic
    // "created by X" that reads as if they typed it up unassisted.
    data: { ticketNumber: ticket.ticketNumber, subject: ticket.subject, createdVia: ticket.createdVia },
  });

  // One batched User lookup covers every "who did this" reference across
  // all four history arrays, plus the "who got assigned" target of each
  // assignedAgentHistory entry — a single query rather than one per array.
  const userIds = new Set<string>();
  for (const entry of ticket.statusHistory) userIds.add(entry.changedBy.toString());
  for (const entry of ticket.categoryHistory) userIds.add(entry.changedBy.toString());
  for (const entry of ticket.priorityHistory) userIds.add(entry.changedBy.toString());
  for (const entry of ticket.assignedAgentHistory) {
    userIds.add(entry.changedBy.toString());
    if (entry.assignedAgent) userIds.add(entry.assignedAgent.toString());
  }
  for (const entry of ticket.chatPresenceHistory) userIds.add(entry.user.toString());
  const users =
    userIds.size > 0 ? await User.find({ _id: { $in: [...userIds] } }, { name: 1, role: 1 }).lean<UserLean[]>() : [];
  const usersById = new Map(users.map((u) => [u._id.toString(), u]));

  function actorFor(changedBy: Types.ObjectId): TicketHistoryEvent["actor"] {
    const user = usersById.get(changedBy.toString());
    return user ? { id: changedBy.toString(), name: user.name, role: user.role } : null;
  }

  const lastEscalatedIndex = [...ticket.statusHistory].map((e) => e.status).lastIndexOf("escalated");
  ticket.statusHistory.forEach((entry, index) => {
    events.push({
      kind: "status_changed",
      at: entry.changedAt,
      actor: actorFor(entry.changedBy),
      data: {
        to: entry.status,
        ...(entry.status === "escalated" && index === lastEscalatedIndex && ticket.escalatedTo
          ? { escalatedTo: { id: ticket.escalatedTo._id.toString(), name: ticket.escalatedTo.name } }
          : {}),
      },
    });
  });

  for (const entry of ticket.categoryHistory) {
    events.push({
      kind: "category_changed",
      at: entry.changedAt,
      actor: actorFor(entry.changedBy),
      data: { to: entry.category },
    });
  }

  for (const entry of ticket.priorityHistory) {
    events.push({
      kind: "priority_changed",
      at: entry.changedAt,
      actor: actorFor(entry.changedBy),
      data: { to: entry.priority },
    });
  }

  for (const entry of ticket.assignedAgentHistory) {
    const targetUser = entry.assignedAgent ? usersById.get(entry.assignedAgent.toString()) : null;
    events.push({
      kind: "assignee_changed",
      at: entry.changedAt,
      actor: actorFor(entry.changedBy),
      data: {
        to: entry.assignedAgent && targetUser ? { id: entry.assignedAgent.toString(), name: targetUser.name } : null,
      },
    });
  }

  for (const entry of ticket.chatPresenceHistory) {
    events.push({
      kind: entry.event === "joined" ? "chat_participant_joined" : "chat_participant_left",
      at: entry.at,
      actor: actorFor(entry.user),
      data: {},
    });
  }

  // ai-features/live-chat: always the ticket's own customer (see
  // ITicketChatInquiryHistoryEntry's doc comment) — reuses the same
  // customer/role fallback as the "created" event above rather than another
  // batched lookup, since there's nobody else it could ever be.
  for (const entry of ticket.chatInquiryHistory) {
    events.push({
      kind: "chat_inquiry",
      at: entry.at,
      actor: ticket.customer
        ? { id: ticket.customer._id.toString(), name: ticket.customer.name, role: "customer" }
        : null,
      data: { conversationId: entry.conversation.toString() },
    });
  }

  // sla-automation Story 28: written by the periodic SLA monitor, not a
  // person — no changedBy to resolve, so actor is always null.
  for (const entry of ticket.slaHistory) {
    events.push({
      kind: entry.event === "at_risk" ? "sla_at_risk" : "sla_breached",
      at: entry.at,
      actor: null,
      data: {},
    });
  }

  const messageFilter: Record<string, unknown> = { parentType: "ticket", parentId: ticket._id };
  if (options.viewerRole === "customer") {
    // agent-workspace Story 24 — internal notes must NEVER be returned to
    // the customer. Landed with Story 13; re-verified by Story 24, which is
    // the feature that actually starts creating internal notes. Excluded in
    // the DB query rather than by dropping "internal_note_added" events
    // afterwards, so the rows never load at all.
    messageFilter.internal = { $ne: true };
  }
  const messages = await Message.find(messageFilter)
    .sort({ createdAt: 1 })
    .populate<{ senderId: { _id: Types.ObjectId; name: string; role: string } | null }>("senderId", "name role");

  for (const message of messages) {
    events.push({
      kind: message.internal ? "internal_note_added" : "reply_posted",
      at: message.createdAt,
      actor: message.senderId
        ? { id: message.senderId._id.toString(), name: message.senderId.name, role: message.senderId.role }
        : null,
      data: { messageId: message._id.toString() },
    });
  }

  events.sort((a, b) => a.at.getTime() - b.at.getTime());
  return events;
}
