import type { Metadata } from "next";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { fontVariables } from "@/lib/fonts";
import "./globals.css";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
const SITE_NAME = "輔仁大學資訊管理學系｜專題管理平台";
const SITE_DESCRIPTION =
  "輔仁大學資訊管理學系專題入口：專題公告、專題規則、產學合作、歷屆成果與競賽榮譽；學生、指導老師與系辦於同一平台完成分組、繳交、評分與簽核。";

export const metadata: Metadata = {
  // metadataBase 讓各頁的 canonical 與 Open Graph 自動補上絕對網址（MOC §14.4）
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE_NAME,
    template: "%s｜輔大資管系專題",
  },
  description: SITE_DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    locale: "zh_TW",
    siteName: SITE_NAME,
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    url: "/",
  },
  twitter: { card: "summary_large_image" },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="zh-Hant-TW"
      suppressHydrationWarning
      className={`${fontVariables} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem={false}
          disableTransitionOnChange
        >
          <TooltipProvider>{children}</TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
