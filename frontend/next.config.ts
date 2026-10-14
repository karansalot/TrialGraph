import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Standalone server bundle is only needed for the Docker image.
  // "standalone" = Docker image (live edition); "export" = plain static files (static edition, e.g. Netlify)
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : process.env.NEXT_OUTPUT === "export" ? "export" : undefined,
  trailingSlash: process.env.NEXT_OUTPUT === "export",
  // e.g. "/TrialGraph" when served from a GitHub Pages project site
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
