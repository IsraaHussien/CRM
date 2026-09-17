"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { io, type Socket } from "socket.io-client";
import { useTranslations } from "next-intl";
import { Send, CircleAlert, Sparkles } from "lucide-react";
import { API_URL } from "@/lib/auth";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useSummarize, SummaryResultPanel } from "@/components/SummaryPanel";

export interface AgentChatMessage {
  _id: string;
  text: string;
  senderType: "customer" | "agent" | "ai" | "system";
  senderId: string | null;
  createdAt: string;
}

export interface ChatClaimant {
  id: string;
  name: string;
}

type ConversationStatus = "ai_handling" | "escalated" | "with_agent" | "resolved";
type ConnectionStatus = "connecting" | "connected" | "error";

// Story 18: minimal agent/admin reply surface — deliberately not a copy of
// LiveChatPanel.tsx (customer-scoped: different auth redirects, different
// composer affordances). Story 20's unified dashboard is the right place to
// consolidate shared chat-rendering code, not this story.
//
// Claiming: replying now requires actively holding the exclusive claim on
// this conversation (conversation:claim / conversation:unclaim on the
// backend) — every staff role, agent/subadmin/admin alike, must click
// "Join chat" first, with no bypass. `initialClaimant` seeds this from the
// server-populated conversation.assignedAgent so the page renders correctly
// before any socket event arrives; conversation:claimed/conversation:unclaimed
// keep it live afterward.
export function AgentChatPanel({
  conversationId,
  initialStatus,
  initialMessages,
  initialClaimant,
  customer,
  token,
  currentUserId,
  canSummarize,
}: {
  conversationId: string;
  initialStatus: ConversationStatus;
  initialMessages: AgentChatMessage[];
  initialClaimant: ChatClaimant | null;
  customer: { id: string; name: string };
  token: string;
  currentUserId?: string;
  canSummarize: boolean;
}) {
  const t = useTranslations("AgentChats");
  const [messages, setMessages] = useState<AgentChatMessage[]>(initialMessages);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [conversationStatus, setConversationStatus] = useState<ConversationStatus>(initialStatus);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [claimant, setClaimant] = useState<ChatClaimant | null>(initialClaimant);
  // A claim/unclaim/reply-while-unclaimed rejection is a recoverable,
  // in-panel message — never the connection-teardown "conversation:error"
  // path below, which is reserved for the pre-join handshake failing.
  const [claimError, setClaimError] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const hasJoinedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const socket = io(API_URL, { auth: { token }, transports: ["websocket"] });
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("conversation:join", conversationId);
    });
    socket.on("conversation:joined", () => {
      if (cancelled) return;
      hasJoinedRef.current = true;
      setStatus("connected");
    });
    socket.on("conversation:message", (message: AgentChatMessage) => {
      if (cancelled) return;
      setMessages((prev) => [...prev, message]);
    });
    // Story 19: reflects the status change whether resolved from this
    // panel's own "Mark resolved" button below or from elsewhere (customer
    // close, another admin session).
    socket.on("conversation:closed", () => {
      if (!cancelled) setConversationStatus("resolved");
    });
    socket.on("conversation:claimed", (payload: { conversationId: string; agent: ChatClaimant }) => {
      if (cancelled || payload.conversationId !== conversationId) return;
      setClaimant(payload.agent);
      setClaimError(null);
    });
    socket.on("conversation:unclaimed", (payload: { conversationId: string }) => {
      if (cancelled || payload.conversationId !== conversationId) return;
      setClaimant(null);
    });
    socket.on("conversation:error", (payload: { error: string }) => {
      if (cancelled) return;
      // Before the initial join succeeds, an error means the whole
      // connection is unusable — surface it as such. Afterward (claim,
      // unclaim, a reply rejected because the claim changed underneath us),
      // it's a recoverable in-panel message, not a reason to tear the
      // connection state down.
      if (!hasJoinedRef.current) {
        setStatus("error");
        setErrorMessage(payload.error);
      } else {
        setClaimError(payload.error);
      }
    });
    socket.on("connect_error", () => {
      if (!cancelled) {
        setStatus("error");
        setErrorMessage(t("connectionError"));
      }
    });

    return () => {
      cancelled = true;
      socket.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, token]);

  function handleSend() {
    const text = draft.trim();
    if (!text || !socketRef.current) return;
    socketRef.current.emit("conversation:message", { conversationId, text });
    setDraft("");
  }

  // Story 19: no optimistic local status flip — wait for the
  // conversation:closed broadcast (handled above) to drive the UI, same as
  // the customer side's own close path.
  function handleMarkResolved() {
    socketRef.current?.emit("conversation:close", { conversationId });
  }

  function handleJoinChat() {
    setClaimError(null);
    socketRef.current?.emit("conversation:claim", { conversationId });
  }

  function handleLeaveChat() {
    setClaimError(null);
    socketRef.current?.emit("conversation:unclaim", { conversationId });
  }

  const isClosed = conversationStatus === "resolved";
  const isClaimant = claimant?.id === currentUserId;
  const isDisabled = status !== "connected" || isClosed || !isClaimant;
  // Counts every message, including "system" ones (e.g. the escalation
  // ack) — matching summary.service.ts's own MIN_MESSAGES check exactly, so
  // this button is never disabled for a thread the backend would actually
  // summarize. An earlier version filtered system messages out here only,
  // which disagreed with both the backend and the ticket-side equivalent
  // (TicketSummaryPanel.tsx) and could leave the button wrongly disabled
  // right after an escalation.
  const {
    summary,
    error: summaryError,
    pending: summaryPending,
    disabled: summaryDisabled,
    tooFewMessages: summaryTooFewMessages,
    handleSummarize,
  } = useSummarize("conversations", conversationId, canSummarize, messages.length);
  const summaryDisabledTitle = !canSummarize
    ? t("summary.noPermission")
    : summaryTooFewMessages
      ? t("summary.notEnoughMessages")
      : undefined;

  return (
    <Card className="flex h-[70vh] w-full max-w-lg flex-col">
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>{t("detailHeading")}</CardTitle>
          <Link href={`/customers/${customer.id}`} className="text-sm font-medium hover:underline">
            {customer.name}
          </Link>
          <CardDescription>
            {status === "connecting" && t("connecting")}
            {status === "connected" && !isClosed && t("connected")}
            {status === "connected" && isClosed && t("closed")}
            {status === "error" && t("connectionError")}
          </CardDescription>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={summaryDisabled || summaryPending}
            title={summaryDisabledTitle}
            onClick={handleSummarize}
          >
            <Sparkles className="size-4" />
            {summaryPending ? t("summary.loading") : summary ? t("summary.regenerate") : t("summary.button")}
          </Button>
          {!isClosed && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button type="button" variant="outline" size="sm" disabled={status !== "connected"}>
                  {t("markResolved")}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("markResolvedConfirmTitle")}</AlertDialogTitle>
                  <AlertDialogDescription>{t("markResolvedConfirmBody")}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("markResolvedCancel")}</AlertDialogCancel>
                  <AlertDialogAction onClick={handleMarkResolved}>{t("markResolvedConfirm")}</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-2 overflow-y-auto">
        <SummaryResultPanel
          namespace="AgentChats"
          summary={summary}
          error={summaryError}
          pending={summaryPending}
          onRetry={handleSummarize}
        />
        {errorMessage && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        )}
        {!isClosed && (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
            <span className="min-w-0 truncate text-muted-foreground">
              {!claimant
                ? t("chatUnclaimed")
                : isClaimant
                  ? t("chatClaimedByYou")
                  : t("chatClaimedBy", { name: claimant.name })}
            </span>
            {!claimant && (
              <Button type="button" size="sm" disabled={status !== "connected"} onClick={handleJoinChat}>
                {t("joinChat")}
              </Button>
            )}
            {isClaimant && (
              <Button type="button" size="sm" variant="outline" onClick={handleLeaveChat}>
                {t("leaveChat")}
              </Button>
            )}
          </div>
        )}
        {claimError && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{claimError}</AlertDescription>
          </Alert>
        )}
        {messages.map((message) => {
          // Story 16/17: a "system" message (currently just the escalation
          // acknowledgment) isn't news to an agent/admin the way it is to
          // the customer — they already know they were just assigned (or
          // that the customer is still waiting for someone). Render it as a
          // quiet centered note, not a bubble, and deliberately skip the
          // sender-label logic below — labeling it "You"/"Agent" would be
          // wrong, since senderId is null on a system message.
          if (message.senderType === "system") {
            return (
              <p key={message._id} className="self-center px-4 py-1 text-center text-xs italic text-muted-foreground">
                {message.text}
              </p>
            );
          }
          const isOwnMessage = message.senderId === currentUserId;
          return (
            <div
              key={message._id}
              className={`flex max-w-[80%] flex-col gap-1 ${isOwnMessage ? "self-end items-end" : "self-start items-start"}`}
            >
              <span className="text-[11px] font-medium text-muted-foreground">
                {message.senderType === "ai"
                  ? t("aiAgentLabel")
                  : message.senderType === "customer"
                    ? t("customerLabel")
                    : isOwnMessage
                      ? t("youLabel")
                      : t("agentLabel")}
              </span>
              <div
                className={`rounded-xl px-3 py-2 text-sm ${isOwnMessage ? "bg-primary text-primary-foreground" : "bg-muted"}`}
              >
                {message.text}
              </div>
              <span dir="ltr" className="text-[11px] text-muted-foreground">
                {new Date(message.createdAt).toLocaleString()}
              </span>
            </div>
          );
        })}
      </CardContent>
      <CardFooter className="flex flex-col gap-2 border-t-0 bg-transparent pt-1">
        <div className="flex w-full items-center gap-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={isClosed ? t("closed") : !isClaimant ? t("joinToReplyPlaceholder") : t("composerPlaceholder")}
            rows={1}
            disabled={isDisabled}
            className="min-h-9"
          />
          <Button type="button" size="icon" disabled={isDisabled || draft.trim().length === 0} onClick={handleSend}>
            <Send className="size-4" />
            <span className="sr-only">{t("send")}</span>
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}
