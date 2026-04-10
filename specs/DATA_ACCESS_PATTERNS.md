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

## Summary: Which Pattern to Use

| Operation            | Pattern                 | Location                         |
| -------------------- | ----------------------- | -------------------------------- |
| Page data loading    | RSC                     | `app/*/page.tsx`                 |
| Create/Update/Delete | Server Action           | `lib/core/[domain]/*-action.ts`  |
| External webhooks    | API Route               | `app/api/webhooks/*/route.ts`    |
| Auth callbacks       | API Route (better-auth) | `app/api/auth/[...all]/route.ts` |
| Third-party API      | API Route               | `app/api/*/route.ts`             |

## Key Principles

1. **Prefer server actions over API routes** - Less boilerplate, better type safety
2. **One action per file** - Easier to find, test, and maintain
3. **Use `revalidatePath`** - Keep UI in sync after mutations
4. **Always use `NextEffect.runPromise`** - Handles redirects correctly
5. **Consistent error handling** - Return typed error objects for client handling
6. **Use `Effect.all([], { concurrency: 'unbounded' })` for parallel queries** - Default is sequential

## See Also

- [DRIZZLE_PATTERNS.md](./DRIZZLE_PATTERNS.md) - Database query patterns
- [SERVER_ACTION_PATTERNS.md](./SERVER_ACTION_PATTERNS.md) - Complete action templates
- [PAGE_PATTERNS.md](./PAGE_PATTERNS.md) - Suspense + Content pattern
- [COMPONENT_PATTERNS.md](./COMPONENT_PATTERNS.md) - Leaf data-loading server components for heavy pages
