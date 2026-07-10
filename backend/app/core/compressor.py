"""
Drain3-based log compression engine for LogTidy.

Each request gets a fresh TemplateMiner — no cross-request state.

Feature Pass 4 additions
─────────────────────────
• Parameter extraction: for each <*> wildcard position in a cluster template,
  collect the original (pre-masking) values from every occurrence, then
  compute min/max/avg (numeric) or distinct_count + examples (text).
  This turns bare <*> wildcards into actionable ranges in the UI.

• Occurrence drill-down: store the first MAX_OCCURRENCES {timestamp, raw}
  pairs per cluster inline in the response so the frontend can show the
  full event history without a separate round-trip.
"""

from __future__ import annotations

import re
from collections import defaultdict
from typing import Optional

from drain3 import TemplateMiner
from drain3.template_miner_config import TemplateMinerConfig

from app.core.models import ClusterResult, LogRecord, OccurrenceRecord, ParameterStats

# ── Severity constants ─────────────────────────────────────────────────────────

# Levels that are shown expanded (with full sample) on the frontend.
HIGH_SEVERITY_LEVELS = {"ERROR", "AUDIT", "FATAL", "CRITICAL"}

# Kept for backward compat references in tests / tidy_text.
VERBATIM_LEVELS = HIGH_SEVERITY_LEVELS

# Levels that are high-signal enough to show timestamps alongside templates.
WARN_LEVELS = {"WARN", "WARNING"}

# ── Collection caps ────────────────────────────────────────────────────────────

# Number of original messages kept per cluster for parameter stats.
# 200 is plenty for accurate min/max/avg; higher values cost memory.
MAX_PARAM_SAMPLES = 200

# Maximum occurrences stored inline per cluster.
# Keeps the initial response lean while still enabling drill-down for most clusters.
MAX_OCCURRENCES = 50


# ── Parameter extraction ───────────────────────────────────────────────────────

def _extract_params(template: str, message: str) -> list[str]:
    """
    Extract the value at each <*> wildcard position in message using the
    Drain3 cluster template.

    Drain3 tokenises on whitespace, so each <*> corresponds to exactly one
    whitespace-delimited token in the original message.  We build a regex
    from the template's fixed parts and capture each wildcard slot with \\S+.

    Returns [] if the template has no wildcards or extraction fails.
    """
    if "<*>" not in template:
        return []

    parts = template.split("<*>")
    n = len(parts) - 1
    if n == 0:
        return []

    # Build pattern: each wildcard → (\S+), fixed parts escaped.
    pattern = "^" + r"(\S+)".join(re.escape(p) for p in parts) + "$"
    try:
        m = re.match(pattern, message.strip())
        if m:
            return list(m.groups())
    except re.error:
        pass

    return []


def _compute_param_stats(template: str, raw_messages: list[str]) -> list[ParameterStats]:
    """
    Analyse extracted wildcard values across raw_messages and produce one
    ParameterStats entry per wildcard position.

    A position is classified "numeric" when ≥80% of its extracted values
    parse as float.  Otherwise "text" with up to 3 representative examples.
    """
    if "<*>" not in template or not raw_messages:
        return []

    n_wildcards = template.count("<*>")
    # per_position[i] collects all extracted strings at wildcard position i.
    per_position: list[list[str]] = [[] for _ in range(n_wildcards)]

    for msg in raw_messages:
        values = _extract_params(template, msg)
        for i, v in enumerate(values[:n_wildcards]):
            per_position[i].append(v.strip())

    stats: list[ParameterStats] = []
    for pos, values in enumerate(per_position):
        if not values:
            continue

        # Attempt numeric parse.
        numeric_vals: list[float] = []
        for v in values:
            try:
                numeric_vals.append(float(v))
            except (ValueError, TypeError):
                pass

        distinct_vals = list(dict.fromkeys(values))  # ordered dedup

        if len(numeric_vals) >= len(values) * 0.8:
            avg = sum(numeric_vals) / len(numeric_vals)
            stats.append(
                ParameterStats(
                    position=pos,
                    type="numeric",
                    distinct_count=len(set(values)),
                    min=min(numeric_vals),
                    max=max(numeric_vals),
                    avg=round(avg, 2),
                )
            )
        else:
            stats.append(
                ParameterStats(
                    position=pos,
                    type="text",
                    distinct_count=len(set(values)),
                    examples=distinct_vals[:3],
                )
            )

    return stats


# ── Drain3 setup ───────────────────────────────────────────────────────────────

def _build_template_miner() -> TemplateMiner:
    """Construct a fresh Drain3 TemplateMiner with sensible masking defaults."""
    config = TemplateMinerConfig()

    # ── Drain parameters ────────────────────────────────────────────────────
    config.drain_sim_th = 0.4          # similarity threshold (lower = more grouping)
    config.drain_depth = 4             # parse tree depth
    config.drain_max_children = 100    # max children per node

    # ── Masking patterns ────────────────────────────────────────────────────
    # Each tuple: (mask_label, regex_pattern)
    config.masking = [
        # GUIDs / UUIDs
        (
            "GUID",
            r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
            r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
        ),
        # IPv4 addresses
        ("IP", r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b"),
        # ISO timestamps embedded mid-message (not at line start)
        (
            "ISOTIME",
            r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?",
        ),
        # Hex blobs (0x…)
        ("HEX", r"0x[0-9a-fA-F]+"),
        # Long pure-hex strings (e.g. SHA hashes, session tokens)
        ("HEXBLOB", r"\b[0-9a-fA-F]{16,}\b"),
        # Pure numbers (integers and decimals)
        ("NUM", r"\b\d+(?:\.\d+)?\b"),
    ]

    config.parametrize_numeric_tokens = True

    return TemplateMiner(config=config)


def _normalise_level(level: Optional[str]) -> Optional[str]:
    if level is None:
        return None
    upper = level.upper()
    if "FATAL" in upper or "CRITICAL" in upper:
        return "CRITICAL"
    return upper


# ── Main compress function ────────────────────────────────────────────────────

def compress(
    records: list[LogRecord],
    no_timestamp_records: Optional[list[LogRecord]] = None,
) -> list[ClusterResult]:
    """
    Run Drain3 template mining over all records and apply severity-aware
    collapsing rules.

    Args:
        records: The (time-filtered) records to compress.
        no_timestamp_records: Records excluded from time filtering; they are
            also compressed and merged into the output clusters.

    Returns:
        clusters — sorted by count descending.

    Each ClusterResult carries:
    • parameters — min/max/avg or distinct examples per <*> wildcard position
    • occurrences — first MAX_OCCURRENCES {timestamp, raw} pairs for drill-down
    • occurrences_truncated — True when count > MAX_OCCURRENCES
    """
    miner = _build_template_miner()

    # Accumulate per-cluster metadata keyed by Drain3 cluster_id.
    cluster_meta: dict[int, dict] = defaultdict(
        lambda: {
            "template": "",
            "level": None,
            "count": 0,
            "first_seen": None,
            "last_seen": None,
            "sample_raw": None,
            # Feature Pass 4
            "raw_messages": [],           # pre-masking first lines for param extraction
            "occurrences": [],            # {timestamp, raw} for drill-down
            "occurrences_truncated": False,
        }
    )

    all_records = list(records) + (no_timestamp_records or [])

    for record in all_records:
        norm_level = _normalise_level(record.level)

        # Cluster by the FIRST LINE of the message only.
        # For stitched multi-line entries (e.g. exception + stack trace) this
        # means Drain3 sees the exception header, not individual frame lines.
        # The full body is still stored on the record via sample_raw.
        cluster_key = (
            record.message.split("\n", 1)[0]
            if "\n" in record.message
            else record.message
        )
        result = miner.add_log_message(cluster_key)
        if result is None:
            continue

        cluster_id = result["cluster_id"]
        template = result["template_mined"]

        meta = cluster_meta[cluster_id]
        meta["template"] = template
        meta["count"] += 1

        # Track dominant level per cluster (highest severity wins).
        if meta["level"] is None:
            meta["level"] = norm_level
        elif norm_level in HIGH_SEVERITY_LEVELS and meta["level"] not in HIGH_SEVERITY_LEVELS:
            meta["level"] = norm_level

        # Track timestamps.
        if record.timestamp is not None:
            if meta["first_seen"] is None or record.timestamp < meta["first_seen"]:
                meta["first_seen"] = record.timestamp
            if meta["last_seen"] is None or record.timestamp > meta["last_seen"]:
                meta["last_seen"] = record.timestamp

        # Keep first occurrence as the sample (preserves full stack trace).
        if meta["sample_raw"] is None:
            meta["sample_raw"] = record.raw

        # ── Feature Pass 4: parameter samples (use pre-masking cluster_key) ──
        # cluster_key is the original message line *before* Drain3 applies
        # its internal masking, so it still carries real numeric values.
        if len(meta["raw_messages"]) < MAX_PARAM_SAMPLES:
            meta["raw_messages"].append(cluster_key)

        # ── Feature Pass 4: occurrence drill-down ────────────────────────────
        if len(meta["occurrences"]) < MAX_OCCURRENCES:
            meta["occurrences"].append(
                {"timestamp": record.timestamp, "raw": record.raw}
            )
        elif not meta["occurrences_truncated"]:
            meta["occurrences_truncated"] = True

    # ── Build final cluster list ──────────────────────────────────────────────
    clusters: list[ClusterResult] = []
    for cid, meta in cluster_meta.items():
        parameters = _compute_param_stats(meta["template"], meta["raw_messages"])
        occurrences = [
            OccurrenceRecord(timestamp=occ["timestamp"], raw=occ["raw"])
            for occ in meta["occurrences"]
        ]
        clusters.append(
            ClusterResult(
                cluster_id=cid,
                template=meta["template"],
                level=meta["level"],
                count=meta["count"],
                first_seen=meta["first_seen"],
                last_seen=meta["last_seen"],
                sample_raw=meta["sample_raw"],
                parameters=parameters,
                occurrences=occurrences,
                occurrences_truncated=meta["occurrences_truncated"],
            )
        )

    # Sort clusters by count descending.
    clusters.sort(key=lambda c: c.count, reverse=True)

    return clusters


# ── Tidy text builder ─────────────────────────────────────────────────────────

def _template_with_ranges(cluster: ClusterResult) -> str:
    """
    Render the template string with parameter ranges substituted for <*>
    wildcards.  E.g.:
      "Cache created: <*> (max size: <*> bytes)"
      → "Cache created: [default|media] (max size: [0–40,991,833] bytes)"
    """
    if not cluster.parameters or "<*>" not in cluster.template:
        return cluster.template

    parts = cluster.template.split("<*>")
    out = parts[0]
    for i, part in enumerate(parts[1:]):
        param = next((p for p in cluster.parameters if p.position == i), None)
        if param:
            if param.type == "numeric":
                lo = int(param.min) if param.min == int(param.min) else param.min  # type: ignore[arg-type]
                hi = int(param.max) if param.max == int(param.max) else param.max  # type: ignore[arg-type]
                out += f"[{lo:,}–{hi:,}]" if lo != hi else f"[{lo:,}]"
            else:
                ex = "|".join(param.examples[:2]) if param.examples else ""
                label = f"{ex}…" if param.distinct_count > 2 else ex
                out += f"[{label or param.distinct_count}]"
        else:
            out += "<*>"
        out += part
    return out


def build_tidy_text(
    detected_format: str,
    confidence: float,
    total_lines: int,
    lines_in_window: int,
    excluded_no_ts: int,
    clusters: list[ClusterResult],
) -> str:
    """Generate the human-readable plaintext summary block."""
    lines: list[str] = []

    high_sev = [c for c in clusters if (c.level or "") in HIGH_SEVERITY_LEVELS]

    lines.append("╔══ LogTidy Summary ══════════════════════════════════════════════════╗")
    lines.append(f"  Format detected : {detected_format} (confidence {confidence:.0%})")
    lines.append(f"  Total lines     : {total_lines:,}")
    lines.append(f"  In time window  : {lines_in_window:,}")
    lines.append(f"  Clusters        : {len(clusters):,}")
    lines.append(f"  High-severity   : {len(high_sev):,}  (ERROR / AUDIT / CRITICAL)")
    if total_lines > 0:
        ratio = 1 - (len(clusters) / max(lines_in_window, 1))
        lines.append(f"  Compression     : {ratio:.0%} reduction")
    if excluded_no_ts:
        lines.append(
            f"  ⚠  {excluded_no_ts:,} lines had no detectable timestamp and were "
            "excluded from the time filter."
        )
    lines.append("╚═════════════════════════════════════════════════════════════════════╝")
    lines.append("")

    if high_sev:
        lines.append(f"{'── HIGH-SEVERITY CLUSTERS (ERROR / AUDIT / CRITICAL) ':─<72}")
        for cluster in high_sev:
            first = cluster.first_seen.isoformat() if cluster.first_seen else "?"
            last = cluster.last_seen.isoformat() if cluster.last_seen else "?"
            lines.append(f"  [{cluster.level}]  ×{cluster.count:,}  {first} → {last}")
            lines.append(f"  {_template_with_ranges(cluster)}")
            if cluster.sample_raw:
                sample = cluster.sample_raw[:600]
                if len(cluster.sample_raw) > 600:
                    sample += "\n  … (truncated)"
                for sline in sample.splitlines():
                    lines.append(f"    {sline}")
            lines.append("")

    lines.append(f"{'── ALL CLUSTERS (sorted by frequency) ':─<72}")
    for i, cluster in enumerate(clusters, 1):
        first = cluster.first_seen.isoformat() if cluster.first_seen else "?"
        last = cluster.last_seen.isoformat() if cluster.last_seen else "?"
        lvl = cluster.level or "UNKNOWN"
        lines.append(
            f"  #{i:>4}  [{lvl}]  count={cluster.count:,}  "
            f"first={first}  last={last}"
        )
        lines.append(f"         {_template_with_ranges(cluster)}")
        lines.append("")

    return "\n".join(lines)
