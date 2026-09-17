"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils";
import type { CustomerTimelineItem } from "./actions";

// Merged ticket (5-way) + chat (4-way) status maps — a single component now
// renders both, unlike StaffTicketQueue.tsx/chats/page.tsx which each only
// ever see one type. Copied verbatim from those files rather than importing
// them, matching how every other list in this app keeps its own local copy.
const STATUS_KEY: Record<string, string> = {
  new: "statusNew",
  in_progress: "statusInProgress",
  answered: "statusAnswered",
  escalated: "statusEscalated",
  closed: "statusClosed",
  ai_handling: "statusAiHandling",
  with_agent: "statusWithAgent",
  resolved: "statusResolved",
};

const STATUS_BADGE_CLASS: Record<string, string> = {
  new: "border-transparent bg-muted text-muted-foreground",
  in_progress: "border-transparent bg-warning/10 text-warning",
  answered: "border-transparent bg-success/10 text-success",
  escalated: "border-transparent bg-destructive/10 text-destructive",
  closed: "border-transparent bg-muted text-muted-foreground",
  ai_handling: "border-transparent bg-muted text-muted-foreground",
  with_agent: "border-transparent bg-success/10 text-success",
  resolved: "border-transparent bg-muted text-muted-foreground",
};

// customer-management Story 6 — Option B (left-rail timeline), chosen over a
// plain card-of-rows so chronology reads as the point of this tab, not just
// an incidental sort order. `--icon-ticket`/`--icon-chat` (globals.css) give
// each type its own vivid, non-status color, same convention as every other
// decorative-category accent in this app (icon-category, icon-priority, …).
export function CustomerHistoryTimeline({ items }: { items: CustomerTimelineItem[] }) {
  const t = useTranslations("CustomerProfile");

  if (items.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{t("historyEmpty")}</p>;
  }

  return (
    <div className="relative flex flex-col gap-5 ps-6">
      <div className="absolute inset-y-1.5 start-[3px] w-px bg-border" />
      {items.map((item) => {
        const isTicket = item.type === "ticket";
        const subject = isTicket ? (item.subject ?? "") : t("historyChatSubject", { date: formatDateTime(item.createdAt) });
        return (
          <Link
            key={`${item.type}-${item.id}`}
            href={isTicket ? `/tickets/${item.id}` : `/chats/${item.id}`}
            className="relative block rounded-lg px-2 py-1.5 hover:bg-muted"
          >
            <span
              className={`absolute -start-6 top-2 size-3 rounded-full border-2 bg-card ${
                isTicket ? "border-icon-ticket" : "border-icon-chat"
              }`}
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-semibold">{subject}</span>
              <Badge variant="outline" className={STATUS_BADGE_CLASS[item.status] ?? STATUS_BADGE_CLASS.new}>
                {t(STATUS_KEY[item.status] ?? "statusNew")}
              </Badge>
            </div>
            <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
                  isTicket ? "bg-icon-ticket/15 text-icon-ticket" : "bg-icon-chat/15 text-icon-chat"
                }`}
              >
                {isTicket ? t("historyTicketLabel") : t("historyChatLabel")}
              </span>
              <span aria-hidden="true">·</span>
              <span>{formatDateTime(item.createdAt)}</span>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
