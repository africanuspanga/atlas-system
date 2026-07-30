import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @atlas/i18n ships raw TypeScript source (shared with the mobile app).
  transpilePackages: ["@atlas/i18n"],
};

export default nextConfig;
