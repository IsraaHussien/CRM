import express, { Request, Response } from "express";
import { z } from "zod";
import { requireAuth, requirePermission } from "../middleware/auth";
import { hasAnyPermission, isActiveAccount } from "../services/permissions";
import type { PermissionKey } from "../constants/permissions";
import { validateBody, validateParams } from "../middleware/validate";
import { escapeRegex } from "../utils/regex";
import { HelpArticle, IHelpArticle } from "../models/HelpArticle";
import {
  createHelpArticle,
  updateHelpArticle,
  softDeleteHelpArticle,
  HelpArticleValidationError,
} from "../services/helpArticle.service";
import { suggestTranslation, findSimilarArticles } from "../services/kbAi.service";
import { recordAuditLog } from "../services/auditLog.service";
import {
  articleIdParamsSchema,
  createHelpArticleBodySchema,
  updateHelpArticleBodySchema,
  listHelpArticlesQuerySchema,
  translateArticleFieldBodySchema,
} from "../validation/kbHelpArticle.schema";
import { ARTICLE_TITLE_MAX_LENGTH, ARTICLE_SUMMARY_MAX_LENGTH, ARTICLE_BODY_MAX_LENGTH } from "../constants/kb";

// knowledge-base Story 30: admin surface for help articles, mounted at
// /api/v1/kb/articles. Structurally identical to kbFaq.routes.ts — same
// no-draft, single-permission-per-verb shape.

const router = express.Router();

// Admin-implicit-pass + live isActive re-check — see kbFaq.routes.ts's copy
// of this helper for why the admin branch must not skip isActiveAccount.
async function callerHasAnyPermission(req: Pick<Request, "user">, keys: PermissionKey[]): Promise<boolean> {
  if (req.user!.role === "admin") return isActiveAccount(req.user!.id);
  return hasAnyPermission(req.user!.id, keys);
}

function toArticleResponse(article: IHelpArticle) {
  return {
    id: article.id,
    slug: article.slug,
    title: { en: article.title.en, ar: article.title.ar },
    summary: { en: article.summary.en, ar: article.summary.ar },
    body: { en: article.body.en, ar: article.body.ar },
    category: article.category,
    createdAt: article.createdAt,
    updatedAt: article.updatedAt,
  };
}

// The list payload omits `body` — sending two 50KB Markdown bodies per row
// for a 10-row page is pointless; the edit page fetches the full document
// by id via GET /:id.
function toArticleListItem(article: IHelpArticle) {
  return {
    id: article.id,
    slug: article.slug,
    title: { en: article.title.en, ar: article.title.ar },
    summary: { en: article.summary.en, ar: article.summary.ar },
    category: article.category,
    createdAt: article.createdAt,
    updatedAt: article.updatedAt,
  };
}

router.get("/", requireAuth, requirePermission("kb:article_view_list"), async (req: Request, res: Response) => {
  const parsed = listHelpArticlesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid query" });
    return;
  }
  const { page, limit, q, category, sort } = parsed.data;
  const skip = (page - 1) * limit;

  const filter: Record<string, unknown> = { isDeleted: { $ne: true } };
  if (category) filter.category = category;
  if (q) {
    // Searches title/summary only — a substring match inside a 50KB
    // Markdown body produces useless hits for an admin scanning a list.
    const regex = new RegExp(escapeRegex(q), "i");
    filter.$or = [
      { "title.en": regex },
      { "title.ar": regex },
      { "summary.en": regex },
      { "summary.ar": regex },
    ];
  }

  let sortSpec: Record<string, 1 | -1> = { updatedAt: -1 };
  if (sort) {
    const descending = sort.startsWith("-");
    const key = descending ? sort.slice(1) : sort;
    sortSpec = { [key]: descending ? -1 : 1 };
  }

  const [articles, total] = await Promise.all([
    HelpArticle.find(filter).sort(sortSpec).skip(skip).limit(limit),
    HelpArticle.countDocuments(filter),
  ]);

  res.status(200).json({ articles: articles.map(toArticleListItem), total, page, limit });
});

router.get(
  "/:id",
  requireAuth,
  requirePermission("kb:article_view_list"),
  validateParams(articleIdParamsSchema),
  async (req: Request<{ id: string }>, res: Response) => {
    const article = await HelpArticle.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
    if (!article) {
      res.status(404).json({ error: "Article not found" });
      return;
    }
    res.status(200).json(toArticleResponse(article));
  }
);

router.post(
  "/",
  requireAuth,
  requirePermission("kb:article_create"),
  validateBody(createHelpArticleBodySchema),
  async (req: Request<unknown, unknown, z.infer<typeof createHelpArticleBodySchema>>, res: Response) => {
    try {
      const article = await createHelpArticle({ ...req.body, actorId: req.user!.id });

      await recordAuditLog({
        actor: req.user!.id,
        action: "kb_article_created",
        targetType: "HelpArticle",
        targetId: article.id,
        metadata: { title: article.title.en || article.title.ar, slug: article.slug },
        ipAddress: req.ip,
      });

      res.status(201).json(toArticleResponse(article));
    } catch (err) {
      if (err instanceof HelpArticleValidationError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  }
);

router.patch(
  "/:id",
  requireAuth,
  requirePermission("kb:article_edit"),
  validateParams(articleIdParamsSchema),
  validateBody(updateHelpArticleBodySchema),
  async (
    req: Request<{ id: string }, unknown, z.infer<typeof updateHelpArticleBodySchema>>,
    res: Response
  ) => {
    try {
      const article = await updateHelpArticle(req.params.id, { ...req.body, actorId: req.user!.id });
      if (!article) {
        res.status(404).json({ error: "Article not found" });
        return;
      }

      await recordAuditLog({
        actor: req.user!.id,
        action: "kb_article_updated",
        targetType: "HelpArticle",
        targetId: article.id,
        ipAddress: req.ip,
      });

      res.status(200).json(toArticleResponse(article));
    } catch (err) {
      if (err instanceof HelpArticleValidationError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  }
);

router.delete(
  "/:id",
  requireAuth,
  requirePermission("kb:article_delete"),
  validateParams(articleIdParamsSchema),
  async (req: Request<{ id: string }>, res: Response) => {
    const article = await softDeleteHelpArticle(req.params.id, req.user!.id);
    if (!article) {
      res.status(404).json({ error: "Article not found" });
      return;
    }

    await recordAuditLog({
      actor: req.user!.id,
      action: "kb_article_deleted",
      targetType: "HelpArticle",
      targetId: article.id,
      ipAddress: req.ip,
    });

    res.status(200).json({ id: article.id, deleted: true });
  }
);

router.post(
  "/ai/translate",
  requireAuth,
  validateBody(translateArticleFieldBodySchema),
  async (req: Request<unknown, unknown, z.infer<typeof translateArticleFieldBodySchema>>, res: Response) => {
    if (!(await callerHasAnyPermission(req, ["kb:article_create", "kb:article_edit"]))) {
      res.status(403).json({ error: "You do not have permission to perform this action" });
      return;
    }
    const { field, from, to, text } = req.body;
    const maxLength =
      field === "title" ? ARTICLE_TITLE_MAX_LENGTH : field === "summary" ? ARTICLE_SUMMARY_MAX_LENGTH : ARTICLE_BODY_MAX_LENGTH;
    const translation = await suggestTranslation({ text, from, to, kind: field, maxLength });
    res.status(200).json({ translation });
  }
);

router.get(
  "/:id/ai/duplicates",
  requireAuth,
  requirePermission("kb:article_view_list"),
  validateParams(articleIdParamsSchema),
  async (req: Request<{ id: string }>, res: Response) => {
    const article = await HelpArticle.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
    if (!article) {
      res.status(404).json({ error: "Article not found" });
      return;
    }
    const duplicates = await findSimilarArticles({
      title: article.title,
      summary: article.summary,
      excludeId: article.id,
    });
    res.status(200).json({ duplicates });
  }
);

export default router;
