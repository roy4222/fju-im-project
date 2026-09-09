/**
 * 後台小圖表：純 SVG，不載圖表庫（規格 §14.3、反模式 #15：只呈現真實業務量）。
 * 動畫在 globals.css 的 .chart-* class；reduced-motion 直接顯示。
 */

export function Sparkline({ values, className = "", stroke = "currentColor" }: { values: number[]; className?: string; stroke?: string }) {
  const w = 96, h = 32, pad = 2;
  const max = Math.max(...values, 1), min = Math.min(...values, 0);
  const pts = values.map((v, i) => [pad + (i * (w - pad * 2)) / Math.max(values.length - 1, 1), h - pad - ((v - min) / (max - min || 1)) * (h - pad * 2)] as const);
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const area = `${d} L${pts[pts.length - 1][0].toFixed(1)},${h} L${pts[0][0].toFixed(1)},${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={`h-8 w-24 ${className}`} aria-hidden>
      <path d={area} fill={stroke} opacity="0.1" />
      <path d={d} fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"  />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2.5" fill={stroke} />
    </svg>
  );
}

export function MiniBars({ values, className = "", fill = "currentColor", highlightLast = true }: { values: number[]; className?: string; fill?: string; highlightLast?: boolean }) {
  const max = Math.max(...values, 1);
  return (
    <div className={`flex h-8 items-end gap-[3px] ${className}`} aria-hidden>
      {values.map((v, i) => (
        <span
          key={i}
          className="block w-1.5 rounded-sm"
          style={{ height: `${Math.max((v / max) * 100, 8)}%`, background: highlightLast && i === values.length - 1 ? fill : "var(--muted-foreground)", opacity: highlightLast && i === values.length - 1 ? 1 : 0.3 }}
        />
      ))}
    </div>
  );
}

/** 環形進度（完成率、儲存量） */
export function Ring({ value, size = 64, stroke = 7, color = "var(--primary)", track = "var(--muted)", children, className = "" }: { value: number; size?: number; stroke?: number; color?: string; track?: string; children?: React.ReactNode; className?: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className={`relative inline-flex shrink-0 items-center justify-center ${className}`} style={{ width: size, height: size }} role="img" aria-label={`${Math.round(v)}%`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - v / 100)} style={{ transition: "stroke-dashoffset 600ms ease" }} />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">{children}</div>
    </div>
  );
}

/** 分段長條（已完成／逾期／未繳） */
export function SegmentBar({ segments, className = "", height = 8 }: { segments: { value: number; color: string; label: string }[]; className?: string; height?: number }) {
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  return (
    <div className={`flex w-full overflow-hidden rounded-full bg-muted ${className}`} style={{ height }} role="img" aria-label={segments.map((s) => `${s.label} ${s.value}`).join("，")}>
      {segments.map((s) => (
        <span key={s.label} className="block h-full" style={{ width: `${(s.value / total) * 100}%`, background: s.color }} />
      ))}
    </div>
  );
}

/** 直式長條圖（近 7 天繳交件數等） */
export function BarChart({ data, className = "", color = "currentColor", highlight }: { data: { label: string; value: number }[]; className?: string; color?: string; highlight?: number }) {
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className={`flex h-36 items-end gap-2 ${className}`} role="img" aria-label={data.map((d) => `${d.label} ${d.value}`).join("，")}>
      {data.map((d, i) => (
        <div key={d.label} className="group flex flex-1 flex-col items-center gap-1.5">
          <span className="tabular text-[11px] font-semibold text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">{d.value}</span>
          <div className="flex h-24 w-full items-end">
            <span className="block w-full rounded-t-md transition-opacity group-hover:opacity-100" style={{ height: `${Math.max((d.value / max) * 100, 4)}%`, background: highlight === i ? "var(--brand)" : color, opacity: highlight === i ? 1 : 0.28 }} />
          </div>
          <span className="tabular text-[11px] text-muted-foreground">{d.label}</span>
        </div>
      ))}
    </div>
  );
}

/** 橫向比較列（各老師進度、各組進度） */
export function HBar({ label, value, total, color = "var(--foreground)", suffix }: { label: string; value: number; total: number; color?: string; suffix?: string }) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="w-20 shrink-0 truncate text-sm">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="tabular w-14 shrink-0 text-right text-xs text-muted-foreground">{suffix ?? `${value}/${total}`}</span>
    </div>
  );
}
