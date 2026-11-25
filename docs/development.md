# Backend scaffold development notes

## Provenance and version matrix

Baseline: `5d13de01b4ddcfc5f2c71c8723e372e1f8bb9e72` on `origin/main`.
The bootstrap, module, compiler and Nest CLI configuration derive from the
maintained [Nest CLI](https://docs.nestjs.com/cli/overview) starter, generated with:

```sh
pnpm dlx @nestjs/cli@12.0.15 new core-api --skip-git --skip-install \
  --package-manager pnpm --strict --no-observe --skip-skills --type cjs
```

Generated in temporary storage; only the needed runtime/compiler configuration was
retained. The Hello World controller/service were replaced by a single health
controller. Optional deployment, observability, formatting and agent integrations
were omitted. Jest config is plain CommonJS to avoid an extra config loader.
The upstream CommonJS/Jest option is used; no custom framework or test runner.

| Tool | Pin / tested version | Upstream compatibility reference |
| --- | --- | --- |
| Node | 24.22.3 | [Node LTS releases](https://nodejs.org/en/about/previous-releases); Node 24 is LTS |
| pnpm | 10.34.9 | [pnpm installation](https://pnpm.io/installation); published package engine >=18.12; pinned with packageManager |
| Turborepo | 2.11.13 | [Support policy](https://turborepo.dev/docs/support-policy): pnpm 8+ stable; [local installation](https://turborepo.dev/docs/getting-started/installation) |
| Nest common/core/platform-express/testing | 12.6.0 | [First steps](https://docs.nestjs.com/first-steps); published core engine >=20, testing peers Nest ^12 |
| Nest CLI / schematics | 12.0.15 / 12.0.13 | [CLI](https://docs.nestjs.com/cli/overview); CLI engine >=20.11 and TypeScript ~6.0.2 |
| TypeScript | 6.0.3 | CLI's compatible ~6.0.2 line; upstream starter uses TypeScript 6 |
| Jest / ts-jest | 30.5.2 / 29.4.15 | [Nest testing](https://docs.nestjs.com/fundamentals/testing), [ts-jest installation](https://kulshekhar.github.io/ts-jest/docs/getting-started/installation); published ts-jest peers Jest ^29 or ^30, TS >=4.3 <7 |
| Supertest | 7.3.2 | [Supertest upstream](https://github.com/forwardemail/supertest); Nest HTTP testing pattern |

Versions and engine/peer constraints were checked against upstream docs and npm
metadata, then tested together. The committed lockfile pins transitive packages.
Node was installed only in temporary storage for local validation; no host runtime
was changed. Package lifecycle scripts are not allowlisted: Nest core's optional
postinstall donation notice is not needed for compilation or operation.

## Validation evidence

Local run on Linux x64 with Node v24.22.3 and pnpm 10.34.9:

| Root command | Actual result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Exit 0; lockfile up to date, resolution skipped |
| `pnpm typecheck` | Exit 0; core-api `tsc --noEmit --incremental false` |
| `pnpm test` | Exit 0; 1 suite, 1 unit test passed |
| `pnpm test:e2e` | Exit 0; 1 suite, 3 HTTP tests passed (GET health, POST health 404, POST claims 404) |
| `pnpm build` | Exit 0; Nest CLI generated `apps/core-api/dist/main.js` |
| `pnpm test:smoke` | Exit 0; 1 real compiled-process HTTP/SIGTERM test passed; `GET /health -> 200 {"status":"ok"}` |

An initial Jest run failed without `--experimental-vm-modules` when loading Nest
12's ESM packages. Restoring the generated starter's flag resolved it; both test
scripts retain that flag and Node emits its experimental VM Modules warning.
Install also reports upstream deprecated `glob@10.5.0` and an ignored optional
`@parcel/watcher@2.6.0` build script. No lifecycle scripts were approved; the real
build and smoke pass with that policy. Watch mode is a convenience, not a tested
platform acceptance gate.

CI uses read-only repository permissions and commit-pinned upstream
[checkout v7](https://github.com/actions/checkout),
[setup-node v7](https://github.com/actions/setup-node), and
[pnpm/action-setup v6](https://github.com/pnpm/action-setup).
CI runs every command above on pull requests, including Draft PRs, and on main.
Local evidence is not a claim that hosted CI or platform acceptance has passed.

## Boundaries and backlog

This is a subset of S1-01, not completion of S1-01 or P1-01.
TC01–TC06 and PT01–PT24 are **pending / not applicable to this scaffold**:
there are no domain/platform runners here and none of those cases passed.
The original specifications and golden expectations remain unchanged.

The next tasks remain tracked by issues #1 (pilot/provider decisions), #3 (full-stack
Compose), #4 (Drizzle/PostgreSQL tenant/RLS/PII/audit), #5 (Kafka outbox/inbox),
#6 (Temporal), #7 (Elasticsearch), and #8 (Kubernetes/Helm/observability/recovery).
This PR implements only #2; these mandatory components are not substituted by
stubs, nor is any platform/database/production readiness asserted.

Future domain work must preserve Decimal ROUND_HALF_UP VND arithmetic, string JSON
and NUMERIC(15,2); tenant transactions with SET LOCAL and RLS; AES-256-GCM PII and
no plaintext PII logs; immutable hash-chain audit; idempotent mutations; and
contract-cited explanations for reductions/rejections. This scaffold handles no
money, tenant data, PII, audit records or business mutations.
