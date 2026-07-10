"""
Format detector — scores every registered parser and picks the best match.
"""

from __future__ import annotations

from app.parsers.base import LogParser

# Import registry to trigger auto-discovery of all parser modules.
import app.parsers.registry  # noqa: F401


_CONFIDENCE_THRESHOLD = 0.3

# Sample size (lines) fed to detect().
_SAMPLE_SIZE = 100


def detect_parser(lines: list[str]) -> tuple[LogParser, float]:
    """
    Score every registered parser against the first _SAMPLE_SIZE non-blank
    lines and return the best-matching parser with its confidence score.

    Falls back to GenericFallbackParser if no parser exceeds the threshold.
    """
    from app.parsers.registry import REGISTERED_PARSERS

    sample = [l for l in lines if l.strip()][:_SAMPLE_SIZE]

    scored: list[tuple[LogParser, float]] = []
    for parser in REGISTERED_PARSERS:
        try:
            score = parser.detect(sample)
        except Exception:
            score = 0.0
        scored.append((parser, score))

    if not scored:
        return _get_fallback(), 0.0

    best_parser, best_score = max(scored, key=lambda x: x[1])

    if best_score <= _CONFIDENCE_THRESHOLD:
        return _get_fallback(), best_score

    return best_parser, best_score


def _get_fallback() -> LogParser:
    """Return the GenericFallbackParser instance."""
    from app.parsers.registry import REGISTERED_PARSERS

    for p in REGISTERED_PARSERS:
        if p.name == "generic_fallback":
            return p

    # Last resort: import and instantiate directly.
    from app.parsers.generic_fallback import GenericFallbackParser

    return GenericFallbackParser()
