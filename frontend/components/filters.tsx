"use client";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { get, type Meta } from "@/lib/api";

interface Filters { category: string; state: string; threshold: number }
interface Ctx extends Filters { meta: Meta | null; error: string | null; set: (p: Partial<Filters>) => void; categoryLabel: string }
const FiltersContext = createContext<Ctx | null>(null);

function writeUrl(f: Filters) {
  const q = new URLSearchParams(window.location.search);
  const put = (k: string, v: string, dflt: string) => (v === dflt ? q.delete(k) : q.set(k, v));
  put("category", f.category, "all"); put("state", f.state, ""); put("threshold", String(f.threshold), "50");
  const s = q.toString();
  window.history.replaceState(window.history.state, "", window.location.pathname + (s ? `?${s}` : ""));
}

export function FiltersProvider({ children }: { children: ReactNode }) {
  const [f, setF] = useState<Filters>({ category: "all", state: "", threshold: 50 });
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const pathname = usePathname();
  useEffect(() => { get<Meta>("/api/meta").then(setMeta).catch((e) => setError(String(e))); }, []);
  // Shareable views: filters live in ?category=&state=&threshold=. On every navigation, filters carried by
  // the URL (a shared link, or an in-app deep link such as an insight) win; otherwise the current filters
  // are written to the new URL so they persist across pages.
  const fRef = useRef(f);
  useEffect(() => { fRef.current = f; }, [f]);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.has("category") || q.has("state") || q.has("threshold")) {
      const t = Number(q.get("threshold"));
      // eslint-disable-next-line react-hooks/set-state-in-effect -- adopt filters from the URL after navigation
      setF({ category: q.get("category") ?? "all", state: (q.get("state") ?? "").toUpperCase(), threshold: [25, 50, 75, 100, 150].includes(t) ? t : 50 });
    } else {
      writeUrl(fRef.current);
    }
    setHydrated(true);
  }, [pathname]);
  useEffect(() => { if (hydrated) writeUrl(f); }, [f, hydrated]);
  const safe = meta && !meta.categories.some((c) => c.id === f.category) ? { ...f, category: "all" } : f;
  const value = useMemo<Ctx>(() => ({
    ...safe, meta, error, set: (p) => setF((o) => ({ ...o, ...p })),
    categoryLabel: meta?.categories.find((c) => c.id === safe.category)?.label ?? "All oncology",
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [f, meta, error]);
  return <FiltersContext.Provider value={value}>{children}</FiltersContext.Provider>;
}

export function useFilters() {
  const c = useContext(FiltersContext);
  if (!c) throw new Error("FiltersProvider missing");
  return c;
}

const sel = "h-8 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

export function FilterBar({ showThreshold = true, children }: { showThreshold?: boolean; children?: ReactNode }) {
  const { meta, category, state, threshold, set } = useFilters();
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-2 rounded-lg border bg-card px-3 py-2.5" data-testid="filter-bar">
      <label className="grid gap-1 text-xs text-muted-foreground">Cancer type
        <select aria-label="Cancer type" className={sel} value={category} onChange={(e) => set({ category: e.target.value })}>
          {!meta && <option value="all">All oncology</option>}
          {meta && <optgroup label="Cancer type">{meta.categories.filter((c) => c.group === "cancer").map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</optgroup>}
          {meta && <optgroup label="Trial-type lens (all cancers)">{meta.categories.filter((c) => c.group === "lens").map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</optgroup>}
        </select>
      </label>
      <label className="grid gap-1 text-xs text-muted-foreground">Region
        <select aria-label="Region" className={sel} value={state} onChange={(e) => set({ state: e.target.value })}>
          <option value="">United States (50 states + DC)</option>
          {meta?.states.map((s) => <option key={s.usps} value={s.usps}>{s.name}</option>)}
        </select>
      </label>
      {showThreshold && (
        <label className="grid gap-1 text-xs text-muted-foreground">Distance threshold (straight-line)
          <select aria-label="Distance threshold" className={sel} value={threshold} onChange={(e) => set({ threshold: Number(e.target.value) })}>
            {[25, 50, 75, 100, 150].map((t) => <option key={t} value={t}>{t} miles</option>)}
          </select>
        </label>
      )}
      {children}
    </div>
  );
}
