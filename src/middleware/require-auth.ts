import type { RequestHandler } from "express";
import { authService } from "../services/auth.service.js";
import { userService } from "../services/user.service.js";

export const requireDashboardAuth: RequestHandler = async (req, _res, next) => {
  try {
    const user = await authService.verifyDashboardRequest(req.header("authorization"), req.header("x-mock-user-id"));
    req.user = user;
    await userService.ensureUser(user.id, user.email);
    next();
  } catch (error) {
    next(error);
  }
};
