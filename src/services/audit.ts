import { Request } from "express";
import { AuditLog, Notification } from "../models";
import { AuthUser } from "../middleware/auth";

export async function writeAudit(opts: {
  user?: AuthUser;
  organizationId: string;
  action: string;
  entity: string;
  entityId?: string;
  previous?: unknown;
  next?: unknown;
  req?: Request;
}) {
  await AuditLog.create({
    organizationId: opts.organizationId,
    userId: opts.user?.id,
    action: opts.action,
    entity: opts.entity,
    entityId: opts.entityId,
    previous: opts.previous,
    next: opts.next,
    ip: opts.req?.ip || "",
    userAgent: opts.req?.headers["user-agent"] || "",
  });
}

export async function notify(opts: {
  organizationId: string;
  userId?: string;
  customerId?: string;
  type: string;
  title: string;
  body?: string;
  entityType?: string;
  entityId?: string;
}) {
  await Notification.create(opts);
}
