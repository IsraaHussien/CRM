import { z } from "zod";
import { requiredString, objectIdSchema, flexibleDateSchema } from "./common";

export const SUBJECT_MAX_LENGTH = 200;
export const DESCRIPTION_MAX_LENGTH = 4000;
export const CATEGORY_MAX_LENGTH = 100;
const SEARCH_QUERY_MAX_LENGTH = 200;

const REQUIRED_MESSAGE = "subject and description are required";

export const ALLOWED_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export const ALLOWED_STATUSES = ["new", "in_progress", "answered", "escalated", "closed"] as const;
export const ALLOWED_SORT_KEYS = ["updatedAt", "status", "category", "priority"] as const;
// ticket-management Story 63: mirrors TicketCreationChannel in Ticket.ts.
export const ALLOWED_CREATION_CHANNELS = ["customer_portal", "ai", "phone", "email", "in_person", "other"] as const;

const categoryFieldSchema = z
  .string()
  .trim()
  .max(CATEGORY_MAX_LENGTH, `category must be at most ${CATEGORY_MAX_LENGTH} characters`)
  .nullable()
  .optional()
  .transform((val) => (val ? val : null));

// Only the fields every caller (customer or staff) can set are covered here
// — customerId/priority/notifyCustomer are staff-only, conditional on
// req.user's role (not known to a body-shape schema), and stay validated
// inline in ticket.routes.ts exactly as before.
export const createTicketBodySchema = z
  .object({
    subject: requiredString(REQUIRED_MESSAGE).max(
      SUBJECT_MAX_LENGTH,
      `subject must be at most ${SUBJECT_MAX_LENGTH} characters`
    ),
    description: requiredString(REQUIRED_MESSAGE).max(
      DESCRIPTION_MAX_LENGTH,
      `description must be at most ${DESCRIPTION_MAX_LENGTH} characters`
    ),
    category: categoryFieldSchema,
    // Story 62: set when the customer accepted the AI's "open a ticket"
    // suggestion from a live chat — provenance only, validated here as a
    // well-formed id; ownership of the conversation is checked in the route.
    sourceConversation: objectIdSchema("sourceConversation must be a valid id").optional(),
  })
  // customerId/priority/notifyCustomer are staff-only fields this schema
  // doesn't know about (see ticket.routes.ts) — passthrough so validateBody
  // replacing req.body with the parsed result doesn't silently drop them.
  .passthrough();

// Story 9: change category and/or priority on an existing ticket. Shape
// only — "category must match an active TicketCategory" is a DB lookup and
// stays inline in ticket.routes.ts's PATCH /:id handler (same pattern as
// every other DB-dependent rule in this codebase). Whether a field is even
// present is decided against the RAW request body in the route handler, not
// this parsed result — categoryFieldSchema's transform turns an absent key
// into `null`, same as it does for the create schema above, which would
// otherwise make "field omitted" indistinguishable from "field explicitly
// cleared."
export const updateTicketBodySchema = z.object({
  category: categoryFieldSchema,
  priority: z
    .enum(ALLOWED_PRIORITIES, { error: `priority must be one of: ${ALLOWED_PRIORITIES.join(", ")}` })
    .optional(),
  // Story 25 (agent-workspace): manual reassignment. Shape only, same
  // reasoning as category above — "must be an active agent" is a DB lookup
  // that stays inline in the route handler. Nullable (unlike category's
  // transform, this passes null straight through) so a caller can
  // explicitly unassign a ticket, not just move it between agents.
  assignedAgent: objectIdSchema("assignedAgent must be a valid id").nullable().optional(),
});

// Story 60 (merged with customer-portal Story 36 + platform Story 59): query
// params for GET /api/v1/tickets. All optional — the route handler applies
// role-based defaults/overrides (e.g. forcing `customer`/`assignedAgent`
// scope) that this schema has no knowledge of; it only validates shape.
export const listTicketsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(10),
  status: z.enum(ALLOWED_STATUSES).optional(),
  category: z.string().trim().min(1).optional(),
  priority: z.enum(ALLOWED_PRIORITIES).optional(),
  // Story 63: filter the staff queue by how the ticket was created.
  createdVia: z.enum(ALLOWED_CREATION_CHANNELS).optional(),
  // Story 60 follow-up: free-text search across subject, customer name, and
  // assigned-agent name (see ticket.routes.ts's GET / — customer/agent names
  // live on the referenced User documents, not on Ticket itself, so the
  // route resolves matching User ids before building the Mongo filter).
  q: z.string().trim().min(1).max(SEARCH_QUERY_MAX_LENGTH).optional(),
  sort: z
    .string()
    .regex(
      new RegExp(`^-?(${ALLOWED_SORT_KEYS.join("|")})$`),
      `sort must be one of: ${ALLOWED_SORT_KEYS.join(", ")}, optionally prefixed with -`
    )
    .optional(),
  // Date-range filters on the two timestamps the queue's own sort options
  // already cover (createdAt/updatedAt) — independent pairs, not one
  // "date field" toggle, so a caller can filter by both at once (e.g.
  // "created last week, but only ones still updated today").
  createdFrom: flexibleDateSchema().optional(),
  createdTo: flexibleDateSchema().optional(),
  updatedFrom: flexibleDateSchema().optional(),
  updatedTo: flexibleDateSchema().optional(),
});

// ticket-management Story 11: PATCH /:id/status body. "escalated" is
// deliberately excluded — Story 12 owns that transition, this endpoint
// rejects it at the validation layer so it never reaches the transition
// service.
export const ALLOWED_MANUAL_STATUSES = ["new", "in_progress", "answered", "closed"] as const;

export const updateTicketStatusSchema = z.object({
  status: z.enum(ALLOWED_MANUAL_STATUSES, {
    error: `status must be one of: ${ALLOWED_MANUAL_STATUSES.join(", ")}`,
  }),
});

export const REPLY_TEXT_MAX_LENGTH = DESCRIPTION_MAX_LENGTH;

// Story 56: the reply-text field of POST /:id/messages. Multer parses the
// multipart body before this runs (see ticket.routes.ts), so this is used
// via an inline `.safeParse(req.body)` there, never `validateBody` —
// validateBody assumes req.body is already the full request payload, but
// multer's own body-parsing populates req.body with only the non-file
// fields as strings, which this schema is shaped to match.
// ticket-management Story 12: POST /:id/escalate body. A dedicated schema,
// not a reuse of updateTicketBodySchema's assignedAgent field — escalation
// targets are agent/admin/subadmin, not just agents, and this endpoint is
// unrelated to reassignment.
export const escalateTicketBodySchema = z.object({
  escalatedTo: objectIdSchema("escalatedTo must be a valid user id"),
});

export const replyToTicketBodySchema = z.object({
  text: requiredString("reply text is required").max(
    REPLY_TEXT_MAX_LENGTH,
    `reply text must be at most ${REPLY_TEXT_MAX_LENGTH} characters`
  ),
});

// agent-workspace Story 24: POST /:id/internal-notes body. `text` mirrors
// replyToTicketBodySchema's limit exactly (REPLY_TEXT_MAX_LENGTH) rather
// than picking its own — an internal note and a reply are the same Message
// document with a different `internal` flag, so a divergent cap would only
// be a surprise. `taggedUserIds` is shape-only (well-formed ObjectIds,
// capped at 20 so one note can't fan out into notification spam); "must be
// an active agent/admin/subadmin, not a customer" is a DB lookup that stays
// inline in the route handler, same as every other DB-dependent rule here.
export const MAX_INTERNAL_NOTE_TAGS = 20;

export const postInternalNoteBodySchema = z.object({
  text: requiredString("note text is required").max(
    REPLY_TEXT_MAX_LENGTH,
    `note text must be at most ${REPLY_TEXT_MAX_LENGTH} characters`
  ),
  taggedUserIds: z
    .array(objectIdSchema("taggedUserIds must contain valid user ids"))
    .max(MAX_INTERNAL_NOTE_TAGS, `you can tag at most ${MAX_INTERNAL_NOTE_TAGS} colleagues on one note`)
    .optional()
    .default([]),
});
