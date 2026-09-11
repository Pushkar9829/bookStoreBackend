import { Router } from "express";
import { Notification, AuditLog } from "../models";
import { requirePermission, orgId } from "../middleware/auth";
import { parsePagination, paged, sortObject } from "../utils/pagination";

export const systemRouter = Router();

systemRouter.get("/notifications", requirePermission("notifications.read"), async (req, res, next) => {
  try {
    const { page, pageSize, skip, search } = parsePagination(req);
    const q: Record<string, unknown> = { organizationId: orgId(req) };
    if (req.user!.roleKey !== "super_admin") {
      q.$or = [{ userId: req.user!.id }, { userId: { $exists: false } }, { userId: null }];
    }
    if (req.query.unread === "true") q.read = false;
    if (search) {
      const re = new RegExp(search, "i");
      const text = { $or: [{ title: re }, { body: re }, { type: re }] };
      if (q.$or) {
        q.$and = [{ $or: q.$or as unknown[] }, text];
        delete q.$or;
      } else {
        Object.assign(q, text);
      }
    }
    const [data, total] = await Promise.all([
      Notification.find(q).sort({ createdAt: -1 }).skip(skip).limit(pageSize),
      Notification.countDocuments(q),
    ]);
    res.json(paged(data, total, page, pageSize));
  } catch (e) {
    next(e);
  }
});

systemRouter.post("/notifications/:id/read", requirePermission("notifications.read"), async (req, res, next) => {
  try {
    const n = await Notification.findByIdAndUpdate(req.params.id, { read: true }, { new: true });
    res.json(n);
  } catch (e) {
    next(e);
  }
});

systemRouter.post("/notifications/read-all", requirePermission("notifications.read"), async (req, res, next) => {
  try {
    await Notification.updateMany({ organizationId: orgId(req), userId: req.user!.id }, { read: true });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

systemRouter.get("/audit", requirePermission("audit.read"), async (req, res, next) => {
  try {
    const { page, pageSize, skip, search, sort } = parsePagination(req);
    const q: Record<string, unknown> = { organizationId: orgId(req) };
    if (typeof req.query.entity === "string") q.entity = req.query.entity;
    if (typeof req.query.action === "string") q.action = req.query.action;
    if (typeof req.query.userId === "string") q.userId = req.query.userId;
    if (search) {
      const re = new RegExp(search, "i");
      q.$or = [{ action: re }, { entity: re }, { entityId: re }];
    }
    const [data, total] = await Promise.all([
      AuditLog.find(q).populate("userId", "name email").sort(sortObject(sort)).skip(skip).limit(pageSize),
      AuditLog.countDocuments(q),
    ]);
    res.json(paged(data, total, page, pageSize));
  } catch (e) {
    next(e);
  }
});
