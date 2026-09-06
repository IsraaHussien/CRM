import express, { Request, Response } from "express";
import { z } from "zod";
import { Types } from "mongoose";
import bcrypt from "bcryptjs";
import { requireAuth, requireRole, requirePermission } from "../middleware/auth";
import { User, IUser, IAttachment } from "../models/User";
import { hasPermission, isActiveAccount } from "../services/permissions";
import { recordAuditLog } from "../services/auditLog.service";
import { uploadIdDocument, uploadGeneralAttachments, customerFilePath } from "../middleware/upload";
import fs from "fs";
import { validateBody, validateParams } from "../middleware/validate";
import { userIdParamsSchema } from "../validation/common";
import {
  createCustomerBodySchema,
  listCustomersQuerySchema,
  noteBodySchema,
  updateCustomerBodySchema,
} from "../validation/customer.schema";
import { escapeRegex } from "../utils/regex";

// customers:manage now gates agent AND subadmin identically — reversed from
// this route's original design (security-admin Story 46 Task 4, which
// explicitly kept agent ungated to avoid a regression when subadmin
// delegation was added). That bypass left customers:manage exposed as a
// toggleable permission in the admin UI for agent accounts while doing
// nothing, which is confusing and wrong, so agent is gated for real now.
// admin alone remains unconditional (still needs the live isActive check).
function staffOrDelegatedSubadmin(key: Parameters<typeof requirePermission>[0]) {
  return async (req: Request, res: Response, next: import("express").NextFunction): Promise<void> => {
    if (req.user!.role === "agent" || req.user!.role === "subadmin") {
      requirePermission(key)(req, res, next);
      return;
    }
    // admin skips the permission-key check itself, but still needs a live
    // isActive lookup — see isActiveAccount's comment (services/
    // permissions.ts) for why this can't just rely on the JWT's role claim.
    if (!(await isActiveAccount(req.user!.id))) {
      res.status(403).json({ error: "You do not have permission to perform this action" });
      return;
    }
    next();
  };
}

const router = express.Router();

const BCRYPT_SALT_ROUNDS = 10;

// Fields safely editable via this endpoint (Story 4).
// role / isActive / passwordHash / internalNotes / attachments are intentionally
// excluded — see USER_STORIES.md customer-management Story 4 and Story 7.
const EDITABLE_FIELDS = ["name", "email", "phone", "preferredLanguage"] as const;
type EditableField = (typeof EDITABLE_FIELDS)[number];

// Shared by GET/PATCH /:id and the two protected download routes (Story 7) —
// a single definition so the "who can see a customer's full profile" rule
// can't drift between call sites. Same scope as the roster (GET /): agent
// and sub-admin both need the same customers:manage grant the list itself
// requires; only admin is unconditional.
async function isFullStaffViewer(caller: { id: string; role: string }): Promise<boolean> {
  if (caller.role === "admin") {
    // Same isActive re-check as staffOrDelegatedSubadmin above — admin
    // doesn't need a permission key here, but does still need to be a
    // currently-active account, not just hold the right role claim in an
    // old still-unexpired token.
    return isActiveAccount(caller.id);
  }
  if (caller.role === "agent" || caller.role === "subadmin") {
    return hasPermission(caller.id, "customers:manage");
  }
  return false;
}

interface HydratedPerson {
  id: string;
  name: string;
}

async function hydratePeople(ids: (Types.ObjectId | undefined)[]): Promise<Map<string, HydratedPerson>> {
  const uniqueIds = Array.from(new Set(ids.filter((id): id is Types.ObjectId => Boolean(id)).map((id) => String(id))));
  if (uniqueIds.length === 0) return new Map();
  const people = await User.find({ _id: { $in: uniqueIds } }, { name: 1 });
  return new Map(people.map((p) => [String(p._id), { id: String(p._id), name: p.name }]));
}

function hydrateAttachment(attachment: IAttachment, people: Map<string, HydratedPerson>) {
  return {
    id: String(attachment._id),
    fileName: attachment.fileName,
    // Tolerates attachments saved before `size` existed (see Migration notes).
    size: attachment.size ?? null,
    url: attachment.url,
    uploadedAt: attachment.createdAt,
    uploader: attachment.uploadedBy ? (people.get(String(attachment.uploadedBy)) ?? null) : null,
  };
}

// `includeNotes`/`includeAttachments` are independent — notes are staff-only,
// attachments/idDocument are staff-or-self (Story 7). When a flag is false
// its key is omitted entirely (not null/[]), never leaking to a viewer who
// shouldn't even know the field exists.
async function toProfileResponse(user: IUser, opts: { includeNotes: boolean; includeAttachments: boolean }) {
  const base = {
    id: user.id,
    name: user.name,
    email: user.email,
    membershipNumber: user.membershipNumber,
    phone: user.phone ?? null,
    role: user.role,
    preferredLanguage: user.preferredLanguage,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    isActive: user.isActive,
    // See customer-management Story 6 (view-customer-interaction-history). URL shape only.
    ticketHistoryUrl: `/api/v1/customers/${user.id}/history`,
  };

  if (!opts.includeNotes && !opts.includeAttachments) {
    return base;
  }

  const peopleIds: (Types.ObjectId | undefined)[] = [];
  if (opts.includeNotes) peopleIds.push(...user.internalNotes.map((note) => note.authorId));
  if (opts.includeAttachments) {
    peopleIds.push(...user.attachments.map((attachment) => attachment.uploadedBy));
    peopleIds.push(user.idDocument?.uploadedBy);
  }
  const people = await hydratePeople(peopleIds);

  return {
    ...base,
    ...(opts.includeNotes && {
      internalNotes: [...user.internalNotes]
        .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
        .map((note) => ({
          id: String(note._id),
          text: note.text,
          createdAt: note.createdAt,
          author: note.authorId ? (people.get(String(note.authorId)) ?? null) : null,
        })),
    }),
    ...(opts.includeAttachments && {
      attachments: [...user.attachments]
        .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
        .map((attachment) => hydrateAttachment(attachment, people)),
      idDocument: user.idDocument ? hydrateAttachment(user.idDocument, people) : null,
    }),
  };
}

// Not part of any story in USER_STORIES.md — Story 4's own plan explicitly
// flagged this as a gap ("no list/search endpoint... do not invent one
// speculatively") and deferred it. Added at the user's direct request.
// Staff-only: this is a customer roster, not the agent/admin account list
// that Story 45 (security-admin) will own separately. Filters/search (`q`,
// `isActive`, `sort`) added later, at the user's direct request, mirroring
// ticket.routes.ts's GET /'s server-driven filter pattern.
router.get(
  "/",
  requireAuth,
  requireRole("agent", "admin", "subadmin"),
  staffOrDelegatedSubadmin("customers:manage"),
  async (req: Request, res: Response) => {
  const parsed = listCustomersQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid query" });
    return;
  }
  const { page, limit, q, isActive, sort } = parsed.data;
  const skip = (page - 1) * limit;

  const filter: Record<string, unknown> = { role: "customer" as const };
  if (isActive !== undefined) filter.isActive = isActive === "true";
  if (q) {
    const regex = new RegExp(escapeRegex(q), "i");
    filter.$or = [{ name: regex }, { email: regex }, { membershipNumber: regex }];
  }

  let sortSpec: Record<string, 1 | -1> = { createdAt: -1 };
  if (sort) {
    const descending = sort.startsWith("-");
    const key = (descending ? sort.slice(1) : sort) as "createdAt" | "name";
    sortSpec = { [key]: descending ? -1 : 1 };
  }

  const [customers, total] = await Promise.all([
    User.find(filter)
      .select("name email membershipNumber phone isActive createdAt")
      .sort(sortSpec)
      .skip(skip)
      .limit(limit),
    User.countDocuments(filter),
  ]);

  res.status(200).json({
    customers: customers.map((c) => ({
      id: c.id,
      name: c.name,
      email: c.email,
      membershipNumber: c.membershipNumber,
      phone: c.phone ?? null,
      isActive: c.isActive,
      createdAt: c.createdAt,
    })),
    total,
    page,
    limit,
  });
});

// USER_STORIES.md customer-management Story 55 ("Add a customer account (as
// staff)") — staff-created customer, initial password set directly (no
// invite-email flow yet). Mirrors auth.routes.ts's /register validation, but
// role is always "customer" here too — staff cannot use this to create an
// agent/admin account (that's Story 45, security-admin, a separate endpoint).
router.post(
  "/",
  requireAuth,
  requireRole("agent", "admin", "subadmin"),
  staffOrDelegatedSubadmin("customers:manage"),
  validateBody(createCustomerBodySchema),
  async (req: Request<unknown, unknown, z.infer<typeof createCustomerBodySchema>>, res: Response) => {
    const { name, email, password, phone } = req.body;

    const existing = await User.findOne({ email });
    if (existing) {
      res.status(409).json({ error: "An account with this email already exists" });
      return;
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);

    let user;
    try {
      user = await User.create({
        name,
        email,
        passwordHash,
        role: "customer",
        phone,
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        res.status(409).json({ error: "An account with this email already exists" });
        return;
      }
      throw err;
    }

    // security-admin Story 47: a staff-created customer account is auditable
    // — self-registration (auth Story 1) is not, same distinction Story 57
    // draws for staff-created vs. self-submitted tickets below.
    await recordAuditLog({
      actor: req.user!.id,
      action: "customer_created",
      targetType: "User",
      targetId: user.id,
      metadata: { email: user.email },
      ipAddress: req.ip,
    });

    res.status(201).json(await toProfileResponse(user, { includeNotes: false, includeAttachments: false }));
  }
);

router.get("/:id", requireAuth, validateParams(userIdParamsSchema), async (req: Request, res: Response) => {
  // internalNotes/attachments/idDocument ARE loaded here (Story 7) — what's
  // actually exposed in the response is decided by toProfileResponse's
  // includeNotes/includeAttachments flags below, not by what's fetched.
  const user = await User.findById(req.params.id).select("-passwordHash");
  if (!user) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  // Same access scope as the roster (GET /) — a sub-admin who can see the
  // list via a customers:manage delegation can also open what's in it; one
  // couldn't see the list at all without the other, so this was a gap
  // rather than a deliberate narrower boundary.
  const isFullStaff = await isFullStaffViewer(req.user!);
  const isSelf = req.user!.id === String(user._id);
  if (!isFullStaff && !isSelf) {
    res.status(403).json({ error: "You do not have permission to perform this action" });
    return;
  }

  // includeAttachments is unconditionally true here: this line is only ever
  // reached for isFullStaff || isSelf, both of whom are allowed to see the
  // customer's own files — only internalNotes narrows further to staff.
  res.status(200).json(await toProfileResponse(user, { includeNotes: isFullStaff, includeAttachments: true }));
});

router.patch("/:id", requireAuth, validateParams(userIdParamsSchema), async (req: Request, res: Response) => {
  const user = await User.findById(req.params.id);
  if (!user) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  const isSelf = req.user!.id === String(user._id);
  const isFullStaff = await isFullStaffViewer(req.user!);
  if (!isSelf && !(isFullStaff && user.role === "customer")) {
    res.status(403).json({ error: "You do not have permission to perform this action" });
    return;
  }

  const body = req.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    res.status(400).json({ error: "Request body must be a JSON object" });
    return;
  }

  const bodyKeys = Object.keys(body);
  const unknownKey = bodyKeys.find((key) => !EDITABLE_FIELDS.includes(key as EditableField));
  if (unknownKey) {
    res.status(400).json({ error: `Field ${unknownKey} is not editable` });
    return;
  }
  if (bodyKeys.length === 0) {
    res.status(400).json({ error: "No editable fields provided" });
    return;
  }

  // Story 5 ("Maintain contact details"): a customer changing their OWN
  // email must go through the confirm-then-apply flow at
  // PATCH /api/v1/me/contact, not this immediate-apply endpoint — otherwise
  // this endpoint bypasses that story's entire confirmation flow. Staff
  // editing a *different* customer's record (isSelf === false here) is a
  // different trust boundary and keeps immediate-apply. Checked before shape
  // validation since it's not a format rule — even a well-formed email is
  // rejected here for a self-edit.
  if ("email" in body && isSelf) {
    res.status(400).json({
      error: "Update your email from account settings (PATCH /api/v1/me/contact) — it requires confirmation",
    });
    return;
  }

  const parsed = updateCustomerBodySchema.safeParse(body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
    return;
  }

  const updates: Partial<Pick<IUser, EditableField>> = {};
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  if ("name" in body && parsed.data.name !== user.name) {
    changes.name = { before: user.name, after: parsed.data.name };
    updates.name = parsed.data.name;
  }
  if ("email" in body && parsed.data.email !== user.email) {
    changes.email = { before: user.email, after: parsed.data.email };
    updates.email = parsed.data.email;
  }
  if ("phone" in body && parsed.data.phone !== user.phone) {
    changes.phone = { before: user.phone, after: parsed.data.phone };
    updates.phone = parsed.data.phone;
  }
  if ("preferredLanguage" in body && parsed.data.preferredLanguage !== user.preferredLanguage) {
    changes.preferredLanguage = { before: user.preferredLanguage, after: parsed.data.preferredLanguage };
    updates.preferredLanguage = parsed.data.preferredLanguage;
  }

  Object.assign(user, updates);

  try {
    await user.save();
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      res.status(409).json({ error: "Email already in use" });
      return;
    }
    throw err;
  }

  if (Object.keys(changes).length > 0) {
    await recordAuditLog({
      actor: req.user!.id,
      action: "customer_updated",
      targetType: "User",
      targetId: user.id,
      metadata: { changes, editedBySelf: isSelf },
      ipAddress: req.ip,
    });
  }

  res.status(200).json(await toProfileResponse(user, { includeNotes: isFullStaff, includeAttachments: true }));
});

// Protected file access (Story 7) — deliberately NOT `express.static`, which
// would serve every customer's files (including ID documents) to anyone
// with the URL, no login required. Both routes re-run the exact same
// isFullStaffViewer-or-self check GET /:id uses before touching the disk.
router.get(
  "/:id/attachments/:attachmentId",
  requireAuth,
  validateParams(userIdParamsSchema),
  async (req: Request, res: Response) => {
  const user = await User.findById(req.params.id);
  if (!user) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  const isSelf = req.user!.id === String(user._id);
  if (!(await isFullStaffViewer(req.user!)) && !isSelf) {
    res.status(403).json({ error: "You do not have permission to perform this action" });
    return;
  }
  const attachment = user.attachments.find((a) => String(a._id) === req.params.attachmentId);
  if (!attachment) {
    res.status(404).json({ error: "Attachment not found" });
    return;
  }
  res.download(customerFilePath(user.id, attachment.storageFileName), attachment.fileName, (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: "File not found" });
    }
  });
});

router.get(
  "/:id/id-document/file",
  requireAuth,
  validateParams(userIdParamsSchema),
  async (req: Request, res: Response) => {
  const user = await User.findById(req.params.id);
  if (!user) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  const isSelf = req.user!.id === String(user._id);
  if (!(await isFullStaffViewer(req.user!)) && !isSelf) {
    res.status(403).json({ error: "You do not have permission to perform this action" });
    return;
  }
  if (!user.idDocument) {
    res.status(404).json({ error: "ID document not found" });
    return;
  }
  res.download(customerFilePath(user.id, user.idDocument.storageFileName), user.idDocument.fileName, (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: "File not found" });
    }
  });
});

// Staff-only writes (Story 7) — customers never reach these (requireRole
// excludes "customer" outright), matching "notes/attachments are added by
// staff about a customer," never by the customer themselves.
router.post(
  "/:id/notes",
  requireAuth,
  requireRole("agent", "admin", "subadmin"),
  staffOrDelegatedSubadmin("customers:manage"),
  validateParams(userIdParamsSchema),
  validateBody(noteBodySchema),
  async (req: Request<{ id: string }, unknown, z.infer<typeof noteBodySchema>>, res: Response) => {
    const user = await User.findById(req.params.id);
    if (!user || user.role !== "customer") {
      res.status(404).json({ error: "Customer not found" });
      return;
    }

    const { text } = req.body;

    const authorId = new Types.ObjectId(req.user!.id);
    user.internalNotes.push({ _id: new Types.ObjectId(), text, authorId, createdAt: new Date() });
    await user.save();
    const newNote = user.internalNotes[user.internalNotes.length - 1];

    await recordAuditLog({
      actor: req.user!.id,
      action: "customer_note_added",
      targetType: "User",
      targetId: user.id,
      metadata: { noteId: String(newNote._id) },
      ipAddress: req.ip,
    });

    const author = await User.findById(req.user!.id, { name: 1 });
    res.status(201).json({
      id: String(newNote._id),
      text: newNote.text,
      createdAt: newNote.createdAt,
      author: author ? { id: String(author._id), name: author.name } : null,
    });
  }
);

// Edit an existing note's text — any staff who can add a note can also
// correct one, same customers:manage gate. Deliberately no DELETE for notes
// (edit only, by direct instruction) — see attachments below for delete.
router.patch(
  "/:id/notes/:noteId",
  requireAuth,
  requireRole("agent", "admin", "subadmin"),
  staffOrDelegatedSubadmin("customers:manage"),
  validateParams(userIdParamsSchema),
  validateBody(noteBodySchema),
  async (req: Request<{ id: string; noteId: string }, unknown, z.infer<typeof noteBodySchema>>, res: Response) => {
    const user = await User.findById(req.params.id);
    if (!user || user.role !== "customer") {
      res.status(404).json({ error: "Customer not found" });
      return;
    }

    const note = user.internalNotes.find((n) => String(n._id) === req.params.noteId);
    if (!note) {
      res.status(404).json({ error: "Note not found" });
      return;
    }

    note.text = req.body.text;
    await user.save();

    await recordAuditLog({
      actor: req.user!.id,
      action: "customer_note_updated",
      targetType: "User",
      targetId: user.id,
      metadata: { noteId: String(note._id) },
      ipAddress: req.ip,
    });

    const author = note.authorId ? await User.findById(note.authorId, { name: 1 }) : null;
    res.status(200).json({
      id: String(note._id),
      text: note.text,
      createdAt: note.createdAt,
      author: author ? { id: String(author._id), name: author.name } : null,
    });
  }
);

router.post(
  "/:id/attachments",
  requireAuth,
  requireRole("agent", "admin", "subadmin"),
  staffOrDelegatedSubadmin("customers:manage"),
  validateParams(userIdParamsSchema),
  uploadGeneralAttachments,
  async (req: Request<{ id: string }>, res: Response) => {
    const user = await User.findById(req.params.id);
    if (!user || user.role !== "customer") {
      res.status(404).json({ error: "Customer not found" });
      return;
    }

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      res.status(400).json({ error: "At least one file is required" });
      return;
    }

    const uploadedBy = new Types.ObjectId(req.user!.id);
    const newEntries: IAttachment[] = files.map((file) => {
      const _id = new Types.ObjectId();
      return {
        _id,
        fileName: file.originalname,
        storageFileName: file.filename,
        size: file.size,
        uploadedBy,
        createdAt: new Date(),
        url: `/api/v1/customers/${user.id}/attachments/${_id}`,
      };
    });
    user.attachments.push(...newEntries);
    await user.save();

    await recordAuditLog({
      actor: req.user!.id,
      action: "customer_attachment_added",
      targetType: "User",
      targetId: user.id,
      metadata: { attachmentIds: newEntries.map((e) => String(e._id)), fileNames: newEntries.map((e) => e.fileName) },
      ipAddress: req.ip,
    });

    const uploader = await User.findById(req.user!.id, { name: 1 });
    const people = uploader ? new Map([[String(uploader._id), { id: String(uploader._id), name: uploader.name }]]) : new Map();
    res.status(201).json(newEntries.map((entry) => hydrateAttachment(entry, people)));
  }
);

// Delete a general attachment — by direct instruction, no separate "edit"
// action (there's no metadata on an attachment worth editing beyond the
// file itself; replacing one is just delete + re-upload). The ID document
// keeps its existing replace-only behavior (PUT below) — this route is for
// the plural `attachments` array only.
router.delete(
  "/:id/attachments/:attachmentId",
  requireAuth,
  requireRole("agent", "admin", "subadmin"),
  staffOrDelegatedSubadmin("customers:manage"),
  validateParams(userIdParamsSchema),
  async (req: Request<{ id: string; attachmentId: string }>, res: Response) => {
    const user = await User.findById(req.params.id);
    if (!user || user.role !== "customer") {
      res.status(404).json({ error: "Customer not found" });
      return;
    }

    const index = user.attachments.findIndex((a) => String(a._id) === req.params.attachmentId);
    if (index === -1) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }

    // Remove the DB reference first, then best-effort delete the on-disk
    // file — the reverse of the replace-order reasoning on the ID document
    // below: here, a failure to delete the file just leaves a harmless
    // orphaned file, whereas deleting the file first and then failing to
    // save would leave a reference pointing at nothing.
    const [removed] = user.attachments.splice(index, 1);
    await user.save();

    await recordAuditLog({
      actor: req.user!.id,
      action: "customer_attachment_deleted",
      targetType: "User",
      targetId: user.id,
      metadata: { attachmentId: String(removed._id), fileName: removed.fileName },
      ipAddress: req.ip,
    });

    fs.promises.unlink(customerFilePath(user.id, removed.storageFileName)).catch((err) => {
      console.error("[attachments] failed to remove deleted file (best-effort cleanup)", err);
    });

    res.status(204).send();
  }
);

router.put(
  "/:id/id-document",
  requireAuth,
  requireRole("agent", "admin", "subadmin"),
  staffOrDelegatedSubadmin("customers:manage"),
  validateParams(userIdParamsSchema),
  uploadIdDocument,
  async (req: Request<{ id: string }>, res: Response) => {
    const user = await User.findById(req.params.id);
    if (!user || user.role !== "customer") {
      res.status(404).json({ error: "Customer not found" });
      return;
    }

    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "A file is required" });
      return;
    }

    // Failure-safe replacement: write + validate the new file first (multer
    // already did, by this point), persist the new reference, and only THEN
    // best-effort-delete the previous file. Never delete-then-save — a save
    // failure in between would leave the customer with no ID document at all.
    const previous = user.idDocument;
    const _id = new Types.ObjectId();
    user.idDocument = {
      _id,
      fileName: file.originalname,
      storageFileName: file.filename,
      size: file.size,
      uploadedBy: new Types.ObjectId(req.user!.id),
      createdAt: new Date(),
      url: `/api/v1/customers/${user.id}/id-document/file`,
    };
    await user.save();

    await recordAuditLog({
      actor: req.user!.id,
      action: "customer_id_document_updated",
      targetType: "User",
      targetId: user.id,
      metadata: { fileName: user.idDocument.fileName },
      ipAddress: req.ip,
    });

    if (previous) {
      fs.promises.unlink(customerFilePath(user.id, previous.storageFileName)).catch((err) => {
        console.error("[id-document] failed to remove previous file (best-effort cleanup)", err);
      });
    }

    const uploader = await User.findById(req.user!.id, { name: 1 });
    const people = uploader ? new Map([[String(uploader._id), { id: String(uploader._id), name: uploader.name }]]) : new Map();
    res.status(200).json(hydrateAttachment(user.idDocument, people));
  }
);

export default router;
