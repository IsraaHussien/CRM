import express, { Request, Response } from "express";
import mongoose from "mongoose";
import { requireAuth, requirePermission } from "../middleware/auth";
import { hasPermission, isActiveAccount } from "../services/permissions";
import type { PermissionKey } from "../constants/permissions";
import { SlaTarget, ISlaTarget } from "../models/SlaTarget";
import { SlaTargetHistory, ISlaTargetSnapshot } from "../models/SlaTargetHistory";
import { SlaSystemSettings, getSlaSystemSettings } from "../models/SlaSystemSettings";
import { validateBody } from "../middleware/validate";
import {
  createSlaTargetBodySchema,
  updateSlaTargetBodySchema,
  updateSlaSystemSettingsBodySchema,
} from "../validation/slaTarget.schema";
import { recordAuditLog } from "../services/auditLog.service";

const router = express.Router();

const DUPLICATE_TARGET_ERROR = "An SLA target with that priority and category already exists.";

function toResponse(target: ISlaTarget) {
  return {
    id: target.id,
    priority: target.priority,
    category: target.category,
    responseMinutes: target.responseMinutes,
    resolutionMinutes: target.resolutionMinutes,
    isDefault: target.priority === null && target.category === null,
    createdAt: target.createdAt,
    updatedAt: target.updatedAt,
  };
}

function snapshot(target: ISlaTarget): ISlaTargetSnapshot {
  return {
    priority: target.priority,
    category: target.category,
    responseMinutes: target.responseMinutes,
    resolutionMinutes: target.resolutionMinutes,
  };
}

// Admin-implicit-pass + live DB check — mirrors ticketCategory.routes.ts's
// callerHasPermission exactly. Calling hasPermission directly would
// incorrectly reject admin, whose permissions array is normally empty.
async function callerHasPermission(req: Request, key: PermissionKey): Promise<boolean> {
  if (req.user!.role === "admin") return isActiveAccount(req.user!.id);
  return hasPermission(req.user!.id, key);
}

// sla-automation Story 25 ("define SLA targets"): admin-editable
// (priority, category) -> (responseMinutes, resolutionMinutes) lookup rows
// that Story 26 ("track SLA timers") consults when a Ticket/Conversation is
// created. Category is stored as a name string snapshot, matching how
// Ticket.category works (backend/src/models/TicketCategory.ts) — renaming a
// category does NOT cascade to existing SlaTarget rows; an admin must
// update them manually.
router.get("/", requireAuth, requirePermission("sla:targets_view"), async (_req: Request, res: Response) => {
  const targets = await SlaTarget.find().sort({ priority: 1, category: 1 });
  res.status(200).json(targets.map(toResponse));
});

// Registered before "/:id" so Express doesn't try to match "history" as an id.
router.get("/history", requireAuth, requirePermission("sla:targets_view"), async (_req: Request, res: Response) => {
  const entries = await SlaTargetHistory.find()
    .sort({ changedAt: -1 })
    .limit(200)
    .populate("changedBy", "name email role");
  res.status(200).json(
    entries.map((e) => ({
      id: e.id,
      target: e.target.toString(),
      action: e.action,
      before: e.before,
      after: e.after,
      changedBy: e.changedBy,
      changedAt: e.changedAt,
    }))
  );
});

// sla-automation Story 27's monitor tuning — a singleton config row, not an
// auditable per-priority/category lookup like SlaTarget, so no history
// write here. Gated on sla:configure (distinct from sla:targets_view/edit),
// finally putting that long-reserved permission key to use. Registered
// before "/:id" for the same reason as "/history" above.
router.get("/settings", requireAuth, requirePermission("sla:configure"), async (_req: Request, res: Response) => {
  const settings = await getSlaSystemSettings();
  res.status(200).json(settings);
});

router.patch(
  "/settings",
  requireAuth,
  requirePermission("sla:configure"),
  validateBody(updateSlaSystemSettingsBodySchema),
  async (req: Request, res: Response) => {
    const before = await getSlaSystemSettings();
    const updated = await SlaSystemSettings.findByIdAndUpdate(
      "default",
      { $set: req.body, updatedBy: req.user!.id },
      { upsert: true, new: true }
    );

    await recordAuditLog({
      actor: req.user!.id,
      action: "sla_settings_updated",
      targetType: "SlaSystemSettings",
      targetId: "default",
      metadata: { before, after: { atRiskPercent: updated!.atRiskPercent, scanIntervalMinutes: updated!.scanIntervalMinutes } },
      ipAddress: req.ip,
    });

    res.status(200).json({ atRiskPercent: updated!.atRiskPercent, scanIntervalMinutes: updated!.scanIntervalMinutes });
  }
);

router.post(
  "/",
  requireAuth,
  requirePermission("sla:targets_edit"),
  validateBody(createSlaTargetBodySchema),
  async (req: Request, res: Response) => {
    let target;
    try {
      target = await SlaTarget.create(req.body);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        res.status(409).json({ error: DUPLICATE_TARGET_ERROR });
        return;
      }
      throw err;
    }

    await SlaTargetHistory.create({
      target: target._id,
      action: "create",
      before: null,
      after: snapshot(target),
      changedBy: req.user!.id,
      changedAt: new Date(),
    });

    await recordAuditLog({
      actor: req.user!.id,
      action: "sla_target_created",
      targetType: "SlaTarget",
      targetId: target.id,
      metadata: { after: snapshot(target) },
      ipAddress: req.ip,
    });

    res.status(201).json(toResponse(target));
  }
);

router.patch("/:id", requireAuth, async (req: Request<{ id: string }>, res: Response) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404).json({ error: "SLA target not found" });
    return;
  }
  if (!(await callerHasPermission(req, "sla:targets_edit"))) {
    res.status(403).json({ error: "You do not have permission to perform this action" });
    return;
  }

  const target = await SlaTarget.findById(req.params.id);
  if (!target) {
    res.status(404).json({ error: "SLA target not found" });
    return;
  }

  const parsed = updateSlaTargetBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
    return;
  }
  const { priority, category, responseMinutes, resolutionMinutes } = parsed.data;

  const isDefaultRow = target.priority === null && target.category === null;
  const wouldLeaveDefault =
    (priority !== undefined && priority !== null) || (category !== undefined && category !== null);
  if (isDefaultRow && wouldLeaveDefault) {
    res.status(400).json({ error: "The default SLA target must remain (priority=null, category=null)." });
    return;
  }

  const before = snapshot(target);

  if (priority !== undefined) target.priority = priority;
  if (category !== undefined) target.category = category;
  if (responseMinutes !== undefined) target.responseMinutes = responseMinutes;
  if (resolutionMinutes !== undefined) target.resolutionMinutes = resolutionMinutes;

  try {
    await target.save();
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      res.status(409).json({ error: DUPLICATE_TARGET_ERROR });
      return;
    }
    throw err;
  }

  await SlaTargetHistory.create({
    target: target._id,
    action: "update",
    before,
    after: snapshot(target),
    changedBy: req.user!.id,
    changedAt: new Date(),
  });

  await recordAuditLog({
    actor: req.user!.id,
    action: "sla_target_updated",
    targetType: "SlaTarget",
    targetId: target.id,
    metadata: { before, after: snapshot(target) },
    ipAddress: req.ip,
  });

  res.status(200).json(toResponse(target));
});

router.delete("/:id", requireAuth, async (req: Request<{ id: string }>, res: Response) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404).json({ error: "SLA target not found" });
    return;
  }
  if (!(await callerHasPermission(req, "sla:targets_edit"))) {
    res.status(403).json({ error: "You do not have permission to perform this action" });
    return;
  }

  const target = await SlaTarget.findById(req.params.id);
  if (!target) {
    res.status(404).json({ error: "SLA target not found" });
    return;
  }

  if (target.priority === null && target.category === null) {
    res.status(400).json({ error: "The default SLA target cannot be deleted." });
    return;
  }

  const before = snapshot(target);
  const targetId = target.id;
  await target.deleteOne();

  await SlaTargetHistory.create({
    target: target._id,
    action: "delete",
    before,
    after: null,
    changedBy: req.user!.id,
    changedAt: new Date(),
  });

  await recordAuditLog({
    actor: req.user!.id,
    action: "sla_target_deleted",
    targetType: "SlaTarget",
    targetId,
    metadata: { before },
    ipAddress: req.ip,
  });

  res.status(204).send();
});

export default router;
