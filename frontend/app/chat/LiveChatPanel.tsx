"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { io, type Socket } from "socket.io-client";
import { useTranslations } from "next-intl";
import { CircleAlert, Send, MessageSquareWarning, CircleHelp, Ticket, BookOpen, X } from "lucide-react";
import { API_URL } from "@/lib/auth";
import { formatDateTime } from "@/lib/utils";
import { pickLocalized } from "@/lib/localized";
import type { Locale } from "@/lib/locale";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { UNSPECIFIED_CATEGORY } from "@/app/tickets/new/constants";
import { listActiveTicketCategories } from "@/app/tickets/new/actions";
import {
  createConversation,
  getActiveConversation,
  getMyRecentTickets,
  createTicketFromConversation,
  type ChatTicketSummary,
} from "./actions";

interface TicketSuggestion {
  subject: string;
  description: string;
}

interface KbSuggestion {
  type: "faq" | "article";
  id: string;
  title: { en: string; ar: string };
  slug?: string;
}

interface ChatMessage {
  _id: string;
  text: string;
  senderType: "customer" | "agent" | "ai" | "system";
  createdAt: string;
  aiTicketSuggestion?: TicketSuggestion | null;
  aiKbSuggestion?: KbSuggestion | null;
}

const STATUS_KEY: Record<ChatTicketSummary["status"], string> = {
  new: "statusNew",
  in_progress: "statusInProgress",
  answered: "statusAnswered",
  escalated: "statusEscalated",
  closed: "statusClosed",
};

const STATUS_BADGE_CLASS: Record<ChatTicketSummary["status"], string> = {
  new: "border-transparent bg-muted text-muted-foreground",
  in_progress: "border-transparent bg-warning/10 text-warning",
  answered: "border-transparent bg-success/10 text-success",
  escalated: "border-transparent bg-destructive/10 text-destructive",
  closed: "border-transparent bg-muted text-muted-foreground",
};

type ConnectionStatus = "connecting" | "connected" | "error";
// Story 16/17: orthogonal to ConnectionStatus (socket up/down) — this tracks
// whether the customer has asked to talk to a human, independent of the
// underlying connection ever dropping/reconnecting. "escalated" = waiting
// for Story 17's auto-assign; "assigned" = a human agent has joined.
type EscalationState = "idle" | "requesting" | "escalated" | "assigned";

// Story 62: the inline "open a ticket" suggestion card rendered under an AI
// message that carries one. Manages its own expand/category/submit state —
// LiveChatPanel only needs to know the outcome (accepted → ticket id/
// reference; declined → hide every card in this conversation).
function TicketSuggestionCard({
  suggestion,
  conversationId,
  onAccepted,
  onDecline,
}: {
  suggestion: TicketSuggestion;
  conversationId: string;
  onAccepted: (ticketId: string, reference: string) => void;
  onDecline: () => void;
}) {
  const t = useTranslations("Chat");
  const [expanded, setExpanded] = useState(false);
  const [subject, setSubject] = useState(suggestion.subject);
  const [description, setDescription] = useState(suggestion.description);
  const [categories, setCategories] = useState<string[] | null>(null);
  const [categoriesLoading, setCategoriesLoading] = useState(false);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);
  const [category, setCategory] = useState(UNSPECIFIED_CATEGORY);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function handleOpenClick() {
    setExpanded(true);
    if (categories !== null) return;
    setCategoriesLoading(true);
    setCategoriesError(null);
    try {
      const result = await listActiveTicketCategories();
      setCategories(result);
    } catch {
      setCategoriesError(t("suggestionCategoriesFailed"));
    } finally {
      setCategoriesLoading(false);
    }
  }

  async function handleSubmit() {
    if (!subject.trim()) return;
    setCreating(true);
    setCreateError(null);
    const result = await createTicketFromConversation({
      conversationId,
      subject: subject.trim(),
      description: description.trim(),
      category: category === UNSPECIFIED_CATEGORY ? "" : category,
    });
    setCreating(false);
    if (!result.ok) {
      setCreateError(result.error);
      return;
    }
    onAccepted(result.ticketId, result.reference);
  }

  return (
    <div className="flex w-full max-w-[90%] flex-col gap-2 self-start rounded-xl border border-border bg-card p-3 text-sm">
      <p className="font-medium">{t("suggestionTitle")}</p>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">{t("suggestionSubjectLabel")}</label>
        <Input value={subject} onChange={(e) => setSubject(e.target.value)} disabled={creating} />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">{t("suggestionDescriptionLabel")}</label>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          disabled={creating}
        />
      </div>
      {expanded && (
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">{t("suggestionCategoryLabel")}</label>
          {categoriesLoading ? (
            <p className="text-xs text-muted-foreground">{t("connecting")}</p>
          ) : categoriesError ? (
            <div className="flex items-center gap-2">
              <p className="text-xs text-destructive">{categoriesError}</p>
              <Button type="button" variant="outline" size="sm" onClick={handleOpenClick}>
                {t("suggestionRetry")}
              </Button>
            </div>
          ) : (
            <Select value={category} onValueChange={setCategory} disabled={creating}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNSPECIFIED_CATEGORY}>{t("suggestionUnspecifiedCategory")}</SelectItem>
                {categories?.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}
      {createError && <p className="text-xs text-destructive">{createError}</p>}
      <div className="flex gap-2">
        {expanded ? (
          <Button type="button" size="sm" disabled={creating || !subject.trim()} onClick={handleSubmit}>
            {creating ? t("suggestionCreating") : t("suggestionSubmit")}
          </Button>
        ) : (
          <Button type="button" size="sm" onClick={handleOpenClick}>
            {t("suggestionOpenTicket")}
          </Button>
        )}
        <Button type="button" variant="outline" size="sm" disabled={creating} onClick={onDecline}>
          {t("suggestionKeepChatting")}
        </Button>
      </div>
    </div>
  );
}

// ai-features Story 34/35 (live-chat half): the inline "you might find this
// helpful" card rendered under an AI message that carries a KB suggestion.
// Unlike TicketSuggestionCard there's no server round-trip on interaction —
// it's a straight link to the existing public Help Center content, so
// dismissing it is purely local UI state (see dismissedKbSuggestions below).
function KbSuggestionCard({
  suggestion,
  locale,
  onDismiss,
}: {
  suggestion: KbSuggestion;
  locale: Locale;
  onDismiss: () => void;
}) {
  const t = useTranslations("Chat");
  const title = pickLocalized(suggestion.title, locale);
  const href = suggestion.type === "article" ? `/help/${suggestion.slug}` : `/help?tab=faqs#faq-${suggestion.id}`;

  return (
    <div className="flex w-full max-w-[90%] items-center gap-2 self-start rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm">
      <BookOpen className="size-4 shrink-0 text-primary" />
      <Link href={href} target="_blank" className="min-w-0 flex-1 text-primary hover:underline">
        <span className="block truncate" lang={title.language} dir={title.language === "ar" ? "rtl" : "ltr"}>
          {t("kbSuggestionLabel")} <span className="font-medium">{title.value}</span>
        </span>
      </Link>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-6 shrink-0"
        onClick={onDismiss}
        title={t("kbSuggestionDismiss")}
      >
        <X className="size-3.5" />
        <span className="sr-only">{t("kbSuggestionDismiss")}</span>
      </Button>
    </div>
  );
}

// Story 14: the access token is passed down once, purely so the Socket.io
// handshake can authenticate (there is no other way for a WebSocket
// connection to carry the httpOnly session cookie) — it is never written to
// localStorage or any client-readable cookie, matching CLAUDE.md's auth
// model everywhere else; it only lives in this component's state for the
// life of the page.
export function LiveChatPanel({ token, locale }: { token: string; locale: Locale }) {
  const router = useRouter();
  const t = useTranslations("Chat");
  const tt = useTranslations("Tickets");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [aiTyping, setAiTyping] = useState(false);
  const [escalationState, setEscalationState] = useState<EscalationState>("idle");
  const [conversationClosed, setConversationClosed] = useState(false);
  // Story 62: once the customer declines one suggestion, every suggestion
  // card in this conversation hides (mirrors the server's
  // aiTicketSuggestionDeclined flag, which stops the classifier from being
  // called again — this local flag just keeps the UI in sync immediately).
  const [suggestionDeclined, setSuggestionDeclined] = useState(false);
  // ai-features Story 34/35: per-message dismiss, not a conversation-wide
  // flag like suggestionDeclined above — each KB suggestion is tied to the
  // specific customer message it was matched against, so dismissing one says
  // nothing about whether the next one is worth showing.
  const [dismissedKbSuggestions, setDismissedKbSuggestions] = useState<Set<string>>(new Set());
  const [acceptedTickets, setAcceptedTickets] = useState<Record<string, { id: string; reference: string }>>({});
  const [previousTicketsOpen, setPreviousTicketsOpen] = useState(false);
  const [previousTicketsLoading, setPreviousTicketsLoading] = useState(false);
  const [previousTickets, setPreviousTickets] = useState<ChatTicketSummary[] | null>(null);
  const [previousTicketsError, setPreviousTicketsError] = useState<string | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const aiTypingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Story 15: independent of the server ever clearing the indicator (the AI
  // reply/fallback message doing so is the normal path) — a server crash
  // between the typing event and the reply would otherwise leave this stuck
  // forever, so it always self-clears after 15s.
  function clearAiTypingTimeout() {
    if (aiTypingTimeoutRef.current) {
      clearTimeout(aiTypingTimeoutRef.current);
      aiTypingTimeoutRef.current = null;
    }
  }

  function startAiTypingSafetyTimeout() {
    clearAiTypingTimeout();
    aiTypingTimeoutRef.current = setTimeout(() => setAiTyping(false), 15_000);
  }

  useEffect(() => {
    let cancelled = false;

    const socket = io(API_URL, { auth: { token }, transports: ["websocket"] });
    socketRef.current = socket;

    // Opening the widget must never, by itself, create anything server-side
    // — only resuming a conversation that already has real content in it
    // (getActiveConversation deliberately ignores an empty one; see its own
    // comment) counts as something to rejoin. A customer who opens /chat and
    // leaves it untouched should leave zero trace: no Conversation row, no
    // entry in their own chat history, nothing for the SLA monitor to scan.
    // The actual (lazy) creation happens in ensureConversationJoined below,
    // triggered only by a genuine first action (send / intent chip /
    // escalate).
    socket.on("connect", async () => {
      if (cancelled) return;
      const existing = await getActiveConversation();
      if (cancelled) return;
      if (!existing.ok) {
        setStatus("error");
        setErrorMessage(existing.error);
        return;
      }
      if (!existing.id) {
        setStatus("connected");
        return;
      }
      conversationIdRef.current = existing.id;
      // Resuming an existing (non-resolved) conversation restores its prior
      // messages and lifecycle state — otherwise a customer reopening the
      // widget mid-conversation would see an empty chat and the "Talk to a
      // human" chip again even though they'd already escalated.
      setMessages(existing.messages);
      if (existing.status === "with_agent") setEscalationState("assigned");
      else if (existing.status === "escalated") setEscalationState("escalated");
      socket.emit("conversation:join", existing.id);
      // status flips to "connected" once conversation:joined fires below.
    });
    socket.on("conversation:joined", () => {
      if (!cancelled) setStatus("connected");
    });
    socket.on("conversation:message", (message: ChatMessage) => {
      if (cancelled) return;
      if (message.senderType === "ai") {
        setAiTyping(false);
        clearAiTypingTimeout();
      }
      setMessages((prev) => [...prev, message]);
    });
    socket.on("conversation:ai-typing", () => {
      if (cancelled) return;
      setAiTyping(true);
      startAiTypingSafetyTimeout();
    });
    socket.on("conversation:escalated", () => {
      if (cancelled) return;
      setEscalationState("escalated");
      setAiTyping(false);
      clearAiTypingTimeout();
    });
    socket.on("conversation:assigned", () => {
      if (cancelled) return;
      setEscalationState("assigned");
    });
    socket.on("conversation:closed", () => {
      if (cancelled) return;
      setConversationClosed(true);
    });
    socket.on("conversation:error", (payload: { error: string }) => {
      if (!cancelled) {
        setStatus("error");
        setErrorMessage(payload.error);
      }
    });
    socket.on("connect_error", () => {
      if (!cancelled) {
        setStatus("error");
        setErrorMessage(t("error"));
      }
    });

    return () => {
      cancelled = true;
      socketRef.current?.disconnect();
      clearAiTypingTimeout();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Creates (or resumes) the Conversation the very first time it's actually
  // needed — sending a message, an intent chip, or escalating — instead of
  // eagerly on mount. Every call after the first is a no-op (conversationIdRef
  // is already set) and just returns the same id.
  async function ensureConversationJoined(): Promise<string | null> {
    if (conversationIdRef.current) return conversationIdRef.current;
    const socket = socketRef.current;
    if (!socket) return null;

    const result = await createConversation();
    if (!result.ok) {
      setStatus("error");
      setErrorMessage(result.error);
      return null;
    }

    conversationIdRef.current = result.id;
    setMessages(result.messages);
    if (result.status === "with_agent") setEscalationState("assigned");
    else if (result.status === "escalated") setEscalationState("escalated");

    await new Promise<void>((resolve) => {
      socket.once("conversation:joined", () => resolve());
      socket.emit("conversation:join", result.id);
    });

    return result.id;
  }

  async function sendMessage(text: string) {
    if (!text) return;
    const conversationId = await ensureConversationJoined();
    if (!conversationId || !socketRef.current) return;
    socketRef.current.emit("conversation:message", { conversationId, text });
  }

  function handleSend() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void sendMessage(text);
  }

  // Quick-action chip: Complaint/Inquiry send a fixed intent message
  // immediately (same emit path as the composer's send button) so the
  // customer doesn't have to type it themselves — Story 15's AI branch
  // responds to it exactly like any other customer message.
  function handleIntentChip(text: string) {
    void sendMessage(text);
  }

  // Story 16: socket emit only — conversation:message is already the
  // customer's only real-time channel into the conversation, so escalation
  // reuses that same authenticated transport rather than a REST call.
  async function handleEscalate() {
    if (escalationState !== "idle") return;
    setEscalationState("requesting");
    const conversationId = await ensureConversationJoined();
    if (!conversationId || !socketRef.current) {
      setEscalationState("idle");
      return;
    }
    socketRef.current.emit("conversation:escalate", { conversationId });
  }

  // The customer ending the chat on their own (header X button) lands them
  // on their tickets list — there's nothing more to do in this widget once
  // they've decided to leave. Nothing to emit if no conversation was ever
  // created (they opened the widget and left without sending anything).
  function handleCloseConversation() {
    if (socketRef.current && conversationIdRef.current) {
      socketRef.current.emit("conversation:close", { conversationId: conversationIdRef.current });
    }
    router.push("/tickets");
  }

  // Story 62: declining hides every suggestion card in this conversation and
  // tells the server so the classifier stops being called here again.
  function handleDeclineSuggestion() {
    setSuggestionDeclined(true);
    if (socketRef.current && conversationIdRef.current) {
      socketRef.current.emit("conversation:ai-suggestion-declined", {
        conversationId: conversationIdRef.current,
      });
    }
  }

  function handleSuggestionAccepted(messageId: string, ticketId: string, reference: string) {
    setAcceptedTickets((prev) => ({ ...prev, [messageId]: { id: ticketId, reference } }));
  }

  async function handleTogglePreviousTickets() {
    if (previousTicketsOpen) {
      setPreviousTicketsOpen(false);
      return;
    }
    setPreviousTicketsOpen(true);
    setPreviousTicketsLoading(true);
    setPreviousTicketsError(null);
    const result = await getMyRecentTickets();
    setPreviousTicketsLoading(false);
    if (result.error) {
      setPreviousTicketsError(result.error);
      return;
    }
    setPreviousTickets(result.tickets);
  }

  return (
    <Card className="flex h-[70vh] w-full max-w-lg flex-col">
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>{t("heading")}</CardTitle>
          <CardDescription>
            {status === "connecting" && t("connecting")}
            {status === "connected" && t("connected")}
            {status === "error" && t("error")}
          </CardDescription>
        </div>
        {!conversationClosed && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            title={t("endChat")}
            onClick={handleCloseConversation}
          >
            <X className="size-4" />
            <span className="sr-only">{t("endChat")}</span>
          </Button>
        )}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-2 overflow-y-auto">
        {errorMessage && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        )}
        {escalationState === "escalated" && (
          <Alert>
            <MessageSquareWarning />
            <AlertDescription>{t("escalatedWaiting")}</AlertDescription>
          </Alert>
        )}
        {escalationState === "assigned" && (
          <Alert>
            <MessageSquareWarning />
            <AlertDescription>{t("agentJoined")}</AlertDescription>
          </Alert>
        )}
        {conversationClosed && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{t("closed")}</AlertDescription>
          </Alert>
        )}
        {messages.map((message) => {
          const isCustomer = message.senderType === "customer";
          const acceptedTicket = acceptedTickets[message._id];
          // Story 16/17: a "system" message (currently just the escalation
          // acknowledgment) is a status update, not a chat turn — it gets an
          // eye-catching full-width banner instead of a bubble, since "help
          // is on the way" is exactly the kind of detail a customer must not
          // miss in a scrolling thread. Kept in its natural chronological
          // position in the list, not pinned/hoisted.
          if (message.senderType === "system") {
            return (
              <Alert key={message._id} className="border-primary/40 bg-primary/10 text-primary [&>svg]:text-primary">
                <MessageSquareWarning />
                <AlertDescription className="font-medium">{message.text}</AlertDescription>
              </Alert>
            );
          }
          return (
            <div key={message._id} className="contents">
              <div className={`flex max-w-[80%] flex-col gap-1 ${isCustomer ? "self-end items-end" : "self-start items-start"}`}>
                {/* TODO(story-16/18): label "agent" messages once agent replies land */}
                {message.senderType === "ai" && (
                  <span className="text-[11px] font-medium text-muted-foreground">{t("aiAgentLabel")}</span>
                )}
                <div className={`rounded-xl px-3 py-2 text-sm ${isCustomer ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                  {message.text}
                </div>
                <span dir="ltr" className="text-[11px] text-muted-foreground">
                  {new Date(message.createdAt).toLocaleString()}
                </span>
              </div>
              {message.aiTicketSuggestion &&
                (acceptedTicket ? (
                  <Link
                    href={`/tickets/${acceptedTicket.id}`}
                    className="w-full max-w-[90%] self-start rounded-xl border border-success/30 bg-success/10 p-3 text-sm text-success hover:underline"
                  >
                    {t("suggestionCreated", { reference: acceptedTicket.reference })}
                  </Link>
                ) : (
                  !suggestionDeclined &&
                  conversationIdRef.current && (
                    <TicketSuggestionCard
                      suggestion={message.aiTicketSuggestion}
                      conversationId={conversationIdRef.current}
                      onAccepted={(ticketId, reference) => handleSuggestionAccepted(message._id, ticketId, reference)}
                      onDecline={handleDeclineSuggestion}
                    />
                  )
                ))}
              {message.aiKbSuggestion && !dismissedKbSuggestions.has(message._id) && (
                <KbSuggestionCard
                  suggestion={message.aiKbSuggestion}
                  locale={locale}
                  onDismiss={() =>
                    setDismissedKbSuggestions((prev) => new Set(prev).add(message._id))
                  }
                />
              )}
            </div>
          );
        })}
        {aiTyping && (
          <div className="flex max-w-[80%] flex-col gap-1 self-start items-start">
            <span className="text-[11px] font-medium text-muted-foreground">{t("aiAgentLabel")}</span>
            <div className="rounded-xl bg-muted px-3 py-2 text-sm italic text-muted-foreground">
              {t("aiTyping")}
            </div>
          </div>
        )}
        {previousTicketsOpen && (
          <div className="flex w-full max-w-[90%] flex-col gap-2 self-start rounded-xl border border-border bg-card p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{t("previousTicketsHeading")}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={() => setPreviousTicketsOpen(false)}
              >
                <X className="size-3.5" />
                <span className="sr-only">{t("previousTicketsClose")}</span>
              </Button>
            </div>
            {previousTicketsLoading && <p className="text-muted-foreground">{t("connecting")}</p>}
            {previousTicketsError && <p className="text-destructive">{previousTicketsError}</p>}
            {!previousTicketsLoading && !previousTicketsError && previousTickets?.length === 0 && (
              <p className="text-muted-foreground">{t("previousTicketsEmpty")}</p>
            )}
            {!previousTicketsLoading &&
              previousTickets?.map((ticket) => (
                <Link
                  key={ticket.id}
                  href={`/tickets/${ticket.id}`}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border p-2 hover:bg-muted/50"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{ticket.subject}</span>
                    <span className="font-mono text-xs text-muted-foreground">{ticket.reference}</span>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Badge variant="outline" className={STATUS_BADGE_CLASS[ticket.status]}>
                      {tt(STATUS_KEY[ticket.status])}
                    </Badge>
                    <span dir="ltr" className="text-[11px] text-muted-foreground">
                      {formatDateTime(ticket.updatedAt)}
                    </span>
                  </div>
                </Link>
              ))}
          </div>
        )}
      </CardContent>
      <CardFooter className="flex flex-col gap-2 border-t-0 bg-transparent pt-1">
        <div className="flex w-full flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={status !== "connected" || conversationClosed}
            onClick={() => handleIntentChip(t("complaintMessage"))}
          >
            <MessageSquareWarning className="size-3.5" />
            {t("complaintChip")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={status !== "connected" || conversationClosed}
            onClick={() => handleIntentChip(t("inquiryMessage"))}
          >
            <CircleHelp className="size-3.5" />
            {t("inquiryChip")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={status !== "connected"}
            onClick={handleTogglePreviousTickets}
          >
            <Ticket className="size-3.5" />
            {t("previousTicketsChip")}
          </Button>
          {(escalationState === "idle" || escalationState === "requesting") && !conversationClosed && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={status !== "connected" || escalationState === "requesting"}
              onClick={handleEscalate}
            >
              <MessageSquareWarning className="size-3.5" />
              {escalationState === "requesting" ? t("talkToHumanRequesting") : t("talkToHuman")}
            </Button>
          )}
        </div>
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
            placeholder={t("composerPlaceholder")}
            rows={1}
            disabled={status !== "connected" || conversationClosed}
            className="min-h-9"
          />
          <Button
            type="button"
            size="icon"
            disabled={status !== "connected" || conversationClosed || draft.trim().length === 0}
            onClick={handleSend}
          >
            <Send className="size-4" />
            <span className="sr-only">{t("send")}</span>
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}
