import type { MetadataRoute } from "next";
import { HONORS, NEWS, PROJECTS } from "@/lib/fixtures";

/**
 * 規格 §14.4：只列公開頁。登入後路由（歷屆一覽、產學、檔案、個人資料）不進 sitemap。
 * 網域尚未封板（TBD-01），先由環境變數提供。
 */
const BASE = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export default function sitemap(): MetadataRoute.Sitemap {
  const staticPages: MetadataRoute.Sitemap = [
    { url: `${BASE}/`, changeFrequency: "daily", priority: 1 },
    { url: `${BASE}/news`, changeFrequency: "daily", priority: 0.9 },
    { url: `${BASE}/competitions`, changeFrequency: "weekly", priority: 0.7 },
    { url: `${BASE}/rules`, changeFrequency: "monthly", priority: 0.9 },
    { url: `${BASE}/projects/featured`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${BASE}/honors`, changeFrequency: "monthly", priority: 0.7 },
    { url: `${BASE}/register`, changeFrequency: "yearly", priority: 0.4 },
  ];
  return [
    ...staticPages,
    ...NEWS.filter((n) => !n.audience || n.audience === "public").map((n) => ({ url: `${BASE}/news/${n.id}`, lastModified: new Date(n.date), changeFrequency: "monthly" as const, priority: 0.6 })),
    ...PROJECTS.filter((p) => p.award).map((p) => ({ url: `${BASE}/projects/${p.id}`, changeFrequency: "yearly" as const, priority: 0.6 })),
    ...HONORS.map((h) => ({ url: `${BASE}/honors?item=${h.id}`, lastModified: new Date(h.date), changeFrequency: "yearly" as const, priority: 0.4 })),
  ];
}
