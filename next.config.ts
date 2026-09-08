import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  basePath: "/healthx-outbox-simulator",
  images: { unoptimized: true },
};

export default nextConfig;
