"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { get } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useData } from "./bits";
import { FiltersProvider, useFilters } from "./filters";

const NAV = [
  { href: "/", label: "National Overview" },
  { href: "/insights", label: "Insights" },
  { href: "/access", label: "Access Gap Explorer" },
  { href: "/trials", label: "Trial Explorer" },
  { href: "/simulator", label: "Site Strategy Simulator" },
  { href: "/brief", label: "Executive Brief" },
  { href: "/methods", label: "Data & Methods" },
];

function Freshness() {
  const { data } = useData(() => get("/api/meta/freshness"), "fresh");
  if (!data) return <span className="text-xs text-muted-foreground">checking data freshness…</span>;
  const ct = data.sources.find((s: { source_key: string }) => s.source_key === "ctgov_studies");
  const fresh = ct?.status === "fresh";
  return (
    <Link href="/methods#sources" data-testid="freshness" title="Open source and freshness details"
      className="flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs hover:bg-muted">
      <span aria-hidden className={cn("size-2 rounded-full", fresh ? "bg-emerald-500" : "bg-amber-500")} />
      <span className="font-medium">{fresh ? "Trial data fresh" : "Trial data stale"}</span>
      <span className="hidden text-muted-foreground md:inline">ClinicalTrials.gov snapshot {dateTime(ct?.retrieved_at)} · {ct?.age_days}d old</span>
    </Link>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { error } = useFilters();
  return (
    <div className="flex min-h-screen flex-col bg-neutral-50">
      <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur print:hidden">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2">
          <Link href="/" className="flex items-baseline gap-2">
            <span className="text-base font-semibold tracking-tight">TrialGraph</span>
            <span className="hidden text-xs text-muted-foreground lg:inline">Oncology trial access intelligence</span>
          </Link>
          <nav className="flex flex-wrap gap-1" aria-label="Primary">
            {NAV.map((n) => {
              const active = n.href === "/" ? path === "/" : path.startsWith(n.href);
              return <Link key={n.href} href={n.href} aria-current={active ? "page" : undefined}
                className={cn("rounded-md px-2.5 py-1.5 text-sm", active ? "bg-neutral-900 text-white" : "text-neutral-700 hover:bg-muted")}>{n.label}</Link>;
            })}
          </nav>
          <div className="ml-auto"><Freshness /></div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1400px] flex-1 space-y-4 px-4 py-4">
        {error && <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          The TrialGraph API is not reachable. Start it with <code>make api</code>. ({error})</div>}
        {children}
      </main>
      <footer className="border-t bg-background px-4 py-3 text-center text-[11px] leading-relaxed text-muted-foreground print:hidden">
        Population-level planning tool built on public data (ClinicalTrials.gov, U.S. Census Bureau, CDC PLACES, USDA ERS). Distances are straight-line.
        Not for individual eligibility or care decisions; proximity to a site does not guarantee access. Portfolio project — not affiliated with any agency.
      </footer>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return <FiltersProvider><Shell>{children}</Shell></FiltersProvider>;
}
