import type { FlowDoc } from './model'

export type SaveStatus =
  | { kind: 'saved' }
  | { kind: 'saving' }
  | { kind: 'error'; message: string }

export interface FlowSaverDeps {
  /** Current draft of a flow, or undefined when the flow has no unsaved edits. */
  read: (name: string) => FlowDoc | undefined
  /** Writes the document to the server. Rejects on failure. */
  write: (name: string, doc: FlowDoc) => Promise<void>
  /** Called after a write succeeded: drops the draft only when it still equals `saved`. */
  settle: (name: string, saved: FlowDoc) => void
  onStatus: (status: SaveStatus) => void
}

/** legacy FlowsAPI.updateFlow: debounce(1000, leading). The first change saves at once; changes inside the window coalesce into one trailing save. */
export const SAVE_WINDOW_MS = 1000

/**
 * Autosave for flow drafts. One save per flow at a time; a change made while a save is in flight
 * is saved after it, never dropped. A failed save keeps the draft and waits for the next change
 * or an explicit flush (Ctrl+S / Save) to retry.
 */
export class FlowSaver {
  private windows = new Map<string, ReturnType<typeof setTimeout>>()
  private inflight = new Map<string, Promise<void>>()
  private pending = new Set<string>()
  private failed = new Map<string, string>()

  constructor(
    private readonly deps: FlowSaverDeps,
    private readonly windowMs = SAVE_WINDOW_MS,
  ) {}

  /** A draft of `name` changed. Saves now if no save window is open, otherwise after it closes. */
  changed(name: string): void {
    if (!this.deps.read(name)) return
    if (this.windows.has(name)) {
      this.pending.add(name)
      return
    }
    void this.start(name)
    this.openWindow(name)
  }

  /** Saves the given dirty flows now (Ctrl+S / Save). Resolves when all writes have settled. */
  async flush(names: readonly string[]): Promise<void> {
    for (const name of names) {
      this.clearWindow(name)
      this.pending.delete(name)
    }
    await Promise.all(names.map((name) => this.drain(name)))
  }

  /** Waits for in-flight writes of one flow, then writes its draft until none is left (or a write fails). */
  private async drain(name: string): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const running = this.inflight.get(name)
      if (running) {
        await running
        continue
      }
      if (!this.deps.read(name) || this.failed.has(name)) return
      await this.start(name)
    }
  }

  /** Retry after a failure: the same as a change, so the next write carries the latest draft. */
  retry(name: string): void {
    this.failed.delete(name)
    this.changed(name)
  }

  dispose(): void {
    for (const name of [...this.windows.keys()]) this.clearWindow(name)
    this.pending.clear()
  }

  private openWindow(name: string): void {
    const timer = setTimeout(() => {
      this.windows.delete(name)
      if (this.pending.delete(name)) this.changed(name)
    }, this.windowMs)
    this.windows.set(name, timer)
  }

  private clearWindow(name: string): void {
    const timer = this.windows.get(name)
    if (timer !== undefined) clearTimeout(timer)
    this.windows.delete(name)
  }

  /** Writes the current draft. If a write is already in flight, the draft is saved after it. */
  private start(name: string): Promise<void> {
    const running = this.inflight.get(name)
    if (running) {
      this.pending.add(name)
      return running
    }
    const doc = this.deps.read(name)
    if (!doc) return Promise.resolve()
    this.deps.onStatus({ kind: 'saving' })
    const run = this.deps
      .write(name, doc)
      .then(() => {
        this.failed.delete(name)
        this.deps.settle(name, doc)
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        this.failed.set(name, message)
        this.deps.onStatus({ kind: 'error', message })
      })
      .finally(() => {
        this.inflight.delete(name)
 // Edits made during the write: save them now if no window is open, else the window closes into a save.
        if (!this.failed.has(name) && this.deps.read(name)) {
          if (this.windows.has(name)) this.pending.add(name)
          else this.changed(name)
        }
        if (this.inflight.size === 0 && this.failed.size === 0) this.deps.onStatus({ kind: 'saved' })
      })
    this.inflight.set(name, run)
    return run
  }
}
