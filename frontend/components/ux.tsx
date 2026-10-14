"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { geoUrl } from "@/lib/api";
import { GLOSSARY } from "@/lib/glossary";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------- glossary tooltip
export function Term({ k, children }: { k: keyof typeof GLOSSARY; children?: ReactNode }) {
  const g = GLOSSARY[k];
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex items-center gap-1" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      {children ?? g.term}
      <button type="button" aria-label={`What is ${g.term}?`} aria-describedby={open ? id : undefined} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
        onClick={(e) => { e.preventDefault(); setOpen((o) => !o); }}
        className="inline-grid size-3.5 shrink-0 place-items-center rounded-full border border-current text-[9px] font-semibold leading-none opacity-60 hover:opacity-100">?</button>
      {open && (
        <span role="tooltip" id={id} className="absolute left-0 top-full z-50 mt-1 w-64 rounded-md border bg-neutral-900 px-3 py-2 text-left text-xs font-normal normal-case leading-relaxed text-white shadow-lg">
          <b className="block">{g.term}</b>{g.text}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------- toasts
const ToastCtx = createContext<(msg: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<{ id: number; msg: string }[]>([]);
  const push = useCallback((msg: string) => {
    const id = Date.now() + Math.random();
    setItems((o) => [...o, { id, msg }]);
    setTimeout(() => setItems((o) => o.filter((x) => x.id !== id)), 2800);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
        {items.map((t) => <div key={t.id} className="rounded-full bg-neutral-900 px-4 py-2 text-sm text-white shadow-lg">{t.msg}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

export function ShareButton() {
  const toast = useToast();
  return (
    <button type="button" data-testid="share" onClick={async () => {
      try { await navigator.clipboard.writeText(window.location.href); toast("Link copied - it opens this exact view"); }
      catch { toast("Copy the address bar to share this view"); }
    }} className="rounded-md border px-2.5 py-1.5 text-sm hover:bg-muted">Share view</button>
  );
}

// ---------------------------------------------------------------- dialog shell
function Dialog({ open, onClose, label, children, wide }: { open: boolean; onClose: () => void; label: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    setTimeout(() => ref.current?.querySelector<HTMLElement>("input,button,a")?.focus(), 0);
    return () => { document.removeEventListener("keydown", onKey); prev?.focus(); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[10vh]" onMouseDown={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={label} onMouseDown={(e) => e.stopPropagation()}
        className={cn("max-h-[80vh] w-full overflow-auto rounded-xl border bg-background shadow-2xl", wide ? "max-w-3xl" : "max-w-xl")}>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------- command palette / jump-to search
interface Item { kind: string; label: string; sub?: string; href: string }
const PAGES: Item[] = [
  { kind: "Page", label: "National Overview", href: "/" }, { kind: "Page", label: "Insights", href: "/insights" },
  { kind: "Page", label: "Access Gap Explorer", href: "/access" }, { kind: "Page", label: "Trial Explorer", href: "/trials" },
  { kind: "Page", label: "Site Strategy Simulator", href: "/simulator" }, { kind: "Page", label: "Executive Brief", href: "/brief" },
  { kind: "Page", label: "Data & Methods", href: "/methods" },
];
let places: Promise<Item[]> | null = null;
const loadPlaces = () => (places ??= Promise.all([fetch(geoUrl("states")).then((r) => r.json()), fetch(geoUrl("counties")).then((r) => r.json())]).then(([s, c]) => [
  ...s.features.map((f: { properties: { usps: string; name: string } }) => ({ kind: "State", label: f.properties.name, sub: f.properties.usps, href: `/access?state=${f.properties.usps}` })),
  ...c.features.map((f: { properties: { fips: string; name: string; usps: string } }) => ({ kind: "County", label: `${f.properties.name}, ${f.properties.usps}`, href: `/access?state=${f.properties.usps}&county=${f.properties.fips}` })),
]));

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [all, setAll] = useState<Item[]>([]);
  const [sel, setSel] = useState(0);
  useEffect(() => { if (open) loadPlaces().then(setAll).catch(() => {}); }, [open]);
  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    const out: Item[] = [];
    const nct = s.match(/^nct\d{8}$/i);
    if (nct) out.push({ kind: "Trial", label: s.toUpperCase(), sub: "Open trial record", href: `/trial?id=${s.toUpperCase()}` });
    if (!s) return [...PAGES];
    out.push(...PAGES.filter((p) => p.label.toLowerCase().includes(s)));
    out.push(...all.filter((p) => p.label.toLowerCase().includes(s) || p.sub?.toLowerCase() === s).sort((a, b) => Number(!a.label.toLowerCase().startsWith(s)) - Number(!b.label.toLowerCase().startsWith(s)) || a.label.length - b.label.length).slice(0, 8));
    if (!nct) out.push({ kind: "Search", label: `Search trials for "${q.trim()}"`, href: `/trials?q=${encodeURIComponent(q.trim())}` });
    return out;
  }, [q, all]);
  const go = (it: Item) => { onClose(); setQ(""); router.push(it.href); };
  return (
    <Dialog open={open} onClose={onClose} label="Jump to">
      <div className="border-b p-3">
        <input aria-label="Jump to a page, state, county or trial" data-testid="palette-input" value={q} autoFocus
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            if (e.key === "Enter" && results[sel]) go(results[sel]);
          }}
          placeholder="Jump to a state, county, page, or NCT number…" className="w-full bg-transparent text-base outline-none" />
      </div>
      <ul role="listbox" className="p-1" data-testid="palette-results">
        {results.map((r, i) => (
          <li key={r.href + r.label} role="option" aria-selected={i === sel}>
            <button onMouseEnter={() => setSel(i)} onClick={() => go(r)} className={cn("flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm", i === sel && "bg-muted")}>
              <span>{r.label}{r.sub && <span className="ml-2 text-xs text-muted-foreground">{r.sub}</span>}</span>
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{r.kind}</span>
            </button>
          </li>))}
      </ul>
      <div className="border-t px-3 py-2 text-[11px] text-muted-foreground">↑↓ to move · Enter to open · Esc to close</div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- help panel
export function HelpPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} label="How to use TrialGraph" wide>
      <div className="space-y-5 p-5 text-sm">
        <div className="flex items-start justify-between">
          <h2 className="text-lg font-semibold">How to use TrialGraph</h2>
          <button onClick={onClose} className="rounded border px-2 py-0.5 text-xs">Close</button>
        </div>
        <ol className="grid gap-3 sm:grid-cols-2">
          {[["Pick a lens", "Choose a cancer type or trial type, a region and a travel distance in the filter bar. Every page updates."],
            ["Find the gaps", "The Access Gap Explorer colours counties by distance or by social factors. Click any county for its profile."],
            ["Check the evidence", "Insights explain what stands out. Trial Explorer shows the real registry records behind every number."],
            ["Test a strategy", "In the Simulator, click the map or ask for a plan to see how many people a hypothetical site would bring within reach."]].map(([t, d], i) => (
            <li key={t} className="rounded-lg border p-3"><div className="text-xs font-semibold text-muted-foreground">Step {i + 1}</div><div className="font-medium">{t}</div><p className="mt-1 text-muted-foreground">{d}</p></li>))}
        </ol>
        <div>
          <h3 className="mb-2 font-semibold">Keyboard shortcuts</h3>
          <p className="text-muted-foreground"><kbd className="rounded border px-1">⌘K</kbd> or <kbd className="rounded border px-1">/</kbd> jump to anything · <kbd className="rounded border px-1">?</kbd> this help · <kbd className="rounded border px-1">Esc</kbd> close</p>
        </div>
        <div>
          <h3 className="mb-2 font-semibold">Glossary</h3>
          <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
            {Object.values(GLOSSARY).map((g) => <div key={g.term}><dt className="font-medium">{g.term}</dt><dd className="text-muted-foreground">{g.text}</dd></div>)}
          </dl>
        </div>
        <p className="rounded-md bg-amber-50 p-3 text-xs text-amber-900">TrialGraph supports population-level planning. It cannot tell whether a particular person is eligible for a trial; for that, talk to a care team or visit ClinicalTrials.gov.</p>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- first-visit welcome
export function Welcome() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read a browser-only preference after hydration
    try { if (!localStorage.getItem("tg-welcome-dismissed")) setShow(true); } catch { /* storage blocked */ }
  }, []);
  if (!show) return null;
  const dismiss = () => { setShow(false); try { localStorage.setItem("tg-welcome-dismissed", "1"); } catch { /* ignore */ } };
  return (
    <section data-testid="welcome" className="relative overflow-hidden rounded-xl border bg-gradient-to-br from-sky-50 via-white to-white p-5">
      <button onClick={dismiss} aria-label="Dismiss introduction" className="absolute right-3 top-3 rounded px-2 text-lg leading-none text-muted-foreground hover:bg-muted">×</button>
      <h2 className="text-lg font-semibold tracking-tight">Who can reach a cancer trial that is recruiting today?</h2>
      <p className="mt-1 max-w-3xl text-sm text-neutral-700">TrialGraph maps every U.S. site recruiting for an oncology trial against where 331 million people live, then shows who is far away, what else they face, and where a new site would help most. Everything comes from public data and every number links to its source.</p>
      <div className="mt-4 flex flex-wrap gap-2 text-sm">
        <Link href="/insights" className="rounded-md bg-neutral-900 px-3 py-1.5 font-medium text-white hover:bg-neutral-700">See the key insights</Link>
        <Link href="/access" className="rounded-md border bg-white px-3 py-1.5 font-medium hover:bg-muted">Explore the map</Link>
        <Link href="/simulator" className="rounded-md border bg-white px-3 py-1.5 font-medium hover:bg-muted">Try the site simulator</Link>
        <button onClick={dismiss} className="px-2 py-1.5 text-muted-foreground hover:underline">I know my way around</button>
      </div>
    </section>
  );
}

/** Collapsible plain-language explainer under a page title. */
export function Explainer({ children }: { children: ReactNode }) {
  return (
    <details className="group rounded-lg border bg-card px-4 py-2 text-sm [&_summary::-webkit-details-marker]:hidden">
      <summary className="flex cursor-pointer list-none items-center gap-2 font-medium text-neutral-800">
        <span className="inline-block transition-transform group-open:rotate-90">▸</span> How to read this page
      </summary>
      <div className="mt-2 space-y-1.5 pb-1 text-neutral-700">{children}</div>
    </details>
  );
}
