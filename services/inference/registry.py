"""
registry.py - pluggable analysis backends.

Three tasks are served, each by exactly one ACTIVE backend at a time:

    defects    bytes  -> {backend, image_size, findings[], coverage}
    stage      image, element_type -> {stage, fraction, evidence, ...}
    inventory  image, scale_m_per_px -> {items[]}

Built-in backends: opencv_tiles (defects), classical_color (stage, inventory), yolo_world (all three,
needs weights). A trained model is added WITHOUT touching the rest of the system by dropping one
Python module into services/inference/plugins/ (see docs/model-integration.md and
plugins/_template.py). Backends are never switched silently: the active one per task comes from
models/active.json or the environment (BACKEND_DEFECTS / BACKEND_STAGE / BACKEND_INVENTORY), and a
request may name one explicitly with ?backend=<name> (used for evaluation and A/B comparison).

Every response is stamped with `model: {backend, version, weights_sha256, ...}` and the API stores
that with each analysis run, so any figure on a dashboard can be traced to the model that produced it.
"""

from __future__ import annotations

import hashlib
import importlib
import json
import os
import pkgutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, Optional

TASKS = ("defects", "stage", "inventory")
HERE = Path(__file__).parent
ACTIVE_FILE = HERE / "models" / "active.json"
DEFAULTS = {"defects": "opencv_tiles", "stage": "classical_color", "inventory": "classical_color"}


@dataclass
class Backend:
    name: str
    version: str
    tasks: Dict[str, Callable]                         # task name -> callable (signatures in the module docstring)
    available: Callable[[], bool] = lambda: True       # False when weights/dependencies are missing
    info: Callable[[], dict] = lambda: {}              # e.g. {"weights_sha256": ..., "trained_on": ..., "metrics": {...}}
    reliability: str = "unvalidated"                   # "demo" | "unvalidated" | "validated"
    source: str = "builtin"                            # "builtin" | "plugin"


_BACKENDS: Dict[str, Backend] = {}
_loaded = False


def register(backend: Backend) -> None:
    bad = [t for t in backend.tasks if t not in TASKS]
    if bad:
        raise ValueError(f"backend '{backend.name}' declares unknown tasks {bad}; allowed: {TASKS}")
    _BACKENDS[backend.name] = backend


def file_sha256(path) -> Optional[str]:
    p = Path(path)
    if not p.exists():
        return None
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _load_builtins() -> None:
    import pipeline
    import scene
    import yolo_scene

    register(Backend(
        "opencv_tiles", "1", {"defects": lambda data, min_violation, conf: pipeline.analyze_defects(data, "opencv_tiles", min_violation, conf)},
        reliability="demo"))
    register(Backend(
        "classical_color", "1", {"stage": scene.analyze_stage, "inventory": scene.estimate_inventory}, reliability="demo"))
    register(Backend(
        "yolo_world", "zero-shot",
        {"stage": yolo_scene.analyze_stage, "inventory": yolo_scene.estimate_inventory,
         "defects": lambda data, min_violation, conf: pipeline.analyze_defects(data, "yolo_world", min_violation, conf)},
        available=yolo_scene.available, info=lambda: {"weights_sha256": file_sha256(yolo_scene.WEIGHTS)}))


def _load_plugins() -> None:
    plugins_dir = HERE / "plugins"
    if not plugins_dir.exists():
        return
    for m in pkgutil.iter_modules([str(plugins_dir)]):
        if m.name.startswith("_"):
            continue
        mod = importlib.import_module(f"plugins.{m.name}")
        backend = getattr(mod, "BACKEND", None)
        if not isinstance(backend, Backend):
            raise RuntimeError(f"plugin '{m.name}' must define BACKEND = registry.Backend(...)")
        backend.source = "plugin"
        register(backend)


def load() -> None:
    global _loaded
    if _loaded:
        return
    _load_builtins()
    _load_plugins()
    _loaded = True


def reload() -> None:
    """Re-scan plugins (used by tests)."""
    global _loaded
    _BACKENDS.clear()
    _loaded = False
    load()


def configured(task: str) -> str:
    """Name of the backend configured for a task: environment, then models/active.json, then the default."""
    env = os.environ.get(f"BACKEND_{task.upper()}")
    if env:
        return env
    if ACTIVE_FILE.exists():
        try:
            name = json.loads(ACTIVE_FILE.read_text(encoding="utf-8")).get(task)
            if name:
                return name
        except (ValueError, OSError):
            pass
    return DEFAULTS[task]


class BackendUnavailable(LookupError):
    """Requested backend is unknown, does not serve the task, or is missing its weights."""


def resolve(task: str, requested: str = "auto"):
    """Return (callable, model_stamp) for a task. Raises BackendUnavailable with a precise reason."""
    load()
    if task not in TASKS:
        raise ValueError(f"unknown task '{task}'")
    name = configured(task) if requested in ("auto", "", None) else requested
    b = _BACKENDS.get(name)
    if b is None:
        raise BackendUnavailable(f"no backend named '{name}' (known: {sorted(_BACKENDS)})")
    if task not in b.tasks:
        raise BackendUnavailable(f"backend '{name}' does not serve '{task}'")
    if not b.available():
        raise BackendUnavailable(f"backend '{name}' is not available (missing weights or dependencies)")
    stamp = {"backend": b.name, "version": b.version, "source": b.source, "reliability": b.reliability, **b.info()}
    return b.tasks[task], stamp


def describe() -> dict:
    load()
    return {
        "active": {t: configured(t) for t in TASKS},
        "backends": [
            {"name": b.name, "version": b.version, "tasks": sorted(b.tasks), "available": bool(b.available()),
             "source": b.source, "reliability": b.reliability}
            for b in _BACKENDS.values()
        ],
    }
