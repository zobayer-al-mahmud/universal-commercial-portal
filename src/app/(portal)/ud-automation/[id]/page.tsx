import { redirect } from "next/navigation";
import Link from "next/link";
import { requireSection } from "@/lib/access";
import { PageHeader, StatusBadge } from "@/components/ui";
import { isKnownFactory, factoryById } from "@/server/ud-automation/factories";
import { getUdRecordScoped, loadFieldStates } from "@/server/ud-automation/intake";
import { bgmeaLiveGate, bgmeaWriteBackGate } from "@/server/ud-automation/guards";
import { listWriteBackPages, WRITE_COVERAGE } from "@/server/ud-automation/writeback";
import { expireStaleRuns, getRunReport, listRuns } from "@/server/ud-automation/runs";
import { UdWorkflow } from "@/components/UdWorkflow";

export const dynamic = "force-dynamic";

/**
 * Keep only the lightweight parts of a fetch report for the persistent page payload:
 * per-section status/counts/unmapped. The heavy captured dropdown options and the HS
 * Code / Unit reference-list rows (~300 KB) are dropped here — they are shown from the
 * live in-session fetch result, and keeping them in every render/refresh made the RSC
 * refresh after "Apply reviewed values" abort, so applied values did not appear.
 */
function summariseFetchReport(report: Record<string, unknown>): Record<string, unknown> {
  const sections = Array.isArray(report.sections) ? report.sections : [];
  return {
    sections: sections.map((s: Record<string, unknown>) => ({
      key: s.key,
      stepKey: s.stepKey,
      title: s.title,
      status: s.status,
      found: s.found,
      message: s.message,
      unmapped: s.unmapped,
      // `dropdowns` intentionally omitted (the heavy part).
    })),
    referenceLists: [], // rows omitted (the heavy part); available from the live fetch result.
    unmapped: Array.isArray(report.unmapped) ? report.unmapped : [],
  };
}

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
  await expireStaleRuns(record.id);
  const runs = await listRuns(record.id, 12);
  const lastFetch = runs.find((r) => r.kind === "fetch" && r.status !== "running");
  // A fetch report can be very large (thousands of captured dropdown options + the
  // HS Code / Unit reference lists ≈ 300 KB). Serialising all of it into the client
  // on every render — and on every router.refresh() after a mutation — made those
  // RSC refreshes abort, so applied values never appeared until a full reload. Only
  // the lightweight per-section summary + unmapped list needs to survive a reload;
  // the full dropdown/reference detail is shown from the live fetch result in-session.
  const fullFetchReport = lastFetch ? await getRunReport(record.id, lastFetch.id) : null;
  const lastFetchReport = fullFetchReport ? summariseFetchReport(fullFetchReport) : null;
  const factory = factoryById(factoryId)!;

  return (
    <div>
      <PageHeader
        eyebrow={factory.label}
        title={record.title || `UD workflow ${record.id.slice(0, 8)}`}
        subtitle="Guided, resumable UD preparation. Fill each step manually, import from the Sales Contract / PI, or fetch the UD's existing data from BGMEA (this factory's own account) — all reviewed before applying. After review, Confirm Ready for BGMEA saves the reviewed values to this UD's BGMEA pages. The final submission is always a separate action you take in BGMEA."
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
        factoryLabel={factory.label}
        liveEnabled={gate.liveEnabled}
        liveReason={gate.reason}
        writeBack={{ enabled: wbGate.enabled, allowed: wbGate.allowed, target: wbGate.target, reason: wbGate.reason, pages: writeBackPages, coverage: WRITE_COVERAGE }}
        runs={runs}
        lastFetchReport={lastFetchReport as never}
      />
    </div>
  );
}
