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
  type CompressionResponse,
  type ClusterResult,
  type ParameterStats,
  type OccurrenceRecord,
} from "./api-client";

// ── Constants ─────────────────────────────────────────────────────────────────

const HIGH_SEVERITY = new Set(["ERROR", "CRITICAL", "FATAL", "AUDIT"]);
const WARN_LEVELS    = new Set(["WARN", "WARNING"]);
const PAGE_SIZE      = 25;
const PREVIEW_SIZE   = 10;

// ── Types ─────────────────────────────────────────────────────────────────────

type SortKey     = "count" | "first_seen";
type LevelFilter = "all" | "error" | "warn" | "info";

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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
// Renders the template with parameter ranges injected inline at each <*>.

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
            {/* Inline parameter annotation before this fixed part */}
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
            {/* Fixed text — with search highlight */}
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

// ── StatCard ──────────────────────────────────────────────────────────────────

function StatCard({ label, value, accent }: {
  label: string; value: string | number; accent?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 px-4 py-3 rounded-lg bg-zinc-900 border border-zinc-800">
      <span className="text-[10px] uppercase tracking-widest text-zinc-500 font-mono">{label}</span>
      <span className={`text-xl font-mono font-bold ${accent ?? "text-zinc-100"}`}>{value}</span>
    </div>
  );
}

// ── CopyButton (small inline) ────────────────────────────────────────────────

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
      className={`px-2 py-0.5 rounded border text-[10px] font-mono transition-colors ${
        flash
          ? "border-green-500/40 text-green-400 bg-green-500/10"
          : "border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600"
      }`}
    >
      {flash ? "✓ copied" : label}
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

  // Reset occurrences view when card collapses
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
      lines.push(
        `… (${cluster.count - cluster.occurrences.length} more occurrences not shown)`
      );
    }
    return lines.join("\n");
  };

  return (
    <div
      className={`rounded-lg border cursor-pointer transition-colors select-none ${
        isHighSev ? color : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-700"
      }`}
      onClick={onToggle}
    >
      {/* ── Compact header — always visible ─────────────────────────────── */}
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
        {/* Template with parameter annotations */}
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

      {/* ── Expanded body — NOT mounted when collapsed (true DOM collapse) ─ */}
      {isExpanded && (
        <div
          className="px-3 pb-3 space-y-3 border-t border-white/5"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Full template with params (not truncated) */}
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

          {/* Parameter stats table */}
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

          {/* Occurrence drill-down toggle */}
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

// ── StickyBar ─────────────────────────────────────────────────────────────────

function StickyBar({
  search, setSearch,
  levelFilter, setLevelFilter,
  sortKey, setSortKey,
  onCollapseAll, onExpandAll,
  totalClusters, highCount, warnCount, infoCount,
}: {
  search: string; setSearch: (s: string) => void;
  levelFilter: LevelFilter; setLevelFilter: (f: LevelFilter) => void;
  sortKey: SortKey; setSortKey: (s: SortKey) => void;
  onCollapseAll: () => void; onExpandAll: () => void;
  totalClusters: number; highCount: number; warnCount: number; infoCount: number;
}) {
  const filters: [LevelFilter, string, string][] = [
    ["all",   `all·${totalClusters}`, "border-zinc-700 text-zinc-400"],
    ["error", `err·${highCount}`,     "border-red-500/40 text-red-400 bg-red-500/10"],
    ["warn",  `warn·${warnCount}`,    "border-amber-500/40 text-amber-400 bg-amber-500/10"],
    ["info",  `info·${infoCount}`,    "border-cyan-500/40 text-cyan-400 bg-cyan-500/10"],
  ];

  return (
    <div className="sticky top-0 z-20 bg-zinc-950/96 backdrop-blur-md border-b border-zinc-800 px-3 py-2 flex items-center gap-x-2 gap-y-1.5 flex-wrap">
      {/* Search */}
      <input
        id="cluster-search"
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="search clusters…"
        className="w-40 sm:w-52 bg-zinc-900 border border-zinc-700 rounded px-2 py-0.5 font-mono text-[11px] text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-green-500/50 focus:ring-1 focus:ring-green-500/20 transition-colors"
      />

      <div className="h-3 w-px bg-zinc-800 hidden sm:block" />

      {/* Level filter */}
      <div className="flex items-center gap-1">
        <span className="text-[10px] font-mono text-zinc-600 mr-0.5">filter:</span>
        {filters.map(([key, label, activeClass]) => (
          <button
            key={key}
            id={`filter-${key}`}
            onClick={() => setLevelFilter(key)}
            className={`px-2 py-0.5 rounded border text-[10px] font-mono transition-colors ${
              levelFilter === key
                ? activeClass
                : "border-zinc-800 text-zinc-600 hover:text-zinc-400"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="h-3 w-px bg-zinc-800 hidden sm:block" />

      {/* Sort */}
      <div className="flex items-center gap-1">
        <span className="text-[10px] font-mono text-zinc-600 mr-0.5">sort:</span>
        {([ ["count", "freq"], ["first_seen", "time"] ] as [SortKey, string][]).map(([key, label]) => (
          <button
            key={key}
            id={`sort-${key}`}
            onClick={() => setSortKey(key)}
            className={`px-2 py-0.5 rounded border text-[10px] font-mono transition-colors ${
              sortKey === key
                ? "border-green-500/40 text-green-400 bg-green-500/10"
                : "border-zinc-800 text-zinc-600 hover:text-zinc-400"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="h-3 w-px bg-zinc-800 hidden sm:block" />

      {/* Bulk actions */}
      <div className="flex items-center gap-1">
        <button
          id="collapse-all-btn"
          onClick={onCollapseAll}
          className="px-2 py-0.5 rounded border border-zinc-800 text-[10px] font-mono text-zinc-600 hover:text-zinc-400 hover:border-zinc-700 transition-colors"
        >
          collapse all
        </button>
        <button
          id="expand-all-btn"
          onClick={onExpandAll}
          className="px-2 py-0.5 rounded border border-zinc-800 text-[10px] font-mono text-zinc-600 hover:text-zinc-400 hover:border-zinc-700 transition-colors"
        >
          expand all
        </button>
      </div>
    </div>
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

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Home() {
  // ── Input ────────────────────────────────────────────────────────────────
  const [logText, setLogText]   = useState("");
  const [file, setFile]         = useState<File | null>(null);
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime]   = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // ── Request ───────────────────────────────────────────────────────────────
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [result, setResult]     = useState<CompressionResponse | null>(null);
  const [copied, setCopied]     = useState(false);

  // ── Results view ──────────────────────────────────────────────────────────
  const [sortKey, setSortKey]         = useState<SortKey>("count");
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");
  const [search, setSearch]           = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [showAll, setShowAll]   = useState(false);
  const [page, setPage]         = useState(0);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 150);
    return () => clearTimeout(t);
  }, [search]);

  // Reset view on new result
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
  }, [result]);

  // Reset page on filter / sort / search change
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
    if (isSearching) return otherClusters;              // show all matches when searching
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

  const ratio = result ? compressionPct(result.lines_in_window, result.clusters.length) : 0;

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleCompress = useCallback(async () => {
    if (!logText.trim() && !file) { setError("Paste some logs or upload a file."); return; }
    setError(null);
    setLoading(true);
    try {
      const res = await compressLogs(logText || null, file, startTime || null, endTime || null);
      setResult(res);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [logText, file, startTime, endTime]);

  const handleCopy = useCallback(() => {
    if (!result) return;
    navigator.clipboard.writeText(result.tidy_text_summary).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
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

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header className="border-b border-zinc-800 px-6 py-4 flex items-center gap-3 shrink-0">
        <div className="scanline-glow w-2 h-2 rounded-full bg-green-400" />
        <span className="font-mono text-lg font-bold tracking-tight">
          log<span className="text-green-400">tidy</span>
        </span>
        <span className="ml-2 text-[11px] text-zinc-600 font-mono hidden sm:inline">
          // universal log compression
        </span>
      </header>

      <div className="flex-1 flex flex-col">
        {/* ── Sticky mini-bar (only while results are showing) ─────────── */}
        {result && (
          <StickyBar
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

        <main className="flex-1 mx-auto w-full max-w-5xl px-4 py-8 space-y-6">
          {/* ── Input panel ───────────────────────────────────────────── */}
          <div className="grid grid-cols-1 gap-4">
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

            <div>
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
                    compressing...
                  </span>
                : "[ compress ]"}
            </button>
          </div>

          {/* ── Result panel ──────────────────────────────────────────── */}
          {result && (
            <div id="result-panel" className="space-y-5 animate-fade-in">
              {/* Stats row */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatCard label="Format" value={result.detected_format} accent="text-green-400" />
                <StatCard
                  label="Confidence"
                  value={`${(result.detection_confidence * 100).toFixed(0)}%`}
                  accent={result.detection_confidence > 0.7 ? "text-green-400" : "text-amber-400"}
                />
                <StatCard
                  label="Lines → Clusters"
                  value={`${result.lines_in_window.toLocaleString()} → ${result.clusters.length.toLocaleString()}`}
                  accent="text-cyan-400"
                />
                <StatCard
                  label="Compression"
                  value={`${ratio}%`}
                  accent={ratio > 80 ? "text-green-400" : "text-amber-400"}
                />
              </div>

              {result.lines_excluded_no_timestamp > 0 && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-2.5 text-xs font-mono text-amber-400">
                  ⚠ {result.lines_excluded_no_timestamp.toLocaleString()} lines had no detectable timestamp and were excluded from the time filter.
                </div>
              )}

              {result.no_date_warning && (
                <div id="no-date-warning-banner" className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-2.5 text-xs font-mono text-red-400">
                  ⚠ {result.no_date_warning}
                </div>
              )}


              {/* Top bar: info + copy */}
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 text-[10px] font-mono text-zinc-600">
                  {highSevClusters.length > 0 && (
                    <span className="flex items-center gap-1">
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
                <button id="copy-btn" onClick={handleCopy}
                  className="px-3 py-1.5 rounded-lg border border-zinc-700 text-zinc-400 font-mono text-xs hover:border-green-500/40 hover:text-green-400 transition-colors">
                  {copied ? "✓ copied" : "copy tidy summary"}
                </button>
              </div>

              {/* ── High-severity section ────────────────────────────── */}
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

              {/* ── Other clusters section ───────────────────────────── */}
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

                  {/* Show-all / pagination */}
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
            </div>
          )}
        </main>
      </div>

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <footer className="border-t border-zinc-900 px-6 py-3 text-center text-[10px] font-mono text-zinc-700">
        logtidy · zero config · zero cloud · paste → compress
      </footer>
    </div>
  );
}
