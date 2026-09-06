import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils";
import type { CustomerChatRow } from "../chats/CustomerChatList";

interface SupportSummary {
  openTickets: number;
  activeChats: number;
  resolvedRecently: number;
}

interface CustomerSupportSummaryProps {
  summary: SupportSummary;
  recentChats: CustomerChatRow[];
}

const CHAT_STATUS_KEY: Record<CustomerChatRow["status"], string> = {
  ai_handling: "statusAiHandling",
  escalated: "statusEscalated",
  with_agent: "statusWithAgent",
  resolved: "statusResolved",
};

const CHAT_STATUS_BADGE_CLASS: Record<CustomerChatRow["status"], string> = {
  ai_handling: "border-transparent bg-muted text-muted-foreground",
  escalated: "border-transparent bg-destructive/10 text-destructive",
  with_agent: "border-transparent bg-success/10 text-success",
  resolved: "border-transparent bg-muted text-muted-foreground",
};

// customer-portal Story 37: the "My Support" summary strip (chosen UI
// direction: Option C, "summary dashboard") sitting above the existing,
// unmodified CustomerTicketList — a stat row plus a recent-chats teaser
// linking into the full /chats list.
export async function CustomerSupportSummary({ summary, recentChats }: CustomerSupportSummaryProps) {
  const t = await getTranslations("Tickets");
  const tChats = await getTranslations("MyChats");

  return (
    <div className="mb-6 flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-3">
        <Card size="sm">
          <CardContent className="flex flex-col gap-1 p-4">
            <span className="text-2xl font-bold tracking-tight">{summary.openTickets}</span>
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("openTicketsStat")}
            </span>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardContent className="flex flex-col gap-1 p-4">
            <span className="text-2xl font-bold tracking-tight">{summary.activeChats}</span>
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("activeChatsStat")}
            </span>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardContent className="flex flex-col gap-1 p-4">
            <span className="text-2xl font-bold tracking-tight">{summary.resolvedRecently}</span>
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("resolvedRecentlyStat")}
            </span>
          </CardContent>
        </Card>
      </div>

      {recentChats.length > 0 && (
        <Card size="sm">
          <CardContent className="flex flex-col gap-3 p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">{t("recentChatsHeading")}</span>
              <Link href="/chats" className="text-xs font-medium text-primary hover:underline">
                {t("viewAllChats")}
              </Link>
            </div>
            <div className="flex flex-col gap-2">
              {recentChats.map((conversation) => (
                <Link
                  key={conversation._id}
                  href={`/chats/${conversation._id}`}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border p-2 text-sm hover:border-primary/40"
                >
                  <Badge variant="outline" className={CHAT_STATUS_BADGE_CLASS[conversation.status]}>
                    {tChats(CHAT_STATUS_KEY[conversation.status])}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{formatDateTime(conversation.updatedAt)}</span>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
