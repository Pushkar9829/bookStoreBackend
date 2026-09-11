import { Router } from "express";
import { Product, Cart, Order, Customer, CustomerAddress, Dispatch, Inventory } from "../models";
import { requireCustomer, orgId } from "../middleware/auth";
import { parsePagination, paged } from "../utils/pagination";
import { AppError, NotFoundError } from "../utils/errors";
import { resolvePrice } from "../services/pricing.service";
import { createOrderFromLines } from "../services/order.service";
import { parseSpreadsheet } from "../utils/spreadsheet";
import { upload } from "../middleware/upload";

export const portalRouter = Router();
portalRouter.use(requireCustomer);

function customerId(req: { user?: { customerId?: string } }) {
  return req.user!.customerId!;
}

portalRouter.get("/me", async (req, res, next) => {
  try {
    const customer = await Customer.findById(customerId(req)).populate("storeId", "name");
    const addresses = await CustomerAddress.find({ customerId: customerId(req) });
    res.json({ customer, addresses, user: req.user });
  } catch (e) {
    next(e);
  }
});

portalRouter.put("/profile", async (req, res, next) => {
  try {
    const customer = await Customer.findByIdAndUpdate(
      customerId(req),
      { name: req.body.name, phone: req.body.phone, notes: req.body.notes },
      { new: true }
    );
    res.json(customer);
  } catch (e) {
    next(e);
  }
});

portalRouter.post("/addresses", async (req, res, next) => {
  try {
    const addr = await CustomerAddress.create({
      organizationId: orgId(req),
      customerId: customerId(req),
      ...req.body,
    });
    res.status(201).json(addr);
  } catch (e) {
    next(e);
  }
});

portalRouter.get("/products", async (req, res, next) => {
  try {
    const { page, pageSize, skip, search } = parsePagination(req);
    const q: Record<string, unknown> = { organizationId: orgId(req), status: "active" };
    if (search) q.$or = [{ name: new RegExp(search, "i") }, { sku: new RegExp(search, "i") }];
    if (typeof req.query.categoryId === "string") q.categoryId = req.query.categoryId;
    const [products, total] = await Promise.all([
      Product.find(q).populate("categoryId", "name").skip(skip).limit(pageSize),
      Product.countDocuments(q),
    ]);
    const cid = customerId(req);
    const customer = await Customer.findById(cid);
    const data = [];
    for (const p of products) {
      const priced = await resolvePrice({
        organizationId: orgId(req),
        customerId: cid,
        productId: p._id.toString(),
        storeId: customer?.storeId?.toString(),
        qty: 1,
      });
      const inv = customer?.storeId
        ? await Inventory.findOne({ storeId: customer.storeId, productId: p._id })
        : null;
      data.push({
        _id: p._id,
        sku: p.sku,
        name: p.name,
        description: p.description,
        images: p.images,
        unit: p.unit,
        category: p.categoryId,
        isbn: p.isbn,
        author: p.author,
        publisher: p.publisher,
        unitPrice: priced.unitPrice,
        taxPercent: priced.taxPercent,
        available: inv ? inv.physical - inv.reserved : null,
      });
    }
    res.json(paged(data, total, page, pageSize));
  } catch (e) {
    next(e);
  }
});

async function cartWithPrices(req: Parameters<typeof orgId>[0]) {
  const cart = await Cart.findOne({ customerId: customerId(req) }) || await Cart.create({
    organizationId: orgId(req),
    customerId: customerId(req),
    items: [],
  });
  const customer = await Customer.findById(customerId(req));
  const items = [];
  let grandTotal = 0;
  for (const it of cart.items) {
    const priced = await resolvePrice({
      organizationId: orgId(req),
      customerId: customerId(req),
      productId: it.productId.toString(),
      storeId: customer?.storeId?.toString(),
      qty: it.qty,
    });
    const lineTotal = Math.round(it.qty * priced.unitPrice * (1 + priced.taxPercent / 100));
    grandTotal += lineTotal;
    items.push({
      productId: priced.product._id,
      sku: priced.product.sku,
      name: priced.product.name,
      qty: it.qty,
      unitPrice: priced.unitPrice,
      taxPercent: priced.taxPercent,
      lineTotal,
      images: priced.product.images,
    });
  }
  return { cart, items, grandTotal };
}

portalRouter.get("/cart", async (req, res, next) => {
  try {
    res.json(await cartWithPrices(req));
  } catch (e) {
    next(e);
  }
});

portalRouter.post("/cart", async (req, res, next) => {
  try {
    const cart = await Cart.findOne({ customerId: customerId(req) }) || await Cart.create({
      organizationId: orgId(req),
      customerId: customerId(req),
      items: [],
    });
    const productId = req.body.productId as string;
    const qty = Number(req.body.qty || 1);
    const existing = cart.items.find((i) => i.productId.toString() === productId);
    if (existing) existing.qty = qty;
    else cart.items.push({ productId: productId as never, qty });
    await cart.save();
    res.json(await cartWithPrices(req));
  } catch (e) {
    next(e);
  }
});

portalRouter.delete("/cart/:productId", async (req, res, next) => {
  try {
    await Cart.updateOne({ customerId: customerId(req) }, { $pull: { items: { productId: req.params.productId } } });
    res.json(await cartWithPrices(req));
  } catch (e) {
    next(e);
  }
});

portalRouter.post("/orders", async (req, res, next) => {
  try {
    let items = req.body.items as { productId: string; qty: number }[] | undefined;
    if (!items?.length) {
      const { items: cartItems } = await cartWithPrices(req);
      items = cartItems.map((i) => ({ productId: i.productId.toString(), qty: i.qty }));
    }
    if (!items.length) throw new AppError("Cart is empty");
    const order = await createOrderFromLines({
      organizationId: orgId(req),
      customerId: customerId(req),
      items,
      source: "portal",
      createdBy: req.user!.id,
      notes: req.body.notes,
      shippingAddress: req.body.shippingAddress,
    });
    await Cart.updateOne({ customerId: customerId(req) }, { items: [] });
    res.status(201).json(order);
  } catch (e) {
    next(e);
  }
});

portalRouter.post("/orders/bulk", upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) throw new AppError("File required");
    const rows = parseSpreadsheet(req.file.path);
    const items: { productId: string; qty: number }[] = [];
    const preview = [];
    const errors: { row: number; message: string }[] = [];
    let i = 0;
    for (const row of rows) {
      i += 1;
      const sku = (row.sku || "").toUpperCase();
      const qty = Number(row.qty || row.quantity || 0);
      const product = await Product.findOne({ organizationId: orgId(req), sku, status: "active" });
      if (!product || !qty) {
        errors.push({ row: i, message: !product ? `Unknown SKU ${sku}` : "Invalid qty" });
        continue;
      }
      items.push({ productId: product._id.toString(), qty });
      const priced = await resolvePrice({
        organizationId: orgId(req),
        customerId: customerId(req),
        productId: product._id.toString(),
        qty,
      });
      preview.push({
        sku,
        name: product.name,
        qty,
        unitPrice: priced.unitPrice,
        lineTotal: Math.round(qty * priced.unitPrice),
      });
    }
    if (req.body.preview === "true" || req.query.preview === "true") {
      return res.json({ preview, errors });
    }
    if (!items.length) throw new AppError("No valid rows");
    const order = await createOrderFromLines({
      organizationId: orgId(req),
      customerId: customerId(req),
      items,
      source: "portal",
      createdBy: req.user!.id,
      notes: "Bulk portal order",
    });
    res.status(201).json({ order, errors });
  } catch (e) {
    next(e);
  }
});

portalRouter.get("/orders", async (req, res, next) => {
  try {
    const { page, pageSize, skip } = parsePagination(req);
    const q: Record<string, unknown> = { organizationId: orgId(req), customerId: customerId(req) };
    if (typeof req.query.status === "string") q.status = req.query.status;
    const [data, total] = await Promise.all([
      Order.find(q).sort({ createdAt: -1 }).skip(skip).limit(pageSize),
      Order.countDocuments(q),
    ]);
    res.json(paged(data, total, page, pageSize));
  } catch (e) {
    next(e);
  }
});

portalRouter.get("/orders/:id", async (req, res, next) => {
  try {
    const order = await Order.findOne({
      _id: req.params.id,
      organizationId: orgId(req),
      customerId: customerId(req),
    });
    if (!order) throw new NotFoundError("Order");
    const dispatches = await Dispatch.find({ orderId: order._id });
    res.json({ ...order.toObject(), dispatches });
  } catch (e) {
    next(e);
  }
});

portalRouter.get("/dashboard", async (req, res, next) => {
  try {
    const cid = customerId(req);
    const q = { organizationId: orgId(req), customerId: cid };
    const [current, pending, delivered, recent] = await Promise.all([
      Order.countDocuments({ ...q, status: { $in: ["submitted", "confirmed", "processing", "ready_for_dispatch", "dispatched", "in_transit"] } }),
      Order.countDocuments({ ...q, status: { $in: ["submitted", "confirmed", "on_hold"] } }),
      Order.countDocuments({ ...q, status: "delivered" }),
      Order.find(q).sort({ createdAt: -1 }).limit(5),
    ]);
    res.json({ current, pending, delivered, recent });
  } catch (e) {
    next(e);
  }
});
