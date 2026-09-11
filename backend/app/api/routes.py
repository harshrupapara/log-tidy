"""
FastAPI routes for LogTidy.

POST /api/compress — main compression endpoint
GET  /api/formats  — list registered parser names
"""

from __future__ import annotations

import io
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from app.core.compressor import build_tidy_text, compress, compute_scla_stats
from app.core.level_scanner import apply_level_scan
from app.core.models import CompressionResponse
from app.core.stitcher import stitch_lines
from app.core.windowing import apply_time_window
from app.parsers.detector import detect_parser

router = APIRouter(prefix="/api")


@router.get("/formats")
async def list_formats() -> dict:
    """Return the names of all registered log format parsers."""
    from app.parsers.registry import REGISTERED_PARSERS

    return {"formats": [p.name for p in REGISTERED_PARSERS]}


@router.post("/compress", response_model=CompressionResponse)
async def compress_logs(
    log_text: Optional[str] = Form(None),
    file: Optional[UploadFile] = File(None),
    start_time: Optional[str] = Form(None),
    end_time: Optional[str] = Form(None),
    format_override: Optional[str] = Form(None),
) -> CompressionResponse:
    """
    Accept raw log content (pasted text or uploaded file) and return a
    structured compressed summary.

    format_override: if set to a known parser name (e.g. "sitecore", "iis"),
    skips auto-detection and forces that parser at confidence 1.0.
    """
    # ── Resolve raw text ────────────────────────────────────────────────────
    raw_text: str = ""

    if file is not None:
        content = await file.read()
        try:
            raw_text = content.decode("utf-8", errors="replace")
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Could not decode file: {exc}")
    elif log_text:
        raw_text = log_text
    else:
        raise HTTPException(
            status_code=400,
            detail="Provide either 'log_text' form field or a file upload.",
        )

    if not raw_text.strip():
        raise HTTPException(status_code=400, detail="Log content is empty.")

    lines = raw_text.splitlines()
    total_lines = len([l for l in lines if l.strip()])

    # ── Parse optional time window ──────────────────────────────────────────
    from datetime import datetime

    parsed_start: Optional[datetime] = None
    parsed_end: Optional[datetime] = None

    if start_time:
        try:
            parsed_start = datetime.fromisoformat(start_time.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid start_time: {start_time!r}")

    if end_time:
        try:
            parsed_end = datetime.fromisoformat(end_time.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid end_time: {end_time!r}")

    # ── Detect or override format ────────────────────────────────────────────
    if format_override:
        from app.parsers.registry import REGISTERED_PARSERS
        override_parser = next(
            (p for p in REGISTERED_PARSERS if p.name == format_override), None
        )
        if override_parser is None:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown format override: {format_override!r}. "
                       f"Valid options: {[p.name for p in REGISTERED_PARSERS]}",
            )
        parser, confidence = override_parser, 1.0
    else:
        parser, confidence = detect_parser(lines)

    # ── Resolve fallback date from filename ──────────────────────────────────
    from app.parsers.base import extract_date_from_filename
    filename = file.filename if file else None
    fallback_date = extract_date_from_filename(filename)

    # ── Pre-stitch (group continuation/stack-trace lines before parsing) ────
    stitched = stitch_lines(lines)

    # ── Parse ────────────────────────────────────────────────────────────────
    try:
        records = parser.parse(stitched, context={"fallback_date": fallback_date})
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Parser error: {exc}")

    # ── Check for time-only logs warning ────────────────────────────────────
    import re
    no_date_warning = None
    if not fallback_date:
        # Match time-only prefix (e.g. "22:38:51" or "2340 22:38:51")
        time_only_re = re.compile(r"^(\d{2}:\d{2}:\d{2}|^\d+\s+\d{2}:\d{2}:\d{2})")
        has_time_only = any(time_only_re.match(r.raw.strip()) for r in records)
        if has_time_only:
            no_date_warning = "No date detected in logs or filename. Timestamps will be time-only."

    # ── Level scan (safety net — fills level=None for any parser that missed it)
    records = apply_level_scan(records)

    # ── Apply time window ────────────────────────────────────────────────────
    in_window, no_timestamp = apply_time_window(records, parsed_start, parsed_end)

    lines_in_window = len(in_window)
    # When no time filter is requested, "in_window" is all timestamped records.
    if parsed_start is None and parsed_end is None:
        lines_in_window = len(in_window) + len(no_timestamp)

    lines_excluded_no_ts = len(no_timestamp) if (parsed_start or parsed_end) else 0

    # ── Compress ─────────────────────────────────────────────────────────────
    records_to_compress = in_window if (parsed_start or parsed_end) else records
    no_ts_for_compress = no_timestamp if (parsed_start or parsed_end) else []

    try:
        clusters = compress(records_to_compress, no_ts_for_compress)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Compression error: {exc}")

    severity_counts, time_range = compute_scla_stats(clusters, records_to_compress)

    # ── Build tidy text ───────────────────────────────────────────────────────
    tidy = build_tidy_text(
        detected_format=parser.name,
        confidence=confidence,
        total_lines=total_lines,
        lines_in_window=lines_in_window,
        excluded_no_ts=lines_excluded_no_ts,
        clusters=clusters,
    )

    return CompressionResponse(
        detected_format=parser.name,
        detection_confidence=round(confidence, 4),
        total_lines=total_lines,
        lines_in_window=lines_in_window,
        lines_excluded_no_timestamp=lines_excluded_no_ts,
        clusters=clusters,
        tidy_text_summary=tidy,
        no_date_warning=no_date_warning,
        severity_counts=severity_counts,
        time_range=time_range,
    )

