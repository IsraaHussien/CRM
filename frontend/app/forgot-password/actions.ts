"use server";

import { z } from "zod";
import { getTranslations } from "next-intl/server";
import { API_URL } from "@/lib/auth";

const forgotPasswordSchema = z.object({
  email: z.string().trim().min(1).email(),
});

export interface ForgotPasswordActionState {
  ok: boolean;
  error: string | null;
  fieldErrors?: { email?: string };
}

// Always surfaces the backend's generic message on success — never branches
// on, or exposes, whether the email actually matched an account (see
// backend/src/routes/auth.routes.ts's POST /forgot-password).
export async function requestPasswordReset(
  _prevState: ForgotPasswordActionState,
  formData: FormData
): Promise<ForgotPasswordActionState> {
  const t = await getTranslations("ForgotPassword");
  const parsed = forgotPasswordSchema.safeParse({ email: formData.get("email") });

  if (!parsed.success) {
    return { ok: false, error: null, fieldErrors: { email: t("invalidEmail") } };
  }

  const res = await fetch(`${API_URL}/api/v1/auth/forgot-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(parsed.data),
  });

  if (!res.ok) {
    return { ok: false, error: t("genericError") };
  }

  return { ok: true, error: null };
}
