<script lang="ts">
  // On/off setting as a row with a switch (Apple: "Prefer a switch for settings").
  interface Props {
    checked: boolean;
    label: string;
    /** one short line under the label */
    detail?: string;
    disabled?: boolean;
    onchange: (checked: boolean) => void;
  }
  let { checked, label, detail, disabled = false, onchange }: Props = $props();
</script>

<button class="row" role="switch" aria-checked={checked} {disabled} onclick={() => onchange(!checked)}>
  <span class="text">
    <span class="label">{label}</span>
    {#if detail}<span class="detail">{detail}</span>{/if}
  </span>
  <span class="track" class:on={checked} aria-hidden="true"><span class="knob"></span></span>
</button>

<style>
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s3);
    width: 100%;
    min-height: var(--h-control);
    text-align: left;
  }
  .row:disabled { filter: saturate(0); cursor: default; }
  .text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .label { font-size: var(--fs-callout); font-weight: 600; color: var(--label); }
  .detail { font-size: var(--fs-footnote); color: var(--label-2); }
  .track {
    position: relative;
    flex: none;
    width: 51px;
    height: 31px;
    border-radius: var(--r-full);
    background: var(--surface-3);
    transition: background-color 180ms var(--ease);
  }
  .track.on { background: var(--on); }
  .knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 27px;
    height: 27px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.35);
    transition: transform 180ms var(--ease);
  }
  .track.on .knob { transform: translateX(20px); }
  @media (prefers-reduced-motion: reduce) {
    .track, .knob { transition: none; }
  }
</style>
