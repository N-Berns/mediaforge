export interface IdleMonitorOptions {
  graceMs: number;
  /** True when no jobs are queued or running and no client is connected. */
  isIdle: () => boolean;
  /** Read fresh each time, so turning the setting off lets a resident core exit. */
  keepRunning: () => Promise<boolean>;
  onIdle: () => void;
}

export class IdleMonitor {
  readonly #options: IdleMonitorOptions;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped by `stop()`, so a check that was awaiting `keepRunning()` can tell it was cancelled. */
  #generation = 0;

  constructor(options: IdleMonitorOptions) {
    this.#options = options;
  }

  /** Call whenever a client or job changes, and now and then so a settings change is noticed. */
  async check(): Promise<void> {
    const generation = this.#generation;
    // Await first, then read `isIdle()` and act in the same tick: a job that arrived while
    // `keepRunning()` was pending must win over the state seen before the await.
    const keep = await this.#options.keepRunning();
    if (generation !== this.#generation) return;
    if (keep || !this.#options.isIdle()) {
      this.stop();
      return;
    }
    if (this.#timer) return;
    this.#timer = setTimeout(() => void this.#fire(), this.#options.graceMs);
  }

  /** Cancels the countdown and any check still in flight. `check()` can arm it again later. */
  stop(): void {
    this.#generation += 1;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async #fire(): Promise<void> {
    this.#timer = undefined;
    const generation = this.#generation;
    const keep = await this.#options.keepRunning();
    if (generation !== this.#generation) return;
    if (keep || !this.#options.isIdle()) return;
    // Drop any countdown a concurrent check() armed meanwhile, so onIdle runs once.
    this.stop();
    this.#options.onIdle();
  }
}
