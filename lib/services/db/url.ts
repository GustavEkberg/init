// NOTE: intentionally NOT 'server-only' — drizzle.config.ts (drizzle-kit CLI,
// plain node) imports this too. Pure string helpers, no secrets.

// pg-connection-string warns when sslmode is prefer/require/verify-ca because
// pg v9 will switch those to libpq semantics with weaker security guarantees.
// We control SSL explicitly at each connection site, so strip sslmode from the
// URL to silence the warning. Used by db, auth, and any other consumer of
// DATABASE_URL that hits a `pg`/`postgres.js`-derived parser.
export const stripSslMode = (url: string) =>
  url.replace(/([?&])sslmode=[^&]*(&|$)/, (_, p, s) => (s ? p : ''));

export const isLocalDbUrl = (url: string) => url.includes('localhost') || url.includes('127.0.0.1');
