// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		interface PageState {
			/**
			 * Identifies this history entry for `$lib/state/view-state`, which
			 * keys restorable view snapshots (browse query/results/sheet/scroll,
			 * and anything added later) by the entry the user returns to.
			 */
			viewStateToken?: string;
		}
		// interface Platform {}
	}
}

export {};
