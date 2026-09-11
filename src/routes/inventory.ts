import { Router } from "express";
import { Inventory, InventoryTransaction, StockTransfer, Product, Store } from "../models";
import { requirePermission, orgId } from "../middleware/auth";
import { parsePagination, paged, sortObject } from "../utils/pagination";
import { stockIn, stockOut, adjustStock, createTransfer, receiveTransfer } from "../services/inventory.service";
import { toPaise } from "../utils/money";

export const inventoryRouter = Router();

inventoryRouter.get("/", requirePermission("inventory.read"), async (req, res, next) => {
  try {
    const { page, pageSize, skip, search } = parsePagination(req);
    const q: Record<string, unknown> = { organizationId: orgId(req) };
    if (typeof req.query.storeId === "string" && req.query.storeId) q.storeId = req.query.storeId;
    else if (req.user!.roleKey !== "super_admin" && req.user!.storeId) q.storeId = req.user!.storeId;
    if (typeof req.query.productId === "string") q.productId = req.query.productId;
    if (search) {
      const products = await Product.find({
        organizationId: orgId(req),
        $or: [{ name: new RegExp(search, "i") }, { sku: new RegExp(search, "i") }],
      }).select("_id");
      q.productId = { $in: products.map((p) => p._id) };
    }
    const [rows, total] = await Promise.all([
      Inventory.find(q).populate("productId").populate("storeId", "name code").skip(skip).limit(pageSize),
      Inventory.countDocuments(q),
    ]);
    const data = rows.map((r) => {
      const o = r.toObject({ virtuals: true }) as Record<string, unknown>;
      o.available = r.physical - r.reserved;
      return o;
    });
    res.json(paged(data, total, page, pageSize));
  } catch (e) {
    next(e);
  }
});

inventoryRouter.get("/central", requirePermission("inventory.read"), async (req, res, next) => {
  try {
    const agg = await Inventory.aggregate([
      { $match: { organizationId: require("mongoose").Types.ObjectId.createFromHexString(orgId(req)) } },
      {
        $group: {
          _id: "$productId",
          physical: { $sum: "$physical" },
          reserved: { $sum: "$reserved" },
          damaged: { $sum: "$damaged" },
          inTransit: { $sum: "$inTransit" },
          dispatched: { $sum: "$dispatched" },
        },
      },
      {
        $lookup: { from: "products", localField: "_id", foreignField: "_id", as: "product" },
      },
      { $unwind: "$product" },
      {
        $project: {
          productId: "$_id",
          sku: "$product.sku",
          name: "$product.name",
          defaultPrice: "$product.defaultPrice",
          physical: 1,
          reserved: 1,
          damaged: 1,
          inTransit: 1,
          dispatched: 1,
          available: { $subtract: ["$physical", "$reserved"] },
          valuePaise: { $multiply: [{ $subtract: ["$physical", "$reserved"] }, "$product.defaultPrice"] },
        },
      },
      { $sort: { name: 1 } },
    ]);
    res.json({ data: agg });
  } catch (e) {
    next(e);
  }
});

inventoryRouter.get("/low-stock", requirePermission("inventory.read"), async (req, res, next) => {
  try {
    const q: Record<string, unknown> = { organizationId: orgId(req) };
    if (typeof req.query.storeId === "string") q.storeId = req.query.storeId;
    const rows = await Inventory.find(q).populate("productId", "name sku").populate("storeId", "name code");
    const data = rows
      .filter((r) => r.physical - r.reserved <= r.lowStockThreshold)
      .map((r) => ({ ...r.toObject(), available: r.physical - r.reserved }));
    res.json({ data });
  } catch (e) {
    next(e);
  }
});

inventoryRouter.get("/transactions", requirePermission("inventory.read"), async (req, res, next) => {
  try {
    const { page, pageSize, skip, sort } = parsePagination(req);
    const q: Record<string, unknown> = { organizationId: orgId(req) };
    if (typeof req.query.storeId === "string") q.storeId = req.query.storeId;
    if (typeof req.query.productId === "string") q.productId = req.query.productId;
    if (typeof req.query.type === "string") q.type = req.query.type;
    const [data, total] = await Promise.all([
      InventoryTransaction.find(q)
        .populate("productId", "name sku")
        .populate("storeId", "name code")
        .populate("createdBy", "name")
        .sort(sortObject(sort))
        .skip(skip)
        .limit(pageSize),
      InventoryTransaction.countDocuments(q),
    ]);
    res.json(paged(data, total, page, pageSize));
  } catch (e) {
    next(e);
  }
});

inventoryRouter.post("/stock-in", requirePermission("inventory.manage"), async (req, res, next) => {
  try {
    const result = await stockIn({
      organizationId: orgId(req),
      storeId: req.body.storeId,
      productId: req.body.productId,
      qty: Number(req.body.qty),
      notes: req.body.notes,
      user: req.user,
      req,
    });
    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

inventoryRouter.post("/stock-out", requirePermission("inventory.manage"), async (req, res, next) => {
  try {
    const result = await stockOut({
      organizationId: orgId(req),
      storeId: req.body.storeId,
      productId: req.body.productId,
      qty: Number(req.body.qty),
      notes: req.body.notes,
      user: req.user,
      req,
    });
    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

inventoryRouter.post("/adjust", requirePermission("inventory.manage"), async (req, res, next) => {
  try {
    const result = await adjustStock({
      organizationId: orgId(req),
      storeId: req.body.storeId,
      productId: req.body.productId,
      physical: req.body.physical !== undefined ? Number(req.body.physical) : undefined,
      damagedDelta: req.body.damagedDelta !== undefined ? Number(req.body.damagedDelta) : undefined,
      notes: req.body.notes,
      reason: req.body.reason,
      user: req.user,
      req,
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

inventoryRouter.get("/transfers", requirePermission("inventory.read"), async (req, res, next) => {
  try {
    const { page, pageSize, skip } = parsePagination(req);
    const q = { organizationId: orgId(req) };
    const [data, total] = await Promise.all([
      StockTransfer.find(q)
        .populate("fromStoreId", "name code")
        .populate("toStoreId", "name code")
        .populate("items.productId", "name sku")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize),
      StockTransfer.countDocuments(q),
    ]);
    res.json(paged(data, total, page, pageSize));
  } catch (e) {
    next(e);
  }
});

inventoryRouter.post("/transfers", requirePermission("inventory.transfer"), async (req, res, next) => {
  try {
    const transfer = await createTransfer({
      organizationId: orgId(req),
      fromStoreId: req.body.fromStoreId,
      toStoreId: req.body.toStoreId,
      items: req.body.items,
      notes: req.body.notes,
      user: req.user,
      req,
    });
    res.status(201).json(transfer);
  } catch (e) {
    next(e);
  }
});

inventoryRouter.post("/transfers/:id/receive", requirePermission("inventory.transfer"), async (req, res, next) => {
  try {
    const transfer = await receiveTransfer({
      organizationId: orgId(req),
      transferId: req.params.id,
      user: req.user,
      req,
    });
    res.json(transfer);
  } catch (e) {
    next(e);
  }
});

void Store;
void toPaise;
