"use client";

import { useState } from "react";
import { ContentCard, MoreLink } from "@/components/public/sections";
import { NEWS, type NewsItem } from "@/lib/fixtures";

const CATEGORIES = ["全部", "專題事務", "競賽資訊", "活動", "規則異動"] as const;

const TONE: Record<string, 1 | 2 | 3 | 4 | 5> = {
  專題事務: 1,
  競賽資訊: 2,
  活動: 3,
  規則異動: 5,
};

/**
 * 公告分類 tab。系網用的手法，同時解決資訊密度問題——
 * 一次只看一類，而不是把 6 則不同性質的公告堆在一起。
 */
export function NewsTabs({ limit = 3 }: { limit?: number }) {
  const [active, setActive] = useState<(typeof CATEGORIES)[number]>("全部");

  const items: NewsItem[] =
    active === "全部" ? NEWS : NEWS.filter((n) => n.category === active);
  const visible = items.slice(0, limit);

  return (
    <div>
      <div
        role="tablist"
        aria-label="公告分類"
        className="mb-6 flex flex-wrap justify-center gap-1.5"
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
              <span
                className={`tabular ml-1.5 text-xs ${selected ? "opacity-70" : "opacity-60"}`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {visible.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          這個分類目前沒有公告。
        </p>
      ) : (
        <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((n) => (
            <li key={n.id}>
              <ContentCard
                href={`/news/${n.id}`}
                imageTone={TONE[n.category] ?? 1}
                category={n.category}
                date={n.date}
                title={n.title}
                summary={n.summary}
              />
            </li>
          ))}
        </ul>
      )}

      <div className="mt-8 flex justify-center">
        <MoreLink href="/news">查看全部公告</MoreLink>
      </div>
    </div>
  );
}
