#!/usr/bin/env node
// Regenerates the app's logo and icon variants from the source artwork in assets/.
//
// The source files are opaque RGB on a near-white vignette. Dropped straight onto
// the dark app header that reads as a pasted patch, so this produces
// transparent-background variants.
//
// Pixels are classified, not colour-keyed. Every pixel is one of three things:
// background, cyan artwork, or neutral (black) artwork. Treating each as its
// source colour composited over the background recovers alpha per pixel, which
// keeps anti-aliased edges smooth instead of leaving the jagged halo a threshold
// key would produce.
//
// The cyan is always preserved as-is, because it reads on both light and dark
// backgrounds. Only the neutral part flips: black for light, white for dark. If a
// source has no neutral artwork at all — like the all-cyan OF monogram — then the
// two variants would be byte-identical, so a single theme-independent file is
// written instead.
//
// The artwork bounding box is detected rather than hardcoded, so replacing a
// source image and re-running this is all that's needed.
//
// ffmpeg is used only to move raw pixels in and out; the maths is here.
// Run: node scripts/make-assets.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const TMP = mkdtempSync(join(tmpdir(), 'of-assets-'));

/** Background level treated as fully transparent. Measured: bg spans 240–255. */
const BG = 252;
/** Below this alpha a pixel is vignette, not artwork. Kills the grey haze. */
const FLOOR = 0.10;
/** b − r above this means the pixel belongs to the cyan artwork. */
const CYAN_CUT = 15;
/** Alpha above which a pixel counts as real artwork when finding the bounds. */
const SOLID = 0.35;

const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function size(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file]).toString().trim();
  const [w, h] = out.split('x').map(Number);
  return { w, h };
}

function decode(file) {
  const { w, h } = size(file);
  const raw = join(TMP, 'in.raw');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-i', file,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw, '-y']);
  return { w, h, px: readFileSync(raw) };
}

function encode(rgba, w, h, outFile, scaleW) {
  const raw = join(TMP, 'out.raw');
  writeFileSync(raw, rgba);
  const args = ['-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-i', raw];
  if (scaleW) {
    // Premultiply before scaling: with straight alpha, fully transparent pixels
    // bleed their colour into the edges and every outline picks up a fringe.
    args.push('-vf', `premultiply=inplace=1,scale=${scaleW}:-1:flags=lanczos,unpremultiply=inplace=1`);
  }
  args.push(outFile, '-y');
  execFileSync('ffmpeg', args);
}

/** Average colour of pixels that are almost entirely cyan. */
function measureCyan(px) {
  let n = 0, r = 0, g = 0, b = 0;
  for (let i = 0; i < px.length; i += 3) {
    if (px[i + 2] - px[i] > 190) { r += px[i]; g += px[i + 1]; b += px[i + 2]; n++; }
  }
  return n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : [0, 168, 232];
}

/** Split the source into straight-alpha RGBA, painting neutral artwork `neutral`. */
function separate(px, w, h, cyan, neutral) {
  const out = Buffer.alloc(w * h * 4);
  const [cr, cg, cb] = cyan;
  const [nr, ng, nb] = neutral;
  const cyanSpan = BG - cr; // red channel travels furthest, so it is least noisy
  let neutralPx = 0;

  for (let i = 0, o = 0; i < px.length; i += 3, o += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    let a, R, G, B;

    if (b - r > CYAN_CUT) {
      a = clamp01((BG - r) / cyanSpan);
      R = cr; G = cg; B = cb;
    } else {
      a = clamp01((BG - lum(r, g, b)) / BG);
      R = nr; G = ng; B = nb;
      if (a > 0.5) neutralPx++;
    }

    // Drop the vignette, then stretch the rest back over the full range so the
    // artwork doesn't come out uniformly translucent.
    a = a < FLOOR ? 0 : (a - FLOOR) / (1 - FLOOR);

    out[o] = R; out[o + 1] = G; out[o + 2] = B; out[o + 3] = Math.round(a * 255);
  }
  return { rgba: out, neutralPx };
}

/** Tightest box containing real artwork, padded, optionally squared up. */
function bounds(rgba, w, h, { square = false, padPct = 0.03 } = {}) {
  const cut = SOLID * 255;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] > cut) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { x: 0, y: 0, w, h };

  let bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const pad = Math.round(Math.max(bw, bh) * padPct);
  x0 -= pad; y0 -= pad; bw += pad * 2; bh += pad * 2;

  if (square) {
    const side = Math.max(bw, bh);
    x0 -= Math.round((side - bw) / 2);
    y0 -= Math.round((side - bh) / 2);
    bw = bh = side;
  }

  // Keep the box inside the canvas.
  x0 = Math.max(0, Math.min(x0, w - 1));
  y0 = Math.max(0, Math.min(y0, h - 1));
  bw = Math.min(bw, w - x0);
  bh = Math.min(bh, h - y0);
  return { x: x0, y: y0, w: bw, h: bh };
}

function crop(rgba, w, box) {
  const out = Buffer.alloc(box.w * box.h * 4);
  for (let y = 0; y < box.h; y++) {
    rgba.copy(out, y * box.w * 4, ((box.y + y) * w + box.x) * 4, ((box.y + y) * w + box.x + box.w) * 4);
  }
  return out;
}

const BLACK = [0, 0, 0];
const WHITE = [255, 255, 255];

const jobs = [
  // The wordmark: "Only" is near-black, so it genuinely needs both variants.
  { src: 'logo_wide.png', base: 'logo-header', widths: [288], square: false },
  // Larger wordmark for the README hero, which needs both variants so GitHub's
  // dark mode does not get a black "Only" on a dark page.
  { src: 'logo_wide.png', base: 'logo-readme', widths: [900], square: false },
  // The OF monogram, used as the app icon and favicon.
  { src: 'icon.png', base: 'icon', widths: [512, 64], square: true },
];

for (const job of jobs) {
  const { w, h, px } = decode(join(ASSETS, job.src));
  const cyan = measureCyan(px);

  // Bounds come from the black pass; alpha is identical either way.
  const probe = separate(px, w, h, cyan, BLACK);
  const box = bounds(probe.rgba, w, h, { square: job.square });
  const themed = probe.neutralPx > w * h * 0.0005;

  console.log(`\n${job.src}  ${w}x${h}  cyan rgb(${cyan})`);
  console.log(`  artwork bounds ${box.w}x${box.h} at ${box.x},${box.y}`);
  console.log(`  neutral artwork pixels: ${probe.neutralPx.toLocaleString()} -> ` +
    (themed ? 'needs light + dark variants' : 'all cyan, one theme-independent file'));

  const variants = themed
    ? [[`${job.base}-light`, BLACK], [`${job.base}-dark`, WHITE]]
    : [[job.base, BLACK]];

  for (const [name, neutral] of variants) {
    const { rgba } = separate(px, w, h, cyan, neutral);
    const cropped = crop(rgba, w, box);
    for (const width of job.widths) {
      const suffix = job.widths.length > 1 ? `-${width}` : '';
      const out = `${name}${suffix}.png`;
      encode(cropped, box.w, box.h, join(ASSETS, out), width);
      console.log(`  wrote ${out}`);
    }
  }
}
