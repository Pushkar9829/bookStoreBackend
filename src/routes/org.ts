import { Router } from "express";
import { z } from "zod";
import { Organization, Store, User, Role, SalesTeam } from "../models";
import { requirePermission } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { orgId } from "../middleware/auth";
import { parsePagination, paged, sortObject } from "../utils/pagination";
import { NotFoundError, AppError } from "../utils/errors";
import { hashPassword } from "../services/auth.service";
import { writeAudit } from "../services/audit";
import { ROLE_KEYS, ALL_PERMISSIONS } from "../utils/permissions";

export const orgRouter = Router();

orgRouter.get("/organization", requirePermission("org.read"), async (req, res, next) => {
  try {
    const org = await Organization.findById(orgId(req));
    if (!org) throw new NotFoundError("Organization");
    res.json(org);
  } catch (e) {
    next(e);
  }
});

orgRouter.put("/organization", requirePermission("org.update"), async (req, res, next) => {
  try {
    const org = await Organization.findByIdAndUpdate(orgId(req), req.body, { new: true });
    await writeAudit({
      user: req.user,
      organizationId: orgId(req),
      action: "org.update",
      entity: "Organization",
      entityId: orgId(req),
      next: req.body,
      req,
    });
    res.json(org);
  } catch (e) {
    next(e);
  }
});

const storeSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  email: z.string().optional(),
  phone: z.string().optional(),
  address: z.record(z.any()).optional(),
  isActive: z.boolean().optional(),
});

orgRouter.get("/stores", requirePermission("stores.read"), async (req, res, next) => {
  try {
    const { page, pageSize, skip, search, sort } = parsePagination(req);
    const q: Record<string, unknown> = { organizationId: orgId(req) };
    if (search) q.$or = [{ name: new RegExp(search, "i") }, { code: new RegExp(search, "i") }];
    const [data, total] = await Promise.all([
      Store.find(q).sort(sortObject(sort)).skip(skip).limit(pageSize),
      Store.countDocuments(q),
    ]);
    res.json(paged(data, total, page, pageSize));
  } catch (e) {
    next(e);
  }
});

orgRouter.post("/stores", requirePermission("stores.manage"), validate(storeSchema), async (req, res, next) => {
  try {
    const store = await Store.create({ ...req.body, organizationId: orgId(req) });
    await writeAudit({
      user: req.user,
      organizationId: orgId(req),
      action: "store.create",
      entity: "Store",
      entityId: store._id.toString(),
      next: store.toObject(),
      req,
    });
    res.status(201).json(store);
  } catch (e) {
    next(e);
  }
});

orgRouter.get("/stores/:id", requirePermission("stores.read"), async (req, res, next) => {
  try {
    const store = await Store.findOne({ _id: req.params.id, organizationId: orgId(req) });
    if (!store) throw new NotFoundError("Store");
    res.json(store);
  } catch (e) {
    next(e);
  }
});

orgRouter.put("/stores/:id", requirePermission("stores.manage"), async (req, res, next) => {
  try {
    const store = await Store.findOneAndUpdate(
      { _id: req.params.id, organizationId: orgId(req) },
      req.body,
      { new: true }
    );
    if (!store) throw new NotFoundError("Store");
    await writeAudit({
      user: req.user,
      organizationId: orgId(req),
      action: "store.update",
      entity: "Store",
      entityId: store._id.toString(),
      next: req.body,
      req,
    });
    res.json(store);
  } catch (e) {
    next(e);
  }
});

orgRouter.delete("/stores/:id", requirePermission("stores.manage"), async (req, res, next) => {
  try {
    const store = await Store.findOneAndUpdate(
      { _id: req.params.id, organizationId: orgId(req) },
      { isActive: false },
      { new: true }
    );
    if (!store) throw new NotFoundError("Store");
    await writeAudit({
      user: req.user,
      organizationId: orgId(req),
      action: "store.deactivate",
      entity: "Store",
      entityId: store._id.toString(),
      req,
    });
    res.json(store);
  } catch (e) {
    next(e);
  }
});

const userSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6).optional(),
  name: z.string().min(1),
  phone: z.string().optional(),
  storeId: z.string().optional().nullable(),
  roleId: z.string().min(1),
  managerId: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
});

orgRouter.get("/users", requirePermission("users.read"), async (req, res, next) => {
  try {
    const { page, pageSize, skip, search, sort } = parsePagination(req);
    const q: Record<string, unknown> = { organizationId: orgId(req), roleKey: { $ne: ROLE_KEYS.CUSTOMER } };
    if (search) q.$or = [{ name: new RegExp(search, "i") }, { email: new RegExp(search, "i") }];
    if (typeof req.query.storeId === "string" && req.query.storeId) q.storeId = req.query.storeId;
    if (typeof req.query.roleKey === "string" && req.query.roleKey) q.roleKey = req.query.roleKey;
    const [data, total] = await Promise.all([
      User.find(q)
        .select("-passwordHash")
        .populate("roleId", "name key")
        .populate("storeId", "name code")
        .populate("managerId", "name email")
        .sort(sortObject(sort))
        .skip(skip)
        .limit(pageSize),
      User.countDocuments(q),
    ]);
    res.json(paged(data, total, page, pageSize));
  } catch (e) {
    next(e);
  }
});

orgRouter.post("/users", requirePermission("users.manage"), validate(userSchema), async (req, res, next) => {
  try {
    const role = await Role.findOne({ _id: req.body.roleId, organizationId: orgId(req) });
    if (!role) throw new NotFoundError("Role");
    if (role.key === ROLE_KEYS.CUSTOMER) throw new AppError("Use customer portal invite for customers");
    const passwordHash = await hashPassword(req.body.password || "Welcome@123");
    const user = await User.create({
      organizationId: orgId(req),
      email: req.body.email.toLowerCase(),
      name: req.body.name,
      phone: req.body.phone || "",
      storeId: req.body.storeId || undefined,
      roleId: role._id,
      roleKey: role.key,
      managerId: req.body.managerId || undefined,
      passwordHash,
      isActive: req.body.isActive ?? true,
    });
    await writeAudit({
      user: req.user,
      organizationId: orgId(req),
      action: "user.create",
      entity: "User",
      entityId: user._id.toString(),
      next: { email: user.email, roleKey: user.roleKey },
      req,
    });
    res.status(201).json(await User.findById(user._id).select("-passwordHash"));
  } catch (e) {
    next(e);
  }
});

orgRouter.put("/users/:id", requirePermission("users.manage"), async (req, res, next) => {
  try {
    const updates: Record<string, unknown> = { ...req.body };
    delete updates.passwordHash;
    delete updates.email;
    if (req.body.password) {
      updates.passwordHash = await hashPassword(req.body.password);
      delete updates.password;
    }
    if (req.body.roleId) {
      const role = await Role.findById(req.body.roleId);
      if (role) updates.roleKey = role.key;
    }
    const user = await User.findOneAndUpdate(
      { _id: req.params.id, organizationId: orgId(req) },
      updates,
      { new: true }
    ).select("-passwordHash");
    if (!user) throw new NotFoundError("User");
    await writeAudit({
      user: req.user,
      organizationId: orgId(req),
      action: "user.update",
      entity: "User",
      entityId: user._id.toString(),
      next: updates,
      req,
    });
    res.json(user);
  } catch (e) {
    next(e);
  }
});

orgRouter.delete("/users/:id", requirePermission("users.manage"), async (req, res, next) => {
  try {
    if (req.params.id === req.user!.id) throw new AppError("Cannot deactivate your own account");
    const user = await User.findOneAndUpdate(
      { _id: req.params.id, organizationId: orgId(req) },
      { isActive: false },
      { new: true }
    ).select("-passwordHash");
    if (!user) throw new NotFoundError("User");
    await writeAudit({
      user: req.user,
      organizationId: orgId(req),
      action: "user.deactivate",
      entity: "User",
      entityId: user._id.toString(),
      req,
    });
    res.json(user);
  } catch (e) {
    next(e);
  }
});

orgRouter.get("/roles", requirePermission("users.read"), async (req, res, next) => {
  try {
    const roles = await Role.find({ organizationId: orgId(req) }).sort({ name: 1 });
    res.json({ data: roles, permissions: ALL_PERMISSIONS });
  } catch (e) {
    next(e);
  }
});

orgRouter.put("/roles/:id", requirePermission("roles.manage"), async (req, res, next) => {
  try {
    const role = await Role.findOneAndUpdate(
      { _id: req.params.id, organizationId: orgId(req) },
      { permissions: req.body.permissions, name: req.body.name },
      { new: true }
    );
    if (!role) throw new NotFoundError("Role");
    await writeAudit({
      user: req.user,
      organizationId: orgId(req),
      action: "role.update",
      entity: "Role",
      entityId: role._id.toString(),
      next: req.body,
      req,
    });
    res.json(role);
  } catch (e) {
    next(e);
  }
});

orgRouter.get("/sales-teams", requirePermission("sales.teams"), async (req, res, next) => {
  try {
    const q: Record<string, unknown> = { organizationId: orgId(req) };
    if (typeof req.query.storeId === "string") q.storeId = req.query.storeId;
    const data = await SalesTeam.find(q)
      .populate("headId", "name email")
      .populate("memberIds", "name email roleKey")
      .populate("storeId", "name code");
    res.json({ data });
  } catch (e) {
    next(e);
  }
});

orgRouter.post("/sales-teams", requirePermission("sales.teams"), async (req, res, next) => {
  try {
    const team = await SalesTeam.create({ ...req.body, organizationId: orgId(req) });
    res.status(201).json(team);
  } catch (e) {
    next(e);
  }
});

orgRouter.put("/sales-teams/:id", requirePermission("sales.teams"), async (req, res, next) => {
  try {
    const team = await SalesTeam.findOneAndUpdate(
      { _id: req.params.id, organizationId: orgId(req) },
      req.body,
      { new: true }
    );
    if (!team) throw new NotFoundError("Sales team");
    res.json(team);
  } catch (e) {
    next(e);
  }
});

orgRouter.delete("/sales-teams/:id", requirePermission("sales.teams"), async (req, res, next) => {
  try {
    const team = await SalesTeam.findOneAndDelete({ _id: req.params.id, organizationId: orgId(req) });
    if (!team) throw new NotFoundError("Sales team");
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
