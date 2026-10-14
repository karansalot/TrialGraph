# TrialGraph web app

Next.js 16 (App Router) + TypeScript + Tailwind 4 + shadcn/ui + MapLibre GL JS + Recharts.
All analytical numbers come from the TrialGraph API (`NEXT_PUBLIC_API_URL`, default `http://localhost:8010`).

```bash
pnpm install
pnpm dev            # http://localhost:3010
pnpm typecheck && pnpm lint && pnpm build
pnpm test:e2e       # Playwright; needs the API and this app running
node e2e/demo.mjs   # re-record docs/demo/trialgraph-demo.webm
```

MapLibre is pinned to v5: the v6 ESM worker did not load under Turbopack.
