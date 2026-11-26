from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from tpa_ai_worker.app import create_app
from tpa_ai_worker.config import Limits

PREPROCESS_URL = "/internal/v1/images/preprocess"


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(create_app(Limits())) as c:
        yield c


@pytest.fixture
def small_client() -> Iterator[TestClient]:
    """Client with tight limits so limit tests stay fast."""
    with TestClient(create_app(Limits(max_bytes=64 * 1024, max_pixels=1_000_000))) as c:
        yield c
