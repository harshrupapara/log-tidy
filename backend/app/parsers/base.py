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
    def parse(
        self,
        lines: list[str],
        context: Optional[dict] = None,
    ) -> list[LogRecord]:
        """
        Parse the full line set into normalised LogRecords.
        Must never raise — worst case return a best-effort partial result.
        """
        ...


import re
from datetime import datetime, date, time


def extract_date_from_filename(filename: Optional[str]) -> Optional[date]:
    if not filename:
        return None
    # 1. Look for 8 consecutive digits (YYYYMMDD)
    for match in re.finditer(r'(?<!\d)(\d{8})(?!\d)', filename):
        ds = match.group(1)
        try:
            return datetime.strptime(ds, "%Y%m%d").date()
        except ValueError:
            pass

    # 2. Look for YYYY-MM-DD or YYYY_MM_DD or YYYY.MM.DD
    match = re.search(r'(?<!\d)(\d{4})[-_.](\d{2})[-_.](\d{2})(?!\d)', filename)
    if match:
        try:
            return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
        except ValueError:
            pass

    # 3. Look for IIS exYYMMDD format (e.g. ex250218.log)
    match = re.search(r'\bex(\d{6})\b', filename, re.IGNORECASE)
    if match:
        ds = match.group(1)
        try:
            return datetime.strptime("20" + ds, "%Y%m%d").date()
        except ValueError:
            pass

    return None

def parse_time_with_fallback(time_str: str, fallback_date: Optional[date]) -> Optional[datetime]:
    if not fallback_date or not time_str:
        return None
    clean = time_str.strip().replace(',', '.')
    for fmt in ("%H:%M:%S.%f", "%H:%M:%S"):
        try:
            t_obj = datetime.strptime(clean, fmt)
            return datetime.combine(fallback_date, t_obj.time())
        except ValueError:
            continue
    return None


