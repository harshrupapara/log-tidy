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

export interface SeverityCounts {
  error: number;
  warn: number;
  info: number;
  debug: number;
  other: number;
}

export interface TimeRange {
  start?: string | null;
  end?: string | null;
  duration_str?: string | null;
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
  severity_counts?: SeverityCounts;
  time_range?: TimeRange;
}

export interface FormatListResponse {
  formats: string[];
}

// ── API calls ─────────────────────────────────────────────────────────────────

export async function compressLogs(
  logText: string | null,
  file: File | null,
  startTime: string | null,
  endTime: string | null,
  formatOverride?: string | null,
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
  if (formatOverride) form.append("format_override", formatOverride);

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

// ── Sitecore Cloud Connector ──────────────────────────────────────────────────

export interface SitecoreAuthStartResponse {
  session_id: string;
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface SitecoreEnvironment {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
  provisioningStatus?: string;
  target?: string;
  isProduction?: boolean;
  host?: string;
  zone?: string;
  branch?: string;
  organizationId?: string;
  organizationName?: string;
}

export interface SitecoreOrgInfo {
  id: string;
  name: string;
}

export interface SitecoreUserInfo {
  email: string;
  name: string;
}

export interface SitecoreSessionInfo {
  valid: boolean;
  organization?: SitecoreOrgInfo;
  user?: SitecoreUserInfo;
}

export interface SitecoreEnvironmentsResponse {
  environments: SitecoreEnvironment[];
  count: number;
  organization?: SitecoreOrgInfo;
  user?: SitecoreUserInfo;
}

export interface SitecoreLogFile {
  name: string;
  lastModified: string | null;
  type: string;
  size: number | null;
}

export async function startSitecoreAuth(): Promise<SitecoreAuthStartResponse> {
  const res = await fetch(`${API_BASE}/api/sitecore/auth/start`, { method: "POST" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Failed to start Sitecore auth");
  }
  return res.json();
}

export async function pollSitecoreAuth(
  sessionId: string,
  deviceCode: string,
): Promise<{ status: "pending" | "ok" | "expired" | "slow_down" }> {
  const res = await fetch(`${API_BASE}/api/sitecore/auth/poll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, device_code: deviceCode }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Poll failed");
  }
  return res.json();
}

export async function checkSitecoreSession(
  sessionId: string,
): Promise<SitecoreSessionInfo> {
  const res = await fetch(
    `${API_BASE}/api/sitecore/session?session_id=${encodeURIComponent(sessionId)}`,
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Session expired or invalid");
  }
  return res.json();
}

export async function disconnectSitecore(sessionId: string): Promise<void> {
  await fetch(`${API_BASE}/api/sitecore/auth/disconnect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId }),
  });
}

export async function getSitecoreEnvironments(
  sessionId: string,
): Promise<SitecoreEnvironmentsResponse> {
  const res = await fetch(
    `${API_BASE}/api/sitecore/environments?session_id=${encodeURIComponent(sessionId)}`,
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Failed to load environments");
  }
  return res.json();
}

export async function getSiteCoreLogs(
  sessionId: string,
  environmentId: string,
): Promise<SitecoreLogFile[]> {
  const res = await fetch(
    `${API_BASE}/api/sitecore/logs?session_id=${encodeURIComponent(sessionId)}&environment_id=${encodeURIComponent(environmentId)}`,
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Failed to load logs");
  }
  const data = await res.json();
  return data.logs ?? [];
}

export async function fetchAndCompressSitecoreLog(
  sessionId: string,
  environmentId: string,
  logName: string,
  startTime?: string | null,
  endTime?: string | null,
  formatOverride?: string | null,
): Promise<CompressionResponse> {
  const res = await fetch(`${API_BASE}/api/sitecore/fetch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId,
      environment_id: environmentId,
      log_name: logName,
      start_time: startTime ?? null,
      end_time: endTime ?? null,
      format_override: formatOverride ?? null,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Compression failed");
  }
  return res.json();
}
