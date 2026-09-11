"""
Sitecore Cloud Connector — complete implementation.

Verified endpoints (from live Swagger docs, fetched 2026-07-22):

AUTH (auth.sitecorecloud.io — OIDC discovery doc):
  device_authorization_endpoint : /oauth/device/code
  token_endpoint                 : /oauth/token

DEPLOY API (xmclouddeploy-api.sitecorecloud.io — swagger confirmed):
  GET /api/environments/v1       → list all environments (EnvironmentDto)
    Fields: id, name, projectId, projectName, provisioningStatus, …

MONITORING API (xmcloud-monitoring-api.sitecorecloud.io — swagger confirmed):
  GET /api/logs/v1/{environmentId}?latest=true&type={type}
      → array of LogFileNamePath {name, path, lastModified, type, size}
  GET /api/logs/v1/{environmentId}/{name}
      → binary log file download (text/plain or application/octet-stream)
  GET /api/logs/v1/{environmentId}/types
      → string[] of log type names (e.g. "cm", "rendering")

SECURITY:
  - Tokens held ONLY in _TOKEN_STORE (module-level in-memory dict).
  - Tokens never written to disk, logged, or returned to the frontend.
  - session_id is an opaque UUID — the frontend never sees the JWT.
  - client_id is a public identifier (same as the Sitecore CLI uses).
"""

from __future__ import annotations

import base64
import gzip
import json
import os
import uuid
from typing import Any

import httpx

# ── Constants ──────────────────────────────────────────────────────────────────

AUTH_BASE       = "https://auth.sitecorecloud.io"
DEPLOY_BASE     = "https://xmclouddeploy-api.sitecorecloud.io"
MONITORING_BASE = "https://xmcloud-monitoring-api.sitecorecloud.io"

DEVICE_CODE_URL = f"{AUTH_BASE}/oauth/device/code"
TOKEN_URL       = f"{AUTH_BASE}/oauth/token"

# Public device-code client ID — same as Sitecore CLI uses; no secret required.
_CLIENT_ID = os.environ.get("SITECORE_CLIENT_ID", "Chi8EwfFnEejksk3Sed9hlalGiM9B2v7")
_AUDIENCE  = "https://api.sitecorecloud.io"

# ── In-memory session store ────────────────────────────────────────────────────
# Maps session_id (str UUID) → dict with token, org, user, and session metadata.
# Module-level; cleared on process restart. Never persisted to disk.
_TOKEN_STORE: dict[str, dict[str, Any]] = {}


# ── JWT & Token Parsing Helpers ────────────────────────────────────────────────

def decode_jwt_unverified(token: str) -> dict[str, Any]:
    """Decode JWT payload without cryptographic verification."""
    if not token or not isinstance(token, str):
        return {}
    try:
        parts = token.split(".")
        if len(parts) < 2:
            return {}
        payload = parts[1]
        payload += "=" * ((4 - len(payload) % 4) % 4)
        return json.loads(base64.urlsafe_b64decode(payload.encode("utf-8")).decode("utf-8"))
    except Exception:
        return {}


def extract_org_and_user_from_tokens(
    access_token: str, id_token: str | None = None
) -> tuple[dict[str, str], dict[str, str]]:
    """Extract organization and user details from access and ID tokens."""
    acc_claims = decode_jwt_unverified(access_token)
    id_claims = decode_jwt_unverified(id_token) if id_token else {}
    claims = {**acc_claims, **id_claims}

    # Extract user details
    email = claims.get("email") or claims.get("preferred_username") or claims.get("name") or ""
    name = claims.get("name") or claims.get("nickname") or email

    # Extract organization details
    org_id = (
        claims.get("org_id")
        or claims.get("https://api.sitecorecloud.io/orgId")
        or claims.get("https://sitecorecloud.io/org_id")
        or claims.get("organizationId")
        or claims.get("tenant")
        or ""
    )
    org_name = (
        claims.get("org_name")
        or claims.get("https://api.sitecorecloud.io/orgName")
        or claims.get("https://sitecorecloud.io/org_name")
        or claims.get("organizationName")
        or ""
    )

    # Fallback to email domain if org name isn't explicit
    if not org_name and email and "@" in email:
        domain = email.split("@")[-1].split(".")[0]
        if domain.lower() not in ("gmail", "outlook", "hotmail", "yahoo", "icloud"):
            org_name = domain.capitalize()

    return {"id": str(org_id), "name": str(org_name or org_id)}, {"email": str(email), "name": str(name)}


# ── Exceptions ─────────────────────────────────────────────────────────────────

class TokenPending(Exception):
    """Device code flow: user has not yet completed login."""

class TokenExpired(Exception):
    """Device code flow: the device code window has expired."""

class TokenSlowDown(Exception):
    """Device code flow: server asked us to slow polling."""

class ConnectorError(Exception):
    """General Sitecore API error, safe to surface to the user."""


# ── Layer 1 — Device-code auth ─────────────────────────────────────────────────

async def start_device_flow() -> dict[str, Any]:
    """
    Initiate Sitecore Cloud device-code flow.

    Returns dict with: session_id, device_code, user_code,
    verification_uri, expires_in, interval.
    """
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            DEVICE_CODE_URL,
            data={
                "client_id": _CLIENT_ID,
                "audience": _AUDIENCE,
                "scope": "openid profile email offline_access",
            },
        )

    if resp.status_code != 200:
        raise ConnectorError(
            f"Device code request failed ({resp.status_code}): {resp.text[:300]}"
        )

    body = resp.json()
    session_id = str(uuid.uuid4())

    return {
        "session_id": session_id,
        "device_code": body["device_code"],
        "user_code": body["user_code"],
        # verification_uri_complete has the code pre-filled in the URL
        "verification_uri": body.get("verification_uri_complete") or body["verification_uri"],
        "expires_in": body.get("expires_in", 300),
        "interval": body.get("interval", 5),
    }


async def poll_token(session_id: str, device_code: str) -> str:
    """
    Poll token endpoint once. Stores token on success.
    Raises TokenPending / TokenExpired / TokenSlowDown / ConnectorError.
    """
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            TOKEN_URL,
            data={
                "client_id": _CLIENT_ID,
                "device_code": device_code,
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            },
        )

    body = resp.json()

    if resp.status_code == 200:
        token = body["access_token"]
        id_token = body.get("id_token")
        org_info, user_info = extract_org_and_user_from_tokens(token, id_token)
        _TOKEN_STORE[session_id] = {
            "access_token": token,
            "id_token": id_token,
            "organization": org_info,
            "user": user_info,
        }
        return token

    error = body.get("error", "")
    if error == "authorization_pending":
        raise TokenPending()
    if error == "expired_token":
        raise TokenExpired()
    if error == "slow_down":
        raise TokenSlowDown()

    raise ConnectorError(f"Token poll failed ({resp.status_code}): {body.get('error_description', resp.text[:200])}")


def get_token(session_id: str) -> str:
    """Retrieve stored token or raise ConnectorError."""
    entry = _TOKEN_STORE.get(session_id)
    if not entry:
        raise ConnectorError("Session not found. Please reconnect to Sitecore Cloud.")
    if isinstance(entry, dict):
        return entry.get("access_token", "")
    return str(entry)


def get_session_info(session_id: str) -> dict[str, Any]:
    """Retrieve session metadata including organization and user info."""
    entry = _TOKEN_STORE.get(session_id)
    if not entry:
        return {"valid": False}
    if isinstance(entry, dict):
        return {
            "valid": True,
            "organization": entry.get("organization", {"id": "", "name": ""}),
            "user": entry.get("user", {"email": "", "name": ""}),
        }
    return {"valid": True, "organization": {"id": "", "name": ""}, "user": {"email": "", "name": ""}}


def clear_session(session_id: str) -> None:
    """Remove token from store (disconnect)."""
    _TOKEN_STORE.pop(session_id, None)


# ── Layer 2 — Environment discovery ───────────────────────────────────────────
# Confirmed shape from live swagger (EnvironmentDto):
#   id, name, projectId, projectName, provisioningStatus, host, zone, …

async def list_environments(session_id: str) -> list[dict[str, Any]]:
    """
    List all XM Cloud environments visible to this user's token.
    Returns rich normalised list of environment dicts.
    """
    token = get_token(session_id)

    async with httpx.AsyncClient(
        base_url=DEPLOY_BASE,
        headers={"Authorization": f"Bearer {token}"},
        timeout=20,
    ) as client:
        resp = await client.get("/api/environments/v1")

    if resp.status_code == 401:
        raise ConnectorError("Authentication expired — please reconnect.")
    if not resp.is_success:
        raise ConnectorError(f"Environments API error ({resp.status_code}): {resp.text[:300]}")

    data = resp.json()

    # Unwrap paged or direct list responses
    items: list[dict] = []
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        for key in ("data", "items", "environments", "results"):
            if key in data and isinstance(data[key], list):
                items = data[key]
                break
        if not items:
            items = [data]

    envs: list[dict[str, Any]] = []
    found_org_id = ""
    found_org_name = ""

    for env in items:
        if not env.get("id"):
            continue

        env_org_id = env.get("organizationId") or env.get("orgId") or env.get("tenantId") or ""
        env_org_name = env.get("organizationName") or env.get("orgName") or ""
        if env_org_id and not found_org_id:
            found_org_id = str(env_org_id)
        if env_org_name and not found_org_name:
            found_org_name = str(env_org_name)

        is_prod = bool(
            env.get("isProduction")
            or str(env.get("target", "")).lower() == "production"
            or str(env.get("name", "")).lower() in ("prod", "production")
        )

        envs.append({
            "id": env.get("id", ""),
            "name": env.get("name", ""),
            "projectId": env.get("projectId", ""),
            "projectName": env.get("projectName") or env.get("project_name") or "Default Project",
            "provisioningStatus": env.get("provisioningStatus") or env.get("status") or "Complete",
            "target": env.get("target") or ("Production" if is_prod else "Development"),
            "isProduction": is_prod,
            "host": env.get("host", ""),
            "zone": env.get("zone", ""),
            "branch": env.get("branch", ""),
            "organizationId": str(env_org_id),
            "organizationName": str(env_org_name),
        })

    # If org info was discovered in environment objects, update session store
    if (found_org_id or found_org_name) and session_id in _TOKEN_STORE:
        session_entry = _TOKEN_STORE[session_id]
        if isinstance(session_entry, dict):
            curr_org = session_entry.get("organization", {})
            if not curr_org.get("name") and found_org_name:
                curr_org["name"] = found_org_name
            if not curr_org.get("id") and found_org_id:
                curr_org["id"] = found_org_id
            session_entry["organization"] = curr_org

    return envs


# ── Layer 3 — Log discovery ────────────────────────────────────────────────────
# Confirmed shape from live swagger (LogFileNamePath):
#   name, path, lastModified, type, size
# Endpoint: GET /api/logs/v1/{environmentId}?latest=true

async def list_logs(session_id: str, environment_id: str) -> list[dict[str, Any]]:
    """
    List available log files for an environment.
    Returns list of {name, lastModified, type, size}.
    """
    token = get_token(session_id)

    async with httpx.AsyncClient(
        base_url=MONITORING_BASE,
        headers={"Authorization": f"Bearer {token}"},
        timeout=20,
    ) as client:
        resp = await client.get(
            f"/api/logs/v1/{environment_id}",
            params={"latest": "true"},
        )

    if resp.status_code == 401:
        raise ConnectorError("Authentication expired — please reconnect.")
    if resp.status_code == 404:
        raise ConnectorError("No logs found for this environment.")
    if not resp.is_success:
        raise ConnectorError(f"Log listing error ({resp.status_code}): {resp.text[:300]}")

    data = resp.json()
    items: list[dict] = data if isinstance(data, list) else []

    return [
        {
            "name": item.get("name", ""),
            "lastModified": item.get("lastModified"),
            "type": item.get("type", ""),
            "size": item.get("size"),
        }
        for item in items
        if item.get("name")
    ]


# ── Layer 4 — Log fetch ────────────────────────────────────────────────────────
# Confirmed endpoint: GET /api/logs/v1/{environmentId}/{name}
# Response: binary (text/plain or application/octet-stream, possibly gzip)

async def fetch_log(session_id: str, environment_id: str, log_name: str) -> bytes:
    """
    Download a log file and return its raw bytes (decompressed if gzip).
    """
    token = get_token(session_id)

    async with httpx.AsyncClient(
        base_url=MONITORING_BASE,
        headers={"Authorization": f"Bearer {token}"},
        timeout=60,
        follow_redirects=True,
    ) as client:
        resp = await client.get(f"/api/logs/v1/{environment_id}/{log_name}")

    if resp.status_code == 401:
        raise ConnectorError("Authentication expired — please reconnect.")
    if resp.status_code == 404:
        raise ConnectorError(f"Log file not found: {log_name!r}")
    if not resp.is_success:
        raise ConnectorError(f"Log download error ({resp.status_code}): {resp.text[:300]}")

    raw = resp.content

    # Transparently decompress gzip if needed
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)

    return raw
