<script lang="ts">
  // One icon language: 24 × 24 grid, 1.75 stroke, round caps – matches SF Symbols' regular weight.
  type Name = "gear" | "close" | "back" | "forward" | "play" | "stop" | "rack" | "wave" | "lock" | "check" | "warning";
  let { name, size = 18 }: { name: Name; size?: number } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  {#if name === "gear"}
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  {:else if name === "close"}
    <path d="M6 6l12 12M18 6L6 18" />
  {:else if name === "back"}
    <path d="M15 5l-7 7 7 7" />
  {:else if name === "forward"}
    <path d="M9 5l7 7-7 7" />
  {:else if name === "play"}
    <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none" />
  {:else if name === "stop"}
    <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none" />
  {:else if name === "rack"}
    <rect x="3.5" y="4.5" width="17" height="6" rx="1.5" /><rect x="3.5" y="13.5" width="17" height="6" rx="1.5" />
    <path d="M7 7.5h.01M7 16.5h.01" />
  {:else if name === "wave"}
    <path d="M3 12h2M7 8v8M11 5v14M15 8v8M19 10.5v3M21 12h0" />
  {:else if name === "lock"}
    <rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" />
  {:else if name === "check"}
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  {:else if name === "warning"}
    <path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17h.01" />
  {/if}
</svg>
