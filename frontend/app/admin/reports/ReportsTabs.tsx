"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Ticket, ShieldCheck, Users, Star } from "lucide-react";
import { cn } from "@/lib/utils";

// reports-management: shared tab strip over /admin/reports/*, same
// real-route-per-tab pattern as SystemConfigurationTabs (not a client-side
// panel swap). Tickets (Story 40) and SLA Performance (Story 41) are real
// tabs; Agent Performance (Story 42) and CSAT (Story 43) are placeholders so
// the strip doesn't visibly change shape once they ship.
const TABS = [
  { key: "tickets", href: "/admin/reports/tickets", icon: Ticket, iconColorClass: "text-icon-source" },
  { key: "sla", href: "/admin/reports/sla", icon: ShieldCheck, iconColorClass: "text-icon-sla" },
] as const;

const SOON_TABS = [
  { key: "agentPerformance", icon: Users, iconColorClass: "text-icon-priority" },
  { key: "csat", icon: Star, iconColorClass: "text-icon-rating" },
] as const;

export function ReportsTabs() {
  const t = useTranslations("AdminReports");
  const pathname = usePathname();

  return (
    <div className="flex items-center gap-1 overflow-x-auto border-b border-border">
      {TABS.map((tab) => {
        const isActive = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        const Icon = tab.icon;
        return (
          <Link
            key={tab.key}
            href={tab.href}
            className={cn(
              "flex items-center gap-2 whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors",
              isActive ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className={cn("size-4", tab.iconColorClass)} />
            {t(`tabs.${tab.key}`)}
          </Link>
        );
      })}
      {SOON_TABS.map((tab) => {
        const Icon = tab.icon;
        return (
          <span
            key={tab.key}
            className="flex items-center gap-2 whitespace-nowrap border-b-2 border-transparent px-3.5 py-2.5 text-sm font-medium text-muted-foreground/50"
            title={t("tabs.soon")}
          >
            <Icon className={cn("size-4", tab.iconColorClass, "opacity-50")} />
            {t(`tabs.${tab.key}`)}
            <span className="rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t("tabs.soon")}
            </span>
          </span>
        );
      })}
    </div>
  );
}
