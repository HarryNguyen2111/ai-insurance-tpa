from __future__ import annotations

from fastapi.testclient import TestClient


def test_health(client: TestClient) -> None:
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "service": "tpa-ai-worker", "version": "0.1.0"}


def test_interactive_docs_disabled(client: TestClient) -> None:
    assert client.get("/docs").status_code == 404
    assert client.get("/redoc").status_code == 404


def test_preprocess_route_is_internal_and_post_only(client: TestClient) -> None:
    paths = client.get("/openapi.json").json()["paths"]
    assert set(paths) == {"/health", "/internal/v1/images/preprocess"}
    assert set(paths["/internal/v1/images/preprocess"]) == {"post"}
