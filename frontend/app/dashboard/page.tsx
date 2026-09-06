import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { Users, Ticket, ShieldUser, BarChart3, ArrowRight, Lock } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { API_URL, SESSION_COOKIE, REFRESH_COOKIE } from "@/lib/auth";
import { peekJwtPayload } from "@/lib/jwt";
import { StaffSidebar } from "@/components/StaffSidebar";
import { cn } from "@/lib/utils";
import { fetchWorkspace } from "@/app/actions/workspace";
import { TriageBoard } from "./TriageBoard";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Dashboard");
  return { title: t("heading"), robots: { index: false, follow: false } };
}

// A tile a viewer lacks permission for stays visible but inert — greyed
// out, not a Link, lock icon instead of the arrow — rather than
// disappearing outright, so the dashboard's shape reflects what the
// platform offers even to a viewer who can't reach every part of it.
function DashboardTile({
  href,
  enabled,
  icon: Icon,
  accent,
  title,
  body,
  note,
  disabledNote,
}: {
  href: string;
  enabled: boolean;
  icon: LucideIcon;
  accent: "--primary" | "--chart-2" | "--chart-3" | "--chart-4";
  title: string;
  body: string;
  note: string;
  disabledNote: string;
}) {
  const className = cn(
    "group/tile relative flex min-h-[168px] flex-col justify-between overflow-hidden rounded-2xl border p-5 shadow-soft transition-all duration-200",
    enabled ? "border-border hover:-translate-y-0.5 hover:shadow-card" : "border-border/60 opacity-60"
  );
  const style = {
    background: `linear-gradient(150deg, color-mix(in oklch, var(${accent}) ${enabled ? 14 : 6}%, var(--card)), var(--card))`,
  };
  const content = (
    <>
      <span
        aria-hidden
        className="pointer-events-none absolute -bottom-8 -end-8 size-36 rounded-full opacity-50"
        style={{
          background: `radial-gradient(circle at 30% 30%, color-mix(in oklch, var(${accent}) ${enabled ? 55 : 25}%, transparent), transparent 70%)`,
        }}
      />
      <div
        className="grid size-10 place-items-center rounded-xl"
        style={
          enabled
            ? { background: `color-mix(in oklch, var(${accent}) 20%, var(--card))`, color: `var(${accent})` }
            : undefined
        }
      >
        <Icon className={cn("size-5", !enabled && "text-muted-foreground")} />
      </div>
      <div>
        <h2 className="text-base font-bold">{title}</h2>
        <p className="mt-0.5 max-w-[30ch] text-sm text-muted-foreground">{body}</p>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{enabled ? note : disabledNote}</span>
        <span className="grid size-8 place-items-center rounded-full border border-border bg-card text-foreground transition-transform group-hover/tile:translate-x-0.5 rtl:group-hover/tile:-translate-x-0.5">
          {enabled ? <ArrowRight className="size-3.5 rtl:-scale-x-100" /> : <Lock className="size-3.5" />}
        </span>
      </div>
    </>
  );

  if (!enabled) {
    return (
      <div className={className} style={style} aria-disabled="true">
        {content}
      </div>
    );
  }

  return (
    <Link href={href} className={className} style={style}>
      {content}
    </Link>
  );
}

// Staff landing page. Not shown to customers: there's no natural 403 to
// lean on here (unlike /customers or /admin/users), so the role check
// happens directly against the access token first, same pattern as
// customers/new/page.tsx — but which tiles actually render comes from a
// live GET /api/v1/me/status call, not the token's baked-in role/
// permissions claims. Those claims are only as fresh as the last login/
// refresh (~15min access-token lifetime): an admin revoking a permission or
// deactivating the account mid-session doesn't touch the still-signed
// token, so a tile driven by the token alone would keep showing (and, pre-
// deactivation, actually working) for up to 15 more minutes — the exact
// gap closed API-side in services/permissions.ts's isActiveAccount. A
// deactivated account gets logged out outright here instead of just having
// its tiles hidden — there's nothing else on this page for it to do.
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ _refreshed?: string }>;
}) {
  const { _refreshed } = await searchParams;
  const t = await getTranslations("Dashboard");
  const tNav = await getTranslations("Nav");

  const cookieStore = await cookies();
  const accessToken = cookieStore.get(SESSION_COOKIE)?.value;
  const hasRefreshToken = Boolean(cookieStore.get(REFRESH_COOKIE)?.value);

  if (!accessToken) {
    if (hasRefreshToken && !_refreshed) {
      redirect("/api/session/refresh?next=/dashboard");
    }
    redirect("/");
  }

  const { role: tokenRole, name } = peekJwtPayload(accessToken);
  const isStaff = tokenRole === "agent" || tokenRole === "admin" || tokenRole === "subadmin";
  if (!isStaff) {
    redirect("/");
  }

  const statusRes = await fetch(`${API_URL}/api/v1/me/status`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });

  if (statusRes.status === 401 && !_refreshed) {
    redirect("/api/session/refresh?next=/dashboard");
  }
  if (!statusRes.ok) {
    redirect("/");
  }

  const { role, isActive, permissions }: { role: string; isActive: boolean; permissions: string[] } =
    await statusRes.json();

  if (!isActive) {
    redirect("/api/session/deactivated");
  }

  // Mirrors the actual route gates: admin always reaches /customers, agent
  // and sub-admin both only with a customers:manage grant (see
  // backend/src/routes/customer.routes.ts's staffOrDelegatedSubadmin);
  // /admin/users needs staff:view_list, which only admin or a delegated
  // sub-admin can ever hold (see SUBADMIN_ONLY_PERMISSIONS). A viewer
  // without the gate still sees the tile (per feedback: dashboard sections
  // the viewer lacks permission for stay visible but unclickable, not
  // hidden) — DashboardTile renders it disabled instead of omitting it.
  // /tickets has no such gate — every staff role reaches a working queue.
  const canViewTickets = true;
  const canViewCustomers = role === "admin" || permissions.includes("customers:manage");
  const canViewAccounts = role === "admin" || permissions.includes("staff:view_list");
  // reports-management Stories 40/41: reports:view is agent-grantable by
  // default (DEFAULT_PERMISSIONS_BY_ROLE), not admin/subadmin-tier only —
  // same shape as canViewCustomers above, not canViewAccounts.
  const canViewReports = role === "admin" || permissions.includes("reports:view");

  // agent-workspace Story 35: the triage board is "my assigned queue", so it
  // renders for role `agent` only — admins/sub-admins are never auto-assigned
  // tickets (assignment.service.ts picks role: "agent") and don't claim chats,
  // so their board would be permanently empty. Their dashboard is exactly what
  // it was before this story: the tile grid, nothing else. Cross-agent
  // oversight is a separate story.
  //
  // fetchWorkspace() returns null (never throws) on any failure — the board is
  // then skipped and the page renders the tile grid plus a one-line notice.
  // Deliberately no redirect here: the page's session-refresh/deactivation
  // redirects above are driven by the /me/status call, not by this one.
  const isAgent = role === "agent";
  const workspace = isAgent ? await fetchWorkspace() : null;

  return (
    <div className="flex min-h-[calc(100vh-57px)]">
      <StaffSidebar active="dashboard" />
      <main className="min-w-0 flex-1 p-4 md:p-8">
        <div className="mb-7">
          <h1 className="text-2xl font-extrabold tracking-tight text-balance">
            {t("greeting", { name: name?.split(" ")[0] || "" })}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("subheading")}</p>
        </div>

        {isAgent && workspace ? <TriageBoard initialColumns={workspace.columns} /> : null}
        {isAgent && !workspace ? <p className="mb-9 text-sm text-muted-foreground">{t("triage.unavailable")}</p> : null}

        {isAgent ? <h2 className="mb-3 text-lg font-bold tracking-tight">{t("triage.sectionsHeading")}</h2> : null}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <DashboardTile
            href="/tickets"
            enabled={canViewTickets}
            icon={Ticket}
            accent="--chart-3"
            title={tNav("tickets")}
            body={t("ticketsTileBody")}
            note={t("ticketsTileNote")}
            disabledNote={t("noAccessNote")}
          />

          <DashboardTile
            href="/customers"
            enabled={canViewCustomers}
            icon={Users}
            accent="--primary"
            title={tNav("customers")}
            body={t("customersTileBody")}
            note={t("customersTileNote")}
            disabledNote={t("noAccessNote")}
          />

          <DashboardTile
            href="/admin/users"
            enabled={canViewAccounts}
            icon={ShieldUser}
            accent="--chart-2"
            title={tNav("accounts")}
            body={t("accountsTileBody")}
            note={t("accountsTileNote")}
            disabledNote={t("noAccessNote")}
          />

          <DashboardTile
            href="/admin/reports"
            enabled={canViewReports}
            icon={BarChart3}
            accent="--chart-4"
            title={t("reportsTileTitle")}
            body={t("reportsTileBody")}
            note={t("reportsTileNote")}
            disabledNote={t("noAccessNote")}
          />
        </div>
      </main>
    </div>
  );
}
