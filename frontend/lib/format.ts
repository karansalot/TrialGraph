export const num = (v: number | null | undefined, d = 0) =>
  v === null || v === undefined || Number.isNaN(v) ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
export const pct = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? "—" : `${num(v, d)}%`);
export const compact = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v);
export const usd = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `$${num(v)}`);
export const date = (s?: string | null) => (s ? new Date(s).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "—");
export const dateTime = (s?: string | null) =>
  s ? new Date(s).toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC" : "—";

export function fmtValue(v: number | null | undefined, unit?: string | null) {
  if (v === null || v === undefined) return "—";
  if (unit === "%") return pct(v);
  if (unit === "USD") return usd(v);
  if (unit === "years") return `${num(v, 1)} yrs`;
  return num(v);
}

export const STATUS_STYLE: Record<string, string> = {
  recruiting: "bg-emerald-50 text-emerald-800 border-emerald-200",
  not_yet_recruiting: "bg-sky-50 text-sky-800 border-sky-200",
  enrolling_by_invitation: "bg-indigo-50 text-indigo-800 border-indigo-200",
  active_not_recruiting: "bg-amber-50 text-amber-800 border-amber-200",
  completed: "bg-neutral-100 text-neutral-700 border-neutral-200",
  unknown: "bg-neutral-50 text-neutral-500 border-neutral-200 border-dashed",
};

// Chart palette (validated reference palette; text never wears these).
export const C = { blue: "#2a78d6", orange: "#eb6834", aqua: "#1baf7a", gray: "#b9b8b2", grid: "#e7e6e2", ink2: "#52514e" };
// Sequential single-hue ramp for choropleths (light = low, dark = high).
export const SEQ = ["#e8f1fd", "#b7d3f6", "#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#104281"];
