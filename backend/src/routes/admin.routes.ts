import express, { Request, Response } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { requireAuth, requireRole, requirePermission } from "../middleware/auth";
import { User, IUser, UserRole } from "../models/User";
import { hasPermission, isActiveAccount } from "../services/permissions";
import { PermissionKey, permissionKeysAllowedForRole } from "../constants/permissions";
import { validateBody, validateParams } from "../middleware/validate";
import {
  staffIdParamsSchema,
  createStaffAccountBodySchema,
  listStaffAccountsQuerySchema,
  updateStaffAccountBodySchema,
} from "../validation/admin.schema";
import { escapeRegex } from "../utils/regex";
import { recordAuditLog } from "../services/auditLog.service";

const router = express.Router();

const BCRYPT_SALT_ROUNDS = 10;

// Valid roster/deactivation/edit/delete TARGETS — includes "admin" because
// admin accounts exist (DB-provisioned, see backend/scripts/seed-admin.ts)
// and must be visible/actionable here, even though they can't be CREATED
// through this router.
const STAFF_ROLES: UserRole[] = ["agent", "admin", "subadmin"];

function toStaffAccountResponse(user: IUser) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    membershipNumber: user.membershipNumber,
    role: user.role,
    isActive: user.isActive,
    isOnline: user.isOnline,
    permissions: user.permissions,
    createdAt: user.createdAt,
  };
}

// `targetRole` is the role the account HAS (edit) or WILL HAVE (create,
// when changing role) — a subadmin-only permission is never valid on an
// agent, checked here as well as filtered out client-side, since the UI
// restriction alone isn't a real boundary. The shape of `permissions`
// (array of valid permission-key strings) is already enforced by
// createStaffAccountBodySchema/updateStaffAccountBodySchema — this only
// covers the cross-field rule those schemas can't express on their own.
function permissionsAllowedForTargetRole(permissions: PermissionKey[], targetRole: UserRole): boolean {
  if (targetRole !== "agent") return true;
  const allowed = permissionKeysAllowedForRole("agent");
  return permissions.every((k) => allowed.includes(k));
}

// Shared by every action below whose real permission decision depends on
// the TARGET's role, not just the caller's — the target isn't known until
// the document loads, so this can't be plain route-level middleware.
// Returns true if the caller (req.user) is allowed to perform `requiredKey`
// on `target` — e.g. "staff:edit" for PATCH, "staff:delete" for DELETE.
async function canManageTarget(
  callerId: string,
  callerRole: UserRole,
  target: IUser,
  requiredKey: PermissionKey
): Promise<boolean> {
  // Same isActive re-check as customer.routes.ts's isFullStaffViewer/
  // staffOrDelegatedSubadmin — an admin bypasses the permission-key check
  // itself, but a deactivated admin's still-unexpired token must not.
  if (callerRole === "admin") return isActiveAccount(callerId);
  if (target.role === "admin") return false; // hard cap — never delegable, see Story 46
  return hasPermission(callerId, requiredKey);
}

// security-admin Story 46: a sub-admin delegated agent/sub-admin account
// management needs to see the roster to act on it — admin always passes via
// requirePermission's own short-circuit. Excludes soft-deleted accounts.
// Filters/search (`q`, `role`, `isActive`, `isOnline`, `sort`) added at the
// user's direct request, mirroring ticket.routes.ts's GET /'s server-driven
// filter pattern — `role` narrows within STAFF_ROLES rather than replacing
// the roster scope, so it can never be used to escalate past it.
router.get(
  "/",
  requireAuth,
  requireRole("agent", "admin", "subadmin"),
  requirePermission("staff:view_list"),
  async (req: Request, res: Response) => {
    const parsed = listStaffAccountsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid query" });
      return;
    }
    const { page, limit, q, role, isActive, isOnline, sort } = parsed.data;
    const skip = (page - 1) * limit;

    const filter: Record<string, unknown> = {
      role: role ?? { $in: STAFF_ROLES },
      isDeleted: { $ne: true },
    };
    if (isActive !== undefined) filter.isActive = isActive === "true";
    if (isOnline !== undefined) filter.isOnline = isOnline === "true";
    if (q) {
      const regex = new RegExp(escapeRegex(q), "i");
      filter.$or = [{ name: regex }, { email: regex }, { membershipNumber: regex }];
    }

    let sortSpec: Record<string, 1 | -1> = { createdAt: -1 };
    if (sort) {
      const descending = sort.startsWith("-");
      const key = (descending ? sort.slice(1) : sort) as "createdAt" | "name";
      sortSpec = { [key]: descending ? -1 : 1 };
    }

    const [users, total] = await Promise.all([
      User.find(filter)
        .select("name email membershipNumber role isActive isOnline permissions createdAt")
        .sort(sortSpec)
        .skip(skip)
        .limit(limit),
      User.countDocuments(filter),
    ]);

    res.status(200).json({
      users: users.map(toStaffAccountResponse),
      total,
      page,
      limit,
    });
  }
);

// Single-account detail — used by the frontend's edit stepper to prefill
// without refetching the whole paginated roster.
router.get(
  "/:id",
  requireAuth,
  requireRole("agent", "admin", "subadmin"),
  requirePermission("staff:view_account"),
  validateParams(staffIdParamsSchema),
  async (req: Request, res: Response) => {
    const user = await User.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
    if (!user || !STAFF_ROLES.includes(user.role)) {
      res.status(404).json({ error: "Account not found" });
      return;
    }
    res.status(200).json(toStaffAccountResponse(user));
  }
);

router.post(
  "/",
  requireAuth,
  requireRole("agent", "admin", "subadmin"),
  // No admin-target cap needed on this route — createStaffAccountBodySchema's
  // role enum already excludes "admin" entirely, so there is nothing here
  // for a delegated sub-admin to escalate into.
  requirePermission("staff:edit"),
  validateBody(createStaffAccountBodySchema),
  async (req: Request<unknown, unknown, z.infer<typeof createStaffAccountBodySchema>>, res: Response) => {
    const { name, email, password, role, permissions = [] } = req.body;

    if (!permissionsAllowedForTargetRole(permissions, role)) {
      res.status(400).json({ error: "permissions must be an array of valid permission keys" });
      return;
    }

    const existing = await User.findOne({ email });
    if (existing) {
      res.status(409).json({ error: "An account with this email already exists" });
      return;
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);

    let user;
    try {
      user = await User.create({
        name,
        email,
        passwordHash,
        role,
        permissions,
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        res.status(409).json({ error: "An account with this email already exists" });
        return;
      }
      throw err;
    }

    await recordAuditLog({
      actor: req.user!.id,
      action: "staff_created",
      targetType: "User",
      targetId: user.id,
      metadata: { role: user.role, email: user.email },
      ipAddress: req.ip,
    });

    res.status(201).json(toStaffAccountResponse(user));
  }
);

// Edit an existing agent/sub-admin account (name/email/role/permissions).
// Admin accounts are never editable here — same DB-only boundary as creation.
router.patch(
  "/:id",
  requireAuth,
  requireRole("agent", "admin", "subadmin"),
  validateParams(staffIdParamsSchema),
  async (req: Request<{ id: string }>, res: Response) => {
    const user = await User.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
    if (!user || !STAFF_ROLES.includes(user.role)) {
      res.status(404).json({ error: "Account not found" });
      return;
    }
    if (user.role === "admin") {
      res.status(400).json({ error: "Admin accounts cannot be edited here" });
      return;
    }

    const parsed = updateStaffAccountBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
      return;
    }
    const { name, email, role, permissions: permissionsInput } = parsed.data;

    const editingDetails = name !== undefined || email !== undefined || role !== undefined;
    const editingPermissions = permissionsInput !== undefined;
    if (
      (editingDetails && !(await canManageTarget(req.user!.id, req.user!.role, user, "staff:edit"))) ||
      (editingPermissions && !(await canManageTarget(req.user!.id, req.user!.role, user, "staff:permissions")))
    ) {
      res.status(403).json({ error: "You do not have permission to perform this action" });
      return;
    }

    const resultingRole = role ?? user.role;
    if (permissionsInput !== undefined && !permissionsAllowedForTargetRole(permissionsInput, resultingRole)) {
      res.status(400).json({ error: "permissions must be an array of valid permission keys" });
      return;
    }

    const detailChanges: Record<string, { before: unknown; after: unknown }> = {};
    if (name !== undefined && name !== user.name) {
      detailChanges.name = { before: user.name, after: name };
      user.name = name;
    }
    if (email !== undefined && email !== user.email) {
      detailChanges.email = { before: user.email, after: email };
      user.email = email;
    }
    if (role !== undefined && role !== user.role) {
      detailChanges.role = { before: user.role, after: role };
      user.role = role;
    }
    // Captured before the assignment below so the audit entry (if any) can
    // carry a before/after diff — security-admin Story 47's prioritized
    // proof-of-pattern wiring point ("who can now do what").
    const previousPermissions = user.permissions;
    if (permissionsInput !== undefined) {
      user.permissions = permissionsInput;
    }

    try {
      await user.save();
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        res.status(409).json({ error: "An account with this email already exists" });
        return;
      }
      throw err;
    }

    if (Object.keys(detailChanges).length > 0) {
      await recordAuditLog({
        actor: req.user!.id,
        action: "staff_updated",
        targetType: "User",
        targetId: user.id,
        metadata: { changes: detailChanges },
        ipAddress: req.ip,
      });
    }

    if (editingPermissions) {
      await recordAuditLog({
        actor: req.user!.id,
        action: "permissions_changed",
        targetType: "User",
        targetId: user.id,
        metadata: { before: previousPermissions, after: user.permissions },
        ipAddress: req.ip,
      });
    }

    res.status(200).json(toStaffAccountResponse(user));
  }
);

async function setActiveState(req: Request, res: Response, isActive: boolean) {
  const user = await User.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
  if (!user || !STAFF_ROLES.includes(user.role)) {
    res.status(404).json({ error: "Account not found" });
    return;
  }

  // security-admin Story 46's cap: acting on an existing "admin" account
  // always requires a true admin, regardless of staff:toggle_status — a
  // delegated sub-admin (or a granted agent) can never disable/enable a
  // higher-privileged account. Acting on an agent/subadmin target is
  // delegable via staff:toggle_status, same as create/roster above.
  if (!(await canManageTarget(req.user!.id, req.user!.role, user, "staff:toggle_status"))) {
    res.status(403).json({ error: "You do not have permission to perform this action" });
    return;
  }

  user.isActive = isActive;
  if (user.role === "agent" && !isActive) {
    user.isOnline = false;
  }
  await user.save();

  // security-admin Story 47's third proof-of-pattern wiring point — this
  // one shared function backs both PATCH /:id/activate and
  // PATCH /:id/deactivate, so wiring it once here covers both directions.
  await recordAuditLog({
    actor: req.user!.id,
    action: isActive ? "staff_activated" : "staff_deactivated",
    targetType: "User",
    targetId: user.id,
    ipAddress: req.ip,
  });

  res.status(200).json(toStaffAccountResponse(user));
}

router.patch(
  "/:id/deactivate",
  requireAuth,
  // The target's role isn't known until the document loads, so the real
  // permission decision happens INSIDE setActiveState — this just filters
  // out callers who could never pass either branch.
  requireRole("agent", "admin", "subadmin"),
  validateParams(staffIdParamsSchema),
  (req: Request, res: Response) => setActiveState(req, res, false)
);

router.patch(
  "/:id/activate",
  requireAuth,
  requireRole("agent", "admin", "subadmin"),
  validateParams(staffIdParamsSchema),
  (req: Request, res: Response) => setActiveState(req, res, true)
);

// Soft delete — hides the account from the roster and locks it out
// entirely, but keeps the document for referential integrity (past ticket
// assignments, audit log entries). No restore action exists yet.
router.delete(
  "/:id",
  requireAuth,
  requireRole("agent", "admin", "subadmin"),
  validateParams(staffIdParamsSchema),
  async (req: Request, res: Response) => {
    const user = await User.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
    if (!user || !STAFF_ROLES.includes(user.role)) {
      res.status(404).json({ error: "Account not found" });
      return;
    }

    if (!(await canManageTarget(req.user!.id, req.user!.role, user, "staff:delete"))) {
      res.status(403).json({ error: "You do not have permission to perform this action" });
      return;
    }

    user.isDeleted = true;
    user.isActive = false;
    if (user.role === "agent") {
      user.isOnline = false;
    }
    await user.save();

    await recordAuditLog({
      actor: req.user!.id,
      action: "staff_deleted",
      targetType: "User",
      targetId: user.id,
      metadata: { role: user.role, email: user.email },
      ipAddress: req.ip,
    });

    res.status(204).send();
  }
);

export default router;
