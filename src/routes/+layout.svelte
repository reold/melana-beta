<script lang="ts">
  import favicon from "$lib/assets/favicon.svg";
  import "../app.css";

  let { children } = $props();
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
  <title>Melana</title>
</svelte:head>

{@render children()}
