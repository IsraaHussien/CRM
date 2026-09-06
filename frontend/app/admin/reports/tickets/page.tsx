import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { API_URL, SESSION_COOKIE, REFRESH_COOKIE } from "@/lib/auth";
import { SOURCE_LABEL_KEY, SOURCE_EMOJI, SOURCE_BADGE_CLASS, type TicketCreationChannel } from "@/lib/ticketSource";
import { TimeSeriesBarChart } from "@/components/reports/TimeSeriesBarChart";
import { TicketReportFilterBar } from "./TicketReportFilterBar";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("AdminReports.tickets");
  return { title: t("pageTitle"), robots: { index: false, follow: false } };
}

interface TicketReportResponse {
  totals: { count: number };
  trend: { bucket: string; count: number }[];
  byCategory: { category: string | null; count: number }[];
  bySource: { createdVia: TicketCreationChannel | null; count: number }[];
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function defaultRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime());
  from.setUTCDate(from.getUTCDate() - 29);
  return { from: isoDate(from), to: isoDate(to) };
}

function bucketLabel(bucket: string, grouping: string): string {
  if (grouping === "month") {
    const [y, m] = bucket.split("-");
    return new Date(Date.UTC(Number(y), Number(m) - 1, 1)).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  }
  return new Date(`${bucket}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

interface SearchParams {
  from?: string;
  to?: string;
  grouping?: string;
  category?: string;
  _refreshed?: string;
}

export default async function TicketReportsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { from: fromParam, to: toParam, grouping: groupingParam, category, _refreshed } = await searchParams;
  const defaults = defaultRange();
  const from = fromParam ?? defaults.from;
  const to = toParam ?? defaults.to;
  const grouping = groupingParam === "week" || groupingParam === "month" ? groupingParam : "day";

  const t = await getTranslations("AdminReports.tickets");
  // Source labels ("Customer", "Staff · Phone", ...) already exist under the
  // "Tickets" namespace for StaffTicketQueue.tsx — reused here rather than
  // duplicated under AdminReports.
  const tSource = await getTranslations("Tickets");

  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  const hasRefreshToken = Boolean(cookieStore.get(REFRESH_COOKIE)?.value);

  const currentQuery = new URLSearchParams();
  currentQuery.set("from", from);
  currentQuery.set("to", to);
  currentQuery.set("grouping", grouping);
  if (category) currentQuery.set("category", category);
  const nextUrl = `/admin/reports/tickets?${currentQuery.toString()}`;

  if (!token) {
    if (hasRefreshToken && !_refreshed) redirect(`/api/session/refresh?next=${encodeURIComponent(nextUrl)}`);
    redirect("/");
  }

  const [reportRes, categoriesRes] = await Promise.all([
    fetch(`${API_URL}/api/v1/reports/tickets?${currentQuery.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    }),
    fetch(`${API_URL}/api/v1/ticket-categories?active=true`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    }),
  ]);

  if (reportRes.status === 401) {
    if (!_refreshed) redirect(`/api/session/refresh?next=${encodeURIComponent(nextUrl)}`);
    redirect("/login");
  }
  if (reportRes.status === 403) redirect("/dashboard");
  if (!reportRes.ok) redirect("/");

  const report: TicketReportResponse = await reportRes.json();
  const categories: { name: string }[] = categoriesRes.ok ? await categoriesRes.json() : [];

  const days = Math.max(1, Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000) + 1);
  const dailyAverage = (report.totals.count / days).toFixed(1);
  const topCategory = [...report.byCategory].sort((a, b) => b.count - a.count)[0];

  const chartData = report.trend.map((p) => ({ bucket: p.bucket, label: bucketLabel(p.bucket, grouping), value: p.count }));

  const exportQuery = new URLSearchParams(currentQuery);
  const exportHref = `/api/reports/tickets/export?${exportQuery.toString()}`;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-[70ch] text-sm text-muted-foreground">{t("pageDescription")}</p>
        <Button asChild size="sm">
          <a href={exportHref}>{t("exportCsv")}</a>
        </Button>
      </div>

      <TicketReportFilterBar defaultFrom={defaults.from} defaultTo={defaults.to} categories={categories.map((c) => c.name)} />

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-border bg-card p-4">
          <p className="text-xs font-semibold text-muted-foreground">{t("statTotal")}</p>
          <p className="mt-1 text-2xl font-extrabold text-chart-1">{report.totals.count}</p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4">
          <p className="text-xs font-semibold text-muted-foreground">{t("statAverage")}</p>
          <p className="mt-1 text-2xl font-extrabold">{dailyAverage}</p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4">
          <p className="text-xs font-semibold text-muted-foreground">{t("statTopCategory")}</p>
          <p className="mt-1 truncate text-lg font-bold">{topCategory ? (topCategory.category ?? t("uncategorized")) : "–"}</p>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        <h2 className="mb-1 text-sm font-bold">{t("chartTitle")}</h2>
        <p className="mb-3 text-xs text-muted-foreground">{t("chartSubtitle")}</p>
        <TimeSeriesBarChart data={chartData} color="var(--chart-1)" valueLabel={t("statTotal")} emptyMessage={t("emptyState")} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-border bg-card p-4">
          <h2 className="mb-3 text-sm font-bold">{t("byCategoryTitle")}</h2>
          {report.byCategory.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">{t("emptyState")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columnCategory")}</TableHead>
                  <TableHead className="text-end">{t("columnCount")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.byCategory.map((row) => (
                  <TableRow key={row.category ?? "__uncategorized__"}>
                    <TableCell>{row.category ?? t("uncategorized")}</TableCell>
                    <TableCell className="text-end">{row.count}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        <div className="rounded-2xl border border-border bg-card p-4">
          <h2 className="mb-3 text-sm font-bold">{t("bySourceTitle")}</h2>
          {report.bySource.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">{t("emptyState")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columnSource")}</TableHead>
                  <TableHead className="text-end">{t("columnCount")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.bySource.map((row) => (
                  <TableRow key={row.createdVia ?? "__unknown__"}>
                    <TableCell>
                      {row.createdVia ? (
                        <Badge variant="outline" className={`gap-1 ${SOURCE_BADGE_CLASS[row.createdVia]}`}>
                          <span aria-hidden="true">{SOURCE_EMOJI[row.createdVia]}</span>
                          {tSource(SOURCE_LABEL_KEY[row.createdVia])}
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-muted-foreground">
                          {tSource("sourceUnknown")}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-end">{row.count}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">{t("utcNote")}</p>
    </div>
  );
}
