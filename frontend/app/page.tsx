"use client";

import {
  useState,
  useCallback,
  useRef,
  useMemo,
  useEffect,
} from "react";
import {
  compressLogs,
  getFormats,
  startSitecoreAuth,
  pollSitecoreAuth,
  disconnectSitecore,
  checkSitecoreSession,
  getSitecoreEnvironments,
  getSiteCoreLogs,
  fetchAndCompressSitecoreLog,
  type CompressionResponse,
  type ClusterResult,
  type ParameterStats,
  type OccurrenceRecord,
  type SitecoreEnvironment,
  type SitecoreLogFile,
  type SitecoreOrgInfo,
} from "./api-client";

// ── Constants ─────────────────────────────────────────────────────────────────

const HIGH_SEVERITY = new Set(["ERROR", "CRITICAL", "FATAL", "AUDIT"]);
const WARN_LEVELS    = new Set(["WARN", "WARNING"]);
const PAGE_SIZE      = 25;
const PREVIEW_SIZE   = 10;
const MAX_HISTORY    = 3;
const SIDEBAR_W      = 264; // px — matches w-66 below

// ── Types ─────────────────────────────────────────────────────────────────────

type SortKey     = "count" | "first_seen";
type LevelFilter = "all" | "error" | "warn" | "info";

interface SitecoreMeta {
  orgName?: string;
  orgId?: string;
  projectName?: string;
  envName?: string;
  envId?: string;
  logName?: string;
}

interface SessionEntry {
  id: string;
  label: string;        // filename or "pasted text"
  ts: number;           // Date.now() when compressed
  format: string;
  ratio: number;
  result: CompressionResponse;
  sitecoreMeta?: SitecoreMeta;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function levelColor(level: string | null): string {
  switch (level?.toUpperCase()) {
    case "ERROR": case "CRITICAL": case "FATAL":
      return "text-red-400 border-red-500/40 bg-red-500/10";
    case "AUDIT":
      return "text-purple-400 border-purple-500/40 bg-purple-500/10";
    case "WARN": case "WARNING":
      return "text-amber-400 border-amber-500/40 bg-amber-500/10";
    case "INFO":
      return "text-cyan-400 border-cyan-500/40 bg-cyan-500/10";
    case "DEBUG":
      return "text-zinc-400 border-zinc-600/40 bg-zinc-800/40";
    default:
      return "text-zinc-400 border-zinc-700/40 bg-zinc-800/30";
  }
}

function levelDotColor(level: string | null): string {
  switch (level?.toUpperCase()) {
    case "ERROR": case "CRITICAL": case "FATAL": return "bg-red-500";
    case "AUDIT":   return "bg-purple-500";
    case "WARN": case "WARNING": return "bg-amber-500";
    case "INFO":    return "bg-cyan-500";
    default:        return "bg-zinc-600";
  }
}

function formatTs(ts: string | null, short = false): string {
  if (!ts) return "—";
  try {
    const iso = new Date(ts).toISOString();
    return short ? iso.slice(0, 16).replace("T", " ") : iso.replace("T", " ").slice(0, 19) + " UTC";
  } catch { return ts; }
}

function formatNum(n: number | null | undefined): string {
  if (n == null) return "?";
  return Number.isInteger(n)
    ? n.toLocaleString()
    : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function compressionPct(total: number, clusters: number): number {
  if (total === 0) return 0;
  return Math.round((1 - clusters / total) * 100);
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function downloadBlob(content: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function parserDisplayName(name: string): string {
  const map: Record<string, string> = {
    sitecore: "Sitecore",
    azure_diagnostics: "Azure Diagnostics",
    iis: "IIS",
    json_lines: "JSON Lines",
    dotnet_exception: ".NET Exception",
    generic_fallback: "Generic",
  };
  return map[name] ?? name;
}

// ── Highlight ─────────────────────────────────────────────────────────────────

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-amber-400/30 text-amber-200 rounded-[2px] not-italic">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
}

// ── TemplateDisplay ───────────────────────────────────────────────────────────

function TemplateDisplay({
  template,
  params,
  search,
  className = "",
}: {
  template: string;
  params: ParameterStats[];
  search: string;
  className?: string;
}) {
  if (!template.includes("<*>") || !params.length) {
    return (
      <span className={className}>
        <Highlight text={template} query={search} />
      </span>
    );
  }

  const parts = template.split("<*>");
  return (
    <span className={className}>
      {parts.map((part, i) => {
        const param = params.find((p) => p.position === i - 1);
        return (
          <span key={i}>
            {param && (
              <span
                className={`font-bold rounded px-1 text-[10px] ${
                  param.type === "numeric"
                    ? "text-amber-400 bg-amber-500/15"
                    : "text-cyan-400 bg-cyan-500/15"
                }`}
                title={
                  param.type === "numeric"
                    ? `min: ${formatNum(param.min)}  max: ${formatNum(param.max)}  avg: ${formatNum(param.avg)}`
                    : (param.examples ?? []).join(", ")
                }
              >
                {param.type === "numeric"
                  ? formatNum(param.min) === formatNum(param.max)
                    ? formatNum(param.min)
                    : `${formatNum(param.min)}–${formatNum(param.max)}`
                  : param.distinct_count === 1 && param.examples?.length
                    ? param.examples[0]
                    : `${param.distinct_count} val${param.distinct_count !== 1 ? "s" : ""}`}
              </span>
            )}
            {!param && i > 0 && (
              <span className="text-zinc-500 text-[10px]">&lt;*&gt;</span>
            )}
            <Highlight text={part} query={search} />
          </span>
        );
      })}
    </span>
  );
}

// ── LevelBadge ────────────────────────────────────────────────────────────────

function LevelBadge({ level }: { level: string | null }) {
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono font-bold border shrink-0 ${levelColor(level)}`}
    >
      {level ?? "NONE"}
    </span>
  );
}

// ── SCLA Severity & Stat Card ─────────────────────────────────────────────────

function SCLACard({
  label,
  value,
  sub,
  accent,
  borderClass,
  active,
  onClick,
}: {
  label: string;
  value: string | number;
  sub?: React.ReactNode;
  accent?: string;
  borderClass?: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={`flex flex-col justify-between p-3.5 rounded-xl border transition-all ${
        onClick ? "cursor-pointer hover:scale-[1.01]" : ""
      } ${
        active
          ? `${borderClass ?? "border-zinc-500"} bg-zinc-900/90 shadow-lg ring-1 ring-white/10`
          : "border-zinc-800/80 bg-zinc-900/40 hover:border-zinc-700"
      }`}
    >
      <div className="flex items-center justify-between gap-1">
        <span className="text-[10px] uppercase tracking-widest text-zinc-500 font-mono font-medium">{label}</span>
        {active && <span className="w-1.5 h-1.5 rounded-full bg-green-400 shadow-[0_0_6px_#4ade80]" />}
      </div>
      <div className="my-1">
        <span className={`text-2xl font-mono font-bold tracking-tight ${accent ?? "text-zinc-100"}`}>
          {value}
        </span>
      </div>
      {sub && <div className="text-[11px] font-mono text-zinc-500">{sub}</div>}
    </div>
  );
}

// ── HotSpotCard ──────────────────────────────────────────────────────────────

function HotSpotCard({
  cluster,
  rank,
  onView,
}: {
  cluster: ClusterResult;
  rank: number;
  onView: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    const cleanSample = cluster.sample_raw ? cluster.sample_raw.trim() : cluster.template;
    const text = [
      `### Sitecore Issue Report (Top #${rank})`,
      `- **Severity:** ${cluster.level ?? "ERROR"}`,
      `- **Occurrences:** ${cluster.count.toLocaleString()}`,
      `- **First Seen:** ${formatTs(cluster.first_seen)}`,
      `- **Last Seen:** ${formatTs(cluster.last_seen)}`,
      `- **Pattern:** \`${cluster.template}\``,
      "",
      "```",
      cleanSample,
      "```",
    ].join("\n");

    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div
      onClick={onView}
      className="group relative rounded-xl border border-red-500/25 bg-red-950/10 hover:bg-red-950/20 p-4 transition-all hover:border-red-500/50 cursor-pointer"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="flex items-center justify-center w-5 h-5 rounded-full bg-red-500/20 text-red-400 font-mono text-[10px] font-bold">
            #{rank}
          </span>
          <LevelBadge level={cluster.level} />
          <span className="text-red-400 font-mono font-bold text-sm">
            ×{cluster.count.toLocaleString()} occurrences
          </span>
          <span className="text-zinc-600 text-[10px] font-mono">
            ({formatTs(cluster.first_seen, true)} → {formatTs(cluster.last_seen, true)})
          </span>
        </div>

        <button
          onClick={handleCopy}
          className="text-left sm:text-right font-mono text-xs text-zinc-400 hover:text-green-400 hover:drop-shadow-[0_0_8px_rgba(74,222,128,0.5)] transition-all cursor-pointer shrink-0"
          title="Copy markdown formatted summary for Jira, GitHub, or AI prompts"
        >
          {copied ? "[ ✓ copied to clipboard ]" : "[ copy for ticket / AI ]"}
        </button>
      </div>

      <p className="font-mono text-xs text-zinc-300 line-clamp-2 break-all group-hover:text-zinc-100 transition-colors">
        {cluster.sample_raw ? cluster.sample_raw.split("\n")[0] : cluster.template}
      </p>
    </div>
  );
}

// ── CopyButton ────────────────────────────────────────────────────────────────

function CopyBtn({ label, getText }: { label: string; getText: () => string }) {
  const [flash, setFlash] = useState(false);
  const handle = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(getText()).then(() => {
      setFlash(true);
      setTimeout(() => setFlash(false), 1500);
    });
  };
  return (
    <button
      onClick={handle}
      className={`font-mono text-xs transition-all cursor-pointer ${
        flash
          ? "text-green-400 drop-shadow-[0_0_8px_rgba(74,222,128,0.5)] font-bold"
          : "text-zinc-500 hover:text-green-400 hover:drop-shadow-[0_0_8px_rgba(74,222,128,0.5)]"
      }`}
    >
      {flash ? "[ ✓ copied ]" : `[ ${label} ]`}
    </button>
  );
}

// ── OccurrencesList ───────────────────────────────────────────────────────────

function OccurrencesList({
  occurrences,
  truncated,
  totalCount,
}: {
  occurrences: OccurrenceRecord[];
  truncated: boolean;
  totalCount: number;
}) {
  if (!occurrences.length) return null;
  return (
    <div
      className="max-h-48 overflow-y-auto rounded border border-zinc-800 bg-black/30 text-[10px] font-mono"
      onClick={(e) => e.stopPropagation()}
    >
      <table className="w-full">
        <thead className="sticky top-0 bg-zinc-950">
          <tr>
            <th className="text-left px-2 py-1 text-zinc-600 font-normal w-40 border-b border-zinc-800">timestamp</th>
            <th className="text-left px-2 py-1 text-zinc-600 font-normal border-b border-zinc-800">raw</th>
          </tr>
        </thead>
        <tbody>
          {occurrences.map((occ, i) => (
            <tr key={i} className="border-b border-zinc-900 last:border-0 hover:bg-zinc-900/40">
              <td className="px-2 py-0.5 text-zinc-600 whitespace-nowrap align-top tabular-nums">
                {formatTs(occ.timestamp, true)}
              </td>
              <td className="px-2 py-0.5 text-zinc-400 break-all align-top">
                {occ.raw.split("\n")[0]}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && (
        <div className="px-3 py-1.5 text-zinc-700 italic border-t border-zinc-800">
          showing first {occurrences.length} of {totalCount.toLocaleString()} occurrences
        </div>
      )}
    </div>
  );
}

// ── ClusterCard ───────────────────────────────────────────────────────────────

function ClusterCard({
  cluster,
  index,
  isExpanded,
  onToggle,
  isHighSev,
  search,
}: {
  cluster: ClusterResult;
  index: number;
  isExpanded: boolean;
  onToggle: () => void;
  isHighSev: boolean;
  search: string;
}) {
  const [showOccurrences, setShowOccurrences] = useState(false);
  const color = levelColor(cluster.level);

  useEffect(() => {
    if (!isExpanded) setShowOccurrences(false);
  }, [isExpanded]);

  const clusterText = () =>
    [
      `[${cluster.level ?? "NONE"}] ×${cluster.count} | ${formatTs(cluster.first_seen)} → ${formatTs(cluster.last_seen)}`,
      cluster.template,
      cluster.parameters.length
        ? "  Parameters: " +
          cluster.parameters
            .map((p) =>
              p.type === "numeric"
                ? `pos${p.position}: ${formatNum(p.min)}–${formatNum(p.max)} (avg ${formatNum(p.avg)})`
                : `pos${p.position}: ${p.distinct_count} values${p.examples ? " [" + p.examples.join(", ") + "]" : ""}`
            )
            .join("; ")
        : "",
      "",
      "Sample:",
      cluster.sample_raw ?? "",
    ]
      .filter((l) => l !== "")
      .join("\n");

  const occurrencesText = () => {
    const lines = cluster.occurrences.map(
      (o) => `${o.timestamp ?? "?"}  ${o.raw.split("\n")[0]}`
    );
    if (cluster.occurrences_truncated) {
      lines.push(`… (${cluster.count - cluster.occurrences.length} more occurrences not shown)`);
    }
    return lines.join("\n");
  };

  return (
    <div
      id={`cluster-${cluster.cluster_id}`}
      className={`rounded-lg border cursor-pointer transition-colors select-none ${
        isHighSev ? color : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-700"
      }`}
      onClick={onToggle}
    >
      {/* Compact header — always visible */}
      <div className="flex items-center gap-2 px-3 py-2 min-w-0">
        <span className="text-zinc-700 text-[10px] w-5 shrink-0 text-right tabular-nums">{index}</span>
        <LevelBadge level={cluster.level} />
        <span
          className={`text-xs font-mono font-bold shrink-0 tabular-nums ${
            isHighSev ? "text-current" : "text-zinc-500"
          }`}
        >
          ×{cluster.count.toLocaleString()}
        </span>
        <span
          className={`flex-1 text-xs font-mono truncate min-w-0 ${
            isHighSev ? "text-zinc-200" : "text-zinc-400"
          }`}
          title={cluster.template}
        >
          <TemplateDisplay
            template={cluster.template}
            params={cluster.parameters}
            search={search}
          />
        </span>
        <span className="text-zinc-700 text-[10px] shrink-0 hidden sm:inline tabular-nums">
          {formatTs(cluster.first_seen, true)}
        </span>
        <span className="text-zinc-700 text-[10px] shrink-0 ml-1">
          {isExpanded ? "▲" : "▼"}
        </span>
      </div>

      {/* Expanded body — NOT mounted when collapsed */}
      {isExpanded && (
        <div
          className="px-3 pb-3 space-y-3 border-t border-white/5"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Full template */}
          <div className="pt-2">
            <TemplateDisplay
              template={cluster.template}
              params={cluster.parameters}
              search={search}
              className="text-xs font-mono text-zinc-300 break-all leading-relaxed"
            />
          </div>

          {/* Timestamp range */}
          <div className="flex gap-4 text-[10px] font-mono text-zinc-600">
            <span>first: {formatTs(cluster.first_seen)}</span>
            <span>last:  {formatTs(cluster.last_seen)}</span>
          </div>

          {/* Parameter stats */}
          {cluster.parameters.length > 0 && (
            <div className="rounded border border-zinc-800 overflow-hidden text-[10px] font-mono">
              <div className="px-2 py-1 bg-zinc-900 text-zinc-600 border-b border-zinc-800 flex gap-2">
                <span className="w-5 text-right">#</span>
                <span className="w-14">type</span>
                <span className="flex-1">value range / examples</span>
                <span className="w-16 text-right">distinct</span>
              </div>
              {cluster.parameters.map((p) => (
                <div key={p.position} className="flex gap-2 px-2 py-1 border-b border-zinc-900 last:border-0 items-center">
                  <span className="w-5 text-right text-zinc-700">{p.position}</span>
                  <span
                    className={`w-14 rounded px-1 text-center ${
                      p.type === "numeric"
                        ? "text-amber-400 bg-amber-500/10"
                        : "text-cyan-400 bg-cyan-500/10"
                    }`}
                  >
                    {p.type}
                  </span>
                  <span className="flex-1 text-zinc-300">
                    {p.type === "numeric" ? (
                      <>
                        {formatNum(p.min)} – {formatNum(p.max)}
                        <span className="text-zinc-600 ml-2">(avg {formatNum(p.avg)})</span>
                      </>
                    ) : (
                      <span className="text-zinc-400">
                        {(p.examples ?? []).slice(0, 3).join("  ·  ")}
                        {(p.examples?.length ?? 0) < p.distinct_count ? "  …" : ""}
                      </span>
                    )}
                  </span>
                  <span className="w-16 text-right text-zinc-600 tabular-nums">
                    {p.distinct_count.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Copy actions */}
          <div className="flex items-center gap-2 flex-wrap">
            <CopyBtn label="copy cluster" getText={clusterText} />
            {cluster.occurrences.length > 0 && (
              <CopyBtn
                label={`copy ${cluster.occurrences_truncated
                  ? `first ${cluster.occurrences.length}`
                  : cluster.occurrences.length} occurrence${cluster.occurrences.length !== 1 ? "s" : ""}`}
                getText={occurrencesText}
              />
            )}
          </div>

          {/* Sample raw */}
          {cluster.sample_raw && (
            <pre className="text-[11px] font-mono text-zinc-400 whitespace-pre-wrap break-all bg-black/40 rounded p-2 max-h-40 overflow-y-auto border border-zinc-800">
              {cluster.sample_raw}
            </pre>
          )}

          {/* Occurrence drill-down */}
          {cluster.occurrences.length > 0 && (
            <div>
              <button
                className="text-[10px] font-mono text-zinc-500 hover:text-zinc-300 transition-colors flex items-center gap-1.5"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowOccurrences((v) => !v);
                }}
              >
                <span>{showOccurrences ? "▲" : "▼"}</span>
                {showOccurrences ? "hide" : "show"} all occurrences (
                {cluster.count.toLocaleString()}
                {cluster.occurrences_truncated
                  ? `, first ${cluster.occurrences.length} shown`
                  : ""})
              </button>
              {showOccurrences && (
                <div className="mt-1.5">
                  <OccurrencesList
                    occurrences={cluster.occurrences}
                    truncated={cluster.occurrences_truncated}
                    totalCount={cluster.count}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function Sidebar({
  open,
  search, setSearch,
  levelFilter, setLevelFilter,
  sortKey, setSortKey,
  onCollapseAll, onExpandAll,
  totalClusters, highCount, warnCount, infoCount,
}: {
  open: boolean;
  search: string; setSearch: (s: string) => void;
  levelFilter: LevelFilter; setLevelFilter: (f: LevelFilter) => void;
  sortKey: SortKey; setSortKey: (s: SortKey) => void;
  onCollapseAll: () => void; onExpandAll: () => void;
  totalClusters: number; highCount: number; warnCount: number; infoCount: number;
}) {
  const filters: [LevelFilter, string, string, string][] = [
    ["all",   "All",  `${totalClusters}`, "border-zinc-700 text-zinc-300 hover:border-zinc-600"],
    ["error", "Error / Audit", `${highCount}`,   "border-red-500/40 text-red-400 bg-red-500/5 hover:bg-red-500/10"],
    ["warn",  "Warn", `${warnCount}`,  "border-amber-500/40 text-amber-400 bg-amber-500/5 hover:bg-amber-500/10"],
    ["info",  "Info / Debug", `${infoCount}`,  "border-cyan-500/40 text-cyan-400 bg-cyan-500/5 hover:bg-cyan-500/10"],
  ];

  if (!open) return null;

  return (
    <aside
      className="fixed top-[57px] bottom-0 left-0 z-30 flex flex-col bg-zinc-950 border-r border-zinc-800 overflow-y-auto"
      style={{ width: SIDEBAR_W }}
    >
      <div className="p-4 space-y-5 flex-1">

        {/* Search */}
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase tracking-widest text-zinc-600 font-mono block">Search</label>
          <input
            id="cluster-search"
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="search clusters…"
            className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 font-mono text-[11px] text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-green-500/50 focus:ring-1 focus:ring-green-500/20 transition-colors"
          />
        </div>

        <div className="h-px bg-zinc-800" />

        {/* Level filter */}
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase tracking-widest text-zinc-600 font-mono block">Filter</label>
          <div className="space-y-1">
            {filters.map(([key, label, count, activeBase]) => (
              <button
                key={key}
                id={`filter-${key}`}
                onClick={() => setLevelFilter(key)}
                className={`w-full flex items-center justify-between px-3 py-1.5 rounded-lg border text-[11px] font-mono transition-colors ${
                  levelFilter === key
                    ? activeBase + " opacity-100"
                    : "border-zinc-800 text-zinc-600 hover:text-zinc-400 hover:border-zinc-700"
                }`}
              >
                <span>{label}</span>
                <span className="tabular-nums text-[10px] opacity-70">{count}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="h-px bg-zinc-800" />

        {/* Sort */}
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase tracking-widest text-zinc-600 font-mono block">Sort by</label>
          <div className="flex gap-1.5">
            {([["count", "frequency"], ["first_seen", "time"]] as [SortKey, string][]).map(([key, label]) => (
              <button
                key={key}
                id={`sort-${key}`}
                onClick={() => setSortKey(key)}
                className={`flex-1 py-1.5 rounded-lg border text-[11px] font-mono transition-colors ${
                  sortKey === key
                    ? "border-green-500/40 text-green-400 bg-green-500/10"
                    : "border-zinc-800 text-zinc-600 hover:text-zinc-400 hover:border-zinc-700"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="h-px bg-zinc-800" />

        {/* Bulk actions */}
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase tracking-widest text-zinc-600 font-mono block">View</label>
          <div className="flex gap-1.5">
            <button
              id="collapse-all-btn"
              onClick={onCollapseAll}
              className="flex-1 py-1.5 rounded-lg border border-zinc-800 text-[11px] font-mono text-zinc-600 hover:text-zinc-400 hover:border-zinc-700 transition-colors"
            >
              collapse all
            </button>
            <button
              id="expand-all-btn"
              onClick={onExpandAll}
              className="flex-1 py-1.5 rounded-lg border border-zinc-800 text-[11px] font-mono text-zinc-600 hover:text-zinc-400 hover:border-zinc-700 transition-colors"
            >
              expand all
            </button>
          </div>
        </div>
      </div>

      {/* Sidebar footer */}
      <div className="p-4 border-t border-zinc-800 text-[10px] font-mono text-zinc-700 text-center">
        {totalClusters.toLocaleString()} clusters
      </div>
    </aside>
  );
}

// ── PaginationBar ─────────────────────────────────────────────────────────────

function PaginationBar({ page, totalPages, total, onPrev, onNext }: {
  page: number; totalPages: number; total: number;
  onPrev: () => void; onNext: () => void;
}) {
  if (totalPages <= 1) return null;
  const start = page * PAGE_SIZE + 1;
  const end = Math.min((page + 1) * PAGE_SIZE, total);
  return (
    <div className="flex items-center justify-center gap-3 py-2 font-mono text-xs text-zinc-500">
      <button id="page-prev" onClick={onPrev} disabled={page === 0}
        className="px-3 py-1 rounded border border-zinc-800 hover:border-zinc-700 hover:text-zinc-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
        ← prev
      </button>
      <span className="tabular-nums">{start}–{end} of {total.toLocaleString()}</span>
      <button id="page-next" onClick={onNext} disabled={page >= totalPages - 1}
        className="px-3 py-1 rounded border border-zinc-800 hover:border-zinc-700 hover:text-zinc-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
        next →
      </button>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse Sitecore log filename into human-readable parts.
 *  Handles formats like:
 *    Log.6k5m8.20260722.083023.txt
 *    Client.log.6k5m8.20260722.083024.txt
 *    ContentTransfer.log.6k5m8.20260722.083024.txt
 */
function parseLogName(name: string): { type: string; date: string; time: string; raw: string } {
  const base = name.replace(/\.txt$/i, "");
  const parts = base.split(".");
  // Find 8-digit date part (YYYYMMDD)
  const dateIdx = parts.findIndex((p) => /^\d{8}$/.test(p));
  if (dateIdx >= 1) {
    const d = parts[dateIdx];
    const t = parts[dateIdx + 1] ?? "";
    // Type = everything before the instanceId (dateIdx - 1 is instanceId)
    const typeParts = parts.slice(0, Math.max(1, dateIdx - 1)).filter((p) => p.toLowerCase() !== "log" || dateIdx <= 2);
    const type = typeParts.join(".") || parts[0];
    const date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    const time = t.length === 6 ? `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}` : t;
    return { type, date, time, raw: name };
  }
  return { type: name, date: "", time: "", raw: name };
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── SitecoreConnectorPanel ────────────────────────────────────────────────────
// Always mounted (parent uses CSS hide/show). State survives tab switches.

type SCPhase = "idle" | "auth_pending" | "authenticated" | "no_access" | "env_selected" | "log_selected" | "fetching";

interface SCState {
  phase: SCPhase;
  sessionId?: string;
  deviceCode?: string;
  userCode?: string;
  verificationUri?: string;
  interval?: number;
  environmentId?: string;
  environmentName?: string;
  logName?: string;
}

function SitecoreConnectorPanel({
  onResult,
  startTime,
  endTime,
  formatOverride,
}: {
  onResult: (res: CompressionResponse, label: string, meta?: SitecoreMeta) => void;
  startTime: string;
  endTime: string;
  formatOverride: string;
}) {
  const [sc, setSc] = useState<SCState>({ phase: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [orgInfo, setOrgInfo] = useState<SitecoreOrgInfo | null>(null);
  const [environments, setEnvironments] = useState<SitecoreEnvironment[]>([]);
  const [logs, setLogs] = useState<SitecoreLogFile[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [logSearch, setLogSearch] = useState("");
  const [selectedEnvId, setSelectedEnvId] = useState("");
  const [selectedLog, setSelectedLog] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Restore saved session on mount
  useEffect(() => {
    const savedSessionId = localStorage.getItem("logtidy_sc_session_id");
    const savedEnvId = localStorage.getItem("logtidy_sc_env_id");
    const savedOrgName = localStorage.getItem("logtidy_sc_org_name");
    const savedOrgId = localStorage.getItem("logtidy_sc_org_id");

    if (savedOrgName || savedOrgId) {
      setOrgInfo({ id: savedOrgId || "", name: savedOrgName || savedOrgId || "" });
    }

    if (savedSessionId) {
      setSc({ phase: "authenticated", sessionId: savedSessionId });
      getSitecoreEnvironments(savedSessionId)
        .then((res) => {
          setEnvironments(res.environments);
          if (res.organization?.name || res.organization?.id) {
            setOrgInfo(res.organization);
            localStorage.setItem("logtidy_sc_org_name", res.organization.name || "");
            localStorage.setItem("logtidy_sc_org_id", res.organization.id || "");
          }
          if (savedEnvId && res.environments.some((e) => e.id === savedEnvId)) {
            setSelectedEnvId(savedEnvId);
            setLoadingLogs(true);
            getSiteCoreLogs(savedSessionId, savedEnvId)
              .then((files) => {
                setLogs(files);
                const env = res.environments.find((e) => e.id === savedEnvId);
                setSc({
                  phase: "env_selected",
                  sessionId: savedSessionId,
                  environmentId: savedEnvId,
                  environmentName: env?.name ?? savedEnvId,
                });
              })
              .catch(() => {})
              .finally(() => setLoadingLogs(false));
          }
        })
        .catch(() => {
          localStorage.removeItem("logtidy_sc_session_id");
          localStorage.removeItem("logtidy_sc_org_name");
          localStorage.removeItem("logtidy_sc_org_id");
          localStorage.removeItem("logtidy_sc_env_id");
          setSc({ phase: "idle" });
        });
    }

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const handleConnect = useCallback(async () => {
    setError(null);
    try {
      const data = await startSitecoreAuth();
      setSc({
        phase: "auth_pending",
        sessionId: data.session_id,
        deviceCode: data.device_code,
        userCode: data.user_code,
        verificationUri: data.verification_uri,
        interval: data.interval,
      });

      // Auto-open the auth URL — user doesn't have to do anything manually
      window.open(data.verification_uri, "_blank", "noopener,noreferrer");

      const intervalMs = (data.interval + 1) * 1000;
      pollRef.current = setInterval(async () => {
        try {
          const poll = await pollSitecoreAuth(data.session_id, data.device_code);
          if (poll.status === "ok") {
            clearInterval(pollRef.current!);
            localStorage.setItem("logtidy_sc_session_id", data.session_id);
            try {
              const res = await getSitecoreEnvironments(data.session_id);
              setEnvironments(res.environments);
              if (res.organization?.name || res.organization?.id) {
                setOrgInfo(res.organization);
                localStorage.setItem("logtidy_sc_org_name", res.organization.name || "");
                localStorage.setItem("logtidy_sc_org_id", res.organization.id || "");
              }
              setSc({ phase: "authenticated", sessionId: data.session_id });
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : "Failed to load environments";
              const is403 = msg.includes("403") || msg.toLowerCase().includes("permission") || msg.toLowerCase().includes("access");
              if (is403) {
                setSc({ phase: "no_access", sessionId: data.session_id });
              } else {
                setError(msg);
                setSc({ phase: "idle" });
              }
            }
          } else if (poll.status === "expired") {
            clearInterval(pollRef.current!);
            setError("Login window expired. Click Connect to try again.");
            setSc({ phase: "idle" });
          }
        } catch (e: unknown) {
          clearInterval(pollRef.current!);
          setError(e instanceof Error ? e.message : "Polling error");
          setSc({ phase: "idle" });
        }
      }, intervalMs);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to start authentication");
    }
  }, []);

  const handleDisconnect = useCallback(() => {
    if (sc.sessionId) disconnectSitecore(sc.sessionId).catch(() => {});
    if (pollRef.current) clearInterval(pollRef.current);
    localStorage.removeItem("logtidy_sc_session_id");
    localStorage.removeItem("logtidy_sc_org_name");
    localStorage.removeItem("logtidy_sc_org_id");
    localStorage.removeItem("logtidy_sc_env_id");
    setSc({ phase: "idle" });
    setOrgInfo(null);
    setEnvironments([]);
    setLogs([]);
    setSelectedEnvId("");
    setSelectedLog("");
    setError(null);
  }, [sc.sessionId]);

  const handleEnvChange = useCallback(async (envId: string) => {
    setSelectedEnvId(envId);
    setSelectedLog("");
    setLogs([]);
    setLogSearch("");
    if (!envId || !sc.sessionId) {
      localStorage.removeItem("logtidy_sc_env_id");
      return;
    }
    localStorage.setItem("logtidy_sc_env_id", envId);
    setError(null);
    setLoadingLogs(true);
    try {
      const logFiles = await getSiteCoreLogs(sc.sessionId, envId);
      setLogs(logFiles);
      const env = environments.find((e) => e.id === envId);
      setSc((s) => ({
        ...s,
        phase: "env_selected",
        environmentId: envId,
        environmentName: env?.name ?? envId,
      }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to load logs";
      const is403 = msg.includes("403") || msg.toLowerCase().includes("permission");
      setError(is403 ? "You don't have permission to view logs for this environment." : msg);
    } finally {
      setLoadingLogs(false);
    }
  }, [sc.sessionId, environments]);

  const handleLogSelect = useCallback((logName: string) => {
    setSelectedLog(logName);
    setSc((s) => ({ ...s, phase: "log_selected", logName }));
  }, []);

  const handleFetch = useCallback(async () => {
    if (sc.phase !== "log_selected" || !sc.sessionId || !sc.environmentId || !sc.logName) return;
    const { sessionId, environmentId, logName } = sc;
    setSc((s) => ({ ...s, phase: "fetching" }));
    setError(null);
    try {
      const res = await fetchAndCompressSitecoreLog(
        sessionId, environmentId, logName,
        startTime || null, endTime || null, formatOverride || null,
      );
      const env = environments.find((e) => e.id === environmentId);
      onResult(res, logName, {
        orgName: orgInfo?.name,
        orgId: orgInfo?.id,
        projectName: env?.projectName,
        envName: env?.name,
        envId: environmentId,
        logName,
      });
      setSc((s) => ({ ...s, phase: "log_selected" }));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to fetch log");
      setSc((s) => ({ ...s, phase: "log_selected" }));
    }
  }, [sc, startTime, endTime, formatOverride, onResult, environments, orgInfo]);

  // Group environments by project for XM Cloud dashboard card layout
  const projects = useMemo(() => {
    const map = new Map<string, SitecoreEnvironment[]>();
    for (const env of environments) {
      const p = env.projectName || "Default Project";
      if (!map.has(p)) map.set(p, []);
      map.get(p)!.push(env);
    }
    return Array.from(map.entries()).map(([projectName, envs]) => ({ projectName, envs }));
  }, [environments]);

  const filteredLogs = useMemo(() => {
    if (!logSearch.trim()) return logs;
    const q = logSearch.toLowerCase();
    return logs.filter((l) => l.name.toLowerCase().includes(q) || l.type.toLowerCase().includes(q));
  }, [logs, logSearch]);

  const { phase } = sc;
  const isConnected = !["idle", "auth_pending", "no_access"].includes(phase);

  return (
    <div className="space-y-5">

      {/* ── Idle: connect button */}
      {phase === "idle" && (
        <button
          id="sc-connect-btn"
          onClick={handleConnect}
          className="w-full py-3.5 rounded-xl border border-zinc-700/60 bg-zinc-900/60 text-zinc-300 font-mono text-sm hover:border-green-500/40 hover:bg-zinc-800/60 hover:text-green-400 transition-all duration-200 cursor-pointer"
        >
          Connect to Sitecore Cloud →
        </button>
      )}

      {/* ── Auth pending: code display */}
      {phase === "auth_pending" && sc.userCode && (
        <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/40 overflow-hidden">
          <div className="px-5 pt-5 pb-4 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono uppercase tracking-[0.15em] text-zinc-500">Sitecore Cloud — Sign in</span>
              <span className="flex items-center gap-1.5 text-[10px] font-mono text-zinc-600">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse inline-block" />
                waiting for login
              </span>
            </div>

            {/* The code */}
            <div className="flex items-center justify-center py-5">
              <span className="font-mono text-4xl font-bold tracking-[0.25em] text-white tabular-nums select-all">
                {sc.userCode}
              </span>
            </div>

            <p className="text-[11px] font-mono text-zinc-500 text-center leading-relaxed">
              A browser window opened — enter this code to complete sign in.<br />
              <span className="text-zinc-600">Nothing opened?{" "}
                <button
                  onClick={() => window.open(sc.verificationUri, "_blank", "noopener,noreferrer")}
                  className="text-cyan-500 hover:text-cyan-400 underline transition-colors cursor-pointer"
                >
                  Open manually
                </button>
              </span>
            </p>
          </div>

          <div className="border-t border-zinc-800 px-5 py-3 flex justify-between items-center">
            <div className="flex items-center gap-2">
              <span className="inline-block w-3 h-3 border-2 border-zinc-700 border-t-green-400 rounded-full animate-spin" />
              <span className="text-[10px] font-mono text-zinc-600">polling for confirmation…</span>
            </div>
            <button
              onClick={handleDisconnect}
              className="text-[10px] font-mono text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
            >
              cancel
            </button>
          </div>
        </div>
      )}

      {/* ── No access state */}
      {phase === "no_access" && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-5 space-y-3">
          <div className="flex items-start gap-3">
            <span className="text-amber-400 text-lg mt-0.5">⚠</span>
            <div className="space-y-1">
              <p className="text-sm font-mono text-amber-300 font-medium">Insufficient permissions</p>
              <p className="text-[11px] font-mono text-zinc-500 leading-relaxed">
                Your account is authenticated but doesn't have the role required to access XM Cloud environments or logs.
                Contact your Sitecore org admin to request access.
              </p>
            </div>
          </div>
          <button
            onClick={handleDisconnect}
            className="text-[10px] font-mono text-red-400/80 hover:text-red-300 hover:drop-shadow-[0_0_8px_rgba(239,68,68,0.5)] transition-all cursor-pointer"
          >
            ← disconnect and try a different account
          </button>
        </div>
      )}

      {/* ── Connected State */}
      {isConnected && (
        <div className="space-y-4">
          {/* Status bar with Org display and glowing red Disconnect button */}
          <div className="flex items-center justify-between gap-3 pb-2 border-b border-zinc-800/80">
            <div className="flex items-center gap-2 min-w-0">
              <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block shadow-[0_0_6px_#34d399] shrink-0" />
              <span className="text-xs font-mono text-emerald-400 font-bold shrink-0">
                Connected to Sitecore Cloud
              </span>
              {orgInfo?.name && (
                <span className="text-xs font-mono text-zinc-400 truncate">
                  — <span className="font-semibold text-zinc-200">{orgInfo.name}</span>
                </span>
              )}
            </div>
            <button
              id="sc-disconnect-btn"
              onClick={handleDisconnect}
              className="text-[10px] font-mono text-red-500/80 hover:text-red-400 hover:drop-shadow-[0_0_8px_rgba(239,68,68,0.5)] transition-all cursor-pointer shrink-0"
              title="Disconnect from Sitecore Cloud"
            >
              disconnect
            </button>
          </div>

          {/* XM Cloud-style Project & Environment Cards */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-[10px] font-mono uppercase tracking-[0.12em] text-zinc-500">
                Environments ({environments.length})
              </label>
              {selectedEnvId && (
                <button
                  onClick={() => {
                    setSelectedEnvId("");
                    setSelectedLog("");
                    setLogs([]);
                    localStorage.removeItem("logtidy_sc_env_id");
                  }}
                  className="text-[10px] font-mono text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
                >
                  clear selection
                </button>
              )}
            </div>

            {environments.length === 0 ? (
              <p className="text-xs font-mono text-zinc-600 py-3">No environments found for this account.</p>
            ) : (
              <div className="space-y-4">
                {projects.map(({ projectName, envs }) => (
                  <div key={projectName} className="space-y-2">
                    <div className="flex items-center gap-2 px-0.5">
                      <span className="text-zinc-500 text-xs">📁</span>
                      <span className="text-xs font-mono font-medium text-zinc-300">{projectName}</span>
                      <span className="text-[10px] font-mono text-zinc-600">
                        ({envs.length} {envs.length === 1 ? "env" : "envs"})
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                      {envs.map((env) => {
                        const isSelected = selectedEnvId === env.id;
                        const isProd = env.isProduction || env.target?.toLowerCase() === "production" || env.name.toLowerCase().includes("prod");
                        return (
                          <button
                            key={env.id}
                            type="button"
                            onClick={() => handleEnvChange(env.id)}
                            className={`text-left p-3.5 rounded-xl border transition-all duration-150 flex flex-col justify-between gap-3 group cursor-pointer ${
                              isSelected
                                ? "bg-green-500/8 border-green-500/50 ring-1 ring-green-500/30 shadow-[0_0_15px_rgba(34,197,94,0.08)]"
                                : "bg-zinc-900/60 border-zinc-800 hover:border-zinc-700 hover:bg-zinc-900/90"
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2 w-full">
                              <div className="min-w-0">
                                <div className={`text-xs font-mono font-bold truncate ${isSelected ? "text-zinc-100" : "text-zinc-300 group-hover:text-white"}`}>
                                  {env.name}
                                </div>
                                {env.branch && (
                                  <div className="text-[10px] font-mono text-zinc-500 truncate flex items-center gap-1 mt-0.5">
                                    <span className="text-zinc-600">⎇</span> {env.branch}
                                  </div>
                                )}
                              </div>
                              <span className={`shrink-0 text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border font-bold ${
                                isProd
                                  ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/30"
                                  : "text-zinc-400 bg-zinc-800/80 border-zinc-700/60"
                              }`}>
                                {isProd ? "PROD" : "NON-PROD"}
                              </span>
                            </div>

                            <div className="flex items-center justify-between gap-2 w-full pt-1.5 border-t border-zinc-800/50 text-[10px] font-mono">
                              <span className="flex items-center gap-1.5 text-zinc-400">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block shadow-[0_0_4px_#34d399]" />
                                {env.provisioningStatus || "Ready"}
                              </span>
                              {env.zone && (
                                <span className="text-[9px] text-zinc-600 truncate">{env.zone}</span>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Log file list with search filter */}
          {selectedEnvId && (
            <div className="space-y-2 pt-2 border-t border-zinc-800/60">
              <div className="flex items-center justify-between gap-3">
                <label className="text-[10px] font-mono uppercase tracking-[0.12em] text-zinc-500">
                  Log files
                  <span className="ml-1 text-zinc-400 font-semibold">
                    ({environments.find(e => e.id === selectedEnvId)?.name})
                  </span>
                  <span className="ml-2 text-zinc-600">
                    {filteredLogs.length} {filteredLogs.length !== logs.length ? `of ${logs.length}` : ""}
                  </span>
                </label>
                {logs.length > 4 && (
                  <input
                    type="text"
                    value={logSearch}
                    onChange={(e) => setLogSearch(e.target.value)}
                    placeholder="Filter logs…"
                    className="bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1 text-[11px] font-mono text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-green-500/40 w-44"
                  />
                )}
              </div>

              {loadingLogs ? (
                <div className="py-8 flex items-center justify-center gap-2 text-xs font-mono text-zinc-500">
                  <span className="inline-block w-3.5 h-3.5 border-2 border-zinc-700 border-t-green-400 rounded-full animate-spin" />
                  Loading logs from Sitecore Cloud…
                </div>
              ) : logs.length === 0 ? (
                <p className="text-xs font-mono text-zinc-600 py-4">No log files available for this environment.</p>
              ) : filteredLogs.length === 0 ? (
                <p className="text-xs font-mono text-zinc-600 py-4">No logs matching "{logSearch}".</p>
              ) : (
                <div className="rounded-lg border border-zinc-800 divide-y divide-zinc-800/60 max-h-64 overflow-y-auto">
                  {filteredLogs.map((log) => {
                    const parsed = parseLogName(log.name);
                    const isSelected = selectedLog === log.name;
                    return (
                      <button
                        key={log.name}
                        type="button"
                        onClick={() => handleLogSelect(log.name)}
                        className={`w-full text-left px-3 py-2.5 flex items-center justify-between gap-3 transition-colors group cursor-pointer ${
                          isSelected
                            ? "bg-green-500/10 border-l-2 border-l-green-500"
                            : "hover:bg-zinc-800/40"
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          {/* Type badge */}
                          <span className={`shrink-0 text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border ${
                            isSelected
                              ? "border-green-500/40 text-green-400 bg-green-500/10"
                              : "border-zinc-700 text-zinc-500 bg-zinc-900"
                          }`}>
                            {parsed.type}
                          </span>
                          {/* Date + time */}
                          <div className="min-w-0">
                            {parsed.date ? (
                              <div className="flex items-center gap-2">
                                <span className={`text-xs font-mono ${isSelected ? "text-zinc-200 font-bold" : "text-zinc-400"}`}>
                                  {parsed.date}
                                </span>
                                <span className="text-[10px] font-mono text-zinc-600">{parsed.time}</span>
                              </div>
                            ) : (
                              <span className="text-xs font-mono text-zinc-400 truncate">{log.name}</span>
                            )}
                          </div>
                        </div>
                        {/* Size */}
                        <span className="shrink-0 text-[10px] font-mono text-zinc-600">
                          {formatBytes(log.size)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/8 px-4 py-3 text-xs font-mono text-red-400 leading-relaxed">
          {error}
        </div>
      )}

      {/* Compress button */}
      {phase === "log_selected" && (
        <button
          id="sc-compress-btn"
          onClick={handleFetch}
          className="w-full py-3.5 rounded-xl bg-green-500 hover:bg-green-400 text-zinc-950 font-mono font-bold text-sm tracking-wider transition-all duration-200 active:scale-[0.99] cursor-pointer"
        >
          [ compress ]
        </button>
      )}
      {phase === "fetching" && (
        <button disabled className="w-full py-3.5 rounded-xl bg-zinc-800 text-zinc-600 font-mono font-bold text-sm tracking-wider cursor-not-allowed">
          <span className="flex items-center justify-center gap-2.5">
            <span className="inline-block w-4 h-4 border-2 border-zinc-700 border-t-green-400 rounded-full animate-spin" />
            fetching log…
          </span>
        </button>
      )}
    </div>
  );
}







// ── Main page ─────────────────────────────────────────────────────────────────



// ── Main page ─────────────────────────────────────────────────────────────────

export default function Home() {
  // ── Source picker ─────────────────────────────────────────────────────────
  const [source, setSource] = useState<"paste" | "sitecore">("paste");

  // ── Input ────────────────────────────────────────────────────────────────
  const [logText, setLogText]           = useState("");
  const [file, setFile]                 = useState<File | null>(null);
  const [startTime, setStartTime]       = useState("");
  const [endTime, setEndTime]           = useState("");
  const [formatOverride, setFormatOverride] = useState("");
  const [availableFormats, setAvailableFormats] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  // ── Request ───────────────────────────────────────────────────────────────
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [result, setResult]     = useState<CompressionResponse | null>(null);

  // ── Session history ───────────────────────────────────────────────────────
  const [history, setHistory]             = useState<SessionEntry[]>([]);
  const [activeHistoryId, setActiveHistoryId] = useState<string | null>(null);
  const [activeSitecoreMeta, setActiveSitecoreMeta] = useState<SitecoreMeta | null>(null);

  // ── Results view ──────────────────────────────────────────────────────────
  const [sortKey, setSortKey]         = useState<SortKey>("count");
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");
  const [search, setSearch]           = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [showAll, setShowAll]   = useState(false);
  const [page, setPage]         = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // ── Load available formats on mount ──────────────────────────────────────
  useEffect(() => {
    getFormats().then(setAvailableFormats).catch(() => {});
  }, []);

  // ── Debounce search ───────────────────────────────────────────────────────
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 150);
    return () => clearTimeout(t);
  }, [search]);

  // ── Reset view on new result ──────────────────────────────────────────────
  useEffect(() => {
    if (!result) return;
    const initExpanded = new Set<string>(
      result.clusters
        .filter((c) => HIGH_SEVERITY.has(c.level ?? ""))
        .map((c) => c.template)
    );
    setExpandedKeys(initExpanded);
    setShowAll(false);
    setPage(0);
    setSortKey("count");
    setLevelFilter("all");
    setSearch("");
    setDebouncedSearch("");
    setSidebarOpen(true);
  }, [result]);

  // ── Reset page on filter / sort / search change ───────────────────────────
  useEffect(() => { setPage(0); }, [levelFilter, sortKey, debouncedSearch]);

  // ── Computed data ─────────────────────────────────────────────────────────

  const allSorted = useMemo(() => {
    if (!result) return [];
    return [...result.clusters].sort((a, b) => {
      if (sortKey === "count") return b.count - a.count;
      const ta = a.first_seen ? new Date(a.first_seen).getTime() : 0;
      const tb = b.first_seen ? new Date(b.first_seen).getTime() : 0;
      return ta - tb;
    });
  }, [result, sortKey]);

  const levelFiltered = useMemo(() => {
    switch (levelFilter) {
      case "error": return allSorted.filter((c) => HIGH_SEVERITY.has(c.level ?? ""));
      case "warn":  return allSorted.filter((c) => WARN_LEVELS.has(c.level ?? ""));
      case "info":  return allSorted.filter((c) => !HIGH_SEVERITY.has(c.level ?? "") && !WARN_LEVELS.has(c.level ?? ""));
      default:      return allSorted;
    }
  }, [allSorted, levelFilter]);

  const filteredClusters = useMemo(() => {
    if (!debouncedSearch.trim()) return levelFiltered;
    const q = debouncedSearch.toLowerCase();
    return levelFiltered.filter(
      (c) =>
        c.template.toLowerCase().includes(q) ||
        c.sample_raw?.toLowerCase().includes(q)
    );
  }, [levelFiltered, debouncedSearch]);

  const highSevClusters = useMemo(
    () => filteredClusters.filter((c) => HIGH_SEVERITY.has(c.level ?? "")),
    [filteredClusters]
  );
  const otherClusters = useMemo(
    () => filteredClusters.filter((c) => !HIGH_SEVERITY.has(c.level ?? "")),
    [filteredClusters]
  );

  const isSearching = debouncedSearch.trim().length > 0;
  const totalPages = Math.ceil(otherClusters.length / PAGE_SIZE);
  const visibleOther = useMemo(() => {
    if (isSearching) return otherClusters;
    if (!showAll) return otherClusters.slice(0, PREVIEW_SIZE);
    return otherClusters.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  }, [otherClusters, showAll, page, isSearching]);

  const barStats = useMemo(() => {
    if (!result) return { total: 0, high: 0, warn: 0, info: 0 };
    const total = result.clusters.length;
    const high  = result.clusters.filter((c) => HIGH_SEVERITY.has(c.level ?? "")).length;
    const warn  = result.clusters.filter((c) => WARN_LEVELS.has(c.level ?? "")).length;
    return { total, high, warn, info: total - high - warn };
  }, [result]);

  const errorClusters = useMemo(
    () => result?.clusters.filter((c) => HIGH_SEVERITY.has(c.level ?? "")) ?? [],
    [result]
  );
  const warnClusters = useMemo(
    () => result?.clusters.filter((c) => WARN_LEVELS.has(c.level ?? "")) ?? [],
    [result]
  );
  const infoClusters = useMemo(
    () => result?.clusters.filter((c) => !HIGH_SEVERITY.has(c.level ?? "") && !WARN_LEVELS.has(c.level ?? "")) ?? [],
    [result]
  );

  const sclaCounts = useMemo(() => {
    if (!result) return { error: 0, warn: 0, info: 0, debug: 0, total: 0 };
    if (result.severity_counts) {
      return {
        error: result.severity_counts.error,
        warn: result.severity_counts.warn,
        info: result.severity_counts.info,
        debug: result.severity_counts.debug,
        total: result.lines_in_window,
      };
    }
    let error = 0;
    let warn = 0;
    let info = 0;
    let debug = 0;
    for (const c of result.clusters) {
      const lvl = (c.level ?? "").toUpperCase();
      if (HIGH_SEVERITY.has(lvl)) error += c.count;
      else if (WARN_LEVELS.has(lvl)) warn += c.count;
      else if (lvl === "DEBUG") debug += c.count;
      else info += c.count;
    }
    return { error, warn, info, debug, total: result.lines_in_window };
  }, [result]);

  const topHotSpots = useMemo(() => {
    if (!result) return [];
    const sortedErrors = [...errorClusters].sort((a, b) => b.count - a.count);
    if (sortedErrors.length > 0) return sortedErrors.slice(0, 3);
    const sortedWarn = [...warnClusters].sort((a, b) => b.count - a.count);
    return sortedWarn.slice(0, 3);
  }, [result, errorClusters, warnClusters]);

  const ratio = result ? compressionPct(result.lines_in_window, result.clusters.length) : 0;

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleCompress = useCallback(async () => {
    if (!logText.trim() && !file) { setError("Paste some logs or upload a file."); return; }
    setError(null);
    setLoading(true);
    try {
      const res = await compressLogs(
        logText || null,
        file,
        startTime || null,
        endTime || null,
        formatOverride || null,
      );
      setResult(res);

      // Push to session history
      const entry: SessionEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        label: file?.name ?? "pasted text",
        ts: Date.now(),
        format: res.detected_format,
        ratio: compressionPct(res.lines_in_window, res.clusters.length),
        result: res,
      };
      setHistory((prev) => [entry, ...prev].slice(0, MAX_HISTORY));
      setActiveHistoryId(entry.id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [logText, file, startTime, endTime, formatOverride]);

  const handleNewCompression = useCallback(() => {
    setLogText("");
    setFile(null);
    if (fileRef.current) fileRef.current.value = "";
    setStartTime("");
    setEndTime("");
    setFormatOverride("");
    setResult(null);
    setError(null);
    setActiveHistoryId(null);
    setSidebarOpen(false);
  }, []);

  const handleDownloadTxt = useCallback(() => {
    if (!result) return;
    downloadBlob(result.tidy_text_summary, "logtidy-summary.txt", "text/plain");
  }, [result]);

  const handleDownloadJson = useCallback(() => {
    if (!result) return;
    downloadBlob(JSON.stringify(result, null, 2), "logtidy-result.json", "application/json");
  }, [result]);

  const toggleCluster = useCallback((template: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      next.has(template) ? next.delete(template) : next.add(template);
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => setExpandedKeys(new Set()), []);
  const expandAll   = useCallback(
    () => setExpandedKeys(new Set(filteredClusters.map((c) => c.template))),
    [filteredClusters]
  );

  const restoreHistory = useCallback((entry: SessionEntry) => {
    setResult(entry.result);
    setActiveHistoryId(entry.id);
    setActiveSitecoreMeta(entry.sitecoreMeta ?? null);
    if (entry.sitecoreMeta) {
      setSource("sitecore");
    }
  }, []);

  // ── Content margin — shift right when sidebar is open ─────────────────────
  const contentStyle = result && sidebarOpen
    ? { marginLeft: SIDEBAR_W }
    : {};

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 border-b border-zinc-800 px-5 py-3.5 flex items-center gap-3 bg-zinc-950 shrink-0" style={{ height: 57 }}>
        {/* Sidebar toggle — only when results are showing */}
        {result && (
          <button
            id="sidebar-toggle"
            onClick={() => setSidebarOpen((v) => !v)}
            className="p-1.5 rounded border border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:border-zinc-700 transition-colors text-[11px] font-mono shrink-0"
            title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          >
            {sidebarOpen ? "◀" : "▶"}
          </button>
        )}

        <div className="w-2 h-2 rounded-full bg-green-400 shrink-0" style={{ boxShadow: "0 0 6px #4ade80" }} />
        <span className="font-mono text-lg font-bold tracking-tight">
          log<span className="text-green-400">tidy</span>
        </span>
        <span className="ml-1 text-[11px] text-zinc-600 font-mono hidden sm:inline">
          // universal log compression
        </span>

        <div className="flex-1" />

        {/* History strip */}
        {history.length > 0 && (
          <div className="flex items-center gap-1.5 overflow-x-auto">
            {history.map((entry) => (
              <button
                key={entry.id}
                onClick={() => restoreHistory(entry)}
                title={`${entry.label} — ${parserDisplayName(entry.format)} · ${entry.ratio}% compression`}
                className={`shrink-0 px-2.5 py-1 rounded border text-[10px] font-mono transition-colors whitespace-nowrap ${
                  activeHistoryId === entry.id
                    ? "border-green-500/40 text-green-400 bg-green-500/10"
                    : "border-zinc-800 text-zinc-600 hover:text-zinc-400 hover:border-zinc-700"
                }`}
              >
                {entry.label.length > 18 ? entry.label.slice(0, 16) + "…" : entry.label}
                <span className="ml-1.5 opacity-60">{timeAgo(entry.ts)}</span>
              </button>
            ))}
          </div>
        )}

        {/* New compression button */}
        {result && (
          <button
            id="new-compression-btn"
            onClick={handleNewCompression}
            className="shrink-0 px-3 py-1.5 rounded-lg border border-zinc-700 text-zinc-400 font-mono text-xs hover:border-green-500/40 hover:text-green-400 transition-colors"
          >
            + new
          </button>
        )}
      </header>

      {/* ── Sidebar ────────────────────────────────────────────────────── */}
      {result && (
        <Sidebar
          open={sidebarOpen}
          search={search} setSearch={setSearch}
          levelFilter={levelFilter} setLevelFilter={setLevelFilter}
          sortKey={sortKey} setSortKey={setSortKey}
          onCollapseAll={collapseAll} onExpandAll={expandAll}
          totalClusters={barStats.total}
          highCount={barStats.high}
          warnCount={barStats.warn}
          infoCount={barStats.info}
        />
      )}

      {/* ── Main content ────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col transition-all duration-200" style={contentStyle}>
        <main className="flex-1 mx-auto w-full max-w-4xl px-4 py-8 space-y-6">

          {/* ── Input panel (remains mounted to preserve active Sitecore state) ── */}
          <div className={result ? "hidden" : "space-y-4"}>

              {/* Source picker tabs */}
              <div className="flex gap-1 p-1 rounded-lg bg-zinc-900 border border-zinc-800">
                <button
                  id="source-paste-btn"
                  onClick={() => setSource("paste")}
                  className={`flex-1 py-1.5 rounded-md font-mono text-xs transition-colors ${
                    source === "paste"
                      ? "bg-zinc-800 text-zinc-100 border border-zinc-700"
                      : "text-zinc-600 hover:text-zinc-400"
                  }`}
                >
                  paste / upload
                </button>
                <button
                  id="source-sitecore-btn"
                  onClick={() => setSource("sitecore")}
                  className={`flex-1 py-1.5 rounded-md font-mono text-xs transition-colors ${
                    source === "sitecore"
                      ? "bg-zinc-800 text-zinc-100 border border-zinc-700"
                      : "text-zinc-600 hover:text-zinc-400"
                  }`}
                >
                  sitecore cloud
                </button>
              </div>

              {/* Sitecore connector panel — always mounted, CSS hidden when not active so state survives tab switch */}
              <div className={source !== "sitecore" ? "hidden" : ""}>
                <SitecoreConnectorPanel
                  onResult={(res, label, meta) => {
                    setResult(res);
                    setActiveSitecoreMeta(meta ?? null);
                    const entry: SessionEntry = {
                      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                      label,
                      ts: Date.now(),
                      format: res.detected_format,
                      ratio: compressionPct(res.lines_in_window, res.clusters.length),
                      result: res,
                      sitecoreMeta: meta,
                    };
                    setHistory((prev) => [entry, ...prev].slice(0, MAX_HISTORY));
                    setActiveHistoryId(entry.id);
                  }}
                  startTime={startTime}
                  endTime={endTime}
                  formatOverride={formatOverride}
                />
              </div>

              {/* Paste / upload panel */}
              {source === "paste" && (<>
              <div className="space-y-2">
                <label className="text-[11px] font-mono uppercase tracking-widest text-zinc-500">
                  Paste logs
                </label>
                <textarea
                  id="log-input"
                  className="w-full h-40 bg-zinc-900 border border-zinc-800 rounded-lg p-3 font-mono text-xs text-zinc-300 placeholder-zinc-700 resize-y focus:outline-none focus:border-green-500/50 focus:ring-1 focus:ring-green-500/20 transition-colors"
                  placeholder={"2026-07-08 12:00:01 ERROR  ManagedPoolThread SolrConnectionException ...\n{\"timestamp\":\"2026-07-08T12:00:01Z\",\"level\":\"error\",...}\n#Fields: date time s-ip cs-method cs-uri-stem ..."}
                  value={logText}
                  onChange={(e) => { setLogText(e.target.value); if (e.target.value) setFile(null); }}
                />
              </div>

              <div className="flex items-center gap-4">
                <div className="h-px flex-1 bg-zinc-800" />
                <span className="text-[11px] font-mono text-zinc-600">or upload</span>
                <div className="h-px flex-1 bg-zinc-800" />
              </div>

              {/* File upload + format override row */}
              <div className="space-y-2">
                <input ref={fileRef} type="file" id="file-upload" className="hidden"
                  accept=".log,.txt,.json,.ndjson"
                  onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); if (f) setLogText(""); }}
                />
                <button id="file-upload-btn" onClick={() => fileRef.current?.click()}
                  className="w-full py-2.5 rounded-lg border border-dashed border-zinc-700 text-zinc-500 font-mono text-sm hover:border-green-500/40 hover:text-green-400 transition-colors">
                  {file
                    ? <span className="text-green-400">✓ {file.name} ({(file.size / 1024).toFixed(1)} KB)</span>
                    : "click to upload .log / .json / .txt"}
                </button>
              </div>

              {/* Time window */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[11px] font-mono uppercase tracking-widest text-zinc-500">Start time (optional)</label>
                  <input id="start-time" type="datetime-local" value={startTime} onChange={(e) => setStartTime(e.target.value)}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-xs text-zinc-300 focus:outline-none focus:border-green-500/50 focus:ring-1 focus:ring-green-500/20 transition-colors" />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-mono uppercase tracking-widest text-zinc-500">End time (optional)</label>
                  <input id="end-time" type="datetime-local" value={endTime} onChange={(e) => setEndTime(e.target.value)}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-xs text-zinc-300 focus:outline-none focus:border-green-500/50 focus:ring-1 focus:ring-green-500/20 transition-colors" />
                </div>
              </div>

              {error && (
                <div id="error-banner" className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm font-mono text-red-400">
                  ✗ {error}
                </div>
              )}

              <button id="compress-btn" onClick={handleCompress} disabled={loading}
                className="w-full py-3 rounded-lg bg-green-500 hover:bg-green-400 disabled:bg-zinc-800 disabled:text-zinc-600 text-zinc-950 font-mono font-bold text-sm tracking-wider transition-all duration-200 active:scale-[0.99]">
                {loading
                  ? <span className="flex items-center justify-center gap-2">
                      <span className="inline-block w-4 h-4 border-2 border-zinc-600 border-t-green-400 rounded-full animate-spin" />
                      compressing…
                    </span>
                  : "[ compress ]"}
              </button>
              </>)} {/* end source === "paste" */}
            </div>

          {/* ── Loading overlay when result exists and re-compressing ── */}
          {loading && result && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/80 backdrop-blur-sm">
              <div className="flex flex-col items-center gap-4 p-8 rounded-xl border border-zinc-800 bg-zinc-900">
                <span className="inline-block w-8 h-8 border-2 border-zinc-700 border-t-green-400 rounded-full animate-spin" />
                <span className="font-mono text-sm text-zinc-400">compressing…</span>
              </div>
            </div>
          )}

          {/* ── Result panel ────────────────────────────────────────── */}
          {result && (
            <div id="result-panel" className="space-y-5 animate-fade-in">

              {/* Sitecore Breadcrumb & Quick Switch */}
              {activeSitecoreMeta && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 font-mono text-xs">
                  <div className="flex items-center gap-2 min-w-0 text-zinc-400 overflow-hidden text-ellipsis whitespace-nowrap">
                    <span className="text-emerald-400 font-bold flex items-center gap-1.5 shrink-0">
                      <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_#34d399]" />
                      Sitecore Cloud
                    </span>
                    {activeSitecoreMeta.orgName && (
                      <>
                        <span className="text-zinc-600 shrink-0">/</span>
                        <span className="text-zinc-200 font-semibold shrink-0">{activeSitecoreMeta.orgName}</span>
                      </>
                    )}
                    {activeSitecoreMeta.projectName && (
                      <>
                        <span className="text-zinc-600 shrink-0">/</span>
                        <span className="text-zinc-400 shrink-0">{activeSitecoreMeta.projectName}</span>
                      </>
                    )}
                    {activeSitecoreMeta.envName && (
                      <>
                        <span className="text-zinc-600 shrink-0">/</span>
                        <span className="text-zinc-300 shrink-0">{activeSitecoreMeta.envName}</span>
                      </>
                    )}
                    <span className="text-zinc-600 shrink-0">/</span>
                    <span className="text-emerald-300 font-bold truncate">{activeSitecoreMeta.logName}</span>
                  </div>

                  <button
                    id="switch-log-btn"
                    onClick={() => {
                      setResult(null);
                      setSource("sitecore");
                    }}
                    className="text-[11px] font-mono text-zinc-400 hover:text-green-400 hover:drop-shadow-[0_0_8px_rgba(74,222,128,0.4)] transition-all cursor-pointer shrink-0"
                    title="Browse other logs in this environment"
                  >
                    [ switch log ]
                  </button>
                </div>
              )}

              {/* SCLA Severity & Volume Breakdown — 4 interactive cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <SCLACard
                  label="Errors"
                  value={sclaCounts.error.toLocaleString()}
                  sub={`${errorClusters.length} unique pattern${errorClusters.length !== 1 ? "s" : ""}`}
                  accent="text-red-400"
                  borderClass="border-red-500/50"
                  active={levelFilter === "error"}
                  onClick={() => setLevelFilter(levelFilter === "error" ? "all" : "error")}
                />
                <SCLACard
                  label="Warnings"
                  value={sclaCounts.warn.toLocaleString()}
                  sub={`${warnClusters.length} unique pattern${warnClusters.length !== 1 ? "s" : ""}`}
                  accent="text-amber-400"
                  borderClass="border-amber-500/50"
                  active={levelFilter === "warn"}
                  onClick={() => setLevelFilter(levelFilter === "warn" ? "all" : "warn")}
                />
                <SCLACard
                  label="Info & Debug"
                  value={(sclaCounts.info + sclaCounts.debug).toLocaleString()}
                  sub={`${infoClusters.length} unique pattern${infoClusters.length !== 1 ? "s" : ""}`}
                  accent="text-cyan-400"
                  borderClass="border-cyan-500/50"
                  active={levelFilter === "info"}
                  onClick={() => setLevelFilter(levelFilter === "info" ? "all" : "info")}
                />
                <SCLACard
                  label="Log Volume"
                  value={`${result.lines_in_window.toLocaleString()} logs`}
                  sub={
                    <span>
                      <strong className="text-emerald-400">{ratio}% tidy</strong> ({result.clusters.length} signatures)
                      {result.time_range?.duration_str ? ` · ${result.time_range.duration_str}` : ""}
                    </span>
                  }
                  accent="text-emerald-400"
                  borderClass="border-emerald-500/50"
                  active={levelFilter === "all"}
                  onClick={() => setLevelFilter("all")}
                />
              </div>

              {/* Top Repeating Hot Spots */}
              {topHotSpots.length > 0 && (
                <div id="hot-spots-section" className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-red-400 flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-red-500 shadow-[0_0_8px_#ef4444]" />
                      Top Repeating Issues & Hot Spots
                    </h3>
                    <span className="text-[11px] font-mono text-zinc-500 hidden sm:inline">
                      Exceptions flooding this log run · click to locate
                    </span>
                  </div>
                  <div className="space-y-2">
                    {topHotSpots.map((cluster, i) => (
                      <HotSpotCard
                        key={cluster.cluster_id || cluster.template}
                        cluster={cluster}
                        rank={i + 1}
                        onView={() => {
                          setExpandedKeys((prev) => new Set([...prev, cluster.template]));
                          const el = document.getElementById(`cluster-${cluster.cluster_id}`);
                          if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
                        }}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* No timestamp excluded warning */}
              {result.lines_excluded_no_timestamp > 0 && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-2.5 text-xs font-mono text-amber-400">
                  ⚠ {result.lines_excluded_no_timestamp.toLocaleString()} lines had no detectable timestamp and were excluded from the time filter.
                </div>
              )}

              {/* No date warning */}
              {result.no_date_warning && (
                <div id="no-date-warning-banner" className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-2.5 text-xs font-mono text-red-400">
                  ⚠ {result.no_date_warning}
                </div>
              )}

              {/* ── Explicit empty state ─────────────────────────────── */}
              {result.clusters.length === 0 && (
                <div id="empty-result-panel" className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-6 py-12 text-center space-y-2">
                  <div className="text-2xl">∅</div>
                  <div className="font-mono text-sm text-zinc-400">
                    {result.total_lines === 0
                      ? "No log lines could be parsed from this input."
                      : "Logs were parsed but produced no clusters."}
                  </div>
                  <div className="font-mono text-xs text-zinc-600">
                    {result.total_lines > 0
                      ? `${result.total_lines.toLocaleString()} lines were read — check the format.`
                      : "Check the file encoding and format, or try pasting a sample directly."}
                  </div>
                </div>
              )}

              {result.clusters.length > 0 && (
                <>
                  {/* Top action bar */}
                  <div className="flex items-center justify-between gap-3 pt-1">
                    <div className="flex items-center gap-3 text-[11px] font-mono text-zinc-500">
                      {highSevClusters.length > 0 && (
                        <span className="flex items-center gap-1.5">
                          <span className={`w-1.5 h-1.5 rounded-full ${levelDotColor("ERROR")} inline-block`} />
                          {highSevClusters.length} high-severity
                        </span>
                      )}
                      {isSearching && (
                        <span className="text-amber-400">
                          {filteredClusters.length} result{filteredClusters.length !== 1 ? "s" : ""} for &ldquo;{debouncedSearch}&rdquo;
                        </span>
                      )}
                    </div>
                    {/* Download + copy buttons (boxless glowing text style) */}
                    <div className="flex items-center gap-3">
                      <button
                        id="download-txt-btn"
                        onClick={handleDownloadTxt}
                        className="text-xs font-mono text-zinc-500 hover:text-green-400 hover:drop-shadow-[0_0_8px_rgba(74,222,128,0.5)] transition-all cursor-pointer"
                      >
                        [ ↓ .txt ]
                      </button>
                      <button
                        id="download-json-btn"
                        onClick={handleDownloadJson}
                        className="text-xs font-mono text-zinc-500 hover:text-cyan-400 hover:drop-shadow-[0_0_8px_rgba(34,211,238,0.5)] transition-all cursor-pointer"
                      >
                        [ ↓ .json ]
                      </button>
                      <CopyBtn label="copy summary" getText={() => result.tidy_text_summary} />
                    </div>
                  </div>

                  {/* ── High-severity section ───────────────────────── */}
                  {highSevClusters.length > 0 && (
                    <section id="high-severity-section" className="space-y-2">
                      <h2 className="text-[10px] font-mono uppercase tracking-widest text-zinc-500 flex items-center gap-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full ${levelDotColor("ERROR")} inline-block`} />
                        High-severity — {highSevClusters.length} distinct signature{highSevClusters.length !== 1 ? "s" : ""}
                        <span className="text-zinc-700 normal-case tracking-normal font-normal">
                          · one row per unique error template
                        </span>
                      </h2>
                      <div className="space-y-1.5">
                        {highSevClusters.map((cluster, i) => (
                          <ClusterCard
                            key={cluster.cluster_id || cluster.template}
                            cluster={cluster}
                            index={i + 1}
                            isExpanded={expandedKeys.has(cluster.template)}
                            onToggle={() => toggleCluster(cluster.template)}
                            isHighSev
                            search={debouncedSearch}
                          />
                        ))}
                      </div>
                    </section>
                  )}

                  {/* ── Other clusters section ──────────────────────── */}
                  {otherClusters.length > 0 && (
                    <section id="other-clusters-section" className="space-y-2">
                      <h2 className="text-[10px] font-mono uppercase tracking-widest text-zinc-500 flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-cyan-500 inline-block" />
                        {highSevClusters.length > 0 ? "Other" : "All"} clusters — {otherClusters.length.toLocaleString()} total
                        {!isSearching && !showAll && otherClusters.length > PREVIEW_SIZE && (
                          <span className="text-zinc-700 normal-case tracking-normal font-normal">
                            · showing top {PREVIEW_SIZE}
                          </span>
                        )}
                      </h2>

                      <div className="space-y-1">
                        {visibleOther.map((cluster, i) => {
                          const globalIdx = showAll && !isSearching ? page * PAGE_SIZE + i + 1 : i + 1;
                          return (
                            <ClusterCard
                              key={cluster.cluster_id || cluster.template}
                              cluster={cluster}
                              index={globalIdx}
                              isExpanded={expandedKeys.has(cluster.template)}
                              onToggle={() => toggleCluster(cluster.template)}
                              isHighSev={false}
                              search={debouncedSearch}
                            />
                          );
                        })}
                      </div>

                      {!isSearching && !showAll && otherClusters.length > PREVIEW_SIZE && (
                        <button id="show-all-btn" onClick={() => { setShowAll(true); setPage(0); }}
                          className="w-full py-2 rounded-lg border border-dashed border-zinc-700 text-zinc-500 font-mono text-xs hover:border-green-500/40 hover:text-green-400 transition-colors">
                          show all {otherClusters.length.toLocaleString()} clusters ({(otherClusters.length - PREVIEW_SIZE).toLocaleString()} more)
                        </button>
                      )}
                      {!isSearching && showAll && (
                        <PaginationBar
                          page={page} totalPages={totalPages} total={otherClusters.length}
                          onPrev={() => setPage((p) => Math.max(0, p - 1))}
                          onNext={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                        />
                      )}
                    </section>
                  )}

                  {filteredClusters.length === 0 && (
                    <div className="text-center py-8 font-mono text-xs text-zinc-600">
                      {isSearching
                        ? `no clusters match "${debouncedSearch}"`
                        : "no clusters match the current filter"}
                    </div>
                  )}
                </>
              )}

              {/* Re-compress controls (shown below result) */}
              <div className="border-t border-zinc-800 pt-4 space-y-3">
                <p className="text-[11px] font-mono text-zinc-600 text-center">run another compression on the same or different input</p>
                <div className="grid grid-cols-1 gap-3">
                  <div className="space-y-2">
                    <textarea
                      id="log-input-bottom"
                      className="w-full h-24 bg-zinc-900 border border-zinc-800 rounded-lg p-3 font-mono text-xs text-zinc-300 placeholder-zinc-700 resize-y focus:outline-none focus:border-green-500/50 focus:ring-1 focus:ring-green-500/20 transition-colors"
                      placeholder="Paste new logs here, or upload a new file below…"
                      value={logText}
                      onChange={(e) => { setLogText(e.target.value); if (e.target.value) setFile(null); }}
                    />
                    <div className="flex gap-2">
                      <input ref={fileRef} type="file" id="file-upload-bottom" className="hidden"
                        accept=".log,.txt,.json,.ndjson"
                        onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); if (f) setLogText(""); }}
                      />
                      <button onClick={() => fileRef.current?.click()}
                        className="flex-1 py-2 rounded-lg border border-dashed border-zinc-700 text-zinc-500 font-mono text-xs hover:border-green-500/40 hover:text-green-400 transition-colors">
                        {file
                          ? <span className="text-green-400">✓ {file.name}</span>
                          : "upload file"}
                      </button>
                      <button id="re-compress-btn" onClick={handleCompress} disabled={loading}
                        className="px-6 py-2 rounded-lg bg-green-500 hover:bg-green-400 disabled:bg-zinc-800 disabled:text-zinc-600 text-zinc-950 font-mono font-bold text-xs tracking-wider transition-all cursor-pointer">
                        [ compress ]
                      </button>
                    </div>
                    {error && (
                      <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs font-mono text-red-400">
                        ✗ {error}
                      </div>
                    )}
                  </div>
                </div>
              </div>

            </div>
          )}
        </main>
      </div>

      {/* ── Footer ─────────────────────────────────────────────────────── */}
      <footer className="border-t border-zinc-900 px-6 py-3 text-center text-[10px] font-mono text-zinc-700" style={contentStyle}>
        logtidy · zero config · zero cloud · paste → compress
      </footer>
    </div>
  );
}
