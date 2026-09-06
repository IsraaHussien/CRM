"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { visibleStaffNavItems, visibleStaffActionItems } from "@/lib/staffNav";
import { CUSTOMER_SEARCH_ITEMS } from "@/lib/customerSearch";

// List pages that support a server-side `?q=` text search (see each page's
// filter bar — CustomerFilterBar/AdminUsersFilterBar/TicketFilterBar surface
// the active `q` as a clearable chip). Exact-path only: a detail/new
// sub-route (e.g. /customers/123) has no table to search, so it's excluded
// even though it shares the prefix.
const PAGE_SEARCH_TARGETS: Record<string, string> = {
  "/customers": "searchCustomersFor",
  "/admin/users": "searchAccountsFor",
  "/tickets": "searchTicketsFor",
  "/admin/audit-logs": "searchAuditLogsFor",
};

// Real quick-nav-and-action search (not decorative) — jumps to pages
// (Customers/Accounts/...) and quick-create actions (New ticket/New
// customer/...) via ⌘K or a click. Also offers a "search this page" action
// when the viewer is on a page with a server-driven list (see
// PAGE_SEARCH_TARGETS) — typing there both filters the nav/action list below
// and offers to re-run that list's own search with the typed text. No fake
// results. Takes only plain serializable props (variant/role) and resolves
// the actual item list (staffNav.ts / customerSearch.ts) itself — those
// lists carry Lucide icon component references, which cannot cross the
// Server-to-Client prop boundary from SiteHeader (a Server Component); only
// primitives can.
export function HeaderSearch({
  variant,
  role,
  permissions = [],
}: {
  variant: "staff" | "customer";
  role?: string;
  permissions?: string[];
}) {
  const t = useTranslations("Nav");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const items =
    variant === "staff"
      ? [...visibleStaffNavItems(role, permissions), ...visibleStaffActionItems(role, permissions)]
      : CUSTOMER_SEARCH_ITEMS;
  const labeledItems = items.map((item) => ({ ...item, label: t(item.key) }));
  const trimmedQuery = query.trim();
  const matches = trimmedQuery
    ? labeledItems.filter((item) => item.label.toLowerCase().includes(trimmedQuery.toLowerCase()))
    : labeledItems;

  // customer-portal Story 37: a customer can only ever be on "/tickets"
  // among PAGE_SEARCH_TARGETS's keys ("/customers" and "/admin/users" both
  // redirect a customer away before rendering), so this is safe without a
  // customer-specific allowlist.
  const pageSearchLabelKey =
    variant === "staff" || pathname === "/tickets" ? PAGE_SEARCH_TARGETS[pathname] : undefined;
  const pageSearchAction = trimmedQuery && pageSearchLabelKey
    ? { key: "__pageSearch__", label: t(pageSearchLabelKey, { query: trimmedQuery }) }
    : null;

  function goToPageSearch() {
    const params = new URLSearchParams(searchParams.toString());
    params.set("q", trimmedQuery);
    params.delete("page");
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
    router.push(`${pathname}?${params.toString()}`);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  function go(href: string) {
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
    router.push(href);
  }

  return (
    <div className="relative min-w-0 flex-1 sm:max-w-64 sm:flex-none">
      <div className="flex h-9 w-full min-w-0 items-center gap-2 rounded-xl border border-input bg-muted/40 px-3 text-sm text-muted-foreground shadow-soft transition-colors focus-within:border-ring focus-within:bg-card sm:w-52 lg:w-64">
        <Search className="size-4 shrink-0" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              if (pageSearchAction) goToPageSearch();
              else if (matches[0]) go(matches[0].href);
            }
            if (e.key === "Escape") inputRef.current?.blur();
          }}
          placeholder={t("searchPlaceholderShort")}
          className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
          aria-label={t("search")}
        />
        <kbd className="hidden shrink-0 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground lg:inline">
          ⌘K
        </kbd>
      </div>
      {open && (pageSearchAction || matches.length > 0) && (
        <ul className="absolute start-0 top-full z-30 mt-1.5 w-full min-w-48 overflow-hidden rounded-xl border border-border bg-popover py-1 text-popover-foreground shadow-card">
          {pageSearchAction && (
            <li>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={goToPageSearch}
                className="flex w-full items-center gap-2.5 border-b border-border px-3 py-2 text-start text-sm font-medium text-primary hover:bg-primary/5"
              >
                <Search className="size-4" />
                {pageSearchAction.label}
              </button>
            </li>
          )}
          {matches.map((item) => (
            <li key={item.key}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => go(item.href)}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-start text-sm hover:bg-muted"
              >
                <item.icon className="size-4 text-muted-foreground" />
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
