# Story 34 — Review audit logs

---

## Prerequisites

- `.squad/plans/security-admin/08-story-manage-user-accounts.md` completed: `backend/src/models/User.ts`'s `role` enum includes `subadmin`, and `backend/src/routes/admin.routes.ts` exposes the staff roster/create/edit/deactivate/delete endpoints this story wires into.
- `.squad/plans/security-admin/09-story-configure-roles-and-permissions.md` completed: `backend/src/constants/permissions.ts` defines `PERMISSION_KEYS`/`SUBADMIN_ONLY_PERMISSIONS`, and `backend/src/middleware/auth.ts`'s `requirePermission` + `backend/src/services/permissions.ts`'s `hasPermission`/`isActiveAccount` exist. `audit:view` is already present in both `PERMISSION_KEYS` (permissions.ts line 20) and `SUBADMIN_ONLY_PERMISSIONS` (line 67) — this only means an **agent** account can never be granted it (staff/system-administration tier), not that subadmins are excluded; a subadmin explicitly granted it, or any admin, passes `requirePermission("audit:view")`. No change needed to that file.
- **Reconciliation note (intake "Dependencies"):** `backend/src/models/Ticket.ts`'s `statusHistory` (an embedded `{ status, changedBy, changedAt }[]`, see lines 13-17/32-36) is exactly the "bespoke history array" the intake flags for reconciliation. Do **not** migrate or remove it in this story — `Ticket.routes.ts` is explicitly out of bounds for this work (owned by parallel `ticket-management`/`live-chat` work happening in a sibling worktree). Leave a decision, not silence: the intake's "reconcile explicitly" is satisfied by this plan documenting the conflict here and by this story's own `AuditLog` model being the ONE model any future consolidation should converge on — `statusHistory` stays a separate, narrower mechanism for now.

## Story Goal

An admin or a subadmin holding `audit:view` can see a read-only, filterable log of key staff actions:

1. A new `AuditLog` model, written only from server-side call sites (no create/update/delete HTTP surface at all — the intake's chosen enforcement for "cannot be edited or deleted by regular users").
2. A single `GET /api/v1/admin/audit-logs` endpoint, gated by `requirePermission("audit:view")`, supporting pagination, a free-text search across actor name/email (via the app's existing `q` convention), an `action` (category) filter, and a `dateFrom`/`dateTo` range over `createdAt`.
3. Proof-of-pattern wiring into 3 already-built call sites, matching the intake's prioritized list:
   - `POST /auth/login` (`backend/src/routes/auth.routes.ts`) — both the success path and every rejection path (unknown email, wrong password, deactivated account) — categorized under `"auth"`.
   - `PATCH /api/v1/admin/users/:id` when `permissionsInput !== undefined` (`backend/src/routes/admin.routes.ts`) — categorized under `"permissions"`. Prioritized per the intake ("who can now do what" is the centerpiece case).
   - `setActiveState` (deactivate **and** activate — same shared function, both directions of the one proof-of-pattern call site) in `admin.routes.ts` — categorized under `"staff"`.
4. A new admin page, `frontend/app/admin/audit-logs/page.tsx`, implementing the already-chosen **Option B "grouped-by-day timeline"** UI: entries clustered under date headers (Today / Yesterday / explicit older dates) on a left rail, each row showing time + actor + a short human-readable action line. A filter bar above follows this app's standard list-view pattern (server-driven params, `ListPagination`, a `q` search wired through `HeaderSearch`, and a Reset button in its own row below the filter/sort wrap, styled destructive-ghost — see `frontend/app/admin/users/AdminUsersFilterBar.tsx`, the closest precedent, over `TicketFilterBar.tsx`'s full-screen-dialog variant).

**Explicitly not in scope** (per intake "Out of scope" and this story's own boundary): retrofitting audit logging into any other mutation (ticket edits/reassignment, KB publishing, SLA config, etc.) beyond the 3 call sites above; System configuration (Story 48, separate); any update/delete endpoint for `AuditLog`.

## Product rules (from story)

- **Read-only, no mutation endpoints.** No `POST`/`PATCH`/`DELETE` route is added for `AuditLog` at all — internal code calls the write helper directly.
- **`actor` is nullable.** A failed login against an email that doesn't resolve to any `User` document has no real actor to reference — store `actor: null` and put the attempted email in `metadata.attemptedEmail` instead of inventing a placeholder ObjectId.
- **`ipAddress` is optional**, captured from `req.ip` where available (Express's own proxy-aware accessor) — no additional trust-proxy configuration is in scope; a `undefined` value is expected and acceptable behind certain proxy configs.
- **Actor identity is resolved by live populate on read**, not a denormalized snapshot — this matches `Ticket.statusHistory`'s existing convention (`changedBy: Types.ObjectId` populated at read time, not a name/email copy stored at write time). If a referenced `User` is later renamed, the audit row will show the current name — accepted, same staleness the existing `statusHistory` pattern already has.

---

## Context — Read These Files First

1. `backend/src/constants/permissions.ts` — confirm `"audit:view"` at line 20 (`PERMISSION_KEYS`) and line 67 (`SUBADMIN_ONLY_PERMISSIONS`) exist exactly as described above. Do not edit this file.
2. `backend/src/middleware/auth.ts` — `requirePermission` (lines 93-118): `admin` role always passes (after a live `isActiveAccount` check); `agent`/`subadmin` need a live `hasPermission(req.user.id, key)` DB check; anything else is rejected. Use `requirePermission("audit:view")` verbatim on the new GET route.
3. `backend/src/routes/admin.routes.ts` — read in full (338 lines). Two edit points:
   - Inside the `router.patch("/:id", ...)` handler (~lines 196-260): after `await user.save()` succeeds (line 249) and only `if (editingPermissions)` (the existing local `const editingPermissions = permissionsInput !== undefined;` at line 220), record an audit entry. Capture the **previous** permissions array before the `if (permissionsInput !== undefined) { user.permissions = permissionsInput; }` assignment (line 244-246) so `metadata` can carry `{ before, after }`.
   - Inside `setActiveState` (~lines 262-286): after `await user.save()` (line 283), record an audit entry using the `isActive` boolean parameter already passed into the function to pick the action (`staff_activated` vs `staff_deactivated`) — this one shared function covers both `PATCH /:id/activate` and `PATCH /:id/deactivate` (lines 288-305), so wiring it once here covers both routes.
4. `backend/src/routes/auth.routes.ts` — the `POST /login` handler (lines 106-153). Three outcomes to log: (a) `!user` → unknown email, actor `null`, `metadata.attemptedEmail`; (b) `!passwordOk` → wrong password, actor is the resolved `user._id`; (c) `!user.isActive` → deactivated-account login attempt, actor is the resolved `user._id`; (d) success, right before/after the existing `res.status(200).json(...)` at line 148-152, actor is `user._id`. Use the same generic `"login_failed"` action for (a)/(b)/(c) with a `metadata.reason` distinguishing them (`"unknown_email"` / `"wrong_password"` / `"account_deactivated"`), and `"login_success"` for (d) — keeps the `action` filter's option list short while `metadata.reason` still lets an investigator tell them apart. Capture `req.ip` at the top of the handler once and reuse it in every branch.
5. `backend/src/models/User.ts` (lines 1-50 read) — `UserRole` type, `IUser.role`/`.name`/`.email`. Reference for `AuditLog.actor`'s `ref: "User"`.
6. `backend/src/models/Ticket.ts` (lines 1-75 read) — `ITicketStatusHistoryEntry`/`statusHistory` field: the precedent for "ObjectId ref, populate at read time, no denormalized snapshot" that `AuditLog.actor` should follow, and the exact array/schema this story deliberately leaves untouched (see Prerequisites reconciliation note).
7. `backend/src/models/Notification.ts` — precedent for a small, purpose-built Mongoose model with a `type` string-enum field and a compound index tuned to its own primary query (`{ recipient: 1, read: 1, createdAt: -1 }`); `AuditLog` needs an analogous index for its own primary query (`createdAt` descending, with `action`/`actor` narrowing).
8. `backend/src/validation/common.ts` — `paginationQuerySchema` (page/limit, default limit 10, max 100), `flexibleDateSchema()` (accepts a plain `YYYY-MM-DD` or an offset ISO datetime — reuse this for `dateFrom`/`dateTo`, don't write a new date schema), `objectIdSchema`.
9. `backend/src/validation/admin.schema.ts` — `listStaffAccountsQuerySchema` (lines 17-29): the pattern to copy for the new `listAuditLogsQuerySchema` (extends `paginationQuerySchema`, adds `q`, an enum filter, and here also a date range).
10. `backend/src/routes/ticket.routes.ts` lines 278-320 — the `createdFrom`/`createdTo` → `filter.createdAt = { $gte, $lte }` pattern (with `new Date(dateString)`) and the `escapeRegex(q)` text-search pattern (`import { escapeRegex } from "../utils/regex"`). Copy both verbatim for the new route's `dateFrom`/`dateTo` and `q`.
11. `backend/src/services/notification.service.ts` (lines 9, 29 — the two exported function signatures) and its call sites in `backend/src/routes/ticket.routes.ts` (e.g. line 170 `await notifyTicketOversight({ type: ..., ticketId: ... })`) — the precedent for a small service module exporting an async "record this event" function, called with `await` directly after the mutation that triggered it, params passed as one object. Follow this shape for the new `backend/src/services/auditLog.service.ts`.
12. `backend/src/app.ts` (full file, 42 lines) — router mounting list (lines 22-29). Add the new router here, following the existing `/api/v1/admin/users` mounting pattern (line 29) with its own path segment.
13. `backend/tests/routes/admin.routes.test.ts` (lines 1-93 read) — test scaffolding pattern: `MongoMemoryServer`, `tokenFor({ id, role })` (note: the JWT here carries only `sub`/`role`, no `permissions` claim — `requirePermission` for `agent`/`subadmin` always does a live DB lookup via `hasPermission`, never trusts the token's `permissions` claim, so tests granting permissions must set `User.permissions` in the DB, not the token), `seedUser(overrides)`. Copy this scaffold for the new `backend/tests/routes/audit.routes.test.ts`.
14. `frontend/app/admin/users/page.tsx` (full file, 243 lines) — the closest full precedent for an admin list page: cookie/token read, `_refreshed` silent-refresh redirect loop guard (lines 73-94), 403→`/dashboard` redirect (lines 96-101, matches `feedback_dashboard_tiles_disabled_not_hidden` in spirit — a nav item without the permission is never shown, per `staffNav.ts`, so reaching the page and being turned away is expected to be rare, not a dead-end message), `hrefForPage`, `ListPagination` usage, `generateMetadata` with `robots: { index: false, follow: false }`.
15. `frontend/app/admin/users/AdminUsersFilterBar.tsx` (full file, 150 lines) — the exact filter-bar shape to copy: `FilterField`-wrapped `Select`s, `updateParam`/`clearSearch` URL-param helpers, the Reset row at lines 132-146 (own `<div>` below the filters `flex-wrap`, `variant="ghost"` + `text-destructive hover:bg-destructive/10 hover:text-destructive`, `X` icon + `resetFilters` label) — this is the convention to follow, not `TicketFilterBar.tsx`'s full-screen dialog variant (a different, earlier-superseded UI direction for a different list).
16. `frontend/components/DatePickerField.tsx` (lines 1-40 read) and its usage in `frontend/app/tickets/TicketFilterBar.tsx` lines 282-336 — themed date-range picker pair (`from`/`to`), `format(value, "yyyy-MM-dd")` on change.
17. `frontend/components/ListPagination.tsx` (full file) and `frontend/components/FilterField.tsx` (full file) — reuse both directly, no changes needed.
18. `frontend/components/HeaderSearch.tsx` (full file, 153 lines) — `PAGE_SEARCH_TARGETS` (lines 15-19): add `"/admin/audit-logs": "searchAuditLogsFor"` so the header's `q`-search-this-page action appears on the new page, exactly like `/admin/users`.
19. `frontend/lib/staffNav.ts` (full file) — `STAFF_NAV_ITEMS` (lines 20-26): add an `"auditLog"` entry, `permission: "audit:view"`, following the `"accounts"` entry's shape exactly (`staffOnly: true`, `agentOrAdminOnly: false`).
20. `frontend/components/StaffSidebar.tsx` — confirms `visibleStaffNavItems` already renders whatever is added to `STAFF_NAV_ITEMS` with no further changes needed there.
21. `frontend/app/globals.css` lines 121-131 and 231-238 (light) / grep for the `.dark` block's `--icon-*` equivalents — **the intake's "`--channel-*` tokens" do not exist anywhere in this file** (confirmed via repo-wide grep — zero matches outside build caches). The actual existing non-semantic, vivid, per-category token set is `--icon-status` / `--icon-category` / `--icon-priority` / `--icon-date` (exposed as Tailwind utilities `text-icon-status` etc., already used in `TicketFilterBar.tsx` lines 219/239/259/284). Use these three (or the closest available) for the 3 action categories (`auth`/`permissions`/`staff`) instead of inventing new tokens or referencing tokens that don't exist. Map: `auth` → `icon-status` (blue, `#3E8FD0`/dark `#5B9FE0`-family), `permissions` → `icon-priority` (violet, `#7C3AED`), `staff` → `icon-category` (teal, `#0D8A82`). Do not add new CSS custom properties for this — 3 categories fit inside the existing 4-token set with one spare.
22. `frontend/messages/en.json` — `"Nav"` section (lines 2-40): add `"auditLog"` and `"searchAuditLogsFor"` alongside the existing `"accounts"`/`"searchAccountsFor"` pair. `"AdminUsersList"` section (lines 370-423): the full key-naming convention to mirror one-for-one for a new `"AuditLogList"` section (heading, empty, filter labels, `resetFilters`, `filterAll`, `searchingFor`, etc.).
23. `frontend/messages/ar.json` — mirror every key added to `en.json` in the same change, per `CLAUDE.md`'s i18n convention. Grep `ar.json` for `"AdminUsersList"` first to copy its exact structural placement/ordering.
24. `frontend/lib/jwt.ts`'s `peekJwtPayload` and its use in `frontend/app/admin/users/page.tsx` line 116 — reuse for `showActionsColumn`-equivalent gating if the page needs to distinguish "audit:view granted, can view" (already gated by the fetch's 403 handling) — for this page there's no per-row action, so this is only needed if the page wants to conditionally show anything else; otherwise skip.

---

## Backend Tasks

### 1 — `AuditLog` model

Create file: `backend/src/models/AuditLog.ts`

```typescript
import mongoose, { Document, Schema, Types } from "mongoose";

// security-admin Story 47: proof-of-pattern audit trail. Deliberately a
// SEPARATE, narrower mechanism from Ticket.statusHistory (see
// .squad/plans/security-admin/34-story-review-audit-logs.md's Prerequisites
// section for why that embedded array isn't migrated here) — any future
// consolidation should converge on THIS model, not the other way around.
// Write-only via internal service calls (see services/auditLog.service.ts);
// no create/update/delete HTTP route exists for it at all — the simplest
// possible enforcement of "cannot be edited or deleted by regular users".
export type AuditActionCategory = "auth" | "permissions" | "staff";

export type AuditAction =
  | "login_success"
  | "login_failed"
  | "permissions_changed"
  | "staff_activated"
  | "staff_deactivated";

export const AUDIT_ACTIONS: AuditAction[] = [
  "login_success",
  "login_failed",
  "permissions_changed",
  "staff_activated",
  "staff_deactivated",
];

export const AUDIT_ACTION_CATEGORY: Record<AuditAction, AuditActionCategory> = {
  login_success: "auth",
  login_failed: "auth",
  permissions_changed: "permissions",
  staff_activated: "staff",
  staff_deactivated: "staff",
};

export interface IAuditLog extends Document {
  // Null when the action couldn't be tied to a resolvable account (e.g. a
  // failed login against an email with no matching User) — see
  // metadata.attemptedEmail in that case instead of inventing a placeholder id.
  actor: Types.ObjectId | null;
  action: AuditAction;
  category: AuditActionCategory;
  targetType: "User";
  targetId: Types.ObjectId | null;
  metadata: Record<string, unknown>;
  ipAddress?: string;
  createdAt: Date;
}

const auditLogSchema = new Schema<IAuditLog>(
  {
    actor: { type: Schema.Types.ObjectId, ref: "User", default: null },
    action: { type: String, enum: AUDIT_ACTIONS, required: true },
    category: { type: String, enum: ["auth", "permissions", "staff"], required: true },
    targetType: { type: String, enum: ["User"], required: true },
    targetId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
    ipAddress: { type: String },
  },
  // createdAt only — no updatedAt on an append-only, never-updated log.
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Backs the admin timeline's default (newest-first) query and the
// action/category filter narrowing it — mirrors Notification.ts's
// recipient/read/createdAt compound index reasoning, tuned to this model's
// own primary query shape instead.
auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ actor: 1, createdAt: -1 });

export const AuditLog = mongoose.model<IAuditLog>("AuditLog", auditLogSchema);
```

### 2 — Write-side service

Create file: `backend/src/services/auditLog.service.ts`

```typescript
import { AuditLog, AuditAction, AUDIT_ACTION_CATEGORY } from "../models/AuditLog";

interface RecordAuditLogParams {
  actor: string | null;
  action: AuditAction;
  targetType: "User";
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
```

### 3 — Read/filter endpoint

Create file: `backend/src/routes/audit.routes.ts`

- Imports: `express`, `Request`/`Response`, `requireAuth`/`requirePermission` from `../middleware/auth`, `AuditLog`/`AUDIT_ACTIONS` from `../models/AuditLog`, `validateBody`/`validateParams` are NOT needed (query-only route — validate inline like `ticket.routes.ts`'s `GET /` does with `.safeParse(req.query)`), `escapeRegex` from `../utils/regex`, and the new `listAuditLogsQuerySchema` from `../validation/audit.schema` (task 4 below).
- Single route:

```typescript
router.get("/", requireAuth, requirePermission("audit:view"), async (req: Request, res: Response) => {
  const parsed = listAuditLogsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid query" });
    return;
  }
  const { page, limit, q, action, dateFrom, dateTo } = parsed.data;
  const skip = (page - 1) * limit;

  const filter: Record<string, unknown> = {};
  if (action) filter.action = action;
  if (dateFrom || dateTo) {
    filter.createdAt = {
      ...(dateFrom ? { $gte: new Date(dateFrom) } : {}),
      ...(dateTo ? { $lte: new Date(dateTo) } : {}),
    };
  }

  // `q` searches the RESOLVED actor's name/email — requires a lookup of
  // matching User ids first (AuditLog.actor is an ObjectId ref, not a
  // denormalized name/email field — see Product rules above), then filters
  // by actor $in that set. An empty match set must still return zero rows
  // (not "no filter applied") — $in: [] does this correctly in Mongo.
  if (q) {
    const regex = new RegExp(escapeRegex(q), "i");
    const matchingUsers = await User.find({ $or: [{ name: regex }, { email: regex }] }).select("_id");
    filter.actor = { $in: matchingUsers.map((u) => u._id) };
  }

  const [entries, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("actor", "name email role"),
    AuditLog.countDocuments(filter),
  ]);

  res.status(200).json({
    entries: entries.map((e) => ({
      id: e.id,
      actor: e.actor && typeof e.actor === "object" ? e.actor : null,
      action: e.action,
      category: e.category,
      targetType: e.targetType,
      targetId: e.targetId,
      metadata: e.metadata,
      ipAddress: e.ipAddress,
      createdAt: e.createdAt,
    })),
    total,
    page,
    limit,
  });
});
```

  (Add `import { User } from "../models/User";` alongside the other imports.)

### 4 — Query validation schema

Create file: `backend/src/validation/audit.schema.ts`

```typescript
import { z } from "zod";
import { AUDIT_ACTIONS } from "../models/AuditLog";
import { paginationQuerySchema, flexibleDateSchema } from "./common";

const SEARCH_QUERY_MAX_LENGTH = 200;

// Mirrors admin.schema.ts's listStaffAccountsQuerySchema — pagination +
// q (free-text actor name/email search) + a single enum filter (`action`,
// not `category`: 5 concrete actions is still a short enough list for a
// Select, and keeps the filter precise rather than only category-grained)
// + a createdAt date range, same shape as ticket.schema.ts's
// createdFrom/createdTo (see ticket.routes.ts lines 278-320).
export const listAuditLogsQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().min(1).max(SEARCH_QUERY_MAX_LENGTH).optional(),
  action: z.enum(AUDIT_ACTIONS as [string, ...string[]]).optional(),
  dateFrom: flexibleDateSchema().optional(),
  dateTo: flexibleDateSchema().optional(),
});
```

### 5 — Mount the new router

File: `backend/src/app.ts`

- Add `import auditRoutes from "./routes/audit.routes";` near the other route imports (after `adminRoutes` at line 12).
- Add `app.use("/api/v1/admin/audit-logs", auditRoutes);` after line 29 (`app.use("/api/v1/admin/users", adminRoutes);`).

### 6 — Wire login success/failure

File: `backend/src/routes/auth.routes.ts`

- Add `import { recordAuditLog } from "../services/auditLog.service";` near the top.
- At the top of the `POST /login` handler body (after destructuring `email`/`password`, before the `typeof` guard at line 109), capture `const ipAddress = req.ip;` — needed in every branch below.
- In the `typeof email !== "string" || ...` guard (lines 109-112): no `recordAuditLog` call — no actor and no meaningful email to attribute (malformed request, not a real login attempt).
- After `if (!user) { res.status(401)...` (lines 117-120): before `return`, `await recordAuditLog({ actor: null, action: "login_failed", targetType: "User", metadata: { reason: "unknown_email", attemptedEmail: normalizedEmail }, ipAddress });`.
- After `if (!passwordOk) { res.status(401)...` (lines 123-126): before `return`, `await recordAuditLog({ actor: user.id, action: "login_failed", targetType: "User", targetId: user.id, metadata: { reason: "wrong_password" }, ipAddress });`.
- After `if (!user.isActive) { res.status(403)...` (lines 134-137): before `return`, `await recordAuditLog({ actor: user.id, action: "login_failed", targetType: "User", targetId: user.id, metadata: { reason: "account_deactivated" }, ipAddress });`.
- Right before `res.status(200).json({...})` (line 148): `await recordAuditLog({ actor: user.id, action: "login_success", targetType: "User", targetId: user.id, metadata: {}, ipAddress });`.

### 7 — Wire permission grant/revoke

File: `backend/src/routes/admin.routes.ts`

- Add `import { recordAuditLog } from "../services/auditLog.service";` near the top.
- Inside `router.patch("/:id", ...)`, capture the previous permissions **before** they're overwritten: add `const previousPermissions = user.permissions;` immediately before the existing `if (permissionsInput !== undefined) { user.permissions = permissionsInput; }` block (~line 244).
- After `await user.save()` succeeds (line 249, before the `catch`'s scope ends and before `res.status(200).json(...)` at line 258) — actually: place this call **after** the whole `try { await user.save(); } catch {...}` block, right before `res.status(200).json(toStaffAccountResponse(user));` (line 258), and only `if (editingPermissions)`:

```typescript
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
```

### 8 — Wire staff activation/deactivation

File: `backend/src/routes/admin.routes.ts`

- Inside `setActiveState` (~lines 262-286), after `await user.save();` (line 283) and before `res.status(200).json(toStaffAccountResponse(user));` (line 285):

```typescript
await recordAuditLog({
  actor: req.user!.id,
  action: isActive ? "staff_activated" : "staff_deactivated",
  targetType: "User",
  targetId: user.id,
  metadata: {},
  ipAddress: req.ip,
});
```

---

## Frontend Tasks

### 1 — i18n keys

File: `frontend/messages/en.json`

- In the top-level `"Nav"` section (after `"accounts": "Accounts",` line 6), add `"auditLog": "Audit log",`.
- In the same `"Nav"` section (after `"searchAccountsFor"` line 38), add `"searchAuditLogsFor": "Search audit logs for “{query}”"`.
- Add a new top-level section, placed after `"AdminUsersList"` (after its closing `},` at line 423), named `"AuditLogList"`, mirroring `AdminUsersList`'s key style:

```json
"AuditLogList": {
  "heading": "Audit log",
  "empty": "No audit log entries yet.",
  "noResults": "No entries match these filters.",
  "today": "Today",
  "yesterday": "Yesterday",
  "unknownActor": "Unknown ({email})",
  "actionLoginSuccess": "{actor} logged in",
  "actionLoginFailedUnknownEmail": "Failed login attempt for {email}",
  "actionLoginFailedWrongPassword": "{actor} entered an incorrect password",
  "actionLoginFailedAccountDeactivated": "{actor} attempted to log in to a deactivated account",
  "actionPermissionsChanged": "{actor} updated permissions for {target}",
  "actionStaffActivated": "{actor} activated {target}",
  "actionStaffDeactivated": "{actor} deactivated {target}",
  "categoryAuth": "Login",
  "categoryPermissions": "Permissions",
  "categoryStaff": "Staff status",
  "filterAction": "Action",
  "filterAll": "All",
  "filterDateFrom": "From",
  "filterDateTo": "To",
  "filterDateRange": "Date range",
  "filterSearch": "Search",
  "searchingFor": "“{query}”",
  "resetFilters": "Reset filters",
  "ipAddressLabel": "IP: {ip}"
}
```

File: `frontend/messages/ar.json` — add the matching Arabic translations for every key above (both the two `Nav` additions and the full `AuditLogList` section), in the same structural position (mirror `AdminUsersList`'s placement there). Grep `ar.json` for `"AdminUsersList"` to find where it sits before adding `"AuditLogList"` after it.

### 2 — Nav entry

File: `frontend/lib/staffNav.ts`

- In `STAFF_NAV_ITEMS` (lines 20-26), add one entry after the `"accounts"` line:

```typescript
{ key: "auditLog", href: "/admin/audit-logs", icon: ScrollText, staffOnly: true, agentOrAdminOnly: false, permission: "audit:view" },
```

- Add `ScrollText` to the `lucide-react` import at line 1.

### 3 — Header search wiring

File: `frontend/components/HeaderSearch.tsx`

- In `PAGE_SEARCH_TARGETS` (lines 15-19), add `"/admin/audit-logs": "searchAuditLogsFor",`.

### 4 — Filter bar component

Create file: `frontend/app/admin/audit-logs/AuditLogFilterBar.tsx`

- `"use client"` component, modeled directly on `frontend/app/admin/users/AdminUsersFilterBar.tsx`'s full structure (imports, `ALL` sentinel, `updateParam`/`clearSearch` helpers, `FilterField`-wrapped `Select`s, the Reset row at the bottom in its own `<div>` outside the filters `flex-wrap`, `variant="ghost"` + `text-destructive hover:bg-destructive/10 hover:text-destructive` + `X` icon).
- Controls:
  - `action` — a `Select` with options `ALL` + the 5 `AUDIT_ACTIONS` values, labeled via `t("categoryAuth")`/etc. grouped visually if desired, or flat list using `t("action" + PascalCase(action))` labels (reuse the `actionLoginSuccess`-style keys' short category label instead — simplest: build a small local `ACTION_LABEL_KEY: Record<string,string>` map, e.g. `login_success: "categoryAuth"` is too coarse since two actions share "auth" — instead map each action value directly to a short label; add 5 short filter-option labels to `AuditLogList` if the action-line keys above read awkwardly as Select options, e.g. reuse `categoryAuth`/`categoryPermissions`/`categoryStaff` as three grouped options filtering by `category` instead of `action` if that reads better in the UI — **decide at implementation time based on how the rendered Select looks; both are valid, category-grained is simpler and matches the intake's "action-category" filter framing more literally**). Icon: reuse `Tag` or similar from `lucide-react`, colored via `text-icon-priority` per the category-color mapping in Context item 21.
  - `dateFrom`/`dateTo` — two `DatePickerField`s side by side, same as `TicketFilterBar.tsx` lines 282-308 (`createdFrom`/`createdTo` pair), using `date-fns`'s `format(value, "yyyy-MM-dd")`.
- `q` is NOT a control in this filter bar (same as `AdminUsersFilterBar` — it's driven by `HeaderSearch`), but IS shown as a removable chip/pill when present, same as `AdminUsersFilterBar` lines 50-62.

### 5 — Page

Create file: `frontend/app/admin/audit-logs/page.tsx`

- Modeled on `frontend/app/admin/users/page.tsx`'s full structure: `generateMetadata()` using `getTranslations("AuditLogList")` → `{ title: t("heading"), robots: { index: false, follow: false } }`; cookie/token read; `_refreshed` silent-refresh redirect guard; build `currentQuery`/`nextUrl` from `page`/`q`/`action`/`dateFrom`/`dateTo`; fetch `GET ${API_URL}/api/v1/admin/audit-logs?...` with `limit=20` (a timeline reads well denser than a 10-row table); 401→refresh-redirect-or-`/login`; 403→`redirect("/dashboard")` (matches the nav item never appearing for a caller without `audit:view`, same reasoning as `admin/users/page.tsx` line 96-101); non-ok→`redirect("/")`.
- Response shape from the endpoint:

```typescript
interface AuditLogEntry {
  id: string;
  actor: { id: string; name: string; email: string; role: string } | null;
  action: "login_success" | "login_failed" | "permissions_changed" | "staff_activated" | "staff_deactivated";
  category: "auth" | "permissions" | "staff";
  targetType: "User";
  targetId: string | null;
  metadata: Record<string, unknown>;
  ipAddress?: string;
  createdAt: string;
}
```

- **Grouped-by-day rendering (Option B):** after fetching `data.entries` (already newest-first from the backend), group client-side (a plain function in this Server Component, no extra library) by the local calendar date of `createdAt`. For each group, render a date-header label using `t("today")`/`t("yesterday")`/otherwise a formatted date (`date-fns`'s `format(date, "MMMM d, yyyy")`, or locale-aware if easy — not required for a first cut given month/day names are English-only elsewhere too, see `DatePickerField.tsx`'s own comment on this same limitation), then the rows for that day.
- **Row content:** time (`format(new Date(entry.createdAt), "p")` or similar), actor name (or `t("unknownActor", { email: entry.metadata.attemptedEmail })` when `actor === null`), and a short human-readable line built by mapping `entry.action`/`entry.metadata.reason` to one of the `actionLoginSuccess`/`actionLoginFailedUnknownEmail`/`actionLoginFailedWrongPassword`/`actionLoginFailedAccountDeactivated`/`actionPermissionsChanged`/`actionStaffActivated`/`actionStaffDeactivated` message keys, interpolating `{actor}`/`{target}`/`{email}` as needed (for `permissions_changed`/`staff_activated`/`staff_deactivated`, `{target}` needs the target user's name/email — the endpoint's `targetId` alone isn't enough without a name; either (a) accept showing the target's raw id as a fallback where no easy name is available, or (b) extend the backend's `populate` to also resolve `targetId` via a second populate call/lookup when `targetType === "User"` and include it in the response as `target: { id, name, email } | null`, mirroring how `actor` is already resolved — **prefer (b)** for a materially better UI at negligible extra query cost, applied consistently since `targetId` is always a `User` in this story's 3 wired actions).
- Action-category coloring: a small left-of-row accent/dot or badge using `text-icon-status` (auth) / `text-icon-priority` (permissions) / `text-icon-category` (staff), per Context item 21's mapping — not new tokens.
- IP address: shown as a small muted label (`t("ipAddressLabel", { ip: entry.ipAddress })`) only `if (entry.ipAddress)` — it's optional per the model, and per Product rules must degrade gracefully when absent.
- Filter bar: `<AuditLogFilterBar />` rendered above the timeline, same position as `<AdminUsersFilterBar />` in the precedent page.
- Pagination: `<ListPagination total={data.total} page={data.page} limit={data.limit} hrefForPage={hrefForPage} />` at the bottom, same as the precedent.
- Empty states: `data.entries.length === 0` → `t("empty")` when no filters are active, `t("noResults")` when any filter/`q` is active (mirrors the distinction implicitly available via `AdminUsersFilterBar`'s `hasActiveFilter`, though `admin/users/page.tsx` itself only has one `t("empty")` string today — this page may introduce the two-string distinction as a small improvement; not required if it adds complexity disproportionate to the story, a single `t("empty")` covering both cases is an acceptable simplification).
- Sidebar: `<StaffSidebar active="auditLog" />` (requires `StaffNavKey` to include `"auditLog"`, which task Frontend §2 above adds automatically since it's derived from `STAFF_NAV_ITEMS`).

### 6 — (b) option from Task 5: resolve `targetId` server-side

File: `backend/src/routes/audit.routes.ts` (extends Backend Task 3)

- After fetching `entries`, resolve any non-null `targetId`s in one extra query: collect `const targetIds = entries.filter(e => e.targetId).map(e => e.targetId);`, `const targets = await User.find({ _id: { $in: targetIds } }).select("name email role");`, build a `Map<string, {id,name,email,role}>`, and include `target: targetMap.get(String(e.targetId)) ?? null` in each response row alongside `actor`.

---

## Edge Cases & Failure Modes

- **`AuditLog.create` fails (e.g. transient DB hiccup) inside `recordAuditLog`.** Expected behavior: swallowed (`try`/`catch`, `console.error`), the calling route's own response is unaffected — enforced in `backend/src/services/auditLog.service.ts` (Backend Task 2). A test should cover that a login/permission-change still succeeds even if this is mocked to throw (or, simpler for this story's scope, at minimum verify the primary route's success path isn't coupled to the audit write via a DB assertion, not necessarily a full failure-injection test).
- **Actor account later deleted (soft-delete via `isDeleted: true`, `admin.routes.ts` line 327).** `populate("actor", ...)` still resolves the document (soft-delete doesn't remove the row) — the audit entry keeps showing the account's last-known name/email. If a `User` were ever hard-deleted (not currently possible anywhere in the app), `populate` would return `null` for `actor` — the response mapping in Backend Task 3 (`e.actor && typeof e.actor === "object" ? e.actor : null`) already handles a null/unpopulated `actor` gracefully, and the frontend must render it the same way it renders a genuinely-null actor (failed login, unknown email) — reuse `t("unknownActor", ...)` with a generic fallback (no `metadata.attemptedEmail` in this case) rather than crashing on a missing field.
- **`q` search matches zero users.** `User.find(...).select("_id")` returns `[]`, so `filter.actor = { $in: [] }` — Mongo correctly returns zero documents for this, not "filter ignored". Covered by the schema's own `$in: []` semantics; add a test asserting `total: 0` for a `q` that matches nobody, not `total` equal to the full unfiltered count.
- **`dateFrom`/`dateTo` supplied as a plain date (`YYYY-MM-DD`), matching the existing `ticket.routes.ts` behavior.** `new Date("2026-09-03")` parses as UTC midnight, so `dateTo=2026-09-03` with a plain-date value will `$lte` UTC-midnight and exclude same-day entries after that — this is a **pre-existing quirk inherited from `ticket.routes.ts`'s identical pattern**, not something to silently "fix" differently here (would make the two date-range filters in the app behave inconsistently). Leave as-is; note it in a code comment at the `filter.createdAt` assignment, same spirit as flagging a known limitation rather than hiding it.
- **A subadmin has `audit:view` but not `staff:view_list`.** The audit-log page's own `targetId`-resolution (Task 6) queries `User` directly inside `audit.routes.ts`, not via the `/admin/users` roster endpoint — so this page never depends on `staff:view_list` and works correctly for a subadmin granted only `audit:view`. Explicitly avoid the alternative design (fetching `/admin/users` server-side from the page to build an actor-filter dropdown) for exactly this reason — it would silently break for that caller. A test should grant a subadmin `audit:view` only (no other keys) and confirm `GET /api/v1/admin/audit-logs` succeeds.
- **Unicode / very long `attemptedEmail`** in a failed unknown-email login. `metadata` is `Schema.Types.Mixed` with no length cap — acceptable for this story's scope (internal admin-only read surface, not user-facing free text rendered without escaping risk in a browser context beyond normal React auto-escaping).
- **Concurrent logins / permission edits** racing to write `AuditLog` entries. Each `recordAuditLog` call is an independent `AuditLog.create` — no shared mutable state, no risk of lost writes or races between them (unlike `RefreshFamily`'s token-chain CAS, this model has nothing analogous to protect).
- **Agent role calling `GET /api/v1/admin/audit-logs`.** `requirePermission("audit:view")` rejects with 403 before the handler runs — `audit:view` is in `SUBADMIN_ONLY_PERMISSIONS`, so an agent's `hasPermission` check can never return true for it (no agent account can ever be granted this key by `admin.routes.ts`'s own `permissionsAllowedForTargetRole`). Covered by a permission-middleware-level test, not a route-specific one — but add one explicit route-level 403 test for an agent token anyway, matching `admin.routes.test.ts`'s existing style (line 60-68).

## Test Plan

Create file: `backend/tests/routes/audit.routes.test.ts` — copy the scaffold from `backend/tests/routes/admin.routes.test.ts` (`MongoMemoryServer`, `tokenFor`, `seedUser`) and add:

1. `describe("GET /api/v1/admin/audit-logs")`:
   - `it("returns 401 without a token")`.
   - `it("returns 403 for a customer or agent token")` — agent token included even though `audit:view` can never be granted to one, matching `admin.routes.test.ts` line 60-68's dual-role style.
   - `it("returns 200 for an admin token with an empty log")` — asserts `entries: []`, `total: 0`.
   - `it("returns 200 for a subadmin token granted ONLY audit:view (no staff:view_list)")` — the "Edge Cases" scenario above; seed a subadmin with `permissions: ["audit:view"]`, assert 200.
   - `it("paginates and filters by action")` — seed several `AuditLog.create(...)` docs directly (mixed actions), assert `action=login_success` query only returns matching rows.
   - `it("filters by date range (dateFrom/dateTo)")` — seed docs with distinct `createdAt` (pass `{ timestamps: false }` override or set `createdAt` explicitly via `AuditLog.create({ ..., createdAt: someDate })`, then verify with `.set('createdAt', ...)`/direct field assignment before `.save()` if Mongoose's `timestamps` option resists a direct create-time override — check Mongoose's own behavior here: passing `createdAt` explicitly to `.create()` on a `timestamps: true`-schema is normally honored unless overwritten; verify during implementation and use `Model.collection.insertOne` as a fallback if not).
   - `it("q searches actor name/email, returns zero rows for no match")`.
   - `it("populates actor name/email/role, and target name/email when targetId is set")`.
   - `it("actor is null and metadata.attemptedEmail is set for an unknown-email login_failed entry")` — seed this shape directly and assert the response's `actor: null`.

2. `describe("POST /api/v1/auth/login audit wiring")` — extend the existing auth-route tests (find them; likely `backend/tests/routes/` has no `auth.routes.test.ts` yet per the file list in Context item 13's sibling listing — check `backend/tests/routes/` directly at implementation time; if absent, add a new focused test file `backend/tests/routes/auditWiring.test.ts` rather than creating a full auth-route test suite out of scope for this story) covering:
   - A successful login creates one `AuditLog` document with `action: "login_success"`, `actor` equal to the user's id.
   - An unknown-email login creates one document with `action: "login_failed"`, `actor: null`, `metadata.reason === "unknown_email"`, `metadata.attemptedEmail` set.
   - A wrong-password login (existing user) creates `action: "login_failed"`, `actor` set, `metadata.reason === "wrong_password"`.
   - A deactivated-account login (correct password) creates `action: "login_failed"`, `metadata.reason === "account_deactivated"`.

3. `describe("PATCH /:id permission-change and status-toggle audit wiring")` — extend `admin.routes.test.ts` directly (it already covers `PATCH /:id` and `/:id/activate`/`/:id/deactivate`) with assertions that a matching `AuditLog` document now exists after each of those calls, with the right `action`/`metadata.before`/`metadata.after` (permissions case) or `action` (`staff_activated`/`staff_deactivated`).

4. `backend/tests/constants/permissions.test.ts` — read this file first; if it asserts the full `PERMISSION_KEYS`/`SUBADMIN_ONLY_PERMISSIONS` contents exactly, no change is needed (this story doesn't modify either array) — just confirm no existing assertion breaks.

## Migration / Rollback

No schema migration needed — `AuditLog` is a brand-new collection, no backfill of historical events is possible or expected (the model only starts capturing events from the moment this story ships). If this story needs to be rolled back, dropping the `audit.routes.ts` mount in `app.ts` and removing the 3 `recordAuditLog` call sites is sufficient; the `AuditLog` collection can be left in place (unused) or dropped manually — no other code depends on its existence.

## Verification Steps

1. **Backend typecheck:** `npm run typecheck` in `backend/`.
2. **Backend build:** `npm run build` in `backend/`.
3. **Backend tests:** `npm test` in `backend/` (runs `vitest run`) — confirm the new `audit.routes.test.ts` (and any auth-wiring test file) pass alongside the full existing suite (no regressions in `admin.routes.test.ts`, `rbac.integration.test.ts`).
4. **Frontend build:** `npm run build` in `frontend/` — confirms the new page/component compile, i18n keys resolve (a missing key surfaces as a build-time or runtime `next-intl` error), and `en.json`/`ar.json` stay structurally valid JSON.
5. **Manual smoke (optional but recommended given the UI is new):** run `backend/` (`npm run dev`) and `frontend/` (`npm run dev`), log in as an admin, trigger a permission change and a staff deactivate/activate via `/admin/users`, then visit `/admin/audit-logs` and confirm the grouped timeline renders those entries with correct action lines, category coloring, and that the filter bar / date range / Reset button all round-trip through the URL correctly.

## Done Criteria

- [x] `AuditLog` model created (`backend/src/models/AuditLog.ts`) with `actor`, `action`, `category`, `targetType`, `targetId`, `metadata`, `ipAddress?`, `createdAt` — no update/delete route exists for it anywhere.
- [x] `GET /api/v1/admin/audit-logs` gated by `requirePermission("audit:view")`, supporting pagination, `q` (actor name/email search), `action`/`category` filters, `dateFrom`/`dateTo` range.
- [x] Wired into exactly 3 proof-of-pattern call sites: login success/failure (`auth.routes.ts`), permission grant/revoke (`admin.routes.ts` `PATCH /:id`), staff activate/deactivate (`admin.routes.ts` `setActiveState`).
- [x] Entries include who (actor, nullable), what (action/category), when (createdAt), and where available (ipAddress) — matches the intake's acceptance criteria verbatim.
- [x] New admin page `frontend/app/admin/audit-logs/page.tsx` implements the grouped-by-day timeline (Option B), reachable from `StaffSidebar`/`staffNav.ts` gated on `audit:view`, with real SEO metadata (`robots: { index: false, follow: false }`, real `<title>`).
- [x] Filter bar follows the app's standard list-view convention (`AdminUsersFilterBar`-style, not `TicketFilterBar`'s dialog variant), Reset button in its own row styled destructive-ghost, `q` wired through `HeaderSearch`/`PAGE_SEARCH_TARGETS`.
- [x] Action-category coloring reuses the existing `--icon-status`/`--icon-category`/`--icon-priority`/`--icon-date` tokens — no new CSS custom properties added (the intake's referenced `--channel-*` tokens were confirmed not to exist in this codebase; flagged as a spec discrepancy).
- [x] `en.json`/`ar.json` both updated in the same change, no key drift.
- [x] `backend/` `npm run typecheck` and `npm run build` pass. `npm test` (505/506 tests passing): all 18 new tests (`audit.routes.test.ts`, `auditWiring.test.ts`) pass, and the full pre-existing suite is unaffected except for one pre-existing, unrelated failure — `tests/routes/ticket.routes.test.ts`'s "creates a Message with an attachment, stored on disk and downloadable" (disk-based attachment download, ticket-management territory this story never touches) — confirmed present in isolation with zero relation to this diff (`git diff` on `ticket.routes.ts`/its test file is empty) before and after this story's changes; not fixed here per the explicit "don't touch ticket.routes.ts" scope boundary.
- [x] `frontend/` `npm run build` passes (confirmed — compiles cleanly, `/admin/audit-logs` route present in the build output).
- [x] `Ticket.statusHistory` reconciliation explicitly documented (not migrated) — this story's own model is the intended future consolidation point.
