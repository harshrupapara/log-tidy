"""
Compressor unit tests — updated for Fix Pass 2.

verbatim_events has been removed. High-severity events are now surfaced by
filtering clusters by level on the client.  Tests now verify:
  - Correct clustering and counts
  - Cluster-level tracking (highest severity wins per cluster)
  - sample_raw is captured for the first occurrence
  - Timestamp tracking (first_seen / last_seen)
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

# Trigger auto-discovery.
import app.parsers.registry  # noqa: F401

from app.core.compressor import HIGH_SEVERITY_LEVELS, compress
from app.core.models import LogRecord


def _ts(hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 7, 8, hour, minute, 0, tzinfo=timezone.utc)


def _make_records(specs: list[tuple]) -> list[LogRecord]:
    """specs: list of (message, level, timestamp_or_None)"""
    return [
        LogRecord(
            timestamp=ts,
            level=level,
            source=None,
            message=msg,
            raw=f"[{level or 'NONE'}] {msg}",
        )
        for msg, level, ts in specs
    ]


# ── Basic clustering ──────────────────────────────────────────────────────────

def test_compress_produces_clusters() -> None:
    records = _make_records([
        ("User 123 logged in", "INFO", _ts(12, 0)),
        ("User 456 logged in", "INFO", _ts(12, 1)),
        ("User 789 logged in", "INFO", _ts(12, 2)),
        ("User 999 logged in", "INFO", _ts(12, 3)),
    ])
    clusters = compress(records)
    assert len(clusters) > 0
    assert clusters[0].count == 4


def test_compress_cluster_count_accurate() -> None:
    records = _make_records([
        ("Request to /api/health completed in 12ms", "INFO", _ts(12, 0)),
        ("Request to /api/orders completed in 340ms", "INFO", _ts(12, 1)),
        ("Request to /api/products completed in 88ms", "INFO", _ts(12, 2)),
    ])
    clusters = compress(records)
    total = sum(c.count for c in clusters)
    assert total == len(records)


# ── Cluster-level tracking ────────────────────────────────────────────────────

def test_high_severity_clusters_flagged_correctly() -> None:
    """ERROR/AUDIT records elevate the cluster's level to high-severity."""
    records = _make_records([
        ("Disk quota exceeded", "ERROR", _ts(12, 0)),
        ("User admin logged in", "AUDIT", _ts(12, 1)),
        ("Cache hit for item abc", "INFO", _ts(12, 2)),
        ("Slow query 1200ms", "WARN", _ts(12, 3)),
        ("System failure: NullReferenceException", "CRITICAL", _ts(12, 4)),
    ])
    clusters = compress(records)
    high_sev = [c for c in clusters if (c.level or "") in HIGH_SEVERITY_LEVELS]
    low_sev = [c for c in clusters if (c.level or "") not in HIGH_SEVERITY_LEVELS]

    high_levels = {c.level for c in high_sev}
    low_levels = {c.level for c in low_sev}

    assert "ERROR" in high_levels
    assert "AUDIT" in high_levels
    assert "INFO" not in high_levels
    assert "WARN" not in high_levels
    assert "INFO" in low_levels or "WARN" in low_levels


def test_highest_severity_wins_per_cluster() -> None:
    """When identical messages at different levels cluster together, highest wins."""
    records = _make_records([
        ("Connection to db failed", "WARN", _ts(12, 0)),
        ("Connection to db failed", "ERROR", _ts(12, 1)),
        ("Connection to db failed", "WARN", _ts(12, 2)),
    ])
    clusters = compress(records)
    assert len(clusters) == 1
    assert clusters[0].level == "ERROR"
    assert clusters[0].count == 3


def test_no_per_occurrence_flooding() -> None:
    """
    1,000 identical errors → exactly 1 cluster, not 1,000 separate entries.
    This is the core Fix Pass 2 regression check.
    """
    records = _make_records([
        (
            "SolrConnectionException: The underlying connection was closed",
            "ERROR",
            _ts(12, i % 60),
        )
        for i in range(1000)
    ])
    clusters = compress(records)
    # All occurrences collapse to a single cluster template.
    assert len(clusters) == 1
    assert clusters[0].count == 1000
    assert (clusters[0].level or "") in HIGH_SEVERITY_LEVELS


# ── sample_raw captured ───────────────────────────────────────────────────────

def test_sample_raw_is_first_occurrence() -> None:
    records = _make_records([
        ("Error processing item 100", "ERROR", _ts(12, 0)),
        ("Error processing item 200", "ERROR", _ts(12, 1)),
    ])
    clusters = compress(records)
    assert len(clusters) == 1
    assert clusters[0].sample_raw is not None
    # sample_raw should be the first occurrence's raw line.
    assert "100" in clusters[0].sample_raw


# ── Timestamp tracking ────────────────────────────────────────────────────────

def test_cluster_timestamps_track_first_last() -> None:
    records = _make_records([
        ("Job completed", "INFO", _ts(12, 0)),
        ("Job completed", "INFO", _ts(12, 5)),
        ("Job completed", "INFO", _ts(12, 10)),
    ])
    clusters = compress(records)
    assert len(clusters) == 1
    cluster = clusters[0]
    assert cluster.first_seen is not None
    assert cluster.last_seen is not None
    assert cluster.first_seen <= cluster.last_seen


# ── No-timestamp records ──────────────────────────────────────────────────────

def test_no_timestamp_records_are_compressed() -> None:
    records = _make_records([
        ("Raw line with no timestamp", None, None),
        ("Another raw line with no timestamp", None, None),
    ])
    clusters = compress(records, no_timestamp_records=records)
    assert len(clusters) > 0


# ── Empty input ───────────────────────────────────────────────────────────────

def test_compress_empty_input() -> None:
    clusters = compress([])
    assert clusters == []
