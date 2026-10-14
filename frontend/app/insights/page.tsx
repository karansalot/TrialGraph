"use client";
import Link from "next/link";
import { useState } from "react";
import { ErrorNote, Loading, PageHeader, useData } from "@/components/bits";
import { Curve, HBar } from "@/components/charts";
import { get, type Json } from "@/lib/api";
import { compact, num, pct } from "@/lib/format";
import { cn } from "@/lib/utils";

const THEME_STYLE: Record<string, string> = {
  "Trial type": "bg-sky-50 text-sky-800 border-sky-200", "Data quality": "bg-amber-50 text-amber-900 border-amber-200",
  Eligibility: "bg-violet-50 text-violet-800 border-violet-200", Equity: "bg-rose-50 text-rose-800 border-rose-200",
  Rurality: "bg-emerald-50 text-emerald-800 border-emerald-200", Supply: "bg-neutral-100 text-neutral-700 border-neutral-200",
  "Cancer type": "bg-indigo-50 text-indigo-800 border-indigo-200", Strategy: "bg-neutral-900 text-white border-neutral-900",
};

function InsightCard({ i, wide }: { i: Json; wide?: boolean }) {
  return (
    <article data-testid="insight" className={cn("flex flex-col rounded-xl border bg-card p-5", wide && "lg:col-span-2")}>
      <div className="flex items-center gap-2">
        <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", THEME_STYLE[i.theme])}>{i.theme}</span>
        {i.hypothetical && <span className="rounded-full border border-dashed px-2 py-0.5 text-[11px] text-muted-foreground">uses hypothetical sites</span>}
      </div>
      <h2 className="mt-3 text-lg font-semibold leading-snug tracking-tight">{i.title}</h2>
      <div className="mt-3 flex items-baseline gap-3">
        <span className="text-4xl font-semibold tabular-nums tracking-tight">{i.headline}</span>
        <span className="max-w-xs text-sm text-muted-foreground">{i.headline_label}</span>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-neutral-700">{i.text}</p>
      {i.chart && (
        <div className="mt-4">
          <div className="mb-1 text-xs font-medium text-muted-foreground">{i.chart_label}</div>
          {i.id === "diminishing_returns"
            ? <Curve data={i.chart} x="label" y="value" name={i.chart_label} xLabel="Number of hypothetical sites" format={(v) => `${v.toFixed(0)}%`} />
            : i.id === "rural_states"
              ? <HBar data={i.chart} x="value" y="label" name={i.chart_label} format={(v) => compact(v)} yWidth={40} />
              : <HBar data={i.chart} x="value" y="label" name={i.chart_label} format={(v) => `${v.toFixed(1)}%`} yWidth={170} />}
        </div>
      )}
      {i.table && (
        <table className="mt-4 w-full text-xs">
          <thead><tr className="text-left text-muted-foreground"><th className="py-1 font-medium">County</th><th className="text-right font-medium">Residents</th>
            <th className="text-right font-medium">Within reach</th><th className="text-right font-medium">Mean mi</th><th className="text-right font-medium">Poverty</th><th className="text-right font-medium">Uninsured</th></tr></thead>
          <tbody>{i.table.map((r: Json) => (<tr key={r.fips} className="border-t"><td className="py-1">{r.name}</td><td className="text-right tabular-nums">{num(r.population)}</td>
            <td className="text-right tabular-nums">{pct(r.pct_within, 0)}</td><td className="text-right tabular-nums">{num(r.mean_mi, 0)}</td>
            <td className="text-right tabular-nums">{pct(r.poverty)}</td><td className="text-right tabular-nums">{pct(r.uninsured)}</td></tr>))}</tbody>
        </table>
      )}
      <div className="mt-auto pt-4">
        <Link href={i.link} className="text-sm font-medium text-blue-700 hover:underline">Explore this →</Link>
      </div>
    </article>
  );
}

export default function Insights() {
  const [threshold, setThreshold] = useState(50);
  const { data, error } = useData<Json>(() => get("/api/insights", { threshold_mi: threshold }), String(threshold));
  return (
    <>
      <PageHeader title="Insights" lead="What the data says, computed fresh from the current snapshot. Each finding shows its evidence and links to the view where you can check it yourself.">
        <label className="grid gap-1 text-xs text-muted-foreground">Distance threshold (straight-line)
          <select aria-label="Insight threshold" className="h-8 rounded-md border bg-background px-2 text-sm" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))}>
            {[25, 50, 75, 100].map((t) => <option key={t} value={t}>{t} miles</option>)}</select></label>
      </PageHeader>
      <ErrorNote error={error} />
      {!data ? <Loading h={600} /> : (
        <>
          <div className="grid gap-4 lg:grid-cols-2" data-testid="insights">
            {data.insights.map((i: Json) => <InsightCard key={i.id} i={i} wide={i.id === "double_burden" || i.id === "diminishing_returns"} />)}
          </div>
          <p className="text-[11px] text-muted-foreground">{data.note}</p>
        </>
      )}
    </>
  );
}
