/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // pdf-parse and exceljs are server-only; keep them out of the client bundle.
  experimental: {
    serverComponentsExternalPackages: ["pdf-parse", "exceljs", "pdf-lib", "tesseract.js", "playwright", "playwright-core"],
    // Default is 1 MB, which rejects real master Excel / PDF uploads.
    serverActions: { bodySizeLimit: "50mb" },
    // Run src/instrumentation.ts register() on server boot (crash/restart
    // recovery for interrupted automation runs).
    instrumentationHook: true,
  },
  // Type safety is enforced by a separate `npm run typecheck` (tsc). ESLint is
  // not wired into the build to avoid requiring eslint-config-next at build time.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
