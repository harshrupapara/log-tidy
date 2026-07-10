"""
Generic Fallback Log Parser.

Last resort — must NEVER fail to produce output.

Strategy:
  1. Try a battery of common timestamp regexes at the start of each line.
  2. Whatever remains after stripping the timestamp is the message.
  3. No level extraction attempted (level=None).
  4. Worst case: timestamp=None, message=full raw line.

This parser registers itself with the lowest possible confidence (0.1) so it
only wins if no other parser exceeds the detection threshold.

--- HOW TO ADD A NEW PARSER ---
Copy this file to backend/app/parsers/my_format.py.
1. Give your class a unique `name = "my_format"`.
2. Implement detect() → return 0.0–1.0 confidence.
3. Implement parse() → return list[LogRecord].
That's it. The registry discovers it automatically on startup.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Optional

from app.core.models import LogRecord
from app.parsers.base import LogParser

# Ordered list of (compiled_regex, strptime_format) pairs.
# The regex must capture the timestamp in group 1.
_TIMESTAMP_PATTERNS: list[tuple[re.Pattern, str]] = [
    # ISO 8601 with optional fractional seconds and timezone: 2026-07-08T12:34:56.789Z
    (
        re.compile(
            r"^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)"
        ),
        "",  # handled specially via fromisoformat
    ),
    # Apache Common Log Format: 08/Jul/2026:12:34:56 +0000
    (
        re.compile(r"^(\d{2}/[A-Za-z]{3}/\d{4}:\d{2}:\d{2}:\d{2}\s*[+-]\d{4})"),
        "%d/%b/%Y:%H:%M:%S %z",
    ),
    # MM/dd/yyyy HH:mm:ss
    (
        re.compile(r"^(\d{1,2}/\d{1,2}/\d{4}\s+\d{2}:\d{2}:\d{2})"),
        "%m/%d/%Y %H:%M:%S",
    ),
    # dd-MMM-yyyy HH:mm:ss (e.g. 08-Jul-2026 12:34:56)
    (
        re.compile(r"^(\d{2}-[A-Za-z]{3}-\d{4}\s+\d{2}:\d{2}:\d{2})"),
        "%d-%b-%Y %H:%M:%S",
    ),
    # Unix epoch (10-digit integer, optionally .ms) at line start.
    (
        re.compile(r"^(\d{10}(?:\.\d+)?)"),
        "",  # handled specially via fromtimestamp
    ),
]


def _try_parse_ts(ts_str: str, fmt: str) -> Optional[datetime]:
    if not fmt:
        # ISO 8601 path.
        try:
            normalised = ts_str.rstrip("Z")
            if ts_str.endswith("Z"):
                normalised += "+00:00"
            return datetime.fromisoformat(normalised)
        except ValueError:
            # Unix epoch path.
            try:
                return datetime.fromtimestamp(float(ts_str))
            except (ValueError, OSError, OverflowError):
                return None
    try:
        return datetime.strptime(ts_str.strip(), fmt)
    except ValueError:
        return None


class GenericFallbackParser(LogParser):
    name = "generic_fallback"

    def detect(self, sample_lines: list[str]) -> float:
        # Always return a non-zero but low score so this is the guaranteed
        # fallback when no other parser scores above the threshold.
        return 0.1

    def parse(self, entries: list[str], context: Optional[dict] = None) -> list[LogRecord]:
        records: list[LogRecord] = []
        fallback_date = context.get("fallback_date") if context else None

        for entry in entries:
            # Each entry may be multi-line (pre-stitched by stitcher.py).
            # Extract timestamp/message from the first line only; preserve
            # the full entry (with any continuation) in raw and message.
            if "\n" in entry:
                first_line = entry.split("\n", 1)[0]
                continuation = "\n" + entry.split("\n", 1)[1]
            else:
                first_line = entry
                continuation = ""

            stripped = first_line.rstrip("\r\n")
            if not stripped.strip():
                continue

            ts: Optional[datetime] = None
            message = stripped + continuation

            matched = False
            for pattern, fmt in _TIMESTAMP_PATTERNS:
                m = pattern.match(stripped.strip())
                if m:
                    ts_str = m.group(1)
                    parsed = _try_parse_ts(ts_str, fmt)
                    if parsed is not None:
                        ts = parsed
                        # Strip the matched timestamp from the first-line message.
                        remainder = stripped.strip()[len(ts_str):].lstrip(" \t:-")
                        message = (remainder if remainder else stripped) + continuation
                        matched = True
                    break

            if not matched and fallback_date:
                m_to = re.match(r"^(\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)", stripped.strip())
                if m_to:
                    ts_str = m_to.group(1)
                    from app.parsers.base import parse_time_with_fallback
                    parsed = parse_time_with_fallback(ts_str, fallback_date)
                    if parsed is not None:
                        ts = parsed
                        remainder = stripped.strip()[len(ts_str):].lstrip(" \t:-")
                        message = (remainder if remainder else stripped) + continuation

            records.append(
                LogRecord(
                    timestamp=ts,
                    level=None,
                    source=None,
                    message=message,
                    raw=entry,
                )
            )

        return records

