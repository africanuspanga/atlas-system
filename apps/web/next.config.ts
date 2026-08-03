import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // @atlas/i18n ships raw TypeScript source (shared with the mobile app).
  transpilePackages: ["@atlas/i18n"],
  // This app lives inside the monorepo and consumes linked workspace packages.
  // Set the root explicitly so Turbopack never guesses from the nested legacy
  // lockfile and so builds resolve the same dependency graph in CI/prod.
  turbopack: {
    root: path.resolve(__dirname, "../.."),
  },
};

export default nextConfig;
