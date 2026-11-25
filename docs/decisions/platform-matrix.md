# Platform matrix và các quyết định pilot — phần kỹ thuật #14

Ngày xác minh: 2026-11-25 (Asia/Bangkok). **Chưa nghiệm thu toàn bộ #14**: owner chưa cung cấp tải, budget, phê duyệt license/vị trí dữ liệu. [#1](https://github.com/HarryNguyen2111/ai-insurance-tpa/issues/1) chỉ theo dõi acceptance. Tài liệu này không thay đổi stack hay điều khoản trong AGENTS/specs.

## 1. Phạm vi bằng chứng theo revision

| Revision / nguồn | Đã kiểm chứng | Giới hạn |
| --- | --- | --- |
| Main nền `694276f78427898d8b9bb9d81fbfbfe4e0a95a15`, gồm [#9](https://github.com/HarryNguyen2111/ai-insurance-tpa/pull/9), [#10](https://github.com/HarryNguyen2111/ai-insurance-tpa/pull/10) | [Backend CI 45538093317](https://github.com/HarryNguyen2111/ai-insurance-tpa/actions/runs/45538093317) và [Compose 45538093444](https://github.com/HarryNguyen2111/ai-insurance-tpa/actions/runs/45538093444) SUCCESS tại đúng main SHA. Manifest/lockfile và code smoke được đọc trực tiếp. | Process health + dependency smoke tổng hợp; không phải nghiệm thu nghiệp vụ/pilot/production. |
| Candidate DB [#59](https://github.com/HarryNguyen2111/ai-insurance-tpa/pull/59), snapshot `db9448678ff891a64dc1c8eb586d6028e8016908` | [Backend CI 45539429453](https://github.com/HarryNguyen2111/ai-insurance-tpa/actions/runs/45539429453), [Compose 45539429451](https://github.com/HarryNguyen2111/ai-insurance-tpa/actions/runs/45539429451) SUCCESS. DB job chạy 7 kiểm tra migration/privilege/numeric. | Chưa tích hợp tại snapshot; chỉ PT01 role subset. Chưa có tenant tables/RLS, PII, audit hoặc domain client trong API. Head mới phải xác minh lại. |
| Contract [#60](https://github.com/HarryNguyen2111/ai-insurance-tpa/pull/60), candidate snapshot `74cbad8a09921b46af277301533278fabccbf89a` | [Backend CI 45539548206](https://github.com/HarryNguyen2111/ai-insurance-tpa/actions/runs/45539548206), [Compose 45539548408](https://github.com/HarryNguyen2111/ai-insurance-tpa/actions/runs/45539548408) SUCCESS. | Schema/types/fixtures, không endpoint/provider/auth/scanner implementation. Trạng thái main sau merge cập nhật ở ghi chú bên dưới. |

**Main hiện được xác minh:** #60 đã squash-merge thành `4a35e84fb488672609975a9ef724d0a1c53b5600`; [Backend CI 45542203448](https://github.com/HarryNguyen2111/ai-insurance-tpa/actions/runs/45542203448) và [Compose 45542203548](https://github.com/HarryNguyen2111/ai-insurance-tpa/actions/runs/45542203548) đều SUCCESS trên chính SHA này, được kiểm tra qua provider. #19 hoàn tất phần contract, endpoint/provider/business acceptance vẫn pending. #59 vẫn là candidate tại `13636bc73ad27bcad1dbaf5a0deee6fe28f2a98a` (đã tích hợp main mới vào nhánh riêng): [Backend CI 45542753282](https://github.com/HarryNguyen2111/ai-insurance-tpa/actions/runs/45542753282) và [Compose 45542753259](https://github.com/HarryNguyen2111/ai-insurance-tpa/actions/runs/45542753259) đều SUCCESS đúng head này, được kiểm tra qua provider. Manifest DB giữ nguyên các pin bên dưới. CI snapshot `db944…` là bằng chứng lịch sử; CI không thay native approval hoặc merge. Chưa có native approval được xác nhận cho head mới. Các bảng pin dưới đây giữ provenance của revision đã kiểm tra, không suy ra mọi PR đã được tích hợp hoặc được reviewer phê duyệt.

Nguồn pin: [root manifest](../../package.json), [core manifest](../../apps/core-api/package.json), [lockfile](../../pnpm-lock.yaml), [Compose](../../infra/compose/compose.yaml), [smoke requirements](../../infra/compose/smoke/requirements.txt), [Dockerfile](../../infra/compose/smoke/Dockerfile). Danh sách dưới là dependency trực tiếp/ranh giới compatibility; không thay SBOM/license inventory toàn bộ transitive packages và OS/codec trong image.

## 2. Runtime và toolchain có bằng chứng

Metadata registry chính thức được đọc đúng version; license text upstream hoặc LICENSE trong tarball được đối chiếu. Đây là phân loại kỹ thuật, chưa là kết luận pháp lý.

| Thành phần | Pin thực tế | License / nguồn chính thức | Compatibility đã chứng minh |
| --- | --- | --- | --- |
| Node | 24.22.3 | [MIT và third-party notices](https://github.com/nodejs/node/blob/v24.22.3/LICENSE) | Repo yêu cầu `>=24.22.3 <25`; CI scaffold dùng pin này. |
| pnpm / Turborepo | 10.34.9 / 2.11.13 | [pnpm MIT](https://github.com/pnpm/pnpm/blob/v10.34.9/LICENSE), [Turbo MIT](https://github.com/vercel/turborepo/blob/v2.11.13/LICENSE) | Frozen lockfile; [Turbo hỗ trợ pnpm 8+](https://turborepo.dev/docs/support-policy). |
| Nest common/core/platform-express/testing | 12.6.0 | [MIT](https://github.com/nestjs/nest/blob/v12.6.0/LICENSE), [core metadata](https://registry.npmjs.org/@nestjs/core/12.6.0) | Core Node >=20; rxjs ^7.1, reflect-metadata ^0.1.12 hoặc ^0.2.0; scaffold build/unit/HTTP/process smoke thực sự chạy. |
| Nest CLI / schematics | 12.0.15 / 12.0.13 | [CLI metadata](https://registry.npmjs.org/@nestjs/cli/12.0.15), [schematics metadata](https://registry.npmjs.org/@nestjs/schematics/12.0.13), MIT | CLI Node >=20.11; schematics Node ^22.22.3 hoặc ^24.15.0 hoặc >=26, TS >=6; Node24.22.3 + TS6.0.3 đáp ứng. |
| TypeScript / reflect-metadata / rxjs | 6.0.3 / 0.2.2 / 7.8.2 | Apache-2.0: [TS text](https://github.com/microsoft/TypeScript/blob/v6.0.3/LICENSE.txt), [reflect metadata/tarball](https://registry.npmjs.org/reflect-metadata/0.2.2), [rxjs metadata/tarball](https://registry.npmjs.org/rxjs/7.8.2) | Các pin core; không suy ra TS6 tương thích mọi generator. |
| Jest / ts-jest / Supertest | 30.5.2 / 29.4.15 / 7.3.2 | MIT, metadata/tarball LICENSE: [Jest](https://registry.npmjs.org/jest/30.5.2), [ts-jest](https://registry.npmjs.org/ts-jest/29.4.15), [Supertest](https://registry.npmjs.org/supertest/7.3.2) | ts-jest peer Jest ^29 hoặc ^30, TS >=4.3 <7. Test dùng upstream `--experimental-vm-modules`; không coi cảnh báo VM là lỗi. |
| Python (smoke, chưa phải AI worker) | 3.12.16 slim-bookworm | [PSF và notices](https://github.com/python/cpython/blob/v3.12.16/LICENSE) | Linux amd64 smoke image; không hứa mọi Python >=3.10 chạy được SDK mới. |

### Image dev: pin digest là nguồn định danh

Các digest dưới được sao lại từ main nền, không phải pull mới trong task #14. Bằng chứng chạy là Compose CI nêu trên và [validation record #3](../../infra/compose/README.md#validation-record).

| Image:tag | SHA-256 RepoDigest | License text / phạm vi |
| --- | --- | --- |
| `pgvector/pgvector:0.8.7-pg16-trixie` | `c28c0b700f3f1b5eec14082b31ad6e7c8a566d14386323609c615315e7c0ffc8` | [pgvector PostgreSQL-style](https://github.com/pgvector/pgvector/blob/v0.8.7/LICENSE); [PostgreSQL License](https://www.postgresql.org/about/licence/). Runtime record: PG16.16, vector0.8.7, pg_trgm1.6, pgcrypto1.3. |
| `postgres:16.16-bookworm` | `cd0e9518bda5f2ea667ff84d22795d089720c883f288e215d97ce57437e8ef37` | PostgreSQL License; Temporal persistence riêng, không dùng DB/role nghiệp vụ. |
| `redis:7.4.12-alpine3.22` | `7f7d30b7fdd09467bac58198a1f166dd69789d348d4fe859cccb20e0cf287fbe` | [RSALv2 hoặc SSPLv1](https://github.com/redis/redis/blob/7.4.12/LICENSE.txt); không BSD/Apache, không áp license Redis8 cho pin7.4. |
| `chrislusf/seaweedfs:4.55` | `7ca46aeae2f223b37e5d91593c17ab37738eec6df6ab69b48a0487f7643342b9` | [Apache-2.0](https://github.com/seaweedfs/seaweedfs/blob/4.55/LICENSE). S3-compatible dev đã tích hợp; không phải quyết định chọn storage production, không phải MinIO đã chạy. |
| `ghcr.io/imgproxy/imgproxy:v4.0.25` | `cad8bfc8031d75efaeab622454f62a3e10dd1fe3a21056d40ab67aed812388cb` | [Apache-2.0 source](https://github.com/imgproxy/imgproxy/blob/v4.0.25/LICENSE); cần inventory codec/OS binary riêng trước phân phối. |
| `temporalio/auto-setup:1.29.7` | `f14912b699cf73015ad5c4fc18d522d4b014db90e794039214dfb7c022c2644f` | [MIT server](https://github.com/temporalio/temporal/blob/v1.29.7/LICENSE); [auto-setup upstream](https://github.com/temporalio/docker-builds/blob/main/docker-readme/auto-setup.md), chỉ dev. |
| `apache/kafka:4.4.0` | `833b867a9585a141da455dc2b57431c65cbccb27f11c91f694444cca9f777e0f` | [Apache-2.0](https://github.com/apache/kafka/blob/4.4.0/LICENSE); single-node KRaft, plaintext, không HA/ACL production. |
| `apicurio/apicurio-registry:3.3.5` | `8d34d381de75264c3a56389e5a457cafb566b9a7b994c5308e5951114aeeffc0` | [Apache-2.0](https://github.com/Apicurio/apicurio-registry/blob/3.3.5/LICENSE); KafkaSQL, API v3, không phải Confluent Schema Registry đã triển khai. |
| `docker.elastic.co/elasticsearch/elasticsearch:9.5.7` | `8aa3b18f6a26880f4c2fa1ffb37a48213e201b0b6a1a47412c66b1f5d533de91` | Default distribution [ELv2](https://www.elastic.co/licensing/elastic-license); [source license matrix](https://github.com/elastic/elasticsearch/blob/v9.5.7/LICENSE.txt) khác binary distribution. Không mặc định DLS hoặc mọi feature miễn phí. |
| `python:3.12.16-slim-bookworm` | `44cf1793efa7c7a476bb0f2cff81443f4a072c90c1cb127e2924933daa3e8c64` | PSF + image/OS/dependency notices; test tool, không image AI worker production. |

### Smoke SDK ↔ server: đã chạy nhưng phạm vi hẹp

| SDK pin / license | Đối tác và kết quả từ #3 | Nguồn upstream / điều chưa chứng minh |
| --- | --- | --- |
| psycopg + psycopg-binary 3.3.9, LGPL-3.0-only | PG16.16: extension query, Decimal NUMERIC và persistence DB riêng | [metadata](https://pypi.org/pypi/psycopg/3.3.9/json), [license](https://github.com/psycopg/psycopg/blob/3.3.9/LICENSE.txt); không RLS/domain migration. |
| redis-py 8.2.0, MIT | Redis7.4.12 SET/GET/DEL TTL | [metadata](https://pypi.org/pypi/redis/8.2.0/json), [text](https://github.com/redis/redis-py/blob/v8.2.0/LICENSE); SDK major không phải server major. |
| boto3 + botocore 1.44.11, Apache-2.0 | SeaweedFS4.55 presigned PUT/GET, anonymous denial | [metadata](https://pypi.org/pypi/boto3/1.44.11/json), [text](https://github.com/boto/boto3/blob/1.44.11/LICENSE); không S3 Object Lock/retention/production IAM coverage. |
| temporalio Python 1.37.0, MIT | Server1.29.7 + PG16: echo workflow và history persist | [metadata](https://pypi.org/pypi/temporalio/1.37.0/json), [text](https://github.com/temporalio/sdk-python/blob/1.37.0/LICENSE); SDK đòi Python >=3.11. Không TypeScript worker, replay upgrade, crash hoặc human command. `postgres12` là tên driver cấu hình, không phiên bản DB thực tế. |
| confluent-kafka 2.16.2, Apache-2.0 source; librdkafka có notices riêng | Kafka4.4.0 produce ack/consume/offset + Apicurio3.3.5 HTTP register/fetch/BACKWARD reject | [release package và LICENSE](https://pypi.org/pypi/confluent-kafka/2.16.2/json). JSON bytes được client validate, chưa chọn serde wire format, chưa test outbox/inbox/crash/TS client. Không suy từ license wrapper sang mọi thư viện binary. |
| elasticsearch Python 9.5.1, Apache-2.0 | ES9.5.7 strict mapping/index/search, auth và anonymous denial | [text](https://github.com/elastic/elasticsearch-py/blob/v9.5.1/LICENSE), [official compatibility](https://www.elastic.co/docs/reference/elasticsearch/clients/python#compatibility); không TS client hoặc tenant search safety. |
| Pillow13.0.0 MIT-CMU + pillow-heif1.9.0 | Ảnh HEIC tổng hợp → S3 → signed Imgproxy4.0.25 WebP1200×600; chữ ký sai bị chặn, bản gốc không đổi | [Pillow metadata](https://pypi.org/pypi/pillow/13.0.0/json), [pillow-heif release/files](https://pypi.org/pypi/pillow-heif/1.9.0/json). Source BSD-3-Clause **không đủ mô tả wheel**; xem quyết định license bên dưới. Chưa kiểm watermark/quyền từng object. |
| jsonschema4.26.0 MIT / requests2.34.2 Apache-2.0 | Schema fetched từ registry và HTTP smoke | [jsonschema release](https://pypi.org/pypi/jsonschema/4.26.0/json), [requests release](https://pypi.org/pypi/requests/2.34.2/json); các SDK phụ/transitive còn lại pin trong requirements, không là application selection. |

**HEIC license finding:** Đã đọc sdist và wheel `pillow_heif-1.9.0-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl` từ release chính thức. File `pillow_heif-1.9.0.dist-info/licenses/LICENSES_bundled.txt` ghi wheel GPLv2; liệt kê libheif1.23.7 LGPLv3, libde2651.1.3 LGPLv3 và x2654.3 GPLv2. [Wheel chính thức](https://files.pythonhosted.org/packages/f7/65/e97b795e5c4de189ac5765b6ebbf79c3c8a4a9489ebe7bc404ca07e03b46/pillow_heif-1.9.0-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl), [libheif licensing](https://github.com/strukturag/libheif/blob/v1.23.7/COPYING). Không suy ra binary Imgproxy có cùng codec graph. Owner/legal phải đánh giá notices, phân phối/linking và HEVC patent rights theo cách dùng/vị trí dữ liệu; smoke thành công không cấp quyền pháp lý.

## 3. Tooling của #59/#60, không đồng nhất với domain runtime

| Revision | Pin / license đã xác minh | Compatibility và trạng thái |
| --- | --- | --- |
| #59 snapshot ở trên | [drizzle-orm0.45.4 Apache-2.0](https://registry.npmjs.org/drizzle-orm/0.45.4), [drizzle-kit0.31.11 MIT](https://registry.npmjs.org/drizzle-kit/0.31.11), [pg8.23.1 MIT](https://registry.npmjs.org/pg/8.23.1); @types/pg8.23.1, TS6.0.3 | ORM peer pg >=8; tested PG16 extension image ở trên. npm tarballs ORM/Kit không có LICENSE root trong lần kiểm tra; [ORM source text đúng tag0.45.4](https://github.com/drizzle-team/drizzle-orm/blob/0.45.4/LICENSE) xác nhận Apache-2.0. Kit MIT đã xác minh qua metadata; source-text provenance riêng Kit cần bổ sung trước owner license sign-off. Chỉ harness schema rỗng và least-privilege roles, không claim toàn bộ DB-02/DB-03. |
| #60 contract package | [openapi-typescript7.13.0](https://registry.npmjs.org/openapi-typescript/7.13.0), [Redocly CLI2.83.0](https://registry.npmjs.org/@redocly/cli/2.83.0), [converter5.1.1](https://registry.npmjs.org/@openapi-contrib/openapi-schema-to-json-schema/5.1.1), [Swagger Parser13.1.0](https://registry.npmjs.org/@apidevtools/swagger-parser/13.1.0): MIT | openapi-typescript peer TS ^5.x, package dùng TS5.9.3 (Apache-2.0), core giữ TS6.0.3. Parser Node >=22.19, pin24 đáp ứng. Không tuyên bố TS6 generator compatibility. |
| #60 runtime schema validation | [Ajv8.20.0](https://registry.npmjs.org/ajv/8.20.0), [ajv-draft-04 1.0.0](https://registry.npmjs.org/ajv-draft-04/1.0.0), [ajv-formats3.0.1](https://registry.npmjs.org/ajv-formats/3.0.1): MIT; [yaml2.9.1](https://registry.npmjs.org/yaml/2.9.1): ISC; @types/node24.10.1 | Converter phát draft-04, cần upstream Ajv draft-04. Tarball LICENSE của các công cụ contract đã đọc. Fixture PT15/PT16/PT22 và TC04 warning-shape không phải chạy scenario/engine. |

### Lifecycle và gate nâng cấp

- [Node schedule](https://github.com/nodejs/Release/blob/main/schedule.json): Node24 Maintenance LTS từ 2026-10-20, EOL 2028-04-30; không dùng Node20 mặc định shell để chứng minh pin24.
- [PostgreSQL policy](https://www.postgresql.org/support/versioning/): PG16 được hỗ trợ tới 2028-11-09, minor hiện tại tại ngày kiểm tra là16.16. [Python status](https://devguide.python.org/versions/): 3.12 security-only, EOL2028-10; yêu cầu specs “3.10+” không đồng nghĩa nên chọn 3.10 đã EOL cho triển khai mới.
- [Redis license policy](https://redis.io/legal/licenses/) và [Elastic lifecycle](https://www.elastic.co/support/eol) là nguồn cần kiểm tra lại khi chốt production. Chưa xác nhận hợp đồng support/EOL riêng cho pin Redis7.4.12/ES9.5.7; không tự tính từ release tag.
- Với Nest/pnpm/TS/Drizzle, pgvector, SeaweedFS, Imgproxy, Temporal self-hosted, Kafka, Apicurio và các smoke SDK: kiểm tra release/license/engine ở trên không cung cấp cam kết maintenance dài hạn cho từng patch. Trạng thái **support contract/EOL chưa xác nhận**; owner vận hành phải chỉ định người theo dõi security/release và kế hoạch upgrade. Không đồng nhất community release với SLA thương mại.
- Mỗi thay pin cần version matrix mới, lock/digest, license/SBOM review, build + compatibility suite; DB expand/contract, Temporal replay/versioning, Kafka schema/rebalance, ES snapshot/rebuild/alias rollback và restore drill tương ứng. Đây là gate dự kiến, task này không chạy upgrade.

## 4. Bắt buộc nhưng chưa chọn pin / chưa thử tích hợp

| Thành phần | Trạng thái và bằng chứng còn thiếu | Child phụ trách |
| --- | --- | --- |
| Temporal TypeScript SDK + IWorkflowEngine / event worker | Chưa pin/triển khai; Python smoke không thay TS SDK-server/replay/crash acceptance. | [#25](https://github.com/HarryNguyen2111/ai-insurance-tpa/issues/25), #38 |
| Kafka TypeScript client / serde / registry client | Chưa chọn SDK/version/license/wire format; cần SDK-broker4.4/registry3.3 integration, outbox/inbox và compatibility CI. | [#23](https://github.com/HarryNguyen2111/ai-insurance-tpa/issues/23), #24 |
| Elasticsearch TypeScript client | Chưa pin; cần official client-server matrix, tenant negatives, rebuild. | [#47](https://github.com/HarryNguyen2111/ai-insurance-tpa/issues/47), #48 |
| Kubernetes/kind/Helm/charts/operators/Argo CD | Bắt buộc theo specs06; chưa chọn version/chart/operator/license/support matrix hay chạy kind. Không đoán operator cho PG/Kafka/ES/Temporal. | [#53](https://github.com/HarryNguyen2111/ai-insurance-tpa/issues/53), #54 |
| OTel/Collector/Prometheus/Grafana/Loki/tracing backend | Chưa pin/chart/test; phải xét license theo đúng distribution/plugin, retention, PII và resource overhead. | [#55](https://github.com/HarryNguyen2111/ai-insurance-tpa/issues/55) |
| FastAPI/OpenCV/pyzbar/lxml/AI worker, decimal.js domain | Specs yêu cầu, chưa là dependency/runtime main nền. Chưa chọn pin hay nghiệm thu TC01–TC06. | #28–#33 |
| Next.js/React/Tailwind/Ant Design hoặc Shadcn, Vite/zmp-sdk | Chưa có frontend/pin/bundle measurement hoặc SDK-platform contract đã thử. | #49–#52 |
| OIDC/MFA, KMS/secret manager | Provider, region, assurance/rotation/revocation/backup-key policy chưa chốt; không tự làm identity server. | [#12](https://github.com/HarryNguyen2111/ai-insurance-tpa/issues/12), #21, #17, #54 |
| Viettel/Qwen3-VL, Zalo identity/OTP/ZNS, tax source, bank | Chưa có versioned provider contract/credentials/sandbox evidence; tên model/API trong spec không chứng minh capability/license/data rights. Không gọi foreign AI hoặc dùng dữ liệu thật. | [#13](https://github.com/HarryNguyen2111/ai-insurance-tpa/issues/13), #29–#30, #41, #46 |
| Production storage / MinIO / managed services | SeaweedFS dev đã thử; vendor, HA, location, retention/Object Lock/KMS/support/license chưa được chọn/duyệt. | #11–#14, #26, #54, #57 |

## 5. Pilot inputs và quyết định còn mở

Tất cả giá trị pilot dưới đây là **CHƯA CUNG CẤP**. Vai trò owner là đề nghị để phân công, không phải người đã chấp thuận. Không thay giá trị trống bằng mặc định dev hay technical limit của API.

| Input cần owner cung cấp | Đơn vị / cách xác định | Người cần quyết định / liên kết |
| --- | --- | --- |
| DNBH/plan, số tenant, mix nghiệp vụ | Tenant/plan được duyệt, quyền hợp đồng/dataset, ngày pilot | Business/legal, [#11](https://github.com/HarryNguyen2111/ai-insurance-tpa/issues/11) |
| Claims/ngày, giờ hoạt động, peak/burst, concurrent users | Arrival profile theo thời gian, thao tác/user, tenant skew; không lấy trung bình thay peak | Business/operations, #11/#14 |
| Trang/claim, documents/claim, file sizes/types | Distribution p50/p95/max; HEIC/XML/PDF mix, compressed/decompressed bytes/pages | Business/security, #11/#26/#28 |
| Retention/legal hold/delete | Thời hạn riêng cho original/derived/DB/audit/history/event/index/backup; location/subprocessor | Legal/security, #11/#12/#13 |
| AI latency và extraction quality | Theo trang/claim/model/prompt, p50/p95/p99, timeout/retry rate, allowed labelled corpus | AI/provider owner, #11/#13/#30 |
| Provider quotas/fees | Requests/tokens/pages/OTP/payout/egress, currency, tax, dated quote và sandbox access qua secret manager | Procurement/provider owner, #12/#13 |
| Availability/RPO/RTO và recovery window | Phạm vi dịch vụ, maintenance, failure model, đo restore có chứng cứ | Operations/business, #14/#57/#58 |
| Budget/ceiling/alerts và support | Monthly + one-off, dự phòng, license/support/labor, người approve và ngày hết hạn quote | Owner/procurement/legal, #14 cùng #11–#13 |

**Local capacity #3 ≠ pilot capacity:** [record #3](../../infra/compose/README.md#validation-record) ghi host20 logical CPUs, RAM11GiB/~6GiB available, disk862GiB free; giới hạn stack ~4.2GiB + smoke512MiB, khuyến nghị ~5GiB available. Đó là quan sát một lần trên dữ liệu tổng hợp và single-node; không phải working-set sizing, throughput, HA, bill, SLA hay benchmark tải pilot. Task #14 không khởi động lại stack hoặc đo thêm capacity.

### Recipe benchmark (chưa thực thi)

1. Owner phê duyệt inputs/dataset/location và sandbox ở #11–#13; dùng synthetic fixtures trước. Ghi commit, OS/CPU/RAM/disk/network, image digests, SDK/chart pins, limits/replicas, dataset seed/hash, tool/version, topology, concurrency/arrival schedule. Không chứa PII/keys/signed URLs trong báo cáo.
2. Sau khi child runtime có runner: cold start riêng, warm-up riêng; chạy các mức tải từ arrival profile được duyệt, steady-state/soak/burst và dependency-outage có thời lượng/sample count được chốt trước. Dùng công cụ upstream load test được chọn trong #56, không viết scheduler/platform riêng. Tách API acceptance latency, async queue wait và end-to-end completion; ghi errors/timeouts/retries, không loại bỏ failed samples khỏi denominator.
3. Định nghĩa API latency = nhận request → response; preflight fast và pending/deep là hai population riêng. Throughput = successful committed unique operations/elapsed second; duplicate retries được đếm riêng. AI = queue wait, inference duration và completed pages/claim; p50/p95/p99 theo histogram và sample count. Search freshness = source DB commit → version searchable, tính cả backlog/gap. Concurrency = in-flight operations, không đồng nhất users với requests/s.
4. Ghi CPU throttling, RSS/working set/peak, disk IOPS/latency/growth, network/egress, DB connections/locks/reservation contention, Kafka lag/outbox age, Temporal queue/history growth, ES indexing/search/merge; đo derivative/original compression ratio và retention growth. Dự báo bytes/day từ measured bytes/claim × approved claims/day; thêm replicas/indexes/backups theo topology đã chọn, không chỉ cộng limit Compose.
5. Sandbox payment chỉ dùng synthetic amount/payee; fault injection timeout/callback lặp, restart/replay/rebuild và restore ở #56/#57. RPO = khoảng committed data mất sau restore; RTO = từ mốc incident được định nghĩa đến phục hồi đúng nghiệp vụ; kiểm chứng dedup/reconciliation, không chỉ process health.
6. Tính chi phí từ measured usage và báo giá có ngày: compute/storage/replication/backup/egress/AI/OTP/bank/license/support/on-call, currency/tax và sensitivity theo tải/retention/retry. Cost/claim ghi denominator completed claims và chi phí failed/retried work. Owner ký budget/headroom/alerts sau kết quả; chưa có số tiền/capacity được đề xuất là đã đủ.

Mục tiêu specs06 (API99.9%/tháng, fast preflight p95≤3s, search p95≤10s, DB RPO≤5phút/RTO≤60phút) chỉ là **mục tiêu cần thử**, chưa là SLA owner ký hoặc kết quả đạt được.

### Review questions / owner gate

- #11: Ai chịu trách nhiệm hợp đồng/claims/finance/legal/security/operations, dataset và guardian authority? Retention/location/legal hold nào được phép?
- #12: Issuer/MFA assurance và KMS nào, region/rotation/revocation/decrypt privileges/restore keys do ai quản lý? Sandbox nào được phép truy cập?
- #13: Provider contract/version/quotas, dữ liệu được phép gửi, bank idempotency/query/callback semantics và Viettel/Zalo/tax evidence ở đâu?
- #14: Owner chọn license option Redis, cách dùng Elastic, HEIC binary/patent obligations, image notices/SBOM và support contract thế nào? Ai chấp thuận sizing, budget và ngưỡng cảnh báo sau đo?

Không tự điền tên người duyệt, credentials hoặc legal approval. Các câu hỏi trên chặn **final acceptance #14**, không chặn việc review tài liệu kỹ thuật. [Threat model](../security/threat-model.md) gắn rủi ro với task và test dự kiến.
