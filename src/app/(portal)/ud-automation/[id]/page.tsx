import { redirect } from "next/navigation";
import Link from "next/link";
import { requireSection } from "@/lib/access";
import { PageHeader, StatusBadge } from "@/components/ui";
import { isKnownFactory, factoryById } from "@/server/ud-automation/factories";
import { getUdRecordScoped, loadFieldStates } from "@/server/ud-automation/intake";
import { bgmeaLiveGate, bgmeaWriteBackGate } from "@/server/ud-automation/guards";
import { listWriteBackPages } from "@/server/ud-automation/writeback";
import { UdWorkflow } from "@/components/UdWorkflow";

export const dynamic = "force-dynamic";

export default async function UdWorkflowPage({ params, searchParams }: { params: { id: string }; searchParams: { factory?: string } }) {
  await requireSection("processes");
  const factoryId = searchParams.factory ?? "";
  if (!factoryId || !isKnownFactory(factoryId)) redirect("/ud-automation");

  const record = await getUdRecordScoped(params.id, factoryId);
  if (!record) redirect(`/ud-automation?factory=${factoryId}`);

  const fields = await loadFieldStates(record.id);
  const gate = await bgmeaLiveGate(factoryId);
  const wbGate = await bgmeaWriteBackGate(factoryId);
  const writeBackPages = await listWriteBackPages(record.id);
  const factory = factoryById(factoryId)!;

  return (
    <div>
      <PageHeader
        eyebrow={factory.label}
        title={record.title || `UD workflow ${record.id.slice(0, 8)}`}
        subtitle="Guided, resumable UD preparation. Fill each step manually, import from the Sales Contract / PI, or read a UD from BGMEA — all reviewed before applying. After review you can explicitly populate & save the BGMEA pages (gated; mock in dev, production disabled). The final submission is always separate and never automatic."
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge status={record.status} />
            <Link href={`/ud-automation?factory=${factoryId}`} className="btn-ghost btn-sm">All UDs</Link>
          </div>
        }
      />
      <UdWorkflow
        factoryId={factoryId}
        record={{ id: record.id, mode: record.mode, udNumber: record.udNumber, title: record.title, status: record.status, currentStep: record.currentStep }}
        steps={record.steps.map((s) => ({ stepKey: s.stepKey, stepNo: s.stepNo, status: s.status, entryMode: s.entryMode }))}
        fields={fields}
        btbLcs={record.btbLcs.map((b) => ({ id: b.id, lcNumber: b.lcNumber, bank: b.bank, amount: b.amount, currency: b.currency, issueDate: b.issueDate, expiryDate: b.expiryDate, isNew: b.isNew }))}
        documents={record.documents.filter((d) => d.kind === "supporting").map((d) => ({ id: d.id, originalName: d.originalName, slotKey: d.slotKey, uploadedAt: d.uploadedAt.toISOString().slice(0, 16).replace("T", " ") }))}
        sourceDocs={record.documents.filter((d) => d.kind === "sales-contract" || d.kind === "pi").map((d) => ({ id: d.id, kind: d.kind, originalName: d.originalName }))}
        pendingImports={record.imports.filter((i) => i.status === "preview").map((i) => ({ id: i.id, source: i.source, stepKey: i.stepKey, previewJson: i.previewJson }))}
        liveEnabled={gate.liveEnabled}
        writeBack={{ enabled: wbGate.enabled, allowed: wbGate.allowed, target: wbGate.target, production: wbGate.production, reason: wbGate.reason, pages: writeBackPages }}
      />
    </div>
  );
}
