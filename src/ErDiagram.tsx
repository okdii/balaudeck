// ER diagram of one database: tables as boxes (PK/FK marked), foreign keys as
// crow's-foot links. Auto-laid-out (erLayout.ts), then pan (drag / scroll),
// zoom (pinch / ⌘-scroll / buttons), drag tables around, hover a table to
// trace its relations, and export PNG/SVG. Works on every SQL engine —
// columns + FKs come from db_table_schema.

import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { api } from "./api";
import type { TableSchemaInfo } from "./ddl";
import { Icon, Spinner } from "./Icon";
import { maskText } from "./privacy";
import { jpegToPdf } from "./pdfImage";
import {
  HEADER_H,
  PAD_Y,
  ROW_H,
  bounds,
  columnY,
  edgePath,
  guessEdges,
  layout,
  visibleColumns,
  type Box,
  type ColumnMode,
  type ErEdge,
  type ErTable,
} from "./erLayout";

/** Above this many tables nothing is pre-selected (the picker comes first). */
const AUTO_ALL = 80;
const FETCH_CAP = 800;

/** Match an FK's referenced table to a listed name: exact, else by the last
 *  dotted segment (engines report "schema.table" vs "table" differently). */
function resolveTable(ref: string, names: string[], byLower: Map<string, string>): string | null {
  if (byLower.has(ref.toLowerCase())) return byLower.get(ref.toLowerCase())!;
  const tail = ref.split(".").pop()!.toLowerCase();
  const hits = names.filter((n) => n.split(".").pop()!.toLowerCase() === tail);
  return hits.length === 1 ? hits[0] : null;
}

function shortType(dataType: string, length: string): string {
  const t = dataType.toLowerCase();
  return length && !/text|blob|json|bool|date|time/.test(t) ? `${t}(${length})` : t;
}

export function ErDiagram({
  params,
  database,
  label,
  onClose,
  onOpenTable,
}: {
  params: Parameters<typeof api.dbTableSchema>[0] & Parameters<typeof api.dbSchemaObjects>[0];
  database: string;
  label: string;
  onClose: () => void;
  onOpenTable?: (table: string) => void;
}) {
  const [names, setNames] = useState<string[]>([]);
  const [schemas, setSchemas] = useState<Map<string, TableSchemaInfo>>(new Map());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [err, setErr] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [mode, setMode] = useState<ColumnMode>("all");
  const [moved, setMoved] = useState<Map<string, Box>>(new Map());
  const [view, setView] = useState({ x: 40, y: 40, k: 1 });
  const [hover, setHover] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [note, setNote] = useState("");
  // Guess links from *_id names; null = automatic (on when the DB has no FKs).
  const [guessPref, setGuessPref] = useState<boolean | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; name: string } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const fittedRef = useRef(false);

  // 1. table list, 2. every table's schema (columns + FKs), a few at a time.
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const objs = await api.dbSchemaObjects(params, database);
        const list = [...objs.tables].sort((a, b) => a.localeCompare(b));
        if (dead) return;
        setNames(list);
        setSelected(new Set(list.length <= AUTO_ALL ? list : []));
        const todo = list.slice(0, FETCH_CAP);
        setProgress({ done: 0, total: todo.length });
        const got = new Map<string, TableSchemaInfo>();
        let i = 0;
        let done = 0;
        const worker = async () => {
          while (i < todo.length && !dead) {
            const t = todo[i++];
            try {
              got.set(t, await api.dbTableSchema(params, database, t));
            } catch {
              got.set(t, { columns: [], foreignKeys: [], indexes: [] });
            }
            done++;
            if (done % 8 === 0 || done === todo.length) {
              setProgress({ done, total: todo.length });
              setSchemas(new Map(got));
            }
          }
        };
        await Promise.all(Array.from({ length: 6 }, worker));
        if (!dead) {
          setSchemas(new Map(got));
          setProgress(null);
          if (list.length > FETCH_CAP) setNote(`Showing the first ${FETCH_CAP} of ${list.length} tables.`);
        }
      } catch (e) {
        if (!dead) setErr(String(e));
      }
    })();
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [database]);

  // All FK edges between known tables (also those not drawn — for "+ related").
  const realEdges = useMemo<ErEdge[]>(() => {
    const byLower = new Map(names.map((n) => [n.toLowerCase(), n]));
    const out: ErEdge[] = [];
    for (const [t, s] of schemas)
      for (const fk of s.foreignKeys) {
        const to = resolveTable(fk.refTable, names, byLower);
        if (to) out.push({ from: t, fromCol: fk.column, to, toCol: fk.refColumn });
      }
    return out;
  }, [schemas, names]);
  const guess = guessPref ?? (!progress && schemas.size > 0 && realEdges.length === 0);
  const guessed = useMemo<ErEdge[]>(
    () =>
      guess
        ? guessEdges(
            [...schemas].map(([name, s]) => ({
              name,
              columns: s.columns,
              fkCols: new Set(s.foreignKeys.map((f) => f.column)),
            })),
          )
        : [],
    [guess, schemas],
  );
  const allEdges = useMemo(() => [...realEdges, ...guessed], [realEdges, guessed]);

  const tables = useMemo<ErTable[]>(() => {
    return names
      .filter((n) => selected.has(n) && schemas.has(n))
      .map((n) => {
        const s = schemas.get(n)!;
        const fkCols = new Set(s.foreignKeys.map((f) => f.column));
        const guessCols = new Set(guessed.filter((e) => e.from === n).map((e) => e.fromCol));
        return {
          name: n,
          columns: s.columns.map((c) => ({
            name: c.name,
            type: shortType(c.dataType, c.length),
            nullable: c.nullable,
            pk: c.pk,
            fk: fkCols.has(c.name) || guessCols.has(c.name),
            guess: !fkCols.has(c.name) && guessCols.has(c.name),
          })),
        };
      });
  }, [names, selected, schemas, guessed]);
  const byName = useMemo(() => new Map(tables.map((t) => [t.name, t])), [tables]);
  const edges = useMemo(
    () => allEdges.filter((e) => byName.has(e.from) && byName.has(e.to)),
    [allEdges, byName],
  );

  const auto = useMemo(() => layout(tables, edges, mode), [tables, edges, mode]);
  const boxes = useMemo(() => {
    const m = new Map(auto);
    for (const [n, b] of moved) if (m.has(n)) m.set(n, { ...m.get(n)!, x: b.x, y: b.y });
    return m;
  }, [auto, moved]);

  function fit() {
    const el = canvasRef.current;
    if (!el || !boxes.size) return;
    const b = bounds(boxes.values());
    const k = Math.min(1.2, Math.max(0.12, Math.min((el.clientWidth - 60) / b.w, (el.clientHeight - 60) / b.h)));
    setView({ k, x: (el.clientWidth - b.w * k) / 2 - b.x * k, y: (el.clientHeight - b.h * k) / 2 - b.y * k });
  }
  // Fit once the first full layout is there, and after a re-arrange.
  useEffect(() => {
    if (!fittedRef.current && boxes.size && !progress) {
      fittedRef.current = true;
      fit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxes, progress]);

  function centerOn(n: string) {
    const el = canvasRef.current;
    const b = boxes.get(n);
    if (!el || !b) return;
    const k = Math.max(view.k, 0.8);
    setView({ k, x: el.clientWidth / 2 - (b.x + b.w / 2) * k, y: el.clientHeight / 2 - (b.y + b.h / 2) * k });
    setFocus(n);
    setTimeout(() => setFocus((f) => (f === n ? null : f)), 1600);
  }

  // ---- pan / zoom / drag ------------------------------------------------------
  const drag = useRef<
    | { kind: "pan"; sx: number; sy: number; vx: number; vy: number }
    | { kind: "node"; name: string; sx: number; sy: number; bx: number; by: number; movedPx: number }
    | null
  >(null);

  function zoomAt(factor: number, cx: number, cy: number) {
    setView((v) => {
      const k = Math.min(3, Math.max(0.08, v.k * factor));
      const f = k / v.k;
      return { k, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f };
    });
  }

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
      else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  function onBgDown(e: RPointerEvent) {
    if (e.button !== 0) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
  }
  function onNodeDown(e: RPointerEvent, name: string) {
    if (e.button !== 0) return;
    e.stopPropagation();
    canvasRef.current?.setPointerCapture(e.pointerId);
    const b = boxes.get(name)!;
    drag.current = { kind: "node", name, sx: e.clientX, sy: e.clientY, bx: b.x, by: b.y, movedPx: 0 };
  }
  function onMove(e: RPointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (d.kind === "pan") setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
    else {
      d.movedPx = Math.max(d.movedPx, Math.abs(dx) + Math.abs(dy));
      const b = boxes.get(d.name)!;
      setMoved((m) => new Map(m).set(d.name, { ...b, x: d.bx + dx / view.k, y: d.by + dy / view.k }));
    }
  }
  function onUp() {
    drag.current = null;
  }

  // ---- selection helpers --------------------------------------------------------
  const shown = names.filter((n) => !filter || n.toLowerCase().includes(filter.toLowerCase()));
  function toggle(n: string) {
    setSelected((s) => {
      const c = new Set(s);
      if (c.has(n)) c.delete(n);
      else c.add(n);
      return c;
    });
  }
  function addRelated() {
    setSelected((s) => {
      const c = new Set(s);
      for (const e of allEdges) {
        if (s.has(e.from)) c.add(e.to);
        if (s.has(e.to)) c.add(e.from);
      }
      return c;
    });
  }
  /** Tables one link away from `n` (either direction). */
  function neighbours(n: string): string[] {
    const s = new Set<string>();
    for (const e of allEdges) {
      if (e.from === n && e.to !== n) s.add(e.to);
      if (e.to === n && e.from !== n) s.add(e.from);
    }
    return [...s].sort((a, b) => a.localeCompare(b));
  }
  function showRelated(n: string, only: boolean) {
    setMenu(null);
    const nb = neighbours(n);
    setSelected((s) => new Set([...(only ? [] : s), n, ...nb]));
    setNote(nb.length ? "" : `${n} has no linked tables${guess ? "" : " — try “Guess links from *_id”"}.`);
  }
  function hideTable(n: string) {
    setMenu(null);
    setSelected((s) => {
      const c = new Set(s);
      c.delete(n);
      return c;
    });
  }
  function rearrange() {
    setMoved(new Map());
    fittedRef.current = false;
  }
  useEffect(() => {
    // New selection / column mode → fresh layout, refit.
    setMoved(new Map());
    fittedRef.current = false;
  }, [selected, mode]);

  // Hover: the table, its neighbours and the links between them stay lit.
  const lit = useMemo(() => {
    if (!hover) return null;
    const s = new Set([hover]);
    for (const e of edges) {
      if (e.from === hover) s.add(e.to);
      if (e.to === hover) s.add(e.from);
    }
    return s;
  }, [hover, edges]);

  // ---- export ---------------------------------------------------------------------
  /** Standalone SVG of the whole diagram with CSS variables resolved. */
  function svgString(): { svg: string; w: number; h: number } {
    const src = svgRef.current!;
    const b = bounds(boxes.values());
    const pad = 32;
    const w = Math.ceil(b.w + pad * 2);
    const h = Math.ceil(b.h + pad * 2);
    const clone = src.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", String(w));
    clone.setAttribute("height", String(h));
    clone.setAttribute("viewBox", `0 0 ${w} ${h}`);
    clone.querySelector("g.er-world")!.setAttribute("transform", `translate(${pad - b.x},${pad - b.y})`);
    const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bg.setAttribute("width", "100%");
    bg.setAttribute("height", "100%");
    bg.setAttribute("fill", "var(--bg)");
    clone.insertBefore(bg, clone.firstChild);
    clone.querySelectorAll(".er-bg").forEach((n) => n.remove());
    const cs = getComputedStyle(document.documentElement);
    const svg = new XMLSerializer()
      .serializeToString(clone)
      .replace(/var\((--[\w-]+)\)/g, (_, v: string) => cs.getPropertyValue(v).trim() || "#888");
    return { svg, w, h };
  }

  /** The diagram rasterised at `scale` (canvas filled with the bg colour). */
  async function rasterise(svg: string, w: number, h: number, scale: number): Promise<HTMLCanvasElement> {
    const img = new Image();
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    await img.decode();
    const c = document.createElement("canvas");
    c.width = Math.round(w * scale);
    c.height = Math.round(h * scale);
    const ctx = c.getContext("2d")!;
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    return c;
  }

  async function exportAs(kind: "png" | "svg" | "pdf") {
    setNote("");
    try {
      // Export the plain diagram, not the hover/centre highlight.
      setHover(null);
      setFocus(null);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const { svg, w, h } = svgString();
      const base = `er-${database.replace(/[^\w.-]+/g, "_")}`;
      const path = await save({
        defaultPath: `${base}.${kind}`,
        filters: [{ name: kind.toUpperCase(), extensions: [kind] }],
      });
      if (!path) return;
      if (kind === "svg") {
        await writeTextFile(path, svg);
      } else if (kind === "pdf") {
        // Sharp enough to zoom into (≈200 dpi), within canvas limits.
        const scale = Math.min(2.5, 16000 / Math.max(w, h));
        const c = await rasterise(svg, w, h, scale);
        const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", 0.92));
        if (!blob) throw new Error("the image is too large to render");
        const jpeg = new Uint8Array(await blob.arrayBuffer());
        // CSS px → pt (72/96), so the page prints at the on-screen size.
        await writeFile(path, jpegToPdf(jpeg, c.width, c.height, w * 0.75, h * 0.75, `ER diagram · ${database}`));
      } else {
        const scale = Math.min(2, 16000 / Math.max(w, h));
        const c = await rasterise(svg, w, h, scale);
        const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
        if (!blob) throw new Error("the image is too large to render");
        await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
      }
      setNote(`Saved ${path.split(/[\\/]/).pop()}.`);
    } catch (e) {
      setNote(`Export failed: ${e}`);
    }
  }

  // ---- render -----------------------------------------------------------------------
  const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";
  const sans = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

  return (
    <div className="modal-backdrop" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="modal er-modal" onClick={(e) => e.stopPropagation()}>
        <div className="er-head">
          <h3>
            <Icon name="layers" size={15} /> ER diagram · {maskText(database)}
            <small>{maskText(label)}</small>
          </h3>
          <div className="er-tools">
            <div className="seg solid er-mode">
              {(["all", "keys", "none"] as ColumnMode[]).map((m) => (
                <button key={m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
                  {m === "all" ? "All columns" : m === "keys" ? "Keys" : "Names"}
                </button>
              ))}
            </div>
            <button className="icon" title="Zoom out" onClick={() => zoomAt(1 / 1.25, (canvasRef.current?.clientWidth ?? 0) / 2, (canvasRef.current?.clientHeight ?? 0) / 2)}>
              −
            </button>
            <span className="er-zoom">{Math.round(view.k * 100)}%</span>
            <button className="icon" title="Zoom in" onClick={() => zoomAt(1.25, (canvasRef.current?.clientWidth ?? 0) / 2, (canvasRef.current?.clientHeight ?? 0) / 2)}>
              +
            </button>
            <button className="ghost" onClick={fit} title="Fit the diagram to the window">
              Fit
            </button>
            <button className="ghost" onClick={rearrange} title="Undo manual moves and lay out again">
              Re-arrange
            </button>
            <button className="ghost" onClick={() => void exportAs("png")} disabled={!boxes.size}>
              <Icon name="download" size={13} /> PNG
            </button>
            <button className="ghost" onClick={() => void exportAs("svg")} disabled={!boxes.size}>
              SVG
            </button>
            <button className="ghost" onClick={() => void exportAs("pdf")} disabled={!boxes.size}>
              PDF
            </button>
            <button className="icon" title="Close (Esc)" onClick={onClose}>
              <Icon name="x" size={15} />
            </button>
          </div>
        </div>

        <div className="er-body">
          <aside className="er-side">
            <input
              className="er-search"
              placeholder={`Filter ${names.length} tables…`}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              spellCheck={false}
            />
            <div className="er-side-actions">
              <button className="ghost" onClick={() => setSelected(new Set([...selected, ...shown]))}>
                All
              </button>
              <button className="ghost" onClick={() => setSelected(new Set([...selected].filter((n) => !shown.includes(n))))}>
                None
              </button>
              <button className="ghost" onClick={addRelated} disabled={!selected.size} title="Add every table linked to the selected ones by a foreign key">
                + Related
              </button>
            </div>
            <label className="er-guess" title="For databases without FK constraints: link country_id → countries.id, parent_id → same table, … (drawn dashed)">
              <input type="checkbox" checked={guess} onChange={(e) => setGuessPref(e.target.checked)} />
              <span>Guess links from *_id</span>
            </label>
            <div className="er-count">
              {selected.size} of {names.length} shown · {edges.length} links
              {edges.some((e) => e.guess) ? ` (${edges.filter((e) => e.guess).length} guessed)` : ""}
            </div>
            <ul className="er-list">
              {shown.map((n) => (
                <li
                  key={n}
                  className={hover === n ? "hl" : ""}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, name: n });
                  }}
                >
                  <label>
                    <input type="checkbox" checked={selected.has(n)} onChange={() => toggle(n)} />
                    <span>{maskText(n)}</span>
                  </label>
                  {selected.has(n) && (
                    <button className="icon" title="Show in diagram" onClick={() => centerOn(n)}>
                      <Icon name="search" size={11} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </aside>

          <div
            className="er-canvas"
            ref={canvasRef}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          >
            {err && <pre className="error er-msg">{err}</pre>}
            {!err && progress && (
              <div className="er-msg">
                <Spinner size={14} /> Reading table structure… {progress.done}/{progress.total}
              </div>
            )}
            {!err && !progress && names.length > 0 && selected.size === 0 && (
              <div className="er-msg">
                {names.length} tables — tick the ones to draw on the left (+ Related adds their linked tables).
              </div>
            )}
            {!err && !progress && names.length === 0 && <div className="er-msg">This database has no tables.</div>}
            {note && <div className="er-note">{note}</div>}
            <svg ref={svgRef} className="er-svg" width="100%" height="100%">
              <rect className="er-bg" width="100%" height="100%" fill="transparent" onPointerDown={onBgDown} />
              <g className="er-world" transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
                {/* links under the tables */}
                {edges.map((e, i) => {
                  const cb = boxes.get(e.from);
                  const pb = boxes.get(e.to);
                  if (!cb || !pb) return null;
                  const ct = byName.get(e.from)!;
                  const pt = byName.get(e.to)!;
                  const p = edgePath(cb, columnY(ct, e.fromCol, mode), pb, columnY(pt, e.toCol, mode));
                  const on = !lit || (lit.has(e.from) && lit.has(e.to) && (e.from === hover || e.to === hover));
                  const col = on && lit ? "var(--accent)" : "var(--muted)";
                  const optional = ct.columns.find((c) => c.name === e.fromCol)?.nullable ?? false;
                  // Crow's foot at the child ("many"), double bar at the parent ("one").
                  const f = p.x1 + p.dir1 * 11;
                  const many = `M${f},${p.y1} L${p.x1},${p.y1 - 6} M${f},${p.y1} L${p.x1},${p.y1 + 6}`;
                  const b1 = p.x2 + p.dir2 * 6;
                  const b2 = p.x2 + p.dir2 * 10;
                  const one = `M${b1},${p.y2 - 6} L${b1},${p.y2 + 6} M${b2},${p.y2 - 6} L${b2},${p.y2 + 6}`;
                  const mk = p.x1 + p.dir1 * 15;
                  return (
                    <g
                      key={i}
                      opacity={on ? 1 : 0.18}
                      stroke={col}
                      fill="none"
                      strokeWidth={on && lit ? 1.8 : 1.2}
                      strokeDasharray={e.guess ? "5 4" : undefined}
                    >
                      <path d={p.d} />
                      <path d={many} />
                      <path d={one} />
                      {optional ? (
                        <circle cx={mk + p.dir1 * 2} cy={p.y1} r={3} fill="var(--card)" />
                      ) : (
                        <path d={`M${mk},${p.y1 - 6} L${mk},${p.y1 + 6}`} />
                      )}
                    </g>
                  );
                })}
                {tables.map((t) => {
                  const b = boxes.get(t.name);
                  if (!b) return null;
                  const cols = visibleColumns(t, mode);
                  const dim = lit && !lit.has(t.name);
                  const hl = hover === t.name || focus === t.name;
                  return (
                    <g
                      key={t.name}
                      transform={`translate(${b.x},${b.y})`}
                      opacity={dim ? 0.3 : 1}
                      className="er-node"
                      onPointerDown={(e) => onNodeDown(e, t.name)}
                      onPointerEnter={() => setHover(t.name)}
                      onPointerLeave={() => setHover((h) => (h === t.name ? null : h))}
                      onDoubleClick={() => onOpenTable?.(t.name)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setMenu({ x: e.clientX, y: e.clientY, name: t.name });
                      }}
                    >
                      <rect
                        width={b.w}
                        height={b.h}
                        rx={7}
                        fill="var(--card)"
                        stroke={hl ? "var(--accent)" : "var(--border)"}
                        strokeWidth={hl ? 2 : 1}
                      />
                      <path
                        d={`M0,7 a7,7 0 0 1 7,-7 h${b.w - 14} a7,7 0 0 1 7,7 v${HEADER_H - 7} h${-b.w} z`}
                        fill="var(--accent)"
                        opacity={0.16}
                      />
                      <text x={12} y={HEADER_H / 2 + 4.5} fontSize={12.5} fontWeight={650} fill="var(--text)" fontFamily={sans}>
                        {maskText(t.name)}
                      </text>
                      {cols.length > 0 && <line x1={0} x2={b.w} y1={HEADER_H} y2={HEADER_H} stroke="var(--border)" />}
                      {cols.map((c, i) => {
                        const y = HEADER_H + PAD_Y + i * ROW_H + ROW_H / 2 + 4;
                        return (
                          <g key={c.name}>
                            <text
                              x={10}
                              y={y}
                              fontSize={9.5}
                              fontWeight={700}
                              fill={c.pk ? "var(--warn, #d9a400)" : "var(--accent)"}
                              opacity={!c.pk && c.guess ? 0.55 : 1}
                              fontFamily={sans}
                            >
                              {c.pk ? "PK" : c.fk ? "FK" : ""}
                            </text>
                            <text x={32} y={y} fontSize={11.5} fill="var(--text)" fontFamily={mono} fontWeight={c.nullable ? 400 : 600}>
                              {c.name}
                            </text>
                            <text x={b.w - 10} y={y} fontSize={10.5} fill="var(--muted)" fontFamily={mono} textAnchor="end">
                              {c.type}
                              {c.nullable ? "?" : ""}
                            </text>
                          </g>
                        );
                      })}
                    </g>
                  );
                })}
              </g>
            </svg>
            <div className="er-hint">
              Drag to pan · ⌘/pinch-scroll to zoom · drag a table to move it · hover to trace links
              {onOpenTable ? " · double-click opens its data" : ""} · right-click a table for related tables · bold =
              NOT NULL, ? = nullable{guess ? " · dashed = guessed link" : ""}
            </div>
            {menu && (
              <>
                <div className="er-menu-shield" onPointerDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
                <ul className="ctx-menu er-menu" style={{ top: menu.y, left: menu.x }}>
                  {(() => {
                    const nb = neighbours(menu.name);
                    const missing = nb.filter((n) => !selected.has(n)).length;
                    return (
                      <>
                        <li className="er-menu-title">{maskText(menu.name)}</li>
                        <li onClick={() => showRelated(menu.name, false)}>
                          <Icon name="plus" size={13} /> Add related tables
                          <span className="ctx-kbd">{missing ? `+${missing}` : nb.length ? "all shown" : "none"}</span>
                        </li>
                        <li onClick={() => showRelated(menu.name, true)}>
                          <Icon name="layers" size={13} /> Show only this + related
                          <span className="ctx-kbd">{nb.length + 1}</span>
                        </li>
                        {selected.has(menu.name) && (
                          <li onClick={() => { setMenu(null); centerOn(menu.name); }}>
                            <Icon name="search" size={13} /> Centre in view
                          </li>
                        )}
                        {selected.has(menu.name) && (
                          <li onClick={() => hideTable(menu.name)}>
                            <Icon name="eyeOff" size={13} /> Hide from diagram
                          </li>
                        )}
                        {onOpenTable && (
                          <li onClick={() => { setMenu(null); onOpenTable(menu.name); }}>
                            <Icon name="table" size={13} /> Open data
                          </li>
                        )}
                      </>
                    );
                  })()}
                </ul>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
