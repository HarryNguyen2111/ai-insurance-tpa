# P1-01 — Kubernetes, Kafka, Elasticsearch và Temporal nền tảng
- Tham chiếu 06–08; triển khai full-stack Compose + kind/Helm và overlays/values staging/prod.
- Tạo `infra/compose`, `infra/helm/mps`, `infra/gitops`, CI, dashboards/runbooks; không secret thật, không image latest.
- Separate DB/role cho Temporal, KRaft + schema registry/ACL, Elasticsearch private index security, PVC/storage/backup policies; production topology khác dev.
- OTel/Prometheus/Grafana/log redaction, workload identity/KMS, ingress TLS/RBAC/NetworkPolicy, probes/limits/PDB/HPA phù hợp.
- DoD: lint/render/schema validation, smoke trên kind; restart/failure recovery; version compatibility và capacity report; không đánh dấu production-ready trước restore/security/load gates.
