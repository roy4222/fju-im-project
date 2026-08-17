"use client";

import { useState } from "react";
import { ContentCard } from "@/components/public/sections";
import { PROJECTS } from "@/lib/fixtures";

export function ProjectsGrid({ cohorts }: { cohorts: string[] }) {
  const [cohort, setCohort] = useState<string>("all");
  const [awardOnly, setAwardOnly] = useState(false);

  const items = PROJECTS.filter(
    (p) => (cohort === "all" || p.cohort === cohort) && (!awardOnly || p.award),
  );

  return (
    <>
      <div className="mb-8 flex flex-wrap items-center gap-1.5 border-b border-border pb-4">
        <button
          type="button"
          onClick={() => setCohort("all")}
          aria-pressed={cohort === "all"}
          className={`press h-9 rounded-full px-3.5 text-sm font-medium transition-colors ${
            cohort === "all"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground"
          }`}
        >
          全部屆別
        </button>
        {cohorts.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCohort(c)}
            aria-pressed={cohort === c}
            className={`press tabular h-9 rounded-full px-3.5 text-sm font-medium transition-colors ${
              cohort === c
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            }`}
          >
            {c} 屆
          </button>
        ))}

        <button
          type="button"
          onClick={() => setAwardOnly((v) => !v)}
          aria-pressed={awardOnly}
          className={`press ml-auto h-9 rounded-full border px-3.5 text-sm font-medium transition-colors ${
            awardOnly
              ? "border-brand bg-brand-subtle text-brand-on-subtle"
              : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
          }`}
        >
          只看得獎作品
        </button>
      </div>

      {items.length === 0 ? (
        <div className="py-16 text-center">
          <p className="text-sm font-medium">沒有符合條件的作品</p>
          <p className="mt-1 text-xs text-muted-foreground">
            試著改選屆別，或取消「只看得獎作品」。
          </p>
        </div>
      ) : (
        <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((p) => (
            <li key={p.id}>
              <ContentCard
                href={`/projects/${p.id}`}
                imageLabel={p.field}
                category={p.award}
                badge={`${p.cohort} 屆`}
                title={p.title}
                hasVideo={p.hasVideo}
              />
            </li>
          ))}
        </ul>
      )}

      <p className="mt-8 text-center text-xs text-muted-foreground">
        目前顯示 {items.length} 件作品。
      </p>
    </>
  );
}
