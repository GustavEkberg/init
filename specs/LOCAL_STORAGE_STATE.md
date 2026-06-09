# Local Storage State

This document defines how to load local storage-backed UI state when a component already uses local storage.

## Core Rule

Do not load local storage preferences in `useEffect` when the value changes the initial UI. `useEffect` runs after paint, which causes the page to render the default state first and then visibly switch to the stored state.

If the component renders only on the client, read local storage in a lazy `useState` initializer or another render-time initializer:

```typescript
'use client';

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'example-view-mode';
const VIEW_MODES = ['table', 'detail'] as const;
type ViewMode = (typeof VIEW_MODES)[number];

function isViewMode(value: unknown): value is ViewMode {
  return typeof value === 'string' && VIEW_MODES.some(mode => mode === value);
}

function readStoredViewMode(): ViewMode {
  if (typeof window === 'undefined') return 'table';

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isViewMode(stored) ? stored : 'table';
  } catch {
    return 'table';
  }
}

export function useStoredViewMode(): readonly [ViewMode, (mode: ViewMode) => void] {
  const [viewMode, setViewMode] = useState(readStoredViewMode);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) setViewMode(readStoredViewMode());
    };

    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setStoredViewMode = useCallback((next: ViewMode) => {
    setViewMode(next);

    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage unavailable.
    }
  }, []);

  return [viewMode, setStoredViewMode];
}
```

## Requirements

- Validate stored values before using them.
- Use typed literal arrays or discriminated unions for allowed values.
- Handle storage reads/writes with `try/catch` because storage can be unavailable.
- Prefer lazy `useState(readStoredValue)` over `useEffect(() => setState(readStoredValue()), [])`.
- If server-rendered markup would otherwise show the wrong default, render a stable fallback until the client has read storage, then render the real UI.
- Update React state before writing storage so same-tab UI updates immediately.
- Add a `storage` event listener only when cross-tab updates matter.
- Namespace keys by scope when preferences are entity-specific, e.g. `workstream-task-status-filters:${workstreamId}`.
