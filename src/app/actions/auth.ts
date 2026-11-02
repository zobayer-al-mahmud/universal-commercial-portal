"use server";

import { redirect } from "next/navigation";
import { authenticate, clearSessionCookie, setSessionCookie } from "@/lib/auth";
import { audit } from "@/lib/audit";

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
    return { error: "Invalid username or password." };
  }
  await setSessionCookie(userId);
  await audit({ entityType: "auth", entityId: userId, action: "login.success", actor: username });
  redirect("/dashboard");
}

export async function logoutAction() {
  clearSessionCookie();
  redirect("/login");
}
