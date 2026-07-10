"""
Format-independent level scanner for LogTidy.

Runs as a post-parse safety net on every LogRecord where the parser did
not extract a level.  This ensures that ERROR/WARN/AUDIT lines always get
flagged as high-severity even when a format-specific parser missed the level
token (e.g., generic_fallback, which doesn't attempt level extraction).

Every parser benefits from this — it's a safety net, not a replacement for
format-specific level extraction.
"""

from __future__ import annotations

import re

from app.core.models import LogRecord

# Match the first well-known severity keyword in a line.
# IGNORECASE so we catch both upper and mixed-case variants.
_LEVEL_RE = re.compile(
    r'\b(FATAL|CRITICAL|ERROR|AUDIT|WARNING|WARN|INFO|DEBUG|TRACE)\b',
    re.IGNORECASE,
)

# Normalise synonyms to the canonical forms used throughout the system.
_NORM: dict[str, str] = {
    "FATAL": "FATAL",
    "CRITICAL": "CRITICAL",
    "ERROR": "ERROR",
    "AUDIT": "AUDIT",
    "WARNING": "WARN",
    "WARN": "WARN",
    "INFO": "INFO",
    "DEBUG": "DEBUG",
    "TRACE": "DEBUG",
}


def apply_level_scan(records: list[LogRecord]) -> list[LogRecord]:
    """
    For every record where ``level`` is None, scan the first line of
    ``message`` (falling back to the first line of ``raw``) for a known
    severity keyword and set ``level`` accordingly.

    Scanning only the first line prevents false positives from stack trace
    bodies (e.g., "at System.Net.Http.HttpClient.SendAsync" would never
    trigger a false FATAL/ERROR match).

    Mutates records in-place and returns the same list for chaining.
    """
    for record in records:
        if record.level is not None:
            continue  # parser already set it — don't override

        # Use the first line of the message; fall back to raw's first line.
        msg_first = record.message.split('\n', 1)[0] if record.message else ''
        text = msg_first or record.raw.split('\n', 1)[0]

        m = _LEVEL_RE.search(text)
        if m:
            found = m.group(1).upper()
            record.level = _NORM.get(found, found)

    return records
