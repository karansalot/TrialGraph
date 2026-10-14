// Data client. Two editions share every page:
//   live   - talks to the FastAPI backend (NEXT_PUBLIC_API_URL)
//   static - answers the same requests in the browser from the exported snapshot (lib/static), so the
//            whole app can be hosted on a static host with no server. Set NEXT_PUBLIC_DATA_MODE=static.
export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8010";
export const STATIC = process.env.NEXT_PUBLIC_DATA_MODE === "static";
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json = any;

export async function get<T = Json>(path: string, params?: Record<string, unknown>): Promise<T> {
  if (STATIC) return (await import("./static/router")).staticGet(path, clean(params));
  const r = await fetch(API + path + qs(params), { cache: "no-store" });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

export async function post<T = Json>(path: string, body: unknown): Promise<T> {
  if (STATIC) return (await import("./static/router")).staticPost(path, body);
  const r = await fetch(API + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

export const geoUrl = (layer: "counties" | "states") => (STATIC ? `${BASE_PATH}/data/geo/${layer}.json` : `${API}/api/geo/${layer}`);

function clean(params?: Record<string, unknown>) {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== null && v !== "") o[k] = v;
  return o;
}

export function qs(params?: Record<string, unknown>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(clean(params))) u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
}

export interface Meta {
  categories: { id: string; label: string; group: "cancer" | "lens"; rule: string | null }[];
  statuses: { id: string; label: string }[];
  states: { usps: string; name: string }[];
  scope: string;
  pipeline_run: { run_id: number; finished_at: string; scope: string };
  defaults: { threshold_mi: number; min_share: number; weights: Record<string, number>; min_gain_pop: number };
  score_components: { id: string; label: string }[];
  analysis_site_definition: string;
  distance_label: string;
  routing_configured: boolean;
  static_edition?: boolean;
}
