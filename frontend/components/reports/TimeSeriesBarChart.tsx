"use client";

import { useState } from "react";

// Shared by reports-management Story 40's ticket-volume trend and Story
// 41's SLA breach trend — both are a single-series bar chart over daily/
// weekly/monthly buckets. No charting library dependency: a single series
// over a handful of buckets doesn't need one (see CLAUDE.md's dependency-
// freshness policy — a new frontend dependency is a decision to make
// deliberately, not a default), and this mirrors the inline-SVG approach
// already validated in both reports' design mockups.
export interface TimeSeriesPoint {
  bucket: string;
  label: string;
  value: number;
}

function niceMax(v: number): number {
  if (v <= 0) return 4;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  const step = n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

export function TimeSeriesBarChart({
  data,
  color,
  valueLabel,
  emptyMessage,
}: {
  data: TimeSeriesPoint[];
  color: string; // e.g. "var(--chart-1)" or "var(--destructive)"
  valueLabel: string;
  emptyMessage: string;
}) {
  const [tooltip, setTooltip] = useState<{ x: number; y: number; label: string; value: number } | null>(null);

  if (data.length === 0) {
    return <div className="flex items-center justify-center rounded-xl border border-dashed border-border p-10 text-sm text-muted-foreground">{emptyMessage}</div>;
  }

  const n = data.length;
  const barW = n > 120 ? 3 : n > 60 ? 6 : n > 30 ? 12 : 22;
  const gap = n > 60 ? 2 : n > 30 ? 4 : 6;
  const padL = 34;
  const padR = 10;
  const padT = 10;
  const padB = 24;
  const H = 200;
  const contentW = padL + padR + n * barW + (n - 1) * gap;
  const W = Math.max(700, contentW);
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const maxV = niceMax(Math.max(...data.map((d) => d.value), 1));
  // With small integer counts (e.g. maxV=2), 4 fixed steps produce
  // colliding rounded labels (2, 2, 1, 1, 0) — cap steps at maxV itself so
  // every gridline is a distinct whole number.
  const steps = Math.max(1, Math.min(4, maxV));

  return (
    <div className="relative overflow-x-auto pb-0.5">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="text-[10.5px]">
        {Array.from({ length: steps + 1 }, (_, g) => {
          const y = padT + plotH - (plotH * g) / steps;
          return (
            <g key={g}>
              <line x1={padL} x2={W - padR} y1={y} y2={y} stroke="var(--border)" strokeWidth={1} />
              <text x={padL - 6} y={y + 3} textAnchor="end" fill="var(--muted-foreground)">
                {Math.round((maxV * g) / steps)}
              </text>
            </g>
          );
        })}
        {data.map((d, idx) => {
          const x = padL + idx * (barW + gap);
          const h = maxV ? (d.value / maxV) * plotH : 0;
          const yBase = padT + plotH;
          const showLabel = n <= 20 || idx % Math.ceil(n / 20) === 0;
          return (
            <g key={d.bucket}>
              <rect
                x={x}
                y={yBase - Math.max(h, 0)}
                width={barW}
                height={Math.max(h, d.value === 0 ? 1.5 : 0)}
                rx={2}
                fill={d.value > 0 ? color : "var(--border)"}
                className="cursor-pointer transition-[filter] hover:brightness-110"
                onMouseEnter={(e) => setTooltip({ x: e.clientX, y: e.clientY, label: d.label, value: d.value })}
                onMouseMove={(e) => setTooltip((t) => (t ? { ...t, x: e.clientX, y: e.clientY } : t))}
                onMouseLeave={() => setTooltip(null)}
              />
              {showLabel && (
                <text x={x + barW / 2} y={H - 6} textAnchor="middle" fill="var(--muted-foreground)">
                  {d.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {tooltip && (
        <div
          className="pointer-events-none fixed z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-border bg-card px-2.5 py-2 text-xs shadow-pop"
          style={{ left: tooltip.x, top: tooltip.y - 10 }}
        >
          <div className="mb-1 font-bold">{tooltip.label}</div>
          <div className="flex justify-between gap-3.5">
            <span className="text-muted-foreground">{valueLabel}</span>
            <span>{tooltip.value}</span>
          </div>
        </div>
      )}
    </div>
  );
}
