import type { MetadataRoute } from "next";

const BASE = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

/**
 * 登入後的頁面不應被索引：Dashboard 只有工作佇列與個人資料，
 * 對搜尋引擎沒有價值，也不該出現在搜尋結果中。
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/dashboard", "/dashboard/", "/login", "/api/"],
      },
    ],
    sitemap: `${BASE}/sitemap.xml`,
    host: BASE,
  };
}
