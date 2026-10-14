"use client";
import { Callout, ErrorNote, Loading, PageHeader, Panel, useData } from "@/components/bits";
import { FilterBar, useFilters } from "@/components/filters";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { API, get, qs, type Json } from "@/lib/api";
import { dateTime, fmtValue, num, pct } from "@/lib/format";

export default function Brief() {
  const { category, state, threshold } = useFilters();
  const params = { category, state, threshold_mi: threshold };
  const { data: b, error } = useData<Json>(() => get("/api/brief", params), `${category}|${state}|${threshold}`);
  const btn = "rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted";
  return (
    <>
      <PageHeader title="Executive Strategy Brief" lead="A decision-ready summary generated from the live analysis. Every sentence is assembled from computed values; change the filters to regenerate it.">
        <div className="flex gap-2 print:hidden">
          <a className={btn} data-testid="export-md" href={`${API}/api/brief.md${qs(params)}`} target="_blank" rel="noreferrer">Export Markdown</a>
          <button className={btn} onClick={() => window.print()}>Print / save PDF</button>
        </div>
      </PageHeader>
      <div className="print:hidden"><FilterBar /></div>
      <ErrorNote error={error} />
      {!b ? <Loading h={500} /> : (
        <article className="space-y-4" data-testid="brief">
          <div className="rounded-lg border bg-card px-5 py-4">
            <h2 className="text-lg font-semibold">{b.title}</h2>
            <p className="text-xs text-muted-foreground">Generated {dateTime(b.generated_at)} · threshold {threshold} straight-line miles · data status: {b.freshness}</p>
          </div>
          <Callout tone="warn">{b.disclaimer}</Callout>
          <Panel title="Key findings">
            <ol className="space-y-3">{b.key_findings.map((f: Json, i: number) => (
              <li key={i} className="grid grid-cols-[28px_1fr] gap-2"><span className="grid size-6 place-items-center rounded-full bg-neutral-900 text-xs font-semibold text-white">{i + 1}</span>
                <div><div className="text-sm font-semibold">{f.title}</div><p className="text-sm">{f.text}</p><p className="text-[11px] text-muted-foreground">Traceable to: {f.trace}</p></div></li>))}</ol>
          </Panel>
          <Panel title="Ranked hypothetical site opportunities" note={<>Weights: {Object.entries(b.weights).map(([k, v]) => `${b.component_labels[k]} ${((v as number) * 100).toFixed(0)}%`).join(" · ")}. Candidates are scored one at a time against today’s baseline.</>}>
            <Table><TableHeader><TableRow><TableHead>#</TableHead><TableHead>Candidate county</TableHead><TableHead className="text-right">Residents newly within {threshold} mi</TableHead><TableHead className="text-right">Miles saved / person</TableHead>
              <TableHead className="text-right">Non-metro share</TableHead><TableHead className="text-right">Score</TableHead><TableHead className="text-right">Stays top 10 across weightings</TableHead></TableRow></TableHeader>
              <TableBody>{b.ranked_opportunities.map((r: Json, i: number) => (<TableRow key={r.fips}><TableCell>{r.rank}</TableCell><TableCell>{r.name}, {r.usps}</TableCell><TableCell className="text-right tabular-nums">{num(r.pop_newly_within)}</TableCell>
                <TableCell className="text-right tabular-nums">{num(r.miles_saved_per_person, 0)}</TableCell><TableCell className="text-right tabular-nums">{pct((r.rural_share ?? 0) * 100, 0)}</TableCell><TableCell className="text-right font-semibold tabular-nums">{num(r.score, 1)}</TableCell>
                <TableCell className="text-right tabular-nums">{b.sensitivity?.weight_monte_carlo[i] ? pct(b.sensitivity.weight_monte_carlo[i].share_top_n * 100, 0) : "—"}</TableCell></TableRow>))}
                {!b.ranked_opportunities.length && <TableRow><TableCell colSpan={7} className="text-muted-foreground">No candidate meets the minimum coverage-gain filter in this scope.</TableCell></TableRow>}</TableBody></Table>
          </Panel>
          <Panel title="Access-gap counties vs other counties" note="Population-weighted county means; ecological comparison, not causal.">
            <Table><TableHeader><TableRow><TableHead>Indicator</TableHead><TableHead className="text-right">Gap counties</TableHead><TableHead className="text-right">Other counties</TableHead></TableRow></TableHeader>
              <TableBody>{b.indicator_comparison.slice(0, 8).map((i: Json) => (<TableRow key={i.indicator_id}><TableCell>{i.label} <span className="text-[11px] text-muted-foreground">{i.vintage}</span></TableCell>
                <TableCell className="text-right tabular-nums">{fmtValue(i.gap_counties, i.unit)}</TableCell><TableCell className="text-right tabular-nums">{fmtValue(i.other_counties, i.unit)}</TableCell></TableRow>))}</TableBody></Table>
          </Panel>
          <div className="grid gap-3 lg:grid-cols-2">
            <Panel title="Methodology"><dl className="space-y-2 text-sm">{b.methodology.map((m: Json) => (<div key={m.topic}><dt className="font-medium">{m.topic}</dt><dd className="text-muted-foreground">{m.text}</dd></div>))}</dl></Panel>
            <Panel title="Limitations"><ul className="list-disc space-y-1.5 pl-4 text-sm">{b.limitations.map((l: string) => <li key={l}>{l}</li>)}</ul></Panel>
          </div>
          <Panel title="Sources">
            <Table><TableHeader><TableRow><TableHead>Source</TableHead><TableHead>Publisher</TableHead><TableHead>Vintage</TableHead><TableHead>Retrieved</TableHead></TableRow></TableHeader>
              <TableBody>{b.sources.map((s: Json) => (<TableRow key={s.source_key}><TableCell className="whitespace-normal"><a className="text-blue-700 hover:underline" href={s.url} target="_blank" rel="noreferrer">{s.source_name}</a> <span className="text-[11px] text-muted-foreground">{s.source_key}</span></TableCell>
                <TableCell>{s.publisher}</TableCell><TableCell>{s.vintage}</TableCell><TableCell className="whitespace-nowrap text-xs">{dateTime(s.retrieved_at)}</TableCell></TableRow>))}</TableBody></Table>
          </Panel>
        </article>)}
    </>
  );
}
