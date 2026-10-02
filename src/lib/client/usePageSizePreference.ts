'use client';
/**
 * usePageSizePreference — Item 12 Phase 2 client hook.
 *
 *   const [pageSize, setPageSizePersistent] = usePageSizePreference('admin_orders', 20);
 *
 * On mount, hydrates from the `sc_ps_<scope>` cookie if present.
 * Every write also persists into the cookie (1-year TTL, SameSite=Lax).
 *
 * SSR-safe: returns the supplied default on the first render so the
 * server-rendered HTML matches; the cookie hydration runs in a
 * useEffect.
 */
import { useEffect, useState } from 'react';
import { readPageSizePreference, writePageSizePreference } from '@/lib/pageSizePreference';

export function usePageSizePreference(
  scope: string,
  defaultSize: number,
  maxSize = 1000,
): [number, (next: number) => void] {
  const [size, setSize] = useState<number>(defaultSize);

  useEffect(() => {
    const stored = readPageSizePreference(scope, defaultSize, maxSize);
    if (stored !== defaultSize) setSize(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  function setSizePersistent(next: number): void {
    setSize(next);
    writePageSizePreference(scope, next);
  }

  return [size, setSizePersistent];
}
