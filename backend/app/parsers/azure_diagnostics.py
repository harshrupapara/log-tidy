"""
Azure Diagnostics / Application Insights log parser.

Detects JSON-lines where each line is a JSON object containing Azure-specific
field names:
  - Azure Diagnostics: time, resourceId, category, level, operationName
  - App Service / App Insights: timestamp, severityLevel, message, customDimensions

Also handles compact single-line JSON blobs from Azure Monitor exports.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Optional

from app.core.models import LogRecord
from app.parsers.base import LogParser

# Azure Diagnostics specific keys — high-confidence signals.
_AZURE_DIAG_KEYS = {"resourceId", "operationName", "category", "resultType"}
# Azure App Insights / Monitor keys.
_AZURE_INSIGHTS_KEYS = {"severityLevel", "customDimensions", "itemType", "cloud_RoleName"}
# Generic Azure time field (not shared with other JSON formats).
_AZURE_TIME_KEYS = {"time", "TimeGenerated"}

_LEVEL_MAP = {
    "0": "CRITICAL",
    "1": "ERROR",
    "2": "WARN",
    "3": "INFO",
    "4": "DEBUG",
    "verbose": "DEBUG",
    "information": "INFO",
    "warning": "WARN",
    "error": "ERROR",
    "critical": "CRITICAL",
}


def _try_parse_json(line: str) -> Optional[dict]:
    try:
        obj = json.loads(line.strip())
        if isinstance(obj, dict):
            return obj
    except (json.JSONDecodeError, ValueError):
        pass
    return None


def _extract_timestamp(obj: dict) -> Optional[datetime]:
    for key in ("time", "TimeGenerated", "timestamp", "eventTimestamp"):
        val = obj.get(key)
        if val and isinstance(val, str):
            # Normalise trailing 'Z'.
            val = val.replace("Z", "+00:00")
            try:
                return datetime.fromisoformat(val)
            except ValueError:
                pass
    return None


def _extract_level(obj: dict) -> Optional[str]:
    for key in ("level", "Level", "severityLevel", "SeverityLevel"):
        val = obj.get(key)
        if val is not None:
            return _LEVEL_MAP.get(str(val).lower(), str(val).upper())
    return None


def _extract_message(obj: dict) -> str:
    for key in ("message", "Message", "operationName", "OperationName", "resultDescription"):
        val = obj.get(key)
        if val and isinstance(val, str):
            return val
    # Fallback: serialise the whole object minus known noisy keys.
    stripped = {
        k: v
        for k, v in obj.items()
        if k not in ("time", "TimeGenerated", "resourceId", "subscriptionId")
    }
    return json.dumps(stripped, default=str)


def _azure_confidence(obj: dict) -> float:
    score = 0.0
    keys = set(obj.keys())
    diag_hits = len(keys & _AZURE_DIAG_KEYS)
    insights_hits = len(keys & _AZURE_INSIGHTS_KEYS)
    time_hits = len(keys & _AZURE_TIME_KEYS)

    score += min(diag_hits * 0.25, 0.5)
    score += min(insights_hits * 0.2, 0.4)
    score += min(time_hits * 0.15, 0.3)
    return min(score, 1.0)


class AzureDiagnosticsParser(LogParser):
    name = "azure_diagnostics"

    def detect(self, sample_lines: list[str]) -> float:
        if not sample_lines:
            return 0.0

        scores: list[float] = []
        json_line_count = 0

        for line in sample_lines:
            obj = _try_parse_json(line)
            if obj is None:
                continue
            json_line_count += 1
            scores.append(_azure_confidence(obj))

        if json_line_count == 0:
            return 0.0

        json_ratio = json_line_count / len(sample_lines)
        avg_azure_score = sum(scores) / len(scores) if scores else 0.0

        return json_ratio * 0.4 + avg_azure_score * 0.6

    def parse(self, lines: list[str]) -> list[LogRecord]:
        records: list[LogRecord] = []

        for line in lines:
            stripped = line.rstrip("\r\n")
            if not stripped.strip():
                continue

            obj = _try_parse_json(stripped)
            if obj is None:
                # Non-JSON line — include as raw with no structure.
                records.append(
                    LogRecord(
                        timestamp=None,
                        level=None,
                        source=None,
                        message=stripped,
                        raw=stripped,
                    )
                )
                continue

            ts = _extract_timestamp(obj)
            level = _extract_level(obj)
            source = obj.get("category") or obj.get("resourceId") or obj.get("cloud_RoleName")
            message = _extract_message(obj)

            records.append(
                LogRecord(
                    timestamp=ts,
                    level=level,
                    source=str(source) if source else None,
                    message=message,
                    raw=stripped,
                )
            )

        return records
