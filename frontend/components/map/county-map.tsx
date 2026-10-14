"use client";
import maplibregl from "maplibre-gl";
import type { ExpressionSpecification, GeoJSONSource, Map as MlMap } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { geoUrl } from "@/lib/api";
import { SEQ } from "@/lib/format";

export interface MapFacility { id: number; lat: number; lon: number; n: number; name: string | null; city: string | null; usps: string; anon?: boolean }
export interface MapMarker { lat: number; lon: number; label: string }
export interface Choropleth {
  values: Record<string, number | null>;
  breaks: number[];              // ascending; breaks.length + 1 colour classes
  label: string;                 // legend title, must state the unit
  format: (v: number) => string;
}
interface Props {
  choropleth?: Choropleth | null;
  facilities?: MapFacility[] | null;
  markers?: MapMarker[];
  state?: string;                // USPS code to zoom to
  selectedFips?: string | null;
  onCountyClick?: (fips: string, name: string, usps: string, lngLat: { lat: number; lng: number }) => void;
  onFacilityClick?: (id: number) => void;
  height?: number;
  facilityLegend?: string;
}

const NO_DATA = "#efeeea";
const CONUS: [[number, number], [number, number]] = [[-125, 24], [-66.5, 49.6]];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cache: Record<string, Promise<any>> = {};
const geo = (layer: "counties" | "states") => (cache[layer] ??= fetch(geoUrl(layer)).then((r) => r.json()));

function bboxOf(geom: { type: string; coordinates: unknown }): [[number, number], [number, number]] {
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
  const walk = (c: unknown) => {
    if (typeof (c as number[])[0] === "number") {
      let [x] = c as number[]; const y = (c as number[])[1];
      if (x > 0) x -= 360; // keep the western Aleutians west of the mainland
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    } else (c as unknown[]).forEach(walk);
  };
  walk(geom.coordinates);
  return [[x0, y0], [x1, y1]];
}

export function colorFor(v: number | null | undefined, breaks: number[]): string {
  if (v === null || v === undefined || Number.isNaN(v)) return NO_DATA;
  let i = 0;
  while (i < breaks.length && v >= breaks[i]) i++;
  return SEQ[Math.min(i, SEQ.length - 1)];
}

export function CountyMap({ choropleth, facilities, markers = [], state, selectedFips, onCountyClick, onFacilityClick, height = 520, facilityLegend }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(false);
  const cb = useRef(onCountyClick);
  const choro = useRef(choropleth);
  const fcb = useRef(onFacilityClick);
  useEffect(() => { cb.current = onCountyClick; choro.current = choropleth; fcb.current = onFacilityClick; });
  const markerObjs = useRef<maplibregl.Marker[]>([]);
  const painted = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!el.current) return;
    const map = new maplibregl.Map({
      container: el.current, bounds: CONUS, fitBoundsOptions: { padding: 16 }, attributionControl: false,
      style: { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#fbfbfa" } }] },
      minZoom: 1.5, maxZoom: 10, dragRotate: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: "Boundaries: U.S. Census Bureau cartographic boundary files" }));
    mapRef.current = map;
    if (process.env.NODE_ENV !== "production") (window as unknown as { __tgmap?: MlMap }).__tgmap = map;
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });
    map.on("load", async () => {
      const [counties, states] = await Promise.all([geo("counties"), geo("states")]);
      if (!mapRef.current) return;
      map.addSource("counties", { type: "geojson", data: counties, promoteId: "fips" });
      map.addSource("states", { type: "geojson", data: states });
      map.addSource("facilities", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "county-fill", type: "fill", source: "counties", paint: { "fill-color": NO_DATA } });
      map.addLayer({ id: "county-line", type: "line", source: "counties", paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.15, 7, 0.8] } });
      map.addLayer({ id: "state-line", type: "line", source: "states", paint: { "line-color": "#6b6a66", "line-width": 0.8 } });
      map.addLayer({ id: "county-selected", type: "line", source: "counties", filter: ["==", ["get", "fips"], ""], paint: { "line-color": "#0b0b0b", "line-width": 2.5 } });
      map.addLayer({
        id: "facilities", type: "circle", source: "facilities",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, ["interpolate", ["linear"], ["get", "n"], 1, 1.6, 50, 4.5], 8, ["interpolate", ["linear"], ["get", "n"], 1, 4, 50, 11]],
          "circle-color": "#eb6834", "circle-opacity": 0.8, "circle-stroke-color": "#ffffff", "circle-stroke-width": 0.6,
        },
      });
      map.on("mousemove", "county-fill", (e) => {
        const f = e.features?.[0]; if (!f) return;
        map.getCanvas().style.cursor = cb.current ? "pointer" : "";
        const c = choro.current; const v = c?.values[f.properties.fips];
        popup.setLngLat(e.lngLat).setHTML(
          `<div style="font:12px/1.35 system-ui"><b>${f.properties.name}, ${f.properties.usps}</b>` +
          (c ? `<br>${c.label}: <b>${v === null || v === undefined ? "no data" : c.format(v)}</b>` : "") + `</div>`).addTo(map);
      });
      map.on("mouseleave", "county-fill", () => { popup.remove(); map.getCanvas().style.cursor = ""; });
      map.on("mousemove", "facilities", (e) => {
        const p = e.features?.[0]?.properties; if (!p) return;
        popup.setLngLat(e.lngLat).setHTML(`<div style="font:12px/1.35 system-ui"><b>${p.name || "Unnamed site"}</b><br>${p.city ?? ""}, ${p.usps}<br>${p.n} recruiting interventional ${p.n === 1 ? "study" : "studies"}${p.anon ? "<br><i>Sponsor-anonymised site name</i>" : ""}</div>`).addTo(map);
      });
      map.on("click", "county-fill", (e) => {
        // a click on a site dot belongs to the site, not the county underneath
        if (fcb.current && map.queryRenderedFeatures(e.point, { layers: ["facilities"] }).length) return;
        const p = e.features?.[0]?.properties; if (p) cb.current?.(p.fips, p.name, p.usps, e.lngLat);
      });
      map.on("click", "facilities", (e) => { const p = e.features?.[0]?.properties; if (p && fcb.current) fcb.current(Number(p.id)); });
      map.on("mouseenter", "facilities", () => { if (fcb.current) map.getCanvas().style.cursor = "pointer"; });
      setReady(true);
    });
    return () => { mapRef.current = null; map.remove(); };
  }, []);

  // choropleth via feature-state (no re-upload of geometry when the metric changes)
  useEffect(() => {
    const map = mapRef.current; if (!ready || !map) return;
    painted.current.forEach((f) => map.removeFeatureState({ source: "counties", id: f }));
    painted.current = new Set();
    if (!choropleth) { map.setPaintProperty("county-fill", "fill-color", NO_DATA); return; }
    for (const [fips, v] of Object.entries(choropleth.values)) {
      if (v === null || v === undefined) continue;
      map.setFeatureState({ source: "counties", id: fips }, { v });
      painted.current.add(fips);
    }
    const step: unknown[] = ["step", ["to-number", ["feature-state", "v"], 0], SEQ[0]];
    choropleth.breaks.forEach((b, i) => step.push(b, SEQ[Math.min(i + 1, SEQ.length - 1)]));
    map.setPaintProperty("county-fill", "fill-color", ["case", ["==", ["feature-state", "v"], null], NO_DATA, step] as unknown as ExpressionSpecification);
  }, [ready, choropleth]);

  useEffect(() => {
    const map = mapRef.current; if (!ready || !map) return;
    (map.getSource("facilities") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: (facilities ?? []).map((f) => ({ type: "Feature", geometry: { type: "Point", coordinates: [f.lon, f.lat] }, properties: f })),
    });
  }, [ready, facilities]);

  useEffect(() => {
    const map = mapRef.current; if (!ready || !map) return;
    map.setFilter("county-selected", ["==", ["get", "fips"], selectedFips ?? ""]);
  }, [ready, selectedFips]);

  useEffect(() => {
    const map = mapRef.current; if (!ready || !map) return;
    if (!state) { map.fitBounds(CONUS, { padding: 16, duration: 400 }); return; }
    geo("states").then((s) => {
      const f = s.features.find((x: { properties: { usps: string } }) => x.properties.usps === state);
      if (f) map.fitBounds(bboxOf(f.geometry), { padding: 30, duration: 400 });
    });
  }, [ready, state]);

  useEffect(() => {
    const map = mapRef.current; if (!ready || !map) return;
    markerObjs.current.forEach((m) => m.remove());
    markerObjs.current = markers.map((m, i) => {
      const d = document.createElement("div");
      d.setAttribute("aria-label", `Hypothetical site ${m.label}`);
      d.style.cssText = "width:22px;height:22px;border-radius:50%;background:#0b0b0b;border:2px solid #fff;display:grid;place-items:center;box-shadow:0 1px 4px rgba(0,0,0,.45);color:#fff;font:600 11px/1 system-ui";
      d.textContent = String(i + 1);
      return new maplibregl.Marker({ element: d, anchor: "center" }).setLngLat([m.lon, m.lat]).addTo(map);
    });
  }, [ready, markers]);

  return (
    <div>
      <div ref={el} style={{ height }} className="w-full overflow-hidden rounded-md border" data-testid="county-map" data-ready={ready} role="img"
        aria-label="Map of U.S. counties. The same data is available in the tables on this page." />
      <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-muted-foreground">
        {choropleth && (
          <div className="flex items-center gap-2" data-testid="map-legend">
            <span className="font-medium text-foreground">{choropleth.label}</span>
            <span className="flex items-center">
              {SEQ.slice(0, choropleth.breaks.length + 1).map((c, i) => (
                <span key={c} className="flex flex-col items-start pr-px">
                  <span style={{ background: c }} className="block h-2.5 w-full min-w-14" />
                  <span className="tabular-nums">{i === 0 ? `< ${choropleth.format(choropleth.breaks[0])}` : `${choropleth.format(choropleth.breaks[i - 1])}+`}</span>
                </span>
              ))}
            </span>
            <span className="flex items-center gap-1"><span style={{ background: NO_DATA }} className="block size-2.5 border" />no data</span>
          </div>
        )}
        {facilities && facilities.length > 0 && (
          <span className="flex items-center gap-1.5"><span className="block size-2.5 rounded-full bg-[#eb6834]" />
            {facilityLegend ?? "Currently recruiting site (size = number of recruiting studies)"}</span>
        )}
        {markers.length > 0 && <span className="flex items-center gap-1.5"><span className="block size-2.5 rounded-full bg-black" />Hypothetical site (not a real facility)</span>}
        <span className="ml-auto">Alaska and Hawaii are at their true positions — pan or pick the state under Region.</span>
      </div>
    </div>
  );
}
