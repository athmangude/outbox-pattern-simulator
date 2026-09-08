import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  basePath: "/outbox-pattern-simulator",
  images: { unoptimized: true },
};

export default nextConfig;
