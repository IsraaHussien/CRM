"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getTranslations } from "next-intl/server";
import { API_URL, SESSION_COOKIE } from "@/lib/auth";
import { refreshSession } from "@/lib/session";
import { isValidPhone } from "@/lib/phone";
import { peekJwtPayload } from "@/lib/jwt";

const profileSchema = z.object({
  name: z.string().trim().min(1),
  email: z.string().trim().min(1).email(),
  phone: z.string().trim().refine((v) => v === "" || isValidPhone(v)),
});

export interface ProfileActionState {
  error: string | null;
  message: string | null;
  fieldErrors?: { name?: string; email?: string; phone?: string };
}

export async function updateProfile(
  id: string,
  _prevState: ProfileActionState,
  formData: FormData
): Promise<ProfileActionState> {
  const t = await getTranslations("CustomerProfile");
  const parsed = profileSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    phone: formData.get("phone"),
  });

  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors;
    return {
      error: null,
      message: null,
      fieldErrors: {
        name: fieldErrors.name ? t("nameRequired") : undefined,
        email: fieldErrors.email ? t("invalidEmail") : undefined,
        phone: fieldErrors.phone ? t("invalidPhone") : undefined,
      },
    };
  }

  const tAuth = await getTranslations("Auth");
  const cookieStore = await cookies();
  let token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) {
    token = (await refreshSession()) ?? undefined;
  }
  if (!token) {
    return { error: tAuth("notSignedIn"), message: null };
  }

  const { phone, email, name } = parsed.data;

  // backend/src/routes/customer.routes.ts's PATCH /:id deliberately 400s an
  // email change from the SAME account it belongs to ("isSelf") — that has
  // to go through the confirm-then-apply flow at PATCH /me/contact instead
  // (Story 5), while a staff member editing a DIFFERENT customer's record
  // keeps applying email immediately (a different trust boundary). This
  // form always submits all three fields together, so a self-edit needs to
  // route them to two different endpoints rather than always sending email
  // straight to /customers/:id, which is what previously made every
  // customer self-save fail regardless of whether email actually changed.
  const { id: callerId } = peekJwtPayload(token);
  const isSelf = callerId === id;

  const doFetch = (bearer: string, path: string, body: Record<string, unknown>) =>
    fetch(`${API_URL}${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    });

  // Inline refresh-and-retry, not a redirect — see settings/actions.ts for
  // why (a redirect here would silently drop this profile-edit submission).
  async function patchWithRefresh(path: string, body: Record<string, unknown>) {
    let res = await doFetch(token!, path, body);
    if (res.status === 401) {
      const refreshedToken = await refreshSession();
      if (!refreshedToken) return null;
      token = refreshedToken;
      res = await doFetch(refreshedToken, path, body);
    }
    return res;
  }

  const profileBody = isSelf
    ? { name, phone: phone.length > 0 ? phone : null }
    : { name, email, phone: phone.length > 0 ? phone : null };

  const profileRes = await patchWithRefresh(`/api/v1/customers/${id}`, profileBody);
  if (!profileRes) {
    return { error: tAuth("notSignedIn"), message: null };
  }
  if (!profileRes.ok) {
    // Backend has no i18n of its own — map its known, reachable error
    // strings to translated copy rather than showing raw English.
    if (profileRes.status === 409) {
      return { error: t("emailInUse"), message: null };
    }
    if (profileRes.status === 403) {
      return { error: t("noPermission"), message: null };
    }
    return { error: t("genericError"), message: null };
  }

  if (!isSelf) {
    revalidatePath(`/customers/${id}`);
    return { error: null, message: t("saved") };
  }

  // Self-edit: name/phone are already saved above — email (if the field
  // actually changed) still needs the confirm flow. "This is already your
  // current email" isn't a real failure here (name/phone still saved), so
  // it's treated as a no-op rather than shown as an error.
  const emailRes = await patchWithRefresh("/api/v1/me/contact", { email });
  if (!emailRes) {
    return { error: tAuth("notSignedIn"), message: t("saved") };
  }
  const emailData = await emailRes.json();
  revalidatePath(`/customers/${id}`);
  if (emailRes.ok) {
    return { error: null, message: t("savedEmailConfirmationSent", { email }) };
  }
  if (emailData?.error === "This is already your current email") {
    return { error: null, message: t("saved") };
  }
  if (emailData?.error === "Email already in use" || emailRes.status === 409) {
    return { error: t("emailInUse"), message: t("saved") };
  }
  return { error: t("genericError"), message: t("saved") };
}

export interface UploadActionState {
  error: string | null;
}

const INITIAL_UPLOAD_STATE: UploadActionState = { error: null };

// Shared by uploadAttachments/replaceIdDocument — both forward a multipart
// FormData (containing File entries) straight through to the backend, never
// touching Content-Type themselves (fetch sets the correct multipart
// boundary from the FormData body automatically).
async function doMultipartRequest(
  path: string,
  method: "POST" | "PUT",
  formData: FormData
): Promise<{ ok: true } | { ok: false; error: string }> {
  const tAuth = await getTranslations("Auth");
  const t = await getTranslations("CustomerProfile");
  const cookieStore = await cookies();
  let token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) {
    token = (await refreshSession()) ?? undefined;
  }
  if (!token) {
    return { ok: false, error: tAuth("notSignedIn") };
  }

  const doFetch = (bearer: string) =>
    fetch(`${API_URL}${path}`, { method, headers: { Authorization: `Bearer ${bearer}` }, body: formData });

  let res = await doFetch(token);
  if (res.status === 401) {
    const refreshedToken = await refreshSession();
    if (!refreshedToken) {
      return { ok: false, error: tAuth("notSignedIn") };
    }
    res = await doFetch(refreshedToken);
  }

  if (!res.ok) {
    const data = await res.json().catch(() => null);
    if (data?.error === "UNSUPPORTED_FILE_TYPE") {
      return { ok: false, error: t("unsupportedFileType") };
    }
    if (res.status === 413) {
      return { ok: false, error: t("fileTooLarge") };
    }
    return { ok: false, error: t("genericError") };
  }

  return { ok: true };
}

export async function addInternalNote(
  customerId: string,
  _prevState: UploadActionState,
  formData: FormData
): Promise<UploadActionState> {
  const t = await getTranslations("CustomerProfile");
  const text = formData.get("text");
  if (typeof text !== "string" || text.trim().length === 0) {
    return { error: t("noteRequired") };
  }

  const tAuth = await getTranslations("Auth");
  const cookieStore = await cookies();
  let token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) {
    token = (await refreshSession()) ?? undefined;
  }
  if (!token) {
    return { error: tAuth("notSignedIn") };
  }

  const doFetch = (bearer: string) =>
    fetch(`${API_URL}/api/v1/customers/${customerId}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ text: text.trim() }),
    });

  let res = await doFetch(token);
  if (res.status === 401) {
    const refreshedToken = await refreshSession();
    if (!refreshedToken) {
      return { error: tAuth("notSignedIn") };
    }
    res = await doFetch(refreshedToken);
  }
  if (!res.ok) {
    return { error: t("genericError") };
  }

  revalidatePath(`/customers/${customerId}`);
  return { error: null };
}

export async function uploadAttachments(
  customerId: string,
  _prevState: UploadActionState,
  formData: FormData
): Promise<UploadActionState> {
  const result = await doMultipartRequest(`/api/v1/customers/${customerId}/attachments`, "POST", formData);
  if (!result.ok) return { error: result.error };
  revalidatePath(`/customers/${customerId}`);
  return INITIAL_UPLOAD_STATE;
}

export async function replaceIdDocument(
  customerId: string,
  _prevState: UploadActionState,
  formData: FormData
): Promise<UploadActionState> {
  const result = await doMultipartRequest(`/api/v1/customers/${customerId}/id-document`, "PUT", formData);
  if (!result.ok) return { error: result.error };
  revalidatePath(`/customers/${customerId}`);
  return INITIAL_UPLOAD_STATE;
}

export async function editInternalNote(
  customerId: string,
  noteId: string,
  _prevState: UploadActionState,
  formData: FormData
): Promise<UploadActionState> {
  const t = await getTranslations("CustomerProfile");
  const text = formData.get("text");
  if (typeof text !== "string" || text.trim().length === 0) {
    return { error: t("noteRequired") };
  }

  const tAuth = await getTranslations("Auth");
  const cookieStore = await cookies();
  let token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) {
    token = (await refreshSession()) ?? undefined;
  }
  if (!token) {
    return { error: tAuth("notSignedIn") };
  }

  const doFetch = (bearer: string) =>
    fetch(`${API_URL}/api/v1/customers/${customerId}/notes/${noteId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ text: text.trim() }),
    });

  let res = await doFetch(token);
  if (res.status === 401) {
    const refreshedToken = await refreshSession();
    if (!refreshedToken) {
      return { error: tAuth("notSignedIn") };
    }
    res = await doFetch(refreshedToken);
  }
  if (!res.ok) {
    return { error: t("genericError") };
  }

  revalidatePath(`/customers/${customerId}`);
  return { error: null };
}

export async function deleteAttachment(customerId: string, attachmentId: string): Promise<{ error: string | null }> {
  const t = await getTranslations("CustomerProfile");
  const tAuth = await getTranslations("Auth");
  const cookieStore = await cookies();
  let token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) {
    token = (await refreshSession()) ?? undefined;
  }
  if (!token) {
    return { error: tAuth("notSignedIn") };
  }

  const doFetch = (bearer: string) =>
    fetch(`${API_URL}/api/v1/customers/${customerId}/attachments/${attachmentId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${bearer}` },
    });

  let res = await doFetch(token);
  if (res.status === 401) {
    const refreshedToken = await refreshSession();
    if (!refreshedToken) {
      return { error: tAuth("notSignedIn") };
    }
    res = await doFetch(refreshedToken);
  }
  if (!res.ok) {
    return { error: t("genericError") };
  }

  revalidatePath(`/customers/${customerId}`);
  return { error: null };
}

// customer-management Story 6: mirrors tickets/[id]/actions.ts's
// getTicketHistory exactly — takes the access token directly (called from
// page.tsx right after it resolves its own token, same reasoning that file
// documents) and degrades to [] on any failure rather than throwing, so a
// history-fetch problem never blocks the rest of the profile page.
export interface CustomerTimelineItem {
  type: "ticket" | "chat";
  id: string;
  subject?: string;
  status: string;
  createdAt: string;
}

export async function getCustomerHistory(customerId: string, accessToken: string): Promise<CustomerTimelineItem[]> {
  const res = await fetch(`${API_URL}/api/v1/customers/${customerId}/history`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { items: CustomerTimelineItem[] };
  return body.items;
}
