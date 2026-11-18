import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // DevContinuity is a local app over live local data; every page is rendered on request.
  serverExternalPackages: ["@prisma/client", "prisma", "archiver", "yauzl"],
  poweredByHeader: false,
  // Lets a test build go elsewhere without touching the build the running app serves.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
