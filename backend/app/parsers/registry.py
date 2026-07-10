"""
Parser registry — scans the parsers package at import time.

Iterates over all *.py files in this package (excluding base, registry,
detector) and imports them. The import triggers __init_subclass__ on
LogParser, which populates REGISTERED_PARSERS automatically.

Nothing in this file or anywhere else needs to be edited when adding a
new parser — just drop a new .py file in this directory.
"""

import importlib
import pkgutil
import sys
from pathlib import Path

# Re-export for convenience.
from app.parsers.base import REGISTERED_PARSERS, LogParser  # noqa: F401

_SKIP = {"base", "registry", "detector", "__init__"}

_package_path = Path(__file__).parent
_package_name = __name__.rsplit(".", 1)[0]  # "app.parsers"


def _discover_parsers() -> None:
    """Import every parser module in this package."""
    for finder, module_name, _is_pkg in pkgutil.iter_modules([str(_package_path)]):
        if module_name in _SKIP:
            continue
        full_name = f"{_package_name}.{module_name}"
        if full_name not in sys.modules:
            importlib.import_module(full_name)


_discover_parsers()
