import mongoose, { Document, Schema, Types } from "mongoose";

export type MessageParentType = "ticket" | "conversation";
export type MessageSenderType = "customer" | "agent" | "ai" | "system";

export interface IMessageAttachment {
  _id: Types.ObjectId;
  fileName: string;
  // The PROTECTED route path the frontend links to (e.g.
  // /api/v1/tickets/<ticketId>/messages/<messageId>/attachments/<attachmentId>)
  // — never a raw filesystem path. Same reasoning as User.ts's IAttachment.
  url: string;
  // The opaque on-disk filename multer generated at upload time (see
  // backend/src/middleware/upload.ts's ticket-scoped storage) — internal
  // only, never included in any API response.
  storageFileName: string;
  // Bytes, populated server-side from multer's file.size.
  size: number;
}

/**
 * A single message on either a Ticket thread or a Conversation (live chat).
 * `parentType` + `parentId` let one model serve both, per CLAUDE.md's data model notes.
 * `senderType: "ai"` covers AI agent replies (live-chat Story 15, ai-features Stories 31-34);
 * `internal: true` covers agent-only notes (agent-workspace Story 24) — never shown to the customer.
 */
export interface IAiTicketSuggestion {
  subject: string;
  description: string;
}

// ai-features Story 34/35 (live-chat half): set on an "ai" message when
// Gemini found one existing, published FAQ or help article genuinely
// relevant to the customer's latest message. `id` always refers to a real
// Faq/HelpArticle document (kbAi.service.ts's suggestKbContent only ever
// returns an id drawn from its own DB-backed shortlist, never one Gemini
// invented) — the frontend links straight to it, never renders fabricated
// content. `title` carries both languages, like every other bilingual KB
// field, so the client picks the viewer's locale the same way the public
// Help Center does. `slug` is only present for articles (FAQs are linked via
// the public Help Center's #faq-<id> anchor instead).
export interface IAiKbSuggestion {
  type: "faq" | "article";
  id: string;
  title: { en: string; ar: string };
  slug?: string;
}

export interface IMessage extends Document {
  parentType: MessageParentType;
  parentId: Types.ObjectId;
  senderType: MessageSenderType;
  senderId: Types.ObjectId | null;
  text: string;
  internal: boolean;
  // agent-workspace Story 24: colleagues explicitly tagged on an internal
  // note (always empty on a non-internal message). Persisted rather than
  // derived from the Notification rows it produces, so the thread can render
  // mention chips on every reload — a notification is a best-effort side
  // effect that may legitimately be missing, and is deleted/read
  // independently of the note it points at. Deduped and validated
  // (active agent/admin/subadmin, never a customer, never the author) at the
  // POST /:id/internal-notes call site.
  taggedUserIds: Types.ObjectId[];
  attachments: IMessageAttachment[];
  // Story 62 (live-chat): set on an "ai" message when Gemini's classifier
  // decided this reply should offer a one-click "open a ticket" suggestion.
  // Persisted (not just emitted) so the card re-hydrates correctly on
  // reconnect/history reload.
  aiTicketSuggestion: IAiTicketSuggestion | null;
  aiKbSuggestion: IAiKbSuggestion | null;
  createdAt: Date;
  updatedAt: Date;
}

const messageSchema = new Schema<IMessage>(
  {
    parentType: { type: String, enum: ["ticket", "conversation"], required: true },
    parentId: { type: Schema.Types.ObjectId, required: true },

    senderType: { type: String, enum: ["customer", "agent", "ai", "system"], required: true },
    senderId: { type: Schema.Types.ObjectId, ref: "User", default: null },

    text: { type: String, required: true },
    internal: { type: Boolean, default: false },
    taggedUserIds: [{ type: Schema.Types.ObjectId, ref: "User" }],

    attachments: [
      {
        fileName: { type: String, required: true },
        url: { type: String, required: true },
        storageFileName: { type: String, required: true },
        size: { type: Number, required: true },
      },
    ],

    aiTicketSuggestion: {
      type: new Schema({ subject: String, description: String }, { _id: false }),
      default: null,
    },

    aiKbSuggestion: {
      type: new Schema(
        {
          type: { type: String, enum: ["faq", "article"], required: true },
          id: { type: String, required: true },
          title: { en: { type: String, default: "" }, ar: { type: String, default: "" } },
          slug: { type: String, required: false },
        },
        { _id: false }
      ),
      default: null,
    },
  },
  { timestamps: true }
);

messageSchema.index({ parentType: 1, parentId: 1, createdAt: 1 });

export const Message = mongoose.model<IMessage>("Message", messageSchema);
