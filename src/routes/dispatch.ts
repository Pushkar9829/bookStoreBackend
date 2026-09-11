import { Router } from "express";
import { Dispatch, Order } from "../models";
import { requirePermission, orgId } from "../middleware/auth";
import { parsePagination, paged, sortObject } from "../utils/pagination";
import { AppError, NotFoundError } from "../utils/errors";
import { stockOut } from "../services/inventory.service";
import { changeOrderStatus, findOrderItem } from "../services/order.service";
import { writeAudit, notify } from "../services/audit";
import { DISPATCH_STATUSES } from "../models/dispatch";

export const dispatchRouter = Router();

dispatchRouter.get("/", requirePermission("dispatch.read"), async (req, res, next) => {
  try {
    const { page, pageSize, skip, sort } = parsePagination(req);
    const q: Record<string, unknown> = { organizationId: orgId(req) };
    if (typeof req.query.storeId === "string") q.storeId = req.query.storeId;
    else if (req.user!.roleKey !== "super_admin" && req.user!.storeId) q.storeId = req.user!.storeId;
    if (typeof req.query.status === "string") q.status = req.query.status;
    if (typeof req.query.orderId === "string") q.orderId = req.query.orderId;
    const [data, total] = await Promise.all([
      Dispatch.find(q)
        .populate("orderId", "status grandTotal")
        .populate("customerId", "name company")
        .populate("storeId", "name code")
        .sort(sortObject(sort))
        .skip(skip)
        .limit(pageSize),
      Dispatch.countDocuments(q),
    ]);
    res.json(paged(data, total, page, pageSize));
  } catch (e) {
    next(e);
  }
});

dispatchRouter.get("/pending-orders", requirePermission("dispatch.read"), async (req, res, next) => {
  try {
    const q: Record<string, unknown> = {
      organizationId: orgId(req),
      status: { $in: ["confirmed", "inventory_reserved", "processing", "ready_for_dispatch"] },
    };
    if (typeof req.query.storeId === "string") q.storeId = req.query.storeId;
    else if (req.user!.roleKey !== "super_admin" && req.user!.storeId) q.storeId = req.user!.storeId;
    const data = await Order.find(q)
      .populate("customerId", "name company")
      .populate("storeId", "name code")
      .sort({ confirmedAt: 1 })
      .limit(100);
    res.json({ data });
  } catch (e) {
    next(e);
  }
});

dispatchRouter.get("/:id", requirePermission("dispatch.read"), async (req, res, next) => {
  try {
    const d = await Dispatch.findOne({ _id: req.params.id, organizationId: orgId(req) })
      .populate("orderId")
      .populate("customerId")
      .populate("storeId");
    if (!d) throw new NotFoundError("Dispatch");
    res.json(d);
  } catch (e) {
    next(e);
  }
});

dispatchRouter.post("/", requirePermission("dispatch.manage"), async (req, res, next) => {
  try {
    const order = await Order.findOne({ _id: req.body.orderId, organizationId: orgId(req) });
    if (!order) throw new NotFoundError("Order");
    const items = (req.body.items || []) as {
      orderItemId: string;
      productId: string;
      qty: number;
      storeId?: string;
    }[];
    if (!items.length) throw new AppError("Dispatch items required");

    for (const di of items) {
      const item = findOrderItem(order, di.orderItemId);
      if (!item) throw new AppError("Order item not found");
      const remaining = item.qty - item.cancelledQty - item.dispatchedQty;
      if (di.qty > remaining) throw new AppError(`Cannot dispatch more than remaining for ${item.sku}`);
    }

    const storeId = req.body.storeId || items[0].storeId || order.storeId;
    const dispatch = await Dispatch.create({
      organizationId: orgId(req),
      storeId,
      orderId: order._id,
      customerId: order.customerId,
      status: "pending",
      carrier: req.body.carrier || "",
      trackingNumber: req.body.trackingNumber || "",
      packages: req.body.packages || "",
      shippingAddress: order.shippingAddress,
      items: items.map((di) => {
        const item = findOrderItem(order, di.orderItemId)!;
        return {
          orderItemId: di.orderItemId,
          productId: di.productId,
          sku: item.sku,
          name: item.name,
          qty: di.qty,
          storeId: di.storeId || storeId,
        };
      }),
      assignedTo: req.body.assignedTo,
      notes: req.body.notes || "",
      createdBy: req.user!.id,
    });

    if (order.status === "confirmed" || order.status === "inventory_reserved") {
      await changeOrderStatus({
        organizationId: orgId(req),
        orderId: order._id.toString(),
        status: "processing",
        remarks: "Dispatch created",
        user: req.user,
        req,
      });
    }

    await writeAudit({
      user: req.user,
      organizationId: orgId(req),
      action: "dispatch.create",
      entity: "Dispatch",
      entityId: dispatch._id.toString(),
      next: dispatch.toObject(),
      req,
    });
    res.status(201).json(dispatch);
  } catch (e) {
    next(e);
  }
});

dispatchRouter.post("/:id/status", requirePermission("dispatch.manage"), async (req, res, next) => {
  try {
    const dispatch = await Dispatch.findOne({ _id: req.params.id, organizationId: orgId(req) });
    if (!dispatch) throw new NotFoundError("Dispatch");
    const status = req.body.status as string;
    if (!DISPATCH_STATUSES.includes(status as (typeof DISPATCH_STATUSES)[number])) {
      throw new AppError("Invalid dispatch status");
    }
    const prev = dispatch.status;

    if (status === "dispatched" && prev !== "dispatched") {
      const order = await Order.findById(dispatch.orderId);
      if (!order) throw new NotFoundError("Order");
      for (const di of dispatch.items) {
        await stockOut({
          organizationId: orgId(req),
          storeId: (di.storeId || dispatch.storeId).toString(),
          productId: di.productId.toString(),
          qty: di.qty,
          type: "dispatch",
          refType: "Dispatch",
          refId: dispatch._id.toString(),
          user: req.user,
          req,
        });
        const item = findOrderItem(order, di.orderItemId);
        if (item) item.dispatchedQty += di.qty;
      }
      dispatch.dispatchedAt = new Date();
      dispatch.carrier = req.body.carrier || dispatch.carrier;
      dispatch.trackingNumber = req.body.trackingNumber || dispatch.trackingNumber;
      await order.save();

      const fully = order.items.every((it) => it.dispatchedQty + it.cancelledQty >= it.qty);
      await changeOrderStatus({
        organizationId: orgId(req),
        orderId: order._id.toString(),
        status: fully ? "dispatched" : "ready_for_dispatch",
        remarks: fully ? "Fully dispatched" : "Partial dispatch",
        user: req.user,
        req,
      });
      await notify({
        organizationId: orgId(req),
        customerId: dispatch.customerId.toString(),
        type: "order_dispatched",
        title: "Order dispatched",
        body: dispatch.trackingNumber ? `Tracking ${dispatch.trackingNumber}` : `Dispatch ${dispatch._id}`,
        entityType: "Dispatch",
        entityId: dispatch._id.toString(),
      });
    }

    if (status === "in_transit") {
      await changeOrderStatus({
        organizationId: orgId(req),
        orderId: dispatch.orderId.toString(),
        status: "in_transit",
        user: req.user,
        req,
      });
    }

    if (status === "delivered") {
      dispatch.deliveredAt = new Date();
      const order = await Order.findById(dispatch.orderId);
      const others = await Dispatch.find({ orderId: dispatch.orderId, _id: { $ne: dispatch._id } });
      const allDelivered = others.every((d) => d.status === "delivered") && order;
      if (order && allDelivered) {
        const fully = order.items.every((it) => it.dispatchedQty + it.cancelledQty >= it.qty);
        if (fully) {
          await changeOrderStatus({
            organizationId: orgId(req),
            orderId: order._id.toString(),
            status: "delivered",
            user: req.user,
            req,
          });
        }
      }
      await notify({
        organizationId: orgId(req),
        customerId: dispatch.customerId.toString(),
        type: "order_delivered",
        title: "Order delivered",
        body: `Dispatch ${dispatch._id}`,
        entityType: "Dispatch",
        entityId: dispatch._id.toString(),
      });
    }

    dispatch.status = status as typeof dispatch.status;
    if (req.body.carrier) dispatch.carrier = req.body.carrier;
    if (req.body.trackingNumber) dispatch.trackingNumber = req.body.trackingNumber;
    if (req.body.assignedTo) dispatch.assignedTo = req.body.assignedTo;
    dispatch.updatedBy = req.user!.id as never;
    await dispatch.save();
    await writeAudit({
      user: req.user,
      organizationId: orgId(req),
      action: "dispatch.status",
      entity: "Dispatch",
      entityId: dispatch._id.toString(),
      previous: { status: prev },
      next: { status },
      req,
    });
    res.json(dispatch);
  } catch (e) {
    next(e);
  }
});
