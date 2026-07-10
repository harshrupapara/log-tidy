"""
Core data models for LogTidy.

LogRecord is the single cross-cutting contract that every parser produces.
Compression and output logic operate exclusively on this shape and never
need to know which parser generated a record.
"""

from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class LogRecord(BaseModel):
    timestamp: Optional[datetime] = None  # None if undetectable
    level: Optional[str] = None           # ERROR/WARN/INFO/DEBUG/AUDIT/None
    source: Optional[str] = None          # logger name, category, thread, etc.
    message: str                          # the free-text body
    raw: str                              # original untouched line


class CompressionRequest(BaseModel):
    log_text: Optional[str] = None
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None


class ParameterStats(BaseModel):
    """
    Statistics for one wildcard position (<*>) in a cluster template.

    Feature Pass 4: preserves the actual numeric ranges / text variety
    behind each wildcard instead of discarding them.
    """
    position: int           # 0-indexed position in the template's <*> sequence
    type: str               # "numeric" or "text"
    distinct_count: int
    # Numeric fields (type == "numeric")
    min: Optional[float] = None
    max: Optional[float] = None
    avg: Optional[float] = None
    # Text fields (type == "text")
    examples: Optional[list[str]] = None   # up to 3 representative values


class OccurrenceRecord(BaseModel):
    """
    Lightweight record of one occurrence within a cluster.
    Stored inline (capped) to enable per-cluster drill-down without a
    separate endpoint or persistent state.
    """
    timestamp: Optional[datetime] = None
    raw: str


class ClusterResult(BaseModel):
    cluster_id: int = 0
    template: str
    level: Optional[str] = None
    count: int
    first_seen: Optional[datetime] = None
    last_seen: Optional[datetime] = None
    sample_raw: Optional[str] = None
    # Feature Pass 4 additions
    parameters: list[ParameterStats] = []
    occurrences: list[OccurrenceRecord] = []
    occurrences_truncated: bool = False   # True when count > MAX_OCCURRENCES


class CompressionResponse(BaseModel):
    detected_format: str
    detection_confidence: float
    total_lines: int
    lines_in_window: int
    lines_excluded_no_timestamp: int
    clusters: list[ClusterResult]
    # verbatim_events removed in Fix Pass 2.
    # High-severity events are now surfaced by filtering `clusters` by level
    # on the frontend (level in ERROR/FATAL/CRITICAL/AUDIT).  One entry per
    # unique error signature with count, first_seen, last_seen and sample_raw
    # — no more one-entry-per-occurrence flooding.
    tidy_text_summary: str
