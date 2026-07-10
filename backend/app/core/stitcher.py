"""
Line-stitching pre-pass for LogTidy.

Runs on the raw line list BEFORE any parser's parse() is called.
Groups continuation lines (indented, stack frames, "--- End of trace",
etc.) back onto the log entry they belong to, so that a 40-line
exception becomes one LogRecord instead of 40 fragments.

This module is format-agnostic and belongs in core/, not in any
individual parser file.
"""

from __future__ import annotations

import re

# ── Fast timestamp-prefix detector ──────────────────────────────────────────
# We don't fully parse timestamps here — just detect their presence at the
# start of a line so we can tell "does this line open a new log entry?"
_TS_QUICK_RE = re.compile(
    r'^(?:'
    r'\d{4}[-/]\d{2}[-/]\d{2}[T \t]'   # ISO-date prefix:  2026-07-08T / 2026-07-08 
    r'|\d{2}/[A-Za-z]{3}/\d{4}:'        # Apache CLF:       08/Jul/2026:
    r'|\d{1,2}/\d{1,2}/\d{4}\s'         # US date:          7/8/2026 
    r'|\d{10}(?:\.\d+)?\s'               # Unix epoch:       1720432800 
    r'|\d{2}-[A-Za-z]{3}-\d{4}\s'       # DD-Mon-YYYY:      08-Jul-2026 
    r'|\[\d{2}/[A-Za-z]{3}/\d{4}'       # nginx error:      [08/Jul/2026
    r')'
)

# ── Pattern-based continuation markers — fast path ──────────────────────────
# Lines that are almost certainly NOT new log entries.
_CONTINUATION_RE = re.compile(
    r'^(?:'
    r'[ \t]'                   # leading whitespace (indented — covers most cases)
    r'|at\s+[\w\.<>\[\]]'      # .NET / Java stack frame:  at Namespace.Class.Method(
    r'|---\s'                  # end-of-trace marker:      --- End of stack trace ---
    r'|Caused\s+by:'           # Java chained exception
    r'|Inner\s*[Ee]xception'   # .NET inner exception
    r')'
)


def _line_has_timestamp(line: str) -> bool:
    """Quick check: does this line begin with something timestamp-shaped?"""
    return bool(_TS_QUICK_RE.match(line.lstrip('\t')))


def _is_continuation(line: str, prev_entry_had_ts: bool) -> bool:
    """
    Return True if `line` is a continuation of the previous log entry
    (i.e., it should NOT become its own LogRecord).

    Two signals, applied in order:
    1. Pattern-based fast path (indentation, "at ", "--- ", etc.)
    2. General heuristic: line has no timestamp AND the previous entry did.
       This is the primary rule — it catches any multi-line message format
       without needing format-specific patterns.
    """
    if not line.strip():
        return False

    # Fast path — definite continuations by shape.
    if _CONTINUATION_RE.match(line):
        return True

    # General heuristic: continuation if the previous entry opened with a
    # timestamp but this line does not.
    if prev_entry_had_ts and not _line_has_timestamp(line):
        return True

    return False


def stitch_lines(lines: list[str]) -> list[str]:
    """
    Group continuation lines with their parent log entry.

    Args:
        lines: Raw log lines (as returned by str.splitlines()).

    Returns:
        A list of logical log entries.  Each element may contain embedded
        '\\n' characters where continuation lines were joined.  Blank lines
        are used as separators and are not included in output entries.

    This output is what parsers should receive instead of the raw line list.
    """
    entries: list[str] = []
    # Tracks whether the *current open entry* started with a timestamp.
    # Reset on blank lines (which act as entry separators).
    prev_entry_had_ts: bool = False

    for raw_line in lines:
        line = raw_line.rstrip('\r\n')

        # Blank line — separator; never a continuation; reset TS state.
        if not line.strip():
            prev_entry_had_ts = False
            continue

        if entries and _is_continuation(line, prev_entry_had_ts):
            # Extend the current (last) entry.
            entries[-1] = entries[-1] + '\n' + line
            # prev_entry_had_ts intentionally NOT updated — it tracks the
            # *entry header*, not any continuation appended to it.
        else:
            # Start a new entry.
            entries.append(line)
            prev_entry_had_ts = _line_has_timestamp(line)

    return entries
