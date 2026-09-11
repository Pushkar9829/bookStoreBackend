import { Inventory, InventoryTransaction, StockTransfer, Product, Organization } from "../models";
import { AppError, NotFoundError } from "../utils/errors";
import { notify, writeAudit } from "./audit";
import { AuthUser } from "../middleware/auth";
import { Request } from "express";

export async function ensureInventory(organizationId: string, storeId: string, productId: string) {
  let row = await Inventory.findOne({ storeId, productId });
  if (!row) {
    const org = await Organization.findById(organizationId);
    row = await Inventory.create({
      organizationId,
      storeId,
      productId,
      lowStockThreshold: org?.settings?.lowStockThreshold ?? 20,
    });
  }
  return row;
}

function snapshot(row: { physical: number; reserved: number; damaged: number; inTransit: number }) {
  return {
    physical: row.physical,
    reserved: row.reserved,
    damaged: row.damaged,
    inTransit: row.inTransit,
    available: row.physical - row.reserved,
  };
}

async function maybeLowStock(organizationId: string, storeId: string, productId: string, row: InstanceType<typeof Inventory>) {
  const available = row.physical - row.reserved;
  if (available <= row.lowStockThreshold) {
    const product = await Product.findById(productId).select("name sku");
    await notify({
      organizationId,
      type: "low_stock",
      title: "Low stock",
      body: `${product?.sku} ${product?.name} is at ${available} units`,
      entityType: "Inventory",
      entityId: row._id.toString(),
    });
  }
}

export async function stockIn(opts: {
  organizationId: string;
  storeId: string;
  productId: string;
  qty: number;
  notes?: string;
  user?: AuthUser;
  req?: Request;
  refType?: string;
  refId?: string;
}) {
  if (opts.qty <= 0) throw new AppError("Quantity must be positive");
  const row = await ensureInventory(opts.organizationId, opts.storeId, opts.productId);
  const before = snapshot(row);
  row.physical += opts.qty;
  await row.save();
  const tx = await InventoryTransaction.create({
    organizationId: opts.organizationId,
    storeId: opts.storeId,
    productId: opts.productId,
    type: "in",
    qty: opts.qty,
    notes: opts.notes || "",
    before,
    after: snapshot(row),
    createdBy: opts.user?.id,
    refType: opts.refType,
    refId: opts.refId,
  });
  await writeAudit({
    user: opts.user,
    organizationId: opts.organizationId,
    action: "inventory.stock_in",
    entity: "Inventory",
    entityId: row._id.toString(),
    previous: before,
    next: snapshot(row),
    req: opts.req,
  });
  return { inventory: row, transaction: tx };
}

export async function stockOut(opts: {
  organizationId: string;
  storeId: string;
  productId: string;
  qty: number;
  notes?: string;
  user?: AuthUser;
  req?: Request;
  type?: "out" | "dispatch";
  refType?: string;
  refId?: string;
}) {
  if (opts.qty <= 0) throw new AppError("Quantity must be positive");
  const type = opts.type || "out";
  const row = await ensureInventory(opts.organizationId, opts.storeId, opts.productId);
  const available = row.physical - row.reserved;
  if (type === "out" && available < opts.qty) throw new AppError("Insufficient available stock");
  const before = snapshot(row);
  if (type === "dispatch") {
    if (row.reserved < opts.qty) throw new AppError("Insufficient reserved stock to dispatch");
    row.reserved -= opts.qty;
    row.physical -= opts.qty;
    row.dispatched += opts.qty;
  } else {
    row.physical -= opts.qty;
  }
  await row.save();
  const tx = await InventoryTransaction.create({
    organizationId: opts.organizationId,
    storeId: opts.storeId,
    productId: opts.productId,
    type,
    qty: opts.qty,
    notes: opts.notes || "",
    before,
    after: snapshot(row),
    createdBy: opts.user?.id,
    refType: opts.refType,
    refId: opts.refId,
  });
  await writeAudit({
    user: opts.user,
    organizationId: opts.organizationId,
    action: "inventory.stock_out",
    entity: "Inventory",
    entityId: row._id.toString(),
    previous: before,
    next: snapshot(row),
    req: opts.req,
  });
  await maybeLowStock(opts.organizationId, opts.storeId, opts.productId, row);
  return { inventory: row, transaction: tx };
}

export async function adjustStock(opts: {
  organizationId: string;
  storeId: string;
  productId: string;
  physical?: number;
  damagedDelta?: number;
  notes?: string;
  reason?: string;
  user?: AuthUser;
  req?: Request;
}) {
  const row = await ensureInventory(opts.organizationId, opts.storeId, opts.productId);
  const before = snapshot(row);
  if (typeof opts.physical === "number") {
    if (opts.physical < row.reserved) throw new AppError("Physical stock cannot be below reserved");
    row.physical = opts.physical;
  }
  if (opts.damagedDelta) {
    row.damaged += opts.damagedDelta;
    if (opts.damagedDelta > 0) {
      if (row.physical - row.reserved < opts.damagedDelta) throw new AppError("Not enough available stock to mark damaged");
      row.physical -= opts.damagedDelta;
    }
  }
  await row.save();
  const tx = await InventoryTransaction.create({
    organizationId: opts.organizationId,
    storeId: opts.storeId,
    productId: opts.productId,
    type: opts.damagedDelta && opts.damagedDelta > 0 ? "damage" : "adjust",
    qty: opts.physical ?? opts.damagedDelta ?? 0,
    notes: opts.notes || opts.reason || "",
    before,
    after: snapshot(row),
    createdBy: opts.user?.id,
  });
  await writeAudit({
    user: opts.user,
    organizationId: opts.organizationId,
    action: "inventory.adjust",
    entity: "Inventory",
    entityId: row._id.toString(),
    previous: before,
    next: snapshot(row),
    req: opts.req,
  });
  return { inventory: row, transaction: tx };
}

/** Atomic reserve: available = physical - reserved must be >= qty */
export async function reserveStock(opts: {
  organizationId: string;
  storeId: string;
  productId: string;
  qty: number;
  refId?: string;
  user?: AuthUser;
}) {
  const filter = {
    organizationId: opts.organizationId,
    storeId: opts.storeId,
    productId: opts.productId,
    $expr: { $gte: [{ $subtract: ["$physical", "$reserved"] }, opts.qty] },
  };
  let updated = await Inventory.findOneAndUpdate(filter, { $inc: { reserved: opts.qty } }, { new: true });
  if (!updated) {
    await ensureInventory(opts.organizationId, opts.storeId, opts.productId);
    updated = await Inventory.findOneAndUpdate(filter, { $inc: { reserved: opts.qty } }, { new: true });
  }
  if (!updated) {
    throw new AppError("Insufficient stock to reserve (possible concurrent order)", 409, "OVERSELL");
  }
  await InventoryTransaction.create({
    organizationId: opts.organizationId,
    storeId: opts.storeId,
    productId: opts.productId,
    type: "reserve",
    qty: opts.qty,
    refType: "Order",
    refId: opts.refId,
    after: snapshot(updated),
    createdBy: opts.user?.id,
  });
  await maybeLowStock(opts.organizationId, opts.storeId, opts.productId, updated);
  return updated;
}

export async function releaseStock(opts: {
  organizationId: string;
  storeId: string;
  productId: string;
  qty: number;
  refId?: string;
  user?: AuthUser;
}) {
  const updated = await Inventory.findOneAndUpdate(
    {
      organizationId: opts.organizationId,
      storeId: opts.storeId,
      productId: opts.productId,
      reserved: { $gte: opts.qty },
    },
    { $inc: { reserved: -opts.qty } },
    { new: true }
  );
  if (!updated) throw new AppError("Cannot release reserved stock");
  await InventoryTransaction.create({
    organizationId: opts.organizationId,
    storeId: opts.storeId,
    productId: opts.productId,
    type: "release",
    qty: opts.qty,
    refType: "Order",
    refId: opts.refId,
    after: snapshot(updated),
    createdBy: opts.user?.id,
  });
  return updated;
}

export async function createTransfer(opts: {
  organizationId: string;
  fromStoreId: string;
  toStoreId: string;
  items: { productId: string; qty: number }[];
  notes?: string;
  user?: AuthUser;
  req?: Request;
}) {
  if (opts.fromStoreId === opts.toStoreId) throw new AppError("Cannot transfer to the same store");
  for (const item of opts.items) {
    const row = await ensureInventory(opts.organizationId, opts.fromStoreId, item.productId);
    if (row.physical - row.reserved < item.qty) throw new AppError("Insufficient stock for transfer");
  }
  const transfer = await StockTransfer.create({
    organizationId: opts.organizationId,
    fromStoreId: opts.fromStoreId,
    toStoreId: opts.toStoreId,
    items: opts.items,
    status: "in_transit",
    notes: opts.notes || "",
    createdBy: opts.user?.id,
  });
  for (const item of opts.items) {
    const from = await ensureInventory(opts.organizationId, opts.fromStoreId, item.productId);
    const before = snapshot(from);
    from.physical -= item.qty;
    from.inTransit += item.qty;
    await from.save();
    const to = await ensureInventory(opts.organizationId, opts.toStoreId, item.productId);
    to.inTransit += item.qty;
    await to.save();
    await InventoryTransaction.create({
      organizationId: opts.organizationId,
      storeId: opts.fromStoreId,
      productId: item.productId,
      type: "transfer_out",
      qty: item.qty,
      refType: "StockTransfer",
      refId: transfer._id,
      before,
      after: snapshot(from),
      createdBy: opts.user?.id,
    });
  }
  await writeAudit({
    user: opts.user,
    organizationId: opts.organizationId,
    action: "inventory.transfer",
    entity: "StockTransfer",
    entityId: transfer._id.toString(),
    next: transfer.toObject(),
    req: opts.req,
  });
  return transfer;
}

export async function receiveTransfer(opts: {
  organizationId: string;
  transferId: string;
  user?: AuthUser;
  req?: Request;
}) {
  const transfer = await StockTransfer.findOne({ _id: opts.transferId, organizationId: opts.organizationId });
  if (!transfer) throw new NotFoundError("Transfer");
  if (transfer.status !== "in_transit" && transfer.status !== "pending") {
    throw new AppError("Transfer already completed");
  }
  for (const item of transfer.items) {
    const from = await ensureInventory(opts.organizationId, transfer.fromStoreId.toString(), item.productId.toString());
    from.inTransit = Math.max(0, from.inTransit - item.qty);
    await from.save();
    const to = await ensureInventory(opts.organizationId, transfer.toStoreId.toString(), item.productId.toString());
    const before = snapshot(to);
    to.inTransit = Math.max(0, to.inTransit - item.qty);
    to.physical += item.qty;
    await to.save();
    await InventoryTransaction.create({
      organizationId: opts.organizationId,
      storeId: transfer.toStoreId,
      productId: item.productId,
      type: "transfer_in",
      qty: item.qty,
      refType: "StockTransfer",
      refId: transfer._id,
      before,
      after: snapshot(to),
      createdBy: opts.user?.id,
    });
  }
  transfer.status = "received";
  transfer.receivedBy = opts.user?.id as never;
  transfer.receivedAt = new Date();
  await transfer.save();
  return transfer;
}
