import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import path from "path";
import { env } from "./config/env";
import { errorHandler, notFound } from "./middleware/error";
import { auth, requireStaff } from "./middleware/auth";
import { authRouter } from "./routes/auth";
import { orgRouter } from "./routes/org";
import { catalogRouter } from "./routes/catalog";
import { inventoryRouter } from "./routes/inventory";
import { crmRouter } from "./routes/crm";
import { orderRouter } from "./routes/orders";
import { dispatchRouter } from "./routes/dispatch";
import { salesRouter } from "./routes/sales";
import { reportsRouter } from "./routes/reports";
import { dashboardRouter } from "./routes/dashboard";
import { systemRouter } from "./routes/system";
import { portalRouter } from "./routes/portal";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(
    cors({
      origin: env.clientOrigins,
      credentials: true,
    })
  );
  app.use(morgan(env.nodeEnv === "production" ? "combined" : "dev"));
  app.use(express.json({ limit: "4mb" }));
  app.use(cookieParser());
  app.use("/uploads", express.static(path.resolve(process.cwd(), env.uploadDir)));

  app.get("/api/health", (_req, res) => res.json({ ok: true, name: "Meridian API" }));
  app.use("/api/auth", authRouter);
  app.use("/api/portal", auth, portalRouter);
  app.use("/api/app", auth, requireStaff, orgRouter);
  app.use("/api/app", auth, requireStaff, catalogRouter);
  app.use("/api/app/inventory", auth, requireStaff, inventoryRouter);
  app.use("/api/app", auth, requireStaff, crmRouter);
  app.use("/api/app/orders", auth, requireStaff, orderRouter);
  app.use("/api/app/dispatches", auth, requireStaff, dispatchRouter);
  app.use("/api/app/sales", auth, requireStaff, salesRouter);
  app.use("/api/app/reports", auth, requireStaff, reportsRouter);
  app.use("/api/app/dashboard", auth, requireStaff, dashboardRouter);
  app.use("/api/app", auth, requireStaff, systemRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
