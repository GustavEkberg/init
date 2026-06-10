import { Schedule } from 'effect';
import { SqlError } from '@effect/sql';

// Exponential backoff
// Handles network issues, cold starts, and transient cloud infrastructure problems
// Retries: immediate, +500ms, +1s, +2s (max 3 retries, ~3.5s total)
export const retryPolicy = Schedule.exponential('500 millis', 2.0).pipe(
  Schedule.intersect(Schedule.recurs(3)),
  Schedule.jittered
);

const hasIsTransient = (error: unknown): error is { isTransient: true } =>
  typeof error === 'object' &&
  error !== null &&
  'isTransient' in error &&
  error.isTransient === true;

export const isTransientError = (error: unknown): boolean =>
  hasIsTransient(error) || error instanceof SqlError.SqlError;

// Used by: Email (Resend transport), Telegram (fetch).
// Deliberately NOT applied to S3 (AWS SDK retries internally — stacking would
// multiply attempts) or Db (pg pool handles connection retry/timeouts).
//
// Conditional usage example:
// .pipe(
//   Effect.retry({
//     while: isTransientError,
//     schedule: retryPolicy
//   })
// )
