"use server";

import { redirect } from "next/navigation";
import { authenticate, clearSessionCookie, setSessionCookie, getSessionUser } from "@/lib/auth";
import { landingPathForRole } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { recordAuthEvent } from "@/server/monitoring/auth-events";

export interface LoginState {
  error?: string;
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!username || !password) return { error: "Username and password are required." };

  const userId = await authenticate(username, password);
  if (!userId) {
    await audit({ entityType: "auth", entityId: username, action: "login.failed" });
    await recordAuthEvent({ kind: "login_failed", username, detail: "Invalid username or password" });
    return { error: "Invalid username or password." };
  }
  await setSessionCookie(userId);
  const signedIn = await prisma.user.findUnique({ where: { id: userId }, include: { role: true } });
  const roleName = signedIn?.role?.name ?? "";
  await audit({ entityType: "auth", entityId: userId, action: "login.success", actor: username });
  await recordAuthEvent({ kind: "login_success", username, userId, role: roleName });
  // Land on the first section this role can open (Commercial → Processes).
  redirect(landingPathForRole(roleName));
}

export async function logoutAction() {
  // Capture who is signing out (with IP/UA) before the cookie is cleared.
  const user = await getSessionUser().catch(() => null);
  if (user) {
    await audit({ entityType: "auth", entityId: user.id, action: "logout", actor: user.username || user.email });
    await recordAuthEvent({ kind: "logout", username: user.username || user.email, userId: user.id, role: user.role });
  }
  clearSessionCookie();
  redirect("/login");
}
