import { Router } from "express";
import { z } from "zod";
import path from "path";
import { Product, ProductCategory } from "../models";
import { requirePermission, orgId } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { upload } from "../middleware/upload";
import { parsePagination, paged, sortObject } from "../utils/pagination";
import { NotFoundError } from "../utils/errors";
import { toPaise } from "../utils/money";
import { writeAudit } from "../services/audit";

export const catalogRouter = Router();

function slugify(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

catalogRouter.get("/categories", requirePermission("products.read"), async (req, res, next) => {
  try {
    const data = await ProductCategory.find({ organizationId: orgId(req) }).sort({ name: 1 });
    res.json({ data });
  } catch (e) {
    next(e);
  }
});

catalogRouter.post(
  "/categories",
  requirePermission("products.manage"),
  validate(z.object({ name: z.string().min(1), description: z.string().optional(), parentId: z.string().optional() })),
  async (req, res, next) => {
    try {
      const cat = await ProductCategory.create({
        organizationId: orgId(req),
        name: req.body.name,
        slug: slugify(req.body.name) + "-" + Date.now().toString(36),
        description: req.body.description || "",
        parentId: req.body.parentId,
      });
      res.status(201).json(cat);
    } catch (e) {
      next(e);
    }
  }
);

catalogRouter.put("/categories/:id", requirePermission("products.manage"), async (req, res, next) => {
  try {
    const cat = await ProductCategory.findOneAndUpdate(
      { _id: req.params.id, organizationId: orgId(req) },
      req.body,
      { new: true }
    );
    if (!cat) throw new NotFoundError("Category");
    res.json(cat);
  } catch (e) {
    next(e);
  }
});

catalogRouter.delete("/categories/:id", requirePermission("products.manage"), async (req, res, next) => {
  try {
    const cat = await ProductCategory.findOneAndDelete({ _id: req.params.id, organizationId: orgId(req) });
    if (!cat) throw new NotFoundError("Category");
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

catalogRouter.get("/products", requirePermission("products.read"), async (req, res, next) => {
  try {
    const { page, pageSize, skip, search, sort } = parsePagination(req);
    const q: Record<string, unknown> = { organizationId: orgId(req) };
    if (search) q.$or = [{ name: new RegExp(search, "i") }, { sku: new RegExp(search, "i") }, { isbn: new RegExp(search, "i") }];
    if (typeof req.query.categoryId === "string" && req.query.categoryId) q.categoryId = req.query.categoryId;
    if (typeof req.query.status === "string" && req.query.status) q.status = req.query.status;
    const [data, total] = await Promise.all([
      Product.find(q).populate("categoryId", "name").sort(sortObject(sort)).skip(skip).limit(pageSize),
      Product.countDocuments(q),
    ]);
    res.json(paged(data, total, page, pageSize));
  } catch (e) {
    next(e);
  }
});

catalogRouter.get("/products/:id", requirePermission("products.read"), async (req, res, next) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, organizationId: orgId(req) }).populate("categoryId");
    if (!product) throw new NotFoundError("Product");
    res.json(product);
  } catch (e) {
    next(e);
  }
});

const productSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  categoryId: z.string().optional(),
  productType: z.string().optional(),
  description: z.string().optional(),
  isbn: z.string().optional(),
  publisher: z.string().optional(),
  author: z.string().optional(),
  unit: z.string().optional(),
  taxPercent: z.number().optional(),
  defaultPrice: z.number(),
  status: z.enum(["active", "inactive"]).optional(),
  trackInventory: z.boolean().optional(),
  priceIsPaise: z.boolean().optional(),
});

catalogRouter.post("/products", requirePermission("products.manage"), validate(productSchema), async (req, res, next) => {
  try {
    const body = req.body;
    const product = await Product.create({
      organizationId: orgId(req),
      sku: body.sku.toUpperCase(),
      name: body.name,
      categoryId: body.categoryId,
      productType: body.productType || "general",
      description: body.description || "",
      isbn: body.isbn || "",
      publisher: body.publisher || "",
      author: body.author || "",
      unit: body.unit || "pcs",
      taxPercent: body.taxPercent || 0,
      defaultPrice: body.priceIsPaise ? body.defaultPrice : toPaise(body.defaultPrice),
      status: body.status || "active",
      trackInventory: body.trackInventory ?? true,
      createdBy: req.user!.id,
    });
    await writeAudit({
      user: req.user,
      organizationId: orgId(req),
      action: "product.create",
      entity: "Product",
      entityId: product._id.toString(),
      next: { sku: product.sku, name: product.name },
      req,
    });
    res.status(201).json(product);
  } catch (e) {
    next(e);
  }
});

catalogRouter.put("/products/:id", requirePermission("products.manage"), async (req, res, next) => {
  try {
    const updates = { ...req.body, updatedBy: req.user!.id };
    if (typeof updates.defaultPrice === "number" && !updates.priceIsPaise) {
      updates.defaultPrice = toPaise(updates.defaultPrice);
    }
    delete updates.priceIsPaise;
    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, organizationId: orgId(req) },
      updates,
      { new: true }
    );
    if (!product) throw new NotFoundError("Product");
    await writeAudit({
      user: req.user,
      organizationId: orgId(req),
      action: "product.update",
      entity: "Product",
      entityId: product._id.toString(),
      next: updates,
      req,
    });
    res.json(product);
  } catch (e) {
    next(e);
  }
});

catalogRouter.delete("/products/:id", requirePermission("products.manage"), async (req, res, next) => {
  try {
    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, organizationId: orgId(req) },
      { status: "inactive" },
      { new: true }
    );
    if (!product) throw new NotFoundError("Product");
    await writeAudit({
      user: req.user,
      organizationId: orgId(req),
      action: "product.deactivate",
      entity: "Product",
      entityId: product._id.toString(),
      req,
    });
    res.json(product);
  } catch (e) {
    next(e);
  }
});

catalogRouter.post(
  "/products/:id/image",
  requirePermission("products.manage"),
  upload.single("image"),
  async (req, res, next) => {
    try {
      if (!req.file) throw new NotFoundError("File");
      const url = `/uploads/products/${path.basename(req.file.path)}`;
      const product = await Product.findOneAndUpdate(
        { _id: req.params.id, organizationId: orgId(req) },
        { $push: { images: url } },
        { new: true }
      );
      if (!product) throw new NotFoundError("Product");
      res.json(product);
    } catch (e) {
      next(e);
    }
  }
);
