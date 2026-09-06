// Mirrors backend/src/constants/permissions.ts's PERMISSION_KEYS. Kept as a
// plain hardcoded list here (same convention as role labels already
// duplicated across the frontend's i18n messages) rather than fetched from
// an API — the vocabulary is fixed and rarely changes.
export const PERMISSION_CATEGORIES: Record<string, string[]> = {
  staff: [
    "staff:view_list",
    "staff:view_account",
    "staff:edit",
    "staff:toggle_status",
    "staff:delete",
    "staff:permissions",
  ],
  audit: ["audit:view"],
  config: ["config:edit"],
  customers: ["customers:manage"],
  tickets: [
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
    // agent-workspace Story 24 — mirrors backend/src/constants/permissions.ts.
    "tickets:post_internal_note",
    "tickets:change_status",
    "tickets:close_reopen",
    "tickets:escalate",
  ],
  chats: ["chats:manage"],
  sla: ["sla:configure", "sla:targets_view", "sla:targets_edit"],
  kb: [
    "kb:faq_view_list",
    "kb:faq_create",
    "kb:faq_edit",
    "kb:faq_delete",
    "kb:article_view_list",
    "kb:article_create",
    "kb:article_edit",
    "kb:article_delete",
  ],
  reports: ["reports:view", "reports:export"],
  ai: ["ai:override_category", "ai:summarize"],
};

// Staff/system-administration keys — sub-admin only, never assignable to an
// agent account. Mirrors backend's SUBADMIN_ONLY_PERMISSIONS; the backend
// re-validates this on every create/edit, this is only for filtering which
// rows PermissionsStep offers based on the role picked in step 1.
export const SUBADMIN_ONLY_PERMISSIONS = new Set<string>([
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
]);

export function stripSubadminOnlyPermissions(permissions: string[]): string[] {
  return permissions.filter((key) => !SUBADMIN_ONLY_PERMISSIONS.has(key));
}
