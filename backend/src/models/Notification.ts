import mongoose, { Document, Schema, Types } from "mongoose";

// Story 54 (ticket-management): in-app notifications for ticket events.
// "ticket_reassigned" was added alongside the manual-reassignment feature
// (ticket-management Story 25) — the intake this model was originally
// scoped from only anticipated "assigned"/"escalated" (Story 10 and a future
// Story 12), but a manually reassigned ticket needs the same "you have new
// work, here's the link" nudge as an auto-assigned one. "ticket_unassigned"
// is the outgoing-assignee counterpart: reassignment notifies two different
// people with two different facts ("you got this" vs. "you no longer have
// this"), so it can't share "ticket_reassigned"'s "reassigned to you" text.
// "ticket_created" and "ticket_auto_assigned" are the oversight counterparts
// of ticket creation/auto-assignment (notifyTicketOversight in
// notification.service.ts) — sent to admins and tickets:view_all subadmins
// rather than the assignee, so they can't reuse "ticket_assigned"'s
// assignee-facing "...to you" text either. "ticket_needs_assignment" covers
// the case auto-assignment can't handle at all: no agent was online, so the
// ticket was created/left unassigned — oversight has to step in and use
// manual reassignment (Story 25) since there was nobody to auto-assign to.
// "ticket_reopened" / "ticket_reopened_oversight" (Story 11): same
// assignee-vs-oversight split as creation above, sent together whenever a
// PATCH /:id/status transition takes a ticket OUT of "closed" — the
// assigned agent (if any) gets the "to you" nudge, admins/tickets:view_all
// subadmins get the oversight fact regardless of whether the ticket is
// assigned. Unlike reassignment (Story 25), which only notifies the two
// agents involved, reopening is oversight-worthy on its own — a ticket
// coming back from "closed" is more consequential than a routine handoff.
// "chat_needs_agent" (live-chat): the conversation-side counterpart of
// ticket_needs_assignment above, added alongside the
// notify-available-agents-when-a-chat-needs-a-human story so escalation
// isn't silent. Unlike tickets, live chat has no auto-assign/"chat_assigned"
// counterpart — a chat is claimed by an explicit staff action (the "Join
// chat" button, chat.socket.ts's conversation:claim), and someone who just
// clicked Join doesn't need to be told they did. "chat_needs_agent" fires on
// EVERY escalation, to every agent/subadmin holding chats:manage plus every
// admin (see notifyChatOversight in notification.service.ts) — not just
// when nobody happens to be online, since the point is "someone, whenever
// they're free, should come claim this," not "we tried once and gave up."
// A notification carries exactly one of ticketId/conversationId, never both
// — see notification.service.ts's creation helpers, which never set both
// fields on the same write.
// "sla_at_risk" / "sla_breached" (sla-automation Story 28): fired by the
// periodic SLA monitor (slaMonitor.service.ts). sla_at_risk is single-shot
// (75% elapsed by default, admin-configurable); sla_breached fires exactly
// once when the target time is passed and is paired with automatic
// escalation via escalateTicket / escalateConversation. Both go to the
// assignee (or oversight, for a ticket with none); sla_breached also fans
// out to oversight via notifyTicketOversight regardless of assignee.
// "ticket_internal_note_mention" (agent-workspace Story 24): sent to a
// colleague explicitly tagged in an internal note (Message.internal: true)
// on a ticket. Never sent to the note's author (their own id is silently
// dropped from taggedUserIds), never sent to the customer (who holds no
// tickets:post_internal_note permission and never sees an internal note at
// all), and deduped per (ticket, recipient) at the call site — POST
// /:id/internal-notes de-duplicates taggedUserIds before notifying. It
// can't reuse any existing type: the recipient-facing copy is "you were
// mentioned in an internal note", which is neither an assignment
// ("ticket_assigned"), an escalation ("ticket_escalated"), nor an oversight
// fact ("ticket_created"/"ticket_needs_assignment").
export type NotificationType =
  | "ticket_assigned"
  | "ticket_escalated"
  | "ticket_reassigned"
  | "ticket_unassigned"
  | "ticket_created"
  | "ticket_auto_assigned"
  | "ticket_needs_assignment"
  | "ticket_reopened"
  | "ticket_reopened_oversight"
  | "chat_needs_agent"
  | "sla_at_risk"
  | "sla_breached"
  | "ticket_internal_note_mention";

export interface INotification extends Document {
  recipient: Types.ObjectId;
  type: NotificationType;
  ticketId: Types.ObjectId | null;
  conversationId: Types.ObjectId | null;
  read: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    recipient: { type: Schema.Types.ObjectId, ref: "User", required: true },
    type: {
      type: String,
      enum: [
        "ticket_assigned",
        "ticket_escalated",
        "ticket_reassigned",
        "ticket_unassigned",
        "ticket_created",
        "ticket_auto_assigned",
        "ticket_needs_assignment",
        "ticket_reopened",
        "ticket_reopened_oversight",
        "chat_needs_agent",
        "sla_at_risk",
        "sla_breached",
        "ticket_internal_note_mention",
      ],
      required: true,
    },
    ticketId: { type: Schema.Types.ObjectId, ref: "Ticket", default: null },
    conversationId: { type: Schema.Types.ObjectId, ref: "Conversation", default: null },
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Backs "my unread count" and "my notifications, unread-first" — the two
// queries GET /me/notifications actually runs.
notificationSchema.index({ recipient: 1, read: 1, createdAt: -1 });

export const Notification = mongoose.model<INotification>("Notification", notificationSchema);
