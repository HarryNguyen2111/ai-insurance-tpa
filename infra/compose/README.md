# Development dependencies

Issue #3 supplies **synthetic local development only**. Single-node Kafka,
Elasticsearch, Temporal auto-setup and SeaweedFS are not HA or production topology.
No deployment, domain migration, identity provider or business API is included.
S0-01 provider, data-location, licensing and capacity decisions remain open.

## Run

Prerequisites: Docker Engine with Compose v2 supporting `--wait`, Linux amd64
(the tested architecture), about 5 GiB available RAM for the stack/smoke, and
adequate image/data disk space. Inspect `free -h`, `df -h`, `docker ps`, and
`docker stats --no-stream` before starting on a shared machine. Do not change
host sysctls or stop other workloads to make this stack fit. Reduce competing
workloads only with their owner's authorization, or use a suitable runner.

From the repository root:

```sh
# Choose a project name unique to your checkout; retain it for all commands.
export COMPOSE_PROJECT_NAME=tpa-my-checkout
# Orchestrator sessions already supply AO_SESSION_ID; standalone users may set it.
export AO_SESSION_ID="${AO_SESSION_ID:-standalone-dev}"
pnpm infra:up
pnpm infra:smoke
pnpm infra:down
```

Native equivalents, requiring no Node/pnpm installation:

```sh
cd infra/compose
# Optional: cp .env.example .env, then replace local placeholders.
docker compose config --quiet
docker compose up -d --wait --wait-timeout 300
docker compose --profile test run --build --rm smoke
docker compose down
```

Root scripts read exported environment variables; to use the optional file with
root commands, set `COMPOSE_ENV_FILES=infra/compose/.env`. Running inside this
directory automatically reads `.env`. Never print rendered `docker compose config`
in shared logs if you supplied private values. `config --quiet` validates silently.

`down` retains data. To reset **only your chosen project**, run from this directory:
`docker compose --profile test down --volumes --remove-orphans`. This destroys its
synthetic data. Never run global prune or delete another project's volumes.
Bootstrap SQL runs only on empty volumes. Changing a DB password in the environment
does not rotate the persisted password: use an owned-volume reset for this dev
stack. No real credentials, patient data or production backups belong here.

## Boundaries and access

No host ports are published. Services communicate on the Compose project network
`<project>_dev`; volumes are project-scoped. Every service including one-off smoke
containers carries `ao.session`. Dependencies use explicit resource limits and
no restart loop; inspect failures rather than repeatedly consuming host resources.
The network is not a production security boundary against a host/Docker admin.

| Service DNS | Internal endpoint | Local configuration |
| --- | --- | --- |
| postgres | 5432 / `tpa_dev` | `tpa_bootstrap`, `POSTGRES_PASSWORD` |
| redis | 6379 | Ephemeral cache, no authentication; network-only |
| s3 | 8333 | `S3_ACCESS_KEY`, `S3_SECRET_KEY`; authenticated S3 only |
| imgproxy | 8080 | Signed URLs; `IMGPROXY_KEY`/`IMGPROXY_SALT` hex; source allowlist |
| temporal-db | 5432 | `temporal` role; `temporal` and `temporal_visibility` DBs |
| temporal | 7233 | PostgreSQL persistence, default namespace, no dev-server shortcut |
| kafka | 9092 | KRaft broker/controller; plaintext, one replica, no production ACL claim |
| registry | 8080 | Apicurio v3 API, KafkaSQL durable storage |
| elasticsearch | 9200 | Basic authentication (`elastic`, `ELASTIC_PASSWORD`), no HTTP TLS |

`.env.example` contains public **dev-only placeholders**. Shell interpolation in
SeaweedFS bootstrap expects keys without JSON quotes/backslashes/newlines; use
simple alphanumeric local values. Its temporary credentials file is mode 600.
S3 has no anonymous identity; bucket/object anonymous denial is tested. Filer and
master ports stay unpublished; never expose them or mount real documents here.
Imgproxy reads only `s3://tpa-smoke/` for this synthetic spike. Future application
integration must define its own authorized source and signing policy.

PostgreSQL initialization enables extensions only. `tpa_bootstrap` is an
infrastructure bootstrap superuser, **not an application role**. Issue #4 owns
restricted application/migration roles, RLS/SET LOCAL, immutable audit and domain
schema. Temporal uses a separate PostgreSQL container, volume, role and DBs; it
cannot find a domain DB on its persistence server. Its SQL schemas are set up by
upstream auto-setup; its role is bootstrap-only too. Never reuse these roles in
application adapters. Elasticsearch is an authenticated synthetic projection,
not a business/financial source of truth. No money computation or domain state
changes are implemented here.

## Smoke and readiness

`up --wait` checks native service readiness (DB, Redis, S3 listener/master, Imgproxy,
Temporal cluster/default namespace, Kafka metadata, registry readiness, Elasticsearch yellow).
The smoke makes real SDK/HTTP calls after health; health alone is not connectivity
or domain acceptance. Failure exits nonzero. Unique synthetic marker IDs isolate
repeated runs. Smoke covers:

- PG16 extension versions, vector distance/trigram/SHA-256, exact NUMERIC Decimal,
  no public domain tables, and separate Temporal persistence/schema presence.
- Redis7 SET/GET/DEL with expiry.
- Generated solid-color HEIC, presigned S3 PUT/read, anonymous GET denied,
  signed Imgproxy WebP resize to 1200×600, bad signature denied, original unchanged.
- Apicurio JSON Schema registration/fetch, BACKWARD compatibility rule rejecting
  an incompatible version; client validation against fetched schema; Kafka
  idempotent producer acknowledgement and consumer round-trip/offset commit.
  Registry is not broker-side payload validation; future producers must enforce
  schema/serde policy. This spike uses JSON bytes, not a promised serde wire format.
- Authenticated Elasticsearch strict mapping/index/search and anonymous denial.
- Temporal Python SDK worker executing a deterministic echo workflow, then reading
  its persisted history. No business activity, replay upgrade or crash test claim.

Objects/topics/indexes/artifacts are removed after success (and in finally blocks
where possible); empty `tpa-smoke` bucket and completed workflow history remain.
History expires with default namespace retention; an owned-volume reset clears it.
Failed runs may leave synthetic state; inspect it or reset only your project.

**TC01–TC06 and PT01–PT24 are pending, not executed by this runner.** In particular,
this does not test audit immutability, RLS, outbox/inbox, payment, PII processing,
Temporal crash/replay, backup/restore or Kubernetes. Golden expectations and
approved specs remain unchanged. Helm/kind, observability, production TLS/ACLs,
restricted roles, KMS, HA, sizing, retention and restore drills belong to later
scoped deliverables and production gates.

## Versions, provenance and licenses

Image references in `compose.yaml` and the smoke Dockerfile pin actual registry
RepoDigests obtained by pulls on 2026-11-25. Tags remain visible for review; digest
is authoritative. Re-test the complete matrix before updating any pin. Upstream
release/tag and license sources below are evidence, not an assertion of production
suitability or legal approval. Distribution/dependency notices still apply.

| Component | Selected version | Upstream / license evidence |
| --- | --- | --- |
| PostgreSQL | 16.16 (domain image actual version checked by smoke) | [release/support](https://www.postgresql.org/support/versioning/), [PostgreSQL License](https://www.postgresql.org/about/licence/) |
| pgvector | 0.8.7, PG16 trixie image | [upstream Docker tags/extensions](https://github.com/pgvector/pgvector/tree/v0.8.7), [PostgreSQL-style license](https://github.com/pgvector/pgvector/blob/v0.8.7/LICENSE) |
| Redis | 7.4.12 alpine3.22 | [release source and RSALv2/SSPLv1 choice](https://github.com/redis/redis/blob/7.4.12/LICENSE.txt); not BSD/Apache |
| SeaweedFS community | 4.55 | [release](https://github.com/seaweedfs/seaweedfs/releases/tag/4.55), [Apache-2.0](https://github.com/seaweedfs/seaweedfs/blob/4.55/LICENSE), [S3 authentication](https://github.com/seaweedfs/seaweedfs/wiki/Amazon-S3-API) |
| Imgproxy | 4.0.25 | [release](https://github.com/imgproxy/imgproxy/releases/tag/v4.0.25), [Apache-2.0](https://github.com/imgproxy/imgproxy/blob/v4.0.25/LICENSE), [S3 options](https://docs.imgproxy.net/configuration/options), [signing](https://docs.imgproxy.net/usage/signing) |
| Temporal auto-setup | 1.29.7 | [published images](https://hub.docker.com/r/temporalio/auto-setup/tags), [PostgreSQL setup](https://github.com/temporalio/docker-builds/blob/main/docker-readme/auto-setup.md), [MIT server](https://github.com/temporalio/temporal/blob/v1.29.7/LICENSE) |
| Kafka | 4.4.0 | [official images](https://hub.docker.com/r/apache/kafka/tags), [Apache-2.0](https://github.com/apache/kafka/blob/4.4.0/LICENSE), [KRaft](https://kafka.apache.org/44/operations/kraft/) |
| Apicurio Registry | 3.3.5 | [release](https://github.com/Apicurio/apicurio-registry/releases/tag/3.3.5), [Apache-2.0](https://github.com/Apicurio/apicurio-registry/blob/3.3.5/LICENSE), [KafkaSQL Docker](https://www.apicur.io/registry/docs/apicurio-registry/3.2.x/getting-started/assembly-installing-registry-docker.html) |
| Elasticsearch | 9.5.7 | [release](https://github.com/elastic/elasticsearch/releases/tag/v9.5.7), [default distribution ELv2](https://www.elastic.co/licensing/elastic-license), [Docker](https://www.elastic.co/docs/deploy-manage/deploy/self-managed/install-elasticsearch-docker-basic) |
| Python smoke runtime | 3.12.16 slim-bookworm | [official image](https://hub.docker.com/_/python), [PSF license](https://docs.python.org/3/license.html) |

Temporal's newest server release 1.32.2 had **no auto-setup image** (actual pull:
`manifest unknown`). The selected published auto-setup is 1.29.7; `DB=postgres12`
is the upstream driver's name, not a requirement to run PostgreSQL 12. PostgreSQL
16 is verified through the persistence startup and workflow execution tests.

Smoke SDKs are pinned in `smoke/requirements.txt`: boto3 (Apache-2.0), psycopg
(LGPL-3.0-only), redis-py (MIT), confluent-kafka/librdkafka (Apache-2.0/BSD-2-Clause),
pillow-heif (BSD-3-Clause, libheif LGPL notices and HEVC codec/patent considerations),
Temporal Python SDK (MIT), Elasticsearch Python (Apache-2.0), jsonschema (MIT),
requests (Apache-2.0). Installed package license metadata was inspected in the
tested image using `importlib.metadata` on 2026-11-25. See the corresponding
[PyPI package metadata](https://pypi.org/) and each package's linked source license.
HEVC patent rights are jurisdiction/use dependent; successful decoding is not legal
clearance. The smoke image is a test tool, not an application dependency decision.
Apicurio artifact deletion is explicitly enabled for synthetic cleanup only
(`APICURIO_REST_DELETION_ARTIFACT_ENABLED`); its v3 API reports incompatible
schema versions as HTTP400 `RuleViolationException`.
SeaweedFS `master.toml` uses one-volume growth rather than the upstream default
of seven, with a four-volume cap and 256 MiB target size; anonymous telemetry is
disabled. Kafka persists at the image-provided non-root-owned `/var/lib/kafka/data`.

## Validation record

Local host inspected before startup: Docker 28.4.0, Compose 2.39.4, Linux amd64,
20 logical CPUs, 11 GiB total / about 6 GiB available RAM, 862 GiB free disk;
`vm.max_map_count=1048576` already set. Existing workloads/ports left untouched.
No host settings changed. Stack memory limits total about 4.2 GiB plus 512 MiB
smoke; image build and other processes also need memory. CI uses a standard Ubuntu
runner, explicit limits and timeout, no sysctl changes, with owned-resource cleanup.

Scaffold checks: frozen install with Node24.22.3/pnpm10.34.9, typecheck, one unit,
three HTTP e2e, compiled-process smoke passed; forced local build also passed. Compose config validation and Python compile checks passed. Warm dependency smoke
and cold empty-volume startup/full smoke through the root `infra:down`, `infra:up`
and `infra:smoke` scripts passed on 2026-11-25. Actual runtime versions confirmed:
PostgreSQL16.16, vector0.8.7, pg_trgm1.6, pgcrypto1.3, Kafka4.4.0,
Apicurio3.3.5 (KafkaSQL), SeaweedFS4.55, Temporal server1.29.7, Elasticsearch9.5.7;
Imgproxy's real HEIC-to-WebP decode/resize and signing checks passed. The pinned SDK
matrix passed against these running servers. This is a compatibility smoke, not
upgrade/replay/production acceptance. Initial runtime failures (Kafka volume
ownership, localhost S3 probe, SeaweedFS allocation batch, registry readiness port,
registry rule status/deletion setting and repeated bucket creation) were fixed and
the cold run revalidated them. Only the owned project is removed after testing.

Exact-head GitHub CI and independent review are tracked on
[PR #10](https://github.com/HarryNguyen2111/ai-insurance-tpa/pull/10); local success
does not stand in for those gates. The parent #9/#2 integration is already on main;
this task's diff contains no scaffold changes.

## Troubleshooting

Use `docker compose ps -a`, `docker compose logs --tail=80 <service>` and
`docker stats --no-stream` for your project only. Exit 137/OOM, disk exhaustion,
blocked registry pulls and host-kernel bootstrap failures are real blockers; do
not disable checks or modify host limits to hide them. On readiness timeout,
inspect service logs before retrying. Kafka/registry and Temporal schema startup
may take minutes on a cold runner. With persistent data, wait for schemas and
registry replay before running smoke. For upgrades, retain old pins, take only
synthetic backups, reset owned volumes if schema compatibility requires it, and
rerun the full smoke. Production upgrades need a separately approved plan.
