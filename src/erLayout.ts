// Auto-layout for the ER diagram (pure, no DOM — unit-testable).
//
// Layered ("Sugiyama-lite") per connected component: a table's rank is the
// longest FK path from it to a table it doesn't reference, so lookup/parent
// tables sit on the left and their children fan out to the right. Within a
// rank, tables are reordered by the average position of their neighbours
// (a few barycenter sweeps) to cut edge crossings. Components — including
// lone tables with no FKs — are then shelf-packed into rows.

export interface ErColumn {
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
  fk: boolean;
  /** FK guessed from the column name (no constraint in the database). */
  guess?: boolean;
}

export interface ErTable {
  name: string;
  columns: ErColumn[];
}

export interface ErEdge {
  /** Child table (holds the FK column). */
  from: string;
  fromCol: string;
  /** Referenced (parent) table. */
  to: string;
  toCol: string;
  /** Inferred from a *_id column name, not a real constraint. */
  guess?: boolean;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ColumnMode = "all" | "keys" | "none";

export const HEADER_H = 30;
export const ROW_H = 20;
export const PAD_Y = 6;
const RANK_GAP = 110;
const NODE_GAP = 34;
const COMP_GAP = 90;

/** Columns shown for a mode (keys = PK + FK columns). */
export function visibleColumns(t: ErTable, mode: ColumnMode): ErColumn[] {
  if (mode === "none") return [];
  if (mode === "keys") return t.columns.filter((c) => c.pk || c.fk);
  return t.columns;
}

/** Box size from text lengths (12px UI font ≈ 7px per char). */
export function measure(t: ErTable, mode: ColumnMode): { w: number; h: number } {
  const cols = visibleColumns(t, mode);
  const head = t.name.length * 7.8 + 34;
  // 32px key gutter + name (11.5px mono ≈ 7.1/char) + 18px gap + type (10.5px ≈ 6.5/char) + 10px pad.
  const body = cols.reduce((m, c) => Math.max(m, c.name.length * 7.1 + (c.type.length + 1) * 6.5 + 60), 0);
  const w = Math.round(Math.min(460, Math.max(150, head, body)));
  const h = HEADER_H + (cols.length ? cols.length * ROW_H + PAD_Y * 2 : 0);
  return { w, h };
}

/** Y (relative to the box top) of a column's row centre; header centre if hidden. */
export function columnY(t: ErTable, col: string, mode: ColumnMode): number {
  const i = visibleColumns(t, mode).findIndex((c) => c.name === col);
  return i < 0 ? HEADER_H / 2 : HEADER_H + PAD_Y + i * ROW_H + ROW_H / 2;
}

export function layout(tables: ErTable[], edges: ErEdge[], mode: ColumnMode): Map<string, Box> {
  const size = new Map(tables.map((t) => [t.name, measure(t, mode)]));
  const names = tables.map((t) => t.name);
  const present = new Set(names);
  const es = edges.filter((e) => present.has(e.from) && present.has(e.to));

  // Undirected neighbours + directed parents (child → parent), no self-loops.
  const nbr = new Map<string, Set<string>>(names.map((n) => [n, new Set()]));
  const parents = new Map<string, Set<string>>(names.map((n) => [n, new Set()]));
  for (const e of es) {
    if (e.from === e.to) continue;
    nbr.get(e.from)!.add(e.to);
    nbr.get(e.to)!.add(e.from);
    parents.get(e.from)!.add(e.to);
  }

  // Connected components.
  const comps: string[][] = [];
  const seen = new Set<string>();
  for (const n of [...names].sort()) {
    if (seen.has(n)) continue;
    const comp: string[] = [];
    const stack = [n];
    seen.add(n);
    while (stack.length) {
      const c = stack.pop()!;
      comp.push(c);
      for (const m of nbr.get(c)!) if (!seen.has(m)) (seen.add(m), stack.push(m));
    }
    comps.push(comp);
  }

  // Rank = longest path to a parentless table; back edges (cycles) ignored.
  const rank = new Map<string, number>();
  const onStack = new Set<string>();
  const rankOf = (n: string): number => {
    const r = rank.get(n);
    if (r !== undefined) return r;
    onStack.add(n);
    let best = 0;
    for (const p of parents.get(n)!) if (!onStack.has(p)) best = Math.max(best, rankOf(p) + 1);
    onStack.delete(n);
    rank.set(n, best);
    return best;
  };

  interface Placed {
    boxes: Map<string, Box>;
    w: number;
    h: number;
  }
  const placed: Placed[] = comps.map((comp) => {
    const layers: string[][] = [];
    for (const n of comp) {
      const r = rankOf(n);
      (layers[r] ??= []).push(n);
    }
    for (const l of layers) l?.sort();
    const ls = layers.filter(Boolean);
    // Barycenter sweeps, alternating direction.
    const pos = () => {
      const m = new Map<string, number>();
      ls.forEach((l) => l.forEach((n, i) => m.set(n, i)));
      return m;
    };
    for (let sweep = 0; sweep < 6; sweep++) {
      const p = pos();
      const order = sweep % 2 === 0 ? ls.keys() : [...ls.keys()].reverse();
      for (const li of order) {
        const bc = (n: string) => {
          const ns = [...nbr.get(n)!].filter((m) => p.has(m));
          return ns.length ? ns.reduce((s, m) => s + p.get(m)!, 0) / ns.length : p.get(n)!;
        };
        ls[li] = [...ls[li]].sort((a, b) => bc(a) - bc(b) || a.localeCompare(b));
      }
    }
    // Coordinates: ranks are columns; each column centred on the tallest.
    const colW = ls.map((l) => Math.max(...l.map((n) => size.get(n)!.w)));
    const colH = ls.map((l) => l.reduce((s, n) => s + size.get(n)!.h, 0) + NODE_GAP * (l.length - 1));
    const maxH = Math.max(...colH);
    const boxes = new Map<string, Box>();
    let x = 0;
    ls.forEach((l, li) => {
      let y = (maxH - colH[li]) / 2;
      for (const n of l) {
        const s = size.get(n)!;
        boxes.set(n, { x, y, w: s.w, h: s.h });
        y += s.h + NODE_GAP;
      }
      x += colW[li] + RANK_GAP;
    });
    return { boxes, w: x - RANK_GAP, h: maxH };
  });

  // Shelf-pack: biggest components first; lone tables fill rows at the end.
  placed.sort((a, b) => b.boxes.size - a.boxes.size || b.h - a.h);
  const maxRow = Math.max(1600, ...placed.map((p) => p.w));
  const out = new Map<string, Box>();
  let cx = 0;
  let cy = 0;
  let rowH = 0;
  for (const p of placed) {
    if (cx > 0 && cx + p.w > maxRow) {
      cx = 0;
      cy += rowH + COMP_GAP;
      rowH = 0;
    }
    for (const [n, b] of p.boxes) out.set(n, { ...b, x: b.x + cx, y: b.y + cy });
    cx += p.w + (p.boxes.size > 1 ? COMP_GAP : NODE_GAP);
    rowH = Math.max(rowH, p.h);
  }
  return out;
}

/** Bounding box of all boxes (empty → zero box). */
export function bounds(boxes: Iterable<Box>): Box {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return x0 === Infinity ? { x: 0, y: 0, w: 0, h: 0 } : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Edge path between a child column and its parent column: a horizontal-
 *  tangent cubic, leaving/entering on the sides that face each other (a
 *  self-reference or stacked pair loops out on the right). Also returns the
 *  end points + which way each end faces (for the crow's-foot markers). */
export function edgePath(
  child: Box,
  cy: number,
  parent: Box,
  py: number,
): { d: string; x1: number; y1: number; dir1: 1 | -1; x2: number; y2: number; dir2: 1 | -1; k: number } {
  const y1 = child.y + cy;
  const y2 = parent.y + py;
  const cc = child.x + child.w / 2;
  const pc = parent.x + parent.w / 2;
  let x1: number, x2: number, dir1: 1 | -1, dir2: 1 | -1;
  const overlap = child.x < parent.x + parent.w && parent.x < child.x + child.w;
  if (overlap) {
    x1 = child.x + child.w;
    x2 = parent.x + parent.w;
    dir1 = 1;
    dir2 = 1;
  } else if (cc > pc) {
    x1 = child.x;
    x2 = parent.x + parent.w;
    dir1 = -1;
    dir2 = 1;
  } else {
    x1 = child.x + child.w;
    x2 = parent.x;
    dir1 = 1;
    dir2 = -1;
  }
  const k = overlap ? 46 + Math.abs(y2 - y1) * 0.12 : Math.max(36, Math.abs(x2 - x1) / 2);
  // Leave a short straight stub at each end so the markers sit flat.
  const s1 = x1 + dir1 * 12;
  const s2 = x2 + dir2 * 12;
  const d = `M${x1},${y1} L${s1},${y1} C${s1 + dir1 * k},${y1} ${s2 + dir2 * k},${y2} ${s2},${y2} L${x2},${y2}`;
  return { d, x1, y1, dir1, x2, y2, dir2, k };
}

/** English-ish plural forms a `<base>_id` column might point at. */
function pluralForms(base: string): string[] {
  const b = base.toLowerCase();
  const out = [b, b + "s", b + "es"];
  if (/[^aeiou]y$/.test(b)) out.push(b.slice(0, -1) + "ies");
  if (b.endsWith("f")) out.push(b.slice(0, -1) + "ves");
  if (b.endsWith("person")) out.push(b.slice(0, -6) + "people");
  return out;
}

/** Links guessed from column names for databases without FK constraints
 *  (common with Laravel/Rails): `country_id` → `countries.id`,
 *  `fee_category_id` → `fee_categories` (else `categories`), `parent_id` →
 *  its own table. Only columns that aren't already a real FK / the PK, and
 *  only when the target table has a single-column key to point at. */
export function guessEdges(
  tables: { name: string; columns: { name: string; pk: boolean }[]; fkCols: Set<string> }[],
): ErEdge[] {
  const byLower = new Map<string, (typeof tables)[number]>();
  for (const t of tables) byLower.set(t.name.split(".").pop()!.toLowerCase(), t);
  const keyOf = (t: (typeof tables)[number]): string | null => {
    const pks = t.columns.filter((c) => c.pk);
    if (pks.length === 1) return pks[0].name;
    return t.columns.find((c) => c.name.toLowerCase() === "id")?.name ?? null;
  };
  const out: ErEdge[] = [];
  for (const t of tables) {
    for (const c of t.columns) {
      if (c.pk || t.fkCols.has(c.name)) continue;
      const m = c.name.match(/^(.+?)_?id$/i);
      if (!m || !/_id$|[a-z]Id$/.test(c.name)) continue;
      const base = m[1].replace(/_$/, "");
      let target: (typeof tables)[number] | undefined;
      if (/^parent$/i.test(base)) target = t;
      const tryForms = (b: string) => {
        for (const f of pluralForms(b)) {
          const hit = byLower.get(f);
          if (hit) return hit;
        }
        return undefined;
      };
      target ??= tryForms(base);
      if (!target && base.includes("_")) target = tryForms(base.split("_").pop()!);
      if (!target) continue;
      const key = keyOf(target);
      if (!key) continue;
      out.push({ from: t.name, fromCol: c.name, to: target.name, toCol: key, guess: true });
    }
  }
  return out;
}

// ---- Line jumps -----------------------------------------------------------
// Where two links cross, the later one hops over the earlier with a small
// semicircle, so it's clear which line goes where (as in Visio/draw.io).

export type Pt = [number, number];

export type LineStyle = "curved" | "straight" | "elbow";

/** The link from edgePath() as a polyline in the chosen style: the cubic
 *  sampled, a straight diagonal between the stubs, or right-angled ("elbow")
 *  with the vertical run in the gap between the tables. `lane` (0,1,2…) nudges
 *  elbow verticals apart so links through the same gap don't sit on top of
 *  each other. */
export function edgePolyline(p: ReturnType<typeof edgePath>, style: LineStyle = "curved", lane = 0): Pt[] {
  const { x1, y1, dir1, x2, y2, dir2, k } = p;
  const s1 = x1 + dir1 * 12;
  const s2 = x2 + dir2 * 12;
  if (style === "straight") return [[x1, y1], [s1, y1], [s2, y2], [x2, y2]];
  if (style === "elbow") {
    const off = ((lane % 7) - 3) * 6;
    // Same side (stacked / self link): run out past both, else midway.
    const mx = dir1 === dir2 ? Math.max(s1, s2) + 22 + Math.abs(off) : (s1 + s2) / 2 + off;
    return [[x1, y1], [s1, y1], [mx, y1], [mx, y2], [s2, y2], [x2, y2]];
  }
  const c1: Pt = [s1 + dir1 * k, y1];
  const c2: Pt = [s2 + dir2 * k, y2];
  const out: Pt[] = [[x1, y1], [s1, y1]];
  const N = 28;
  for (let i = 1; i <= N; i++) {
    const t = i / N;
    const u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    out.push([a * s1 + b * c1[0] + c * c2[0] + d * s2, a * y1 + b * c1[1] + c * c2[1] + d * y2]);
  }
  out.push([x2, y2]);
  return out;
}

function segHit(a: Pt, b: Pt, c: Pt, d: Pt): [number, number] | null {
  const rx = b[0] - a[0], ry = b[1] - a[1];
  const sx = d[0] - c[0], sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const qx = c[0] - a[0], qy = c[1] - a[1];
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  // Nearly parallel lines "cross" over a long stretch — a hop there looks wrong.
  const sin = Math.abs(den) / (Math.hypot(rx, ry) * Math.hypot(sx, sy));
  if (sin < 0.12) return null;
  return [t, u];
}

/** Around a column several links share, crossings closer than this don't hop. */
const BUNDLE_R = 80;

/** SVG path for each polyline, hopping over every earlier polyline it crosses. */
export function pathsWithJumps(lines: Pt[][], r = 5): string[] {
  const lens = lines.map((l) => {
    const acc = [0];
    for (let i = 1; i < l.length; i++) acc.push(acc[i - 1] + Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]));
    return acc;
  });
  const bbox = lines.map((l) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of l) (x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y));
    return { x0, y0, x1, y1 };
  });
  const near = 22; // no hops right at the table edge (markers live there)
  return lines.map((l, i) => {
    const L = lens[i];
    const total = L[L.length - 1];
    const hits: number[] = [];
    const same = (p: Pt, q: Pt) => Math.abs(p[0] - q[0]) < 0.5 && Math.abs(p[1] - q[1]) < 0.5;
    const ends = (x: Pt[]) => [x[0], x[x.length - 1]];
    for (let j = 0; j < i; j++) {
      // Links meeting at the same column (one PK fanning out to many FKs) are
      // a bundle — they cross each other on the way out of the table, and hops
      // there only add noise. Crossings further out still hop.
      const shared = ends(l).filter((p) => ends(lines[j]).some((q) => same(p, q)));
      const A = bbox[i], B = bbox[j];
      if (A.x1 < B.x0 || B.x1 < A.x0 || A.y1 < B.y0 || B.y1 < A.y0) continue;
      const m = lines[j];
      const ML = lens[j];
      const mTotal = ML[ML.length - 1];
      for (let a = 1; a < l.length; a++) {
        for (let b = 1; b < m.length; b++) {
          const h = segHit(l[a - 1], l[a], m[b - 1], m[b]);
          if (!h) continue;
          const s = L[a - 1] + h[0] * (L[a] - L[a - 1]);
          const sm = ML[b - 1] + h[1] * (ML[b] - ML[b - 1]);
          if (s < near || s > total - near || sm < near || sm > mTotal - near) continue;
          if (shared.length) {
            // Only near where the bundle meets the table; further out it's a real crossing.
            const a0 = l[a - 1], a1 = l[a];
            const x = a0[0] + h[0] * (a1[0] - a0[0]), y = a0[1] + h[0] * (a1[1] - a0[1]);
            if (shared.some((q) => Math.hypot(x - q[0], y - q[1]) < BUNDLE_R)) continue;
          }
          hits.push(s);
        }
      }
    }
    hits.sort((x, y) => x - y);
    const at = (s: number): Pt => {
      let k = 1;
      while (k < L.length - 1 && L[k] < s) k++;
      const seg = L[k] - L[k - 1] || 1;
      const t = Math.max(0, Math.min(1, (s - L[k - 1]) / seg));
      return [l[k - 1][0] + t * (l[k][0] - l[k - 1][0]), l[k - 1][1] + t * (l[k][1] - l[k - 1][1])];
    };
    const f = (n: number) => +n.toFixed(1);
    let d = `M${f(l[0][0])},${f(l[0][1])}`;
    let pen = 0; // distance drawn so far
    let vi = 1; // next vertex
    for (const s of hits) {
      if (s - r < pen + 1) continue; // overlaps the previous hop
      while (vi < l.length && L[vi] < s - r) d += ` L${f(l[vi][0])},${f(l[vi][1])}`, vi++;
      const p0 = at(s - r);
      const p1 = at(s + r);
      const sweep = p1[0] >= p0[0] ? 1 : 0; // bump towards the top of the screen
      d += ` L${f(p0[0])},${f(p0[1])} A${r},${r} 0 0 ${sweep} ${f(p1[0])},${f(p1[1])}`;
      pen = s + r;
      while (vi < l.length && L[vi] <= pen) vi++;
    }
    for (; vi < l.length; vi++) d += ` L${f(l[vi][0])},${f(l[vi][1])}`;
    return d;
  });
}

// ---- Obstacle-avoiding routing -------------------------------------------
// Each link is routed on a sparse orthogonal grid built from the table edges
// (inflated by a margin), with A* minimising length + bends, so it goes
// around tables instead of behind them. Channels already used by earlier
// links cost a little extra, which spreads links out. The chosen style is
// then applied to that route: elbow = small rounded corners, curved = large
// rounded corners, straight = the route pulled taut into diagonals that still
// clear every table.

const RM = 14; // clearance kept around tables
const STUB = 28; // straight run out of a table before the first turn
const BEND = 40;

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function inflate(b: Box, m: number): Rect {
  const r = (n: number) => Math.round(n * 10) / 10;
  return { x0: r(b.x - m), y0: r(b.y - m), x1: r(b.x + b.w + m), y1: r(b.y + b.h + m) };
}


/** Does segment a→b pass through the interior of r (Liang–Barsky)? */
function segCrossesRect(a: Pt, b: Pt, r: Rect): boolean {
  let t0 = 0,
    t1 = 1;
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const clip = (p: number, q: number) => {
    if (Math.abs(p) < 1e-12) return q > 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  if (!clip(-dx, a[0] - r.x0) || !clip(dx, r.x1 - a[0]) || !clip(-dy, a[1] - r.y0) || !clip(dy, r.y1 - a[1])) return false;
  return t1 - t0 > 1e-6;
}

class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size() {
    return this.k.length;
  }
  push(key: number, val: number) {
    const k = this.k,
      v = this.v;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop(): number {
    const k = this.k,
      v = this.v;
    const top = v[0];
    const lk = k.pop()!,
      lv = v.pop()!;
    if (k.length) {
      k[0] = lk;
      v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1,
          r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

const uniq = (a: number[]) => [...new Set(a.map((n) => Math.round(n * 10) / 10))].sort((x, y) => x - y);

/** Already-routed link segments, bucketed on a coarse grid, so a candidate
 *  move can be charged for crossing or running along other links. */
class SegIndex {
  private cells = new Map<number, { v: boolean; c: number; lo: number; hi: number; o: number; q: number }[]>();
  private readonly S = 64;
  private qid = 0;
  private key(i: number, j: number) {
    return (i + 32768) * 65536 + (j + 32768);
  }
  add(pts: Pt[], owner: number) {
    const S = this.S;
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1],
        b = pts[k];
      const v = Math.abs(a[0] - b[0]) < 0.01;
      if (!v && Math.abs(a[1] - b[1]) > 0.01) continue; // only axis-aligned runs
      const sg = { v, c: v ? a[0] : a[1], lo: Math.min(v ? a[1] : a[0], v ? b[1] : b[0]), hi: Math.max(v ? a[1] : a[0], v ? b[1] : b[0]), o: owner, q: 0 };
      for (let i = Math.floor(Math.min(a[0], b[0]) / S); i <= Math.floor(Math.max(a[0], b[0]) / S); i++)
        for (let j = Math.floor(Math.min(a[1], b[1]) / S); j <= Math.floor(Math.max(a[1], b[1]) / S); j++) {
          const kk = this.key(i, j);
          let list = this.cells.get(kk);
          if (!list) this.cells.set(kk, (list = []));
          list.push(sg);
        }
    }
  }
  remove(owner: number) {
    for (const [k, list] of this.cells) this.cells.set(k, list.filter((sg) => sg.o !== owner));
  }
  /** Penalty for a move (x0,y0)→(x1,y1): crossings + length run alongside other links. */
  cost(x0: number, y0: number, x1: number, y1: number): number {
    if (!this.cells.size) return 0;
    const S = this.S;
    const v = x0 === x1;
    const c = v ? x0 : y0;
    const lo = v ? Math.min(y0, y1) : Math.min(x0, x1);
    const hi = v ? Math.max(y0, y1) : Math.max(x0, x1);
    const q = ++this.qid;
    let cross = 0,
      along = 0;
    const i0 = Math.floor(Math.min(x0, x1) / S),
      i1 = Math.floor(Math.max(x0, x1) / S);
    const j0 = Math.floor(Math.min(y0, y1) / S),
      j1 = Math.floor(Math.max(y0, y1) / S);
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const list = this.cells.get(this.key(i, j));
        if (!list) continue;
        for (const sg of list) {
          if (sg.q === q) continue;
          sg.q = q;
          if (sg.v === v) {
            if (Math.abs(sg.c - c) < 4) {
              const o = Math.min(hi, sg.hi) - Math.max(lo, sg.lo);
              if (o > 0) along += o;
            }
          } else if (sg.c > lo && sg.c < hi && c > sg.lo && c < sg.hi) cross++;
        }
      }
    return cross * CROSS + along * 0.8;
  }
}
const CROSS = 70;

/** Orthogonal route from start to goal around obstacles, or null. */
function orthoRoute(
  start: Pt,
  startDir: number, // 0 right, 1 left
  goal: Pt,
  goalDir: number, // heading wanted on arrival: 0 right, 1 left
  rects: Rect[],
  idx: SegIndex,
): Pt[] | null {
  const pad = 160;
  const reg: Rect = {
    x0: Math.min(start[0], goal[0]) - pad,
    y0: Math.min(start[1], goal[1]) - pad,
    x1: Math.max(start[0], goal[0]) + pad,
    y1: Math.max(start[1], goal[1]) + pad,
  };
  const obs = rects.filter((r) => r.x1 > reg.x0 && r.x0 < reg.x1 && r.y1 > reg.y0 && r.y0 < reg.y1);
  // Grow the region to take in every obstacle it touches, so there's always a way round.
  for (const r of obs) (reg.x0 = Math.min(reg.x0, r.x0 - 20)), (reg.y0 = Math.min(reg.y0, r.y0 - 20)), (reg.x1 = Math.max(reg.x1, r.x1 + 20)), (reg.y1 = Math.max(reg.y1, r.y1 + 20));
  const xs = uniq([start[0], goal[0], (start[0] + goal[0]) / 2, reg.x0, reg.x1, ...obs.flatMap((r) => [r.x0, r.x1])]);
  const ys = uniq([start[1], goal[1], (start[1] + goal[1]) / 2, reg.y0, reg.y1, ...obs.flatMap((r) => [r.y0, r.y1])]);
  const W = xs.length,
    H = ys.length;
  if (W * H > 40000) return null;
  const xi = new Map(xs.map((x, i) => [x, i]));
  const yi = new Map(ys.map((y, i) => [y, i]));
  const r10 = (n: number) => Math.round(n * 10) / 10;
  const si = xi.get(r10(start[0]))! + yi.get(r10(start[1]))! * W;
  const gi = xi.get(r10(goal[0]))! + yi.get(r10(goal[1]))! * W;
  // Blocked nodes and moves, marked per obstacle over index ranges (rect
  // edges are themselves grid lines, so a move between neighbours is either
  // wholly inside a rect or wholly outside).
  const free = new Uint8Array(W * H).fill(1);
  const blockH = new Uint8Array(W * H); // move (i,j)→(i+1,j)
  const blockV = new Uint8Array(W * H); // move (i,j)→(i,j+1)
  const firstGt = (a: number[], v: number) => {
    let lo = 0,
      hi = a.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (a[m] > v) hi = m;
      else lo = m + 1;
    }
    return lo;
  };
  const E = 0.01;
  for (const r of obs) {
    const ia = firstGt(xs, r.x0 + E), ib = firstGt(xs, r.x1 - E) - 1; // strictly inside (x)
    const ja = firstGt(ys, r.y0 + E), jb = firstGt(ys, r.y1 - E) - 1; // strictly inside (y)
    const ea = firstGt(xs, r.x0 - E), eb = firstGt(xs, r.x1 + E) - 1; // within [x0,x1]
    const fa = firstGt(ys, r.y0 - E), fb = firstGt(ys, r.y1 + E) - 1; // within [y0,y1]
    for (let j = ja; j <= jb; j++) {
      for (let i = ia; i <= ib; i++) free[i + j * W] = 0;
      for (let i = ea; i < eb; i++) blockH[i + j * W] = 1;
    }
    for (let i = ia; i <= ib; i++) for (let j = fa; j < fb; j++) blockV[i + j * W] = 1;
  }
  free[si] = 1;
  free[gi] = 1;
  const DX = [1, -1, 0, 0],
    DY = [0, 0, 1, -1];
  const N = W * H;
  const GOAL = N * 4;
  const g = new Float64Array(N * 4 + 1).fill(Infinity);
  const prev = new Int32Array(N * 4 + 1).fill(-1);
  const heap = new Heap();
  const hfun = (n: number) => Math.abs(xs[n % W] - goal[0]) + Math.abs(ys[(n / W) | 0] - goal[1]);
  const s0 = si * 4 + startDir;
  g[s0] = 0;
  heap.push(hfun(si), s0);
  while (heap.size) {
    const st = heap.pop();
    if (st === GOAL) break;
    const n = (st / 4) | 0,
      d = st % 4;
    const gc = g[st];
    if (n === gi) {
      const c = gc + (d === goalDir ? 0 : BEND * (d < 2 ? 2 : 1));
      if (c < g[GOAL]) (g[GOAL] = c), (prev[GOAL] = st), heap.push(c, GOAL);
      continue;
    }
    const i = n % W,
      j = (n / W) | 0;
    for (let nd = 0; nd < 4; nd++) {
      if ((d ^ 1) === nd && ((d < 2) === (nd < 2))) continue; // no U-turn
      const ni = i + DX[nd],
        nj = j + DY[nd];
      if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
      const m = ni + nj * W;
      if (!free[m]) continue;
      if (nd < 2 ? blockH[Math.min(i, ni) + j * W] : blockV[i + Math.min(j, nj) * W]) continue;
      const len = Math.abs(xs[ni] - xs[i]) + Math.abs(ys[nj] - ys[j]);
      const c = gc + len + (nd === d ? 0 : BEND) + idx.cost(xs[i], ys[j], xs[ni], ys[nj]);
      const ns = m * 4 + nd;
      if (c < g[ns]) {
        g[ns] = c;
        prev[ns] = st;
        heap.push(c + hfun(m), ns);
      }
    }
  }
  if (prev[GOAL] < 0) return null;
  const nodes: number[] = [];
  for (let st = prev[GOAL]; st >= 0; st = prev[st]) nodes.push((st / 4) | 0);
  nodes.reverse();
  const pts: Pt[] = [];
  for (const n of nodes) {
    const p: Pt = [xs[n % W], ys[(n / W) | 0]];
    const L = pts[pts.length - 1];
    if (L && L[0] === p[0] && L[1] === p[1]) continue;
    pts.push(p);
  }
  // Drop collinear middle points.
  const out: Pt[] = [];
  for (const p of pts) {
    while (out.length >= 2) {
      const a = out[out.length - 2],
        b = out[out.length - 1];
      if ((a[0] === b[0] && b[0] === p[0]) || (a[1] === b[1] && b[1] === p[1])) out.pop();
      else break;
    }
    out.push(p);
  }
  return out;
}

/** Round the corners of an orthogonal polyline (sampled, so jumps still work). */
function roundCorners(p: Pt[], R: number): Pt[] {
  if (p.length < 3) return p;
  const out: Pt[] = [p[0]];
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[i - 1],
      v = p[i],
      b = p[i + 1];
    const la = Math.hypot(v[0] - a[0], v[1] - a[1]);
    const lb = Math.hypot(b[0] - v[0], b[1] - v[1]);
    const r = Math.min(R, la / 2, lb / 2);
    if (r < 1) {
      out.push(v);
      continue;
    }
    const p0: Pt = [v[0] + ((a[0] - v[0]) / la) * r, v[1] + ((a[1] - v[1]) / la) * r];
    const p1: Pt = [v[0] + ((b[0] - v[0]) / lb) * r, v[1] + ((b[1] - v[1]) / lb) * r];
    const n = Math.max(3, Math.round(r / 4));
    for (let k = 0; k <= n; k++) {
      const t = k / n,
        u = 1 - t;
      out.push([u * u * p0[0] + 2 * u * t * v[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * v[1] + t * t * p1[1]]);
    }
  }
  out.push(p[p.length - 1]);
  return out;
}

/** Pull a route taut: skip ahead to the farthest point still in clear sight. */
function pullTaut(p: Pt[], rects: Rect[]): Pt[] {
  const out: Pt[] = [p[0]];
  let i = 0;
  while (i < p.length - 1) {
    let j = p.length - 1;
    while (j > i + 1 && rects.some((r) => segCrossesRect(p[i], p[j], r))) j--;
    out.push(p[j]);
    i = j;
  }
  return out;
}

/** Spread links that share a channel: overlapping collinear segments (same
 *  x for verticals, same y for horizontals) get side-by-side lanes. The
 *  horizontal runs attached to a table row stay put; a vertical run may move
 *  its end along the stub (STUB leaves room). Mutates `routes`. */
function separateLanes(routes: (Pt[] | null)[], tight: Rect[]): void {
  interface Seg {
    r: number;
    k: number; // segment from routes[r][k] to routes[r][k+1]
    vert: boolean;
    c: number; // shared coordinate
    lo: number;
    hi: number;
    mid: number;
  }
  const segs: Seg[] = [];
  routes.forEach((pts, r) => {
    if (!pts) return;
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k],
        b = pts[k + 1];
      const vert = a[0] === b[0];
      if (!vert && (k === 0 || k === pts.length - 2)) continue; // on a table row
      const c = vert ? a[0] : a[1];
      const lo = Math.min(vert ? a[1] : a[0], vert ? b[1] : b[0]);
      const hi = Math.max(vert ? a[1] : a[0], vert ? b[1] : b[0]);
      if (hi - lo < 1) continue;
      segs.push({ r, k, vert, c, lo, hi, mid: (lo + hi) / 2 });
    }
  });
  const groups = new Map<string, Seg[]>();
  for (const sg of segs) {
    const key = `${sg.vert ? "v" : "h"}${Math.round(sg.c)}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(sg);
  }
  const before = routes.map((p) => p?.map((q) => [q[0], q[1]] as Pt) ?? null);
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    // Clusters of overlapping intervals; within one, greedy lane colouring.
    g.sort((a, b) => a.lo - b.lo || a.mid - b.mid);
    let i = 0;
    while (i < g.length) {
      let j = i + 1;
      let end = g[i].hi;
      while (j < g.length && g[j].lo < end - 0.5) (end = Math.max(end, g[j].hi)), j++;
      const cl = g.slice(i, j);
      i = j;
      if (cl.length < 2) continue;
      // One lane each, ordered so the turns at their ends don't cut across
      // each other. turn(sg, end): which way the link goes on from that end
      // (+1 towards higher perpendicular coordinate, -1 lower, 0 none).
      const turn = (sg: Seg, hiEnd: boolean): number => {
        const pts = routes[sg.r]!;
        const ax = sg.vert ? 1 : 0; // along-axis
        const pe = sg.vert ? 0 : 1; // perpendicular axis
        const aIsLo = pts[sg.k][ax] <= pts[sg.k + 1][ax];
        const atK = hiEnd ? !aIsLo : aIsLo; // is this end pts[k]?
        const nb = atK ? pts[sg.k - 1] : pts[sg.k + 2];
        if (!nb) return 0;
        const d = nb[pe] - sg.c;
        return Math.abs(d) < 0.5 ? 0 : Math.sign(d);
      };
      // Crossings if a sits on the lower side of b.
      const cost = (a: Seg, b: Seg): number => {
        let n = 0;
        const inB = (y: number) => y > b.lo + 0.5 && y < b.hi - 0.5;
        const inA = (y: number) => y > a.lo + 0.5 && y < a.hi - 0.5;
        if (inB(a.lo) && turn(a, false) > 0) n++;
        if (inB(a.hi) && turn(a, true) > 0) n++;
        if (inA(b.lo) && turn(b, false) < 0) n++;
        if (inA(b.hi) && turn(b, true) < 0) n++;
        return n;
      };
      const ord = [...cl];
      for (let pass = 0; pass < ord.length; pass++) {
        let swapped = false;
        for (let q = 0; q + 1 < ord.length; q++) {
          if (cost(ord[q], ord[q + 1]) > cost(ord[q + 1], ord[q])) {
            [ord[q], ord[q + 1]] = [ord[q + 1], ord[q]];
            swapped = true;
          }
        }
        if (!swapped) break;
      }
      const lane = new Map<Seg, number>(ord.map((sg, q) => [sg, q]));
      const n = ord.length;
      const sp = Math.min(7, 24 / (n - 1));
      for (const sg of cl) {
        const off = (lane.get(sg)! - (n - 1) / 2) * sp;
        const pts = routes[sg.r]!;
        const ax = sg.vert ? 0 : 1;
        pts[sg.k][ax] = sg.c + off;
        pts[sg.k + 1][ax] = sg.c + off;
      }
    }
  }
  // A nudge must never push a link into a table — undo it for that link.
  routes.forEach((pts, r) => {
    if (!pts) return;
    // (The first/last runs start on a table edge by design — skip them.)
    for (let k = 1; k < pts.length - 2; k++) {
      if (tight.some((rc) => segCrossesRect(pts[k], pts[k + 1], rc))) {
        routes[r] = before[r];
        return;
      }
    }
  });
}

/** Route every link around the tables and shape it in the given style. */
export function routeLinks(
  ps: ReturnType<typeof edgePath>[],
  boxes: Box[],
  style: LineStyle,
  onProgress?: (done: number, total: number) => void,
): Pt[][] {
  const rects = boxes.map((b) => inflate(b, RM));
  const tight = boxes.map((b) => inflate(b, 2));
  const idx = new SegIndex();
  const route1 = (i: number) => {
    const p = ps[i];
    const s: Pt = [p.x1 + p.dir1 * STUB, p.y1];
    const e: Pt = [p.x2 + p.dir2 * STUB, p.y2];
    return orthoRoute(s, p.dir1 > 0 ? 0 : 1, e, p.dir2 > 0 ? 1 : 0, rects, idx);
  };
  // Short links first: they have the fewest ways round, long ones can detour.
  const order = ps.map((_, i) => i).sort((a, b) => {
    const L = (p: (typeof ps)[number]) => Math.abs(p.x2 - p.x1) + Math.abs(p.y2 - p.y1);
    return L(ps[a]) - L(ps[b]);
  });
  const mids: (Pt[] | null)[] = ps.map(() => null);
  const second = ps.length <= 40;
  const total = ps.length * (second ? 2 : 1);
  let done = 0;
  for (const i of order) {
    mids[i] = route1(i);
    if (mids[i]) idx.add(mids[i]!, i);
    if (onProgress && ++done % 20 === 0) onProgress(done, total);
  }
  // Rip-up and re-route: each link again, now seeing every other link.
  if (second) {
    for (const i of order) {
      idx.remove(i);
      const r = route1(i);
      if (r) mids[i] = r;
      if (mids[i]) idx.add(mids[i]!, i);
    }
  }
  // Lanes are judged on the whole route, table stubs included.
  const collinear = (pts: Pt[]): Pt[] => {
    const out: Pt[] = [];
    for (const q of pts) {
      while (out.length >= 2) {
        const a = out[out.length - 2],
          b = out[out.length - 1];
        if ((a[0] === b[0] && b[0] === q[0]) || (a[1] === b[1] && b[1] === q[1])) out.pop();
        else break;
      }
      out.push(q);
    }
    return out;
  };
  const full = mids.map((m, i) => (m ? collinear([[ps[i].x1, ps[i].y1], ...m, [ps[i].x2, ps[i].y2]]) : null));
  separateLanes(full, tight);
  return ps.map((p, i) => {
    const route = full[i];
    if (!route) return edgePolyline(p, style);
    if (style === "straight") {
      // Pull from stub end to stub end (merging collinear points dropped them).
      const s0: Pt = [p.x1 + p.dir1 * STUB, p.y1];
      const e0: Pt = [p.x2 + p.dir2 * STUB, p.y2];
      const t = pullTaut([s0, ...route.slice(1, -1), e0], boxes.map((b) => inflate(b, 4)));
      return [route[0], ...t, route[route.length - 1]];
    }
    return roundCorners(route, style === "curved" ? 36 : 7);
  });
}
