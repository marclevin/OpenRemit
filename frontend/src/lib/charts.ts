// Tiny dependency-free chart toolkit for the arcade impact board. Each function
// returns an HTML/SVG string built to drop straight into a template literal —
// no canvas, no chart library, just neon pixels. All caller-supplied colours go
// through cssHex() and all labels through escapeHtml() so a charity name or seed
// colour can never break out into markup/CSS.

import { escapeHtml } from '../escape';

export interface ChartRow {
  label: string;
  value: number;
  color: string;
}

// Theme hexes (mirrors the CSS tokens) so SVG fills/gradients get a concrete
// colour — CSS custom properties don't resolve inside SVG paint attributes.
export const NEON = {
  green: '#39ff14',
  gold: '#ffd23f',
  pink: '#ff2e88',
  cyan: '#21e6c1',
  violet: '#a463ff',
} as const;

/** Whitelist a colour to a safe hex literal; fall back to neon violet. */
function cssHex(c: string): string {
  return /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : NEON.violet;
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/**
 * Horizontal labelled bars: [label] [▮▮▮▮ track] [value]. Bars are scaled to the
 * largest value in the set and glow in their own colour. `format` renders the
 * trailing value (e.g. money formatting); defaults to the raw number.
 */
export function barsH(rows: ChartRow[], format: (n: number) => string = String): string {
  if (rows.length === 0) return `<p class="chart-empty">No data yet — go play!</p>`;
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    `<div class="barchart">` +
    rows
      .map((r) => {
        const pct = r.value > 0 ? clamp(Math.round((100 * r.value) / max), 3, 100) : 0;
        const hex = cssHex(r.color);
        return `<div class="barchart__row">
        <span class="barchart__label" title="${escapeHtml(r.label)}">${escapeHtml(r.label)}</span>
        <span class="barchart__track"><span class="barchart__fill" style="width:${pct}%;background:${hex};box-shadow:0 0 12px ${hex}"></span></span>
        <span class="barchart__val">${escapeHtml(format(r.value))}</span>
      </div>`;
      })
      .join('') +
    `</div>`
  );
}

/**
 * A single stacked horizontal bar with a legend underneath — perfect for a
 * two-or-three-way split (e.g. player giving vs sponsor matching).
 */
export function stackBar(segs: ChartRow[], format: (n: number) => string = String): string {
  const total = segs.reduce((s, x) => s + x.value, 0);
  const safeTotal = Math.max(1, total);
  const bar =
    `<div class="stackbar">` +
    (total > 0
      ? segs
          .filter((s) => s.value > 0)
          .map(
            (s) =>
              `<span class="stackbar__seg" style="width:${((100 * s.value) / safeTotal).toFixed(2)}%;background:${cssHex(
                s.color,
              )}"></span>`,
          )
          .join('')
      : `<span class="stackbar__seg stackbar__seg--empty" style="width:100%"></span>`) +
    `</div>`;
  const legend =
    `<div class="stackbar__legend">` +
    segs
      .map(
        (s) =>
          `<span class="stackbar__key"><i style="background:${cssHex(s.color)}"></i>${escapeHtml(
            s.label,
          )} <b>${escapeHtml(format(s.value))}</b></span>`,
      )
      .join('') +
    `</div>`;
  return bar + legend;
}

/**
 * Neon area sparkline. `id` must be unique on the page (it names the gradient).
 * Renders a filled glow under a bright stroke, plus a pulsing dot on the latest
 * point. All-zero series degrade to a flat baseline.
 */
export function areaChart(
  values: number[],
  opts: { id: string; stroke?: string; width?: number; height?: number },
): string {
  const w = opts.width ?? 520;
  const h = opts.height ?? 120;
  const stroke = cssHex(opts.stroke ?? NEON.green);
  const pad = 8;
  const n = values.length;
  const max = Math.max(1, ...values);
  const px = (i: number): number => (n <= 1 ? w / 2 : pad + (i * (w - 2 * pad)) / (n - 1));
  const py = (v: number): number => h - pad - (v / max) * (h - 2 * pad);

  const linePts = values.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
  const areaPts = `${px(0).toFixed(1)},${(h - pad).toFixed(1)} ${linePts} ${px(n - 1).toFixed(1)},${(
    h - pad
  ).toFixed(1)}`;
  const lastX = px(n - 1).toFixed(1);
  const lastY = py(values[n - 1] ?? 0).toFixed(1);

  return `<svg class="areachart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-hidden="true">
    <defs>
      <linearGradient id="${escapeHtml(opts.id)}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${stroke}" stop-opacity="0.45" />
        <stop offset="100%" stop-color="${stroke}" stop-opacity="0" />
      </linearGradient>
    </defs>
    <polygon points="${areaPts}" fill="url(#${escapeHtml(opts.id)})" />
    <polyline points="${linePts}" fill="none" stroke="${stroke}" stroke-width="2.5"
      stroke-linejoin="round" stroke-linecap="round" style="filter:drop-shadow(0 0 5px ${stroke})" />
    <circle class="areachart__dot" cx="${lastX}" cy="${lastY}" r="4" fill="${stroke}" />
  </svg>`;
}

/**
 * Radial progress ring (win rate, completion, etc). Shows `pct%` big in the
 * centre with a caption below it.
 */
export function donut(pct: number, opts: { caption: string; color?: string; size?: number }): string {
  const size = opts.size ?? 132;
  const sw = 13;
  const r = (size - sw) / 2;
  const c = 2 * Math.PI * r;
  const color = cssHex(opts.color ?? NEON.green);
  const dash = (clamp(pct, 0, 100) / 100) * c;
  const cx = size / 2;
  return `<div class="donut" style="width:${size}px">
    <svg viewBox="0 0 ${size} ${size}" role="img" aria-hidden="true">
      <circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="var(--bg-inset)" stroke-width="${sw}" />
      <circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="${color}" stroke-width="${sw}"
        stroke-linecap="round" stroke-dasharray="${dash.toFixed(1)} ${c.toFixed(1)}"
        transform="rotate(-90 ${cx} ${cx})" style="filter:drop-shadow(0 0 5px ${color})" />
    </svg>
    <span class="donut__pct" style="color:${color}">${clamp(Math.round(pct), 0, 100)}%</span>
    <span class="donut__cap">${escapeHtml(opts.caption)}</span>
  </div>`;
}
