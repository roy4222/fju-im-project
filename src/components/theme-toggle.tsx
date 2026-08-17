"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { IconMoon, IconSun } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";

/**
 * 主題切換。
 *
 * 必須等 mount 後才依 resolvedTheme 渲染——server 端不知道使用者的主題，
 * 直接讀 resolvedTheme 會造成 icon 與 aria-label 的 hydration mismatch。
 * mount 前渲染固定的月亮 icon 佔位，尺寸相同所以不會有 layout shift。
 */
export function ThemeToggle({
  size = "icon",
  className,
}: {
  size?: "icon" | "icon-lg";
  className?: string;
}) {
  const [mounted, setMounted] = useState(false);
  const { resolvedTheme, setTheme } = useTheme();

  useEffect(() => setMounted(true), []);

  const isDark = mounted && resolvedTheme === "dark";

  return (
    <Button
      variant="ghost"
      size={size}
      className={className}
      aria-label={isDark ? "切換為淺色模式" : "切換為深色模式"}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isDark ? <IconSun className="size-4" /> : <IconMoon className="size-4" />}
    </Button>
  );
}
