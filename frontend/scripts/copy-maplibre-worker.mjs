// Self-host MapLibre's web worker so the app needs no third-party or blob-script origin and works under a
// strict Content-Security-Policy. Runs before dev/build; output (public/maplibre) is git-ignored.
import { copyFileSync, mkdirSync } from "node:fs";
const from = new URL("../node_modules/maplibre-gl/dist/", import.meta.url);
const to = new URL("../public/maplibre/", import.meta.url);
mkdirSync(to, { recursive: true });
for (const f of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) copyFileSync(new URL(f, from), new URL(f, to));
