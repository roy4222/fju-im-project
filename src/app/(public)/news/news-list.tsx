"use client";

import { useState } from "react";
import { ContentCard } from "@/components/public/sections";
import { NEWS } from "@/lib/fixtures";

const CATEGORIES = ["全部", "專題事務", "競賽資訊", "活動", "規則異動"] as const;

export function NewsList() {
  const [active, setActive] = useState<(typeof CATEGORIES)[number]>("全部");
  const items = active === "全部" ? NEWS : NEWS.filter((n) => n.category === active);

  return (
    <>
      <div
        role="tablist"
        aria-label="公告分類"
        className="mb-8 flex flex-wrap gap-1.5 border-b border-border pb-4"
      >
        {CATEGORIES.map((c) => {
          const selected = c === active;
          const count = c === "全部" ? NEWS.length : NEWS.filter((n) => n.category === c).length;
          return (
            <button
              key={c}
              role="tab"
              type="button"
              aria-selected={selected}
              onClick={() => setActive(c)}
              className={`press h-9 rounded-full px-3.5 text-sm font-medium transition-colors ${
                selected
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              {c}
              <span className="tabular ml-1.5 text-xs opacity-70">{count}</span>
            </button>
          );
        })}
      </div>

      {items.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">
          這個分類目前沒有公告。
        </p>
      ) : (
        <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((n) => (
            <li key={n.id}>
              <ContentCard
                href={`/news/${n.id}`}
                category={n.category}
                date={n.date}
                title={n.title}
                summary={n.summary}
              />
            </li>
          ))}
        </ul>
      )}

      <p className="mt-8 text-center text-xs text-muted-foreground">
        目前共 {items.length} 則公告。實際站台會依日期分頁。
      </p>
    </>
  );
}
