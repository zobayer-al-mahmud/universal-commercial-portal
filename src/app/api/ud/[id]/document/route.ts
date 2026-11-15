import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { env } from "@/lib/env";
import { prisma } from "@/lib/db";
import { recordDocument } from "@/server/ud-automation/intake";

/**
 * Upload a supporting document (step 12) for a UD record. The authoritative list
 * of the 8 supporting documents + their file-type/size/conditional rules is an
 * open decision (Q-UD-07): until confirmed, any PDF/image/doc is accepted into a
 * free-form "supporting" slot and nothing is enforced beyond the size guard.
 */
const ALLOWED = /\.(pdf|png|jpe?g|tiff?|xlsx|docx)$/i;

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.UD_RUN)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const record = await prisma.udRecord.findUnique({ where: { id: params.id }, select: { id: true } });
  if (!record) return NextResponse.json({ error: "UD record not found." }, { status: 404 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart form upload." }, { status: 400 });
  }

  const slotKey = String(form.get("slotKey") || "");
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Choose a file." }, { status: 400 });
  if (!ALLOWED.test(file.name)) return NextResponse.json({ error: "Unsupported file type." }, { status: 400 });
  if (file.size > env.BGMEA_MAX_FILE_MB * 1024 * 1024) {
    return NextResponse.json({ error: `File is too large (limit ${env.BGMEA_MAX_FILE_MB} MB).` }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const ext = (file.name.match(ALLOWED)?.[0] ?? "").toLowerCase();
  const dir = resolve(env.STORAGE_ROOT, "ud", record.id, "supporting");
  await mkdir(dir, { recursive: true });
  const storagePath = join(dir, `${sha256}${ext}`);
  await writeFile(storagePath, buffer);

  const { id } = await recordDocument({
    recordId: record.id,
    kind: "supporting",
    slotKey,
    originalName: file.name,
    sha256,
    sizeBytes: file.size,
    storagePath,
    mimeDetected: file.type || "",
    actor: user.email,
  });

  return NextResponse.json({ id });
}
