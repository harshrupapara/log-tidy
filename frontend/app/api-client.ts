/**
 * Thin typed fetch wrapper for the LogTidy backend API.
 *
 * All requests go to http://localhost:8000 — override NEXT_PUBLIC_API_URL
 * via .env.local if the backend is on a different host/port.
 *
 * Feature Pass 4: ParameterStats + OccurrenceRecord added to ClusterResult.
 */

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ParameterStats {
  position: number;          // 0-indexed wildcard position in the template
  type: "numeric" | "text";
  distinct_count: number;
  // Numeric
  min?: number | null;
  max?: number | null;
  avg?: number | null;
  // Text
  examples?: string[] | null;
}

export interface OccurrenceRecord {
  timestamp: string | null;
  raw: string;
}

export interface ClusterResult {
  cluster_id: number;
  template: string;
  level: string | null;
  count: number;
  first_seen: string | null;
  last_seen: string | null;
  sample_raw: string | null;
  parameters: ParameterStats[];
  occurrences: OccurrenceRecord[];
  occurrences_truncated: boolean;
}

export interface CompressionResponse {
  detected_format: string;
  detection_confidence: number;
  total_lines: number;
  lines_in_window: number;
  lines_excluded_no_timestamp: number;
  clusters: ClusterResult[];
  tidy_text_summary: string;
  no_date_warning: string | null;
}

export interface FormatListResponse {
  formats: string[];
}

// ── API calls ─────────────────────────────────────────────────────────────────

export async function compressLogs(
  logText: string | null,
  file: File | null,
  startTime: string | null,
  endTime: string | null
): Promise<CompressionResponse> {
  const form = new FormData();

  if (file) {
    form.append("file", file);
  } else if (logText) {
    form.append("log_text", logText);
  } else {
    throw new Error("Provide either log text or a file.");
  }

  if (startTime) form.append("start_time", startTime);
  if (endTime) form.append("end_time", endTime);

  const res = await fetch(`${API_BASE}/api/compress`, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Compression failed");
  }

  return res.json() as Promise<CompressionResponse>;
}

export async function getFormats(): Promise<string[]> {
  const res = await fetch(`${API_BASE}/api/formats`);
  if (!res.ok) throw new Error("Failed to fetch formats");
  const data = (await res.json()) as FormatListResponse;
  return data.formats;
}
