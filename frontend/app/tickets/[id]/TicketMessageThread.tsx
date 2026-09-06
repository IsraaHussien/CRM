import { getTranslations } from "next-intl/server";
import { Lock, Paperclip } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { TicketMessage } from "./page";

// Story 56: read-only thread renderer — customer's original message is
// rendered separately (as the ticket's subject/description, already on the
// page); this only renders real Message rows, oldest first (server already
// sorts them).
//
// agent-workspace Story 24: internal notes (Message.internal: true) now
// render here too, inline and chronologically — never grouped into a
// separate list — with an amber-tinted bubble and an "Internal note" badge
// so they can't be mistaken for something the customer can see. The backend
// never returns one to a customer (GET /:id/messages filters `internal` out
// of the query for a customer caller, and drops the flag from the DTO
// entirely); `staffViewer` here is redundant defence-in-depth for the same
// rule, not the enforcement point.
export async function TicketMessageThread({
  messages,
  ticketId,
  staffViewer = false,
}: {
  messages: TicketMessage[];
  ticketId: string;
  staffViewer?: boolean;
}) {
  const t = await getTranslations("TicketDetail");

  const visible = staffViewer ? messages : messages.filter((m) => m.internal !== true);

  if (visible.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("threadEmpty")}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {visible.map((message) => {
        const initial = (message.sender?.name.trim().charAt(0) || "?").toUpperCase();
        const isInternal = message.internal === true;
        return (
          <div
            key={message.id}
            className={cn(
              "rounded-xl border p-3",
              isInternal ? "border-warning/40 border-s-4 border-s-warning bg-warning/5" : "border-border"
            )}
          >
            {isInternal && (
              <span className="sr-only">{t("internalNotes.srLabel")}</span>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Avatar size="sm">
                <AvatarFallback className="bg-accent text-accent-foreground">{initial}</AvatarFallback>
              </Avatar>
              <span className="text-sm font-medium">{message.sender?.name ?? t("thread")}</span>
              {isInternal && (
                <Badge variant="outline" className="gap-1 border-warning/40 bg-warning/10 text-[10px] text-warning">
                  <Lock className="size-3" aria-hidden="true" />
                  {t("internalNotes.badge")}
                </Badge>
              )}
              {message.senderType === "agent" && !isInternal && (
                <Badge variant="outline" className="text-[10px]">
                  {t("sentByEmail")}
                </Badge>
              )}
              <span dir="ltr" className="ms-auto text-xs text-muted-foreground">
                {new Date(message.createdAt).toLocaleString()}
              </span>
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm">{message.text}</p>
            {isInternal && message.taggedUsers && message.taggedUsers.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted-foreground">{t("internalNotes.taggedLabel")}</span>
                {message.taggedUsers.map((user) => (
                  <Badge
                    key={user.id}
                    variant="outline"
                    className="border-warning/40 bg-warning/10 text-[10px] text-warning"
                  >
                    {user.name}
                  </Badge>
                ))}
              </div>
            )}
            {message.attachments.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {message.attachments.map((attachment) => (
                  <a
                    key={attachment.id}
                    href={`/api/tickets/${ticketId}/messages/${message.id}/attachments/${attachment.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground"
                  >
                    <Paperclip className="size-3" />
                    {attachment.fileName}
                  </a>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
