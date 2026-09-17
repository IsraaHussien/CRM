import { z } from "zod";
import { isValidPhone } from "../utils/phone";
import { emailSchema, flexibleDateSchema, passwordSchema, requiredString } from "./common";

// Format-only — "this is already your current email" / "email already in
// use" / the confirm-email send both depend on the loaded user document and
// stay inline in me.routes.ts.
export const contactBodySchema = z.object({
  phone: z
    .string({ error: "phone must be a string" })
    .trim()
    .refine((val) => val === "" || isValidPhone(val), { message: "phone must be a valid phone number" })
    .transform((val) => (val === "" ? undefined : val))
    .optional(),
  email: emailSchema("valid email is required").optional(),
});

export const availabilityBodySchema = z.object({
  isOnline: z.boolean({ error: "isOnline must be a boolean" }),
});

// auth Story 64 (change password). "Differs from current" and "current
// password is correct" both need the loaded User document (bcrypt.compare),
// so they're enforced in the me.routes.ts handler, not here — same division
// of labor as contactBodySchema above. `refreshToken` is the raw value the
// frontend Server Action forwards from its own REFRESH_COOKIE, used only to
// identify the caller's current RefreshFamily so it can be exempted from the
// bulk revoke — optional, since a caller with no refresh session can still
// change their password (they just lose every session, including this one).
export const changePasswordSchema = z.object({
  currentPassword: requiredString("currentPassword is required"),
  newPassword: passwordSchema("newPassword is required"),
  refreshToken: z.string().optional(),
});

// Backs the "view all notifications" history page. All fields optional and
// only meaningfully used together — GET /me/notifications switches into
// full-history mode (paginated, date-filterable, newest-first) whenever
// ANY of these is present; with none present it keeps its original
// bell-dropdown behavior (unread-first, capped at 50, plain array) so that
// existing caller is untouched.
export const notificationHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(50).optional().default(10),
  from: flexibleDateSchema().optional(),
  to: flexibleDateSchema().optional(),
});
