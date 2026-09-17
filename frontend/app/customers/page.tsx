import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { API_URL, SESSION_COOKIE, REFRESH_COOKIE } from "@/lib/auth";
import { peekJwtPayload } from "@/lib/jwt";
import { StaffSidebar } from "@/components/StaffSidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ListPagination } from "@/components/ListPagination";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { CustomerFilterBar } from "./CustomerFilterBar";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("CustomersList");
  return { title: t("heading"), robots: { index: false, follow: false } };
}

interface CustomerRow {
  id: string;
  name: string;
  email: string;
  membershipNumber: string;
  phone: string | null;
  isActive: boolean;
  createdAt: string;
}

// Staff-only roster (agent/admin) — see backend/src/routes/customer.routes.ts's
// GET / for why this exists outside the original story backlog. One row per
// customer; this is deliberately NOT where per-ticket detail lives — that's
// a separate, ticket-management-owned table/list later (one row per ticket,
// customer name linking back to /customers/[id]), not merged into this one.
interface CustomersListSearchParams {
  page?: string;
  q?: string;
  isActive?: string;
  sort?: string;
  _refreshed?: string;
}

export default async function CustomersListPage({
  searchParams,
}: {
  searchParams: Promise<CustomersListSearchParams>;
}) {
  const { page: pageParam, q, isActive, sort, _refreshed } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);
  const t = await getTranslations("CustomersList");

  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  const hasRefreshToken = Boolean(cookieStore.get(REFRESH_COOKIE)?.value);

  const currentQuery = new URLSearchParams();
  if (q) currentQuery.set("q", q);
  if (isActive) currentQuery.set("isActive", isActive);
  if (sort) currentQuery.set("sort", sort);
  const nextUrl = `/customers${currentQuery.toString() ? `?${currentQuery.toString()}` : ""}`;

  if (!token) {
    if (hasRefreshToken && !_refreshed) {
      redirect(`/api/session/refresh?next=${encodeURIComponent(nextUrl)}`);
    }
    redirect("/");
  }

  const listQuery = new URLSearchParams(currentQuery);
  listQuery.set("page", String(page));
  listQuery.set("limit", "10");

  const res = await fetch(`${API_URL}/api/v1/customers?${listQuery.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  if (res.status === 401) {
    if (!_refreshed) {
      redirect(`/api/session/refresh?next=${encodeURIComponent(nextUrl)}`);
    }
    redirect("/login");
  }

  if (res.status === 403) {
    // A persona without customers:manage never gets a working link to this
    // page (see lib/staffNav.ts), so reaching it and being turned away
    // belongs on the dashboard, not a dead-end message here.
    redirect("/dashboard");
  }

  if (!res.ok) {
    redirect("/");
  }

  const data: { customers: CustomerRow[]; total: number; page: number; limit: number } =
    await res.json();

  function hrefForPage(nextPage: number) {
    const params = new URLSearchParams(currentQuery);
    params.set("page", String(nextPage));
    return `/customers?${params.toString()}`;
  }

  // Mirrors backend/src/routes/customer.routes.ts's GET /:id gate exactly —
  // admin always, agent and sub-admin both only with the same
  // customers:manage grant the roster itself required to load. A
  // name/history link a click would just 403 on isn't a link — render as
  // plain text instead.
  const { role: viewerRole, permissions: viewerPermissions = [] } = peekJwtPayload(token);
  const canViewCustomerDetail =
    viewerRole === "admin" || viewerPermissions.includes("customers:manage");

  return (
    <div className="flex min-h-[calc(100vh-57px)]">
      <StaffSidebar active="customers" />
      <main className="min-w-0 flex-1 p-4 md:p-8">
        <div className="mb-6 flex items-center justify-between gap-3">
          <h1 className="text-xl font-bold tracking-tight md:text-2xl">{t("heading")}</h1>
          <Button asChild size="sm">
            <Link href="/customers/new">{t("addCustomer")}</Link>
          </Button>
        </div>

        <CustomerFilterBar />

        {data.customers.length === 0 ? (
          <p className="py-8 text-center text-muted-foreground">{t("empty")}</p>
        ) : (
          <>
            {/* Mobile (< md): stacked cards — a wide table forced into a
                narrow viewport either overflows the page or becomes an
                unreadable horizontal-scroll strip; a table just isn't the
                right shape for this data below a certain width. */}
            <div className="flex flex-col gap-3 md:hidden">
              {data.customers.map((c) => (
                <div key={c.id} className="rounded-xl border border-border p-4">
                  <div className="flex items-start justify-between gap-2">
                    {canViewCustomerDetail ? (
                      <Link href={`/customers/${c.id}`} className="font-medium text-primary hover:underline">
                        {c.name}
                      </Link>
                    ) : (
                      <span className="font-medium">{c.name}</span>
                    )}
                    {c.isActive ? (
                      <Badge variant="outline" className="shrink-0 border-transparent bg-success/10 text-success">
                        {t("statusActive")}
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="shrink-0">
                        {t("statusInactive")}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 truncate text-sm text-muted-foreground">{c.email}</p>
                  <p className="mt-0.5 font-mono text-xs text-muted-foreground">{c.membershipNumber}</p>
                  <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
                    <span>{c.phone ?? "—"}</span>
                    <span>{new Date(c.createdAt).toLocaleDateString()}</span>
                  </div>
                  {canViewCustomerDetail && (
                    <Link
                      href={`/customers/${c.id}?tab=history`}
                      className="mt-3 inline-block text-sm text-primary hover:underline"
                    >
                      {t("history")}
                    </Link>
                  )}
                </div>
              ))}
            </div>

            {/* md and up: the real table. */}
            <div className="hidden overflow-hidden rounded-2xl border border-border md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("colName")}</TableHead>
                    <TableHead>{t("colMembershipNumber")}</TableHead>
                    <TableHead>{t("colEmail")}</TableHead>
                    <TableHead>{t("colPhone")}</TableHead>
                    <TableHead>{t("colStatus")}</TableHead>
                    <TableHead>{t("colJoined")}</TableHead>
                    <TableHead>{t("colHistory")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.customers.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>
                        {canViewCustomerDetail ? (
                          <Link href={`/customers/${c.id}`} className="font-medium text-primary hover:underline">
                            {c.name}
                          </Link>
                        ) : (
                          <span className="font-medium">{c.name}</span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-sm text-muted-foreground">{c.membershipNumber}</TableCell>
                      <TableCell>{c.email}</TableCell>
                      <TableCell>{c.phone ?? "—"}</TableCell>
                      <TableCell>
                        {c.isActive ? (
                          <Badge variant="outline" className="border-transparent bg-success/10 text-success">
                            {t("statusActive")}
                          </Badge>
                        ) : (
                          <Badge variant="secondary">{t("statusInactive")}</Badge>
                        )}
                      </TableCell>
                      <TableCell>{new Date(c.createdAt).toLocaleDateString()}</TableCell>
                      <TableCell>
                        {canViewCustomerDetail && (
                          <Link href={`/customers/${c.id}?tab=history`} className="text-sm text-primary hover:underline">
                            {t("history")}
                          </Link>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
        <div className="mt-4">
          <ListPagination total={data.total} page={data.page} limit={data.limit} hrefForPage={hrefForPage} />
        </div>
      </main>
    </div>
  );
}
