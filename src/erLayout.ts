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
): { d: string; x1: number; y1: number; dir1: 1 | -1; x2: number; y2: number; dir2: 1 | -1 } {
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
  return { d, x1, y1, dir1, x2, y2, dir2 };
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
