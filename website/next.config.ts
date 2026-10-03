import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  images: {
    // screenshots are already sized; let Next serve them as AVIF/WebP
    formats: ["image/avif", "image/webp"],
  },
};

export default nextConfig;
