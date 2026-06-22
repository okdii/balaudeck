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
import { getCurrentWindow } from "@tauri-apps/api/window";
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

// The layout of a tab is a recursive split tree: a leaf holds one pane; a split
// arranges its children either left-to-right ("row", vertical gutters) or
// top-to-bottom ("col", horizontal gutters), sized by flex weights. This lets a
// single pane be subdivided in place without disturbing its siblings.
type LayoutNode =
  | { type: "pane"; pane: Pane }
  | { type: "split"; dir: "row" | "col"; sizes: number[]; children: LayoutNode[] };

interface Tab {
  id: string;
  root: LayoutNode;
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


// ---- Layout-tree helpers (pure / immutable) ----

function flattenNodes(node: LayoutNode): Pane[] {
  return node.type === "pane" ? [node.pane] : node.children.flatMap(flattenNodes);
}

// Path = child indices from the root down to a node.
function findPath(node: LayoutNode, id: string, path: number[] = []): number[] | null {
  if (node.type === "pane") return node.pane.id === id ? path : null;
  for (let i = 0; i < node.children.length; i++) {
    const r = findPath(node.children[i], id, [...path, i]);
    if (r) return r;
  }
  return null;
}

function nodeAt(root: LayoutNode, path: number[]): LayoutNode {
  let n = root;
  for (const i of path) {
    if (n.type !== "split") break;
    n = n.children[i];
  }
  return n;
}

// Immutably replace the node reached by `path` with `fn`'s result.
function updateAtPath(
  root: LayoutNode,
  path: number[],
  fn: (n: LayoutNode) => LayoutNode,
): LayoutNode {
  if (path.length === 0) return fn(root);
  if (root.type !== "split") return root;
  const [i, ...rest] = path;
  const children = root.children.map((c, idx) => (idx === i ? updateAtPath(c, rest, fn) : c));
  return { ...root, children };
}

// Give the leaf `id` a sibling on the given orientation. If its parent split
// already runs that direction, insert next to it (n-ary, shared gutter);
// otherwise wrap the leaf in a new 2-child split.
function splitLeaf(
  root: LayoutNode,
  id: string,
  dir: "row" | "col",
  newLeaf: LayoutNode,
): LayoutNode {
  const path = findPath(root, id);
  if (!path) return root;
  if (path.length > 0) {
    const parentPath = path.slice(0, -1);
    const index = path[path.length - 1];
    const parent = nodeAt(root, parentPath);
    if (parent.type === "split" && parent.dir === dir) {
      return updateAtPath(root, parentPath, (p) => {
        if (p.type !== "split") return p;
        const children = [...p.children];
        const sizes = [...p.sizes];
        children.splice(index + 1, 0, newLeaf);
        sizes.splice(index + 1, 0, 1);
        return { ...p, children, sizes };
      });
    }
  }
  return updateAtPath(root, path, (leaf) => ({
    type: "split",
    dir,
    sizes: [1, 1],
    children: [leaf, newLeaf],
  }));
}

// Collapse a split whose nesting is redundant (a child split of the same dir is
// merged into it, scaling sizes proportionally).
function normalize(node: LayoutNode): LayoutNode {
  if (node.type === "pane") return node;
  const children = node.children.map(normalize);
  const flatChildren: LayoutNode[] = [];
  const flatSizes: number[] = [];
  children.forEach((c, i) => {
    if (c.type === "split" && c.dir === node.dir) {
      const childTotal = c.sizes.reduce((a, b) => a + b, 0) || 1;
      c.children.forEach((cc, j) => {
        flatChildren.push(cc);
        flatSizes.push((node.sizes[i] * c.sizes[j]) / childTotal);
      });
    } else {
      flatChildren.push(c);
      flatSizes.push(node.sizes[i]);
    }
  });
  if (flatChildren.length === 1) return flatChildren[0];
  return { ...node, children: flatChildren, sizes: flatSizes };
}

// Remove the leaf `id`; collapse a split that drops to one child; null if empty.
function removeLeaf(node: LayoutNode, id: string): LayoutNode | null {
  if (node.type === "pane") return node.pane.id === id ? null : node;
  const kept: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((c, i) => {
    const r = removeLeaf(c, id);
    if (r) {
      kept.push(r);
      sizes.push(node.sizes[i]);
    }
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0];
  return normalize({ ...node, children: kept, sizes });
}

function leaf(pane: Pane): LayoutNode {
  return { type: "pane", pane };
}

// Insert `newLeaf` next to the leaf `targetId` along `dir`, before or after it.
// Like splitLeaf but with ordering — used by drag-drop reorder.
function insertAdjacent(
  root: LayoutNode,
  targetId: string,
  dir: "row" | "col",
  newLeaf: LayoutNode,
  position: "before" | "after",
): LayoutNode {
  const path = findPath(root, targetId);
  if (!path) return root;
  if (path.length > 0) {
    const parentPath = path.slice(0, -1);
    const index = path[path.length - 1];
    const parent = nodeAt(root, parentPath);
    if (parent.type === "split" && parent.dir === dir) {
      return updateAtPath(root, parentPath, (p) => {
        if (p.type !== "split") return p;
        const children = [...p.children];
        const sizes = [...p.sizes];
        const at = position === "before" ? index : index + 1;
        children.splice(at, 0, newLeaf);
        sizes.splice(at, 0, 1);
        return { ...p, children, sizes };
      });
    }
  }
  return updateAtPath(root, path, (target) => ({
    type: "split",
    dir,
    sizes: [1, 1],
    children: position === "before" ? [newLeaf, target] : [target, newLeaf],
  }));
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
  // When set, this pane fills the whole pane-area; its header toolbar stays
  // visible so it can be restored.
  const [maxPane, setMaxPane] = useState<string | null>(null);
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
  // Guards resize handles against a second concurrent pointer (e.g. a second
  // finger landing on the same bar) restarting the drag with a stale baseline.
  const resizingRef = useRef(false);

  async function reload() {
    setStore(await api.profilesLoad());
  }
  useEffect(() => {
    reload();
  }, []);

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  const paneCount = activeTab ? flattenNodes(activeTab.root).length : 0;
  const layoutSig = `${activeId}:${paneCount}:${maxPane}`;
  useEffect(() => {
    const t = setTimeout(() => window.dispatchEvent(new Event("resize")), 40);
    return () => clearTimeout(t);
  }, [layoutSig]);

  // Maximizing a pane also takes the OS window fullscreen so it fills the whole
  // display, not just the app window. Best-effort: a no-op/denied call (mobile,
  // missing permission) is swallowed — the CSS cover still fills the window.
  useEffect(() => {
    getCurrentWindow()
      .setFullscreen(maxPane != null)
      .catch(() => {});
  }, [maxPane]);

  function makePane(p: Omit<Pane, "id">): Pane {
    return { ...p, id: `p${seq.current++}` };
  }

  function openTab(pane: Omit<Pane, "id">) {
    const id = `t${seq.current++}`;
    setTabs((prev) => [...prev, { id, root: leaf(makePane(pane)) }]);
    setActiveId(id);
    setTabMenu(false);
  }

  function openEditor(state: EditorState) {
    setEditor(state);
    setSidebarOpen(false); // hide the drawer behind the dialog on mobile
  }

  // Drag the sidebar's right edge to resize it; width persists across launches.
  function startSidebarResize(e: React.PointerEvent) {
    e.preventDefault();
    if (resizingRef.current) return;
    const startX = e.clientX;
    const startW = sidebarWidth;
    const handle = e.currentTarget as HTMLElement;
    resizingRef.current = true;
    handle.setPointerCapture(e.pointerId);
    setSidebarResizing(true);
    function onMove(ev: PointerEvent) {
      const w = Math.min(560, Math.max(180, startW + (ev.clientX - startX)));
      setSidebarWidth(w);
      window.dispatchEvent(new Event("resize"));
    }
    function onUp() {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = "";
      resizingRef.current = false;
      setSidebarResizing(false);
      setSidebarWidth((w) => {
        localStorage.setItem("balaudeck.sidebarWidth", String(Math.round(w)));
        return w;
      });
      window.dispatchEvent(new Event("resize"));
    }
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
    document.body.style.cursor = "col-resize";
  }

  function updateTab(tabId: string, fn: (t: Tab) => Tab) {
    setTabs((prev) => prev.map((t) => (t.id === tabId ? fn(t) : t)));
  }

  function splitPane(tabId: string, paneId: string, kind: PaneKind, dir: "right" | "down") {
    // Inherit the source pane's SSH identity / DB profile where it makes sense.
    const tab = tabs.find((t) => t.id === tabId);
    const path = tab ? findPath(tab.root, paneId) : null;
    const srcNode = tab && path ? nodeAt(tab.root, path) : null;
    const srcPane = srcNode && srcNode.type === "pane" ? srcNode.pane : null;
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
    // "right" subdivides the clicked pane left/right (a row split); "down" splits
    // it top/bottom (a col split). Only the clicked pane is affected.
    const wantDir = dir === "right" ? "row" : "col";
    updateTab(tabId, (t) => ({ ...t, root: splitLeaf(t.root, paneId, wantDir, leaf(pane)) }));
    setSplitFor(null);
  }

  function closePane(tabId: string, paneId: string) {
    if (paneId === maxPane) setMaxPane(null);
    setTabs((prev) => {
      const out: Tab[] = [];
      for (const t of prev) {
        if (t.id !== tabId) {
          out.push(t);
          continue;
        }
        const root = removeLeaf(t.root, paneId);
        if (root) out.push({ ...t, root });
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
      const path = src ? findPath(src.root, paneId) : null;
      const node = src && path ? nodeAt(src.root, path) : null;
      if (!src || !node || node.type !== "pane") return prev;
      const pane = node.pane;
      const out: Tab[] = [];
      for (const t of prev) {
        if (t.id !== tabId) {
          out.push(t);
          continue;
        }
        const root = removeLeaf(t.root, paneId);
        if (root) out.push({ ...t, root });
      }
      out.push({ id: newTabId, root: leaf(pane) });
      return out;
    });
    setActiveId(newTabId);
  }

  // Move a pane within a tab: drop onto another pane, inserting above/below it
  // (a vertical neighbour) depending on which half was targeted.
  function movePane(tabId: string, fromId: string, toId: string, position: "before" | "after") {
    if (fromId === toId) return;
    updateTab(tabId, (t) => {
      const fromPath = findPath(t.root, fromId);
      const fromNode = fromPath ? nodeAt(t.root, fromPath) : null;
      if (!fromNode || fromNode.type !== "pane") return t;
      const moved = fromNode.pane;
      const removed = removeLeaf(t.root, fromId);
      if (!removed) return t;
      // Recompute the target against the post-removal tree.
      if (!findPath(removed, toId)) return { ...t, root: removed };
      return { ...t, root: insertAdjacent(removed, toId, "col", leaf(moved), position) };
    });
  }

  // Drop a pane onto the right edge => move it into a brand-new rightmost column.
  function movePaneToNewColumn(tabId: string, fromId: string) {
    updateTab(tabId, (t) => {
      const fromPath = findPath(t.root, fromId);
      const fromNode = fromPath ? nodeAt(t.root, fromPath) : null;
      if (!fromNode || fromNode.type !== "pane") return t;
      const moved = fromNode.pane;
      const removed = removeLeaf(t.root, fromId);
      if (!removed) return t;
      return {
        ...t,
        root: { type: "split", dir: "row", sizes: [1, 1], children: [removed, leaf(moved)] },
      };
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
                root: {
                  type: "split" as const,
                  dir: "row" as const,
                  sizes: [1, 1],
                  children: [t.root, src.root],
                },
              }
            : t,
        )
        .filter((t) => t.id !== sourceId);
    });
    setActiveId(targetId);
  }

  // Resize the boundary at `index` inside the split node at `splitPath`. The
  // gutter's parent is the split's flex container, so we measure it directly —
  // correct even for nested splits. `dir` gives the drag axis.
  function startResize(
    splitPath: number[],
    index: number,
    dir: "row" | "col",
    e: React.PointerEvent,
  ) {
    e.preventDefault();
    if (resizingRef.current || !activeTab) return;
    const tabId = activeTab.id;
    const splitNode = nodeAt(activeTab.root, splitPath);
    if (splitNode.type !== "split") return;
    const handle = e.currentTarget as HTMLElement;
    const container = handle.parentElement as HTMLElement | null;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const arr = [...splitNode.sizes];
    const total = arr.reduce((a, b) => a + b, 0);
    const fullSize = dir === "row" ? rect.width : rect.height;
    const start = dir === "row" ? e.clientX : e.clientY;
    const a = arr[index];
    const b = arr[index + 1];
    const min = total * 0.12;
    resizingRef.current = true;
    handle.setPointerCapture(e.pointerId);

    function onMove(ev: PointerEvent) {
      const pos = dir === "row" ? ev.clientX : ev.clientY;
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
      next[index] = na;
      next[index + 1] = nb;
      updateTab(tabId, (t) => ({
        ...t,
        root: updateAtPath(t.root, splitPath, (n) =>
          n.type === "split" ? { ...n, sizes: next } : n,
        ),
      }));
      window.dispatchEvent(new Event("resize"));
    }
    function onUp() {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = "";
      resizingRef.current = false;
      window.dispatchEvent(new Event("resize"));
    }
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
    document.body.style.cursor = dir === "row" ? "col-resize" : "row-resize";
  }

  // A pane is "maximized here" only when it belongs to the active tab — so
  // switching tabs shows that tab normally and returning restores the maximize.
  const maximizedHere =
    !!maxPane && !!activeTab && flattenNodes(activeTab.root).some((p) => p.id === maxPane);

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
    const flat = flattenNodes(t.root);
    return flat[0].title + (flat.length > 1 ? ` +${flat.length - 1}` : "");
  };

  // ---- Recursive layout render ----
  // A leaf pane card. `grow` is its flex weight within the parent split. A
  // maximized pane drops out of flex flow (CSS .pane.maximized = fixed inset:0).
  function renderPane(p: Pane, tabId: string, grow: number) {
    const active = tabId === activeId;
    const isMax = active && maxPane === p.id;
    const hiddenByMax = active && maximizedHere && !isMax;
    const style: React.CSSProperties = isMax
      ? {}
      : hiddenByMax
        ? { display: "none" }
        : { flexGrow: grow, flexBasis: 0, minWidth: 0, minHeight: 0 };
    return (
      <section
        key={p.id}
        className={
          "pane" +
          (isMax ? " maximized" : "") +
          (dropPane === p.id ? (dropPanePos === "before" ? " drop-before" : " drop-after") : "")
        }
        style={style}
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
              title={isMax ? "Restore" : "Maximize"}
              onClick={() => setMaxPane(isMax ? null : p.id)}
            >
              <Icon name={isMax ? "minimize" : "maximize"} size={14} />
            </button>
            <button className="icon" title="Close pane" onClick={() => closePane(tabId, p.id)}>
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
        <div className={"pane-body" + (p.kind === "ssh" || p.kind === "local" ? " flush" : "")}>
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
  }

  // Recursively render a split tree: a split is a flex container with a draggable
  // gutter between each child; a leaf is a pane card.
  function renderNode(
    node: LayoutNode,
    tabId: string,
    path: number[],
    grow: number,
  ): React.ReactNode {
    if (node.type === "pane") return renderPane(node.pane, tabId, grow);
    const isRow = node.dir === "row";
    const kids: React.ReactNode[] = [];
    node.children.forEach((child, i) => {
      if (i > 0) {
        kids.push(
          <div
            key={"g" + i}
            className={"gutter " + (isRow ? "gutter-col" : "gutter-row")}
            onPointerDown={(e) => startResize(path, i - 1, node.dir, e)}
          />,
        );
      }
      kids.push(renderNode(child, tabId, [...path, i], node.sizes[i]));
    });
    return (
      <div
        key={"s" + path.join("-")}
        className={"pane-split " + (isRow ? "row" : "col")}
        style={{ flexGrow: grow, flexBasis: 0, minWidth: 0, minHeight: 0 }}
      >
        {kids}
      </div>
    );
  }

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
          onPointerDown={startSidebarResize}
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
                <Icon name={KIND_META[flattenNodes(t.root)[0].kind].icon} size={14} className="tab-icon" />
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
              {tabs.map((t) => (
                <div
                  key={t.id}
                  className="tab-tree"
                  style={{ display: t.id === activeId ? "flex" : "none" }}
                >
                  {renderNode(t.root, t.id, [], 1)}
                </div>
              ))}
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
