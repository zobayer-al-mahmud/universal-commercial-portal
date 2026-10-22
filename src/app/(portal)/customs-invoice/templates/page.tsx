import Link from "next/link";
import { PageHeader, StatusBadge } from "@/components/ui";
import { listTemplates } from "@/server/customs-invoice/templates";
import { learnLayout, type LearnedLayout } from "@/server/customs-invoice/learn-template";

export const dynamic = "force-dynamic";

export default async function TemplateHealthPage() {
  const templates = listTemplates();
  // Learn every template in parallel (ExcelJS loads are modest for these ~40KB files).
  const learned = await Promise.all(templates.map(async (t) => ({ t, l: await learnLayout(t.path) })));

  const healthy = learned.filter((x) => x.l && x.l.warnings.length === 0).length;
  const warning = learned.filter((x) => x.l && x.l.warnings.length > 0).length;
  const broken = learned.filter((x) => !x.l).length;

  return (
    <div>
      <PageHeader
        title="Customs-Invoice Templates — Learned Layouts"
        subtitle={`${templates.length} template files · ${healthy} healthy · ${warning} warnings · ${broken} unreadable`}
        actions={<Link href="/customs-invoice" className="btn-ghost text-xs">← Back</Link>}
      />

      <p className="mb-4 text-xs text-slate-500">
        For every country-coded template file, the learner finds the <code>PAYMENT INVOICE</code> input row (the one row
        with the <code>AGL/H&amp;M/.../YYYY</code> contract reference) and records which column holds each field. On
        download, the writer uses this layout to populate the invoice — the cross-sheet formulas in
        <code> SUMMARY </code>/<code> CUSTOM INVOICE </code>/<code> MCO </code> cascade automatically.
      </p>

      <div className="card overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">Country code</th>
              <th className="th">Template</th>
              <th className="th">Input row</th>
              <th className="th">Observed</th>
              <th className="th">Status</th>
            </tr>
          </thead>
          <tbody>
            {learned.map(({ t, l }) => (
              <tr key={t.path} className="border-t border-slate-50">
                <td className="td font-mono">{t.countryCode}{t.variant ? <span className="text-slate-400"> · {t.variant}</span> : null}</td>
                <td className="td text-slate-500">{t.filename}</td>
                <td className="td text-right">{l ? l.inputRow : "—"}</td>
                <td className="td">
                  {l ? (
                    <div className="text-[10px] text-slate-500">
                      {renderObserved(l)}
                    </div>
                  ) : (
                    <span className="text-slate-400">no PAYMENT INVOICE sheet / no contract ref</span>
                  )}
                </td>
                <td className="td">
                  {!l ? (
                    <StatusBadge status="failed" />
                  ) : l.warnings.length === 0 ? (
                    <StatusBadge status="verified" />
                  ) : (
                    <div>
                      <StatusBadge status="needs_review" />
                      <ul className="mt-1 text-[10px] text-amber-700">
                        {l.warnings.map((w, i) => <li key={i}>• {w}</li>)}
                      </ul>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function renderObserved(l: LearnedLayout) {
  const bits: string[] = [];
  if (l.observed.contractNo) bits.push(`B=${l.observed.contractNo}`);
  if (l.observed.hmOrderNo) bits.push(`D=${l.observed.hmOrderNo}`);
  if (l.observed.invoiceNumber) bits.push(`J=${l.observed.invoiceNumber}`);
  if (l.observed.marketCode) bits.push(`K=${l.observed.marketCode}`);
  if (l.observed.quantityPcs) bits.push(`M=${l.observed.quantityPcs}`);
  if (l.observed.unitPrice) bits.push(`F=${l.observed.unitPrice}`);
  return bits.slice(0, 6).join(" · ");
}
