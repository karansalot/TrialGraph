// Thin typed client for the TrialGraph API. All analytical numbers come from here - the UI computes nothing itself.
export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8010";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json = any;

export async function get<T = Json>(path: string, params?: Record<string, unknown>): Promise<T> {
  const r = await fetch(API + path + qs(params), { cache: "no-store" });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

export async function post<T = Json>(path: string, body: unknown): Promise<T> {
  const r = await fetch(API + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

export function qs(params?: Record<string, unknown>): string {
  if (!params) return "";
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
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
}
