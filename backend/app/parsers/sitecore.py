"""
Sitecore CMS log parser.

Detects both classic Sitecore logs with full timestamps:
  2026-07-08 12:34:56 INFO  ManagedPoolThread #1 ...

And common Sitecore logs with thread IDs and time-only (no date) on the line:
  2340 22:38:51 INFO  [Index=sitecore_web_index] ...
"""

from __future__ import annotations

import re
from datetime import datetime, date
from typing import Optional

from app.core.models import LogRecord
from app.parsers.base import LogParser, parse_time_with_fallback

# e.g. "2026-07-08 12:34:56"
_TS_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})")

# Level token surrounded by word boundaries.
_LEVEL_RE = re.compile(
    r"\b(INFO|WARN(?:ING)?|ERROR|DEBUG|AUDIT|FATAL|CRITICAL)\b"
)

# Sitecore-specific thread identifier.
_MANAGED_POOL_RE = re.compile(r"ManagedPoolThread")

# Stack frame line.
_STACK_FRAME_RE = re.compile(r"^\s+at\s+[\w\.<>\[\]`]+\(")

# Classic full Sitecore line pattern (timestamp + level + optional thread + message).
_FULL_LINE_DT_RE = re.compile(
    r"^(?P<ts>\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+"
    r"(?P<level>INFO|WARN(?:ING)?|ERROR|DEBUG|AUDIT|FATAL|CRITICAL)\s+"
    r"(?:(?P<source>[^\d][^\s]*(?:\s+#\d+)?)\s+\d+\s+\d{2}:\d{2}:\d{2}\s+"
    r"(?:INFO|WARN(?:ING)?|ERROR|DEBUG|AUDIT|FATAL|CRITICAL)\s+)?"
    r"(?P<message>.+)$",
    re.IGNORECASE,
)

# Time-only Sitecore line pattern (optional thread + time + level + message).
_FULL_LINE_TO_RE = re.compile(
    r"^(?:(?P<thread_id>\d+)\s+)?(?P<time>\d{2}:\d{2}:\d{2})\s+"
    r"(?P<level>INFO|WARN(?:ING)?|ERROR|DEBUG|AUDIT|FATAL|CRITICAL)\s+"
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
        stack_frames = sum(1 for line in sample_lines if _STACK_FRAME_RE.match(line))
        effective_n = max(n - stack_frames, 1)

        # Structure hits
        thread_hits = sum(1 for line in sample_lines if _MANAGED_POOL_RE.search(line))
        dt_format_hits = sum(1 for line in sample_lines if _FULL_LINE_DT_RE.match(line))
        to_format_hits = sum(1 for line in sample_lines if _FULL_LINE_TO_RE.match(line))

        # Vocabulary hits
        vocab_score = 0.0
        vocab_patterns = [
            (r"Sitecore\.", 0.25),
            (r"_template:", 0.2),
            (r"SolrQuery|Solr Query|SolrConnectionException", 0.3),
            (r"ManualStrategy", 0.25),
            (r"\[Index=", 0.25),
            (r"IsOnline", 0.25),
            (r"Crawling Resumed", 0.25),
            (r"DPWG\.", 0.25),
            (r"System\.|Microsoft\.", 0.1),
            (r"\b[\w\.]+Exception\b", 0.15),
        ]

        for pattern, weight in vocab_patterns:
            hits = sum(1 for line in sample_lines if re.search(pattern, line, re.IGNORECASE))
            if hits > 0:
                vocab_score += min((hits / effective_n) * weight * 3.0, weight)

        dt_ratio = dt_format_hits / effective_n
        to_ratio = to_format_hits / effective_n
        thread_ratio = thread_hits / effective_n

        base_score = 0.0
        if dt_ratio > 0.1:
            base_score += 0.4
        if to_ratio > 0.1:
            base_score += 0.4
        if thread_ratio > 0.05:
            base_score += 0.3

        total_score = base_score + vocab_score
        if dt_ratio + to_ratio > 0.3:
            total_score += 0.3

        return min(total_score, 1.0)

    def parse(self, entries: list[str], context: Optional[dict] = None) -> list[LogRecord]:
        records: list[LogRecord] = []
        fallback_date = context.get("fallback_date") if context else None

        for entry in entries:
            if "\n" in entry:
                first_line = entry.split("\n", 1)[0]
                continuation = "\n" + entry.split("\n", 1)[1]
            else:
                first_line = entry
                continuation = ""

            stripped = first_line.rstrip("\r\n").strip()
            if not stripped:
                continue

            ts: Optional[datetime] = None
            level: Optional[str] = None
            source: Optional[str] = None
            message: str = entry

            # 1. Try classic Date-Time pattern
            m_dt = _FULL_LINE_DT_RE.match(first_line.rstrip("\r\n"))
            if m_dt:
                ts = _parse_timestamp(m_dt.group("ts"))
                level_raw = m_dt.group("level").upper()
                level = "WARN" if level_raw == "WARNING" else level_raw
                source = m_dt.group("source")
                message = m_dt.group("message").strip() + continuation
            else:
                # 2. Try time-only pattern
                m_to = _FULL_LINE_TO_RE.match(first_line.rstrip("\r\n"))
                if m_to:
                    level_raw = m_to.group("level").upper()
                    level = "WARN" if level_raw == "WARNING" else level_raw
                    source = f"Thread #{m_to.group('thread_id')}" if m_to.group("thread_id") else None
                    message = m_to.group("message").strip() + continuation
                    ts = parse_time_with_fallback(m_to.group("time"), fallback_date)
                else:
                    # 3. Simple regex-based fallback
                    ts_m = _TS_RE.match(stripped)
                    if ts_m:
                        ts = _parse_timestamp(ts_m.group(1))
                    else:
                        to_m = re.match(r"^(\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)", stripped)
                        if to_m:
                            ts = parse_time_with_fallback(to_m.group(1), fallback_date)

                    level_m = _LEVEL_RE.search(stripped[:80])
                    if level_m:
                        level = level_m.group(1).upper()
                        if level == "WARNING":
                            level = "WARN"

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
