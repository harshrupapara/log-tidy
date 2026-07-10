"""
LogParser ABC with automatic subclass registration.

Every concrete parser that subclasses LogParser is automatically added to
REGISTERED_PARSERS via __init_subclass__. Adding a new parser file is the
only step required — no editing of a master list, no manual registration.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import ClassVar

from app.core.models import LogRecord

# Module-level registry — populated automatically as subclasses are defined.
REGISTERED_PARSERS: list["LogParser"] = []


class LogParser(ABC):
    """
    Base class for all log format parsers.

    Subclass this, implement detect() and parse(), and the parser is
    automatically registered. See generic_fallback.py for a minimal example.
    """

    # Each subclass must set a human-readable name.
    name: ClassVar[str] = "base"

    def __init_subclass__(cls, **kwargs: object) -> None:
        super().__init_subclass__(**kwargs)
        # Skip abstract intermediaries (those that don't define `name` concretely).
        if not getattr(cls, "__abstractmethods__", None):
            try:
                instance = cls()
                REGISTERED_PARSERS.append(instance)
            except Exception:
                pass  # If instantiation fails, don't crash the whole app.

    @abstractmethod
    def detect(self, sample_lines: list[str]) -> float:
        """
        Return a confidence score 0.0–1.0 that this parser matches the input.
        Called with the first ~100 non-blank lines. Highest score wins.
        """
        ...

    @abstractmethod
    def parse(self, lines: list[str]) -> list[LogRecord]:
        """
        Parse the full line set into normalised LogRecords.
        Must never raise — worst case return a best-effort partial result.
        """
        ...
