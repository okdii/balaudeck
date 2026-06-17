import { useEffect, useRef, useState } from "react";
import { SshPanel } from "./SshPanel";
import { LocalPanel } from "./LocalPanel";
import { SftpPanel } from "./SftpPanel";
import { TunnelPanel } from "./TunnelPanel";
import { DbPanel } from "./DbPanel";
import { Sidebar } from "./Sidebar";
import { ProfileEditor } from "./ProfileEditor";
import { Icon, type IconName } from "./Icon";
import { api } from "./api";
import type { DbProfile, ProfileStore, SshProfile } from "./types";
import "./App.css";

type PaneKind = "local" | "ssh" | "sftp" | "tunnel" | "db";

interface Pane {
  id: string;
  kind: PaneKind;
  title: string;
  sshProfile?: SshProfile | null;
  dbProfile?: DbProfile | null;
  autoConnect?: boolean;
}

// A tab is a set of columns; each column is a top-to-bottom stack of panes.
interface Tab {
  id: string;
  columns: Pane[][];
  colSizes: number[];
  rowSizes: number[][];
}

type EditorState =
  | { kind: "ssh"; profile?: SshProfile }
  | { kind: "db"; profile?: DbProfile }
  | null;

const KIND_META: Record<PaneKind, { icon: IconName; label: string }> = {
  local: { icon: "terminal", label: "Local" },
  ssh: { icon: "server", label: "SSH" },
  sftp: { icon: "folder", label: "SFTP" },
  tunnel: { icon: "tunnel", label: "Tunnel" },
  db: { icon: "database", label: "MySQL" },
};

const GAP = 8;

function findLoc(columns: Pane[][], id: string): { c: number; r: number } | null {
  for (let c = 0; c < columns.length; c++) {
    const r = columns[c].findIndex((p) => p.id === id);
    if (r >= 0) return { c, r };
  }
  return null;
}

function flatten(tab: Tab): Pane[] {
  return tab.columns.flat();
}

function App() {
  const [store, setStore] = useState<ProfileStore>({ ssh: [], db: [] });
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(null);
  const [tabMenu, setTabMenu] = useState(false);
  const [splitFor, setSplitFor] = useState<{ paneId: string; dir: "right" | "down" } | null>(null);
  const [dragTab, setDragTab] = useState<string | null>(null);
  const [dropTab, setDropTab] = useState<string | null>(null);
  const [dropMode, setDropMode] = useState<"before" | "after" | "merge" | null>(null);
  const [dragPane, setDragPane] = useState<{ tabId: string; paneId: string } | null>(null);
  const [dropPane, setDropPane] = useState<string | null>(null);
  const [dropPanePos, setDropPanePos] = useState<"before" | "after">("after");
  const gridRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  async function reload() {
    setStore(await api.profilesLoad());
  }
  useEffect(() => {
    reload();
  }, []);

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  const paneCount = activeTab ? flatten(activeTab).length : 0;
  const layoutSig = `${activeId}:${paneCount}`;
  useEffect(() => {
    const t = setTimeout(() => window.dispatchEvent(new Event("resize")), 40);
    return () => clearTimeout(t);
  }, [layoutSig]);

  function makePane(p: Omit<Pane, "id">): Pane {
    return { ...p, id: `p${seq.current++}` };
  }

  function openTab(pane: Omit<Pane, "id">) {
    const id = `t${seq.current++}`;
    setTabs((prev) => [
      ...prev,
      { id, columns: [[makePane(pane)]], colSizes: [1], rowSizes: [[1]] },
    ]);
    setActiveId(id);
    setTabMenu(false);
  }

  function updateTab(tabId: string, fn: (t: Tab) => Tab) {
    setTabs((prev) => prev.map((t) => (t.id === tabId ? fn(t) : t)));
  }

  function splitPane(tabId: string, paneId: string, kind: PaneKind, dir: "right" | "down") {
    const pane = makePane({ kind, title: `New ${KIND_META[kind].label}` });
    updateTab(tabId, (t) => {
      const loc = findLoc(t.columns, paneId);
      if (!loc) return t;
      const columns = t.columns.map((col) => [...col]);
      const colSizes = [...t.colSizes];
      const rowSizes = t.rowSizes.map((r) => [...r]);
      if (dir === "down") {
        columns[loc.c].splice(loc.r + 1, 0, pane);
        rowSizes[loc.c].splice(loc.r + 1, 0, 1);
      } else {
        columns.splice(loc.c + 1, 0, [pane]);
        colSizes.splice(loc.c + 1, 0, 1);
        rowSizes.splice(loc.c + 1, 0, [1]);
      }
      return { ...t, columns, colSizes, rowSizes };
    });
    setSplitFor(null);
  }

  function removePaneFrom(t: Tab, paneId: string): Tab | null {
    const loc = findLoc(t.columns, paneId);
    if (!loc) return t;
    const columns = t.columns.map((col) => [...col]);
    const colSizes = [...t.colSizes];
    const rowSizes = t.rowSizes.map((r) => [...r]);
    columns[loc.c].splice(loc.r, 1);
    rowSizes[loc.c].splice(loc.r, 1);
    if (columns[loc.c].length === 0) {
      columns.splice(loc.c, 1);
      colSizes.splice(loc.c, 1);
      rowSizes.splice(loc.c, 1);
    }
    if (columns.length === 0) return null;
    return { ...t, columns, colSizes, rowSizes };
  }

  function closePane(tabId: string, paneId: string) {
    setTabs((prev) => {
      const out: Tab[] = [];
      for (const t of prev) {
        if (t.id !== tabId) {
          out.push(t);
          continue;
        }
        const next = removePaneFrom(t, paneId);
        if (next) out.push(next);
      }
      if (!out.find((t) => t.id === activeId)) {
        setActiveId(out.length ? out[out.length - 1].id : null);
      }
      return out;
    });
  }

  function detachPane(tabId: string, paneId: string) {
    const newTabId = `t${seq.current++}`;
    setTabs((prev) => {
      const src = prev.find((t) => t.id === tabId);
      const loc = src && findLoc(src.columns, paneId);
      if (!src || !loc) return prev;
      const pane = src.columns[loc.c][loc.r];
      const out: Tab[] = [];
      for (const t of prev) {
        if (t.id !== tabId) {
          out.push(t);
          continue;
        }
        const next = removePaneFrom(t, paneId);
        if (next) out.push(next);
      }
      out.push({ id: newTabId, columns: [[pane]], colSizes: [1], rowSizes: [[1]] });
      return out;
    });
    setActiveId(newTabId);
  }

  // Move a pane within a tab: drop onto another pane, inserting above/below it
  // depending on which half was targeted (reorders within a column too).
  function movePane(tabId: string, fromId: string, toId: string, position: "before" | "after") {
    if (fromId === toId) return;
    updateTab(tabId, (t) => {
      const from = findLoc(t.columns, fromId);
      if (!from) return t;
      const pane = t.columns[from.c][from.r];
      let columns = t.columns.map((col) => [...col]);
      let colSizes = [...t.colSizes];
      let rowSizes = t.rowSizes.map((r) => [...r]);
      columns[from.c].splice(from.r, 1);
      rowSizes[from.c].splice(from.r, 1);
      if (columns[from.c].length === 0) {
        columns.splice(from.c, 1);
        colSizes.splice(from.c, 1);
        rowSizes.splice(from.c, 1);
      }
      const to = findLoc(columns, toId);
      if (!to) return t;
      const insertAt = position === "before" ? to.r : to.r + 1;
      columns[to.c].splice(insertAt, 0, pane);
      rowSizes[to.c].splice(insertAt, 0, 1);
      return { ...t, columns, colSizes, rowSizes };
    });
  }

  // Drop a pane onto the right edge => move it into a brand-new last column.
  function movePaneToNewColumn(tabId: string, fromId: string) {
    updateTab(tabId, (t) => {
      const from = findLoc(t.columns, fromId);
      if (!from) return t;
      const pane = t.columns[from.c][from.r];
      let columns = t.columns.map((col) => [...col]);
      let colSizes = [...t.colSizes];
      let rowSizes = t.rowSizes.map((r) => [...r]);
      columns[from.c].splice(from.r, 1);
      rowSizes[from.c].splice(from.r, 1);
      if (columns[from.c].length === 0) {
        columns.splice(from.c, 1);
        colSizes.splice(from.c, 1);
        rowSizes.splice(from.c, 1);
      }
      columns.push([pane]);
      colSizes.push(1);
      rowSizes.push([1]);
      return { ...t, columns, colSizes, rowSizes };
    });
  }

  function reorderTabs(sourceId: string, targetId: string, position: "before" | "after") {
    setTabs((prev) => {
      const arr = [...prev];
      const from = arr.findIndex((t) => t.id === sourceId);
      if (from < 0) return prev;
      const [moved] = arr.splice(from, 1);
      let to = arr.findIndex((t) => t.id === targetId);
      if (to < 0) {
        arr.splice(from, 0, moved);
        return arr;
      }
      if (position === "after") to += 1;
      arr.splice(to, 0, moved);
      return arr;
    });
  }

  function mergeTabs(sourceId: string, targetId: string) {
    if (sourceId === targetId) return;
    setTabs((prev) => {
      const src = prev.find((t) => t.id === sourceId);
      if (!src) return prev;
      return prev
        .map((t) =>
          t.id === targetId
            ? {
                ...t,
                columns: [...t.columns, ...src.columns],
                colSizes: [...t.colSizes, ...src.colSizes],
                rowSizes: [...t.rowSizes, ...src.rowSizes],
              }
            : t,
        )
        .filter((t) => t.id !== sourceId);
    });
    setActiveId(targetId);
  }

  // Resize a column boundary (axis col) or a row boundary within a column.
  function startResize(
    axis: "col" | "row",
    colIndex: number,
    rowIndex: number,
    e: React.MouseEvent,
  ) {
    e.preventDefault();
    const grid = gridRef.current;
    if (!grid || !activeTab) return;
    const rect = grid.getBoundingClientRect();
    const tabId = activeTab.id;
    const arr =
      axis === "col" ? [...activeTab.colSizes] : [...activeTab.rowSizes[colIndex]];
    const idx = axis === "col" ? colIndex : rowIndex;
    const total = arr.reduce((a, b) => a + b, 0);
    const fullSize = axis === "col" ? rect.width : rect.height;
    const start = axis === "col" ? e.clientX : e.clientY;
    const a = arr[idx];
    const b = arr[idx + 1];
    const min = total * 0.12;

    function onMove(ev: MouseEvent) {
      const pos = axis === "col" ? ev.clientX : ev.clientY;
      const delta = ((pos - start) / fullSize) * total;
      let na = a + delta;
      let nb = b - delta;
      if (na < min) {
        nb -= min - na;
        na = min;
      }
      if (nb < min) {
        na -= min - nb;
        nb = min;
      }
      const next = [...arr];
      next[idx] = na;
      next[idx + 1] = nb;
      updateTab(tabId, (t) => {
        if (axis === "col") return { ...t, colSizes: next };
        const rowSizes = t.rowSizes.map((r) => [...r]);
        rowSizes[colIndex] = next;
        return { ...t, rowSizes };
      });
      window.dispatchEvent(new Event("resize"));
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      window.dispatchEvent(new Event("resize"));
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = axis === "col" ? "col-resize" : "row-resize";
  }

  // Compute absolute layout for the active tab's panes + gutter handles.
  const styleByPane = new Map<string, React.CSSProperties>();
  const colGutters: { c: number; left: number }[] = [];
  const rowGutters: { c: number; r: number; left: number; width: number; top: number }[] = [];
  if (activeTab) {
    const colTotal = activeTab.colSizes.reduce((a, b) => a + b, 0) || 1;
    let leftAcc = 0;
    activeTab.columns.forEach((col, c) => {
      const left = (leftAcc / colTotal) * 100;
      const width = (activeTab.colSizes[c] / colTotal) * 100;
      leftAcc += activeTab.colSizes[c];
      if (c < activeTab.columns.length - 1) colGutters.push({ c, left: (leftAcc / colTotal) * 100 });
      const rowTotal = activeTab.rowSizes[c].reduce((a, b) => a + b, 0) || 1;
      let topAcc = 0;
      col.forEach((pane, r) => {
        const top = (topAcc / rowTotal) * 100;
        const height = (activeTab.rowSizes[c][r] / rowTotal) * 100;
        topAcc += activeTab.rowSizes[c][r];
        if (r < col.length - 1) {
          rowGutters.push({ c, r, left, width, top: (topAcc / rowTotal) * 100 });
        }
        styleByPane.set(pane.id, {
          position: "absolute",
          left: `calc(${left}% + ${GAP / 2}px)`,
          top: `calc(${top}% + ${GAP / 2}px)`,
          width: `calc(${width}% - ${GAP}px)`,
          height: `calc(${height}% - ${GAP}px)`,
        });
      });
    });
  }

  const allPanes = tabs.flatMap((t) =>
    t.columns.flatMap((col) => col.map((pane) => ({ pane, tabId: t.id }))),
  );

  const sshTitle = (p: SshProfile) => p.name || `${p.user}@${p.host}`;
  const dbTitle = (p: DbProfile) => p.name || p.database || `${p.user}@${p.host}`;
  const tabLabel = (t: Tab) => {
    const flat = flatten(t);
    return flat[0].title + (flat.length > 1 ? ` +${flat.length - 1}` : "");
  };

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">termdb</span>
        <span className="brand-sub">SSH · SFTP · Tunnel · DB</span>
      </header>
      <div className="app">
        <Sidebar
          store={store}
          onSelectSsh={(p) =>
            openTab({ kind: "ssh", title: sshTitle(p), sshProfile: p, autoConnect: true })
          }
          onSelectDb={(p) => openTab({ kind: "db", title: dbTitle(p), dbProfile: p })}
          onEditSsh={(p) => setEditor({ kind: "ssh", profile: p })}
          onEditDb={(p) => setEditor({ kind: "db", profile: p })}
          onDeleteSsh={async (p) => {
            await api.sshProfileDelete(p.id);
            reload();
          }}
          onDeleteDb={async (p) => {
            await api.dbProfileDelete(p.id);
            reload();
          }}
          onNewSsh={() => setEditor({ kind: "ssh" })}
          onNewDb={() => setEditor({ kind: "db" })}
        />

        <main className="main">
          <div className="tabbar">
            {tabs.map((t) => (
              <div
                key={t.id}
                className={
                  "tab" +
                  (t.id === activeId ? " active" : "") +
                  (t.id === dropTab && dropMode === "merge" ? " drop" : "") +
                  (t.id === dropTab && dropMode === "before" ? " insert-before" : "") +
                  (t.id === dropTab && dropMode === "after" ? " insert-after" : "")
                }
                draggable
                onClick={() => setActiveId(t.id)}
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", t.id);
                  e.dataTransfer.effectAllowed = "move";
                  setDragTab(t.id);
                }}
                onDragEnd={() => {
                  setDragTab(null);
                  setDropTab(null);
                  setDropMode(null);
                }}
                onDragOver={(e) => {
                  if (!dragTab || dragTab === t.id) return;
                  e.preventDefault();
                  const rect = e.currentTarget.getBoundingClientRect();
                  const x = e.clientX - rect.left;
                  const mode =
                    x < rect.width * 0.3 ? "before" : x > rect.width * 0.7 ? "after" : "merge";
                  setDropTab(t.id);
                  setDropMode(mode);
                }}
                onDragLeave={() =>
                  setDropTab((d) => {
                    if (d === t.id) {
                      setDropMode(null);
                      return null;
                    }
                    return d;
                  })
                }
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragTab && dragTab !== t.id) {
                    if (dropMode === "merge") mergeTabs(dragTab, t.id);
                    else if (dropMode) reorderTabs(dragTab, t.id, dropMode);
                  }
                  setDragTab(null);
                  setDropTab(null);
                  setDropMode(null);
                }}
                title="Drag to reorder · drop on centre to merge as split"
              >
                <Icon name={KIND_META[flatten(t)[0].kind].icon} size={14} className="tab-icon" />
                <span className="tab-title">{tabLabel(t)}</span>
                <button
                  className="tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    setTabs((prev) => {
                      const idx = prev.findIndex((x) => x.id === t.id);
                      const next = prev.filter((x) => x.id !== t.id);
                      if (activeId === t.id) {
                        const fb = next[idx] ?? next[idx - 1];
                        setActiveId(fb ? fb.id : null);
                      }
                      return next;
                    });
                  }}
                >
                  <Icon name="x" size={13} />
                </button>
              </div>
            ))}
            <div className="tab-add-wrap">
              <button className="tab-add" title="New session" onClick={() => setTabMenu((v) => !v)}>
                <Icon name="plus" size={16} />
              </button>
              {tabMenu && (
                <div className="tab-menu" onMouseLeave={() => setTabMenu(false)}>
                  {(Object.keys(KIND_META) as PaneKind[]).map((k) => (
                    <button
                      key={k}
                      onClick={() => openTab({ kind: k, title: `New ${KIND_META[k].label}` })}
                    >
                      <Icon name={KIND_META[k].icon} size={15} /> New {KIND_META[k].label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="tab-content">
            {tabs.length === 0 && (
              <div className="empty-tabs">
                <div className="empty-glyph">›_</div>
                <p>Select a host on the left, or press + to open a session.</p>
                <p className="hint">
                  Split panes with the ⊞/▤ buttons, drag a pane by its header to rearrange, or drag
                  a tab onto another to merge.
                </p>
              </div>
            )}
            <div
              ref={gridRef}
              className="pane-area"
              style={{ display: tabs.length ? "block" : "none" }}
            >
              {activeTab &&
                colGutters.map((g) => (
                  <div
                    key={"gc" + g.c}
                    className="gutter gutter-col"
                    style={{ left: `${g.left}%`, top: 0, bottom: 0 }}
                    onMouseDown={(e) => startResize("col", g.c, 0, e)}
                  />
                ))}
              {activeTab &&
                rowGutters.map((g) => (
                  <div
                    key={"gr" + g.c + "-" + g.r}
                    className="gutter gutter-row"
                    style={{ left: `${g.left}%`, width: `${g.width}%`, top: `${g.top}%` }}
                    onMouseDown={(e) => startResize("row", g.c, g.r, e)}
                  />
                ))}
              {activeTab && dragPane && dragPane.tabId === activeId && (
                <div
                  className="edge-drop"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    movePaneToNewColumn(activeId!, dragPane.paneId);
                    setDragPane(null);
                    setDropPane(null);
                  }}
                />
              )}
              {allPanes.map(({ pane: p, tabId }) => {
                const active = tabId === activeId;
                return (
                  <section
                    key={p.id}
                    className={
                      "pane" +
                      (dropPane === p.id ? (dropPanePos === "before" ? " drop-before" : " drop-after") : "")
                    }
                    style={active ? styleByPane.get(p.id) : { display: "none" }}
                    onDragOver={(e) => {
                      if (dragPane && dragPane.tabId === tabId && dragPane.paneId !== p.id) {
                        e.preventDefault();
                        const rect = e.currentTarget.getBoundingClientRect();
                        const pos = e.clientY - rect.top < rect.height / 2 ? "before" : "after";
                        setDropPane(p.id);
                        setDropPanePos(pos);
                      }
                    }}
                    onDragLeave={() => setDropPane((d) => (d === p.id ? null : d))}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragPane && dragPane.tabId === tabId)
                        movePane(tabId, dragPane.paneId, p.id, dropPanePos);
                      setDragPane(null);
                      setDropPane(null);
                    }}
                  >
                    <div
                      className="pane-head"
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", p.id);
                        e.dataTransfer.effectAllowed = "move";
                        setDragPane({ tabId, paneId: p.id });
                      }}
                      onDragEnd={() => {
                        setDragPane(null);
                        setDropPane(null);
                      }}
                      title="Drag to rearrange"
                    >
                      <Icon name={KIND_META[p.kind].icon} size={14} className="tab-icon" />
                      <span className="pane-title">{p.title}</span>
                      <div className="pane-actions">
                        <button
                          className="icon"
                          title="Split right"
                          onClick={() =>
                            setSplitFor(
                              splitFor?.paneId === p.id && splitFor.dir === "right"
                                ? null
                                : { paneId: p.id, dir: "right" },
                            )
                          }
                        >
                          <Icon name="split" size={15} />
                        </button>
                        <button
                          className="icon"
                          title="Split down"
                          onClick={() =>
                            setSplitFor(
                              splitFor?.paneId === p.id && splitFor.dir === "down"
                                ? null
                                : { paneId: p.id, dir: "down" },
                            )
                          }
                        >
                          <Icon name="splitDown" size={15} />
                        </button>
                        <button
                          className="icon"
                          title="Detach to new tab"
                          onClick={() => detachPane(tabId, p.id)}
                        >
                          <Icon name="detach" size={14} />
                        </button>
                        <button
                          className="icon"
                          title="Close pane"
                          onClick={() => closePane(tabId, p.id)}
                        >
                          <Icon name="x" size={14} />
                        </button>
                        {splitFor?.paneId === p.id && (
                          <div className="tab-menu pane-menu" onMouseLeave={() => setSplitFor(null)}>
                            {(Object.keys(KIND_META) as PaneKind[]).map((k) => (
                              <button key={k} onClick={() => splitPane(tabId, p.id, k, splitFor.dir)}>
                                <Icon name={KIND_META[k].icon} size={15} />{" "}
                                {splitFor.dir === "right" ? "Right" : "Down"}: {KIND_META[k].label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    <div
                      className={"pane-body" + (p.kind === "ssh" || p.kind === "local" ? " flush" : "")}
                    >
                      {p.kind === "local" && <LocalPanel />}
                      {p.kind === "ssh" && <SshPanel prefill={p.sshProfile} autoConnect={p.autoConnect} />}
                      {p.kind === "sftp" && <SftpPanel prefill={p.sshProfile} />}
                      {p.kind === "tunnel" && <TunnelPanel sshProfiles={store.ssh} />}
                      {p.kind === "db" && <DbPanel prefill={p.dbProfile} sshProfiles={store.ssh} />}
                    </div>
                  </section>
                );
              })}
            </div>
          </div>
        </main>
      </div>

      {editor && (
        <ProfileEditor
          kind={editor.kind}
          initial={editor.profile}
          sshProfiles={store.ssh}
          onClose={() => setEditor(null)}
          onSaved={reload}
        />
      )}
    </div>
  );
}

export default App;
