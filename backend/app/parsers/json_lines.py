"""
Generic JSON-lines log parser.

Matches any log stream where every non-blank line is valid JSON and
extracts common timestamp / level / message field names used by
popular logging frameworks (pino, winston, bunyan, structlog, etc.).

Timestamp keys tried (in order): timestamp, time, ts, @timestamp, datetime
Level keys tried:                 level, severity, lvl, log_level, sev
Message keys tried:               message, msg, text, body, log

This parser deliberately has a lower confidence ceiling than format-specific
parsers so that azure_diagnostics.py (which also produces JSON-lines but has
Azure-specific keys) wins when appropriate.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Optional

from app.core.models import LogRecord
from app.parsers.base import LogParser

_TS_KEYS = ("timestamp", "time", "ts", "@timestamp", "datetime", "date")
_LEVEL_KEYS = ("level", "severity", "lvl", "log_level", "sev", "loglevel")
_MSG_KEYS = ("message", "msg", "text", "body", "log", "event")

_LEVEL_NORM = {
    "10": "DEBUG", "20": "DEBUG", "trace": "DEBUG",
    "30": "INFO", "information": "INFO",
    "40": "WARN", "warning": "WARN",
    "50": "ERROR",
    "60": "CRITICAL", "fatal": "CRITICAL", "critical": "CRITICAL",
}


def _try_json(line: str) -> Optional[dict]:
    try:
        obj = json.loads(line.strip())
        return obj if isinstance(obj, dict) else None
    except (json.JSONDecodeError, ValueError):
        return None


def _extract_ts(obj: dict) -> Optional[datetime]:
    for key in _TS_KEYS:
        val = obj.get(key)
        if val is None:
            continue
        if isinstance(val, (int, float)):
            # Unix epoch — handle seconds and milliseconds.
            try:
                epoch = val / 1000 if val > 1e10 else val
                return datetime.fromtimestamp(epoch, tz=timezone.utc)
            except (OSError, OverflowError, ValueError):
                pass
        if isinstance(val, str):
            val = val.replace("Z", "+00:00")
            try:
                return datetime.fromisoformat(val)
            except ValueError:
                pass
    return None


def _extract_level(obj: dict) -> Optional[str]:
    for key in _LEVEL_KEYS:
        val = obj.get(key)
        if val is not None:
            s = str(val).lower()
            return _LEVEL_NORM.get(s, str(val).upper())
    return None


def _extract_message(obj: dict) -> str:
    for key in _MSG_KEYS:
        val = obj.get(key)
        if val and isinstance(val, str):
            return val
    # Fallback: compact serialisation.
    return json.dumps(obj, default=str)


def _extract_source(obj: dict) -> Optional[str]:
    for key in ("name", "logger", "component", "service", "module", "pid"):
        val = obj.get(key)
        if val is not None:
            return str(val)
    return None


class JsonLinesParser(LogParser):
    name = "json_lines"

    def detect(self, sample_lines: list[str]) -> float:
        if not sample_lines:
            return 0.0

        non_blank = [l for l in sample_lines if l.strip()]
        if not non_blank:
            return 0.0

        json_count = 0
        has_msg_key = 0
        has_level_key = 0

        for line in non_blank:
            obj = _try_json(line)
            if obj is None:
                continue
            json_count += 1
            if any(k in obj for k in _MSG_KEYS):
                has_msg_key += 1
            if any(k in obj for k in _LEVEL_KEYS):
                has_level_key += 1

        if json_count == 0:
            return 0.0

        json_ratio = json_count / len(non_blank)
        msg_ratio = has_msg_key / json_count
        level_ratio = has_level_key / json_count

        # Cap at 0.75 so azure_diagnostics can outscore us when it sees
        # Azure-specific fields.
        return min(json_ratio * 0.5 + msg_ratio * 0.3 + level_ratio * 0.2, 0.75)

    def parse(self, lines: list[str]) -> list[LogRecord]:
        records: list[LogRecord] = []

        for line in lines:
            stripped = line.rstrip("\r\n")
            if not stripped.strip():
                continue

            obj = _try_json(stripped)
            if obj is None:
                records.append(
                    LogRecord(timestamp=None, level=None, source=None,
                               message=stripped, raw=stripped)
                )
                continue

            records.append(
                LogRecord(
                    timestamp=_extract_ts(obj),
                    level=_extract_level(obj),
                    source=_extract_source(obj),
                    message=_extract_message(obj),
                    raw=stripped,
                )
            )

        return records
