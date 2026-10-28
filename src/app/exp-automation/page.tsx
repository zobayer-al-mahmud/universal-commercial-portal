import { redirect } from "next/navigation";

/**
 * Convenience alias: the EXP Automation module lives at /modules/exp-automation.
 * A bare /exp-automation (natural to type or bookmark) would otherwise 404, so
 * redirect it to the real module page. Auth is still enforced there.
 */
export default function ExpAutomationAlias() {
  redirect("/modules/exp-automation");
}
