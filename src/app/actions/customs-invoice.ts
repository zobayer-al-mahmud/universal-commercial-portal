"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { parseLineItems } from "@/server/customs-invoice/build";
import { intakeCustomsInvoice, type CustomsInvoiceIntakeResult } from "@/server/customs-invoice/intake";

export interface CustomsInvoiceActionState {
  error?: string;
  result?: CustomsInvoiceIntakeResult;
}

export async function customsInvoiceAction(
  _prev: CustomsInvoiceActionState,
  formData: FormData,
): Promise<CustomsInvoiceActionState> {
  const user = await getSessionUser();
  if (!user) return { error: "Not authenticated." };
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE))
    return { error: "You do not have permission to create jobs." };

  const g = (k: string) => String(formData.get(k) ?? "").trim();
  const lineItems = parseLineItems(g("lineItems"));
  if (lineItems.length === 0) return { error: "Add at least one line item (description|hsCode|qty|unitPrice)." };

  try {
    const result = await intakeCustomsInvoice(
      {
        invoiceNumber: g("invoiceNumber"),
        marketCode: g("marketCode"),
        invoiceDate: g("invoiceDate"),
        contractNo: g("contractNo"),
        contractDate: g("contractDate"),
        hmOrderNo: g("hmOrderNo"),
        expNo: g("expNo"),
        expDate: g("expDate"),
        portOfLoading: g("portOfLoading"),
        portOfDelivery: g("portOfDelivery"),
        countryOfOrigin: g("countryOfOrigin"),
        countryOfFinalDestination: g("countryOfFinalDestination"),
        lineItems,
      },
      { actor: user.email },
    );
    revalidatePath("/modules/customs-invoice");
    revalidatePath("/jobs");
    revalidatePath("/dashboard");
    return { result };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Invoice build failed." };
  }
}
