# Component Patterns

This document defines patterns for building **leaf data-loading server components**: async server components that take only identifying props, fetch their own data via Effect, and stream into a parent shell via `<Suspense>`. Use these for any heavy page where sections fetch independent data.

For the shell that hosts leaves, see [PAGE_PATTERNS.md](./PAGE_PATTERNS.md) "Pattern: Shell + Leaf Components".

## Why

A monolithic `Content` component that awaits everything in one `Effect.all` blocks HTML on the slowest query. Splitting sections into leaves means:

- **Parallel streaming.** Each leaf renders its skeleton immediately and streams content as soon as its own data is ready. The slowest leaf does not delay any other.
- **Independent error boundaries.** A failure in the EV chart does not break the task list.
- **Targeted refresh.** Combined with `'use cache'` + `cacheTag` (see below), a mutation can invalidate exactly one leaf without re-running the others.
- **Smaller files.** Each leaf is its own file with one concern.

## Leaves vs Reusable Components

Leaves are **page-specific**. They live next to the page that uses them, fetch data for that page's exact needs, and are not designed for reuse. If two pages need the same section, do not share a leaf — write a reusable presentational component that takes data as props, then have each page's leaf fetch and pass that data.

| Kind                       | Where it lives                              | Takes                          | Fetches data?       |
| -------------------------- | ------------------------------------------- | ------------------------------ | ------------------- |
| **Leaf**                   | Co-located with the page (`*-leaf.tsx`)    | Identifier props only          | Yes — its own       |
| **Reusable component**     | `components/ui/` or shared module           | Data + presentation props      | No — takes props    |
| **Page-specific client UI** | Co-located with the page                   | Data + handlers                | No — takes props    |

Rule of thumb: if a section is used in exactly one page and has its own data shape, it's a leaf. Anything used in two or more places is a reusable component that takes props. Leaves can render reusable components — that's the normal composition.

## The Leaf Contract

A leaf is an **async server component** that:

1. Takes only **serializable identifiers** as props (`workstreamId`, `taskId`, `programId`, etc.). Never receives pre-fetched data from a parent.
2. Runs its own Effect pipeline via `NextEffect.runPromise`.
3. Provides its own `<Suspense>` fallback **at the call site in the parent** (the shell), not inside the leaf itself.
4. Provides its own error UI via `Effect.matchEffect` — failures are scoped to the leaf.
5. Returns JSX (server-rendered, may render client components as children).
6. Does **not** call `await cookies()` — that runs once in the shell. The leaf inherits the page's `force-dynamic`.
7. Does **not** re-check auth — auth is enforced once in the shell. Leaves trust the call.

## Required Elements

| Element                              | Where                              | Why                                                       |
| ------------------------------------ | ---------------------------------- | --------------------------------------------------------- |
| `async function`                     | the leaf                           | enables `await` / RSC streaming                           |
| `NextEffect.runPromise(...)`         | inside the leaf                    | runs the Effect, handles redirects                        |
| `Effect.provide(AppLayer)`           | end of pipeline                    | provides services                                         |
| `Effect.matchEffect`                 | end of pipeline                    | per-leaf error UI                                         |
| `<Suspense fallback={...}>` wrapper  | the **parent** (shell), not leaf   | streaming boundary; fallback shows until leaf resolves    |
| Identifier-only props                | leaf signature                     | no pre-fetched data; the leaf owns its fetch              |
| `'use cache'` + `cacheTag(...)`      | inside data-fetching helper        | enables targeted invalidation via `revalidateTag`         |

## Worked Example

```typescript
// app/(dashboard)/[orgSlug]/program/[programId]/workstream/[workstreamId]/ev-section-leaf.tsx
import { Effect, Match } from 'effect'
import { NextEffect } from '@/lib/next-effect'
import { AppLayer } from '@/lib/layers'
import { getWorkstreamEVData } from '@/lib/core/cost/get-workstream-ev-data'
import { WorkstreamEVSection } from './workstream-ev-section'
import { EVErrorCard } from './ev-error-card'

type Props = {
  workstreamId: string
  programId: string
}

export async function WorkstreamEVSectionLeaf({ workstreamId, programId }: Props) {
  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const data = yield* getWorkstreamEVData(workstreamId, programId)
      return <WorkstreamEVSection {...data} />
    }).pipe(
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.matchEffect({
        onFailure: error =>
          Effect.succeed(<EVErrorCard message={error.message ?? 'Failed to load earned value'} />),
        onSuccess: Effect.succeed
      })
    )
  )
}
```

The shell renders it like this:

```typescript
<Suspense fallback={<EVSkeleton />}>
  <WorkstreamEVSectionLeaf workstreamId={workstreamId} programId={programId} />
</Suspense>
```

Notes:

- No `await cookies()` — the shell already called it.
- No auth check — the shell already gated access via `requireWorkstreamAccess`.
- Failure shows the local `<EVErrorCard>` — task list and team leaves keep working.
- `getWorkstreamEVData` is a regular Effect function in `lib/core/`.

## Parallel Streaming

Sibling leaves under the **same** `<Suspense>` block each other (one boundary, one waterfall). To stream them in parallel, give each its own boundary:

```typescript
// GOOD — three boundaries, three parallel streams
<Suspense fallback={<HeaderSkeleton />}>
  <HeaderLeaf workstreamId={id} />
</Suspense>
<Suspense fallback={<EVSkeleton />}>
  <EVSectionLeaf workstreamId={id} programId={pid} />
</Suspense>
<Suspense fallback={<TaskListSkeleton />}>
  <TaskListLeaf workstreamId={id} programId={pid} />
</Suspense>
```

```typescript
// BAD — single boundary, all three serialize behind the slowest
<Suspense fallback={<PageSkeleton />}>
  <HeaderLeaf workstreamId={id} />
  <EVSectionLeaf workstreamId={id} programId={pid} />
  <TaskListLeaf workstreamId={id} programId={pid} />
</Suspense>
```

## Caching with `'use cache'` + `cacheTag`

Wrap each leaf's data fetcher in a thin module that uses Next 16's `'use cache'` directive and tags the result for targeted invalidation. The Effect function stays pure; the cache directive lives in a separate file at the boundary.

```typescript
// lib/core/cost/get-workstream-ev-data.ts
import { cacheTag } from 'next/cache'
import { Effect } from 'effect'
import { NextEffect } from '@/lib/next-effect'
import { AppLayer } from '@/lib/layers'
import { buildEVData } from './build-ev-data'

export async function getWorkstreamEVData(workstreamId: string, programId: string) {
  'use cache'
  cacheTag(`ws-ev:${workstreamId}`)

  return await NextEffect.runPromise(
    buildEVData(workstreamId, programId).pipe(Effect.provide(AppLayer), Effect.scoped)
  )
}
```

**Tag conventions** (kebab-case prefix + colon + ID):

| Tag                     | Cached data                                       |
| ----------------------- | ------------------------------------------------- |
| `ws-meta:${id}`         | workstream row + name + description               |
| `ws-ev:${id}`           | planned value + earned value + snapshots + prognosis |
| `ws-tasks:${id}`        | shell task list (id, name, status, assignee, …)   |
| `task:${id}`            | per-task detail (items, status history, risk, mitigation) |
| `ws-members:${id}`      | workstream members + eligible candidates          |
| `program-tasks:${id}`   | program-wide task list for dependency picker      |

Pick the smallest scope that captures what changes together.

### Auth invariant — IMPORTANT

**Never put auth checks inside `'use cache'` functions.** The cached value is shared across all users who pass the shell's auth gate. The cache key is the function arguments — adding the user ID would defeat the cache.

This is safe **only** when the data is identical for everyone with the same access to the resource. For workstream-scoped data, that holds: any user with `requireWorkstreamAccess(wsId)` sees the same EV chart, same task list, same member list. If a leaf's data depends on the viewer (e.g. "my open tasks"), do **not** use `'use cache'` — fetch directly without caching, or cache by a per-user key.

## Refresh Semantics

After a mutation, invalidate the affected tags. Pair with `router.refresh()` so the UI re-renders against the now-invalidated cache:

```typescript
// lib/core/task/create-task-action.ts (snippet)
import { revalidateTag } from 'next/cache'

// ... inside the action's onSuccess
revalidateTag(`ws-tasks:${workstreamId}`)
revalidateTag(`ws-ev:${workstreamId}`)
revalidateTag(`program-tasks:${programId}`)
```

```typescript
// in the calling client component
const result = await createTaskAction(input)
if (result._tag !== 'Error') router.refresh()
```

`router.refresh()` re-runs the page tree server-side. Each leaf re-evaluates its `'use cache'` fetcher; tags that were invalidated re-fetch fresh, untagged-or-untouched leaves return cached data instantly. The result is a near-instant refresh that updates exactly the affected sections.

**Mutation → tag mapping** is a per-domain concern; document it inline in each action file or at the top of `lib/core/[domain]/queries.ts`.

## Auth in the Shell, Never in Leaves

Auth runs **once** in the page's `Content` shell:

```typescript
async function Content({ workstreamId }: Props) {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const ctx = yield* requireWorkstreamAccess(workstreamId) // ← only here
      // ... render leaves
    }).pipe(Effect.provide(AppLayer), Effect.scoped, /* matchEffect */)
  )
}
```

Leaves accept identifiers and trust the shell's gate. Reasons:

1. **Performance.** Each leaf would otherwise re-run the same auth queries.
2. **Cacheability.** `'use cache'` requires user-independent inputs.
3. **Single source of truth.** Auth logic lives in one place.

If a specific leaf legitimately needs the viewer's identity (e.g. "show edit button if I own this"), pass the relevant identifier as a prop from the shell (`currentUserId={ctx.session.user.id}`). Do not call `getSession()` inside the leaf.

## Per-Item Leaves (e.g. Task Rows)

For lists where each item has independent expensive data, each row can be its own leaf:

```typescript
// task-list-leaf.tsx
import { Suspense } from 'react'
import { TaskRowLeaf } from './task-row-leaf'
import { TaskRowSkeleton } from './task-row-skeleton'

export async function TaskListLeaf({ workstreamId }: { workstreamId: string }) {
  const tasks = await getWorkstreamTasksShell(workstreamId) // light query: id + name + status
  return (
    <ul>
      {tasks.map(t => (
        <Suspense key={t.id} fallback={<TaskRowSkeleton task={t} />}>
          <TaskRowLeaf taskId={t.id} />
        </Suspense>
      ))}
    </ul>
  )
}
```

`TaskRowLeaf` fetches its own detail via `'use cache'` + `cacheTag('task:${taskId}')`. Mutating one task invalidates only that tag; other rows return cached data.

Trade-off: this becomes N small queries on the first uncached load. Each query is simple (`WHERE taskId = $1` with an index) and runs in parallel under React's RSC streaming. Measure before optimizing — for small N (< 100), per-row fetching is typically faster than the equivalent batched join.

If profiling shows the per-row pattern hurts cold loads, pre-warm by having `TaskListLeaf` issue a batched fetch that populates the per-tag cache, then let rows hit the warm cache. Track that as an optimization, not the default.

## Anti-Patterns

| Anti-pattern                                                          | Correct                                                                       |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Threading pre-fetched data as props into a leaf                       | Leaf takes identifier only, fetches its own                                   |
| Calling `await cookies()` inside a leaf                               | Cookies are signaled once in the shell                                        |
| Calling `getSession()` / `requireX` inside a leaf                     | Auth runs in the shell; pass identifiers to leaves                            |
| Single `<Suspense>` wrapping multiple leaves                          | One `<Suspense>` per leaf for parallel streaming                              |
| `'use cache'` on per-user data without per-user cache key             | Don't cache, or include the user identifier as a function arg                 |
| `'use cache'` wrapping an auth check                                  | Auth is shell-only; cache must be user-independent                            |
| Forgetting `revalidateTag` in a mutation that touches cached data     | Stale UI. Map every mutation to its tags up front                             |
| `router.refresh()` without `revalidateTag`                            | Re-fetches everything (no cache hit). Always invalidate first                 |
| Sharing one leaf for multiple unrelated sections                      | One leaf per section; one Suspense boundary per leaf                          |
| Leaf returns `null` on error                                          | Leaf renders a local error UI via `matchEffect`                               |

## Checklist for New Leaves

- [ ] File ends in `-leaf.tsx`, co-located with the page that uses it
- [ ] `async function` taking only identifier props
- [ ] No `await cookies()`, no `getSession()`, no auth check
- [ ] Wraps Effect in `NextEffect.runPromise` with `Effect.provide(AppLayer)` + `Effect.scoped`
- [ ] Has `Effect.matchEffect` with a local error fallback component
- [ ] Data fetcher in `lib/core/[domain]/get-*.ts` uses `'use cache'` + `cacheTag(...)` if shareable across users
- [ ] Caller wraps leaf in its own `<Suspense>` with a skeleton fallback
- [ ] Mutation actions for the underlying data call `revalidateTag` for the leaf's tag(s)

## Summary

| Concept            | Where                                                        |
| ------------------ | ------------------------------------------------------------ |
| Shell              | `app/.../page.tsx` `Content` — auth + layout only            |
| Leaf               | `app/.../*-leaf.tsx` — async server component, fetches own data |
| Suspense boundary  | parent (shell), one per leaf                                  |
| Cached fetcher     | `lib/core/[domain]/get-*.ts` with `'use cache'` + `cacheTag`  |
| Tag invalidation   | mutation actions call `revalidateTag(...)`                    |
| UI refresh         | client calls `router.refresh()` after mutation                |

## See Also

- [PAGE_PATTERNS.md](./PAGE_PATTERNS.md) — Shell + leaves at the page level
- [DATA_ACCESS_PATTERNS.md](./DATA_ACCESS_PATTERNS.md) — RSC vs server actions decision tree
- [SERVER_ACTION_PATTERNS.md](./SERVER_ACTION_PATTERNS.md) — Mutations and `revalidateTag`
- [DRIZZLE_PATTERNS.md](./DRIZZLE_PATTERNS.md) — Query patterns
