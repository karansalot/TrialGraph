"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { get, STATIC } from "@/lib/api";
import { date, dateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useData } from "./bits";
import { FiltersProvider, useFilters } from "./filters";
import { CommandPalette, HelpPanel, ShareButton, ToastProvider } from "./ux";

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/insights", label: "Insights" },
  { href: "/access", label: "Access Gaps" },
  { href: "/trials", label: "Trials" },
  { href: "/simulator", label: "Simulator" },
  { href: "/brief", label: "Brief" },
  { href: "/methods", label: "Data & Methods" },
];

function Freshness() {
  const { data } = useData(() => get("/api/meta/freshness"), "fresh");
  if (!data) return <span className="text-xs text-muted-foreground">checking data…</span>;
  const ct = data.sources.find((s: { source_key: string }) => s.source_key === "ctgov_studies");
  const fresh = ct?.status === "fresh";
  return (
    <Link href="/methods#sources" data-testid="freshness" title={STATIC ? "Static edition: a frozen snapshot. Click for source details." : "Open source and freshness details"}
      className="flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs hover:bg-muted">
      <span aria-hidden className={cn("size-2 rounded-full", STATIC ? "bg-sky-500" : fresh ? "bg-emerald-500" : "bg-amber-500")} />
      <span className="font-medium">{STATIC ? "Snapshot" : fresh ? "Trial data fresh" : "Trial data stale"}</span>
      <span className="hidden text-muted-foreground xl:inline">
        {STATIC ? `ClinicalTrials.gov data of ${date(ct?.source_updated_at)}` : `ClinicalTrials.gov snapshot ${dateTime(ct?.retrieved_at)} · ${ct?.age_days}d old`}
      </span>
    </Link>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { error } = useFilters();
  const [menu, setMenu] = useState(false);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? "");
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) { e.preventDefault(); setPalette(true); }
      else if (e.key === "?" && !typing) { e.preventDefault(); setHelp(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- close the mobile menu after navigating
  useEffect(() => setMenu(false), [path]);
  const nav = (mobile = false) => NAV.map((n) => {
    const active = n.href === "/" ? path === "/" : path.startsWith(n.href) || (n.href === "/trials" && path.startsWith("/trial"));
    return <Link key={n.href} href={n.href} aria-current={active ? "page" : undefined}
      className={cn("rounded-md px-2.5 py-1.5 text-sm transition-colors", mobile && "block", active ? "bg-neutral-900 text-white" : "text-neutral-700 hover:bg-muted")}>{n.label}</Link>;
  });
  return (
    <div className="flex min-h-screen flex-col bg-neutral-50">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[70] focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:shadow">Skip to content</a>
      <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur print:hidden">
        <div className="mx-auto flex max-w-[1400px] items-center gap-3 px-4 py-2">
          <Link href="/" className="flex items-center gap-2" aria-label="TrialGraph home">
            <span aria-hidden className="grid size-7 place-items-center rounded-md bg-neutral-900 text-xs font-bold text-white">TG</span>
            <span className="text-base font-semibold tracking-tight">TrialGraph</span>
          </Link>
          <nav className="hidden flex-wrap gap-1 lg:flex" aria-label="Primary">{nav()}</nav>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => setPalette(true)} data-testid="open-palette" className="hidden items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted sm:flex">
              Jump to… <kbd className="rounded border px-1 text-[10px]">⌘K</kbd></button>
            <button onClick={() => setPalette(true)} aria-label="Search" className="rounded-md border px-2.5 py-1.5 text-sm sm:hidden">Search</button>
            <span className="hidden md:block"><Freshness /></span>
            <button onClick={() => setHelp(true)} aria-label="Help and glossary" data-testid="open-help" className="grid size-8 place-items-center rounded-full border text-sm font-semibold hover:bg-muted">?</button>
            <button onClick={() => setMenu((m) => !m)} aria-expanded={menu} aria-controls="mobile-nav" className="rounded-md border px-2.5 py-1.5 text-sm lg:hidden">{menu ? "Close" : "Menu"}</button>
          </div>
        </div>
        {menu && <nav id="mobile-nav" aria-label="Primary" className="space-y-1 border-t px-4 py-2 lg:hidden">{nav(true)}<div className="pt-2"><Freshness /></div></nav>}
      </header>
      <main id="main" className="mx-auto w-full max-w-[1400px] flex-1 space-y-4 px-4 py-4">
        {error && <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {STATIC ? "The data snapshot could not be loaded. Please refresh the page." : <>The TrialGraph API is not reachable. Start it with <code>make api</code>.</>} ({error})</div>}
        {children}
      </main>
      <footer className="border-t bg-background px-4 py-4 text-center text-[11px] leading-relaxed text-muted-foreground print:hidden">
        <div className="mx-auto max-w-4xl">
          Built on public data: ClinicalTrials.gov, U.S. Census Bureau, CDC PLACES, USDA ERS. Distances are straight-line.
          For population-level planning only. It does not assess individual eligibility, and living near a site does not guarantee access.
          {STATIC && " Static edition: all analysis runs in your browser on a frozen data snapshot."}
          {" "}<a className="underline" href="https://github.com/karansalot/TrialGraph" target="_blank" rel="noreferrer">Source code &amp; methodology</a>
        </div>
      </footer>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
      <HelpPanel open={help} onClose={() => setHelp(false)} />
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return <ToastProvider><FiltersProvider><Shell>{children}</Shell></FiltersProvider></ToastProvider>;
}

export { ShareButton };
