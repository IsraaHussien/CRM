import express, { Request, Response, NextFunction } from "express";
import { z } from "zod";
import mongoose from "mongoose";
import { requireAuth, requirePermission } from "../middleware/auth";
import { hasPermission, isActiveAccount } from "../services/permissions";
import type { PermissionKey } from "../constants/permissions";
import { TicketCategory, ITicketCategory } from "../models/TicketCategory";
import { validateBody } from "../middleware/validate";
import { createTicketCategoryBodySchema, updateTicketCategoryBodySchema } from "../validation/ticketCategory.schema";
import { recordAuditLog } from "../services/auditLog.service";

const router = express.Router();

function toCategoryResponse(category: ITicketCategory) {
  return {
    id: category.id,
    name: category.name,
    active: category.active,
    createdAt: category.createdAt,
    updatedAt: category.updatedAt,
  };
}

// Case-insensitive lookup matching the model's collation-aware unique
// index — used on both create (new name) and rename (name changing).
export function findByNameCaseInsensitive(name: string, excludeId?: string) {
  const filter: Record<string, unknown> = { name };
  if (excludeId) filter._id = { $ne: excludeId };
  return TicketCategory.findOne(filter).collation({ locale: "en", strength: 2 });
}

// GET /?active=true is consumed by the ticket-submission forms (Story 8/57)
// for ANY authenticated customer/staff — a plain picklist read, no admin
// significance, so it must stay permission-free. Only the admin surface's
// full-list view (default, includes inactive rows) requires
// tickets:categories_view.
function viewListOrActiveOnly(key: PermissionKey) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.query.active === "true") {
      next();
      return;
    }
    requirePermission(key)(req, res, next);
  };
}

// Admin-implicit-pass + live DB check, for the PATCH handler below where the
// required key depends on WHICH fields are being changed in this specific
// request (rename vs. toggle-status vs. both) — can't be a single fixed
// route-level requirePermission. Mirrors ticket.routes.ts's
// customerOrPermitted / admin.routes.ts's canManageTarget reasoning: calling
// hasPermission directly would incorrectly reject admin, whose permissions
// array is normally empty.
async function callerHasPermission(req: Request, key: PermissionKey): Promise<boolean> {
  if (req.user!.role === "admin") return isActiveAccount(req.user!.id);
  return hasPermission(req.user!.id, key);
}

// Story 58: admin-editable ticket category list backing Story 9's
// categorize-a-ticket picker and Story 57's staff-create-for-customer form
// (neither is wired up to this list yet — that's their own job). Every
// distinct action here has its own permission key (view/create/edit/
// toggle-status) rather than one umbrella key — see
// [[feedback_granular_action_permissions]].
router.get(
  "/",
  requireAuth,
  viewListOrActiveOnly("tickets:categories_view"),
  async (req: Request, res: Response) => {
    const filter = req.query.active === "true" ? { active: true } : {};
    const categories = await TicketCategory.find(filter).sort({ name: 1 });
    res.status(200).json(categories.map(toCategoryResponse));
  }
);

router.post(
  "/",
  requireAuth,
  requirePermission("tickets:categories_create"),
  validateBody(createTicketCategoryBodySchema),
  async (req: Request<unknown, unknown, z.infer<typeof createTicketCategoryBodySchema>>, res: Response) => {
    const { name } = req.body;

    const existing = await findByNameCaseInsensitive(name);
    if (existing) {
      if (!existing.active) {
        res
          .status(409)
          .json({ error: "A category with that name exists but is inactive. Reactivate it instead." });
        return;
      }
      res.status(409).json({ error: "A category with that name already exists." });
      return;
    }

    let category;
    try {
      category = await TicketCategory.create({ name });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        res.status(409).json({ error: "A category with that name already exists." });
        return;
      }
      throw err;
    }

    await recordAuditLog({
      actor: req.user!.id,
      action: "ticket_category_created",
      targetType: "TicketCategory",
      targetId: category.id,
      metadata: { name: category.name },
      ipAddress: req.ip,
    });

    res.status(201).json(toCategoryResponse(category));
  }
);

router.patch(
  "/:id",
  requireAuth,
  async (req: Request<{ id: string }>, res: Response) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      res.status(404).json({ error: "Category not found" });
      return;
    }
    const category = await TicketCategory.findById(req.params.id);
    if (!category) {
      res.status(404).json({ error: "Category not found" });
      return;
    }

    const parsed = updateTicketCategoryBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
      return;
    }
    const { name, active } = parsed.data;

    if (name !== undefined && !(await callerHasPermission(req, "tickets:categories_edit"))) {
      res.status(403).json({ error: "You do not have permission to perform this action" });
      return;
    }
    if (active !== undefined && !(await callerHasPermission(req, "tickets:categories_toggle_status"))) {
      res.status(403).json({ error: "You do not have permission to perform this action" });
      return;
    }

    const changes: Record<string, { before: unknown; after: unknown }> = {};

    if (name !== undefined) {
      const existing = await findByNameCaseInsensitive(name, category.id);
      if (existing) {
        res.status(409).json({ error: "A category with that name already exists." });
        return;
      }
      if (name !== category.name) {
        changes.name = { before: category.name, after: name };
        category.name = name;
      }
    }

    if (active !== undefined && active !== category.active) {
      changes.active = { before: category.active, after: active };
      category.active = active;
    }

    await category.save();

    if (Object.keys(changes).length > 0) {
      await recordAuditLog({
        actor: req.user!.id,
        action: "ticket_category_updated",
        targetType: "TicketCategory",
        targetId: category.id,
        metadata: { changes },
        ipAddress: req.ip,
      });
    }

    res.status(200).json(toCategoryResponse(category));
  }
);

export default router;
