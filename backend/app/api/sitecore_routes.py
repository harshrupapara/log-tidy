"""
FastAPI routes for the Sitecore Cloud connector.

Mounted under /api/sitecore by app/main.py.

Layer 1 — Auth
  POST /api/sitecore/auth/start        Start device-code flow
  POST /api/sitecore/auth/poll         Poll for token (frontend calls on interval)
  POST /api/sitecore/auth/disconnect   Clear session

Layer 2 — Environment discovery
  GET  /api/sitecore/environments      List environments for this token

Layer 3 — Log discovery
  GET  /api/sitecore/logs              List log files for an environment

Layer 4+5 — Fetch and compress
  POST /api/sitecore/fetch             Download log + run through existing compress pipeline
                                       Returns CompressionResponse — identical to /api/compress
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.connectors.sitecore_cloud import (
    ConnectorError,
    TokenExpired,
    TokenPending,
    TokenSlowDown,
    clear_session,
    fetch_log,
    get_session_info,
    list_environments,
    list_logs,
    poll_token,
    start_device_flow,
)
from app.core.compressor import build_tidy_text, compress, compute_scla_stats
from app.core.level_scanner import apply_level_scan
from app.core.models import CompressionResponse
from app.core.stitcher import stitch_lines
from app.core.windowing import apply_time_window
from app.parsers.base import extract_date_from_filename
from app.parsers.sitecore import SitecoreParser

router = APIRouter(prefix="/api/sitecore", tags=["sitecore-connector"])


# ── Request / response models ──────────────────────────────────────────────────

class AuthStartResponse(BaseModel):
    session_id: str
    device_code: str
    user_code: str
    verification_uri: str
    expires_in: int
    interval: int


class AuthPollRequest(BaseModel):
    session_id: str
    device_code: str


class AuthPollResponse(BaseModel):
    status: str  # "pending" | "ok" | "expired" | "slow_down"


class DisconnectRequest(BaseModel):
    session_id: str


class FetchAndCompressRequest(BaseModel):
    session_id: str
    environment_id: str
    log_name: str
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    format_override: Optional[str] = None


# ── Layer 1 — Auth ─────────────────────────────────────────────────────────────

@router.post("/auth/start", response_model=AuthStartResponse)
async def auth_start() -> AuthStartResponse:
    """Start Sitecore device-code flow. Returns user_code + verification_uri."""
    try:
        data = await start_device_flow()
    except ConnectorError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return AuthStartResponse(**data)


@router.post("/auth/poll", response_model=AuthPollResponse)
async def auth_poll(body: AuthPollRequest) -> AuthPollResponse:
    """
    Poll token endpoint once. Frontend calls this every `interval` seconds.
    Returns status: pending | ok | expired | slow_down.
    On "ok", the token is stored server-side — never returned here.
    """
    try:
        await poll_token(body.session_id, body.device_code)
        return AuthPollResponse(status="ok")
    except TokenPending:
        return AuthPollResponse(status="pending")
    except TokenExpired:
        return AuthPollResponse(status="expired")
    except TokenSlowDown:
        return AuthPollResponse(status="slow_down")
    except ConnectorError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("/auth/disconnect")
async def auth_disconnect(body: DisconnectRequest) -> dict[str, str]:
    """Clear session token from memory."""
    clear_session(body.session_id)
    return {"status": "disconnected"}


@router.get("/session")
async def session_info(session_id: str) -> dict[str, Any]:
    """Check session validity and return organization / user metadata."""
    info = get_session_info(session_id)
    if not info.get("valid"):
        raise HTTPException(status_code=401, detail="Session expired or invalid. Please reconnect.")
    return info


# ── Layer 2 — Environments ─────────────────────────────────────────────────────

@router.get("/environments")
async def environments(session_id: str) -> dict[str, Any]:
    """List XM Cloud environments visible to this user's token."""
    try:
        envs = await list_environments(session_id)
    except ConnectorError as exc:
        msg = str(exc)
        if "reconnect" in msg.lower() or "expired" in msg.lower():
            raise HTTPException(status_code=401, detail=msg)
        if "403" in msg or "access denied" in msg.lower() or "forbidden" in msg.lower():
            raise HTTPException(
                status_code=403,
                detail="Your account doesn't have permission to access XM Cloud environments. Contact your Sitecore org admin to request the required role.",
            )
        raise HTTPException(status_code=502, detail=msg)

    info = get_session_info(session_id)
    return {
        "environments": envs,
        "count": len(envs),
        "organization": info.get("organization", {"id": "", "name": ""}),
        "user": info.get("user", {"email": "", "name": ""}),
    }


# ── Layer 3 — Logs ─────────────────────────────────────────────────────────────

@router.get("/logs")
async def logs(session_id: str, environment_id: str) -> dict[str, Any]:
    """List available log files for the given environment."""
    try:
        log_files = await list_logs(session_id, environment_id)
    except ConnectorError as exc:
        msg = str(exc)
        if "reconnect" in msg.lower() or "expired" in msg.lower():
            raise HTTPException(status_code=401, detail=msg)
        if "403" in msg or "access denied" in msg.lower() or "forbidden" in msg.lower():
            raise HTTPException(
                status_code=403,
                detail="Your account doesn't have permission to view logs for this environment.",
            )
        raise HTTPException(status_code=502, detail=msg)

    return {"logs": log_files, "count": len(log_files)}


# ── Layers 4 & 5 — Fetch + hand off to compression pipeline ───────────────────

@router.post("/fetch", response_model=CompressionResponse)
async def fetch_and_compress(body: FetchAndCompressRequest) -> CompressionResponse:
    """
    Download a Sitecore Cloud log file and run it through the exact same
    compression pipeline as POST /api/compress — identical output shape.
    """
    # ── Fetch ─────────────────────────────────────────────────────────────────
    try:
        raw_bytes = await fetch_log(body.session_id, body.environment_id, body.log_name)
    except ConnectorError as exc:
        code = 401 if "reconnect" in str(exc).lower() else 502
        raise HTTPException(status_code=code, detail=str(exc))

    try:
        raw_text = raw_bytes.decode("utf-8", errors="replace")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not decode log file: {exc}")

    if not raw_text.strip():
        raise HTTPException(status_code=400, detail="Log file is empty.")

    # ── Everything below is identical to POST /api/compress ───────────────────
    lines = raw_text.splitlines()
    total_lines = len([ln for ln in lines if ln.strip()])

    from datetime import datetime
    parsed_start: datetime | None = None
    parsed_end:   datetime | None = None

    if body.start_time:
        try:
            parsed_start = datetime.fromisoformat(body.start_time.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid start_time: {body.start_time!r}")

    if body.end_time:
        try:
            parsed_end = datetime.fromisoformat(body.end_time.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid end_time: {body.end_time!r}")

    parser = SitecoreParser()
    confidence = 1.0

    fallback_date = extract_date_from_filename(body.log_name)
    stitched = stitch_lines(lines)

    try:
        records = parser.parse(stitched, context={"fallback_date": fallback_date})
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Parser error: {exc}")

    records = apply_level_scan(records)
    in_window, no_timestamp = apply_time_window(records, parsed_start, parsed_end)

    lines_in_window = len(in_window)
    if parsed_start is None and parsed_end is None:
        lines_in_window = len(in_window) + len(no_timestamp)

    lines_excluded_no_ts = len(no_timestamp) if (parsed_start or parsed_end) else 0
    records_to_compress = in_window if (parsed_start or parsed_end) else records
    no_ts_for_compress   = no_timestamp if (parsed_start or parsed_end) else []

    try:
        clusters = compress(records_to_compress, no_ts_for_compress)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Compression error: {exc}")

    severity_counts, time_range = compute_scla_stats(clusters, records_to_compress)

    tidy = build_tidy_text(
        detected_format="sitecore",
        confidence=confidence,
        total_lines=total_lines,
        lines_in_window=lines_in_window,
        excluded_no_ts=lines_excluded_no_ts,
        clusters=clusters,
    )

    return CompressionResponse(
        detected_format="sitecore",
        detection_confidence=1.0,
        total_lines=total_lines,
        lines_in_window=lines_in_window,
        lines_excluded_no_timestamp=lines_excluded_no_ts,
        clusters=clusters,
        tidy_text_summary=tidy,
        no_date_warning=None,
        severity_counts=severity_counts,
        time_range=time_range,
    )
