/** @type {import('next').NextConfig} */

const isProd = process.env.NODE_ENV === 'production';

// Robust CSP guaranteed to allow Firebase Auth, OTP verification, and reCAPTCHA.

const csp = [

  "default-src 'self'",

  isProd

    ? "script-src 'self' 'unsafe-inline' https://www.google.com/recaptcha/ https://www.gstatic.com/ https://www.recaptcha.net/"

    : "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.google.com/recaptcha/ https://www.gstatic.com/ https://www.recaptcha.net/",

  "style-src 'self' 'unsafe-inline'",

  "img-src 'self' data: blob: https://www.gstatic.com/",

  "font-src 'self' data:",

  // ADDED: https://www.google.com to allow reCAPTCHA v2 to make fetch() requests

  "connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://*.googleapis.com https://www.google.com https://www.recaptcha.net",

  "frame-src 'self' https://www.google.com/recaptcha/ https://recaptcha.google.com/ https://www.recaptcha.net/",

  "frame-ancestors 'self'",

  "base-uri 'self'",

  "form-action 'self'",

  "object-src 'none'",

  "upgrade-insecure-requests",

].join('; ');

const nextConfig = {

  reactStrictMode: true,

  poweredByHeader: false,

  experimental: {

    serverActions: {

      bodySizeLimit: '10mb',

    },

  },

  images: { remotePatterns: [] },

  async headers() {

    return [

      {

        source: '/:path*',

        headers: [

          { key: 'X-Content-Type-Options', value: 'nosniff' },

          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },

          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },

          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },

          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },

          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' }, 

          { key: 'Cross-Origin-Resource-Policy', value: 'cross-origin' },

          { key: 'Content-Security-Policy', value: csp },

        ],

      },

    ];

  },

};

export default nextConfig;
