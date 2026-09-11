import { Router } from "express";
import { Order, Product, Customer } from "../models";
import { requirePermission, orgId } from "../middleware/auth";
import { upload } from "../middleware/upload";
import { parsePagination, paged, sortObject } from "../utils/pagination";
import { AppError, NotFoundError } from "../utils/errors";
import { parseSpreadsheet } from "../utils/spreadsheet";
import { teamUserIds } from "../utils/scope";
import {
  createOrderFromLines,
  confirmOrder,
  changeOrderStatus,
  reallocate,
} from "../services/order.service";
import { ORDER_STATUSES } from "../models/order";

export const orderRouter = Router();

async function orderQuery(req: Parameters<typeof orgId>[0]) {
  const q: Record<string, unknown> = { organizationId: orgId(req) };
  if (typeof req.query.storeId === "string" && req.query.storeId) q.storeId = req.query.storeId;
  else if (req.user!.roleKey !== "super_admin" && req.user!.storeId) q.storeId = req.user!.storeId;
  const ids = await teamUserIds(req.user!);
  if (ids) q.salesUserId = { $in: ids };
  if (typeof req.query.status === "string") q.status = req.query.status;
  if (typeof req.query.customerId === "string") q.customerId = req.query.customerId;
  if (typeof req.query.source === "string") q.source = req.query.source;
  if (req.query.from || req.query.to) {
    const createdAt: Record<string, Date> = {};
    if (typeof req.query.from === "string") createdAt.$gte = new Date(req.query.from);
    if (typeof req.query.to === "string") createdAt.$lte = new Date(req.query.to);
    q.createdAt = createdAt;
  }
  return q;
}

orderRouter.get("/", requirePermission("orders.read"), async (req, res, next) => {
  try {
    const { page, pageSize, skip, search, sort } = parsePagination(req);
    const q = await orderQuery(req);
    if (search) {
      const re = new RegExp(search, "i");
      const customers = await Customer.find({ organizationId: orgId(req), $or: [{ name: re }, { company: re }] }).select("_id");
      const or: Record<string, unknown>[] = [{ customerId: { $in: customers.map((c) => c._id) } }, { notes: re }];
      if (/^[a-f0-9]{24}$/i.test(search)) or.push({ _id: search });
      q.$or = or;
    }
    const [data, total] = await Promise.all([
      Order.find(q)
        .populate("customerId", "name company phone")
        .populate("storeId", "name code")
        .populate("salesUserId", "name")
        .sort(sortObject(sort))
        .skip(skip)
        .limit(pageSize),
      Order.countDocuments(q),
    ]);
    res.json(paged(data, total, page, pageSize));
  } catch (e) {
    next(e);
  }
});

orderRouter.get("/:id", requirePermission("orders.read"), async (req, res, next) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, organizationId: orgId(req) })
      .populate("customerId")
      .populate("storeId")
      .populate("salesUserId", "name email")
      .populate("allocations.storeId", "name code");
    if (!order) throw new NotFoundError("Order");
    res.json(order);
  } catch (e) {
    next(e);
  }
});

orderRouter.post("/", requirePermission("orders.manage"), async (req, res, next) => {
  try {
    const order = await createOrderFromLines({
      organizationId: orgId(req),
      customerId: req.body.customerId,
      salesUserId: req.body.salesUserId || req.user!.id,
      leadId: req.body.leadId,
      storeId: req.body.storeId || req.user!.storeId,
      items: req.body.items,
      source: "sales_team",
      createdBy: req.user!.id,
      notes: req.body.notes,
      shippingAddress: req.body.shippingAddress,
      billingAddress: req.body.billingAddress,
      status: req.body.status || "submitted",
    });
    res.status(201).json(order);
  } catch (e) {
    next(e);
  }
});

orderRouter.post("/bulk", requirePermission("orders.manage"), upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) throw new AppError("File required");
    const customerId = req.body.customerId as string;
    if (!customerId) throw new AppError("customerId required");
    const rows = parseSpreadsheet(req.file.path);
    const items: { productId: string; qty: number }[] = [];
    const errors: { row: number; message: string }[] = [];
    let i = 0;
    for (const row of rows) {
      i += 1;
      const sku = (row.sku || row.product_sku || "").toUpperCase();
      const qty = Number(row.qty || row.quantity || 0);
      if (!sku || !qty) {
        errors.push({ row: i, message: "sku and quantity required" });
        continue;
      }
      const product = await Product.findOne({ organizationId: orgId(req), sku });
      if (!product) {
        errors.push({ row: i, message: `Unknown SKU ${sku}` });
        continue;
      }
      items.push({ productId: product._id.toString(), qty });
    }
    if (!items.length) throw new AppError("No valid rows");
    const order = await createOrderFromLines({
      organizationId: orgId(req),
      customerId,
      salesUserId: req.user!.id,
      storeId: req.body.storeId || req.user!.storeId,
      items,
      source: "sales_team",
      createdBy: req.user!.id,
      notes: errors.length ? `Bulk import with ${errors.length} skipped rows` : "Bulk import",
    });
    res.status(201).json({ order, errors });
  } catch (e) {
    next(e);
  }
});

orderRouter.post("/:id/confirm", requirePermission("orders.confirm"), async (req, res, next) => {
  try {
    const order = await confirmOrder({
      organizationId: orgId(req),
      orderId: req.params.id,
      user: req.user,
      req,
      remarks: req.body.remarks,
      storeId: req.body.storeId,
    });
    res.json(order);
  } catch (e) {
    next(e);
  }
});

orderRouter.post("/:id/status", requirePermission("orders.manage"), async (req, res, next) => {
  try {
    if (!ORDER_STATUSES.includes(req.body.status)) throw new AppError("Invalid status");
    if (req.body.status === "cancelled" && !req.user!.permissions.includes("orders.cancel") && req.user!.roleKey !== "super_admin") {
      throw new AppError("Missing cancel permission", 403);
    }
    const order = await changeOrderStatus({
      organizationId: orgId(req),
      orderId: req.params.id,
      status: req.body.status,
      remarks: req.body.remarks,
      user: req.user,
      req,
    });
    res.json(order);
  } catch (e) {
    next(e);
  }
});

orderRouter.post("/:id/allocate", requirePermission("orders.confirm"), async (req, res, next) => {
  try {
    const order = await reallocate({
      organizationId: orgId(req),
      orderId: req.params.id,
      allocations: req.body.allocations,
      user: req.user,
      req,
    });
    res.json(order);
  } catch (e) {
    next(e);
  }
});

void parsePagination;
void paged;
