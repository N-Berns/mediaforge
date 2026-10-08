import { useCallback, useState } from "react";

/** Screens visited so far, newest last. Always holds at least one entry. */
export interface NavStack<T> {
  readonly entries: readonly T[];
}

export const createStack = <T>(root: T): NavStack<T> => ({ entries: [root] });

export const topOf = <T>(stack: NavStack<T>): T => stack.entries[stack.entries.length - 1] as T;

export const canPop = <T>(stack: NavStack<T>): boolean => stack.entries.length > 1;

export const pushEntry = <T>(stack: NavStack<T>, entry: T): NavStack<T> => ({
  entries: [...stack.entries, entry],
});

/** One step back. At the root there is nowhere to go, so the stack is returned as is. */
export const popEntry = <T>(stack: NavStack<T>): NavStack<T> =>
  canPop(stack) ? { entries: stack.entries.slice(0, -1) } : stack;

/** Remove the top `count` entries, then push `entry`. `count` 1 replaces the current screen. */
export const unwind = <T>(stack: NavStack<T>, count: number, entry: T): NavStack<T> => ({
  entries: [...stack.entries.slice(0, Math.max(0, stack.entries.length - count)), entry],
});

/** Forget the history and start over from these entries; the last one is shown. */
export const resetStack = <T>(first: T, ...rest: T[]): NavStack<T> => ({
  entries: [first, ...rest],
});

export interface Nav<T> {
  current: T;
  depth: number;
  canGoBack: boolean;
  push: (entry: T) => void;
  /** Swap the current screen for another, e.g. a waiting screen that should not stay in history. */
  replace: (entry: T) => void;
  back: () => void;
  unwind: (count: number, entry: T) => void;
  reset: (first: T, ...rest: T[]) => void;
}

/** A back stack for screens. Entries hold their own state, so going back restores it. */
export function useNav<T>(root: T): Nav<T> {
  const [stack, setStack] = useState<NavStack<T>>(() => createStack(root));
  const push = useCallback((entry: T) => setStack((s) => pushEntry(s, entry)), []);
  const replace = useCallback((entry: T) => setStack((s) => unwind(s, 1, entry)), []);
  const back = useCallback(() => setStack((s) => popEntry(s)), []);
  const unwindBy = useCallback(
    (count: number, entry: T) => setStack((s) => unwind(s, count, entry)),
    [],
  );
  const reset = useCallback((first: T, ...rest: T[]) => setStack(resetStack(first, ...rest)), []);
  return {
    current: topOf(stack),
    depth: stack.entries.length,
    canGoBack: canPop(stack),
    push,
    replace,
    back,
    unwind: unwindBy,
    reset,
  };
}
