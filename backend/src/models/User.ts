import mongoose, { Document, Schema, Types } from "mongoose";
import { PERMISSION_KEYS, PermissionKey } from "../constants/permissions";
import { nextSequence } from "./Counter";

export type UserRole = "customer" | "agent" | "admin" | "subadmin";
export type Language = "en" | "ar";

export interface IAttachment {
  _id: Types.ObjectId;
  fileName: string;
  // The PROTECTED route path the frontend links to (e.g.
  // /api/v1/customers/<id>/attachments/<attachmentId>) — never a raw
  // filesystem path, and never returned by any unauthenticated route.
  url: string;
  // The opaque on-disk filename multer generated at upload time (see
  // backend/src/middleware/upload.ts) — internal only, never included in
  // any API response. Needed because `url` is the protected route's
  // *logical* path, not a disk path, so the download route needs some way
  // to find the actual file.
  storageFileName: string;
  // Bytes, populated server-side from multer's file.size — never trusted
  // from the client, so it can't be spoofed.
  size: number;
  uploadedBy?: Types.ObjectId;
  createdAt?: Date;
}

export interface IInternalNote {
  _id: Types.ObjectId;
  text: string;
  authorId?: Types.ObjectId;
  createdAt?: Date;
}

/**
 * Covers Customer, Agent, and Admin — they share login/role mechanics (auth feature).
 * Customer-specific fields (notes, attachments) support the customer-management feature
 * (Stories 4-7). If this grows unwieldy, split customer-only fields into a separate
 * CustomerProfile collection referencing this one — not needed yet at this scale.
 */
export interface IUser extends Document {
  name: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  phone?: string;
  preferredLanguage: Language;
  // Story 5 (customer-management): set while a customer has an unconfirmed
  // email change in flight. `email` itself only changes once the customer
  // clicks the confirmation link — see backend/src/routes/me.routes.ts.
  pendingEmail?: string | null;
  emailConfirmToken?: string | null;
  emailConfirmTokenExpiresAt?: Date | null;
  // auth Story 65 (forgot password): unlike emailConfirmToken above, this is
  // stored HASHED (SHA-256, see backend/src/services/passwordChange.service.ts)
  // — a leaked password-reset token is a full account takeover, not just an
  // email change, so the raw token is never persisted. `passwordResetTokenUsedAt`
  // makes the token one-shot even if a future code path left the hash intact.
  passwordResetTokenHash?: string | null;
  passwordResetTokenExpiresAt?: Date | null;
  passwordResetTokenUsedAt?: Date | null;
  isOnline: boolean;
  internalNotes: IInternalNote[];
  attachments: IAttachment[];
  // Single-slot — zero or one per customer, distinct from the plural
  // `attachments` above: uploading a new one replaces it (see
  // customer.routes.ts's PUT /:id/id-document), it's restricted to image/PDF
  // on upload, and it's kept separate rather than a `kind` discriminator on
  // `attachments` so both the type restriction and the "at most one"
  // invariant are load-bearing at the schema level, not just convention.
  idDocument?: IAttachment;
  isActive: boolean;
  // security-admin Story 46: permissions are granted PER INDIVIDUAL account,
  // not per role — only meaningful for role "agent"/"subadmin" ("admin"
  // always has every permission regardless of this field; "customer" never
  // has any). See backend/src/constants/permissions.ts and
  // backend/src/services/permissions.ts's hasPermission().
  permissions: PermissionKey[];
  // security-admin Story 45: soft-delete for staff accounts (agent/admin/
  // subadmin) — a deleted account is hidden from the roster and fully
  // locked out (isActive is also forced false), but the document is kept
  // for referential integrity (past ticket assignments, audit log entries).
  isDeleted: boolean;
  // Shown in the header user menu and the customer roster instead of email —
  // a stable, non-sensitive display identifier every account gets (customer
  // or staff), assigned once and never reused. 10-digit zero-padded sequence,
  // see Counter.ts's nextSequence() and this schema's pre("validate") hook.
  membershipNumber: string;
  createdAt: Date;
  updatedAt: Date;
}

const attachmentSchema = new Schema<IAttachment>(
  {
    fileName: { type: String, required: true },
    url: { type: String, required: true },
    storageFileName: { type: String, required: true },
    size: { type: Number, required: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

const internalNoteSchema = new Schema<IInternalNote>(
  {
    text: String,
    authorId: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ["customer", "agent", "admin", "subadmin"], required: true },
    phone: String,
    preferredLanguage: { type: String, enum: ["en", "ar"], default: "en" },

    // Story 5 (customer-management): confirm-then-apply email change.
    pendingEmail: { type: String, default: null, lowercase: true, trim: true },
    emailConfirmToken: { type: String, default: null, index: true },
    emailConfirmTokenExpiresAt: { type: Date, default: null },

    // Story 65 (forgot password) — see IUser above for why this is hashed.
    passwordResetTokenHash: { type: String, default: null, index: true },
    passwordResetTokenExpiresAt: { type: Date, default: null },
    passwordResetTokenUsedAt: { type: Date, default: null },

    // Agent-specific (agent-workspace feature, Story 21)
    isOnline: { type: Boolean, default: false },

    // Customer-specific (customer-management feature, Story 7)
    internalNotes: [internalNoteSchema],
    attachments: [attachmentSchema],
    idDocument: { type: attachmentSchema },

    isActive: { type: Boolean, default: true },

    // security-admin Story 46: per-individual-account permissions (agent/subadmin only).
    permissions: [{ type: String, enum: PERMISSION_KEYS }],

    // security-admin Story 45: soft-delete for staff accounts.
    isDeleted: { type: Boolean, default: false },

    membershipNumber: { type: String, unique: true, required: true },
  },
  { timestamps: true }
);

// pre("validate"), not pre("save") — required: true above is enforced during
// validation, which runs BEFORE the "save" middleware phase, so the number
// has to exist by then. Runs for every creation path (register, admin-
// created staff, staff-added customer, both seed scripts) since they all
// go through User.create()/doc.save() — no per-call-site wiring needed.
userSchema.pre("validate", async function (next) {
  if (this.isNew && !this.membershipNumber) {
    const seq = await nextSequence("membershipNumber");
    this.membershipNumber = String(seq).padStart(10, "0");
  }
  next();
});

export const User = mongoose.model<IUser>("User", userSchema);
