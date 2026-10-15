import { dedupeCandidates } from "@mediaforge/extension-core";
import type { MediaCandidate } from "@mediaforge/shared-types";

/** `browser.storage.session`, or a fake in tests. */
export interface SessionArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface TabStore {
  list(tabId: number): Promise<MediaCandidate[]>;
  /** Resolves with whether the tab's list changed; a repeat of a known response changes nothing. */
  add(tabId: number, candidate: MediaCandidate): Promise<boolean>;
  clear(tabId: number): Promise<void>;
  find(tabId: number, id: string): Promise<MediaCandidate | undefined>;
}

const keyOf = (tabId: number) => `candidates:${tabId}`;

/** Per-tab cap so a chatty page cannot grow storage without bound. */
const MAX_CANDIDATES_PER_TAB = 100;

const isCandidate = (value: unknown): value is MediaCandidate =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { url?: unknown }).url === "string" &&
  typeof (value as { id?: unknown }).id === "string";

/** Drops the oldest by `detectedAt`, keeping insertion order of the survivors. */
function capNewest(list: MediaCandidate[]): MediaCandidate[] {
  if (list.length <= MAX_CANDIDATES_PER_TAB) return list;
  const dropped = new Set(
    list
      .map((candidate, index) => ({ index, at: candidate.detectedAt }))
      .sort((a, b) => a.at - b.at || a.index - b.index)
      .slice(0, list.length - MAX_CANDIDATES_PER_TAB)
      .map((entry) => entry.index),
  );
  return list.filter((_, index) => !dropped.has(index));
}

export function createTabStore(area: SessionArea): TabStore {
  const memory = new Map<number, MediaCandidate[]>();
  // One chain per tab so two quick responses cannot overwrite each other's write.
  const chains = new Map<number, Promise<unknown>>();

  const load = async (tabId: number): Promise<MediaCandidate[]> => {
    const cached = memory.get(tabId);
    if (cached) return cached;
    const stored = (await area.get(keyOf(tabId)))[keyOf(tabId)];
    const list = Array.isArray(stored) ? stored.filter(isCandidate) : [];
    memory.set(tabId, list);
    return list;
  };

  const queue = <T>(tabId: number, task: () => Promise<T>): Promise<T> => {
    const next = (chains.get(tabId) ?? Promise.resolve()).then(task, task);
    const tail = next.then(
      () => {},
      () => {},
    );
    chains.set(tabId, tail);
    // Forget idle chains so closed tabs do not leak entries.
    void tail.then(() => {
      if (chains.get(tabId) === tail) chains.delete(tabId);
    });
    return next;
  };

  return {
    list: (tabId) => queue(tabId, async () => [...(await load(tabId))]),
    find: (tabId, id) => queue(tabId, async () => (await load(tabId)).find((c) => c.id === id)),
    add: (tabId, candidate) =>
      queue(tabId, async () => {
        const current = await load(tabId);
        const merged = capNewest(dedupeCandidates([...current, candidate]));
        // Pages repeat requests for the same media constantly; skip the write and the news.
        if (JSON.stringify(merged) === JSON.stringify(current)) return false;
        // Persist first: if the write rejects, the in-memory view stays unchanged.
        await area.set({ [keyOf(tabId)]: merged });
        memory.set(tabId, merged);
        return true;
      }),
    clear: (tabId) =>
      queue(tabId, async () => {
        memory.delete(tabId);
        await area.remove(keyOf(tabId));
      }),
  };
}
