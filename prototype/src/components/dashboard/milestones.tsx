import { IconCheck, IconTrophy } from "@tabler/icons-react";
import { Panel } from "@/components/dashboard/primitives";
import type { Milestone } from "@/lib/fixtures";

/**
 * 里程碑（Steam 成就的感覺）：一條路，做完一格亮一格；最新達成的有橘色微光。
 * 首頁其他模組完成後會收起，這條會留下來，讓「完成」有地方被看到。
 */
export function Milestones({ items, title = "本學期里程碑" }: { items: Milestone[]; title?: string }) {
  const done = items.filter((m) => m.done).length;
  const latest = [...items].reverse().find((m) => m.done);
  return (
    <Panel title={title} description={`${done}/${items.length} 達成`} className="h-full">
      <ol className="flex flex-col px-5 pb-4">
        {items.map((m, i) => {
          const isLatest = latest?.id === m.id;
          return (
            <li key={m.id} className="relative flex gap-3.5 pb-4 last:pb-0">
              {i < items.length - 1 ? <span aria-hidden className={`absolute top-7 left-[13px] h-[calc(100%-1rem)] w-0.5 ${m.done ? "bg-brand" : "bg-border"}`} /> : null}
              <span className={`relative z-[1] inline-flex size-7 shrink-0 items-center justify-center rounded-full ${m.done ? `bg-brand text-brand-foreground ${isLatest ? "achieve" : ""}` : m.current ? "border-2 border-brand bg-background text-brand" : "border-2 border-border bg-background text-muted-foreground/60"}`}>
                {m.done ? <IconCheck className="size-4" /> : <span className="tabular text-[11px] font-bold">{i + 1}</span>}
              </span>
              <div className="min-w-0 flex-1 pt-0.5">
                <div className="flex items-center gap-2">
                  <p className={`text-sm font-semibold ${m.done ? "" : m.current ? "" : "text-muted-foreground"}`}>{m.title}</p>
                  {isLatest ? <span className="inline-flex items-center gap-1 rounded-full bg-brand-subtle px-2 py-0.5 text-[11px] font-bold text-brand-on-subtle"><IconTrophy className="size-3" />最新達成</span> : null}
                  {m.current ? <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">進行中</span> : null}
                </div>
                <p className="tabular text-xs text-muted-foreground">{m.done && m.at ? `${m.at}・` : ""}{m.hint}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}
