"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { CircleAlert, Lock, Paperclip, X } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  sendTicketReply,
  postInternalNote,
  listInternalNoteTagTargets,
  type InternalNoteTagTarget,
} from "./actions";

const MAX_NOTE_LENGTH = 4000;
// Mirrors MAX_INTERNAL_NOTE_TAGS in backend/src/validation/ticket.schema.ts —
// the server rejects a 21st tag with a 400; this just stops the picker from
// letting a user build a request that can only fail.
const MAX_TAGS = 20;
// Shown suggestions are capped independently of MAX_TAGS — this is a "don't
// scroll forever" UI limit, not a request limit; the search query narrows
// the list long before this matters in practice.
const MAX_MENTION_SUGGESTIONS = 8;

// Computed CSS properties that affect text layout/wrapping and therefore
// must be copied onto the mirror element for its wrapped line breaks (and so
// its caret span's offset) to land at the same pixel position they would in
// the real textarea. Anything cosmetic (color, background, border-radius…)
// is irrelevant since the mirror is never actually shown.
const CARET_MIRROR_PROPS = [
  "boxSizing",
  "width",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "lineHeight",
  "textTransform",
  "wordSpacing",
  "textIndent",
] as const;

// Classic "mirror div" technique for locating a textarea's caret in pixels:
// no browser API exposes this directly, so a hidden, identically-styled div
// is given the same text up to the caret, and the pixel offset of a marker
// span appended at that point is read back. Coordinates returned are
// relative to the textarea's own content box (top-left), NOT the viewport —
// callers position an absolutely-positioned element inside a `relative`
// wrapper around the textarea using these directly.
function getCaretCoordinates(textarea: HTMLTextAreaElement, position: number): { top: number; left: number; height: number } {
  const div = document.createElement("div");
  const style = window.getComputedStyle(textarea);
  for (const prop of CARET_MIRROR_PROPS) {
    div.style[prop] = style[prop];
  }
  div.style.position = "absolute";
  div.style.visibility = "hidden";
  div.style.whiteSpace = "pre-wrap";
  div.style.wordWrap = "break-word";
  div.style.top = "0";
  div.style.left = "-9999px";
  div.style.height = "auto";
  document.body.appendChild(div);

  div.textContent = textarea.value.slice(0, position);
  const marker = document.createElement("span");
  marker.textContent = textarea.value.slice(position) || ".";
  div.appendChild(marker);

  const top = marker.offsetTop - textarea.scrollTop;
  const left = marker.offsetLeft;
  const lineHeight = parseInt(style.lineHeight, 10);
  document.body.removeChild(div);
  return { top, left, height: Number.isNaN(lineHeight) ? 20 : lineHeight };
}

// Looks backward from the cursor for an "@" that's still being actively
// typed as a mention: it must start a token (preceded by start-of-text or
// whitespace, so an email address's "@" never triggers this) and have no
// whitespace between it and the cursor (typing a space ends mention mode,
// same as every other @mention implementation).
function findMentionTrigger(text: string, cursor: number): { start: number; query: string } | null {
  const upToCursor = text.slice(0, cursor);
  const at = upToCursor.lastIndexOf("@");
  if (at === -1) return null;
  const charBefore = at === 0 ? "" : upToCursor[at - 1];
  if (charBefore && !/\s/.test(charBefore)) return null;
  const query = upToCursor.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

// Story 56: sends immediately on click (no page navigation) — same
// direct-server-action-call shape as TicketDetailSidebar.tsx's
// updateTicketCategory/updateTicketPriority, not useActionState+<form>,
// since state (drafted text, selected files, success/error) is cleared or
// kept based on the action's actual result rather than eagerly on click.
//
// agent-workspace Story 24 wraps this in a two-tab shell: "Reply to
// customer" (unchanged) and "Internal note" (agent-only, never emailed,
// never seen by the customer). The tabs only appear when the viewer actually
// holds tickets:post_internal_note — an account with only tickets:reply sees
// exactly the composer it saw before this story.
export function TicketReplyComposer({
  ticketId,
  canReply = true,
  canPostInternalNote = false,
}: {
  ticketId: string;
  canReply?: boolean;
  canPostInternalNote?: boolean;
}) {
  const t = useTranslations("TicketDetail");

  // Only one of the two is available: render it bare, no tab strip to pick
  // between a single option.
  if (!canPostInternalNote) {
    return (
      <div className="border-t border-border pt-4">
        <ReplyTab ticketId={ticketId} />
      </div>
    );
  }
  if (!canReply) {
    return (
      <div className="border-t border-border pt-4">
        <InternalNoteTab ticketId={ticketId} />
      </div>
    );
  }

  return (
    <Tabs defaultValue="reply" className="border-t border-border pt-4">
      <TabsList>
        <TabsTrigger value="reply">{t("composerReplyTab")}</TabsTrigger>
        <TabsTrigger value="internal">{t("internalNotes.tab")}</TabsTrigger>
      </TabsList>
      <TabsContent value="reply">
        <ReplyTab ticketId={ticketId} />
      </TabsContent>
      <TabsContent value="internal">
        <InternalNoteTab ticketId={ticketId} />
      </TabsContent>
    </Tabs>
  );
}

function ReplyTab({ ticketId }: { ticketId: string }) {
  const t = useTranslations("TicketDetail");
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [justSent, setJustSent] = useState(false);
  const [pending, startTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleSend() {
    const trimmed = text.trim();
    if (!trimmed) return;
    setError(null);
    setJustSent(false);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("text", trimmed);
      files.forEach((file) => formData.append("files", file));
      const result = await sendTicketReply(ticketId, formData);
      if (result.error) {
        setError(result.error);
      } else {
        setText("");
        setFiles([]);
        setJustSent(true);
      }
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setJustSent(false);
        }}
        placeholder={t("replyPlaceholder")}
        rows={3}
        maxLength={4000}
        disabled={pending}
      />
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {files.map((file, index) => (
            <li
              key={`${file.name}-${index}`}
              className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-xs text-muted-foreground"
            >
              <Paperclip className="size-3" />
              {file.name}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!error && justSent && <p className="text-xs text-success">{t("replySent")}</p>}
      <div className="flex items-center justify-between gap-2">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
        />
        <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => fileInputRef.current?.click()}>
          <Paperclip className="size-4" />
          {t("replyAttach")}
        </Button>
        <Button type="button" size="sm" disabled={pending || text.trim().length === 0} onClick={handleSend}>
          {pending ? t("replySendPending") : t("replySend")}
        </Button>
      </div>
    </div>
  );
}

// agent-workspace Story 24: the internal-note half of the composer. No file
// attachments (the backend endpoint takes JSON, not multipart — notes are
// short team annotations, not deliverables) and no "sent by email" anything:
// posting one changes nothing the customer can observe.
//
// Tagging colleagues is a real inline "@" mention, not a separate always-
// visible button: typing "@" opens a floating list, anchored at the caret
// (via the mirror-div technique above), of every staff account the backend
// considers taggable — which is every active agent/admin/subadmin, i.e.
// "every staff member who can view a ticket" (GET /:id has no per-ticket
// ownership gate — see ticket.routes.ts — so that's the whole staff roster,
// not a narrower "assigned to this ticket" set). Picking one inserts
// "@Name " as plain text at the caret and adds them to `tagged`, which is
// the actual source of truth sent as `taggedUserIds` — the "@Name" text is
// a readability aid, not re-parsed on submit. Removing a chip strips its
// first matching "@Name" occurrence back out of the text to keep the two
// in sync from that direction; a manual edit of the raw text is the one
// path this can't reconcile, an accepted limitation of a plain <textarea>
// rather than a full rich-text editor.
function InternalNoteTab({ ticketId }: { ticketId: string }) {
  const t = useTranslations("TicketDetail");
  const [text, setText] = useState("");
  const [tagged, setTagged] = useState<InternalNoteTagTarget[]>([]);
  const [candidates, setCandidates] = useState<InternalNoteTagTarget[]>([]);
  const [candidatesLoaded, setCandidatesLoaded] = useState(false);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionPos, setMentionPos] = useState<{ top: number; left: number; height: number } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [tagErrors, setTagErrors] = useState<Record<string, string>>({});
  const [justPosted, setJustPosted] = useState(false);
  const [pending, startTransition] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Fetched once, lazily, the first time "@" is typed — a staff roster is
  // small and rarely changes mid-session, and an agent who only ever writes
  // untagged notes never pays for the request at all.
  useEffect(() => {
    if (mention === null || candidatesLoaded || candidatesLoading) return;
    let cancelled = false;
    setCandidatesLoading(true);
    void (async () => {
      const targets = await listInternalNoteTagTargets();
      if (cancelled) return;
      setCandidates(targets);
      setCandidatesLoaded(true);
      setCandidatesLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [mention, candidatesLoaded, candidatesLoading]);

  // Re-measure the caret's pixel position whenever the mention trigger or
  // the surrounding text changes — the text affects line-wrapping, so the
  // caret can move even while `mention.start` itself stays put.
  useLayoutEffect(() => {
    if (!mention) {
      setMentionPos(null);
      return;
    }
    const el = textareaRef.current;
    if (!el) return;
    setMentionPos(getCaretCoordinates(el, mention.start));
  }, [mention, text]);

  useEffect(() => {
    setActiveIndex(0);
  }, [mention?.start, mention?.query]);

  const filtered = useMemo(() => {
    if (!mention) return [];
    const query = mention.query.trim().toLowerCase();
    return candidates
      .filter((c) => !tagged.some((u) => u.id === c.id))
      .filter((c) => query.length === 0 || c.name.toLowerCase().includes(query))
      .slice(0, MAX_MENTION_SUGGESTIONS);
  }, [candidates, tagged, mention]);

  function handleTextChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setText(value);
    setJustPosted(false);
    setMention(findMentionTrigger(value, e.target.selectionStart ?? value.length));
  }

  // Fires on every caret move, not just typing (click, arrow keys, Home/End)
  // — closes or updates mention mode the moment the cursor leaves an active
  // "@query" span, same as it opens one when the cursor lands back inside.
  function handleSelectionChange(e: React.SyntheticEvent<HTMLTextAreaElement>) {
    const cursor = e.currentTarget.selectionStart ?? 0;
    setMention(findMentionTrigger(text, cursor));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!mention || filtered.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % filtered.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      selectMention(filtered[Math.min(activeIndex, filtered.length - 1)]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setMention(null);
    }
  }

  function selectMention(candidate: InternalNoteTagTarget) {
    if (!mention || tagged.length >= MAX_TAGS) {
      setMention(null);
      return;
    }
    const before = text.slice(0, mention.start);
    const afterQueryEnd = mention.start + 1 + mention.query.length;
    const after = text.slice(afterQueryEnd);
    const insertion = `@${candidate.name} `;
    const nextCursor = before.length + insertion.length;
    setText(before + insertion + after);
    setTagged((current) => (current.some((u) => u.id === candidate.id) ? current : [...current, candidate]));
    setMention(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextCursor, nextCursor);
    });
  }

  function removeTag(target: InternalNoteTagTarget) {
    setTagErrors({});
    setTagged((current) => current.filter((u) => u.id !== target.id));
    setText((current) => {
      const token = `@${target.name}`;
      const idx = current.indexOf(token);
      if (idx === -1) return current;
      const end = idx + token.length + (current[idx + token.length] === " " ? 1 : 0);
      return current.slice(0, idx) + current.slice(end);
    });
  }

  function handlePost() {
    const trimmed = text.trim();
    if (!trimmed) return;
    setError(null);
    setTagErrors({});
    setJustPosted(false);
    startTransition(async () => {
      const result = await postInternalNote(ticketId, {
        text: trimmed,
        taggedUserIds: tagged.map((u) => u.id),
      });
      if (result.error) {
        setError(result.error);
        setTagErrors(result.taggedUserIdErrors ?? {});
      } else {
        setText("");
        setTagged([]);
        setJustPosted(true);
      }
    });
  }

  // Role labels are duplicated per section throughout messages/*.json (see
  // AdminUsersList/NewStaffAccount) rather than shared — kept consistent
  // with that here instead of introducing a cross-section reference.
  const roleLabel = (role: InternalNoteTagTarget["role"]) =>
    t(
      role === "admin"
        ? "internalNotes.roleAdmin"
        : role === "subadmin"
          ? "internalNotes.roleSubadmin"
          : "internalNotes.roleAgent"
    );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 border-s-4 border-s-warning bg-warning/5 ps-3 pt-1">
        <p className="flex items-center gap-1.5 text-xs text-warning">
          <Lock className="size-3.5" aria-hidden="true" />
          {t("internalNotes.helper")}
        </p>
        <p className="text-xs text-muted-foreground">{t("internalNotes.mentionHint")}</p>
        <div className="relative">
          <Textarea
            ref={textareaRef}
            value={text}
            onChange={handleTextChange}
            onSelect={handleSelectionChange}
            onKeyDown={handleKeyDown}
            placeholder={t("internalNotes.placeholder")}
            rows={3}
            maxLength={MAX_NOTE_LENGTH}
            disabled={pending}
            aria-label={t("internalNotes.tab")}
          />
          {mention && mentionPos && (
            <Popover open onOpenChange={(open) => !open && setMention(null)}>
              <PopoverTrigger asChild>
                <span
                  aria-hidden
                  className="pointer-events-none absolute"
                  style={{ top: mentionPos.top, left: mentionPos.left, width: 1, height: mentionPos.height }}
                />
              </PopoverTrigger>
              <PopoverContent
                align="start"
                sideOffset={4}
                className="w-56 p-1"
                onOpenAutoFocus={(e) => e.preventDefault()}
                onCloseAutoFocus={(e) => e.preventDefault()}
              >
                {filtered.length === 0 ? (
                  <p className="px-2 py-1.5 text-xs text-muted-foreground">
                    {candidatesLoaded ? t("internalNotes.noColleagues") : t("loading")}
                  </p>
                ) : (
                  <ul>
                    {filtered.map((c, index) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          // mousedown (not click/onSelect) fires before the
                          // textarea's blur — preventing default keeps focus
                          // (and the caret position) in the textarea instead
                          // of losing it to this button.
                          onMouseDown={(e) => {
                            e.preventDefault();
                            selectMention(c);
                          }}
                          className={cn(
                            "flex w-full flex-col items-start rounded-md px-2 py-1.5 text-start text-sm",
                            index === Math.min(activeIndex, filtered.length - 1) ? "bg-muted" : "hover:bg-muted/60"
                          )}
                        >
                          <span className="truncate">{c.name}</span>
                          <span className="truncate text-xs text-muted-foreground">{roleLabel(c.role)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </PopoverContent>
            </Popover>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {tagged.length === 0 ? (
            <span className="text-xs text-muted-foreground">{t("internalNotes.noTagsYet")}</span>
          ) : (
            tagged.map((u) => (
              <Badge
                key={u.id}
                variant="outline"
                className={cn(
                  "gap-1 border-warning/40 bg-warning/10 text-warning",
                  tagErrors[u.id] && "border-destructive/50 bg-destructive/10 text-destructive"
                )}
              >
                {u.name}
                <button
                  type="button"
                  onClick={() => removeTag(u)}
                  disabled={pending}
                  aria-label={t("internalNotes.removeTag", { name: u.name })}
                  className="opacity-70 hover:opacity-100"
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))
          )}
        </div>
        {Object.entries(tagErrors).map(([id, message]) => {
          const name = tagged.find((u) => u.id === id)?.name ?? id;
          return (
            <p key={id} className="text-xs text-destructive">
              {name}: {message}
            </p>
          );
        })}
      </div>

      {error && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!error && justPosted && <p className="text-xs text-success">{t("internalNotes.posted")}</p>}

      <div className="flex justify-end">
        <Button type="button" size="sm" disabled={pending || text.trim().length === 0} onClick={handlePost}>
          {pending ? t("internalNotes.postPending") : t("internalNotes.post")}
        </Button>
      </div>
    </div>
  );
}
