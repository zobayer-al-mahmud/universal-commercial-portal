import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { buildMasterTemplate } from "@/server/pdf-combiner/read-master";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  const buf = await buildMasterTemplate();
  return new NextResponse(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="PDF_Combiner_Master_Template.xlsx"`,
      "Content-Length": String(buf.byteLength),
    },
  });
}
