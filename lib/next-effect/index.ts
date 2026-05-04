import 'server-only';
import { Data, Effect, Either } from 'effect';
import { redirect } from 'next/navigation';

// Tagged error for redirect intents. Exported so callers can `instanceof`-check
// in custom error handlers without using `as` casts.
export class RedirectError extends Data.TaggedError('RedirectError')<{
  path: string;
}> {}

/**
 * Create a redirect effect. Use this instead of Next.js redirect() inside Effect pipelines.
 */
const redirectEffect = (path: string) => Effect.fail(new RedirectError({ path }));

/**
 * Custom Effect.runPromise that handles Next.js redirects outside the Effect context.
 */
const runPromise = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
  const result = await Effect.runPromise(
    Effect.catchAll(Effect.map(effect, Either.right), e =>
      e instanceof RedirectError ? Effect.succeed(Either.left(e)) : Effect.fail(e)
    )
  );
  if (Either.isLeft(result)) {
    return redirect(result.left.path);
  }
  return result.right;
};

/**
 * Drop-in replacement for `Effect.matchEffect` that auto-bubbles `RedirectError`
 * to `runPromise`. Without this wrapper, `Effect.matchEffect` catches `RedirectError`
 * as a regular failure and the redirect never reaches Next.js — the page renders
 * the fallback JSX (or, if `onFailure` calls `redirect()` itself, fails with
 * `FiberFailure: NEXT_REDIRECT`).
 *
 * Use this in every page / server action that combines `NextEffect.redirect()`
 * with error matching.
 */
const matchEffect =
  <A, E, A2, E2, R2, A3, E3, R3>(options: {
    onFailure: (error: E) => Effect.Effect<A2, E2, R2>;
    onSuccess: (value: A) => Effect.Effect<A3, E3, R3>;
  }) =>
  <R>(
    self: Effect.Effect<A, E, R>
  ): Effect.Effect<A2 | A3, RedirectError | E2 | E3, R | R2 | R3> =>
    Effect.flatMap(
      Effect.either(self),
      (either): Effect.Effect<A2 | A3, RedirectError | E2 | E3, R2 | R3> => {
        if (Either.isLeft(either)) {
          const error = either.left;
          if (error instanceof RedirectError) {
            return Effect.fail<RedirectError>(error);
          }
          return options.onFailure(error);
        }
        return options.onSuccess(either.right);
      }
    );

export const NextEffect = {
  redirect: redirectEffect,
  runPromise,
  matchEffect
};
