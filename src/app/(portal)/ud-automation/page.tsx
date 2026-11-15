import Link from "next/link";
import { requireSection } from "@/lib/access";
import { PageHeader, StatusBadge } from "@/components/ui";
import { env } from "@/lib/env";
import { isKnownFactory, factoryById } from "@/server/ud-automation/factories";
import { listFactories, listUdRecords } from "@/server/ud-automation/intake";
import { getBgmeaCredentialStatus } from "@/server/ud-automation/credentials";
import { bgmeaLiveGate } from "@/server/ud-automation/guards";
import { UdNewRecord } from "@/components/UdNewRecord";
import { UdCredentialsPanel } from "@/components/UdCredentialsPanel";
import { UdFactorySelect } from "@/components/UdFactorySelect";

export const dynamic = "force-dynamic";

export default async function UdAutomationPage({ searchParams }: { searchParams: { factory?: string } }) {
  const user = await requireSection("processes");
  const factories = await listFactories();
  const selected = searchParams.factory ?? "";

  // STEP 1: factory selection is required before anything else.
  if (!selected || !isKnownFactory(selected)) {
    return (
      <div>
        <PageHeader
          title="UD Automation"
          subtitle="BGMEA UD preparation. First, select the factory you are working for — every UD, upload and value stays scoped to that factory."
          actions={<StatusBadge status="partial" />}
        />
        <div className="card p-5">
          <h3 className="text-sm font-semibold text-slate-800">Select a factory</h3>
          <p className="mb-4 mt-1 text-sm text-slate-500">Choose the factory account from the list. You cannot continue until a factory is selected.</p>
          <UdFactorySelect factories={factories} />
        </div>
      </div>
    );
  }

  const factory = factoryById(selected)!;
  const records = await listUdRecords(selected);
  const role = (user.role ?? "").toUpperCase();
  const canManageCreds = role === "ADMIN" || role === "COMMERCIAL";
  const credStatus = await getBgmeaCredentialStatus(selected);
  const gate = await bgmeaLiveGate(selected);

  return (
    <div>
      <PageHeader
        title="UD Automation"
        subtitle={`Factory: ${factory.label}`}
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge status={gate.liveEnabled ? "live" : "draft"} label={gate.liveEnabled ? "Live enabled" : "Fill & review only"} />
            <Link href="/ud-automation" className="btn-ghost btn-sm">Change factory</Link>
          </div>
        }
      />

      <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
        UD Automation never submits to BGMEA automatically — it fills and reviews only.
        {!gate.liveEnabled ? " Live portal driving is disabled (fail-closed)." : ""}
        {" "}The BGMEA Excel auto-fill template and exact portal fields are pending confirmation, so Excel auto-fill is shown as pending and field lists are indicative.
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <UdNewRecord factoryId={selected} />
        {canManageCreds ? (
          <UdCredentialsPanel
            factoryId={selected}
            factoryLabel={factory.label}
            configured={credStatus.configured}
            source={credStatus.source}
            username={credStatus.username}
          />
        ) : null}
      </div>

      <div className="card overflow-hidden">
        <div className="panel-head">
          <div className="panel-title">UD workflows for {factory.label}</div>
        </div>
        {records.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-400">No UD workflows yet for this factory. Start one above.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50/70">
                <tr>
                  <th className="th">UD</th>
                  <th className="th">Mode</th>
                  <th className="th">UD No.</th>
                  <th className="th">Step</th>
                  <th className="th">Status</th>
                  <th className="th">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {records.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50/60">
                    <td className="td">
                      <Link href={`/ud-automation/${r.id}?factory=${selected}`} className="row-link text-ananta hover:underline">
                        {r.title || r.id.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="td">{r.mode}</td>
                    <td className="td font-mono text-xs">{r.udNumber || "—"}</td>
                    <td className="td">{r.currentStep}/12</td>
                    <td className="td"><StatusBadge status={r.status} /></td>
                    <td className="td text-xs text-slate-400">{r.updatedAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="mt-4 text-xs text-slate-400">
        Credentials source: {credStatus.configured ? credStatus.source : "none configured"}. Credentials are isolated per factory, encrypted at rest, and never shown or logged.
      </p>
    </div>
  );
}
