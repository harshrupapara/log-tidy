"""
IIS W3C Extended Log Format parser.

Detects the #Fields: header line that identifies W3C extended format.
Dynamically parses per the declared field list — handles any combination
of standard IIS fields without hardcoding field positions.

Common fields: date, time, c-ip, cs-username, s-computername, s-ip,
               s-port, cs-method, cs-uri-stem, cs-uri-query,
               sc-status, sc-substatus, sc-win32-status,
               time-taken, cs(User-Agent), cs(Referer)
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Optional

from app.core.models import LogRecord
from app.parsers.base import LogParser

_FIELDS_HEADER_RE = re.compile(r"^#Fields:\s+(.+)$", re.IGNORECASE)
_COMMENT_RE = re.compile(r"^#")

# HTTP status → approximate severity level.
def _status_to_level(status: Optional[str]) -> Optional[str]:
    if status is None:
        return None
    try:
        code = int(status)
    except ValueError:
        return None
    if code >= 500:
        return "ERROR"
    if code >= 400:
        return "WARN"
    return "INFO"


class IISParser(LogParser):
    name = "iis"

    def detect(self, sample_lines: list[str]) -> float:
        if not sample_lines:
            return 0.0

        has_fields_header = False
        has_software_header = False
        comment_ratio = 0.0
        space_delimited_data_lines = 0
        total_data_lines = 0

        for line in sample_lines:
            stripped = line.strip()
            if not stripped:
                continue
            if _FIELDS_HEADER_RE.match(stripped):
                has_fields_header = True
            if stripped.startswith("#Software:") or stripped.startswith("#Version:"):
                has_software_header = True
            if stripped.startswith("#"):
                comment_ratio += 1
            else:
                total_data_lines += 1
                # IIS data lines are space-delimited; check for multiple fields.
                if len(stripped.split()) >= 5:
                    space_delimited_data_lines += 1

        n = len(sample_lines)
        comment_ratio /= n

        score = 0.0
        if has_fields_header:
            score += 0.6  # Very strong signal.
        if has_software_header:
            score += 0.2
        if total_data_lines > 0:
            score += (space_delimited_data_lines / total_data_lines) * 0.2

        return min(score, 1.0)

    def parse(self, lines: list[str], context: Optional[dict] = None) -> list[LogRecord]:
        records: list[LogRecord] = []
        field_names: list[str] = []

        for line in lines:
            stripped = line.rstrip("\r\n")
            if not stripped.strip():
                continue

            # Parse field header.
            fields_match = _FIELDS_HEADER_RE.match(stripped.strip())
            if fields_match:
                field_names = fields_match.group(1).strip().split()
                continue

            # Skip other comment lines.
            if _COMMENT_RE.match(stripped.strip()):
                continue

            if not field_names:
                # No header seen yet — treat as raw.
                records.append(
                    LogRecord(timestamp=None, level=None, source=None,
                               message=stripped, raw=stripped)
                )
                continue

            parts = stripped.strip().split()
            # Pad or truncate to match field count.
            while len(parts) < len(field_names):
                parts.append("-")
            fields = dict(zip(field_names, parts))

            # Timestamp: combine 'date' + 'time' fields.
            ts: Optional[datetime] = None
            date_str = fields.get("date", "-")
            time_str = fields.get("time", "-")
            if date_str != "-" and time_str != "-":
                try:
                    ts = datetime.strptime(f"{date_str} {time_str}", "%Y-%m-%d %H:%M:%S")
                except ValueError:
                    pass

            # Level from HTTP status.
            status = fields.get("sc-status") or fields.get("sc_status")
            if status == "-":
                status = None
            level = _status_to_level(status)

            # Source: server IP or computer name.
            source = (
                fields.get("s-computername")
                or fields.get("s-ip")
                or fields.get("s_computername")
            )
            if source == "-":
                source = None

            # Build a human-readable message.
            method = fields.get("cs-method") or fields.get("cs_method") or "-"
            uri = fields.get("cs-uri-stem") or fields.get("cs_uri_stem") or "-"
            query = fields.get("cs-uri-query") or fields.get("cs_uri_query") or "-"
            sc_status = status or "-"
            time_taken = fields.get("time-taken") or fields.get("time_taken") or "-"
            c_ip = fields.get("c-ip") or fields.get("c_ip") or "-"

            message = (
                f"{method} {uri}"
                + (f"?{query}" if query not in ("-", "") else "")
                + f" {sc_status} {time_taken}ms from {c_ip}"
            )

            records.append(
                LogRecord(
                    timestamp=ts,
                    level=level,
                    source=source,
                    message=message,
                    raw=stripped,
                )
            )

        return records
