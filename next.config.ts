import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Moss ships native (N-API) bindings via @moss-dev/moss-core that Turbopack can't bundle.
  // Force them to be loaded at runtime from node_modules instead.
  serverExternalPackages: ["@moss-dev/moss", "@moss-dev/moss-core"],
};

export default nextConfig;
