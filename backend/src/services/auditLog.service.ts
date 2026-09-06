import { AuditLog, AuditAction, AuditTargetType, AUDIT_ACTION_CATEGORY } from "../models/AuditLog";

interface RecordAuditLogParams {
  actor: string | null;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}

// security-admin Story 47: the one place that writes AuditLog documents —
// every call site (auth.routes.ts login, admin.routes.ts permission
// changes/status toggles) calls this directly and `await`s it, same
// fire-after-the-fact pattern as notification.service.ts's
// notifyTicketOversight. Swallows its own errors (logged, not thrown) so a
// transient audit-write failure can never break the login/permission-change
// flow it's observing — the primary action has already succeeded by the
// time this runs.
export async function recordAuditLog(params: RecordAuditLogParams): Promise<void> {
  try {
    await AuditLog.create({
      actor: params.actor,
      action: params.action,
      category: AUDIT_ACTION_CATEGORY[params.action],
      targetType: params.targetType,
      targetId: params.targetId ?? null,
      metadata: params.metadata ?? {},
      ipAddress: params.ipAddress,
    });
  } catch (err) {
    console.error("[auditLog] failed to record entry", params.action, err);
  }
}
