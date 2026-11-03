import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { landingPathForRole } from "@/lib/permissions";

export default async function Home() {
  const user = await getSessionUser();
  redirect(user ? landingPathForRole(user.role) : "/login");
}
