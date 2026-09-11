#!/usr/bin/env python3
"""
Sitecore Cloud Connector — Layer 1 & 2 verification script.

Run from the backend directory with the venv active:
  python test_sitecore_auth.py

This script:
  1. Calls start_device_flow() — prints user_code + verification_uri
  2. Waits for you to complete login in your browser
  3. Polls poll_token() until you finish (or it times out)
  4. Calls list_environments() with the resulting token
  5. Prints the raw environment response shape

WHAT TO VERIFY:
  - The device code endpoint responds with a 200 and a user_code
  - The verification_uri actually works when you visit it in a browser
  - Polling detects your login and returns an access_token
  - list_environments() returns real data (not a 401 or 404)
  - Print the response shape — note the actual field names
    (we assumed {id, name, projectName} — confirm or correct)

This file is a throwaway test — safe to delete after verification.
"""

import asyncio
import sys
import time

# Make sure the app package is importable when run from the backend root.
sys.path.insert(0, ".")

from app.connectors.sitecore_cloud import (
    ConnectorError,
    TokenExpired,
    TokenPending,
    TokenSlowDown,
    list_environments,
    poll_token,
    start_device_flow,
    _TOKEN_STORE,
)


async def main() -> None:
    print("\n=== Sitecore Cloud Connector — Layer 1 & 2 Verification ===\n")

    # ── Step 1: Start device flow ─────────────────────────────────────────────
    print("Step 1: Starting device-code flow...")
    try:
        flow = await start_device_flow()
    except ConnectorError as exc:
        print(f"\n  FAIL — start_device_flow() raised ConnectorError:\n  {exc}")
        print("\n  Check: is DEVICE_CODE_URL correct? Is the client_id valid?")
        return

    session_id = flow["session_id"]
    device_code = flow["device_code"]
    interval = flow.get("interval", 5)
    expires_in = flow.get("expires_in", 300)

    print(f"\n  User code : {flow['user_code']}")
    print(f"\n  Visit this URL in your browser:")
    print(f"  {flow['verification_uri']}")
    print(f"\n  Then enter the user code shown above.")
    print(f"  Device code expires in {expires_in}s. Polling every {interval}s.")
    print(f"\n  Session ID (for step 2): {session_id}")


    # ── Step 2: Poll until login completes ────────────────────────────────────
    print("\nStep 2: Polling for token (waiting for you to complete login)...")
    deadline = time.monotonic() + expires_in
    attempt = 0

    while time.monotonic() < deadline:
        attempt += 1
        print(f"  poll #{attempt}...", end=" ", flush=True)
        await asyncio.sleep(interval)

        try:
            await poll_token(session_id, device_code)
            print("OK — token received!")
            break
        except TokenPending:
            print("pending")
            continue
        except TokenSlowDown:
            print("slow_down — doubling interval")
            interval = min(interval * 2, 30)
            continue
        except TokenExpired:
            print("\n  FAIL — device code expired before login completed.")
            return
        except ConnectorError as exc:
            print(f"\n  FAIL — unexpected error:\n  {exc}")
            return
    else:
        print("\n  FAIL — polling timed out.")
        return

    # Confirm token is in store
    token_preview = _TOKEN_STORE.get(session_id, "")[:20] + "..."
    print(f"  Token stored (first 20 chars): {token_preview}")

    # ── Step 3: List environments ─────────────────────────────────────────────
    print("\nStep 3: Listing environments via Deploy API...")
    try:
        envs = await list_environments(session_id)
    except ConnectorError as exc:
        print(f"\n  FAIL — list_environments() raised ConnectorError:\n  {exc}")
        print("\n  Check: is DEPLOY_BASE URL correct? Does the token have Deploy API scope?")
        return

    print(f"  OK — got {len(envs)} environment(s).")
    print("\n  Raw response shape (first environment):")
    if envs:
        import json
        first = envs[0]
        print("  " + json.dumps(first, indent=4, default=str).replace("\n", "\n  "))
        print(f"\n  All field names: {sorted(first.keys()) if isinstance(first, dict) else type(first)}")
    else:
        print("  (empty list — no environments returned)")

    print("\n=== Verification complete. Review the output above before building Layer 3. ===\n")


if __name__ == "__main__":
    asyncio.run(main())
