import 'server-only';
import { Layer, ManagedRuntime } from 'effect';
import { Db } from './services/db/live-layer';
import { Auth } from './services/auth/live-layer';
import { Email } from './services/email/live-layer';
import { S3 } from './services/s3/live-layer';
import { Telegram } from './services/telegram/live-layer';
import { Activity } from './services/activity/live-layer';

// Combined app layer
export const AppLayer = Layer.mergeAll(
  Auth.Live,
  Db.Live,
  Email.Live,
  S3.Live,
  Telegram.Live,
  Activity.Live
);

/**
 * Module-level runtime built once per server process.
 *
 * Layers are memoized inside the runtime: services (better-auth instance,
 * pg pool, Resend/S3 clients) are constructed a single time instead of on
 * every request, and shared dependencies (e.g. Email inside Auth.Live and
 * in AppLayer) resolve to the same instance.
 *
 * Scoped resources (db pools) are owned by the runtime's scope and released
 * on `AppRuntime.dispose()` / process teardown — never per request.
 *
 * Consume via `NextEffect.runPromise` (actions/pages) or
 * `AppRuntime.runtime()` (API route handlers).
 */
export const AppRuntime = ManagedRuntime.make(AppLayer);

/** Services available to effects run on {@link AppRuntime}. */
export type AppContext = ManagedRuntime.ManagedRuntime.Context<typeof AppRuntime>;
