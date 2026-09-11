import { Request } from "express";
import { User } from "../models";
import { AuthUser } from "../middleware/auth";

export async function teamUserIds(user: AuthUser): Promise<string[] | null> {
  if (user.roleKey === "super_admin") return null;
  if (user.roleKey === "sales_rep") return [user.id];
  if (user.roleKey === "sales_manager") {
    const reports = await User.find({ organizationId: user.organizationId, managerId: user.id }).select("_id");
    return [user.id, ...reports.map((r) => r._id.toString())];
  }
  return null;
}

export function scopedQuery(req: Request, extra: Record<string, unknown> = {}) {
  const user = req.user!;
  const q: Record<string, unknown> = { organizationId: user.organizationId, ...extra };
  if (user.roleKey === "super_admin") {
    if (typeof req.query.storeId === "string" && req.query.storeId) q.storeId = req.query.storeId;
    return q;
  }
  if (user.storeId) q.storeId = user.storeId;
  return q;
}
