<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";

  interface Props {
    title: string;
    subtitle?: string;
    badge?: string;
    /** max width in px on larger screens */
    width?: number;
    onclose: () => void;
    /** optional custom header content (replaces title/subtitle) */
    header?: Snippet;
    children: Snippet;
  }
  let { title, subtitle, badge, width = 640, onclose, header, children }: Props = $props();
</script>

<svelte:window onkeydown={(e) => { if (e.key === "Escape") onclose(); }} />

<div class="backdrop" onclick={onclose} role="presentation"></div>
<div class="sheet" role="dialog" aria-modal="true" aria-label={title} style="--w: {width}px">
  <header>
    {#if header}
      <div class="custom">{@render header()}</div>
    {:else}
      <div class="titles">
        <h2 class="t-title">{title}{#if badge}<span class="badge">{badge}</span>{/if}</h2>
        {#if subtitle}<p class="t-footnote">{subtitle}</p>{/if}
      </div>
    {/if}
    <button class="icon-btn" onclick={onclose} aria-label="Schließen"><Icon name="close" /></button>
  </header>
  <div class="body">
    {@render children()}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 20;
    background: rgba(0, 0, 0, 0.5);
    animation: fade 180ms var(--ease);
  }
  .sheet {
    position: fixed;
    z-index: 21;
    left: 50%;
    bottom: 0;
    translate: -50% 0;
    width: min(var(--w), 100%);
    max-height: 92dvh;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    border-radius: var(--r-lg) var(--r-lg) 0 0;
    box-shadow: var(--shadow-sheet), inset 0 0.5px 0 rgba(255, 255, 255, 0.12);
    padding-bottom: env(safe-area-inset-bottom);
    animation: rise 260ms var(--ease);
  }
  /* Larger screens: centred card instead of a bottom sheet. */
  @media (min-width: 720px) and (min-height: 560px) {
    .sheet {
      bottom: auto;
      top: 50%;
      translate: -50% -50%;
      width: min(var(--w), calc(100% - 64px));
      max-height: min(86dvh, 900px);
      border-radius: var(--r-lg);
      animation: pop 220ms var(--ease);
    }
  }
  header {
    display: flex;
    align-items: flex-start;
    gap: var(--s3);
    padding: var(--s5) var(--s5) var(--s3);
  }
  .titles, .custom { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .titles h2 { display: flex; align-items: center; gap: var(--s2); }
  .badge {
    font: 700 var(--fs-caption2) / 1 var(--font);
    letter-spacing: 0.02em;
    color: var(--send-ink);
    background: var(--send);
    border-radius: var(--r-xs);
    padding: 4px 6px;
  }
  .body {
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: var(--s2) var(--s5) var(--s6);
    display: flex;
    flex-direction: column;
    gap: var(--s6);
  }
  @keyframes fade { from { opacity: 0; } }
  @keyframes rise { from { transform: translateY(32px); opacity: 0; } }
  @keyframes pop { from { transform: scale(0.97); opacity: 0; } }
</style>
