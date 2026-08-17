import type { MetadataRoute } from "next";
import { COMPETITIONS, INDUSTRY, NEWS, PROJECTS } from "@/lib/fixtures";

/**
 * MOC §14.4：公開頁需產生 sitemap，且公告、產學、專題、榮譽詳情具有穩定 URL。
 * 網域尚未封板（TBD-01），先由環境變數提供，預設為本機。
 */
const BASE = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export default function sitemap(): MetadataRoute.Sitemap {
  const staticPages: MetadataRoute.Sitemap = [
    { url: `${BASE}/`, changeFrequency: "daily", priority: 1 },
    { url: `${BASE}/news`, changeFrequency: "daily", priority: 0.9 },
    { url: `${BASE}/rules`, changeFrequency: "monthly", priority: 0.9 },
    { url: `${BASE}/industry`, changeFrequency: "weekly", priority: 0.8 },
    { url: `${BASE}/projects`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${BASE}/competitions`, changeFrequency: "weekly", priority: 0.7 },
    { url: `${BASE}/honors`, changeFrequency: "monthly", priority: 0.7 },
    { url: `${BASE}/register`, changeFrequency: "yearly", priority: 0.5 },
  ];

  return [
    ...staticPages,
    ...NEWS.map((n) => ({
      url: `${BASE}/news/${n.id}`,
      lastModified: new Date(n.date),
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
    ...INDUSTRY.map((i) => ({
      url: `${BASE}/industry/${i.id}`,
      lastModified: new Date(i.publishedAt),
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
    ...PROJECTS.map((p) => ({
      url: `${BASE}/projects/${p.id}`,
      changeFrequency: "yearly" as const,
      priority: 0.6,
    })),
    ...COMPETITIONS.map((c) => ({
      url: `${BASE}/competitions#${c.id}`,
      changeFrequency: "monthly" as const,
      priority: 0.4,
    })),
  ];
}
