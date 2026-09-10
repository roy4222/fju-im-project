"use client";

import { Area, AreaChart, Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

/**
 * 首頁圖表（recharts）。只畫真實業務量：繳交、收件、分組、評分。
 * 色：橘＝重點、深藍＝主色、其餘中性；tooltip 白卡。
 */
const TIP = { contentStyle: { borderRadius: 12, border: "1px solid var(--border)", background: "var(--card)", color: "var(--foreground)", fontSize: 12, boxShadow: "0 8px 24px rgba(0,51,102,0.10)" }, itemStyle: { color: "var(--foreground)" }, labelStyle: { color: "var(--muted-foreground)" }, cursor: { fill: "color-mix(in oklch, var(--foreground) 5%, transparent)" } } as const;

export function TrendArea({ data, color = "var(--brand)", height = 160 }: { data: { label: string; value: number }[]; color?: string; height?: number }) {
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: -22, bottom: 0 }}>
          <defs>
            <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity={0.35} /><stop offset="100%" stopColor={color} stopOpacity={0.02} /></linearGradient>
          </defs>
          <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} />
          <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} allowDecimals={false} width={40} />
          <Tooltip {...TIP} />
          <Area type="monotone" dataKey="value" name="件" stroke={color} strokeWidth={2.5} fill="url(#trendFill)" dot={{ r: 3, fill: color, strokeWidth: 0 }} activeDot={{ r: 5 }} isAnimationActive animationDuration={700} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function Donut({ data, size = 132, thickness = 16, center }: { data: { name: string; value: number; color: string }[]; size?: number; thickness?: number; center?: React.ReactNode }) {
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" innerRadius={size / 2 - thickness} outerRadius={size / 2} paddingAngle={2} cornerRadius={6} strokeWidth={0} isAnimationActive animationDuration={700}>
            {data.map((d) => <Cell key={d.name} fill={d.color} />)}
          </Pie>
          <Tooltip {...TIP} />
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">{center}</div>
    </div>
  );
}

export function Bars({ data, height = 160, color = "var(--primary)", highlight = "var(--brand)" }: { data: { label: string; value: number; hot?: boolean }[]; height?: number; color?: string; highlight?: string }) {
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, left: -22, bottom: 0 }} barCategoryGap="28%">
          <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} />
          <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} allowDecimals={false} width={40} />
          <Tooltip {...TIP} />
          <Bar dataKey="value" name="件" radius={[8, 8, 8, 8]} isAnimationActive animationDuration={700}>
            {data.map((d) => <Cell key={d.label} fill={d.hot ? highlight : color} fillOpacity={d.hot ? 1 : 0.28} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** 水平堆疊：完成／逾期／未繳 */
export function StackedRows({ rows }: { rows: { label: string; done: number; overdue: number; total: number; href?: string }[] }) {
  return (
    <ul className="flex flex-col gap-3.5">
      {rows.map((r) => {
        const pending = Math.max(0, r.total - r.done - r.overdue);
        return (
          <li key={r.label}>
            <div className="mb-1.5 flex items-center justify-between gap-3 text-sm"><span className="truncate font-semibold">{r.label}</span><span className="tabular shrink-0 text-xs text-muted-foreground">{r.done}/{r.total}</span></div>
            <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
              <span className="h-full rounded-l-full bg-brand transition-[width] duration-700" style={{ width: `${(r.done / r.total) * 100}%` }} />
              <span className="h-full bg-destructive" style={{ width: `${(r.overdue / r.total) * 100}%` }} />
              <span className="h-full" style={{ width: `${(pending / r.total) * 100}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
