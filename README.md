# TPA Health and Life

Backend foundation for issue #2. The approved architecture and domain requirements
are in [docs/ai-specs](docs/ai-specs). This scaffold implements only process health.

## Local development

Use Node **24.22.3** (also pinned in `.node-version`) and pnpm **10.34.9**.
With the correct Node on your PATH, Corepack users can run
`corepack pnpm@10.34.9 install --frozen-lockfile`; alternatively install that
exact pnpm version with your preferred package-manager setup.

From a clean clone, at the repository root:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
pnpm test:smoke
pnpm --filter @tpa/core-api start
```

In another terminal: `curl -i http://127.0.0.1:3000/health`.
Expected: HTTP 200, JSON `{"status":"ok"}`. Stop with Ctrl+C.
For watch mode use `pnpm dev`. `PORT` defaults to `3000`, `HOST` to `127.0.0.1`;
set them explicitly if needed (for example `HOST=0.0.0.0` in a future container).
No database, external service, credentials or containers are needed for these checks.

`/health` is an unauthenticated process liveness endpoint, **not dependency
readiness**. It makes no database, workflow, event, search or business checks.
Unit and HTTP tests use Jest; the smoke test boots `dist/main.js` in a child
process on an ephemeral loopback port, checks HTTP, and sends SIGTERM.

See [development notes](docs/development.md) for upstream provenance, compatibility,
validation evidence and pending work. No identity server, claim/payment
API, database adapter or custom workflow implementation is included.

## Local web + API preview (issue #68)

`apps/workbench` is a Next.js App Router + shadcn/ui workspace (Vietnamese): a
browser-only PROTOTYPE of organisation onboarding (create organisation, profile,
logo, brand theme; backend proposal in `docs/ai-specs/13-…`), an honest
claims-intake preview and a real same-origin connection to core-api `GET /health`.
Start both compiled apps on loopback (no Docker needed):

```sh
pnpm preview:local   # prints READY http://127.0.0.1:3100 once FE, BE and FE->BE respond
pnpm preview:stop    # or Ctrl+C; stops only the processes the launcher started
```

This is process liveness and UI progress only, not claims workflow or platform
readiness. Details, tests and remaining backend prerequisites:
[docs/local-preview.md](docs/local-preview.md).

## Local infrastructure

The dev-only mandatory dependency stack and synthetic connectivity tests live in
[infra/compose](infra/compose/README.md). From the root, `pnpm infra:up`,
`pnpm infra:smoke`, and `pnpm infra:down` use native Docker Compose. No host ports
are published by default. This is separate from the process-only API scaffold;
production and domain acceptance remain pending.
