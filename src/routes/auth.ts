import { Router } from "express";
import jwt from "jsonwebtoken";
import { login, loginSchema } from "../services/auth.service";
import { auth, clearRefreshCookie, hydrateUser, setRefreshCookie, signAccessToken, TokenPayload } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { env } from "../config/env";
import { UnauthorizedError } from "../utils/errors";

export const authRouter = Router();

authRouter.post("/login", validate(loginSchema), async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const result = await login(email, password);
    setRefreshCookie(res, result.refreshToken);
    res.json({ accessToken: result.accessToken, user: result.user });
  } catch (e) {
    next(e);
  }
});

authRouter.post("/refresh", async (req, res, next) => {
  try {
    const token = req.cookies?.refresh_token as string | undefined;
    if (!token) throw new UnauthorizedError();
    const payload = jwt.verify(token, env.jwtRefreshSecret) as TokenPayload;
    const user = await hydrateUser(payload.sub);
    const accessToken = signAccessToken({
      sub: user.id,
      orgId: user.organizationId,
      roleKey: user.roleKey,
      typ: user.typ,
    });
    res.json({ accessToken, user });
  } catch (e) {
    next(new UnauthorizedError("Invalid refresh token"));
  }
});

authRouter.post("/logout", (_req, res) => {
  clearRefreshCookie(res);
  res.json({ ok: true });
});

authRouter.get("/me", auth, (req, res) => {
  res.json({ user: req.user });
});
