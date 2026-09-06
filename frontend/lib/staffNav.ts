import { LayoutDashboard, Users, ShieldUser, Ticket, MessageSquare, TicketPlus, UserPlus, ShieldPlus, Settings2, MessagesSquare, BookOpen, ScrollText, BarChart3 } from "lucide-react";

// Shared between the desktop hover-expand rail and the mobile drawer
// (components/StaffSidebar.tsx, components/MobileStaffNav.tsx) so both stay
// in sync. "accounts" (/admin/users) is gated on the exact permission its
// own GET requires — staff:view_list — not just the admin/subadmin role,
// since a sub-admin without it gets a real 403 from that page (see
// app/admin/users/page.tsx's own comment on this). "chats" (Story 18) used
// to be `agentOrAdminOnly` — its backend route was `requireRole("agent",
// "admin")` with no permission-delegation path at all, so a sub-admin (even
// with every permission granted) always got a real 403 there, and any agent
// had unconditional access with no way to revoke it. It's now gated on
// chats:manage instead, same as "accounts" — see isVisibleForRole below for
// why one `permission` check now covers both cases correctly. "customers"
// used to be unconditionally visible to any staff role too, back when an
// agent's access to /customers was itself unconditional — now that
// customer.routes.ts gates agent (not just sub-admin) on customers:manage,
// this must gate on it as well, or an agent who's had it revoked gets a nav
// entry/search result that just bounces them to /dashboard.
export const STAFF_NAV_ITEMS = [
  { key: "dashboard", href: "/dashboard", icon: LayoutDashboard, staffOnly: false, agentOrAdminOnly: false, permission: undefined, pinned: false },
  { key: "customers", href: "/customers", icon: Users, staffOnly: false, agentOrAdminOnly: false, permission: "customers:manage", pinned: false },
  { key: "tickets", href: "/tickets", icon: Ticket, staffOnly: false, agentOrAdminOnly: false, permission: undefined, pinned: false },
  { key: "chats", href: "/chats", icon: MessageSquare, staffOnly: false, agentOrAdminOnly: false, permission: "chats:manage", pinned: false },
  { key: "accounts", href: "/admin/users", icon: ShieldUser, staffOnly: true, agentOrAdminOnly: false, permission: "staff:view_list", pinned: false },
  // knowledge-base Stories 29/30: FAQs and help articles are two separate
  // destinations (separately delegable permission families — see
  // backend/src/constants/permissions.ts) even though their admin UI lives
  // side by side under /admin/kb.
  { key: "kbFaqs", href: "/admin/kb/faqs", icon: MessagesSquare, staffOnly: true, agentOrAdminOnly: false, permission: "kb:faq_view_list", pinned: false },
  { key: "kbArticles", href: "/admin/kb/articles", icon: BookOpen, staffOnly: true, agentOrAdminOnly: false, permission: "kb:article_view_list", pinned: false },
  // security-admin Story 47: read-only audit log, gated on audit:view — a
  // subadmin can hold this without staff:view_list (or vice versa), so it's
  // its own permission key, not folded into "accounts".
  { key: "auditLog", href: "/admin/audit-logs", icon: ScrollText, staffOnly: true, agentOrAdminOnly: false, permission: "audit:view", pinned: false },
  // reports-management Stories 40/41: reports:view is agent-grantable by
  // default (see backend/src/constants/permissions.ts's
  // DEFAULT_PERMISSIONS_BY_ROLE), unlike auditLog above — so this isn't
  // staffOnly in the "admin/subadmin-tier" sense, it's purely permission-gated.
  { key: "reports", href: "/admin/reports", icon: BarChart3, staffOnly: true, agentOrAdminOnly: false, permission: "reports:view", pinned: false },
  // sla-automation Story 25: the /admin/system-configuration shell
  // (categories/SLA targets/quick replies/branding tabs). `pinned: true`
  // means StaffSidebar/MobileStaffNav render this separately, anchored to
  // the bottom of the nav rather than in the scrollable main list — a
  // "settings" item reads as app-level chrome, not a workspace section.
  // href is the shell's bare root (redirects to its first tab, see
  // app/admin/system-configuration/page.tsx) rather than a specific tab, so
  // activeStaffNavKey's prefix match highlights this item on every tab.
  { key: "systemConfiguration", href: "/admin/system-configuration", icon: Settings2, staffOnly: true, agentOrAdminOnly: false, permission: "tickets:categories_view", pinned: true },
] as const;

export type StaffNavKey = (typeof STAFF_NAV_ITEMS)[number]["key"];

// A `permission` key, when present, is checked the same way for every item
// regardless of `staffOnly`: admin always passes; agent/subadmin need it in
// their own granted list. This one rule already covers both existing shapes
// — a sub-admin-only key like staff:view_list (an agent's permissions array
// can never contain it; the backend rejects granting it to an agent
// account, so the array-membership check alone excludes agents exactly like
// the old staffOnly-specific branch did) and a key assignable to either role
// like chats:manage (an agent *can* hold it, and should see the item when
// they do). `agentOrAdminOnly`/`staffOnly` only still matter for the
// permission-less items above (visible to any signed-in staff role).
function isVisibleForRole(
  item: { agentOrAdminOnly: boolean; staffOnly: boolean; permission?: string },
  role: string | undefined,
  permissions: string[]
): boolean {
  if (item.permission) {
    if (role === "admin") return true;
    if (role === "agent" || role === "subadmin") return permissions.includes(item.permission);
    return false;
  }
  if (item.agentOrAdminOnly) return role === "agent" || role === "admin";
  if (!item.staffOnly) return true;
  return role === "admin";
}

export function visibleStaffNavItems(role: string | undefined, permissions: string[] = []) {
  return STAFF_NAV_ITEMS.filter((item) => isVisibleForRole(item, role, permissions));
}

// Quick-create actions surfaced in the header search (HeaderSearch), not
// destinations to browse. Each entry's visibility mirrors its own
// destination page's real access check exactly — a link a click would just
// redirect away from isn't offered here (same rule customer.routes.ts's
// roster already follows for row-level links: don't render a link a click
// would just bounce off of). Where the destination page checks a specific
// permission (not just role) for a sub-admin, `permission` names it — a
// sub-admin lacking it doesn't get offered the entry, same as it doesn't
// get a working "accounts" nav item above without staff:view_list.
export const STAFF_ACTION_ITEMS = [
  // /tickets/new (ticket-management Story 8/57) renders customer-submit
  // mode for a customer and staff-create-for-customer mode for
  // agent/admin/subadmin — every staff role reaches a working form here,
  // even one lacking tickets:create_for_customer (the backend 403 surfaces
  // as an in-form alert, not a dead page).
  { key: "newTicket", href: "/tickets/new", icon: TicketPlus, agentOrAdminOnly: false, staffOnly: false, permission: undefined },
  // customers/new/page.tsx requires customers:manage (agent/subadmin) or
  // admin, same gate its POST /customers ultimately enforces — matches
  // that exactly.
  { key: "newCustomer", href: "/customers/new", icon: UserPlus, agentOrAdminOnly: false, staffOnly: false, permission: "customers:manage" },
  // admin/users/new/page.tsx requires role "admin" or permission staff:edit
  // (a sub-admin delegated staff:edit, same key the POST itself requires).
  { key: "newStaffAccount", href: "/admin/users/new", icon: ShieldPlus, agentOrAdminOnly: false, staffOnly: true, permission: "staff:edit" },
  // systemConfiguration used to live here (replacing the older
  // manageTicketCategories entry) before it got a real pinned-bottom slot
  // in STAFF_NAV_ITEMS above — HeaderSearch already concatenates
  // visibleStaffNavItems + visibleStaffActionItems, so it's still
  // ⌘K-searchable without being duplicated in both lists.
] as const;

export function visibleStaffActionItems(role: string | undefined, permissions: string[] = []) {
  return STAFF_ACTION_ITEMS.filter((item) => isVisibleForRole(item, role, permissions));
}

// Derives which nav item is "active" from the current URL instead of a
// prop threaded down from each page — lets a single client component (the
// mobile drawer trigger, rendered once from SiteHeader) work correctly on
// every staff page without per-page wiring. Longest-prefix match, most
// specific href first, so "/admin/users" doesn't shadow a future
// "/admin/users/settings"-style route in the wrong direction.
export function activeStaffNavKey(pathname: string): StaffNavKey | undefined {
  const sorted = [...STAFF_NAV_ITEMS].sort((a, b) => b.href.length - a.href.length);
  return sorted.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))?.key;
}
