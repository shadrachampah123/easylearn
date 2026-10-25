import type { NextConfig } from "next";
import { FILE_RESPONSE_CSP } from "./src/lib/upload-content";

const nextConfig: NextConfig = {
  async headers() {
    const isProduction = process.env.NODE_ENV === "production";

    /*
     * Content Security Policy.
     *
     * The development and production policies differ deliberately:
     *
     *   - `'unsafe-eval'` is needed by the Next.js development server (React Fast
     *     Refresh compiles modules with `eval`). The PRODUCTION build does not use
     *     `eval` anywhere, so the production policy does not allow it. `eval` is the
     *     single most effective way to defeat a script-src policy, because it turns
     *     a string into code.
     *   - `ws:` / `wss:` are only needed by the development server's hot-reload
     *     socket. The application opens no WebSocket of its own.
     *
     * KNOWN REMAINING EXPOSURE: `'unsafe-inline'` is still present in `script-src`,
     * so an injected inline `<script>` would still execute. Removing it requires a
     * nonce-based policy, which needs the root layout to pass a per-request nonce to
     * every script and a review of every third-party script the app loads. That is
     * tracked as a follow-up in docs/SECURITY_AUTHENTICATION.md rather than being
     * half-done here: a policy that breaks the application is worse than a policy
     * that is merely incomplete.
     */
    const scriptSrc = isProduction
      ? "script-src 'self' 'unsafe-inline' blob:"
      : "script-src 'self' 'unsafe-eval' 'unsafe-inline' blob:";

    const connectSrc = isProduction
      ? "connect-src 'self' https:"
      : "connect-src 'self' https: wss: ws:";

    const csp = [
      "default-src 'self'",
      scriptSrc,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "img-src 'self' data: blob: https: http:",
      "media-src 'self' data: blob: https:",
      connectSrc,
      "frame-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "upgrade-insecure-requests",
    ].join("; ");

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
      {
        key: "Content-Security-Policy",
        value: csp,
      },
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
