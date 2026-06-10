import { HttpApp, HttpServerResponse } from '@effect/platform';
import { Effect, Match } from 'effect';
import { AppRuntime } from '@/lib/layers';
import { getPosts } from '@/lib/core/post/get-posts';

export const dynamic = 'force-dynamic';

// GET /api/example - Fetch posts for authenticated user
const getHandler = Effect.gen(function* () {
  const posts = yield* getPosts();

  return yield* HttpServerResponse.json({ posts });
}).pipe(
  Effect.catchAll(error =>
    Match.value(error).pipe(
      Match.tag('UnauthenticatedError', () =>
        HttpServerResponse.json({ error: 'Not authenticated' }, { status: 401 })
      ),
      Match.orElse(e => {
        console.error('API error:', e);
        return HttpServerResponse.json({ error: 'Internal server error' }, { status: 500 });
      })
    )
  )
);

// Resolve the runtime lazily on first request: ManagedRuntime memoizes the
// layer build, and deferring keeps module import side-effect free so
// `next build` page-data collection doesn't require env vars.
let effectHandler: ((request: Request) => Promise<Response>) | undefined;

export const GET = async (request: Request) => {
  effectHandler ??= HttpApp.toWebHandlerRuntime(await AppRuntime.runtime())(getHandler);
  return effectHandler(request);
};
