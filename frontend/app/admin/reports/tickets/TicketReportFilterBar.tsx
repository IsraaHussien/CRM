"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { CalendarRange, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { FilterField } from "@/components/FilterField";
import { DatePickerField } from "@/components/DatePickerField";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const ALL = "__all__";

// Same server-driven filter-bar shape as AuditLogFilterBar — URL search
// params are the only state, the server component re-fetches on navigation.
export function TicketReportFilterBar({
  defaultFrom,
  defaultTo,
  categories,
}: {
  defaultFrom: string;
  defaultTo: string;
  categories: string[];
}) {
  const t = useTranslations("AdminReports.tickets");
  const router = useRouter();
  const searchParams = useSearchParams();

  const from = searchParams.get("from") ?? defaultFrom;
  const to = searchParams.get("to") ?? defaultTo;
  const grouping = searchParams.get("grouping") ?? "day";
  const category = searchParams.get("category") ?? ALL;

  function updateParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (!value || value === ALL) params.delete(key);
    else params.set(key, value);
    router.push(`/admin/reports/tickets?${params.toString()}`);
  }

  function updateDateParam(key: "from" | "to", value: Date | undefined) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, format(value, "yyyy-MM-dd"));
    else params.delete(key);
    router.push(`/admin/reports/tickets?${params.toString()}`);
  }

  const hasActiveFilter = from !== defaultFrom || to !== defaultTo || grouping !== "day" || category !== ALL;

  return (
    <div className="mb-4 flex flex-col gap-3 rounded-2xl border border-border bg-card/50 p-3 sm:p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:gap-x-5 sm:gap-y-3">
        <FilterField label={t("filterDateRange")}>
          <div className="flex items-center gap-2">
            <CalendarRange className="hidden size-3.5 shrink-0 text-icon-date sm:block" />
            <DatePickerField
              id="ticket-report-from"
              className="flex-1 sm:w-44"
              placeholder={t("filterDateFrom")}
              value={new Date(`${from}T00:00:00`)}
              maxDate={new Date(`${to}T00:00:00`)}
              onChange={(v) => updateDateParam("from", v)}
            />
            <span className="text-xs text-muted-foreground" aria-hidden>
              –
            </span>
            <DatePickerField
              id="ticket-report-to"
              className="flex-1 sm:w-44"
              placeholder={t("filterDateTo")}
              value={new Date(`${to}T00:00:00`)}
              minDate={new Date(`${from}T00:00:00`)}
              onChange={(v) => updateDateParam("to", v)}
            />
          </div>
        </FilterField>

        <FilterField label={t("filterGroupBy")}>
          <Select value={grouping} onValueChange={(v) => updateParam("grouping", v)}>
            <SelectTrigger className="w-full sm:w-36" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="day">{t("groupByDay")}</SelectItem>
              <SelectItem value="week">{t("groupByWeek")}</SelectItem>
              <SelectItem value="month">{t("groupByMonth")}</SelectItem>
            </SelectContent>
          </Select>
        </FilterField>

        <FilterField label={t("filterCategory")}>
          <Select value={category} onValueChange={(v) => updateParam("category", v)}>
            <SelectTrigger
              className={cn("w-full sm:w-56", category !== ALL && "border-primary/50 bg-primary/5 text-primary")}
              size="sm"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("filterAll")}</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FilterField>
      </div>

      {/* Own row, outside the filters flex-wrap, per this app's
          reset-button convention. */}
      {hasActiveFilter && (
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => router.push("/admin/reports/tickets")}
          >
            <X className="size-3.5" />
            {t("resetFilters")}
          </Button>
        </div>
      )}
    </div>
  );
}
