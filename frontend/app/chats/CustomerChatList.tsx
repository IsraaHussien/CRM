import Link from "next/link";
import { Eye } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { formatDateTime } from "@/lib/utils";

export interface CustomerChatRow {
  _id: string;
  assignedAgent: { _id: string; name: string } | null;
  status: "ai_handling" | "escalated" | "with_agent" | "resolved";
  updatedAt: string;
}

interface CustomerChatListProps {
  conversations: CustomerChatRow[];
}

const STATUS_KEY: Record<CustomerChatRow["status"], string> = {
  ai_handling: "statusAiHandling",
  escalated: "statusEscalated",
  with_agent: "statusWithAgent",
  resolved: "statusResolved",
};

const STATUS_BADGE_CLASS: Record<CustomerChatRow["status"], string> = {
  ai_handling: "border-transparent bg-muted text-muted-foreground",
  escalated: "border-transparent bg-destructive/10 text-destructive",
  with_agent: "border-transparent bg-success/10 text-success",
  resolved: "border-transparent bg-muted text-muted-foreground",
};

// customer-portal Story 37: the customer branch of /chats — their own
// conversations, any status (unlike the staff table, which only ever shows
// escalated/with_agent — see conversation.routes.ts's GET / customer
// branch). Same mobile-card / desktop-table split and "eye icon to view"
// convention as CustomerTicketList.tsx.
export async function CustomerChatList({ conversations }: CustomerChatListProps) {
  const t = await getTranslations("MyChats");

  function handledBy(conversation: CustomerChatRow): string {
    if (conversation.assignedAgent) return conversation.assignedAgent.name;
    if (conversation.status === "ai_handling") return t("aiAgentLabel");
    return "—";
  }

  if (conversations.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        <p className="text-muted-foreground">{t("empty")}</p>
        <Button asChild size="sm">
          <Link href="/chat">{t("emptyCta")}</Link>
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-3 md:hidden">
        {conversations.map((conversation) => (
          <div key={conversation._id} className="rounded-xl border border-border p-4">
            <div className="flex items-start justify-between gap-2">
              <Badge variant="outline" className={STATUS_BADGE_CLASS[conversation.status]}>
                {t(STATUS_KEY[conversation.status])}
              </Badge>
              <span className="text-xs text-muted-foreground">{formatDateTime(conversation.updatedAt)}</span>
            </div>
            <div className="mt-3 flex items-center justify-between">
              <p className="text-sm text-muted-foreground">{handledBy(conversation)}</p>
              <Button
                asChild
                variant="ghost"
                size="icon"
                title={t("viewDetails")}
                className="text-primary hover:bg-primary/10 hover:text-primary"
              >
                <Link href={`/chats/${conversation._id}`}>
                  <Eye className="size-4" />
                  <span className="sr-only">{t("viewDetails")}</span>
                </Link>
              </Button>
            </div>
          </div>
        ))}
      </div>

      <div className="hidden overflow-hidden rounded-2xl border border-border md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("columnStatus")}</TableHead>
              <TableHead>{t("columnHandledBy")}</TableHead>
              <TableHead>{t("columnUpdated")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {conversations.map((conversation) => (
              <TableRow key={conversation._id}>
                <TableCell>
                  <Badge variant="outline" className={STATUS_BADGE_CLASS[conversation.status]}>
                    {t(STATUS_KEY[conversation.status])}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{handledBy(conversation)}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{formatDateTime(conversation.updatedAt)}</TableCell>
                <TableCell>
                  <Button
                    asChild
                    variant="ghost"
                    size="icon"
                    title={t("viewDetails")}
                    className="text-primary hover:bg-primary/10 hover:text-primary"
                  >
                    <Link href={`/chats/${conversation._id}`}>
                      <Eye className="size-4" />
                      <span className="sr-only">{t("viewDetails")}</span>
                    </Link>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
