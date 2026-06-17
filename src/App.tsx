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

interface Tab {
  id: string;
  panes: Pane[];
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

interface Cell {
  column: string;
  row: string;
}
interface Layout {
  columns: number;
  rows: number;
  cells: Cell[];
}

// Tiling layout per pane count. Odd counts let the last column span full height
// so there is no empty bottom cell.
function gridLayout(n: number): Layout {
  switch (n) {
    case 0:
    case 1:
      return { columns: 1, rows: 1, cells: [{ column: "1", row: "1" }] };
    case 2:
      return { columns: 2, rows: 1, cells: [{ column: "1", row: "1" }, { column: "2", row: "1" }] };
    case 3:
      return {
        columns: 2,
        rows: 2,
        cells: [
          { column: "1", row: "1" },
          { column: "2", row: "1 / 3" },
          { column: "1", row: "2" },
        ],
      };
    case 4:
      return {
        columns: 2,
        rows: 2,
        cells: [
          { column: "1", row: "1" },
          { column: "2", row: "1" },
          { column: "1", row: "2" },
          { column: "2", row: "2" },
        ],
      };
    case 5:
      return {
        columns: 3,
        rows: 2,
        cells: [
          { column: "1", row: "1" },
          { column: "2", row: "1" },
          { column: "3", row: "1 / 3" },
          { column: "1", row: "2" },
          { column: "2", row: "2" },
        ],
      };
    default:
      return {
        columns: 3,
        rows: 2,
        cells: [
          { column: "1", row: "1" },
          { column: "2", row: "1" },
          { column: "3", row: "1" },
          { column: "1", row: "2" },
          { column: "2", row: "2" },
          { column: "3", row: "2" },
        ],
      };
  }
}

function App() {
  const [store, setStore] = useState<ProfileStore>({ ssh: [], db: [] });
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(null);
  const [tabMenu, setTabMenu] = useState(false);
  const [splitFor, setSplitFor] = useState<string | null>(null); // pane id
  const [dragTab, setDragTab] = useState<string | null>(null);
  const [dropTab, setDropTab] = useState<string | null>(null);
  const [dropMode, setDropMode] = useState<"before" | "after" | "merge" | null>(null);
  const [dragPane, setDragPane] = useState<{ tabId: string; paneId: string } | null>(null);
  const [dropPane, setDropPane] = useState<string | null>(null);
  const [paneSizes, setPaneSizes] = useState<Record<string, { cols: number[]; rows: number[] }>>({});
  const gridRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  async function reload() {
    setStore(await api.profilesLoad());
  }
  useEffect(() => {
    reload();
  }, []);

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;

  const layoutSig = `${activeId}:${activeTab?.panes.length ?? 0}`;
  useEffect(() => {
    const t = setTimeout(() => window.dispatchEvent(new Event("resize")), 40);
    return () => clearTimeout(t);
  }, [layoutSig]);

  function makePane(p: Omit<Pane, "id">): Pane {
    return { ...p, id: `p${seq.current++}` };
  }

  function openTab(pane: Omit<Pane, "id">) {
    const id = `t${seq.current++}`;
    setTabs((prev) => [...prev, { id, panes: [makePane(pane)] }]);
    setActiveId(id);
    setTabMenu(false);
  }

  function splitPane(tabId: string, kind: PaneKind) {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId
          ? { ...t, panes: [...t.panes, makePane({ kind, title: `New ${KIND_META[kind].label}` })] }
          : t,
      ),
    );
    setSplitFor(null);
  }

  function closePane(tabId: string, paneId: string) {
    setTabs((prev) => {
      const next = prev
        .map((t) => (t.id === tabId ? { ...t, panes: t.panes.filter((p) => p.id !== paneId) } : t))
        .filter((t) => t.panes.length > 0);
      if (!next.find((t) => t.id === activeId)) {
        setActiveId(next.length ? next[next.length - 1].id : null);
      }
      return next;
    });
  }

  // Pop a pane out into its own new tab. Pane id is preserved so the live
  // session is not remounted (panes are rendered in one flat grid).
  function detachPane(tabId: string, paneId: string) {
    const newTabId = `t${seq.current++}`;
    setTabs((prev) => {
      const src = prev.find((t) => t.id === tabId);
      const pane = src?.panes.find((p) => p.id === paneId);
      if (!pane) return prev;
      const updated = prev
        .map((t) => (t.id === tabId ? { ...t, panes: t.panes.filter((p) => p.id !== paneId) } : t))
        .filter((t) => t.panes.length > 0);
      updated.push({ id: newTabId, panes: [pane] });
      return updated;
    });
    setActiveId(newTabId);
  }

  function closeTab(id: string) {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      if (activeId === id) {
        const fallback = next[idx] ?? next[idx - 1];
        setActiveId(fallback ? fallback.id : null);
      }
      return next;
    });
  }

  // Move a tab before/after another tab in the tab bar.
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

  // Drag a tab onto the centre of another tab to merge its panes in as splits.
  function mergeTabs(sourceId: string, targetId: string) {
    if (sourceId === targetId) return;
    setTabs((prev) => {
      const src = prev.find((t) => t.id === sourceId);
      if (!src) return prev;
      return prev
        .map((t) => (t.id === targetId ? { ...t, panes: [...t.panes, ...src.panes] } : t))
        .filter((t) => t.id !== sourceId);
    });
    setActiveId(targetId);
  }

  // Drag a pane (by its header) onto another pane in the same tab to reorder.
  function reorderPanes(tabId: string, fromId: string, toId: string) {
    if (fromId === toId) return;
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== tabId) return t;
        const arr = [...t.panes];
        const from = arr.findIndex((p) => p.id === fromId);
        const to = arr.findIndex((p) => p.id === toId);
        if (from < 0 || to < 0) return t;
        const [moved] = arr.splice(from, 1);
        arr.splice(to, 0, moved);
        return { ...t, panes: arr };
      }),
    );
  }

  const layout = gridLayout(activeTab?.panes.length ?? 0);
  const cellByPane = new Map<string, Cell>();
  activeTab?.panes.forEach((p, i) => {
    if (layout.cells[i]) cellByPane.set(p.id, layout.cells[i]);
  });

  // Resizable track sizes (fractions) for the active tab's grid.
  const stored = activeId ? paneSizes[activeId] : undefined;
  const effCols =
    stored && stored.cols.length === layout.columns ? stored.cols : Array(layout.columns).fill(1);
  const effRows =
    stored && stored.rows.length === layout.rows ? stored.rows : Array(layout.rows).fill(1);

  function startResize(axis: "col" | "row", index: number, e: React.MouseEvent) {
    e.preventDefault();
    const grid = gridRef.current;
    if (!grid || !activeId) return;
    const rect = grid.getBoundingClientRect();
    const arr = axis === "col" ? [...effCols] : [...effRows];
    const total = arr.reduce((a, b) => a + b, 0);
    const size = axis === "col" ? rect.width : rect.height;
    const start = axis === "col" ? e.clientX : e.clientY;
    const a = arr[index];
    const b = arr[index + 1];
    const min = total * 0.12;
    const tabId = activeId;
    const otherCols = [...effCols];
    const otherRows = [...effRows];

    function onMove(ev: MouseEvent) {
      const pos = axis === "col" ? ev.clientX : ev.clientY;
      const delta = ((pos - start) / size) * total;
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
      next[index] = na;
      next[index + 1] = nb;
      setPaneSizes((s) => ({
        ...s,
        [tabId]:
          axis === "col" ? { cols: next, rows: otherRows } : { cols: otherCols, rows: next },
      }));
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

  const colTotal = effCols.reduce((a, b) => a + b, 0);
  const rowTotal = effRows.reduce((a, b) => a + b, 0);
  const boundary = (arr: number[], total: number, k: number) => {
    let s = 0;
    for (let i = 0; i <= k; i++) s += arr[i];
    return (s / total) * 100;
  };

  const sshTitle = (p: SshProfile) => p.name || `${p.user}@${p.host}`;
  const dbTitle = (p: DbProfile) => p.name || p.database || `${p.user}@${p.host}`;
  const tabLabel = (t: Tab) =>
    t.panes[0].title + (t.panes.length > 1 ? ` +${t.panes.length - 1}` : "");

  // Flat list of every pane (keyed by pane id) so moving a pane between tabs
  // only toggles its visibility instead of remounting the live session.
  const allPanes = tabs.flatMap((t) => t.panes.map((pane) => ({ pane, tabId: t.id })));

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
                onDragStart={() => setDragTab(t.id)}
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
                <Icon name={KIND_META[t.panes[0].kind].icon} size={14} className="tab-icon" />
                <span className="tab-title">{tabLabel(t)}</span>
                <button
                  className="tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.id);
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
                  Split a tab with ⊞ to view sessions side by side, or drag a tab onto another to
                  merge them.
                </p>
              </div>
            )}
            <div
              ref={gridRef}
              className="pane-grid"
              style={{
                display: tabs.length ? "grid" : "none",
                gridTemplateColumns: effCols.map((f) => `${f}fr`).join(" "),
                gridTemplateRows: effRows.map((f) => `${f}fr`).join(" "),
              }}
            >
              {tabs.length > 0 &&
                Array.from({ length: layout.columns - 1 }).map((_, k) => (
                  <div
                    key={"gc" + k}
                    className="gutter gutter-col"
                    style={{ left: `${boundary(effCols, colTotal, k)}%` }}
                    onMouseDown={(e) => startResize("col", k, e)}
                  />
                ))}
              {tabs.length > 0 &&
                Array.from({ length: layout.rows - 1 }).map((_, j) => (
                  <div
                    key={"gr" + j}
                    className="gutter gutter-row"
                    style={{ top: `${boundary(effRows, rowTotal, j)}%` }}
                    onMouseDown={(e) => startResize("row", j, e)}
                  />
                ))}
              {allPanes.map(({ pane: p, tabId }) => {
                const cell = cellByPane.get(p.id);
                const active = tabId === activeId;
                return (
                <section
                  key={p.id}
                  className={"pane" + (dropPane === p.id ? " drop-pane" : "")}
                  style={
                    active
                      ? { display: "flex", gridColumn: cell?.column, gridRow: cell?.row }
                      : { display: "none" }
                  }
                  onDragOver={(e) => {
                    if (dragPane && dragPane.tabId === tabId && dragPane.paneId !== p.id) {
                      e.preventDefault();
                      setDropPane(p.id);
                    }
                  }}
                  onDragLeave={() => setDropPane((d) => (d === p.id ? null : d))}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragPane && dragPane.tabId === tabId) reorderPanes(tabId, dragPane.paneId, p.id);
                    setDragPane(null);
                    setDropPane(null);
                  }}
                >
                  <div
                    className="pane-head"
                    draggable
                    onDragStart={() => setDragPane({ tabId, paneId: p.id })}
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
                        title="Split this tab"
                        onClick={() => setSplitFor(splitFor === p.id ? null : p.id)}
                      >
                        <Icon name="split" size={15} />
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
                      {splitFor === p.id && (
                        <div className="tab-menu pane-menu" onMouseLeave={() => setSplitFor(null)}>
                          {(Object.keys(KIND_META) as PaneKind[]).map((k) => (
                            <button key={k} onClick={() => splitPane(tabId, k)}>
                              <Icon name={KIND_META[k].icon} size={15} /> Split: {KIND_META[k].label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="pane-body">
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
