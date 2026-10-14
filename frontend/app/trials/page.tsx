"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ErrorNote, Loading, PageHeader, StatusBadge, useData } from "@/components/bits";
import { FilterBar, useFilters } from "@/components/filters";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { get, type Json } from "@/lib/api";
import { date, num } from "@/lib/format";

const sel = "h-8 rounded-md border border-input bg-background px-2 text-sm";

export default function Trials() {
  const { category, state, meta } = useFilters();
  const [q, setQ] = useState(""); const [query, setQuery] = useState("");
  useEffect(() => {
    const init = new URLSearchParams(window.location.search).get("q");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read ?q= deep link once
    if (init) { setQ(init); setQuery(init); }
  }, []);
  const [status, setStatus] = useState("recruiting"); const [phase, setPhase] = useState(""); const [stype, setStype] = useState("");
  const [sort, setSort] = useState("updated");
  useEffect(() => { const t = setTimeout(() => setQuery(q), 300); return () => clearTimeout(t); }, [q]);
  // the page number belongs to one filter combination; any filter change starts again at page 1
  const fkey = [category, state, query, status, phase, stype, sort].join("|");
  const [pg, setPg] = useState({ k: fkey, page: 1 });
  const page = pg.k === fkey ? pg.page : 1;
  const setPage = (p: number) => setPg({ k: fkey, page: p });
  const key = [category, state, query, status, phase, stype, sort, page].join("|");
  const { data, error, loading, reload } = useData<Json>(() => get("/api/trials", { category, state, q: query, status, phase, study_type: stype, sort, page, page_size: 25 }), key);
  const pages = data ? Math.max(1, Math.ceil(data.total / 25)) : 1;

  return (
    <>
      <PageHeader title="Trial Explorer" lead="Search the real ClinicalTrials.gov records behind every number in TrialGraph. Each row links to the original registry page." />
      <FilterBar showThreshold={false}>
        <label className="grid min-w-64 flex-1 gap-1 text-xs text-muted-foreground">Search title, condition, sponsor or NCT ID
          <Input aria-label="Search trials" className="h-8" placeholder="e.g. pembrolizumab, NCT04585490, glioblastoma" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <label className="grid gap-1 text-xs text-muted-foreground">Recruitment status
          <select aria-label="Recruitment status" className={sel} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>{meta?.statuses.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
        <label className="grid gap-1 text-xs text-muted-foreground">Phase
          <select aria-label="Phase" className={sel} value={phase} onChange={(e) => setPhase(e.target.value)}>
            <option value="">Any</option>{["EARLY_PHASE1", "PHASE1", "PHASE2", "PHASE3", "PHASE4", "NA"].map((p) => <option key={p} value={p}>{p.replace("_", " ")}</option>)}</select></label>
        <label className="grid gap-1 text-xs text-muted-foreground">Study type
          <select aria-label="Study type" className={sel} value={stype} onChange={(e) => setStype(e.target.value)}>
            <option value="">Any</option><option value="INTERVENTIONAL">Interventional</option><option value="OBSERVATIONAL">Observational</option></select></label>
        <label className="grid gap-1 text-xs text-muted-foreground">Sort
          <select aria-label="Sort" className={sel} value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="updated">Last updated</option><option value="recruiting_sites">Most recruiting sites</option><option value="sites">Most sites</option><option value="nct">NCT ID</option></select></label>
      </FilterBar>
      <ErrorNote error={error} onRetry={reload} />
      <div className="rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-2 text-sm">
          <span data-testid="trial-count">{data ? <><b>{num(data.total)}</b> studies match</> : "Searching…"}{loading && data ? " · updating…" : ""}</span>
          <span className="text-xs text-muted-foreground">Site counts are for {state ? meta?.states.find((s) => s.usps === state)?.name : "the 50 states and DC"} · Source: ClinicalTrials.gov API v2</span>
        </div>
        {!data ? <div className="p-4"><Loading h={300} /></div> : (
          <Table>
            <TableHeader><TableRow><TableHead className="w-28">NCT ID</TableHead><TableHead>Study</TableHead><TableHead>Status</TableHead><TableHead>Phase</TableHead>
              <TableHead className="text-right">Recruiting sites</TableHead><TableHead className="text-right">All sites</TableHead><TableHead>Updated</TableHead><TableHead>Source</TableHead></TableRow></TableHeader>
            <TableBody data-testid="trial-rows">
              {data.trials.map((t: Json) => (
                <TableRow key={t.nct_id}>
                  <TableCell className="font-mono text-xs"><Link className="text-blue-700 hover:underline" href={`/trial?id=${t.nct_id}`}>{t.nct_id}</Link></TableCell>
                  <TableCell className="max-w-xl whitespace-normal"><Link href={`/trial?id=${t.nct_id}`} className="font-medium hover:underline">{t.brief_title}</Link>
                    <div className="text-[11px] text-muted-foreground">{t.lead_sponsor} · {(t.conditions ?? []).slice(0, 3).join("; ")}{(t.conditions ?? []).length > 3 ? "…" : ""}</div></TableCell>
                  <TableCell><StatusBadge group={t.status_group} label={meta?.statuses.find((s) => s.id === t.status_group)?.label} /></TableCell>
                  <TableCell className="text-xs">{(t.phases ?? []).join(" / ").replaceAll("PHASE", "Ph ") || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(t.n_recruiting_sites)}</TableCell><TableCell className="text-right tabular-nums">{num(t.n_us_sites)}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">{date(t.last_update_posted)}</TableCell>
                  <TableCell><a className="text-xs text-blue-700 hover:underline" href={t.source_url} target="_blank" rel="noreferrer">ClinicalTrials.gov ↗</a></TableCell>
                </TableRow>))}
              {!data.trials.length && <TableRow><TableCell colSpan={8} className="py-8 text-center text-muted-foreground">No studies match these filters. Try clearing the status or search.</TableCell></TableRow>}
            </TableBody>
          </Table>)}
        <div className="flex items-center justify-end gap-2 border-t px-4 py-2 text-sm">
          <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded border px-2 py-1 disabled:opacity-40">Previous</button>
          <span className="tabular-nums">Page {page} of {num(pages)}</span>
          <button disabled={page >= pages} onClick={() => setPage(page + 1)} className="rounded border px-2 py-1 disabled:opacity-40">Next</button>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">“Recruiting sites” counts sites whose own status is RECRUITING on a study whose overall status is RECRUITING. A study that is Completed, Active-not-recruiting or Unknown always shows 0. This tool does not assess individual eligibility.</p>
    </>
  );
}
