import { z } from "zod";
import { emailSchema, optionalPhoneSchema, passwordSchema, requiredString } from "./common";

// Only /register goes through zod here — /login, /refresh, and /logout
// deliberately keep their hand-rolled checks (see auth.routes.ts): those
// return a generic 401 by design, to avoid distinguishing "malformed
// request" from "wrong credentials"/"invalid token" for an
// anti-enumeration/anti-probing reason a generic 400 shape-validator would
// undermine.
export const registerBodySchema = z.object({
  name: requiredString("name is required"),
  email: emailSchema("valid email is required"),
  password: passwordSchema("password is required"),
  phone: optionalPhoneSchema().optional(),
});

export type RegisterBody = z.infer<typeof registerBodySchema>;

// auth Story 65 (forgot password). Unlike /login, these two routes' body
// shape is not itself a credential-enumeration surface — the anti-
// enumeration behavior lives in the handler (always the same 200/400 shape
// regardless of whether the email/token is valid), not in whether the body
// is well-formed — so going through zod here is safe.
export const forgotPasswordBodySchema = z.object({
  email: emailSchema("valid email is required"),
});
export type ForgotPasswordBody = z.infer<typeof forgotPasswordBodySchema>;

export const resetPasswordBodySchema = z.object({
  token: requiredString("token is required"),
  newPassword: passwordSchema("password is required"),
});
export type ResetPasswordBody = z.infer<typeof resetPasswordBodySchema>;
