// Titles: text with an outline, shadow and background box, drawn on a canvas the size of the frame.
import type { TitleStyle } from '../core/project';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface TitleBox {
  /** The text block in sequence pixels (for picking and editing it in the Program monitor). */
  x: number;
  y: number;
  w: number;
  h: number;
}

function font(st: TitleStyle, scale: number): string {
  // The family is quoted so names with spaces work; a generic fallback keeps text visible
  return `${st.italic ? 'italic ' : ''}${st.bold ? 700 : 400} ${Math.max(1, st.size * scale)}px "${st.font.replace(/"/g, '')}", "Segoe UI", sans-serif`;
}

/** Where a title's text block sits (sequence pixels). */
export function layoutTitle(ctx: Ctx, st: TitleStyle, seqW: number, seqH: number, scale = 1): TitleBox & { lines: string[]; widths: number[]; lh: number } {
  ctx.font = font(st, scale);
  if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D).letterSpacing = `${st.tracking * scale}px`;
  const lines = (st.text || ' ').split('\n');
  const widths = lines.map((l) => ctx.measureText(l || ' ').width / scale);
  const lh = st.size * st.lineHeight;
  const w = Math.max(...widths, 1);
  const h = lh * lines.length;
  const ax = st.x * seqW;
  const x = st.align === 'left' ? ax : st.align === 'right' ? ax - w : ax - w / 2;
  const y = st.y * seqH - h / 2;
  return { x, y, w, h, lines, widths, lh };
}

/** Draws a title onto a canvas `scale` times the sequence's size. */
export function drawTitle(ctx: Ctx, st: TitleStyle, seqW: number, seqH: number, scale: number): TitleBox {
  const L = layoutTitle(ctx, st, seqW, seqH, scale);
  const s = scale;
  ctx.save();
  if (st.box) {
    const p = st.boxPadding;
    ctx.globalAlpha = Math.max(0, Math.min(1, st.boxOpacity / 100));
    ctx.fillStyle = st.boxColor;
    const r = Math.min(p, 8) * s;
    ctx.beginPath();
    ctx.roundRect((L.x - p) * s, (L.y - p * 0.6) * s, (L.w + p * 2) * s, (L.h + p * 1.2) * s, r);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  if (st.shadow) {
    ctx.shadowColor = st.shadowColor;
    ctx.shadowBlur = st.shadowBlur * s;
    ctx.shadowOffsetX = st.shadowDistance * s * 0.7071;
    ctx.shadowOffsetY = st.shadowDistance * s * 0.7071;
  }
  L.lines.forEach((line, i) => {
    const lw = L.widths[i];
    const x = st.align === 'left' ? L.x : st.align === 'right' ? L.x + L.w - lw : L.x + (L.w - lw) / 2;
    const y = L.y + L.lh * (i + 0.5);
    if (st.strokeWidth > 0) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = st.strokeWidth * 2 * s;
      ctx.strokeStyle = st.stroke;
      ctx.strokeText(line, x * s, y * s);
      // The fill shouldn't cast a second shadow over the outline
      ctx.shadowColor = 'transparent';
    }
    ctx.fillStyle = st.color;
    ctx.fillText(line, x * s, y * s);
    if (st.shadow) ctx.shadowColor = st.shadowColor;
  });
  ctx.restore();
  return { x: L.x, y: L.y, w: L.w, h: L.h };
}

let measurer: OffscreenCanvasRenderingContext2D | null = null;

/** The title's text block without drawing it. */
export function titleBounds(st: TitleStyle, seqW: number, seqH: number): TitleBox {
  measurer ??= new OffscreenCanvas(4, 4).getContext('2d')!;
  const { x, y, w, h } = layoutTitle(measurer, st, seqW, seqH, 1);
  return { x, y, w, h };
}
