import { useCallback, useRef } from "react";

/** How long a second commit is ignored after the first, like debouncing a double-click. */
export const ENTER_LOCK_MS = 300;

/**
 * Returns a `claim` function. Call it right before committing a choice: it returns true the first
 * time and false for any further call within `ms`, so a double Enter commits once.
 */
export function useEnterLock(ms = ENTER_LOCK_MS): () => boolean {
  const lockedUntil = useRef(0);
  return useCallback(() => {
    const now = Date.now();
    if (now < lockedUntil.current) return false;
    lockedUntil.current = now + ms;
    return true;
  }, [ms]);
}
