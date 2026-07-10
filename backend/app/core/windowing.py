"""
Time-window filtering for LogTidy.

Applied post-parse on LogRecord.timestamp values.
Records with timestamp=None are excluded from time-filtered results
but are always reported separately — never silently dropped.
"""

from datetime import datetime, timezone
from typing import Optional

from app.core.models import LogRecord


def _make_aware(dt: datetime) -> datetime:
    """Ensure a datetime is timezone-aware (UTC if no tzinfo)."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def apply_time_window(
    records: list[LogRecord],
    start_time: Optional[datetime],
    end_time: Optional[datetime],
) -> tuple[list[LogRecord], list[LogRecord]]:
    """
    Filter records to those within [start_time, end_time].

    Returns:
        (in_window, no_timestamp)
        - in_window: records with timestamp within the window (or all
          timestamped records if no window is given)
        - no_timestamp: records whose timestamp is None
    """
    no_timestamp: list[LogRecord] = []
    timestamped: list[LogRecord] = []

    for record in records:
        if record.timestamp is None:
            no_timestamp.append(record)
        else:
            timestamped.append(record)

    # No filtering requested — return all timestamped records as-is.
    if start_time is None and end_time is None:
        return timestamped, no_timestamp

    start_aware = _make_aware(start_time) if start_time else None
    end_aware = _make_aware(end_time) if end_time else None

    in_window: list[LogRecord] = []
    for record in timestamped:
        ts = _make_aware(record.timestamp)
        if start_aware and ts < start_aware:
            continue
        if end_aware and ts > end_aware:
            continue
        in_window.append(record)

    return in_window, no_timestamp
