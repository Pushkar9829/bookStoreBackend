import { Order, Customer, Product, Inventory, Store, CustomerAddress } from "../models";
import { AppError, NotFoundError } from "../utils/errors";
import { resolvePrice } from "./pricing.service";
import { lineTotalPaise } from "../utils/money";
import { reserveStock, releaseStock } from "./inventory.service";
import { notify, writeAudit } from "./audit";
import { AuthUser } from "../middleware/auth";
import { Request } from "express";
import { Organization } from "../models";

const ACTIVE_STATUSES = ["confirmed", "inventory_reserved", "processing", "ready_for_dispatch", "dispatched", "in_transit"];

export function findOrderItem(order: InstanceType<typeof Order>, id: unknown) {
  const sid = String(id);
  return order.items.find((it) => String(it._id) === sid);
}

export async function buildItems(
  organizationId: string,
  customerId: string,
  lines: { productId: string; qty: number }[],
  storeId?: string
) {
  const items = [];
  let subtotal = 0;
  let taxTotal = 0;
  let totalQty = 0;
  for (const line of lines) {
    if (!line.qty || line.qty <= 0) throw new AppError("Invalid quantity");
    const priced = await resolvePrice({
      organizationId,
      customerId,
      productId: line.productId,
      storeId,
      qty: line.qty,
    });
    const net = lineTotalPaise(line.qty, priced.unitPrice);
    const tax = Math.round((net * (priced.taxPercent || 0)) / 100);
    items.push({
      productId: priced.product._id,
      sku: priced.product.sku,
      name: priced.product.name,
      qty: line.qty,
      unitPrice: priced.unitPrice,
      taxPercent: priced.taxPercent,
      lineTotal: net + tax,
      cancelledQty: 0,
      dispatchedQty: 0,
    });
    subtotal += net;
    taxTotal += tax;
    totalQty += line.qty;
  }
  return { items, subtotal, taxTotal, grandTotal: subtotal + taxTotal, totalQty };
}

export async function createOrderFromLines(opts: {
  organizationId: string;
  customerId: string;
  salesUserId?: string;
  leadId?: string;
  storeId?: string;
  items: { productId: string; qty: number }[];
  source: "sales_team" | "portal" | "lead_conversion";
  createdBy?: string;
  notes?: string;
  shippingAddress?: Record<string, unknown>;
  billingAddress?: Record<string, unknown>;
  status?: string;
}) {
  const customer = await Customer.findById(opts.customerId);
  if (!customer) throw new NotFoundError("Customer");
  const storeId = opts.storeId || customer.storeId?.toString();
  const built = await buildItems(opts.organizationId, opts.customerId, opts.items, storeId);
  let shipping = opts.shippingAddress;
  if (!shipping) {
    const addr = await CustomerAddress.findOne({ customerId: customer._id, kind: "shipping", isDefault: true })
      || await CustomerAddress.findOne({ customerId: customer._id });
    if (addr) shipping = addr.toObject();
  }
  const order = await Order.create({
    organizationId: opts.organizationId,
    storeId,
    customerId: customer._id,
    salesUserId: opts.salesUserId || customer.salesUserId,
    leadId: opts.leadId,
    source: opts.source,
    status: opts.status || "submitted",
    items: built.items,
    totalQty: built.totalQty,
    subtotal: built.subtotal,
    taxTotal: built.taxTotal,
    grandTotal: built.grandTotal,
    shippingAddress: shipping,
    billingAddress: opts.billingAddress || shipping,
    notes: opts.notes || "",
    placedAt: new Date(),
    createdBy: opts.createdBy,
    statusHistory: [{ from: "draft", to: opts.status || "submitted", changedBy: opts.createdBy, at: new Date() }],
  });
  await notify({
    organizationId: opts.organizationId,
    customerId: customer._id.toString(),
    userId: order.salesUserId?.toString(),
    type: "order_submitted",
    title: "Order submitted",
    body: `Order ${order._id} · ₹${(order.grandTotal / 100).toFixed(2)}`,
    entityType: "Order",
    entityId: order._id.toString(),
  });
  const org = await Organization.findById(opts.organizationId);
  if (org && order.grandTotal >= (org.settings?.highValueOrderPaise || 10000000)) {
    await notify({
      organizationId: opts.organizationId,
      type: "high_value_order",
      title: "High-value order",
      body: `₹${(order.grandTotal / 100).toLocaleString("en-IN")} from ${customer.name}`,
      entityType: "Order",
      entityId: order._id.toString(),
    });
  }
  return order;
}

type Alloc = { orderItemId: string; productId: string; storeId: string; qty: number; reserved: boolean };

export async function allocateOrder(organizationId: string, order: InstanceType<typeof Order>, forceStoreId?: string) {
  const customer = await Customer.findById(order.customerId);
  const preferred = forceStoreId || order.storeId?.toString() || customer?.storeId?.toString();
  const stores = await Store.find({ organizationId, isActive: true });
  const allocations: Alloc[] = [];

  for (const item of order.items) {
    const remaining = item.qty - (item.cancelledQty || 0);
    if (remaining <= 0) continue;
    let leftover = remaining;

    const tryStore = async (storeId: string, qty: number) => {
      const inv = await Inventory.findOne({ storeId, productId: item.productId });
      const available = inv ? inv.physical - inv.reserved : 0;
      const take = Math.min(qty, available);
      if (take > 0) {
        allocations.push({
          orderItemId: item._id.toString(),
          productId: item.productId.toString(),
          storeId,
          qty: take,
          reserved: false,
        });
      }
      return take;
    };

    if (preferred) leftover -= await tryStore(preferred, leftover);

    if (leftover > 0) {
      const ranked = [];
      for (const store of stores) {
        if (store._id.toString() === preferred) continue;
        const inv = await Inventory.findOne({ storeId: store._id, productId: item.productId });
        ranked.push({ storeId: store._id.toString(), available: inv ? inv.physical - inv.reserved : 0 });
      }
      ranked.sort((a, b) => b.available - a.available);
      for (const r of ranked) {
        if (leftover <= 0) break;
        leftover -= await tryStore(r.storeId, leftover);
      }
    }

    if (leftover > 0) {
      throw new AppError(
        `Insufficient stock for ${item.sku} (short ${leftover} units)`,
        409,
        "INSUFFICIENT_STOCK"
      );
    }
  }

  order.allocations = allocations as never;
  if (allocations.length) {
    const primary = allocations[0].storeId;
    order.storeId = primary as never;
  }
  await order.save();
  return allocations;
}

export async function confirmOrder(opts: {
  organizationId: string;
  orderId: string;
  user?: AuthUser;
  req?: Request;
  remarks?: string;
  storeId?: string;
}) {
  const order = await Order.findOne({ _id: opts.orderId, organizationId: opts.organizationId });
  if (!order) throw new NotFoundError("Order");
  if (!["submitted", "draft", "on_hold"].includes(order.status)) {
    throw new AppError("Order cannot be confirmed from current status");
  }

  const allocations = await allocateOrder(opts.organizationId, order, opts.storeId);
  const applied: Alloc[] = [];
  try {
    for (const a of allocations) {
      await reserveStock({
        organizationId: opts.organizationId,
        storeId: a.storeId,
        productId: a.productId,
        qty: a.qty,
        refId: order._id.toString(),
        user: opts.user,
      });
      a.reserved = true;
      applied.push(a);
    }
  } catch (err) {
    for (const a of applied) {
      await releaseStock({
        organizationId: opts.organizationId,
        storeId: a.storeId,
        productId: a.productId,
        qty: a.qty,
        refId: order._id.toString(),
        user: opts.user,
      });
    }
    throw err;
  }

  const prev = order.status;
  order.allocations = allocations as never;
  order.status = "inventory_reserved";
  order.confirmedAt = new Date();
  order.statusHistory.push({
    from: prev,
    to: "inventory_reserved",
    changedBy: opts.user?.id as never,
    remarks: opts.remarks || "Inventory reserved",
    at: new Date(),
  });
  order.statusHistory.push({
    from: "inventory_reserved",
    to: "confirmed",
    changedBy: opts.user?.id as never,
    remarks: opts.remarks || "Order confirmed",
    at: new Date(),
  });
  order.status = "confirmed";
  await order.save();

  const customer = await Customer.findById(order.customerId);
  if (customer) {
    customer.totalOrderValue += order.grandTotal;
    customer.lastOrderDate = new Date();
    await customer.save();
  }

  await notify({
    organizationId: opts.organizationId,
    customerId: order.customerId.toString(),
    userId: order.salesUserId?.toString(),
    type: "order_confirmed",
    title: "Order confirmed",
    body: `Order ${order._id}`,
    entityType: "Order",
    entityId: order._id.toString(),
  });
  await writeAudit({
    user: opts.user,
    organizationId: opts.organizationId,
    action: "order.confirm",
    entity: "Order",
    entityId: order._id.toString(),
    previous: { status: prev },
    next: { status: order.status, allocations },
    req: opts.req,
  });
  return order;
}

export async function changeOrderStatus(opts: {
  organizationId: string;
  orderId: string;
  status: string;
  remarks?: string;
  user?: AuthUser;
  req?: Request;
}) {
  const order = await Order.findOne({ _id: opts.orderId, organizationId: opts.organizationId });
  if (!order) throw new NotFoundError("Order");
  const prev = order.status;

  if (opts.status === "cancelled" || opts.status === "partially_cancelled") {
    for (const a of order.allocations.filter((x) => x.reserved)) {
      const item = findOrderItem(order, a.orderItemId);
      const undelivered = a.qty - (item?.dispatchedQty || 0);
      if (undelivered > 0) {
        await releaseStock({
          organizationId: opts.organizationId,
          storeId: a.storeId.toString(),
          productId: a.productId.toString(),
          qty: undelivered,
          refId: order._id.toString(),
          user: opts.user,
        });
        a.reserved = false;
      }
    }
  }

  order.status = opts.status as typeof order.status;
  order.statusHistory.push({
    from: prev,
    to: opts.status,
    changedBy: opts.user?.id as never,
    remarks: opts.remarks || "",
    at: new Date(),
  });
  await order.save();
  await notify({
    organizationId: opts.organizationId,
    customerId: order.customerId.toString(),
    type: `order_${opts.status}`,
    title: `Order ${opts.status.replace(/_/g, " ")}`,
    body: `Order ${order._id}`,
    entityType: "Order",
    entityId: order._id.toString(),
  });
  await writeAudit({
    user: opts.user,
    organizationId: opts.organizationId,
    action: "order.status",
    entity: "Order",
    entityId: order._id.toString(),
    previous: { status: prev },
    next: { status: opts.status },
    req: opts.req,
  });
  return order;
}

export async function reallocate(opts: {
  organizationId: string;
  orderId: string;
  allocations: { orderItemId: string; productId: string; storeId: string; qty: number }[];
  user?: AuthUser;
  req?: Request;
}) {
  const order = await Order.findOne({ _id: opts.orderId, organizationId: opts.organizationId });
  if (!order) throw new NotFoundError("Order");
  if (ACTIVE_STATUSES.includes(order.status) && order.allocations.some((a) => a.reserved)) {
    for (const a of order.allocations.filter((x) => x.reserved)) {
      await releaseStock({
        organizationId: opts.organizationId,
        storeId: a.storeId.toString(),
        productId: a.productId.toString(),
        qty: a.qty,
        refId: order._id.toString(),
        user: opts.user,
      });
    }
  }
  const next: Alloc[] = [];
  for (const a of opts.allocations) {
    await reserveStock({
      organizationId: opts.organizationId,
      storeId: a.storeId,
      productId: a.productId,
      qty: a.qty,
      refId: order._id.toString(),
      user: opts.user,
    });
    next.push({ ...a, reserved: true });
  }
  order.allocations = next as never;
  if (next[0]) order.storeId = next[0].storeId as never;
  await order.save();
  await writeAudit({
    user: opts.user,
    organizationId: opts.organizationId,
    action: "order.reallocate",
    entity: "Order",
    entityId: order._id.toString(),
    next,
    req: opts.req,
  });
  return order;
}

void Product;
