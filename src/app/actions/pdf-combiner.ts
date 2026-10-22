"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { runPdfCombine } from "@/server/pdf-combiner/run";

export interface PdfCombineState {
  error?: string;
  runId?: string;
}

/** Master Excel + selected folders → one combined PDF per master row. */
export async function runPdfCombineAction(_prev: PdfCombineState, formData: FormData): Promise<PdfCombineState> {
  const user = await getSessionUser();
  if (!user) return { error: "Not authenticated." };
  if (!userHasPermission(user, PERMISSIONS.PDF_COMBINE)) return { error: "You do not have permission to run the PDF Combiner." };

  const master = formData.get("master");
  if (!(master instanceof File) || master.name === "" || master.size === 0) return { error: "Upload the master Excel file." };
  const folders = formData.getAll("folders").map(String).filter(Boolean);
  if (folders.length === 0) return { error: "Select at least one folder." };

  try {
    const { runId } = await runPdfCombine({
      masterFileName: master.name,
      masterData: Buffer.from(await master.arrayBuffer()),
      folders,
      actor: user.email,
    });
    revalidatePath("/modules/pdf-combiner");
    return { runId };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "PDF combine failed." };
  }
}
