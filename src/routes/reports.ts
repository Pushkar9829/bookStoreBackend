import { Router } from "express";
import { Types } from "mongoose";
import { Order, Lead, Inventory, InventoryTransaction, StockTransfer, Dispatch, Store, User } from "../models";
import { requirePermission, orgId } from "../middleware/auth";
import { performanceForUser } from "../services/performance.service";

export const reportsRouter = Router();

function orgOid(req: Parameters<typeof orgId>[0]) {
  return new Types.ObjectId(orgId(req));
}

function dateMatch(req: { query: Record<string, unknown> }) {
  const createdAt: Record<string, Date> = {};
  if (typeof req.query.from === "string") createdAt.$gte = new Date(req.query.from);
  if (typeof req.query.to === "string") createdAt.$lte = new Date(req.query.to);
  return Object.keys(createdAt).length ? { createdAt } : {};
}

reportsRouter.get("/sales", requirePermission("reports.read"), async (req, res, next) => {
  try {
    const match: Record<string, unknown> = {
      organizationId: orgOid(req),
      status: { $nin: ["draft", "cancelled"] },
      ...dateMatch(req),
    };
    if (typeof req.query.storeId === "string") match.storeId = new Types.ObjectId(req.query.storeId);
    if (typeof req.query.salesUserId === "string") match.salesUserId = new Types.ObjectId(req.query.salesUserId);
    if (typeof req.query.customerId === "string") match.customerId = new Types.ObjectId(req.query.customerId);
    const groupBy = (req.query.groupBy as string) || "store";
    const groupField =
      groupBy === "employee"
        ? "$salesUserId"
        : groupBy === "customer"
          ? "$customerId"
          : groupBy === "date"
            ? { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }
            : "$storeId";
    const data = await Order.aggregate([
      { $match: match },
      { $group: { _id: groupField, orders: { $sum: 1 }, value: { $sum: "$grandTotal" }, qty: { $sum: "$totalQty" } } },
      { $sort: { value: -1 } },
    ]);
    res.json({ data, groupBy });
  } catch (e) {
    next(e);
  }
});

reportsRouter.get("/sales/by-product", requirePermission("reports.read"), async (req, res, next) => {
  try {
    const match: Record<string, unknown> = {
      organizationId: orgOid(req),
      status: { $nin: ["draft", "cancelled"] },
      ...dateMatch(req),
    };
    const data = await Order.aggregate([
      { $match: match },
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.productId",
          sku: { $first: "$items.sku" },
          name: { $first: "$items.name" },
          qty: { $sum: "$items.qty" },
          value: { $sum: "$items.lineTotal" },
        },
      },
      { $sort: { value: -1 } },
      { $limit: 50 },
    ]);
    res.json({ data });
  } catch (e) {
    next(e);
  }
});

reportsRouter.get("/leads", requirePermission("reports.read"), async (req, res, next) => {
  try {
    const match: Record<string, unknown> = { organizationId: orgOid(req), ...dateMatch(req) };
    const bySource = await Lead.aggregate([
      { $match: match },
      { $group: { _id: "$source", count: { $sum: 1 }, converted: { $sum: { $cond: [{ $eq: ["$status", "converted"] }, 1, 0] } } } },
    ]);
    const byStatus = await Lead.aggregate([{ $match: match }, { $group: { _id: "$status", count: { $sum: 1 } } }]);
    const byOwner = await Lead.aggregate([
      { $match: match },
      { $group: { _id: "$ownerId", count: { $sum: 1 }, converted: { $sum: { $cond: [{ $eq: ["$status", "converted"] }, 1, 0] } } } },
    ]);
    res.json({ bySource, byStatus, byOwner });
  } catch (e) {
    next(e);
  }
});

reportsRouter.get("/inventory", requirePermission("reports.read"), async (req, res, next) => {
  try {
    const match: Record<string, unknown> = { organizationId: orgOid(req) };
    if (typeof req.query.storeId === "string") match.storeId = new Types.ObjectId(req.query.storeId);
    const stock = await Inventory.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$storeId",
          physical: { $sum: "$physical" },
          reserved: { $sum: "$reserved" },
          damaged: { $sum: "$damaged" },
          inTransit: { $sum: "$inTransit" },
        },
      },
    ]);
    const movement = await InventoryTransaction.aggregate([
      { $match: { ...match, ...dateMatch(req) } },
      { $group: { _id: "$type", qty: { $sum: "$qty" }, count: { $sum: 1 } } },
    ]);
    const transfers = await StockTransfer.find({ organizationId: orgId(req) }).sort({ createdAt: -1 }).limit(20);
    res.json({ stock, movement, transfers });
  } catch (e) {
    next(e);
  }
});

reportsRouter.get("/orders", requirePermission("reports.read"), async (req, res, next) => {
  try {
    const match: Record<string, unknown> = { organizationId: orgOid(req), ...dateMatch(req) };
    const byStatus = await Order.aggregate([{ $match: match }, { $group: { _id: "$status", count: { $sum: 1 }, value: { $sum: "$grandTotal" } } }]);
    const bulk = await Order.countDocuments({ ...match, "items.2": { $exists: true } });
    res.json({ byStatus, bulk });
  } catch (e) {
    next(e);
  }
});

reportsRouter.get("/performance", requirePermission("reports.read"), async (req, res, next) => {
  try {
    const now = new Date();
    const from = typeof req.query.from === "string" ? new Date(req.query.from) : new Date(now.getFullYear(), now.getMonth(), 1);
    const to = typeof req.query.to === "string" ? new Date(req.query.to) : now;
    const users = await User.find({
      organizationId: orgId(req),
      roleKey: { $in: ["sales_rep", "sales_manager"] },
    }).select("name storeId");
    const ranking = [];
    for (const u of users) {
      ranking.push({
        user: u,
        ...(await performanceForUser({ organizationId: orgId(req), userId: u._id.toString(), from, to })),
      });
    }
    ranking.sort((a, b) => b.totalOrderValue - a.totalOrderValue);
    const stores = await Store.find({ organizationId: orgId(req) });
    const storeRank = [];
    for (const s of stores) {
      const [agg] = await Order.aggregate([
        {
          $match: {
            organizationId: orgOid(req),
            storeId: s._id,
            createdAt: { $gte: from, $lte: to },
            status: { $nin: ["draft", "cancelled"] },
          },
        },
        { $group: { _id: null, value: { $sum: "$grandTotal" }, orders: { $sum: 1 } } },
      ]);
      storeRank.push({ store: s, value: agg?.value || 0, orders: agg?.orders || 0 });
    }
    storeRank.sort((a, b) => b.value - a.value);
    res.json({ ranking, storeRank, from, to });
  } catch (e) {
    next(e);
  }
});

void Dispatch;
