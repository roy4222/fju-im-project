import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Roy 透過 Tailscale 開 dev server 時，JS 檔才不會被擋成 403（給 Roy 點的版本仍用 next start）
  allowedDevOrigins: ["mac-mini.tail89e7a6.ts.net"],
};

export default nextConfig;
