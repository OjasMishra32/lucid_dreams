"""Every test starts with no private data root and no private config in the environment (a developer's own shell may set them)."""

import pytest


@pytest.fixture(autouse=True)
def _no_private_environment(monkeypatch):
    monkeypatch.delenv("COURT_DATA", raising=False)
    monkeypatch.delenv("COURT_BAKE_CONFIG", raising=False)
