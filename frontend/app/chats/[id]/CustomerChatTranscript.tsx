import { getTranslations } from "next-intl/server";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import type { AgentChatMessage } from "./AgentChatPanel";

interface CustomerChatTranscriptProps {
  messages: AgentChatMessage[];
  currentUserId: string | undefined;
}

// customer-portal Story 37: read-only transcript for a customer viewing
// their own RESOLVED conversation's history — no Socket.io, no composer, no
// claim/reply UI (that's AgentChatPanel, staff-only). Conversation messages
// carry no attachments today (live chat has no upload path, unlike ticket
// replies — see backend/src/sockets/chat.socket.ts), so unlike
// TicketMessageThread this renders no attachment affordance.
export async function CustomerChatTranscript({ messages, currentUserId }: CustomerChatTranscriptProps) {
  const t = await getTranslations("MyChats");

  if (messages.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("threadEmpty")}</p>;
  }

  function senderLabel(message: AgentChatMessage): string {
    if (message.senderType === "ai") return t("aiAgentLabel");
    if (message.senderType === "customer") return message.senderId === currentUserId ? t("youLabel") : t("customerLabel");
    if (message.senderType === "agent") return t("agentLabel");
    return t("systemLabel");
  }

  return (
    <div className="flex flex-col gap-3">
      {messages.map((message) => {
        const label = senderLabel(message);
        return (
          <div key={message._id} className="rounded-xl border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Avatar size="sm">
                <AvatarFallback className="bg-accent text-accent-foreground">
                  {label.charAt(0).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <span className="text-sm font-medium">{label}</span>
              <span dir="ltr" className="ms-auto text-xs text-muted-foreground">
                {new Date(message.createdAt).toLocaleString()}
              </span>
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm">{message.text}</p>
          </div>
        );
      })}
    </div>
  );
}
