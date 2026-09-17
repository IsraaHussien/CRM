import { z } from "zod";
import { isValidPhone } from "../utils/phone";
import { emailSchema, optionalPhoneSchema, passwordSchema, paginationQuerySchema, requiredString } from "./common";

export const NOTE_MAX_LENGTH = 4000;
const NAME_MAX_LENGTH = 200;
const SEARCH_QUERY_MAX_LENGTH = 200;

export const ALLOWED_CUSTOMER_SORT_KEYS = ["createdAt", "name"] as const;

// Query params for GET /api/v1/customers — the roster this was originally
// flagged as deferring (see customer.routes.ts's GET / comment); filters
// added at the user's direct request, mirroring ticket.schema.ts's
// listTicketsQuerySchema pattern (page/limit shared via paginationQuerySchema).
export const listCustomersQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().min(1).max(SEARCH_QUERY_MAX_LENGTH).optional(),
  isActive: z.enum(["true", "false"]).optional(),
  sort: z
    .string()
    .regex(
      new RegExp(`^-?(${ALLOWED_CUSTOMER_SORT_KEYS.join("|")})$`),
      `sort must be one of: ${ALLOWED_CUSTOMER_SORT_KEYS.join(", ")}, optionally prefixed with -`
    )
    .optional(),
});

// GET /api/v1/customers/:id/history — a "most recent N, merged across
// Ticket + Conversation" read, not an offset-paginated list, so this
// deliberately does NOT extend paginationQuerySchema (no `page` concept).
export const customerHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

export const createCustomerBodySchema = z.object({
  name: requiredString("name is required"),
  email: emailSchema(),
  password: passwordSchema(),
  phone: optionalPhoneSchema()
    .optional()
    .transform((val) => (val ? val : undefined)),
});

// Every field is optional here — PATCH /:id in customer.routes.ts decides
// per-key which of these to actually run (whitelist/self-edit rules aren't
// expressible as a body shape, so they stay inline there).
export const updateCustomerBodySchema = z.object({
  // Reuses the same ("must be a non-empty string") message for the
  // too-long case too — matches the pre-zod behavior in customer.routes.ts,
  // odd as that pairing reads.
  name: requiredString("name must be a non-empty string")
    .max(NAME_MAX_LENGTH, "name must be a non-empty string")
    .optional(),
  email: emailSchema().optional(),
  phone: z
    .string({ error: "phone must be a string or null" })
    .trim()
    .nullable()
    .refine((val) => val === null || val === "" || isValidPhone(val), {
      message: "phone must be a valid phone number",
    })
    .transform((val) => (val === null || val === "" ? undefined : val))
    .optional(),
  preferredLanguage: z.enum(["en", "ar"], { error: "preferredLanguage must be 'en' or 'ar'" }).optional(),
});

// POST /:id/notes and PATCH /:id/notes/:noteId — deliberately symbolic
// error codes (not sentence messages), matching the rest of the API's
// { error } contract for these two routes specifically.
export const noteBodySchema = z.object({
  text: requiredString("TEXT_REQUIRED").max(NOTE_MAX_LENGTH, "TEXT_TOO_LONG"),
});
