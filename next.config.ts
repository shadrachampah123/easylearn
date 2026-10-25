import type { NextConfig } from "next";
import { FILE_RESPONSE_CSP } from "./src/lib/upload-content";

const nextConfig: NextConfig = {
  async headers() {
    // CSP is now set in src/proxy.ts with a per-request nonce (Risk #2).
    // Keeping 'unsafe-inline' as fallback for browsers without nonce support,
    // but modern browsers will enforce 'nonce-*' + 'strict-dynamic' and ignore
    // 'unsafe-inline' per CSP spec. next.config no longer emits CSP to avoid
    // duplicate headers; see docs/SECURITY_AUTHENTICATION.md §6.
    const isProduction = process.env.NODE_ENV === "production";

    const securityHeaders = [
      {
        key: "X-DNS-Prefetch-Control",
        value: "on",
      },
      {
        key: "X-Content-Type-Options",
        value: "nosniff",
      },
      {
        key: "X-Frame-Options",
        value: "DENY",
      },
      {
        key: "X-XSS-Protection",
        value: "1; mode=block",
      },
      {
        key: "Referrer-Policy",
        value: "strict-origin-when-cross-origin",
      },
      {
        key: "Permissions-Policy",
        value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
      },
      // Content-Security-Policy is set in src/proxy.ts with per-request nonce.
    ];

    // HSTS only in production
    if (isProduction) {
      securityHeaders.push({
        key: "Strict-Transport-Security",
        value: "max-age=31536000; includeSubDomains; preload",
      });
    }

    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
      {
        source: "/api/(.*)",
        headers: [
          {
            key: "Cache-Control",
            value: "no-store, no-cache, must-revalidate, proxy-revalidate",
          },
          ...securityHeaders,
        ],
      },
      /*
       * Uploaded files are user-supplied content. They are served with a
       * server-determined content type that is never scriptable, and this
       * rule adds the second layer: a response the browser treats as a
       * document is put into an opaque origin with scripting disabled, so it
       * cannot reach this application's session or DOM.
       *
       * This rule comes LAST so that it replaces the general policy above for
       * file responses. The route handler sets the same value, so the header
       * is the same whichever of the two is applied.
       */
      {
        source: "/api/files/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: FILE_RESPONSE_CSP,
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Cross-Origin-Resource-Policy",
            value: "same-origin",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
