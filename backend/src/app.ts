import express, { Application, Request, Response } from "express";
import cors from "cors";
import morgan from "morgan";

import healthRoutes from "./routes/health.routes";
import authRoutes from "./routes/auth.routes";
import ticketRoutes from "./routes/ticket.routes";
import ticketCategoryRoutes from "./routes/ticketCategory.routes";
import slaTargetRoutes from "./routes/slaTarget.routes";
import conversationRoutes from "./routes/conversation.routes";
import customerRoutes from "./routes/customer.routes";
import meRoutes from "./routes/me.routes";
import adminRoutes from "./routes/admin.routes";
import kbFaqRoutes from "./routes/kbFaq.routes";
import kbHelpArticleRoutes from "./routes/kbHelpArticle.routes";
import kbPublicRoutes from "./routes/kbPublic.routes";
import feedbackRoutes from "./routes/feedback.routes";
import auditRoutes from "./routes/audit.routes";
import reportRoutes from "./routes/report.routes";
import { errorHandler } from "./middleware/errorHandler";

export function createApp(): Application {
  const app = express();

  app.use(cors({ origin: process.env.CLIENT_ORIGIN || "http://localhost:3000" }));
  app.use(express.json());
  app.use(morgan("dev"));

  app.use("/api/v1", healthRoutes);
  app.use("/api/v1/auth", authRoutes);
  app.use("/api/v1/tickets", ticketRoutes);
  app.use("/api/v1/ticket-categories", ticketCategoryRoutes);
  app.use("/api/v1/sla-targets", slaTargetRoutes);
  app.use("/api/v1/conversations", conversationRoutes);
  app.use("/api/v1/customers", customerRoutes);
  app.use("/api/v1/me", meRoutes);
  app.use("/api/v1/admin/users", adminRoutes);
  app.use("/api/v1/kb/faqs", kbFaqRoutes);
  app.use("/api/v1/kb/articles", kbHelpArticleRoutes);
  app.use("/api/v1/kb/public", kbPublicRoutes);
  app.use("/api/v1/feedback", feedbackRoutes);
  app.use("/api/v1/admin/audit-logs", auditRoutes);
  app.use("/api/v1/reports", reportRoutes);
  // TODO: mount remaining feature routers as they're implemented —
  // agent-workspace, ai-features (see USER_STORIES.md for the full feature
  // list).

  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use(errorHandler);

  return app;
}
