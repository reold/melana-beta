import type { Attachment } from "svelte/attachments";

export type PortalTarget = HTMLElement | (() => HTMLElement | null) | string;

function resolveTarget(target: PortalTarget): HTMLElement | null {
  if (typeof target === "string") {
    const found = document.querySelector(target);
    return found instanceof HTMLElement ? found : null;
  }
  return typeof target === "function" ? target() : target;
}

/**
 * Moves an element out of its DOM position and into `target` (default `<body>`).
 *
 * Overflow containers, transforms, filters and `contain` on an ancestor all clip
 * or re-anchor `position: fixed` children — WebKit/iOS Safari is the strictest
 * about it — so floating UI (menus, popovers, tooltips) has to escape the
 * subtree it is authored in. Svelte still owns the node's lifetime; the
 * attachment only relocates it and detaches it again on teardown.
 */
export function portal(target: PortalTarget = "body"): Attachment<HTMLElement> {
  return (node) => {
    const destination = resolveTarget(target) ?? document.body;
    if (node.parentNode !== destination) destination.appendChild(node);

    return () => node.remove();
  };
}
