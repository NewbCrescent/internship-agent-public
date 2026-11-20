import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  transpilePackages: [
    "@internship-agent/agent",
    "@internship-agent/db",
    "@internship-agent/domain",
    "@internship-agent/github",
    "@internship-agent/jobs"
  ],
  allowedDevOrigins: ["127.0.0.1"],
  // Base resume uploads (PDF, up to 5 MB) travel through a server action.
  experimental: {
    serverActions: { bodySizeLimit: "6mb" }
  }
};

export default nextConfig;
