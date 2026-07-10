# LogTidy

Universal log compression tool — paste or upload raw logs (Sitecore, Azure Diagnostics, IIS, JSON-lines, or any other format), optionally filter by a time window, and get a compressed structured summary.

**No AI, no cloud, no API keys, no database, no config required.**

---

## Quick start

### Backend (Python 3.11+)

```bash
cd backend

# Create and activate a virtual environment
python -m venv venv

# Windows
venv\Scripts\activate

# macOS / Linux
source venv/bin/activate

pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Backend is now running at `http://localhost:8000`.  
Interactive API docs: `http://localhost:8000/docs`

### Frontend (Node 18+)

Open a **separate terminal**:

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:3000` in your browser.

---

## Optional: Docker Compose

Runs both services together (production build):

```bash
docker-compose up --build
```

Frontend → `http://localhost:3000`  
Backend  → `http://localhost:8000`

---

## How it works

```
raw log text (paste or file upload)
   ↓
FORMAT DETECTION  — every registered parser scores the first ~100 lines
   ↓
PARSING           — chosen parser → list[LogRecord]
   ↓
TIME WINDOW FILTER (optional)  — on LogRecord.timestamp
   ↓
COMPRESSION       — Drain3 template mining, severity-aware collapsing
   ↓
JSON response + human-readable tidy text block
```

### Severity tiers

| Level | Handling |
|---|---|
| ERROR / AUDIT / FATAL / CRITICAL | Always individually surfaced in `verbatim_events` |
| WARN | Clustered — template + count + first/last timestamp |
| INFO / DEBUG / None | Clustered aggressively — template + count only |

---

## Adding a new log format parser

> This is the whole point of the plugin architecture. Adding a new format
> takes one file and zero edits to any existing code.

1. **Copy** `backend/app/parsers/generic_fallback.py` to
   `backend/app/parsers/my_format.py`.
2. **Change** `name = "my_format"` on the class.
3. **Implement** `detect(sample_lines)` — return a confidence float 0.0–1.0.
4. **Implement** `parse(lines)` — return `list[LogRecord]`.
5. **Restart** the backend — your parser is automatically discovered and registered.

No imports to update. No list to edit. No config to change.

See `generic_fallback.py` for the minimal template and inline docs.

---

## API reference

### `POST /api/compress`

**Form fields** (multipart/form-data):

| Field | Type | Description |
|---|---|---|
| `log_text` | string | Raw pasted log text |
| `file` | file | Uploaded log file (alternative to log_text) |
| `start_time` | string (ISO 8601) | Optional time window start |
| `end_time` | string (ISO 8601) | Optional time window end |

**Response** (JSON):

```json
{
  "detected_format": "sitecore",
  "detection_confidence": 0.92,
  "total_lines": 14582,
  "lines_in_window": 9204,
  "lines_excluded_no_timestamp": 12,
  "clusters": [
    {
      "template": "Item <*> locked by <*>, retry <*>",
      "level": "WARN",
      "count": 142,
      "first_seen": "2026-07-08T14:22:01Z",
      "last_seen": "2026-07-08T14:38:44Z",
      "sample_raw": "..."
    }
  ],
  "verbatim_events": [
    { "timestamp": "...", "level": "ERROR", "message": "...", "raw": "..." }
  ],
  "tidy_text_summary": "...human-readable copy-paste ready block..."
}
```

### `GET /api/formats`

Returns the list of registered parser names.

```json
{ "formats": ["sitecore", "azure_diagnostics", "iis", "json_lines", "generic_fallback"] }
```

---

## Running tests

```bash
cd backend
pip install pytest
pytest tests/ -v
```

---

## Repo structure

```
logtidy/
  backend/
    app/
      core/
        models.py          # LogRecord + response types
        compressor.py      # Drain3 wrapper + severity logic
        windowing.py       # time filter
      parsers/
        base.py            # LogParser ABC + auto-registration
        registry.py        # pkgutil auto-discovery
        detector.py        # detect_parser()
        sitecore.py
        azure_diagnostics.py
        iis.py
        json_lines.py
        generic_fallback.py   ← copy this to add a new parser
      api/
        routes.py
      main.py
    requirements.txt
    Dockerfile
    tests/
      sample_logs/
      test_parsers.py
      test_compressor.py
  frontend/
    app/
      page.tsx
      api-client.ts
      globals.css
      layout.tsx
    Dockerfile
  docker-compose.yml
  README.md
```
