import mongoose, { Document, Schema, Types } from "mongoose";

// security-admin Story 47: proof-of-pattern audit trail. Deliberately a
// SEPARATE, narrower mechanism from Ticket.statusHistory (see
// .squad/plans/security-admin/34-story-review-audit-logs.md's Prerequisites
// section for why that embedded array isn't migrated here) — any future
// consolidation should converge on THIS model, not the other way around.
// Write-only via internal service calls (see services/auditLog.service.ts);
// no create/update/delete HTTP route exists for it at all — the simplest
// possible enforcement of "cannot be edited or deleted by regular users".
export type AuditActionCategory =
  | "auth"
  | "permissions"
  | "staff"
  | "customers"
  | "tickets"
  | "live-chat"
  | "knowledge-base"
  | "sla"
  | "feedback";

export type AuditAction =
  // auth
  | "login_success"
  | "login_failed"
  | "logout"
  | "customer_registered"
  // permissions
  | "permissions_changed"
  // staff
  | "staff_created"
  | "staff_updated"
  | "staff_activated"
  | "staff_deactivated"
  | "staff_deleted"
  | "agent_availability_changed"
  // customers
  | "customer_created"
  | "customer_updated"
  | "customer_contact_updated"
  | "customer_email_change_requested"
  | "customer_email_change_confirmed"
  | "customer_note_added"
  | "customer_note_updated"
  | "customer_attachment_added"
  | "customer_attachment_deleted"
  | "customer_id_document_updated"
  // tickets
  | "ticket_created"
  | "ticket_reassigned"
  | "ticket_category_changed"
  | "ticket_priority_changed"
  | "ticket_status_changed"
  | "ticket_escalated"
  | "ticket_replied"
  | "ticket_internal_note_added"
  | "ticket_summarized"
  | "ticket_category_created"
  | "ticket_category_updated"
  | "ticket_referenced_in_chat"
  // live-chat
  | "chat_started"
  | "chat_escalated"
  | "chat_claimed"
  | "chat_unclaimed"
  | "chat_closed"
  | "chat_summarized"
  // knowledge-base
  | "kb_faq_created"
  | "kb_faq_updated"
  | "kb_faq_deleted"
  | "kb_article_created"
  | "kb_article_updated"
  | "kb_article_deleted"
  // sla
  | "sla_target_created"
  | "sla_target_updated"
  | "sla_target_deleted"
  | "sla_settings_updated"
  // feedback
  | "feedback_submitted";

export const AUDIT_ACTION_CATEGORY: Record<AuditAction, AuditActionCategory> = {
  login_success: "auth",
  login_failed: "auth",
  logout: "auth",
  customer_registered: "auth",
  permissions_changed: "permissions",
  staff_created: "staff",
  staff_updated: "staff",
  staff_activated: "staff",
  staff_deactivated: "staff",
  staff_deleted: "staff",
  agent_availability_changed: "staff",
  customer_created: "customers",
  customer_updated: "customers",
  customer_contact_updated: "customers",
  customer_email_change_requested: "customers",
  customer_email_change_confirmed: "customers",
  customer_note_added: "customers",
  customer_note_updated: "customers",
  customer_attachment_added: "customers",
  customer_attachment_deleted: "customers",
  customer_id_document_updated: "customers",
  ticket_created: "tickets",
  ticket_reassigned: "tickets",
  ticket_category_changed: "tickets",
  ticket_priority_changed: "tickets",
  ticket_status_changed: "tickets",
  ticket_escalated: "tickets",
  ticket_replied: "tickets",
  ticket_internal_note_added: "tickets",
  ticket_summarized: "tickets",
  ticket_category_created: "tickets",
  ticket_category_updated: "tickets",
  ticket_referenced_in_chat: "tickets",
  chat_started: "live-chat",
  chat_escalated: "live-chat",
  chat_claimed: "live-chat",
  chat_unclaimed: "live-chat",
  chat_closed: "live-chat",
  chat_summarized: "live-chat",
  kb_faq_created: "knowledge-base",
  kb_faq_updated: "knowledge-base",
  kb_faq_deleted: "knowledge-base",
  kb_article_created: "knowledge-base",
  kb_article_updated: "knowledge-base",
  kb_article_deleted: "knowledge-base",
  sla_target_created: "sla",
  sla_target_updated: "sla",
  sla_target_deleted: "sla",
  sla_settings_updated: "sla",
  feedback_submitted: "feedback",
};

export const AUDIT_ACTIONS: AuditAction[] = Object.keys(AUDIT_ACTION_CATEGORY) as AuditAction[];

export const AUDIT_CATEGORIES: AuditActionCategory[] = [
  "auth",
  "permissions",
  "staff",
  "customers",
  "tickets",
  "live-chat",
  "knowledge-base",
  "sla",
  "feedback",
];

export type AuditTargetType =
  | "User"
  | "Ticket"
  | "Conversation"
  | "TicketCategory"
  | "SlaTarget"
  | "SlaSystemSettings"
  | "Faq"
  | "HelpArticle"
  | "Feedback";

export const AUDIT_TARGET_TYPES: AuditTargetType[] = [
  "User",
  "Ticket",
  "Conversation",
  "TicketCategory",
  "SlaTarget",
  "SlaSystemSettings",
  "Faq",
  "HelpArticle",
  "Feedback",
];

export interface IAuditLog extends Document {
  // Null when the action couldn't be tied to a resolvable account (e.g. a
  // failed login against an email with no matching User) — see
  // metadata.attemptedEmail in that case instead of inventing a placeholder id.
  actor: Types.ObjectId | null;
  action: AuditAction;
  category: AuditActionCategory;
  targetType: AuditTargetType;
  targetId: Types.ObjectId | null;
  metadata: Record<string, unknown>;
  ipAddress?: string;
  createdAt: Date;
}

const auditLogSchema = new Schema<IAuditLog>(
  {
    actor: { type: Schema.Types.ObjectId, ref: "User", default: null },
    action: { type: String, enum: AUDIT_ACTIONS, required: true },
    category: { type: String, enum: AUDIT_CATEGORIES, required: true },
    // No `ref` here (unlike `actor`) — which collection `targetId` points
    // into depends on `targetType`, so a single static ref would be wrong
    // for one of the two cases. Resolved manually per targetType in
    // audit.routes.ts's GET / instead of via .populate().
    targetType: { type: String, enum: AUDIT_TARGET_TYPES, required: true },
    targetId: { type: Schema.Types.ObjectId, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
    ipAddress: { type: String },
  },
  // createdAt only — no updatedAt on an append-only, never-updated log.
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Backs the admin timeline's default (newest-first) query and the
// action/actor filters narrowing it — mirrors Notification.ts's
// recipient/read/createdAt compound index reasoning, tuned to this model's
// own primary query shape instead.
auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ actor: 1, createdAt: -1 });

export const AuditLog = mongoose.model<IAuditLog>("AuditLog", auditLogSchema);
