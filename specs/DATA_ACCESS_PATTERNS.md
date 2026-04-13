# Data Access Patterns

This document defines how data flows between the client and server in this Next.js application with Effect-TS.

## Decision Tree

```
Need to fetch data for initial page render?
  └─> Use RSC (React Server Components)

Need to mutate data (create, update, delete)?
  └─> Use Server Actions

Need multiple independent queries?
  └─> Use Effect.all() in RSC or Server Actions

Need webhook endpoints for external services?
  └─> Use API routes
```

## Pattern 1: RSC for Data Loading

Load data directly in Server Components using Effect-TS. This is the **default pattern** for all read operations.

> **Important:** For pages that require authentication, see `specs/PAGE_PATTERNS.md` for the required Suspense + Content pattern with `export const dynamic = 'force-dynamic'`. Heavy pages should split data-fetching across leaf server components — see `specs/COMPONENT_PATTERNS.md`.

### Where reads can happen

RSC reads can happen at any level of the server tree, not only in `page.tsx`:

- **In the page's `Content` component** — default for light pages, see `PAGE_PATTERNS.md`
- **In a leaf server component** — for heavy pages with independent sections, see `COMPONENT_PATTERNS.md`
- **In a layout** — for shared data needed across multiple pages

The decision is about page weight, not about where reads are "allowed".

### When to Use

- Page initial render
- Layout data (user session, navigation counts)
- Any read-only data fetch

### Pattern (for authenticated pages)

```typescript
// app/(dashboard)/programs/page.tsx
import { Suspense } from 'react'
import { Effect, Match } from 'effect'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { getSession } from '@/lib/services/auth/get-session'
import { getPrograms } from '@/lib/core/program/get-programs'

export const dynamic = 'force-dynamic'

async function Content() {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      const programs = yield* getPrograms({ orgId: session.orgId })

      return (
        <div>
          {programs.map(program => (
            <ProgramCard key={program.id} program={program} />
          ))}
        </div>
      )
    }).pipe(
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.matchEffect({
        onFailure: error =>
          Match.value(error._tag).pipe(
            Match.when('UnauthenticatedError', () => NextEffect.redirect('/login')),
            Match.orElse(() => Effect.succeed(<ErrorMessage error={error} />))
          ),
        onSuccess: Effect.succeed
      })
    )
  )
}

export default async function ProgramsPage() {
  return (
    <Suspense fallback={<p>Loading...</p>}>
      <Content />
    </Suspense>
  )
}
```

### Domain Function

```typescript
// lib/core/program/get-programs.ts
import { Effect } from 'effect';
import { Db } from '@/lib/services/db/live-layer';
import * as schema from '@/lib/services/db/schema';
import { eq } from 'drizzle-orm';

export const getPrograms = (params: { orgId: string }) =>
  Effect.gen(function* () {
    const db = yield* Db;

    const programs = yield* db
      .select()
      .from(schema.program)
      .where(eq(schema.program.orgId, params.orgId));

    return programs;
  }).pipe(Effect.withSpan('Program.getPrograms'));
```

### Parallel Data Fetching with Effect.all

When a page needs multiple independent data sources, use `Effect.all()` to fetch them concurrently:

```typescript
// app/(dashboard)/page.tsx
async function Content() {
  await cookies();

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession();

      // Fetch all data in parallel
      const [programs, members, recentActivity] = yield* Effect.all(
        [
          getPrograms({ orgId: session.orgId }),
          getOrgMembers({ orgId: session.orgId }),
          getRecentActivity({ orgId: session.orgId })
        ],
        { concurrency: 'unbounded' }
      );

      return (
        <DashboardContent
          programs={programs}
          members={members}
          recentActivity={recentActivity}
        />
      );
    }).pipe(
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.matchEffect({
        onFailure: error =>
          Match.value(error._tag).pipe(
            Match.when('UnauthenticatedError', () => NextEffect.redirect('/login')),
            Match.orElse(() => Effect.succeed(<ErrorPage />))
          ),
        onSuccess: Effect.succeed
      })
    )
  );
}
```

**Key points:**

- **Always** pass `{ concurrency: 'unbounded' }` -- `Effect.all` defaults to sequential
- Fails fast if any effect fails
- Results are returned in array order matching input
- Use for independent queries that don't depend on each other's results

> **WARNING: Never pass raw Drizzle query builders directly to `Effect.all()`.**
> Drizzle's `drizzle-orm/effect-postgres` query builders implement `[Symbol.iterator]`
> and `[Effect.EffectTypeId]` via mixin, which makes `yield*` work in generators.
> However, they lack the `_op` property that the Effect fiber runtime requires,
> causing a `"Not a valid effect"` RuntimeException. Always wrap in `Effect.gen`:
>
> ```typescript
> // WRONG - raw Drizzle query builders in Effect.all
> yield* Effect.all([
>   db.select().from(table1).where(...),
>   db.select().from(table2).where(...)
> ]);
>
> // CORRECT - wrap each in Effect.gen, always pass concurrency
> yield* Effect.all(
>   [
>     Effect.gen(function* () {
>       return yield* db.select().from(table1).where(...);
>     }),
>     Effect.gen(function* () {
>       return yield* db.select().from(table2).where(...);
>     })
>   ],
>   { concurrency: 'unbounded' }
> );
>
> // ALSO CORRECT - use Effect-returning query functions
> yield* Effect.all(
>   [getPrograms(orgId), getOrgMembers(orgId)],
>   { concurrency: 'unbounded' }
> );
> ```

For complex queries with joins and aggregations, see [DRIZZLE_PATTERNS.md](./DRIZZLE_PATTERNS.md).

## Pattern 2: Server Actions for Mutations

Use Server Actions for all data mutations. One action per file, always ending in `-action.ts`.

### When to Use

- Creating records
- Updating records
- Deleting records
- Any operation that changes server state

### File Naming Convention

```
lib/core/[domain]/
├── get-programs.ts           # Read function (used in RSC)
├── create-program-action.ts  # Server action
├── update-program-action.ts  # Server action
├── delete-program-action.ts  # Server action
└── errors.ts                 # Domain-specific errors
```

### Server Action Pattern

```typescript
// lib/core/program/delete-program-action.ts
'use server';

import { Effect, Match } from 'effect';
import { revalidatePath } from 'next/cache';
import { AppLayer } from '@/lib/layers';
import { NextEffect } from '@/lib/next-effect';
import { getSession } from '@/lib/services/auth/get-session';
import { deleteProgram } from './delete-program';

export const deleteProgramAction = async (programId: string) => {
  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession();
      yield* Effect.annotateCurrentSpan({
        'user.id': session.user.id,
        'user.email': session.user.email
      });

      return yield* deleteProgram(programId);
    }).pipe(
      Effect.withSpan('action.program.delete', {
        attributes: {
          'program.id': programId,
          operation: 'program.delete'
        }
      }),
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.matchEffect({
        onFailure: error =>
          Match.value(error._tag).pipe(
            Match.when('UnauthenticatedError', () => NextEffect.redirect('/login')),
            Match.when('UnauthorizedError', () => NextEffect.redirect('/')),
            Match.orElse(() =>
              Effect.succeed({
                _tag: 'Error' as const,
                message: `Something went wrong: ${error.message}`
              })
            )
          ),
        onSuccess: () => Effect.sync(() => revalidatePath('/programs'))
      })
    )
  );
};
```

### Client Component Usage

```typescript
// components/delete-program-dialog.tsx
'use client'

import { useTransition } from 'react'
import { toast } from 'sonner'
import { deleteProgramAction } from '@/lib/core/program/delete-program-action'

export function DeleteProgramButton({ programId }: { programId: string }) {
  const [isPending, startTransition] = useTransition()

  const handleDelete = () => {
    startTransition(async () => {
      const result = await deleteProgramAction(programId)

      if (result?._tag === 'Error') {
        toast.error(result.message)
        return
      }

      toast.success('Program deleted')
    })
  }

  return (
    <button onClick={handleDelete} disabled={isPending}>
      {isPending ? 'Deleting...' : 'Delete'}
    </button>
  )
}
```

### Action Return Types

Server actions should return one of:

1. **Nothing** (void) - Action succeeded, page revalidated
2. **Error object** - Action failed with user-facing message
3. **Data** - Action succeeded with data to display

```typescript
// Success with revalidation (most common for mutations)
Effect.matchEffect({
  onFailure: error => /* ... */,
  onSuccess: () => Effect.sync(() => revalidatePath('/programs'))
})

// Success with data return
Effect.matchEffect({
  onFailure: error => /* ... */,
  onSuccess: data => Effect.succeed({ _tag: 'Success' as const, data })
})
```

## Pattern 3: API Routes (Exception Cases)

Only use API routes when:

1. **External webhooks** - Services calling your app (Stripe, auth callbacks)
2. **Parallelization needed** - Multiple independent DB queries that benefit from parallel execution
3. **Non-browser clients** - Mobile apps, CLI tools, third-party integrations

### When NOT to Use API Routes

- Regular CRUD operations (use server actions)
- Data loading for pages (use RSC)

### API Route Pattern (if needed)

```typescript
// app/api/webhooks/stripe/route.ts
import { Effect, Match } from 'effect';
import { HttpApp, HttpServerResponse } from '@effect/platform';
import { ManagedRuntime } from 'effect';
import { AppLayer } from '@/lib/layers';
import { handleStripeWebhook } from '@/lib/core/billing/handle-stripe-webhook';

const postHandler = Effect.gen(function* () {
  yield* handleStripeWebhook();
  return yield* HttpServerResponse.json({ received: true });
}).pipe(
  Effect.catchAll(error =>
    Match.value(error).pipe(
      Match.tag('WebhookVerificationError', () =>
        HttpServerResponse.json({ error: 'Invalid signature' }, { status: 400 })
      ),
      Match.orElse(() => HttpServerResponse.json({ error: 'Internal error' }, { status: 500 }))
    )
  )
);

const managedRuntime = ManagedRuntime.make(AppLayer);
const runtime = await managedRuntime.runtime();
const effectHandler = HttpApp.toWebHandlerRuntime(runtime)(postHandler);

export const POST = (request: Request) => effectHandler(request);
```

## Pattern 4: Client-Side Mutations via API Routes (Heavy Pages)

On heavy `force-dynamic` pages (many parallel queries), every `'use server'` action invocation causes Next.js to regenerate the entire RSC payload of the current page as part of the action response. On a page like the workstream detail view (~10 parallel queries), this costs ~3–8s per mutation — even with fire-and-forget, the server burns CPU regenerating a payload nobody reads.

**Use API route handlers instead of server actions when all of these hold:**

1. The page is `force-dynamic` with expensive data loading (≥5 parallel queries)
2. Mutations are high-frequency (assign, status change, inline edit) — not rare one-offs
3. The client already manages optimistic state (the RSC regen adds nothing)

### Architecture

Split each mutation into three pieces:

| Piece | Location | Role |
| ----- | -------- | ---- |
| Pure Effect | `lib/core/[domain]/[op].ts` | Business logic, auth, validation. No `'use server'`, no `NextEffect.runPromise`. Reusable by route handler + tests. |
| Route handler | `app/api/[domain]/[op]/route.ts` | Thin POST handler: decode body, run Effect, map errors to HTTP status, return `{ _tag: 'Success' | 'Error' }` JSON. |
| Typed client | `lib/api-client/[domain].ts` | `'use client'` fetch wrapper using `@effect/platform` HttpClient. Returns same `{ _tag }` discriminated union. |

### Pure Effect function

```typescript
// lib/core/task/assign-task.ts
import { Effect, Schema as S } from 'effect'
import { requireWorkstreamAccess } from '@/lib/core/auth/require-workstream-access'
import { Db } from '@/lib/services/db/live-layer'
import { ValidationError } from '@/lib/core/errors'

export const AssignTaskInputSchema = S.Struct({
  taskId: S.String.pipe(S.minLength(1)),
  workstreamId: S.String.pipe(S.minLength(1)),
  assignedTo: S.String.pipe(S.minLength(1))
})

export const assignTask = (rawInput: unknown) =>
  Effect.gen(function* () {
    const parsed = yield* S.decodeUnknown(AssignTaskInputSchema)(rawInput).pipe(
      Effect.mapError(() => new ValidationError({ message: 'Invalid input', field: 'input' }))
    )
    const ctx = yield* requireWorkstreamAccess(parsed.workstreamId)
    const db = yield* Db
    // ... business logic
    return { task: updatedTask, programId: ctx.program.id }
  }).pipe(Effect.withSpan('task.assign'))
```

### Route handler

```typescript
// app/api/tasks/assign/route.ts
import { Effect, Match } from 'effect'
import { AppLayer } from '@/lib/layers'
import { assignTask } from '@/lib/core/task/assign-task'

export async function POST(request: Request) {
  const body = await request.json().catch(() => null)

  const result = await Effect.runPromise(
    assignTask(body).pipe(
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.matchEffect({
        onFailure: error =>
          Match.value(error._tag).pipe(
            Match.when('UnauthenticatedError', () =>
              Effect.succeed(Response.json(
                { _tag: 'Error', message: 'Authentication required' }, { status: 401 }
              ))
            ),
            Match.when('UnauthorizedError', () =>
              Effect.succeed(Response.json(
                { _tag: 'Error', message: error.message }, { status: 403 }
              ))
            ),
            Match.when('ValidationError', () =>
              Effect.succeed(Response.json(
                { _tag: 'Error', message: error.message }, { status: 400 }
              ))
            ),
            Match.orElse(() =>
              Effect.succeed(Response.json(
                { _tag: 'Error', message: 'Failed to assign task' }, { status: 500 }
              ))
            )
          ),
        onSuccess: ({ task }) =>
          Effect.sync(() => Response.json({ _tag: 'Success', task }))
      })
    )
  )
  return result
}
```

### Typed client wrapper

```typescript
// lib/api-client/tasks.ts
'use client'

import { Schema as S } from 'effect'
import { apiPost } from './internal-fetch'

const TaskSuccessSchema = S.Struct({
  _tag: S.Literal('Success'),
  task: S.Unknown
})

export const assignTask = (input: {
  readonly taskId: string
  readonly workstreamId: string
  readonly assignedTo: string
}) => apiPost('/api/tasks/assign', input, TaskSuccessSchema)
```

`apiPost` uses `@effect/platform` HttpClient + FetchHttpClient. See `lib/api-client/internal-fetch.ts`.

### Client component with optimistic state

The parent client component manages `localTasks` state. Mutations update local state immediately, fire the API call, and revert on error:

```typescript
const handleAssigned = useCallback(
  (taskId: string, userId: string, member: MemberOption) => {
    // Optimistic: update immediately
    setLocalTasks(prev => prev.map(t =>
      t.id === taskId
        ? { ...t, assignedTo: userId, assigneeName: member.userName }
        : t
    ))
    // Fire-and-forget: no startTransition, no RSC regen
    assignTask({ taskId, workstreamId, assignedTo: userId }).then(result => {
      if (result._tag === 'Error') {
        setLocalTasks(prev => prev.map(t =>
          t.id === taskId ? tasks.find(orig => orig.id === taskId) ?? t : t
        ))
        onError(result.message)
      }
    })
  },
  [workstreamId, tasks, onError]
)
```

### When NOT to use this pattern

- Light pages (< 5 parallel queries) — server action overhead is negligible
- Rare mutations (create program, delete workstream) — user won't notice 1–2s on a one-off
- Mutations that need `revalidatePath`/`revalidateTag` to update other server-rendered sections immediately

### File naming

```
lib/core/[domain]/
├── assign-task.ts              # Pure Effect (used by route handler + tests)
├── assign-task.test.ts         # Tests the pure Effect via runEffectAsAction helper
├── get-programs.ts             # Read function (used in RSC)
├── create-program-action.ts    # Server action (light pages, rare mutations)
└── errors.ts                   # Domain-specific errors

app/api/[domain]/[op]/
└── route.ts                    # Thin POST handler

lib/api-client/
└── tasks.ts                    # Typed client wrappers ('use client')
```

## Summary: Which Pattern to Use

| Operation            | Pattern                        | Location                         |
| -------------------- | ------------------------------ | -------------------------------- |
| Page data loading    | RSC                            | `app/*/page.tsx`                 |
| Create/Update/Delete | Server Action                  | `lib/core/[domain]/*-action.ts`  |
| High-freq mutations  | API Route + optimistic client  | `app/api/*/route.ts` + `lib/api-client/*.ts` |
| External webhooks    | API Route                      | `app/api/webhooks/*/route.ts`    |
| Auth callbacks       | API Route (better-auth)        | `app/api/auth/[...all]/route.ts` |
| Third-party API      | API Route                      | `app/api/*/route.ts`             |

## Key Principles

1. **Prefer server actions over API routes** — unless the page is heavy and mutations are frequent
2. **One action per file** - Easier to find, test, and maintain
3. **Use `revalidatePath`** - Keep UI in sync after mutations (server actions)
4. **Always use `NextEffect.runPromise`** - Handles redirects correctly (RSC + server actions)
5. **Consistent error handling** - Return typed error objects for client handling
6. **Use `Effect.all([], { concurrency: 'unbounded' })` for parallel queries** - Default is sequential
7. **Optimistic state for API route mutations** — client manages `localTasks` and merges server responses via callbacks

## See Also

- [DRIZZLE_PATTERNS.md](./DRIZZLE_PATTERNS.md) - Database query patterns
- [SERVER_ACTION_PATTERNS.md](./SERVER_ACTION_PATTERNS.md) - Complete action templates
- [PAGE_PATTERNS.md](./PAGE_PATTERNS.md) - Suspense + Content pattern
- [COMPONENT_PATTERNS.md](./COMPONENT_PATTERNS.md) - Leaf data-loading server components for heavy pages
