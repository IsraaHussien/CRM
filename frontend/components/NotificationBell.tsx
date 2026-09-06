"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { fetchNotifications, markNotificationRead, type NotificationItem } from "@/app/actions/notifications";
import { formatDateTime } from "@/lib/utils";

const POLL_INTERVAL_MS = 60_000;
// The dropdown is a quick-glance surface, not a browsable history — capped
// at 10 with a "View all" link to the dedicated /notifications page (which
// has real pagination + date filtering) rather than letting this list grow
// unbounded as notifications pile up.
const DROPDOWN_ITEM_LIMIT = 8;

const TYPE_KEY: Record<NotificationItem["type"], string> = {
  ticket_assigned: "notificationTicketAssigned",
  ticket_escalated: "notificationTicketEscalated",
  ticket_reassigned: "notificationTicketReassigned",
  ticket_unassigned: "notificationTicketUnassigned",
  ticket_created: "notificationTicketCreated",
  ticket_auto_assigned: "notificationTicketAutoAssigned",
  ticket_needs_assignment: "notificationTicketNeedsAssignment",
  ticket_reopened: "notificationTicketReopened",
  ticket_reopened_oversight: "notificationTicketReopenedOversight",
  chat_needs_agent: "notificationChatNeedsAgent",
  sla_at_risk: "notificationSlaAtRisk",
  sla_breached: "notificationSlaBreached",
  ticket_internal_note_mention: "notificationTicketInternalNoteMention",
};

// Story 54: was a static "coming soon" placeholder — now fetches on mount,
// polls every 60s while the tab is visible (paused in the background,
// refetched immediately on regaining focus), and refetches on route change
// so returning from a linked ticket updates the count. Polling, not
// Socket.io — the intake explicitly permits this and it keeps notifications
// out of the live-chat socket surface (see this story's plan).
export function NotificationBell() {
  const t = useTranslations("Nav");
  const pathname = usePathname();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [, startTransition] = useTransition();

  const refresh = useCallback(() => {
    startTransition(async () => {
      const next = await fetchNotifications();
      setItems(next);
    });
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(() => {
      if (!document.hidden) refresh();
    }, POLL_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refresh]);

  // Route change (e.g. returning from a linked ticket) — re-fetch so the
  // badge reflects any notification marked read while the user was away.
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const unreadCount = items.filter((n) => !n.read).length;
  const badgeLabel = unreadCount > 9 ? "9+" : String(unreadCount);

  function handleItemClick(item: NotificationItem) {
    if (item.read) return;
    setItems((prev) => prev.map((n) => (n.id === item.id ? { ...n, read: true } : n)));
    startTransition(async () => {
      await markNotificationRead(item.id);
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="relative rounded-xl border-border bg-card shadow-soft"
          aria-label={t("notifications")}
        >
          <Bell className="size-[17px]" />
          {unreadCount > 0 && (
            <span
              aria-hidden
              className="absolute -end-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground"
            >
              {badgeLabel}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-96">
        <DropdownMenuLabel className="font-normal text-muted-foreground">{t("notifications")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.length === 0 ? (
          <DropdownMenuLabel className="font-normal text-muted-foreground">
            {t("notificationsEmpty")}
          </DropdownMenuLabel>
        ) : (
          // A notification whose type isn't in TYPE_KEY (a legacy/removed
          // type on an old unread row still sitting in the DB) has no
          // matching label to render — skip it rather than crash the whole
          // dropdown, which next-intl's t() would otherwise do on an
          // undefined key.
          items
            .filter((item) => item.type in TYPE_KEY)
            .slice(0, DROPDOWN_ITEM_LIMIT)
            .map((item) => (
              <DropdownMenuItem key={item.id} asChild className="flex-col items-start gap-0.5">
                <Link
                  href={item.ticket ? `/tickets/${item.ticket.id}` : `/chats/${item.conversation!.id}`}
                  onClick={() => handleItemClick(item)}
                >
                  <span className={item.read ? "text-sm text-muted-foreground" : "text-sm font-medium"}>
                    {t(TYPE_KEY[item.type])}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {item.ticket ? `${item.ticket.reference} — ${item.ticket.subject}` : t("notificationChatLabel")}
                  </span>
                  <span className="text-[11px] text-muted-foreground/70">{formatDateTime(item.createdAt)}</span>
                </Link>
              </DropdownMenuItem>
            ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild className="justify-center text-sm font-medium text-primary">
          <Link href="/notifications">{t("viewAllNotifications")}</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
