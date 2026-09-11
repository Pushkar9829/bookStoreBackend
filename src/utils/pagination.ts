import { Request } from "express";

export function parsePagination(req: Request) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
  const skip = (page - 1) * pageSize;
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const sort = typeof req.query.sort === "string" ? req.query.sort : "-createdAt";
  return { page, pageSize, skip, search, sort };
}

export function sortObject(sort: string): Record<string, 1 | -1> {
  const dir: 1 | -1 = sort.startsWith("-") ? -1 : 1;
  const field = sort.replace(/^-/, "") || "createdAt";
  return { [field]: dir };
}

export function paged<T>(data: T[], total: number, page: number, pageSize: number) {
  return { data, total, page, pageSize, pages: Math.ceil(total / pageSize) };
}
