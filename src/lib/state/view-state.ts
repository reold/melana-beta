import { browser } from "$app/environment";
import { beforeNavigate, replaceState } from "$app/navigation";
import { page } from "$app/state";
import { onMount, untrack } from "svelte";

/**
 * History-entry scoped view state.
 * -----------------------------------------------------------------------------
 * Restoring "the screen exactly as I left it" when the user presses Back is a
 * storage problem, not a routing problem: something has to hold the previous
 * screen's data, and it has to be addressable by *which* history entry the user
 * came back to. This module is that storage, and it is deliberately generic —
 * any view can define its own snapshot shape and get the same behaviour.
 *
 * How an entry is identified
 *   Every history entry that owns a snapshot is tagged with a random token kept
 *   in `page.state` (SvelteKit persists that into the browser's history entry).
 *   Coming back to an entry therefore hands us its token synchronously, before
 *   the page component's first effect runs, so a view can hydrate itself during
 *   initialisation with no flash of default content.
 *
 * Where the data lives (two tiers)
 *   1. Memory  — the full snapshot, instant, used for in-document (SPA) back
 *      navigation. Lost when the document is discarded.
 *   2. sessionStorage — a JSON copy, bounded in size and count (oldest entries
 *      evicted first). Mobile Safari happily throws a page out of memory while
 *      the user is on the next screen; when Back then reloads the document,
 *      SvelteKit resets `page.state`, so the token is gone. In that case (and
 *      only then) the newest persisted snapshot for the view is reused, which is
 *      indistinguishable from the real thing for a single-entry-per-view app.
 *
 * Adding a new view:
 *   const myViewState = defineViewState<MySnapshot>({ key: "my-view", version: 1 });
 *   const restored = myViewState.connect(() => captureCurrentState()); // in init
 */

/** `page.state` field holding the current history entry's token. */
const ENTRY_TOKEN_KEY = "viewStateToken";
const STORAGE_KEY = "melana:view-state";
/** History entries kept in sessionStorage (per-tab, so this is generous). */
const MAX_STORED_ENTRIES = 8;
/** Upper bound for the whole serialised document; oversized writes degrade. */
const MAX_STORED_BYTES = 2_000_000;
/** Memory tier bound, counted per (history entry, view) pair. */
const MAX_MEMORY_ENTRIES = 12;

interface StoredSnapshot {
  /** Schema version of `data`. */
  v: number;
  /** Last write, used for eviction and for the newest-entry fallback. */
  t: number;
  data: unknown;
}

/** `{ [entryToken]: { [viewKey]: snapshot } }` */
type StoredDocument = Record<string, Record<string, StoredSnapshot>>;

const memory = new Map<string, StoredSnapshot>();

/**
 * True when this document was created by a history traversal (Back/Forward)
 * rather than a normal load — the signal that lets a discarded page still
 * restore. Consumed once, by the first view that asks for it.
 */
let traversalRestorePending =
  browser &&
  typeof performance !== "undefined" &&
  performance
    .getEntriesByType?.("navigation")
    .some(
      (entry) => (entry as PerformanceNavigationTiming).type === "back_forward",
    );

function memoryKey(token: string, viewKey: string): string {
  return `${token}\u0000${viewKey}`;
}

let lastTimestamp = 0;

/**
 * Wall-clock time, forced to strictly increase within a document. Snapshots
 * written in the same millisecond still order deterministically, which is what
 * eviction and the newest-snapshot fallback rely on.
 */
function nextTimestamp(): number {
  lastTimestamp = Math.max(Date.now(), lastTimestamp + 1);
  return lastTimestamp;
}

function rememberInMemory(key: string, snapshot: StoredSnapshot) {
  memory.delete(key);
  memory.set(key, snapshot);
  while (memory.size > MAX_MEMORY_ENTRIES) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
}

function readDocument(): StoredDocument {
  if (!browser) return {};
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as StoredDocument)
      : {};
  } catch {
    // Private mode, disabled storage or corrupt JSON: memory tier still works.
    return {};
  }
}

function newestWrite(entry: Record<string, StoredSnapshot>): number {
  return Object.values(entry).reduce((latest, snapshot) => {
    const time = typeof snapshot?.t === "number" ? snapshot.t : 0;
    return time > latest ? time : latest;
  }, 0);
}

function writeDocument(document_: StoredDocument) {
  if (!browser) return;

  const entries = Object.entries(document_).sort(
    ([, a], [, b]) => newestWrite(b) - newestWrite(a),
  );

  // Drop the oldest history entries until the payload fits both budgets. A
  // single oversized snapshot simply never reaches sessionStorage (it stays in
  // the memory tier), which downgrades to a refetch instead of breaking.
  for (let count = Math.min(entries.length, MAX_STORED_ENTRIES); count > 0; count--) {
    const candidate = Object.fromEntries(entries.slice(0, count));
    let serialized: string;
    try {
      serialized = JSON.stringify(candidate);
    } catch {
      return;
    }
    if (serialized.length > MAX_STORED_BYTES) continue;

    try {
      sessionStorage.setItem(STORAGE_KEY, serialized);
      return;
    } catch {
      // Quota exceeded: retry with fewer entries.
    }
  }

  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing else to do.
  }
}

function createToken(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function currentToken(): string | null {
  if (!browser) return null;
  const token = untrack(() => page.state?.[ENTRY_TOKEN_KEY]);
  return typeof token === "string" && token ? token : null;
}

/**
 * Tags the current history entry so snapshots can be addressed to it. Called
 * after mount (the router must be running) and again, defensively, before the
 * first write.
 */
function ensureEntryToken(): string | null {
  const existing = currentToken();
  if (existing) return existing;

  const token = createToken();
  try {
    replaceState("", { ...untrack(() => page.state), [ENTRY_TOKEN_KEY]: token });
  } catch {
    return null;
  }
  return currentToken();
}

export interface ViewStateOptions<T> {
  /** Stable identifier for the view, e.g. `"browse"`. */
  key: string;
  /** Bump when the snapshot shape changes; older snapshots are then ignored. */
  version?: number;
  /**
   * Projection applied before writing to sessionStorage. Return `null` to keep
   * the snapshot in memory only — useful to drop a payload that is too heavy to
   * persist while still supporting instant in-document back navigation.
   */
  toStorage?: (value: T) => unknown;
  /**
   * Validates/upgrades a value read back from sessionStorage. Returning `null`
   * rejects it. Snapshots are untrusted input: they outlive deploys.
   */
  fromStorage?: (raw: unknown) => T | null;
}

export interface ViewState<T> {
  readonly key: string;
  /**
   * Snapshot attached to the current history entry, or `null`. Safe to call
   * during component initialisation, which is the point: the view can render
   * restored content on its very first frame. Treat the result as read-only
   * unless `fromStorage` rebuilds it (it may be the stored instance).
   */
  read(): T | null;
  /** Stores a snapshot for the current history entry. */
  write(value: T): void;
  /** Forgets the snapshot for the current history entry. */
  clear(): void;
  /**
   * Component sugar: reads the snapshot (synchronously) and wires capture up to
   * navigation away, tab hide and unload. Must be called during component
   * initialisation.
   */
  connect(capture: () => T | null): T | null;
}

export function defineViewState<T>(options: ViewStateOptions<T>): ViewState<T> {
  const { key, version = 1, toStorage, fromStorage } = options;

  function accept(snapshot: StoredSnapshot | undefined): T | null {
    if (!snapshot || snapshot.v !== version) return null;
    if (!fromStorage) return snapshot.data as T;
    try {
      return fromStorage(snapshot.data);
    } catch {
      return null;
    }
  }

  /** Newest persisted snapshot for this view, regardless of history entry. */
  function readNewestStored(): T | null {
    const document_ = readDocument();
    let newest: StoredSnapshot | undefined;
    for (const entry of Object.values(document_)) {
      const snapshot = entry?.[key];
      if (!snapshot) continue;
      if (!newest || (snapshot.t ?? 0) > (newest.t ?? 0)) newest = snapshot;
    }
    return accept(newest);
  }

  const state: ViewState<T> = {
    key,

    read() {
      if (!browser) return null;

      const token = currentToken();
      if (token) {
        const fromMemory = accept(memory.get(memoryKey(token, key)));
        if (fromMemory !== null) return fromMemory;

        const fromStorageTier = accept(readDocument()[token]?.[key]);
        if (fromStorageTier !== null) return fromStorageTier;
        return null;
      }

      // No token: either a first visit, or a Back that had to reload the
      // document (SvelteKit clears `page.state` on a fresh load). Only the
      // latter may fall back to the newest persisted snapshot, once.
      if (!traversalRestorePending) return null;
      const restored = readNewestStored();
      if (restored !== null) traversalRestorePending = false;
      return restored;
    },

    write(value: T) {
      if (!browser) return;
      const token = ensureEntryToken();
      if (!token) return;

      const timestamp = nextTimestamp();
      rememberInMemory(memoryKey(token, key), { v: version, t: timestamp, data: value });

      let persisted: unknown = value;
      if (toStorage) {
        try {
          persisted = toStorage(value);
        } catch {
          persisted = null;
        }
      }
      if (persisted === null || persisted === undefined) return;

      const document_ = readDocument();
      document_[token] = {
        ...document_[token],
        [key]: { v: version, t: timestamp, data: persisted },
      };
      writeDocument(document_);
    },

    clear() {
      if (!browser) return;
      const token = currentToken();
      if (!token) return;

      memory.delete(memoryKey(token, key));

      const document_ = readDocument();
      const entry = document_[token];
      if (!entry?.[key]) return;

      delete entry[key];
      if (Object.keys(entry).length === 0) delete document_[token];
      writeDocument(document_);
    },

    connect(capture: () => T | null) {
      const restored = state.read();
      if (!browser) return restored;

      const save = () => {
        try {
          const value = capture();
          if (value === null || value === undefined) state.clear();
          else state.write(value);
        } catch (error) {
          console.error(`Could not capture "${key}" view state`, error);
        }
      };

      beforeNavigate(save);

      onMount(() => {
        // Tag the entry up front so leaving never has to touch history while a
        // navigation is already in flight. A macrotask keeps it after the
        // router has finished starting up.
        const tagTimer = setTimeout(ensureEntryToken, 0);
        // `pagehide` is the reliable last call on iOS Safari (unload is not).
        window.addEventListener("pagehide", save);

        return () => {
          clearTimeout(tagTimer);
          window.removeEventListener("pagehide", save);
        };
      });

      return restored;
    },
  };

  return state;
}
