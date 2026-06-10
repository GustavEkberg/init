import { Effect } from 'effect';
import { Auth } from '@/lib/services/auth/live-layer';
import { AppRuntime } from '@/lib/layers';
import { toNextJsHandler } from 'better-auth/next-js';

// Resolve the better-auth handler lazily on first request via the shared
// runtime — the Auth service (and its db pool) is memoized by AppRuntime,
// not rebuilt per request. Deferring keeps module import side-effect free
// so `next build` page-data collection doesn't require env vars.
let cachedHandler: ReturnType<typeof toNextJsHandler> | undefined;

const getHandler = async () => {
  if (!cachedHandler) {
    const auth = await AppRuntime.runPromise(Effect.map(Auth, authService => authService.auth));
    cachedHandler = toNextJsHandler(auth.handler);
  }
  return cachedHandler;
};

export const GET = async (request: Request) => (await getHandler()).GET(request);
export const POST = async (request: Request) => (await getHandler()).POST(request);
