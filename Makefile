# TrialGraph developer commands (no-Docker path; see docker-compose.yml for the container path).
ENV := .tools/env/bin
.PHONY: setup db db-stop pipeline refresh api web dev test test-unit test-e2e lint demo static

setup:            ## create the project-local toolchain (Python 3.12 + PostgreSQL/PostGIS) and install deps
	./scripts/dev_env.sh
	cd frontend && pnpm install && pnpm exec playwright install chromium
db:               ## start local PostGIS on :5433
	./scripts/dev_db.sh start
db-stop:
	./scripts/dev_db.sh stop
pipeline: db      ## extract (cached) -> transform -> load -> analyze
	$(ENV)/trialgraph all
refresh: db       ## re-download ClinicalTrials.gov and rebuild
	$(ENV)/trialgraph extract --refresh --only ctgov
	$(ENV)/trialgraph transform && $(ENV)/trialgraph load && $(ENV)/trialgraph analyze
api: db           ## API on :8010 (docs at /docs)
	$(ENV)/uvicorn trialgraph.api.main:app --app-dir backend --port 8010 --reload --reload-dir backend/trialgraph
web:              ## web app on :3010
	cd frontend && pnpm dev
test-unit:        ## unit + data-validation + API tests (DB tests skip if the database is not loaded)
	cd backend && ../$(ENV)/pytest -q
test-e2e:         ## Playwright (needs `make api` and `make web` running)
	cd frontend && pnpm test:e2e
test: test-unit test-e2e
lint:
	$(ENV)/ruff check backend && cd frontend && pnpm typecheck && pnpm lint
demo:             ## record the product walkthrough video into docs/demo/
	cd frontend && node e2e/demo.mjs
static:           ## export the data snapshot and build the static edition into frontend/out (serve with pnpm serve:static)
	$(ENV)/trialgraph export-static
	cd frontend && pnpm build:static
