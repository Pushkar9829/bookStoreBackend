import bcrypt from "bcryptjs";
import { z } from "zod";
import { User } from "../models";
import { AppError, UnauthorizedError } from "../utils/errors";
import { hydrateUser, signAccessToken, signRefreshToken, TokenPayload } from "../middleware/auth";

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function login(email: string, password: string) {
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) throw new UnauthorizedError("Invalid credentials");
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw new UnauthorizedError("Invalid credentials");
  if (!user.isActive) throw new AppError("Account disabled", 403, "DISABLED");
  user.lastLoginAt = new Date();
  await user.save();
  const payload: TokenPayload = {
    sub: user._id.toString(),
    orgId: user.organizationId.toString(),
    roleKey: user.roleKey,
    typ: user.roleKey === "customer" ? "customer" : "staff",
  };
  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);
  const authUser = await hydrateUser(user._id.toString());
  return { accessToken, refreshToken, user: authUser };
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 10);
}
