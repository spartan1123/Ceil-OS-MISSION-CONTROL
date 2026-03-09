from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any


class CouncilArtifactStore:
    """Best-effort artifact persistence for council run outputs."""

    def __init__(self, base_path: str | Path) -> None:
        self.base_path = Path(base_path)
        self._lock = threading.Lock()

    def persist_artifact(self, run_id: str, artifact: dict[str, Any]) -> dict[str, Any]:
        payload = dict(artifact)
        payload["run_id"] = run_id

        try:
            with self._lock:
                self.base_path.mkdir(parents=True, exist_ok=True)
                file_path = self.base_path / f"{run_id}.json"
                file_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            return {
                "ok": True,
                "path": str(file_path),
            }
        except Exception as exc:  # pylint: disable=broad-except
            return {
                "ok": False,
                "error": str(exc),
                "path": str(self.base_path / f"{run_id}.json"),
            }
