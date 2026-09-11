import { Request, Response, NextFunction } from "express";
import { AppError } from "../utils/errors";

export function notFound(_req: Request, _res: Response, next: NextFunction) {
  next(new AppError("Not found", 404, "NOT_FOUND"));
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  const e = err as AppError & { code?: number | string; name?: string };
  if (e?.name === "MongoServerError" && Number(e.code) === 11000) {
    return res.status(409).json({ error: "DUPLICATE", message: "Duplicate record" });
  }
  const status = e.statusCode ?? 500;
  const message = e.message || "Internal server error";
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: e.code || "ERROR",
    message,
  });
}
