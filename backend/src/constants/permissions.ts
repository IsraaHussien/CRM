// Fixed permission vocabulary — see USER_STORIES.md security-admin Story 46.
// Permissions are granted PER INDIVIDUAL agent/sub-admin account (stored on
// User.permissions, see backend/src/models/User.ts) — there is no shared
// per-role permission set. Keys not yet backed by a real feature
// (sla:configure, ...) are reserved here, ready for the story
// that builds that feature to start gating its own routes with
// requirePermission(key) using one of these.
//
// The "staff:*" keys replace what used to be a single coarse "users:manage"
// key — every staff-account action (view the roster, view one account, edit
// its details, activate/deactivate, delete, change its granted permissions)
// is now independently grantable.
export const PERMISSION_KEYS = [
  "staff:view_list",
  "staff:view_account",
  "staff:edit",
  "staff:toggle_status",
  "staff:delete",
  "staff:permissions",
  "audit:view",
  "config:edit",
  "customers:manage",
  "tickets:delete",
  "tickets:reassign",
  "tickets:view_all",
  "tickets:create_for_customer",
  "tickets:categories_view",
  "tickets:categories_create",
  "tickets:categories_edit",
  "tickets:categories_toggle_status",
  "tickets:categorize",
  "tickets:change_priority",
  "tickets:reply",
  // agent-workspace Story 24: post an agent-only internal note on a ticket
  // (Message.internal: true), optionally tagging colleagues. Its own key,
  // not folded into tickets:reply — a reply is emailed to the customer and
  // flips the ticket to "answered", an internal note is invisible to the
  // customer and changes nothing; an account can legitimately hold one
  // without the other (see [[feedback_granular_action_permissions]]).
  "tickets:post_internal_note",
  // Split in two (ticket-management Story 11) so an account can be granted
  // routine New/In Progress/Answered flips without also getting authority to
  // close/reopen a ticket, or vice versa.
  "tickets:change_status",
  "tickets:close_reopen",
  // ticket-management Story 12: manual escalation to a senior agent or
  // admin — agent-tier, same reasoning as tickets:change_status above (an
  // account can be granted this without also getting close/reopen or vice
  // versa).
  "tickets:escalate",
  // ticket-management Story 13 (view full ticket history): exporting a
  // ticket's full audit timeline as a file is a sub-admin-tier action,
  // distinct from just viewing the (already-unrestricted) timeline itself.
  "tickets:export_history",
  "chats:manage",
  "sla:configure",
  // sla-automation Story 25: view/edit the admin-configurable
  // (priority, category) -> duration lookup rows. Distinct from
  // sla:configure, which gates the monitor's own tuning (at-risk threshold,
  // scan interval), not the target rows themselves.
  "sla:targets_view",
  "sla:targets_edit",
  // knowledge-base Stories 29/30: FAQs and help articles. Per-ENTITY,
  // per-ACTION keys (view/create/edit/delete for each of kb:faq_* and
  // kb:article_* separately) rather than one umbrella "kb:manage" — see
  // [[feedback_granular_action_permissions]]. Curating short Q&A pairs and
  // writing long-form guides are separately delegable jobs, so an account
  // can hold one family without the other. There is no draft/published
  // state and no separate "publish" authority (product decision, 2026-09-02):
  // an FAQ or article is live for customers as soon as it's saved, so
  // *_create and *_edit are the only gates a customer-visible change needs.
  "kb:faq_view_list",
  "kb:faq_create",
  "kb:faq_edit",
  "kb:faq_delete",
  "kb:article_view_list",
  "kb:article_create",
  "kb:article_edit",
  "kb:article_delete",
  "reports:view",
  "reports:export",
  "ai:override_category",
  // ai-features Story 32: AI summary of a ticket/chat thread.
  "ai:summarize",
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export type CreatableStaffRole = "agent" | "subadmin";

// Keys that can only ever be granted to a sub-admin account, never an agent
// — staff/system administration is a sub-admin-tier concern, agents are
// scoped to customer/ticket-facing work. Enforced server-side in
// admin.routes.ts's validatePermissions (not just hidden in the UI).
export const SUBADMIN_ONLY_PERMISSIONS: ReadonlySet<PermissionKey> = new Set([
  "staff:view_list",
  "staff:view_account",
  "staff:edit",
  "staff:toggle_status",
  "staff:delete",
  "staff:permissions",
  "audit:view",
  "config:edit",
  "sla:configure",
  "sla:targets_view",
  "sla:targets_edit",
  "kb:faq_view_list",
  "kb:faq_create",
  "kb:faq_edit",
  "kb:faq_delete",
  "kb:article_view_list",
  "kb:article_create",
  "kb:article_edit",
  "kb:article_delete",
  "reports:export",
  "tickets:categories_view",
  "tickets:categories_create",
  "tickets:categories_edit",
  "tickets:categories_toggle_status",
  "tickets:export_history",
]);

export function permissionKeysAllowedForRole(role: CreatableStaffRole): readonly PermissionKey[] {
  if (role === "subadmin") return PERMISSION_KEYS;
  return PERMISSION_KEYS.filter((key) => !SUBADMIN_ONLY_PERMISSIONS.has(key));
}

// Suggested starting point when creating a new account via the admin UI's
// stepper (step 2 pre-fill) — a convenience default, not an enforced
// role-level set. The admin can freely adjust before or after creation;
// once created, permissions live entirely on that individual User document.
export const DEFAULT_PERMISSIONS_BY_ROLE: Record<CreatableStaffRole, PermissionKey[]> = {
  agent: [
    "tickets:reassign",
    "reports:view",
    "ai:override_category",
    "tickets:create_for_customer",
    "tickets:categorize",
    "tickets:change_priority",
    "tickets:reply",
    "tickets:post_internal_note",
    "tickets:change_status",
    "tickets:close_reopen",
    "tickets:escalate",
    "chats:manage",
    // customers:manage added when agents started being gated on it (see
    // customer.routes.ts) — pre-existing agent accounts won't have it and
    // need a manual grant; no backfill migration exists for this.
    "customers:manage",
    "ai:summarize",
  ],
  // Deliberately empty — sub-admin accounts start with no default
  // permissions, granted individually post-creation, unlike agents above.
  // ai-features Story 32's plan called for adding "ai:summarize" here too,
  // but that would make it the first-ever entry in this list and break that
  // invariant for no story-specific reason — a sub-admin who needs it can
  // still be granted it manually like
  // every other sub-admin permission.
  subadmin: [],
};
