/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // pdf-parse and exceljs are server-only; keep them out of the client bundle.
  experimental: {
    serverComponentsExternalPackages: ["pdf-parse", "exceljs"],
  },
  // Type safety is enforced by a separate `npm run typecheck` (tsc). ESLint is
  // not wired into the build to avoid requiring eslint-config-next at build time.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
