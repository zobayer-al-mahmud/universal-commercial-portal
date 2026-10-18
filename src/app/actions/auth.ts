"use server";

import { redirect } from "next/navigation";
import { authenticate, clearSessionCookie, setSessionCookie } from "@/lib/auth";
import { audit } from "@/lib/audit";

export interface LoginState {
  error?: string;
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Email and password are required." };

  const userId = await authenticate(email, password);
  if (!userId) {
    await audit({ entityType: "auth", entityId: email, action: "login.failed" });
    return { error: "Invalid email or password." };
  }
  await setSessionCookie(userId);
  await audit({ entityType: "auth", entityId: userId, action: "login.success", actor: email });
  redirect("/dashboard");
}

export async function logoutAction() {
  clearSessionCookie();
  redirect("/login");
}
