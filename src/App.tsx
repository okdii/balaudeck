import { useEffect, useRef, useState } from "react";
import { SshPanel } from "./SshPanel";
import { LocalPanel } from "./LocalPanel";
import { SftpPanel } from "./SftpPanel";
import { TunnelPanel } from "./TunnelPanel";
import { DbPanel } from "./DbPanel";
import { Sidebar } from "./Sidebar";
import { ProfileEditor } from "./ProfileEditor";
import { SyncModal } from "./SyncModal";
import { Icon, type IconName } from "./Icon";
import { api } from "./api";
import type {
  ConnKind,
  DbProfile,
  ProfileStore,
  SftpProfile,
  SshProfile,
  TunnelProfile,
} from "./types";
import "./App.css";

type PaneKind = "local" | "ssh" | "sftp" | "tunnel" | "db";

interface Pane {
  id: string;
  kind: PaneKind;
  title: string;
  sshProfile?: SshProfile | null;
  dbProfile?: DbProfile | null;
  sftpProfile?: SftpProfile | null;
  tunnelProfile?: TunnelProfile | null;
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
  | { kind: "sftp"; profile?: SftpProfile }
  | { kind: "tunnel"; profile?: TunnelProfile }
  | null;

const KIND_META: Record<PaneKind, { icon: IconName; label: string }> = {
  local: { icon: "terminal", label: "Local" },
  ssh: { icon: "server", label: "SSH" },
  sftp: { icon: "sftp", label: "SFTP" },
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
  const [store, setStore] = useState<ProfileStore>({
    ssh: [],
    db: [],
    sftp: [],
    tunnel: [],
    folders: [],
    queries: [],
  });
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [tabMenu, setTabMenu] = useState(false);
  const [tabMenuPos, setTabMenuPos] = useState<{ top: number; left: number } | null>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("sidebarCollapsed") === "1",
  );
  function toggleSidebar() {
    if (window.matchMedia("(max-width: 760px)").matches) {
      setSidebarOpen((v) => !v);
    } else {
      setSidebarCollapsed((v) => {
        localStorage.setItem("sidebarCollapsed", v ? "0" : "1");
        return !v;
      });
    }
  }
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const v = Number(localStorage.getItem("balaudeck.sidebarWidth"));
    return v >= 180 && v <= 560 ? v : 256;
  });
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [splitFor, setSplitFor] = useState<{ paneId: string; dir: "right" | "down" } | null>(null);
  const [dragTab, setDragTab] = useState<string | null>(null);
  const [dropTab, setDropTab] = useState<string | null>(null);
  const [dropMode, setDropMode] = useState<"before" | "after" | "merge" | null>(null);
  const [dragPane, setDragPane] = useState<{ tabId: string; paneId: string } | null>(null);
  const [dropPane, setDropPane] = useState<string | null>(null);
  const [dropPanePos, setDropPanePos] = useState<"before" | "after">("after");
  // Live SSH identity of a connected pane (saved profile or manual), so a split
  // can inherit the original pane's connection.
  const [paneConn, setPaneConn] = useState<Record<string, SshProfile>>({});
  // Connection label shown in each pane's title bar + a per-pane disconnect signal.
  const [paneSession, setPaneSession] = useState<Record<string, string>>({});
  const [paneDc, setPaneDc] = useState<Record<string, number>>({});
  const setSession = (id: string, label: string) =>
    setPaneSession((m) => (m[id] === label ? m : { ...m, [id]: label }));
  const requestDisconnect = (id: string) => setPaneDc((m) => ({ ...m, [id]: (m[id] || 0) + 1 }));
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

  function openEditor(state: EditorState) {
    setEditor(state);
    setSidebarOpen(false); // hide the drawer behind the dialog on mobile
  }

  // Drag the sidebar's right edge to resize it; width persists across launches.
  function startSidebarResize(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    setSidebarResizing(true);
    function onMove(ev: MouseEvent) {
      const w = Math.min(560, Math.max(180, startW + (ev.clientX - startX)));
      setSidebarWidth(w);
      window.dispatchEvent(new Event("resize"));
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      setSidebarResizing(false);
      setSidebarWidth((w) => {
        localStorage.setItem("balaudeck.sidebarWidth", String(Math.round(w)));
        return w;
      });
      window.dispatchEvent(new Event("resize"));
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
  }

  function updateTab(tabId: string, fn: (t: Tab) => Tab) {
    setTabs((prev) => prev.map((t) => (t.id === tabId ? fn(t) : t)));
  }

  function splitPane(tabId: string, paneId: string, kind: PaneKind, dir: "right" | "down") {
    // Inherit the source pane's SSH identity / DB profile where it makes sense.
    const tab = tabs.find((t) => t.id === tabId);
    const loc = tab ? findLoc(tab.columns, paneId) : null;
    const srcPane = tab && loc ? tab.columns[loc.c][loc.r] : null;
    const inheritedSsh = paneConn[paneId] ?? srcPane?.sshProfile ?? null;

    let data: Omit<Pane, "id">;
    const title = `New ${KIND_META[kind].label}`;
    if (kind === "ssh") {
      data = { kind, title, sshProfile: inheritedSsh, autoConnect: !!inheritedSsh?.id };
    } else if (kind === "sftp" || kind === "tunnel") {
      data = { kind, title, sshProfile: inheritedSsh };
    } else if (kind === "db") {
      data = { kind, title, dbProfile: srcPane?.dbProfile ?? null };
    } else {
      data = { kind, title };
    }

    const pane = makePane(data);
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
  const connTitle = (p: { name: string; user: string; host: string }) =>
    p.name || `${p.user}@${p.host}`;

  function selectProfile(kind: ConnKind, id: string) {
    if (kind === "ssh") {
      const p = store.ssh.find((x) => x.id === id);
      if (p) openTab({ kind: "ssh", title: sshTitle(p), sshProfile: p, autoConnect: true });
    } else if (kind === "sftp") {
      const p = store.sftp.find((x) => x.id === id);
      if (p) openTab({ kind: "sftp", title: connTitle(p), sftpProfile: p, autoConnect: true });
    } else if (kind === "tunnel") {
      const p = store.tunnel.find((x) => x.id === id);
      if (p) openTab({ kind: "tunnel", title: connTitle(p), tunnelProfile: p });
    } else {
      const p = store.db.find((x) => x.id === id);
      if (p) openTab({ kind: "db", title: dbTitle(p), dbProfile: p });
    }
    setSidebarOpen(false);
  }

  function editProfile(kind: ConnKind, id: string) {
    if (kind === "ssh") openEditor({ kind, profile: store.ssh.find((x) => x.id === id) });
    else if (kind === "sftp") openEditor({ kind, profile: store.sftp.find((x) => x.id === id) });
    else if (kind === "tunnel")
      openEditor({ kind, profile: store.tunnel.find((x) => x.id === id) });
    else openEditor({ kind, profile: store.db.find((x) => x.id === id) });
  }

  async function deleteProfile(kind: ConnKind, id: string) {
    if (kind === "ssh") await api.sshProfileDelete(id);
    else if (kind === "sftp") await api.sftpProfileDelete(id);
    else if (kind === "tunnel") await api.tunnelProfileDelete(id);
    else await api.dbProfileDelete(id);
    reload();
  }
  const tabLabel = (t: Tab) => {
    const flat = flatten(t);
    return flat[0].title + (flat.length > 1 ? ` +${flat.length - 1}` : "");
  };

  return (
    <div className="shell">
      <header className="topbar">
        <button className="menu-toggle" title="Collapse / expand sidebar" onClick={toggleSidebar}>
          <Icon name="menu" size={20} />
        </button>
        <svg className="brand-mark" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
          <rect width="24" height="24" rx="6" fill="#20242a" />
          <path
            d="M7 8 L12 12 L7 16"
            fill="none"
            stroke="#5fbf57"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <rect x="13" y="13.4" width="5.6" height="2.4" rx="1.2" fill="#4ba4e3" />
        </svg>
        <span className="brand">BalauDeck</span>
        <span className="brand-sub">SSH · SFTP · Tunnel · DB</span>
      </header>
      <div className={"app" + (sidebarCollapsed ? " sidebar-collapsed" : "")}>
        {sidebarOpen && (
          <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />
        )}
        <Sidebar
          open={sidebarOpen}
          width={sidebarWidth}
          store={store}
          onSelect={selectProfile}
          onEdit={editProfile}
          onDelete={deleteProfile}
          onNew={(kind) => openEditor({ kind })}
          onNewFolder={async () => {
            const f = await api.folderCreate("New Folder");
            await reload();
            return f;
          }}
          onRenameFolder={async (id, name) => {
            await api.folderRename(id, name);
            reload();
          }}
          onDeleteFolder={async (id) => {
            await api.folderDelete(id);
            reload();
          }}
          onMoveProfile={async (kind, id, folderId) => {
            await api.profileSetFolder(kind, id, folderId);
            reload();
          }}
          onMoveFolder={async (id, parentId, beforeId) => {
            await api.folderMove(id, parentId, beforeId);
            reload();
          }}
          onSync={() => {
            setSyncOpen(true);
            setSidebarOpen(false);
          }}
        />
        <div
          className={"sidebar-resizer" + (sidebarResizing ? " dragging" : "")}
          title="Drag to resize sidebar"
          onMouseDown={startSidebarResize}
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
              <button
                ref={addBtnRef}
                className="tab-add"
                title="New session"
                onClick={() => {
                  if (tabMenu) {
                    setTabMenu(false);
                    return;
                  }
                  const r = addBtnRef.current?.getBoundingClientRect();
                  if (r) setTabMenuPos({ top: r.bottom + 4, left: r.left });
                  setTabMenu(true);
                }}
              >
                <Icon name="plus" size={16} />
              </button>
            </div>
          </div>

          <div className="tab-content">
            {tabs.length === 0 && (
              <div className="empty-tabs">
                <svg className="empty-logo" width="92" height="92" viewBox="0 0 1024 1024" aria-hidden="true">
                  <defs>
                    <linearGradient id="eg-bg" x1="0" y1="0" x2="0" y2="1024" gradientUnits="userSpaceOnUse">
                      <stop offset="0" stopColor="#2d323a" />
                      <stop offset="1" stopColor="#15181c" />
                    </linearGradient>
                    <linearGradient id="eg-wood" x1="0" y1="712" x2="0" y2="788" gradientUnits="userSpaceOnUse">
                      <stop offset="0" stopColor="#e2ab59" />
                      <stop offset="0.16" stopColor="#cf8d38" />
                      <stop offset="1" stopColor="#a6671f" />
                    </linearGradient>
                  </defs>
                  <rect width="1024" height="1024" rx="224" fill="url(#eg-bg)" />
                  <rect x="212" y="246" width="600" height="452" rx="30" fill="#ffffff" fillOpacity="0.03" stroke="#5d646e" strokeWidth="3" strokeOpacity="0.7" />
                  <circle cx="280" cy="314" r="15" fill="#ec6a5e" />
                  <circle cx="332" cy="314" r="15" fill="#f3bf4f" />
                  <circle cx="384" cy="314" r="15" fill="#61c655" />
                  <path d="M300 430 L396 488 L300 546" fill="none" stroke="#5fbf57" strokeWidth="38" strokeLinecap="round" strokeLinejoin="round" />
                  <rect x="424" y="470" width="118" height="36" rx="18" fill="#4ba4e3" />
                  <rect x="300" y="600" width="250" height="30" rx="15" fill="#889099" />
                  <rect x="176" y="712" width="672" height="76" rx="12" fill="url(#eg-wood)" />
                  <rect x="176" y="712" width="672" height="10" rx="7" fill="#eebf73" fillOpacity="0.45" />
                  <g stroke="#8a561d" strokeWidth="3" strokeOpacity="0.65" strokeLinecap="round">
                    <line x1="344" y1="718" x2="344" y2="782" />
                    <line x1="512" y1="718" x2="512" y2="782" />
                    <line x1="680" y1="718" x2="680" y2="782" />
                  </g>
                </svg>
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
                      {paneSession[p.id] ? (
                        <span className="pane-title connected">
                          <span className="dot ok" /> {paneSession[p.id]}
                        </span>
                      ) : (
                        <span className="pane-title">{p.title}</span>
                      )}
                      <div className="pane-actions">
                        {paneSession[p.id] && (
                          <button
                            className="icon pane-disconnect"
                            title="Disconnect"
                            onClick={() => requestDisconnect(p.id)}
                          >
                            <Icon name="power" size={14} />
                          </button>
                        )}
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
                      {p.kind === "ssh" && (
                        <SshPanel
                          prefill={p.sshProfile}
                          autoConnect={p.autoConnect}
                          sshProfiles={store.ssh}
                          onConnInfo={(info) => setPaneConn((m) => ({ ...m, [p.id]: info }))}
                          onSession={(label) => setSession(p.id, label)}
                          dcSignal={paneDc[p.id] || 0}
                        />
                      )}
                      {p.kind === "sftp" && (
                        <SftpPanel
                          prefill={p.sftpProfile ?? p.sshProfile}
                          autoConnect={p.autoConnect}
                          sftpProfiles={store.sftp}
                          sshProfiles={store.ssh}
                          onConnInfo={(info) => setPaneConn((m) => ({ ...m, [p.id]: info }))}
                          onSession={(label) => setSession(p.id, label)}
                          dcSignal={paneDc[p.id] || 0}
                        />
                      )}
                      {p.kind === "tunnel" && (
                        <TunnelPanel
                          tunnelProfiles={store.tunnel}
                          sshProfiles={store.ssh}
                          prefill={p.tunnelProfile}
                          sshPrefill={p.sshProfile}
                        />
                      )}
                      {p.kind === "db" && (
                        <DbPanel
                          prefill={p.dbProfile}
                          sshProfiles={store.ssh}
                          dbProfiles={store.db}
                          savedQueries={store.queries}
                          onQueriesChanged={reload}
                          onSession={(label) => setSession(p.id, label)}
                          dcSignal={paneDc[p.id] || 0}
                        />
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          </div>
        </main>
      </div>

      {tabMenu && tabMenuPos && (
        <>
          <div className="menu-backdrop" onClick={() => setTabMenu(false)} />
          <div
            className="tab-menu tab-menu-fixed"
            style={{ top: tabMenuPos.top, left: tabMenuPos.left }}
          >
            {(Object.keys(KIND_META) as PaneKind[]).map((k) => (
              <button
                key={k}
                onClick={() => openTab({ kind: k, title: `New ${KIND_META[k].label}` })}
              >
                <Icon name={KIND_META[k].icon} size={15} /> New {KIND_META[k].label}
              </button>
            ))}
          </div>
        </>
      )}

      {editor && (
        <ProfileEditor
          kind={editor.kind}
          initial={editor.profile}
          sshProfiles={store.ssh}
          folders={store.folders}
          onClose={() => setEditor(null)}
          onSaved={reload}
        />
      )}

      {syncOpen && (
        <SyncModal onClose={() => setSyncOpen(false)} onImported={reload} />
      )}
    </div>
  );
}

export default App;
