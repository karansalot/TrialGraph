# Deployment guide

## Option 1 - static edition (recommended for the portfolio)

No server, no database, no secrets. The browser runs the analysis on the bundled data snapshot.

1. Push the repository to GitHub.
2. Netlify: *Add new site -> Import an existing project -> GitHub -> TrialGraph -> Deploy*. `netlify.toml` sets the build and the
   security headers (CSP, HSTS, frame and content-type protections).
3. Optional: GitHub Pages via *Settings -> Pages -> Source: GitHub Actions* (`pages.yml`).
4. Verify headers after deploying: `curl -sI https://<your-site>/ | grep -iE "content-security|strict-transport|x-frame"`.

Refresh the data: re-run the pipeline, run `trialgraph export-static`, commit `frontend/public/data`, push.

## Option 2 - live API + PostGIS

Use only if you need a refreshable server. Everything below applies to the API; none of it applies to Option 1.

| Requirement | How |
|---|---|
| TLS and rate limiting | Put the API behind a reverse proxy or CDN. Example Caddy site with a per-client limit (requires the `caddy-ratelimit` module): `rate_limit { zone api { key {remote_host} events 60 window 1m } }` |
| Least-privilege database access | Create `trialgraph_ro` (see `backend/db-init-readonly.sh` / `scripts/dev_db.sh`), run `trialgraph load` once so it receives SELECT, set `TG_API_DATABASE_URL` for the API only |
| Secrets | Provide `TG_DB_PASSWORD`, `TG_RO_PASSWORD` and `TG_CORS_ORIGINS` through the host's secret store; never commit `.env` |
| Network | Database port not published (Compose binds it to localhost); only the proxy is public |
| Ingestion | Run `trialgraph all` from a scheduled job or by hand; there is no HTTP route that can start it |
| Web build | `docker compose build web` with `NEXT_PUBLIC_API_URL=https://api.<your-domain>` (HTTPS, or the browser blocks mixed content) |

The Docker and Compose files have not been built or run on this project; test them before relying on them.
