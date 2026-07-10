"""
Parser sanity tests — one test per parser covering detect() and parse().
"""

from __future__ import annotations

from pathlib import Path

import pytest

# Trigger auto-discovery before importing any parsers.
import app.parsers.registry  # noqa: F401

from app.parsers.base import REGISTERED_PARSERS
from app.parsers.detector import detect_parser

SAMPLES = Path(__file__).parent / "sample_logs"


def _lines(filename: str) -> list[str]:
    return (SAMPLES / filename).read_text(encoding="utf-8").splitlines()


# ── Registry ────────────────────────────────────────────────────────────────

def test_all_parsers_registered() -> None:
    names = {p.name for p in REGISTERED_PARSERS}
    expected = {"sitecore", "azure_diagnostics", "iis", "json_lines", "generic_fallback"}
    assert expected.issubset(names), f"Missing parsers: {expected - names}"


# ── Sitecore ─────────────────────────────────────────────────────────────────

def test_sitecore_detect_high_confidence() -> None:
    lines = _lines("sitecore_sample.log")
    parser, score = detect_parser(lines)
    assert parser.name == "sitecore", f"Expected sitecore, got {parser.name}"
    assert score > 0.5, f"Low confidence: {score}"


def test_sitecore_parse_produces_records() -> None:
    lines = _lines("sitecore_sample.log")
    from app.parsers.sitecore import SitecoreParser
    records = SitecoreParser().parse(lines)
    assert len(records) > 0
    assert all(r.message for r in records)


def test_sitecore_parse_levels() -> None:
    lines = _lines("sitecore_sample.log")
    from app.parsers.sitecore import SitecoreParser
    records = SitecoreParser().parse(lines)
    levels = {r.level for r in records if r.level}
    assert "ERROR" in levels
    assert "INFO" in levels
    assert "WARN" in levels
    assert "AUDIT" in levels


def test_sitecore_parse_timestamps() -> None:
    lines = _lines("sitecore_sample.log")
    from app.parsers.sitecore import SitecoreParser
    records = SitecoreParser().parse(lines)
    with_ts = [r for r in records if r.timestamp is not None]
    assert len(with_ts) > 0


# ── Azure Diagnostics ─────────────────────────────────────────────────────────

def test_azure_detect_high_confidence() -> None:
    lines = _lines("azure_sample.json")
    parser, score = detect_parser(lines)
    assert parser.name == "azure_diagnostics", f"Expected azure_diagnostics, got {parser.name}"
    assert score > 0.4


def test_azure_parse_produces_records() -> None:
    lines = _lines("azure_sample.json")
    from app.parsers.azure_diagnostics import AzureDiagnosticsParser
    records = AzureDiagnosticsParser().parse(lines)
    assert len(records) > 0
    assert all(r.message for r in records)


def test_azure_parse_timestamps() -> None:
    lines = _lines("azure_sample.json")
    from app.parsers.azure_diagnostics import AzureDiagnosticsParser
    records = AzureDiagnosticsParser().parse(lines)
    with_ts = [r for r in records if r.timestamp is not None]
    assert len(with_ts) > 0


# ── IIS ───────────────────────────────────────────────────────────────────────

def test_iis_detect_high_confidence() -> None:
    lines = _lines("iis_sample.log")
    parser, score = detect_parser(lines)
    assert parser.name == "iis", f"Expected iis, got {parser.name}"
    assert score > 0.5


def test_iis_parse_produces_records() -> None:
    lines = _lines("iis_sample.log")
    from app.parsers.iis import IISParser
    records = IISParser().parse(lines)
    assert len(records) > 0
    assert all(r.message for r in records)


def test_iis_parse_timestamps() -> None:
    lines = _lines("iis_sample.log")
    from app.parsers.iis import IISParser
    records = IISParser().parse(lines)
    with_ts = [r for r in records if r.timestamp is not None]
    assert len(with_ts) > 0


def test_iis_parse_levels_from_status() -> None:
    lines = _lines("iis_sample.log")
    from app.parsers.iis import IISParser
    records = IISParser().parse(lines)
    levels = {r.level for r in records if r.level}
    # 500 → ERROR, 404/403 → WARN, 200/201 → INFO
    assert "ERROR" in levels
    assert "WARN" in levels
    assert "INFO" in levels


# ── JSON Lines ────────────────────────────────────────────────────────────────

def test_json_lines_detect_high_confidence() -> None:
    lines = _lines("json_lines_sample.log")
    parser, score = detect_parser(lines)
    assert parser.name == "json_lines", f"Expected json_lines, got {parser.name}"
    assert score > 0.4


def test_json_lines_parse_produces_records() -> None:
    lines = _lines("json_lines_sample.log")
    from app.parsers.json_lines import JsonLinesParser
    records = JsonLinesParser().parse(lines)
    assert len(records) > 0
    assert all(r.message for r in records)


def test_json_lines_parse_timestamps() -> None:
    lines = _lines("json_lines_sample.log")
    from app.parsers.json_lines import JsonLinesParser
    records = JsonLinesParser().parse(lines)
    with_ts = [r for r in records if r.timestamp is not None]
    assert len(with_ts) > 0


# ── Generic Fallback ──────────────────────────────────────────────────────────

def test_generic_fallback_never_crashes() -> None:
    """Throw garbage input at the fallback — it must never raise."""
    from app.parsers.generic_fallback import GenericFallbackParser
    parser = GenericFallbackParser()
    garbage = [
        "not a log line at all",
        "!!@#$%^&*()",
        "",
        "   ",
        "12345",
        '{"json": true}',
    ]
    records = parser.parse(garbage)
    # Should produce at least one record for each non-blank line.
    assert len(records) > 0
    assert all(r.raw is not None for r in records)


def test_generic_fallback_parses_iso_timestamps() -> None:
    lines = _lines("generic_sample.log")
    from app.parsers.generic_fallback import GenericFallbackParser
    records = GenericFallbackParser().parse(lines)
    with_ts = [r for r in records if r.timestamp is not None]
    assert len(with_ts) > 0


def test_generic_fallback_no_timestamp_line() -> None:
    """The line with no timestamp should become timestamp=None."""
    lines = _lines("generic_sample.log")
    from app.parsers.generic_fallback import GenericFallbackParser
    records = GenericFallbackParser().parse(lines)
    no_ts = [r for r in records if r.timestamp is None]
    assert len(no_ts) >= 1


# ── Detector threshold ────────────────────────────────────────────────────────

def test_detector_falls_back_for_unknown_format() -> None:
    """Completely synthetic / unrecognised input should go to generic_fallback."""
    unknown = [f"line {i} with no recognisable format whatsoever" for i in range(50)]
    parser, _ = detect_parser(unknown)
    assert parser.name == "generic_fallback"


# ── Fix Pass 5: Date from filename & time-only fallback ───────────────────────

def test_extract_date_from_filename() -> None:
    from app.parsers.base import extract_date_from_filename
    from datetime import date

    # Standard Sitecore log names
    assert extract_date_from_filename("log.20250218.212241.txt") == date(2025, 2, 18)
    assert extract_date_from_filename("sitecore.20261105.log") == date(2026, 11, 5)

    # Delimited names
    assert extract_date_from_filename("log_2025-02-18.log") == date(2025, 2, 18)
    assert extract_date_from_filename("log.2025_02_18.txt") == date(2025, 2, 18)

    # IIS naming format (exYYMMDD)
    assert extract_date_from_filename("ex250218.log") == date(2025, 2, 18)
    assert extract_date_from_filename("EX261231.LOG") == date(2026, 12, 31)

    # Invalid names
    assert extract_date_from_filename("log.txt") is None
    assert extract_date_from_filename("ex123.log") is None
    assert extract_date_from_filename("20259999.log") is None  # invalid month/day


def test_sitecore_parse_time_only_with_fallback_date() -> None:
    from app.parsers.sitecore import SitecoreParser
    from datetime import datetime, date

    lines = [
        "2340 22:38:51 INFO  [Index=sitecore_web_index] Crawling resumed.",
        "22:39:00 WARN  DPWG. Something is wrong.",
    ]
    parser = SitecoreParser()

    # Without context/fallback_date -> timestamp stays None
    records_no_ctx = parser.parse(lines)
    assert records_no_ctx[0].timestamp is None
    assert records_no_ctx[1].timestamp is None

    # With context/fallback_date -> timestamp is combined
    ctx = {"fallback_date": date(2025, 2, 18)}
    records_ctx = parser.parse(lines, context=ctx)
    assert records_ctx[0].timestamp == datetime(2025, 2, 18, 22, 38, 51)
    assert records_ctx[1].timestamp == datetime(2025, 2, 18, 22, 39, 0)
    assert records_ctx[0].level == "INFO"
    assert records_ctx[1].level == "WARN"


def test_generic_fallback_parse_time_only_with_fallback_date() -> None:
    from app.parsers.generic_fallback import GenericFallbackParser
    from datetime import datetime, date

    lines = [
        "22:38:51 This is a generic log line",
    ]
    parser = GenericFallbackParser()

    # Without context
    records_no_ctx = parser.parse(lines)
    assert records_no_ctx[0].timestamp is None

    # With context
    ctx = {"fallback_date": date(2025, 2, 18)}
    records_ctx = parser.parse(lines, context=ctx)
    assert records_ctx[0].timestamp == datetime(2025, 2, 18, 22, 38, 51)

