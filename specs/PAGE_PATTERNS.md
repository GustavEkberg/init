# Page Patterns for Dynamic Routes

This document defines patterns for building pages that require authentication or other dynamic server features in Next.js 16 with Effect-TS.

## The Problem

Next.js attempts to statically prerender pages at build time. Pages that use `cookies()`, `headers()`, or authentication fail during this prerendering phase with errors like:

```
Error: Dynamic server usage: Route /dashboard couldn't be rendered statically
because it used `cookies`. See more info here: https://nextjs.org/docs/messages/dynamic-server-error
```

## Solutions

Two patterns, picked by page weight:

| Pattern                  | When to use                                                                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Content fetches all**  | Light pages: one or two cheap queries, or data that's tightly coupled. Single `Content` component awaits everything.                                       |
| **Shell + leaf components** | Heavy pages: multiple independent sections, the slowest query would otherwise block the whole page, or sections need independent refresh. `Content` becomes a thin shell that does only auth + layout, and each section is its own async server component wrapped in its own `<Suspense>`. See [COMPONENT_PATTERNS.md](./COMPONENT_PATTERNS.md). |

Both patterns share the same required elements.

### Required Elements

1. **`export const dynamic = 'force-dynamic'`** - Opt out of static generation
2. **`await cookies()`** - Called at start of Content to ensure dynamic rendering
3. **`<Suspense>` wrapper** - Provides loading state during server render
4. **`Effect.matchEffect`** - Typed error handling with redirects

## Pattern: Basic Dynamic Page

```typescript
// app/(dashboard)/posts/page.tsx
import { Suspense } from 'react'
import { Effect, Match } from 'effect'
import { cookies } from 'next/headers'
import { NextEffect } from '@/lib/next-effect'
import { AppLayer } from '@/lib/layers'
import { getSession } from '@/lib/services/auth/get-session'
import { getPosts } from '@/lib/core/post/get-posts'

export const dynamic = 'force-dynamic'

async function Content() {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      const posts = yield* getPosts({ userId: session.user.id })

      return (
        <div className="p-6">
          <h1 className="text-2xl font-bold">Posts</h1>
          <PostList posts={posts} />
        </div>
      )
    }).pipe(
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.matchEffect({
        onFailure: error =>
          Match.value(error._tag).pipe(
            Match.when('UnauthenticatedError', () => NextEffect.redirect('/login')),
            Match.orElse(() =>
              Effect.succeed(
                <div className="p-6">
                  <p>Something went wrong.</p>
                  <p className="text-red-500">Error: {error.message}</p>
                </div>
              )
            )
          ),
        onSuccess: Effect.succeed
      })
    )
  )
}

export default async function PostsPage() {
  return (
    <Suspense fallback={<p className="p-6">Laddar...</p>}>
      <Content />
    </Suspense>
  )
}
```

## Pattern: Shell + Leaf Components (heavy pages)

When a page has multiple expensive, independent sections, do not block HTML on the slowest one. Make `Content` a thin shell that only authenticates and renders the layout, then put each section in its own async server component (a "leaf") wrapped in its own `<Suspense>` boundary. Leaves stream in parallel; each renders its own skeleton until ready; a slow leaf does not delay any other.

```typescript
// app/(dashboard)/[orgSlug]/program/[programId]/workstream/[workstreamId]/page.tsx
import { Suspense } from 'react'
import { Effect, Match } from 'effect'
import { cookies } from 'next/headers'
import { NextEffect } from '@/lib/next-effect'
import { AppLayer } from '@/lib/layers'
import { requireWorkstreamAccess } from '@/lib/core/auth/require-workstream-access'
import { WorkstreamHeaderLeaf } from './header-leaf'
import { WorkstreamEVSectionLeaf } from './ev-section-leaf'
import { WorkstreamTaskListLeaf } from './task-list-leaf'
import { WorkstreamTeamLeaf } from './team-leaf'
import { HeaderSkeleton, EVSkeleton, TaskListSkeleton, TeamSkeleton } from './skeletons'

export const dynamic = 'force-dynamic'

async function Content({ orgSlug, workstreamId }: Props) {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const ctx = yield* requireWorkstreamAccess(workstreamId)

      if (ctx.effectiveRole !== 'admin' && ctx.wsMembership === undefined) {
        return yield* NextEffect.redirect(`/${orgSlug}/program/${ctx.program.id}`)
      }

      // Shell only — no data fetching here.
      return (
        <div className="mx-auto w-full max-w-6xl space-y-8 p-6">
          <Suspense fallback={<HeaderSkeleton />}>
            <WorkstreamHeaderLeaf workstreamId={workstreamId} />
          </Suspense>
          <Suspense fallback={<EVSkeleton />}>
            <WorkstreamEVSectionLeaf
              workstreamId={workstreamId}
              programId={ctx.program.id}
            />
          </Suspense>
          <Suspense fallback={<TaskListSkeleton />}>
            <WorkstreamTaskListLeaf
              workstreamId={workstreamId}
              programId={ctx.program.id}
            />
          </Suspense>
          <Suspense fallback={<TeamSkeleton />}>
            <WorkstreamTeamLeaf workstreamId={workstreamId} />
          </Suspense>
        </div>
      )
    }).pipe(
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.matchEffect({
        onFailure: error =>
          Match.value(error._tag).pipe(
            Match.when('UnauthenticatedError', () => NextEffect.redirect('/login')),
            Match.when('UnauthorizedError', () => NextEffect.redirect('/')),
            Match.orElse(() => Effect.succeed(<ErrorMessage error={error} />))
          ),
        onSuccess: Effect.succeed
      })
    )
  )
}
```

Each leaf is an async server component that takes only identifiers as props, runs its own Effect pipeline, and returns JSX. See [COMPONENT_PATTERNS.md](./COMPONENT_PATTERNS.md) for the leaf contract, caching, refresh semantics, and worked examples.

**When to choose this pattern**:

- The page has multiple sections that fetch independently expensive data.
- Time-to-first-byte for the shell matters more than waiting for everything.
- Sections need to refresh independently (e.g. mutating tasks should not refetch the team list).

**When to stay with single-Content**:

- The page has one or two cheap queries.
- All sections share the same data (one `Effect.all` is the right shape).
- The "slowest" query is also the cheapest.

## Pattern: Page with URL State (nuqs)

When using nuqs for filters/search, pass searchParams to Content:

```typescript
// app/(dashboard)/posts/page.tsx
import { Suspense } from 'react'
import { Effect, Match } from 'effect'
import { cookies } from 'next/headers'
import type { SearchParams } from 'nuqs/server'
import { NextEffect } from '@/lib/next-effect'
import { AppLayer } from '@/lib/layers'
import { getSession } from '@/lib/services/auth/get-session'
import { getPosts } from '@/lib/core/post/get-posts'
import { loadSearchParams } from './search-params'
import { PostFilters } from './post-filters'

export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<SearchParams>
}

async function Content({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await cookies()

  const { q, status, sortBy } = await loadSearchParams(searchParams)

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      const posts = yield* getPosts({
        userId: session.user.id,
        query: q,
        status,
        sortBy
      })

      return (
        <div className="p-6">
          <h1 className="text-2xl font-bold">Posts</h1>
          <PostFilters />
          <PostList posts={posts} />
        </div>
      )
    }).pipe(
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.matchEffect({
        onFailure: error =>
          Match.value(error._tag).pipe(
            Match.when('UnauthenticatedError', () => NextEffect.redirect('/login')),
            Match.orElse(() =>
              Effect.succeed(
                <div className="p-6">
                  <p>Something went wrong.</p>
                  <p className="text-red-500">Error: {error.message}</p>
                </div>
              )
            )
          ),
        onSuccess: Effect.succeed
      })
    )
  )
}

export default async function PostsPage({ searchParams }: Props) {
  return (
    <Suspense fallback={<p className="p-6">Laddar...</p>}>
      <Content searchParams={searchParams} />
    </Suspense>
  )
}
```

## Pattern: Admin-Only Page with Role Check

Redirect non-admins inside the Effect pipeline using `NextEffect.redirect()`:

```typescript
async function Content() {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()

      // Role check inside Effect - redirects cleanly
      if (session.user.role !== 'ADMIN') {
        return yield* NextEffect.redirect('/dashboard')
      }

      const users = yield* getUsers()

      return (
        <div className="p-6">
          <h1 className="text-2xl font-bold">Admin Panel</h1>
          <UserList users={users} />
        </div>
      )
    }).pipe(
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.matchEffect({
        onFailure: error =>
          Match.value(error._tag).pipe(
            Match.when('UnauthenticatedError', () => NextEffect.redirect('/login')),
            Match.orElse(() =>
              Effect.succeed(
                <div className="p-6">
                  <p>Something went wrong.</p>
                  <p className="text-red-500">Error: {error.message}</p>
                </div>
              )
            )
          ),
        onSuccess: Effect.succeed
      })
    )
  )
}
```

## Pattern: Conditional Data Loading

Load different data based on user role without nested async components:

```typescript
async function Content() {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      const isAdmin = session.user.role === 'ADMIN'

      // User data - always loaded
      const userPosts = yield* getPosts({ userId: session.user.id })

      // Non-admin: return early with just user data
      if (!isAdmin) {
        return (
          <div className="p-6">
            <h1 className="text-2xl font-bold">My Posts</h1>
            <PostList posts={userPosts} />
          </div>
        )
      }

      // Admin: load additional data
      const allPosts = yield* getAllPosts()
      const analytics = yield* getAnalytics()

      return (
        <div className="p-6">
          <h1 className="text-2xl font-bold">Admin Dashboard</h1>
          <Analytics data={analytics} />
          <h2 className="text-xl font-semibold mt-8">All Posts</h2>
          <PostList posts={allPosts} />
          <h2 className="text-xl font-semibold mt-8">My Posts</h2>
          <PostList posts={userPosts} />
        </div>
      )
    }).pipe(
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.matchEffect({
        onFailure: error =>
          Match.value(error._tag).pipe(
            Match.when('UnauthenticatedError', () => NextEffect.redirect('/login')),
            Match.orElse(() =>
              Effect.succeed(
                <div className="p-6">
                  <p>Something went wrong.</p>
                  <p className="text-red-500">Error: {error.message}</p>
                </div>
              )
            )
          ),
        onSuccess: Effect.succeed
      })
    )
  )
}
```

## Pattern: Role-Based Page Variants with Permissions Context

When a page needs different content for admins vs members, use `ProgramPermissions` or `OrgPermissions` context instead of prop drilling booleans.

### Server-Side: Page Gates + Data Branching

Admin-only pages redirect members server-side. Pages with member variants branch early in the Effect pipeline:

```typescript
async function Content({ orgSlug, programId }: Props) {
  await cookies();

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const { session, effectiveRole } = yield* requireProgramAccess(programId);

      // Gate: member hitting admin-only page
      if (effectiveRole === 'member') {
        return yield* NextEffect.redirect(`/${orgSlug}/program/${programId}`);
      }

      // Admin-only data loading continues...
      const data = yield* getAdminData(programId);
      return <AdminPageContent data={data} />;
    }).pipe(/* ... */)
  );
}
```

For pages with member variants, use early return to avoid loading admin-only data:

```typescript
Effect.gen(function* () {
  const { session, effectiveRole } = yield* requireProgramAccess(programId);

  // Member path: load scoped data, return different component
  if (effectiveRole === 'member') {
    const myTasks = yield* getUserProgramTasks(session.user.id, programId);
    return <MemberDashboard tasks={myTasks} />;
  }

  // Admin path: load full data
  const [tasks, members, stats] = yield* Effect.all([...], { concurrency: 'unbounded' });
  return <AdminDashboard tasks={tasks} members={members} stats={stats} />;
})
```

### Client-Side: Permissions Context

Client components read permissions from React context instead of receiving boolean props:

```typescript
'use client';

import { useProgramPermissions } from '@/lib/core/auth/program-permissions-context';

export function MilestoneCard({ milestone }: Props) {
  const permissions = useProgramPermissions();

  return (
    <div>
      <h3>{milestone.name}</h3>
      {permissions.canManageMilestones && (
        <Button onClick={handleEdit}>Edit</Button>
      )}
    </div>
  );
}
```

### Anti-Pattern: Boolean Prop Drilling

```typescript
// BAD — prop drilling role booleans through component tree
<MilestoneList isProgramAdmin={isProgramAdmin} isOrgAdmin={isOrgAdmin} />

// GOOD — component reads from context
<MilestoneList />
// Inside MilestoneList:
const { canManageMilestones } = useProgramPermissions();
```

### Key Files

- `lib/core/auth/permissions.ts` — pure resolver functions
- `lib/core/auth/program-permissions-context.tsx` — React context + hook
- `lib/core/auth/org-permissions-context.tsx` — React context + hook
- `app/(dashboard)/[orgSlug]/program/[programId]/layout.tsx` — provider integration
- `app/(dashboard)/[orgSlug]/layout.tsx` — org provider integration

## Anti-Patterns

### AVOID: Monolithic Content awaiting every query for a heavy page

Single `Content` components that `Effect.all` over many independent queries block HTML on the slowest one. The page can't ship until every query resolves, and `router.refresh()` after a mutation re-runs all of them — even ones unaffected by the mutation.

```typescript
// BAD — heavy page, single Content, every query blocks first paint
async function Content() {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const ctx = yield* requireWorkstreamAccess(workstreamId)

      // 8+ queries — slowest one gates the whole page
      const [tasks, members, ev, programTasks, history, items, risks, mitigations] =
        yield* Effect.all(
          [
            getWorkstreamTasks(workstreamId),
            getWorkstreamMembers(workstreamId),
            buildEVData(workstreamId, ctx.program),
            getProgramTasks(ctx.program.id),
            getTaskStatusHistoryForTasks(taskIds),
            getTaskItemsForTasks(taskIdsWithItems),
            getTaskRiskHistoryForTasks(taskIds),
            getMitigationActionsForTasks(atRiskTaskIds)
          ],
          { concurrency: 'unbounded' }
        )

      return <BigClientComponent {...everything} />
    })
  )
}
```

**Solution:** Split into shell + leaves. See "Pattern: Shell + Leaf Components (heavy pages)" above and [COMPONENT_PATTERNS.md](./COMPONENT_PATTERNS.md). Nested async server components inside `<Suspense>` are fully supported in Next 16 with React 19; each leaf streams in independently.

### NEVER: Missing `export const dynamic`

Without explicit dynamic marking, Next.js attempts static prerendering:

```typescript
// BAD - No dynamic export
async function Content() {
  await cookies(); // This alone is not enough!
  // ...
}
```

**Solution:** Always add at the top of the file:

```typescript
export const dynamic = 'force-dynamic';
```

### NEVER: Auth Outside Effect Pipeline

Don't call `redirect()` directly outside the Effect context:

```typescript
// BAD - redirect() outside Effect
async function Content() {
  await cookies();
  const session = await getSessionSomehow();

  if (!session) {
    redirect('/login'); // This won't work correctly with Effect
  }
}
```

**Solution:** Use `NextEffect.redirect()` inside the Effect pipeline:

```typescript
// GOOD - redirect inside Effect
return await NextEffect.runPromise(
  Effect.gen(function* () {
    const session = yield* getSession();
    if (!session.user.isAdmin) {
      return yield* NextEffect.redirect('/dashboard');
    }
    // ...
  })
);
```

## Error Handling Pattern

Always use `Effect.matchEffect` with typed error tags:

```typescript
Effect.matchEffect({
  onFailure: error =>
    Match.value(error._tag).pipe(
      // Auth errors -> redirect to login
      Match.when('UnauthenticatedError', () => NextEffect.redirect('/login')),
      // Permission errors -> redirect to home
      Match.when('UnauthorizedError', () => NextEffect.redirect('/')),
      // All other errors -> show error UI
      Match.orElse(() =>
        Effect.succeed(
          <div className="p-6">
            <p>Something went wrong.</p>
            <p className="text-red-500">Error: {error.message}</p>
          </div>
        )
      )
    ),
  onSuccess: Effect.succeed
})
```

## Pattern: Passing Data to Client Components

When passing data from server to client components, ensure all data is serializable:

### Server Component

```typescript
async function Content({ searchParams }: Props) {
  await cookies();

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession();

      // Fetch multiple data sources in parallel
      const [transactions, categories, stats] = yield* Effect.all(
        [
          getTransactions({ userId: session.user.id }),
          getCategories(),
          getStats(session.user.id)
        ],
        { concurrency: 'unbounded' }
      );

      // Convert non-serializable types before passing to client
      // Maps -> Arrays, Classes -> Plain objects
      const statsArray = Array.from(stats.byCategory.entries()).map(([id, data]) => ({
        categoryId: id,
        ...data
      }));

      // Pass ONLY serializable data to client component
      return (
        <DashboardContent
          // Plain objects and arrays are fine
          transactions={transactions}
          // Pick only needed fields to reduce payload
          categories={categories.map(c => ({
            id: c.id,
            name: c.name,
            icon: c.icon
          }))}
          // Converted Map data
          categoryStats={statsArray}
          // Primitives
          userName={session.user.name}
        />
      );
    }).pipe(/* ... */)
  );
}
```

### Client Component Props Types

Define types locally in client components - don't import server-side types:

```typescript
// components/dashboard-content.tsx
'use client';

// Define types locally - these match the serialized shape
type Transaction = {
  id: string;
  date: Date;         // RSC serializes Dates correctly
  merchant: string;
  amount: string;     // Decimal columns return strings
  categoryId: string | null;
};

type Category = {
  id: string;
  name: string;
  icon: string | null;
};

type CategoryStat = {
  categoryId: string;
  total: number;
  count: number;
};

type Props = {
  transactions: Transaction[];
  categories: Category[];
  categoryStats: CategoryStat[];
  userName: string;
};

export function DashboardContent({
  transactions,
  categories,
  categoryStats,
  userName
}: Props) {
  // All data received via props - no fetching in client component
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  // Client-side filtering, sorting, etc.
  const filtered = selectedCategory
    ? transactions.filter(t => t.categoryId === selectedCategory)
    : transactions;

  return (
    <div>
      <h1>Welcome, {userName}</h1>
      <CategoryFilter categories={categories} onSelect={setSelectedCategory} />
      <TransactionList transactions={filtered} />
    </div>
  );
}
```

### Serialization Rules

| Type                | Serializable? | Solution                                      |
| ------------------- | ------------- | --------------------------------------------- |
| Plain objects       | Yes           | Pass directly                                 |
| Arrays              | Yes           | Pass directly                                 |
| Dates               | Yes           | RSC handles Date serialization                |
| Strings/Numbers     | Yes           | Pass directly                                 |
| `Map`               | No            | Convert to array of `[key, value]` or objects |
| `Set`               | No            | Convert to array                              |
| Classes             | Partial       | Pick plain fields, don't pass methods         |
| Functions           | No            | Never pass functions as props                 |
| `Decimal` (Drizzle) | Partial       | Returns as string, parse in client if needed  |

## Checklist for New Pages

- [ ] Add `export const dynamic = 'force-dynamic'` at top of file
- [ ] Create `Content` async function with `await cookies()` as first line
- [ ] Wrap Content in `<Suspense>` with appropriate fallback
- [ ] Use `Effect.matchEffect` for error handling
- [ ] Handle `UnauthenticatedError` with redirect to `/login`
- [ ] Decide: single-Content (light page) or shell + leaves (heavy page) — see [COMPONENT_PATTERNS.md](./COMPONENT_PATTERNS.md)
- [ ] Pass data to client components as props (or pass identifiers to leaf server components)
- [ ] Ensure all props are serializable (no Maps, Sets, or functions)
- [ ] Define prop types locally in client components

## Summary

| Element                                        | Purpose                                        |
| ---------------------------------------------- | ---------------------------------------------- |
| `export const dynamic`                         | Opt out of static prerendering                 |
| `await cookies()`                              | Signal dynamic rendering to Next.js            |
| `<Suspense>` wrapper                           | Provide loading state                          |
| `NextEffect.runPromise()`                      | Handle redirects outside Effect context        |
| `Effect.matchEffect`                           | Typed error handling with clean redirects      |
| Single Content (light) or shell + leaves (heavy) | Pick by page weight; leaves stream in parallel |
| `Effect.all([], { concurrency: 'unbounded' })` | Parallel data fetching (default is sequential) |
| Serializable props                             | Client components receive plain data           |

## See Also

- [COMPONENT_PATTERNS.md](./COMPONENT_PATTERNS.md) - Leaf data-loading server components
- [DATA_ACCESS_PATTERNS.md](./DATA_ACCESS_PATTERNS.md) - When to use RSC vs server actions
- [SERVER_ACTION_PATTERNS.md](./SERVER_ACTION_PATTERNS.md) - Mutation patterns
- [NUQS_URL_STATE.md](./NUQS_URL_STATE.md) - URL state with nuqs
