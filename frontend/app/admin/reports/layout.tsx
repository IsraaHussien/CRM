import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { StaffSidebar } from "@/components/StaffSidebar";
import { ReportsTabs } from "./ReportsTabs";

export async function generateMetadata() {
  const t = await getTranslations("AdminReports");
  return { title: t("heading"), robots: { index: false, follow: false } };
}

// reports-management: shared shell over /admin/reports/* — same pattern as
// system-configuration's layout (real per-tab pages, not a client panel
// swap). Each report page still does its own requireAuth/permission check
// against the backend response (see tickets/page.tsx, sla/page.tsx) rather
// than gating here, matching audit-logs' precedent of relying on the
// backend's 403 -> redirect rather than a separate frontend permission
// helper (none exists in this codebase).
export default async function ReportsLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations("AdminReports");

  return (
    <div className="flex min-h-[calc(100vh-57px)]">
      <StaffSidebar active="reports" />
      <main className="min-w-0 flex-1 p-4 md:p-8">
        <div className="mb-4">
          <h1 className="text-xl font-bold tracking-tight md:text-2xl">{t("heading")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("subheading")}</p>
        </div>
        <div className="mb-6">
          <ReportsTabs />
        </div>
        {children}
      </main>
    </div>
  );
}
