"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { ListFilter, CalendarRange, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { FilterField } from "@/components/FilterField";
import { DatePickerField } from "@/components/DatePickerField";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const ALL = "__all__";

// Server-driven filtering, same pattern as admin/users/AdminUsersFilterBar.tsx
// (not tickets/TicketFilterBar.tsx's full-screen-dialog variant — that's a
// different, earlier-superseded UI direction for a different list). `q`
// isn't a control here either — it's driven by HeaderSearch, same reasoning
// as AdminUsersFilterBar, and shown as a removable chip when active.
export function AuditLogFilterBar() {
  const t = useTranslations("AuditLogList");
  const router = useRouter();
  const searchParams = useSearchParams();

  const category = searchParams.get("category") ?? ALL;
  const q = searchParams.get("q");
  const dateFrom = searchParams.get("dateFrom") ?? "";
  const dateTo = searchParams.get("dateTo") ?? "";
  const dateFromDate = dateFrom ? new Date(`${dateFrom}T00:00:00`) : undefined;
  const dateToDate = dateTo ? new Date(`${dateTo}T00:00:00`) : undefined;

  function updateParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === ALL) {
      params.delete(key);
    } else {
      params.set(key, value);
    }
    params.delete("page");
    router.push(`/admin/audit-logs?${params.toString()}`);
  }

  function updateDateParam(key: "dateFrom" | "dateTo", value: Date | undefined) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set(key, format(value, "yyyy-MM-dd"));
    } else {
      params.delete(key);
    }
    params.delete("page");
    router.push(`/admin/audit-logs?${params.toString()}`);
  }

  function clearSearch() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("q");
    params.delete("page");
    router.push(`/admin/audit-logs?${params.toString()}`);
  }

  const hasActiveFilter = category !== ALL || Boolean(dateFrom || dateTo) || Boolean(q);

  return (
    <div className="mb-4 flex flex-col gap-3 rounded-2xl border border-border bg-card/50 p-3 sm:p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:gap-x-5 sm:gap-y-3">
        {q && (
          <FilterField label={t("filterSearch")}>
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-between border-primary/50 bg-primary/5 text-primary sm:w-auto"
              onClick={clearSearch}
            >
              <span className="max-w-40 truncate">{t("searchingFor", { query: q })}</span>
              <X className="size-3.5" />
            </Button>
          </FilterField>
        )}

        <FilterField label={t("filterCategory")}>
          <Select value={category} onValueChange={(v) => updateParam("category", v)}>
            <SelectTrigger
              className={cn("w-full sm:w-64", category !== ALL && "border-primary/50 bg-primary/5 text-primary")}
              size="sm"
            >
              <ListFilter className={cn("size-3.5", category !== ALL ? "text-primary" : "text-muted-foreground")} />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("filterAll")}</SelectItem>
              <SelectItem value="auth">{t("categoryAuth")}</SelectItem>
              <SelectItem value="permissions">{t("categoryPermissions")}</SelectItem>
              <SelectItem value="staff">{t("categoryStaff")}</SelectItem>
              <SelectItem value="tickets">{t("categoryTickets")}</SelectItem>
              <SelectItem value="customers">{t("categoryCustomers")}</SelectItem>
              <SelectItem value="live-chat">{t("categoryLiveChat")}</SelectItem>
              <SelectItem value="knowledge-base">{t("categoryKnowledgeBase")}</SelectItem>
              <SelectItem value="sla">{t("categorySla")}</SelectItem>
              <SelectItem value="feedback">{t("categoryFeedback")}</SelectItem>
            </SelectContent>
          </Select>
        </FilterField>

        <FilterField label={t("filterDateRange")} className="sm:ms-auto">
          <div className="flex items-center gap-2">
            <CalendarRange className="hidden size-3.5 shrink-0 text-icon-date sm:block" />
            <DatePickerField
              id="audit-log-date-from"
              className="flex-1 sm:w-44"
              placeholder={t("filterDateFrom")}
              value={dateFromDate}
              maxDate={dateToDate}
              onChange={(v) => updateDateParam("dateFrom", v)}
            />
            <span className="text-xs text-muted-foreground" aria-hidden>
              –
            </span>
            <DatePickerField
              id="audit-log-date-to"
              className="flex-1 sm:w-44"
              placeholder={t("filterDateTo")}
              value={dateToDate}
              minDate={dateFromDate}
              onChange={(v) => updateDateParam("dateTo", v)}
            />
          </div>
        </FilterField>
      </div>

      {/* Its own row, outside the filters/sort wrap flow above, per this
          app's reset-button convention (see AdminUsersFilterBar). */}
      {hasActiveFilter && (
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => router.push("/admin/audit-logs")}
          >
            <X className="size-3.5" />
            {t("resetFilters")}
          </Button>
        </div>
      )}
    </div>
  );
}
