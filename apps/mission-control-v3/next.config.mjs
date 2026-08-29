/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [
      {
        // Documents only: keep the local-only service from calling
        // CopilotKit's cloud (update checks, announcements) from the browser.
        // The chat runtime stays same-origin via /api/copilotkit.
        source: '/((?!api/|_next/static/).*)',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
          },
        ],
      },
    ];
  },
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: [
    '@copilotkit/react-core',
    '@copilotkit/react-ui',
    '@copilotkit/runtime',
  ],
  experimental: {
    serverActions: {
      bodySizeLimit: '1mb',
    },
  },
};

export default nextConfig;
