import { Router } from "express";
import { Types } from "mongoose";
import { Store, Customer, Lead, Order, Inventory, Dispatch, Product } from "../models";
import { requirePermission, orgId } from "../middleware/auth";
import { performanceForUser } from "../services/performance.service";
import { User } from "../models";

export const dashboardRouter = Router();

dashboardRouter.get("/", requirePermission("dashboard.read"), async (req, res, next) => {
  try {
    const organizationId = orgId(req);
    const oid = new Types.ObjectId(organizationId);
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const storeFilter: Record<string, unknown> = { organizationId };
    if (req.user!.roleKey !== "super_admin" && req.user!.storeId) storeFilter.storeId = req.user!.storeId;

    const [
      stores,
      customers,
      leads,
      converted,
      ordersToday,
      ordersMonth,
      monthValue,
      pendingDispatch,
      recentOrders,
      recentLeads,
    ] = await Promise.all([
      Store.countDocuments({ organizationId, isActive: true }),
      Customer.countDocuments(storeFilter),
      Lead.countDocuments(storeFilter),
      Lead.countDocuments({ ...storeFilter, status: "converted" }),
      Order.countDocuments({ ...storeFilter, createdAt: { $gte: startToday } }),
      Order.countDocuments({ ...storeFilter, createdAt: { $gte: startMonth } }),
      Order.aggregate([
        {
          $match: {
            organizationId: oid,
            createdAt: { $gte: startMonth },
            status: { $nin: ["draft", "cancelled"] },
            ...(storeFilter.storeId ? { storeId: new Types.ObjectId(String(storeFilter.storeId)) } : {}),
          },
        },
        { $group: { _id: null, v: { $sum: "$grandTotal" } } },
      ]),
      Dispatch.countDocuments({ ...storeFilter, status: { $in: ["pending", "packed", "ready"] } }),
      Order.find(storeFilter).populate("customerId", "name").sort({ createdAt: -1 }).limit(8),
      Lead.find(storeFilter).populate("ownerId", "name").sort({ createdAt: -1 }).limit(8),
    ]);

    const inventoryAgg = await Inventory.aggregate([
      { $match: { organizationId: oid, ...(storeFilter.storeId ? { storeId: new Types.ObjectId(String(storeFilter.storeId)) } : {}) } },
      {
        $group: {
          _id: null,
          physical: { $sum: "$physical" },
          reserved: { $sum: "$reserved" },
        },
      },
    ]);

    const lowStock = await Inventory.find({
      organizationId,
      ...(storeFilter.storeId ? { storeId: storeFilter.storeId } : {}),
    })
      .populate("productId", "name sku")
      .populate("storeId", "name")
      .limit(200);
    const low = lowStock.filter((r) => r.physical - r.reserved <= r.lowStockThreshold).slice(0, 8);

    const salesTrend = await Order.aggregate([
      {
        $match: {
          organizationId: oid,
          createdAt: { $gte: new Date(now.getTime() - 30 * 86400000) },
          status: { $nin: ["draft", "cancelled"] },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          value: { $sum: "$grandTotal" },
          orders: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const storePerf = await Order.aggregate([
      {
        $match: {
          organizationId: oid,
          createdAt: { $gte: startMonth },
          status: { $nin: ["draft", "cancelled"] },
        },
      },
      { $group: { _id: "$storeId", value: { $sum: "$grandTotal" }, orders: { $sum: 1 } } },
      { $sort: { value: -1 } },
    ]);

    const reps = await User.find({ organizationId, roleKey: "sales_rep" }).select("name").limit(10);
    const topReps = [];
    for (const r of reps) {
      topReps.push({
        user: r,
        ...(await performanceForUser({ organizationId, userId: r._id.toString(), from: startMonth, to: now })),
      });
    }
    topReps.sort((a, b) => b.totalOrderValue - a.totalOrderValue);

    const funnel = await Lead.aggregate([
      { $match: { organizationId: oid } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    res.json({
      kpis: {
        stores,
        customers,
        leads,
        conversionRate: leads ? Math.round((converted / leads) * 1000) / 10 : 0,
        ordersToday,
        ordersMonth,
        monthValue: monthValue[0]?.v || 0,
        inventoryQty: (inventoryAgg[0]?.physical || 0) - (inventoryAgg[0]?.reserved || 0),
        pendingDispatch,
      },
      lowStock: low,
      recentOrders,
      recentLeads,
      salesTrend,
      storePerf,
      topReps: topReps.slice(0, 5),
      funnel,
    });
  } catch (e) {
    next(e);
  }
});

void Product;
