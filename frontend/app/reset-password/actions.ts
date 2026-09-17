"use server";

import { z } from "zod";
import { getTranslations } from "next-intl/server";
import { API_URL } from "@/lib/auth";

// Same z.string().min(8) rule as register/actions.ts and settings/actions.ts —
// reused verbatim, not reinvented.
const resetPasswordSchema = z
  .object({
    token: z.string().min(1),
    newPassword: z.string().min(8),
    confirmPassword: z.string().min(8),
  })
  .refine((v) => v.newPassword === v.confirmPassword, { path: ["confirmPassword"] });

export interface ResetPasswordActionState {
  ok: boolean;
  error: string | null;
  fieldErrors?: { newPassword?: string; confirmPassword?: string };
}

export async function resetPassword(
  _prevState: ResetPasswordActionState,
  formData: FormData
): Promise<ResetPasswordActionState> {
  const t = await getTranslations("ResetPassword");
  const parsed = resetPasswordSchema.safeParse({
    token: formData.get("token"),
    newPassword: formData.get("newPassword"),
    confirmPassword: formData.get("confirmPassword"),
  });

  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors;
    return {
      ok: false,
      error: fieldErrors.token ? t("invalidLink") : null,
      fieldErrors: {
        newPassword: fieldErrors.newPassword ? t("tooShort") : undefined,
        confirmPassword: fieldErrors.confirmPassword ? t("mismatch") : undefined,
      },
    };
  }

  const res = await fetch(`${API_URL}/api/v1/auth/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: parsed.data.token, newPassword: parsed.data.newPassword }),
  });

  if (!res.ok) {
    // The backend's single generic error covers "no such token", "expired",
    // and "already used" alike — surfaced as one message here too, never
    // distinguished.
    return { ok: false, error: t("invalidLink") };
  }

  return { ok: true, error: null };
}
