<script lang="ts">
  import favicon from "$lib/assets/favicon.svg";
  import { page } from "$app/state";
  import "../app.css";

  let { children } = $props();

  // Fallback per-route titles. Pages set their own <svelte:head> titles where
  // possible, but a page whose template uses two-way component bindings (e.g.
  // /browse's `bind:open` on the details sheet) is server-rendered inside
  // Svelte's "settled loop" on a copied renderer, which makes its title lose
  // Svelte's SSR title selection to this layout's. Providing the fallback here
  // keeps the <title> correct in SSR and prerendered HTML for every route.
  const fallbackTitle = $derived.by(() => {
    const path = page.url.pathname;
    if (path.startsWith("/browse")) return "Browse - Melana";
    if (path.startsWith("/settings")) return "Settings - Melana";
    if (path.startsWith("/watch")) return "Watch - Melana";
    return "Melana";
  });
</script>

<svelte:head>
  <link rel="icon" href={favicon} />
  <meta name="theme-color" content="#000000" />
  <meta
    name="theme-color"
    content="#000000"
    media="(prefers-color-scheme: dark)"
  />
  <meta name="color-scheme" content="dark" />
  <title>{fallbackTitle}</title>
</svelte:head>

{@render children()}
