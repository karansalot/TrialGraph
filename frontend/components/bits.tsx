"use client";
import { useEffect, useState, type ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { STATUS_STYLE } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ShareButton } from "./ux";

/** Data hook: refetches when `key` changes; keeps the previous data visible while loading. */
export function useData<T>(fn: () => Promise<T>, key0: string) {
  const [nonce, setNonce] = useState(0);
  const key = `${key0}#${nonce}`;
  const [state, setState] = useState<{ data: T | null; error: string | null; key: string | null }>({ data: null, error: null, key: null });
  useEffect(() => {
    let live = true;
    fn().then((d) => live && setState({ data: d, error: null, key }))
        .catch((e) => live && setState((s) => ({ data: s.data, error: String(e.message ?? e), key })));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { data: state.data, error: state.key === key ? state.error : null, loading: state.key !== key, reload: () => setNonce((n) => n + 1) };
}

export function PageHeader({ title, lead, children }: { title: string; lead: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{lead}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 print:hidden">{children}<ShareButton /></div>
    </div>
  );
}

/** KPI tile. `source` is mandatory: every displayed metric names where it comes from. */
export function Stat({ label, value, sub, source, testId }: { label: string; value: ReactNode; sub?: ReactNode; source: string; testId?: string }) {
  return (
    <Card className="gap-0 py-0" data-testid={testId}>
      <CardContent className="px-4 py-3">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
        {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
        <div className="mt-2 border-t pt-1.5 text-[11px] leading-tight text-muted-foreground/80">{source}</div>
      </CardContent>
    </Card>
  );
}

export function Panel({ title, note, children, className, action }: { title: string; note?: ReactNode; children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <Card className={cn("gap-0 py-0", className)}>
      <CardContent className="px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-sm font-semibold">{title}</h2>
          {action}
        </div>
        <div className="mt-2">{children}</div>
        {note && <p className="mt-2 border-t pt-1.5 text-[11px] leading-snug text-muted-foreground">{note}</p>}
      </CardContent>
    </Card>
  );
}

export function StatusBadge({ group, label }: { group: string; label?: string }) {
  return <span className={cn("inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium", STATUS_STYLE[group] ?? STATUS_STYLE.unknown)}>
    {label ?? group.replaceAll("_", " ")}</span>;
}

export function Loading({ h = 200, label }: { h?: number; label?: string }) {
  return <div className="relative" aria-busy="true"><Skeleton style={{ height: h }} className="w-full" />
    {label && <span className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">{label}</span>}</div>;
}

export function ErrorNote({ error, onRetry }: { error: string | null; onRetry?: () => void }) {
  if (!error) return null;
  return <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
    <span>Something went wrong loading this view. {error.length < 160 ? error : ""}</span>
    {onRetry && <button onClick={onRetry} className="rounded border border-red-300 bg-white px-2 py-0.5 text-xs font-medium hover:bg-red-100">Try again</button>}</div>;
}

export function Callout({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warn" }) {
  return <div className={cn("rounded-md border px-3 py-2 text-xs leading-relaxed",
    tone === "warn" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-sky-200 bg-sky-50 text-sky-900")}>{children}</div>;
}
