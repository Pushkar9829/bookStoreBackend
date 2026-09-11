import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { User, Role } from "../models";
import { UnauthorizedError, ForbiddenError } from "../utils/errors";
import { Permission } from "../utils/permissions";

export type AuthUser = {
  id: string;
  organizationId: string;
  storeId?: string;
  roleId: string;
  roleKey: string;
  permissions: string[];
  customerId?: string;
  name: string;
  email: string;
  managerId?: string;
  typ: "staff" | "customer";
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export type TokenPayload = {
  sub: string;
  orgId: string;
  roleKey: string;
  typ: "staff" | "customer";
};

export function signAccessToken(payload: TokenPayload) {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: env.jwtExpiresIn } as jwt.SignOptions);
}

export function signRefreshToken(payload: TokenPayload) {
  return jwt.sign(payload, env.jwtRefreshSecret, { expiresIn: env.jwtRefreshExpiresIn } as jwt.SignOptions);
}

function refreshCookieOptions() {
  return {
    httpOnly: true,
    sameSite: env.cookieSecure ? ("none" as const) : ("lax" as const),
    secure: env.cookieSecure,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/api/auth",
  };
}

export function setRefreshCookie(res: Response, token: string) {
  res.cookie("refresh_token", token, refreshCookieOptions());
}

export function clearRefreshCookie(res: Response) {
  res.clearCookie("refresh_token", refreshCookieOptions());
}

export async function hydrateUser(userId: string): Promise<AuthUser> {
  const user = await User.findById(userId);
  if (!user || !user.isActive) throw new UnauthorizedError("Account disabled");
  const role = await Role.findById(user.roleId);
  const typ: "staff" | "customer" = user.roleKey === "customer" ? "customer" : "staff";
  return {
    id: user._id.toString(),
    organizationId: user.organizationId.toString(),
    storeId: user.storeId?.toString(),
    roleId: user.roleId.toString(),
    roleKey: user.roleKey,
    permissions: role?.permissions ?? [],
    customerId: user.customerId?.toString(),
    name: user.name,
    email: user.email,
    managerId: user.managerId?.toString(),
    typ,
  };
}

export async function auth(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedError();
    const payload = jwt.verify(token, env.jwtSecret) as TokenPayload;
    req.user = await hydrateUser(payload.sub);
    next();
  } catch (err) {
    next(err instanceof UnauthorizedError ? err : new UnauthorizedError("Invalid token"));
  }
}

export function requireStaff(req: Request, _res: Response, next: NextFunction) {
  if (!req.user || req.user.typ !== "staff") return next(new ForbiddenError());
  next();
}

export function requireCustomer(req: Request, _res: Response, next: NextFunction) {
  if (!req.user || req.user.typ !== "customer" || !req.user.customerId) {
    return next(new ForbiddenError("Customer access only"));
  }
  next();
}

export function requirePermission(...perms: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new UnauthorizedError());
    if (req.user.roleKey === "super_admin") return next();
    const ok = perms.every((p) => req.user!.permissions.includes(p));
    if (!ok) return next(new ForbiddenError("Missing permission"));
    next();
  };
}

export function orgId(req: Request) {
  return req.user!.organizationId;
}

export function storeScope(req: Request): string | undefined {
  if (req.user?.roleKey === "super_admin") {
    const q = typeof req.query.storeId === "string" ? req.query.storeId : undefined;
    const bodyStore = typeof req.body?.storeId === "string" ? req.body.storeId : undefined;
    return q || bodyStore;
  }
  return req.user?.storeId;
}
