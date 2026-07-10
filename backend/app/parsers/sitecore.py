"""
Sitecore CMS log parser.

Detects the classic Sitecore log line format:
  NNNN dd HH:mm:ss LEVEL  ThreadName #N PID HH:mm:ss LEVEL  Message...

Or the simpler two-field format commonly seen in Sitecore 9/10:
  NNNN dd HH:mm:ss LEVEL  Message...

Detection signals (now extended beyond ManagedPoolThread):
  - Timestamp at/near line start in yyyy-MM-dd HH:mm:ss format
  - Level token from {INFO, WARN, ERROR, DEBUG, AUDIT}
  - "ManagedPoolThread" string (strongest Sitecore signal)
  - Sitecore.* namespace references
  - System.* / Microsoft.* .NET namespace references
  - Exception class name patterns (NullReferenceException: etc.)
  - Solr query patterns (_template:, fq=, SolrQuery)
  Stack-frame lines are excluded from timestamp/level ratios so they
  don't dilute the score on exception-heavy files.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Optional

from app.core.models import LogRecord
from app.parsers.base import LogParser

# e.g. "2026-07-08 12:34:56"
_TS_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})"
)

# Level token surrounded by whitespace or end-of-string.
_LEVEL_RE = re.compile(
    r"\b(INFO|WARN(?:ING)?|ERROR|DEBUG|AUDIT|FATAL|CRITICAL)\b"
)

# Sitecore-specific thread identifier.
_MANAGED_POOL_RE = re.compile(r"ManagedPoolThread")

# Stack frame line (excluded from ts/level ratio calculations).
_STACK_FRAME_RE = re.compile(r"^\s+at\s+[\w\.<>\[\]`]+\(")

# Additional Sitecore/.NET signal patterns.
_SITECORE_NS_RE = re.compile(r"Sitecore\.")
_DOTNET_NS_RE = re.compile(r"\b(System\.|Microsoft\.)")
_EXCEPTION_LINE_RE = re.compile(r"\b[\w\.]+Exception\s*:")
_SOLR_RE = re.compile(r"(_template:|fq=|SolrQuery|\bq=)", re.IGNORECASE)

# Full Sitecore line pattern (timestamp + level + optional thread block + message).
# Format: <timestamp> <LEVEL>  <ThreadName> #<id> <PID> <HH:mm:ss> <LEVEL>  <message>
# Or simpler: <timestamp> <LEVEL>  <message>
_FULL_LINE_RE = re.compile(
    r"^(?P<ts>\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+"
    r"(?P<level>INFO|WARN(?:ING)?|ERROR|DEBUG|AUDIT|FATAL|CRITICAL)\s+"
    r"(?:(?P<source>[^\d][^\s]*(?:\s+#\d+)?)\s+\d+\s+\d{2}:\d{2}:\d{2}\s+"
    r"(?:INFO|WARN(?:ING)?|ERROR|DEBUG|AUDIT|FATAL|CRITICAL)\s+)?"
    r"(?P<message>.+)$",
    re.IGNORECASE,
)


def _parse_timestamp(ts_str: str) -> Optional[datetime]:
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d  %H:%M:%S"):
        try:
            return datetime.strptime(ts_str.strip(), fmt)
        except ValueError:
            continue
    return None


class SitecoreParser(LogParser):
    name = "sitecore"

    def detect(self, sample_lines: list[str]) -> float:
        if not sample_lines:
            return 0.0

        n = len(sample_lines)

        ts_hits = 0
        level_hits = 0
        thread_hits = 0
        sitecore_ns_hits = 0
        dotnet_ns_hits = 0
        exception_hits = 0
        solr_hits = 0
        stack_frame_hits = 0

        for line in sample_lines:
            if _STACK_FRAME_RE.match(line):
                stack_frame_hits += 1
                continue  # stack frames skew ts/level ratios — exclude
            if _TS_RE.match(line):
                ts_hits += 1
            if _LEVEL_RE.search(line):
                level_hits += 1
            if _MANAGED_POOL_RE.search(line):
                thread_hits += 1
            if _SITECORE_NS_RE.search(line):
                sitecore_ns_hits += 1
            if _DOTNET_NS_RE.search(line):
                dotnet_ns_hits += 1
            if _EXCEPTION_LINE_RE.search(line):
                exception_hits += 1
            if _SOLR_RE.search(line):
                solr_hits += 1

        # Effective denominator: exclude stack frames so they don't dilute ratios.
        effective_n = max(n - stack_frame_hits, 1)

        ts_ratio = ts_hits / effective_n
        level_ratio = level_hits / effective_n

        # ManagedPoolThread is a near-certain Sitecore signal.
        thread_bonus = min(thread_hits / effective_n * 2, 0.5)

        # Broader .NET/Sitecore signals.
        sitecore_ns_bonus = min(sitecore_ns_hits / effective_n * 0.6, 0.3)
        dotnet_ns_bonus = min(dotnet_ns_hits / effective_n * 0.2, 0.15)
        exception_bonus = min(exception_hits / effective_n * 0.4, 0.2)
        solr_bonus = min(solr_hits / effective_n * 0.4, 0.15)

        score = (
            ts_ratio * 0.3
            + level_ratio * 0.2
            + thread_bonus
            + sitecore_ns_bonus
            + dotnet_ns_bonus
            + exception_bonus
            + solr_bonus
        )
        return min(score, 1.0)

    def parse(self, entries: list[str]) -> list[LogRecord]:
        records: list[LogRecord] = []

        for entry in entries:
            # Each entry may be multi-line (pre-stitched by stitcher.py).
            # Use only the first line for metadata extraction; preserve the
            # full entry (including stack frames) in message and raw.
            if "\n" in entry:
                first_line = entry.split("\n", 1)[0]
                continuation = "\n" + entry.split("\n", 1)[1]
            else:
                first_line = entry
                continuation = ""

            stripped = first_line.rstrip("\r\n").strip()
            if not stripped:
                continue

            m = _FULL_LINE_RE.match(first_line.rstrip("\r\n"))
            if m:
                ts = _parse_timestamp(m.group("ts"))
                level_raw = m.group("level").upper()
                level = "WARN" if level_raw == "WARNING" else level_raw
                source = m.group("source")
                # First-line message + any continuation lines (stack trace).
                message = m.group("message").strip() + continuation
            else:
                # Fallback: extract what we can via simpler regexes.
                ts = None
                ts_m = _TS_RE.match(stripped)
                if ts_m:
                    ts = _parse_timestamp(ts_m.group(1))

                level = None
                level_m = _LEVEL_RE.search(stripped)
                if level_m:
                    level = level_m.group(1).upper()
                    if level == "WARNING":
                        level = "WARN"

                source = None
                message = stripped + continuation

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
