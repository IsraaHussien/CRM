"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getTranslations } from "next-intl/server";
import { API_URL, SESSION_COOKIE, REFRESH_COOKIE } from "@/lib/auth";
import { refreshSession } from "@/lib/session";
import { isValidPhone } from "@/lib/phone";

export interface ContactActionState {
  error: string | null;
  message: string | null;
}

// A Server Action, unlike a Server Component, CAN write cookies — so on a
// 401 it refreshes inline and retries once, rather than redirecting (a
// redirect here would silently drop the user's phone/email submission). See
// .squad/plans/auth/02-story-login-customer-agent-or-admin.md, "Addendum:
// Refresh token mechanism".
async function callContactApi(body: Record<string, string>) {
  const cookieStore = await cookies();
  let token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) {
    token = (await refreshSession()) ?? undefined;
  }
  if (!token) {
    return { ok: false, data: { error: "Not signed in" } };
  }

  const doFetch = (bearer: string) =>
    fetch(`${API_URL}/api/v1/me/contact`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    });

  let res = await doFetch(token);
  if (res.status === 401) {
    const refreshedToken = await refreshSession();
    if (!refreshedToken) {
      return { ok: false, status: 401, data: { error: "Not signed in" } };
    }
    res = await doFetch(refreshedToken);
  }
  return { ok: res.ok, status: res.status, data: await res.json() };
}

export async function updatePhone(
  _prevState: ContactActionState,
  formData: FormData
): Promise<ContactActionState> {
  const t = await getTranslations("Settings");
  const phone = String(formData.get("phone") ?? "").trim();
  if (phone !== "" && !isValidPhone(phone)) {
    return { error: t("invalidPhone"), message: null };
  }
  const { ok, data } = await callContactApi({ phone });
  // Backend has no i18n of its own — the only realistic failure left here
  // (phone format is already validated above) is an auth hiccup, so a
  // generic translated fallback covers it; no need for per-string mapping.
  if (!ok) return { error: t("phoneUpdateFailed"), message: null };
  revalidatePath("/settings");
  return { error: null, message: t("phoneUpdated") };
}

export async function updateEmail(
  _prevState: ContactActionState,
  formData: FormData
): Promise<ContactActionState> {
  const t = await getTranslations("Settings");
  const email = String(formData.get("email") ?? "");
  const { ok, status, data } = await callContactApi({ email });
  if (!ok) {
    // Backend has no i18n of its own — map its known, reachable error
    // strings to translated copy rather than showing raw English.
    if (data.error === "valid email is required") {
      return { error: t("invalidEmail"), message: null };
    }
    if (data.error === "This is already your current email") {
      return { error: t("emailUnchanged"), message: null };
    }
    if (status === 409) {
      return { error: t("emailInUse"), message: null };
    }
    if (status === 502) {
      return { error: t("emailSendFailed"), message: null };
    }
    return { error: t("emailUpdateFailed"), message: null };
  }
  revalidatePath("/settings");
  return { error: null, message: t("emailConfirmationSent", { email }) };
}

// auth Story 64 (change password). Same z.string().min(8) rule as
// register/actions.ts's password schema — reused verbatim, not reinvented.
const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8),
    confirmNewPassword: z.string().min(1),
  })
  .refine((v) => v.newPassword === v.confirmNewPassword, { path: ["confirmNewPassword"] })
  .refine((v) => v.currentPassword !== v.newPassword, { path: ["newPassword"] });

export interface ChangePasswordActionState {
  ok: boolean;
  error: string | null;
  fieldErrors?: Partial<Record<"currentPassword" | "newPassword" | "confirmNewPassword", string>>;
}

// Same bearer-token + one-retry-on-401 shape as callContactApi above, but
// this call also forwards the caller's own REFRESH_COOKIE value as
// `refreshToken` in the body — the backend uses it only to identify which
// RefreshFamily is the caller's current session, so it can be exempted from
// the bulk revoke that follows a successful password change (see
// backend/src/routes/me.routes.ts's PATCH /password).
async function callChangePasswordApi(body: { currentPassword: string; newPassword: string }) {
  const cookieStore = await cookies();
  let token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) {
    token = (await refreshSession()) ?? undefined;
  }
  if (!token) {
    return { ok: false, data: { error: "Not signed in" } };
  }
  const refreshToken = cookieStore.get(REFRESH_COOKIE)?.value;

  const doFetch = (bearer: string) =>
    fetch(`${API_URL}/api/v1/me/password`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ ...body, refreshToken }),
    });

  let res = await doFetch(token);
  if (res.status === 401) {
    const refreshedToken = await refreshSession();
    if (!refreshedToken) {
      return { ok: false, status: 401, data: { error: "Not signed in" } };
    }
    res = await doFetch(refreshedToken);
  }
  return { ok: res.ok, status: res.status, data: await res.json() };
}

export async function changePassword(
  _prevState: ChangePasswordActionState,
  formData: FormData
): Promise<ChangePasswordActionState> {
  const t = await getTranslations("Settings");
  const parsed = changePasswordSchema.safeParse({
    currentPassword: formData.get("currentPassword"),
    newPassword: formData.get("newPassword"),
    confirmNewPassword: formData.get("confirmNewPassword"),
  });

  if (!parsed.success) {
    const fieldErrors: ChangePasswordActionState["fieldErrors"] = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as keyof NonNullable<ChangePasswordActionState["fieldErrors"]>;
      if (!key) continue;
      if (key === "newPassword" && issue.code === "custom") {
        fieldErrors[key] = t("changePassword.errors.sameAsCurrent");
      } else if (key === "confirmNewPassword" && issue.code === "custom") {
        fieldErrors[key] = t("changePassword.errors.mismatch");
      } else if (key === "newPassword") {
        fieldErrors[key] = t("changePassword.errors.tooShort");
      } else if (key === "currentPassword") {
        fieldErrors[key] = t("changePassword.errors.currentRequired");
      } else if (key === "confirmNewPassword") {
        fieldErrors[key] = t("changePassword.errors.confirmRequired");
      }
    }
    return { ok: false, error: null, fieldErrors };
  }

  const { ok, status, data } = await callChangePasswordApi({
    currentPassword: parsed.data.currentPassword,
    newPassword: parsed.data.newPassword,
  });

  if (!ok) {
    if (data?.fieldErrors?.currentPassword) {
      return {
        ok: false,
        error: null,
        fieldErrors: { currentPassword: t("changePassword.errors.currentIncorrect") },
      };
    }
    if (data?.fieldErrors?.newPassword) {
      return {
        ok: false,
        error: null,
        fieldErrors: { newPassword: t("changePassword.errors.sameAsCurrent") },
      };
    }
    if (status === 403) {
      return { ok: false, error: t("changePassword.errors.inactive") };
    }
    return { ok: false, error: t("changePassword.errors.failed") };
  }

  return { ok: true, error: null };
}
