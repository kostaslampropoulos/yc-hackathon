import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Moss ships native (N-API) bindings via @moss-dev/moss-core. Turbopack can't bundle
  // .node binaries, so the package must be loaded at runtime from node_modules.
  serverExternalPackages: ["@moss-dev/moss", "@moss-dev/moss-core"],

  // Vercel's file-tracer otherwise misses the platform-specific native bindings
  // (which moss-core resolves at runtime by reading process.platform). Explicitly
  // include the whole @moss-dev tree in every function bundle that touches Moss.
  outputFileTracingIncludes: {
    "/api/admin/agentphone": ["./node_modules/@moss-dev/**/*"],
    "/api/provision": ["./node_modules/@moss-dev/**/*"],
    "/api/agentphone/webhook": ["./node_modules/@moss-dev/**/*"],
  },
};

export default nextConfig;
