"""
.NET / CLR exception log parser.

Detects log files dominated by .NET exception stack traces, covering:
  - Raw exception dumps:  ExceptionType: message
                             at Namespace.Class.Method(args)
  - Sitecore-adjacent logs with Solr query strings and .NET exceptions
  - Azure / IIS logs whose bodies are .NET stack traces

Detection is applied to the ORIGINAL (pre-stitch) line list so that
individual "at " lines are visible to detect() even though they will be
merged into their parent entries before parse() is called.

--- HOW TO ADD A NEW PARSER ---
Copy this file to backend/app/parsers/my_format.py.
1. Give your class a unique  name = "my_format".
2. Implement detect() → return 0.0–1.0 confidence.
3. Implement parse() → return list[LogRecord].
That's it.  The registry discovers it automatically on startup.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Optional

from app.core.models import LogRecord
from app.parsers.base import LogParser

# Detection regexes (run on individual lines, before stitching).
_STACK_FRAME_RE = re.compile(r'^\s+at\s+[\w\.<>\[\]`]+\(')
_EXCEPTION_NAME_RE = re.compile(r'\b[\w\.]+Exception\b', re.IGNORECASE)
_EXCEPTION_LINE_RE = re.compile(r'\b[\w\.]+Exception\s*:', re.IGNORECASE)
_DOTNET_NS_RE = re.compile(r'\b(System\.|Microsoft\.|Sitecore\.)', re.IGNORECASE)
_SOLR_RE = re.compile(r'(_template:|fq=|SolrQuery|\bq=)', re.IGNORECASE)
_END_TRACE_RE = re.compile(r'^---\s')

# Parsing regexes (run on the first line of each pre-stitched entry).
_TS_RE = re.compile(
    r'^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)'
)
_LEVEL_RE = re.compile(
    r'\b(FATAL|CRITICAL|ERROR|AUDIT|WARNING|WARN|INFO|DEBUG|TRACE)\b',
    re.IGNORECASE,
)
_LEVEL_NORM: dict[str, str] = {
    "WARNING": "WARN",
    "TRACE": "DEBUG",
    "FATAL": "FATAL",
}


def _parse_ts(ts_str: str) -> Optional[datetime]:
    clean = ts_str.strip().replace('Z', '+00:00').replace('T', ' ')
    for fmt in ('%Y-%m-%d %H:%M:%S%z', '%Y-%m-%d %H:%M:%S'):
        try:
            return datetime.strptime(clean, fmt)
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(ts_str.strip().replace('Z', '+00:00'))
    except ValueError:
        return None


class DotNetExceptionParser(LogParser):
    name = "dotnet_exception"

    def detect(self, sample_lines: list[str]) -> float:
        if not sample_lines:
            return 0.0

        n = len(sample_lines)
        stack_frames = sum(1 for l in sample_lines if _STACK_FRAME_RE.match(l))
        exception_lines = sum(1 for l in sample_lines if _EXCEPTION_LINE_RE.search(l))
        ns_hits = sum(1 for l in sample_lines if _DOTNET_NS_RE.search(l))
        solr_hits = sum(1 for l in sample_lines if _SOLR_RE.search(l))

        frame_ratio = stack_frames / n
        exception_ratio = exception_lines / n
        ns_ratio = ns_hits / n
        solr_bonus = min(solr_hits / n * 2, 0.2)

        score = (
            frame_ratio * 0.5
            + exception_ratio * 0.2
            + ns_ratio * 0.1
            + solr_bonus
        )
        # Cap at 0.85 so sitecore.py (which has stronger Sitecore-specific
        # signals like ManagedPoolThread) can outrank us on Sitecore files.
        return min(score, 0.85)

    def parse(self, entries: list[str]) -> list[LogRecord]:
        records: list[LogRecord] = []

        for entry in entries:
            # Each entry may be multi-line (pre-stitched).
            if '\n' in entry:
                first_line, continuation = entry.split('\n', 1)
                continuation = '\n' + continuation
            else:
                first_line = entry
                continuation = ''

            stripped = first_line.strip()
            if not stripped:
                continue

            # ── Timestamp ──────────────────────────────────────────────────
            ts: Optional[datetime] = None
            ts_m = _TS_RE.match(stripped)
            if ts_m:
                ts = _parse_ts(ts_m.group(1))
                stripped = stripped[len(ts_m.group(1)):].lstrip()

            # ── Level ──────────────────────────────────────────────────────
            level: Optional[str] = None
            level_m = _LEVEL_RE.search(stripped[:80])
            if level_m:
                raw_lvl = level_m.group(1).upper()
                level = _LEVEL_NORM.get(raw_lvl, raw_lvl)

            # Default to ERROR if this looks like an exception header line.
            if level is None and _EXCEPTION_LINE_RE.search(stripped):
                level = 'ERROR'

            # ── Source ─────────────────────────────────────────────────────
            source: Optional[str] = None
            exc_m = _EXCEPTION_NAME_RE.search(stripped)
            if exc_m:
                source = exc_m.group(0).strip()

            # ── Message ────────────────────────────────────────────────────
            # Include the continuation (stack frames) in the full message so
            # verbatim_events shows the complete stack trace.
            message = (stripped + continuation).strip()

            records.append(
                LogRecord(
                    timestamp=ts,
                    level=level,
                    source=source,
                    message=message,
                    raw=entry,
                )
            )

        return records
