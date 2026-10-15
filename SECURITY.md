# Security

TrialGraph handles **only public data** (ClinicalTrials.gov, U.S. Census, CDC PLACES, USDA ERS). It stores no
accounts, no personal or patient data, and no secrets beyond a local development database password.

## Reporting a vulnerability

Please open a private advisory (repository **Security -> Report a vulnerability**) rather than a public issue.

## What is in place

| Area | Control | Verified by |
|---|---|---|
| Injection | Every user value is a bound SQL parameter; sort keys come from a whitelist; filters are validated against known categories and states | `backend/tests/test_security.py` fires injection payloads at each parameter |
| XSS | React escapes all text; map popups are built from DOM nodes (`textContent`), never HTML strings, because facility names come from third-party registry text | `frontend/e2e/security.spec.ts` injects a hostile facility name |
| Content-Security-Policy | Static host sends a strict CSP (`default-src 'self'`, no third-party origins, `object-src 'none'`, `frame-ancestors 'none'`); the map worker is self-hosted | the same Playwright suite runs under the CSP and fails on any violation |
| Untrusted URL input | `?category=`, `?state=`, `?county=` are ignored unless they match known values; static data paths never contain raw user input | `security.spec.ts` |
| Transport / headers | HSTS, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy` on the static host; `nosniff`, `no-referrer` on the API | tests + `netlify.toml` |
| API abuse | CORS limited to configured origins and GET/POST; at most 4 CPU-heavy requests at once, others get HTTP 429 | `test_security.py` |
| Supply chain | `pip-audit` and `pnpm audit --prod` report no known vulnerabilities; Dependabot enabled; the pipeline downloads only from fixed HTTPS URLs and records SHA-256 for each file | audit output, `dependabot.yml` |
| Secrets | None in the repository or history (scanned); `.env` is git-ignored | secret scan |
| Containers | API and web images run as non-root; Compose publishes the database on localhost only and takes its passwords from the environment; a root `.dockerignore` keeps `.git`, data and local env files out of the build context | `docker-compose.yml`, `.dockerignore` |
| Database least privilege | The API serves requests through `trialgraph_ro` (SELECT only; no DDL, no extensions); only the pipeline connects as the owner. Set `TG_API_DATABASE_URL` | psql denial checks; full test suite passes on the read-only role |
| Cost controls | Insights thresholds snap to six standard values (no cache thrash); the live upstream check is cached for 10 minutes; heavy routes are capped at 4 concurrent requests | `main.py`, `freshness.py` |
| Workflows | Least-privilege `GITHUB_TOKEN` (`contents: read`); no secrets used; Dependabot updates actions | `.github/workflows` |
| Ignore rules | `.env.*`, keys, certificates, credentials and logs are git-ignored | `git check-ignore` |

## Before exposing the API publicly

The hosted static edition has no server and needs none of this. For the live API: terminate TLS and rate-limit at a
reverse proxy (see `docs/DEPLOYMENT.md`), set `TG_CORS_ORIGINS` to your site, set non-default database passwords,
and keep the database off the public network.

## Known limits

- The live API has no authentication or per-client rate limiting; run it behind a reverse proxy for public use.
  The hosted static edition has no server component at all.
- Development defaults (`trialgraph` database password, trust auth on the local Postgres) are for local use only.
- `unsafe-inline` is allowed for scripts and styles because Next.js static export emits inline bootstrap scripts.
