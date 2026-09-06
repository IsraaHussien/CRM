# security-admin — plan overview

Entry point for the **security-admin** feature. Stories execute in order by their `NN` prefix.

## Stories

| NN | File | Title | Tracker id | Depends on |
|----|------|-------|------------|------------|
| 08 | `08-story-manage-user-accounts.md` | Manage user accounts | 45 | — |
| 09 | `09-story-configure-roles-and-permissions.md` | Configure roles and permissions | 46 | 08 |
| 10 | `34-story-review-audit-logs.md` | Review audit logs | 47 | 08, 09 |
| 11 | _not yet planned_ | System configuration | 48 | 09, 10 |

## Dependency notes

- **Story 08 introduces the fourth role, `subadmin`**, on `backend/src/models/User.ts`'s `role` enum — every later story in this feature (and any story elsewhere that reasons about roles, e.g. `frontend/components/SiteHeader.tsx`'s `isStaff` check) builds on that change rather than re-deriving it.
- **Story 08 gates its endpoints on `requireRole("admin")` with marked `TODO` comments**, not `requirePermission`, because the per-account `permissions` field and `requirePermission` middleware don't exist until Story 09. Story 09's plan must find and convert those marked spots to the granular `staff:*` keys it introduces — roster visibility → `requirePermission("staff:view_list")`, opening a single account → `requirePermission("staff:view_account")`, creating an account or editing its name/email/role → `requirePermission("staff:edit")`, and activating/deactivating an account → `requirePermission("staff:toggle_status")` — rather than leaving everything on the coarser role check indefinitely, and rather than collapsing staff-account actions back down to one shared key.
- **`admin` accounts are never created through the app** — Story 08's `POST /api/v1/admin/users` only accepts `role: "agent" | "subadmin"`; real admin accounts are provisioned directly in the database (`backend/scripts/seed-admin.ts`). Because of this, **`staff:edit` needs no cap on creation at all** — a delegated sub-admin can never mint anything more powerful than themselves, since `admin` isn't a reachable value.
- **Status changes are capped separately from creation/edit**: a sub-admin holding `staff:toggle_status` can activate/deactivate `agent`/`subadmin` accounts, but toggling the status of an *existing* `admin` account always stays `requireRole("admin")`. Story 08 leaves this as a marked-but-inert comment (every caller today is already a true admin, so the branch has nothing to enforce yet); **Story 09 is the one that makes it load-bearing** when it converts Story 08's other endpoints to `requirePermission`. Do not let that conversion silently drop the admin-target branch.
- **Staff/system-administration permissions are sub-admin only, never assignable to an agent account.** That set is all six `staff:*` keys (`staff:view_list`, `staff:view_account`, `staff:edit`, `staff:toggle_status`, `staff:delete`, `staff:permissions`), plus `config:edit`, `audit:view`, `sla:configure`, `kb:publish`, `reports:export`. Everything else in the vocabulary (`customers:manage`, `tickets:delete`, `tickets:reassign`, `tickets:view_all`, `reports:view`, `ai:override_category`) stays assignable to either an agent or a sub-admin. This is enforced server-side — not just hidden in the UI — and is the centerpiece of Story 09.
- Story 10 (audit logs) should wire logging into Story 08's account-creation/status-toggle actions and Story 09's permission-grant/revoke actions as 2 of its 2–3 proof-of-pattern examples (see its intake's "Extra notes").
- Story 11 (system configuration) gates its endpoints on `requirePermission("config:edit")`, which only exists after Story 09.
