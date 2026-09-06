import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { API_URL, SESSION_COOKIE, REFRESH_COOKIE } from "@/lib/auth";
import { TimeSeriesBarChart } from "@/components/reports/TimeSeriesBarChart";
import { SlaReportFilterBar } from "./SlaReportFilterBar";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("AdminReports.sla");
  return { title: t("pageTitle"), robots: { index: false, follow: false } };
}

interface SlaBreakdownRow {
  key: string;
  label: string;
  total: number;
  breached: number;
}

interface SlaEntityReport {
  total: number;
  breached: number;
  complianceRate: number | null;
  byAgent: SlaBreakdownRow[];
  byCategory?: SlaBreakdownRow[];
  byPriority?: SlaBreakdownRow[];
  trend: { bucket: string; breaches: number }[];
}

interface SlaReportResponse {
  tickets: SlaEntityReport | null;
  conversations: SlaEntityReport | null;
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

function pct(rate: number | null): string {
  return rate === null ? "–" : `${Math.round(rate * 1000) / 10}%`;
}

// Small SVG compliance ring — success-green fill for compliant share,
// destructive-red for the rest. Status color (good/bad), not a categorical
// hue, per the app's semantic-color convention.
function ComplianceRing({ rate }: { rate: number | null }) {
  const size = 64;
  const r = 25;
  const stroke = 9;
  const circumference = 2 * Math.PI * r;
  const dash = rate === null ? 0 : Math.max(rate * circumference - 1, 0);
  const color = rate === null ? "var(--muted-foreground)" : rate >= 0.9 ? "var(--success)" : "var(--destructive)";
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--muted)" strokeWidth={stroke} />
      {rate !== null && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference - dash}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      )}
    </svg>
  );
}

interface SearchParams {
  from?: string;
  to?: string;
  scope?: string;
  _refreshed?: string;
}

export default async function SlaReportPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { from: fromParam, to: toParam, scope: scopeParam, _refreshed } = await searchParams;
  const defaults = defaultRange();
  const from = fromParam ?? defaults.from;
  const to = toParam ?? defaults.to;
  const scope = scopeParam === "tickets" || scopeParam === "conversations" ? scopeParam : "all";

  const t = await getTranslations("AdminReports.sla");

  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  const hasRefreshToken = Boolean(cookieStore.get(REFRESH_COOKIE)?.value);

  const currentQuery = new URLSearchParams();
  currentQuery.set("from", from);
  currentQuery.set("to", to);
  currentQuery.set("scope", scope);
  const nextUrl = `/admin/reports/sla?${currentQuery.toString()}`;

  if (!token) {
    if (hasRefreshToken && !_refreshed) redirect(`/api/session/refresh?next=${encodeURIComponent(nextUrl)}`);
    redirect("/");
  }

  const res = await fetch(`${API_URL}/api/v1/reports/sla?${currentQuery.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  if (res.status === 401) {
    if (!_refreshed) redirect(`/api/session/refresh?next=${encodeURIComponent(nextUrl)}`);
    redirect("/login");
  }
  if (res.status === 403) redirect("/dashboard");
  if (!res.ok) redirect("/");

  const report: SlaReportResponse = await res.json();

  function renderEntity(title: string, data: SlaEntityReport, trendCaption: string, breakdownTitles: { agent: string; category?: string; priority?: string }) {
    const chartData = data.trend.map((p) => ({
      bucket: p.bucket,
      label: new Date(`${p.bucket}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
      value: p.breaches,
    }));

    function renderBreakdownTable(rows: SlaBreakdownRow[], nameHeader: string) {
      if (rows.length === 0) return <p className="py-4 text-center text-sm text-muted-foreground">{t("emptyState")}</p>;
      const sorted = [...rows].sort((a, b) => b.breached - a.breached);
      return (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{nameHeader}</TableHead>
              <TableHead className="text-end">{t("columnTotal")}</TableHead>
              <TableHead className="text-end">{t("columnBreached")}</TableHead>
              <TableHead className="text-end">{t("columnCompliance")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((row) => {
              const rate = row.total > 0 ? 1 - row.breached / row.total : null;
              return (
                <TableRow key={row.key}>
                  <TableCell>{row.label}</TableCell>
                  <TableCell className="text-end">{row.total}</TableCell>
                  <TableCell className="text-end">{row.breached}</TableCell>
                  <TableCell className={`text-end font-bold ${rate === null ? "" : rate >= 0.9 ? "text-success" : "text-destructive"}`}>
                    {pct(rate)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      );
    }

    return (
      <div className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-4">
        <h2 className="text-base font-bold">{title}</h2>

        <div className="grid gap-3 sm:grid-cols-[auto_1fr_1fr]">
          <div className="flex items-center gap-3 rounded-xl border border-border p-3">
            <ComplianceRing rate={data.complianceRate} />
            <div>
              <p className="text-xl font-extrabold">{pct(data.complianceRate)}</p>
              <p className="text-xs font-semibold text-muted-foreground">{t("statCompliance")}</p>
            </div>
          </div>
          <div className="min-w-0 rounded-xl border border-border p-3">
            <p className="text-xs font-semibold text-muted-foreground">{t("statTotal")}</p>
            <p className="mt-1 text-2xl font-extrabold">{data.total}</p>
          </div>
          <div className="min-w-0 rounded-xl border border-border p-3">
            <p className="text-xs font-semibold text-muted-foreground">{t("statBreached")}</p>
            <p className="mt-1 text-2xl font-extrabold text-destructive">{data.breached}</p>
          </div>
        </div>

        <div>
          <h3 className="mb-1 text-sm font-bold">{t("trendTitle")}</h3>
          <p className="mb-3 text-xs text-muted-foreground">{trendCaption}</p>
          <TimeSeriesBarChart data={chartData} color="var(--destructive)" valueLabel={t("columnBreached")} emptyMessage={t("emptyState")} />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="min-w-0">
            <h3 className="mb-2 text-sm font-bold">{breakdownTitles.agent}</h3>
            {renderBreakdownTable(data.byAgent, t("columnAgent"))}
          </div>
          {data.byCategory && (
            <div className="min-w-0">
              <h3 className="mb-2 text-sm font-bold">{breakdownTitles.category}</h3>
              {renderBreakdownTable(data.byCategory, t("columnCategory"))}
            </div>
          )}
          {data.byPriority && (
            <div className="min-w-0">
              <h3 className="mb-2 text-sm font-bold">{breakdownTitles.priority}</h3>
              {renderBreakdownTable(data.byPriority, t("columnPriority"))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="max-w-[70ch] text-sm text-muted-foreground">{t("pageDescription")}</p>

      <SlaReportFilterBar defaultFrom={defaults.from} defaultTo={defaults.to} />

      {report.tickets && renderEntity(t("ticketsTitle"), report.tickets, t("trendCaptionTickets"), { agent: t("byAgentTitle"), category: t("byCategoryTitle"), priority: t("byPriorityTitle") })}
      {report.conversations && renderEntity(t("conversationsTitle"), report.conversations, t("trendCaptionConversations"), { agent: t("byAgentTitle") })}

      <p className="text-xs text-muted-foreground">{t("utcNote")}</p>
    </div>
  );
}
