import { useEffect, useRef, useState } from "react";
import { createHtmlPortalNode, InPortal, OutPortal, type HtmlPortalNode } from "react-reverse-portal";
import { SshPanel } from "./SshPanel";
import { LocalPanel } from "./LocalPanel";
import { SftpPanel } from "./SftpPanel";
import { TunnelPanel } from "./TunnelPanel";
import { DbPanel } from "./DbPanel";
import { MongoPanel } from "./MongoPanel";
import { RedisPanel } from "./RedisPanel";
import { S3Panel } from "./S3Panel";
import { NotePane } from "./NotePane";
import { Sidebar } from "./Sidebar";
import { ProfileEditor } from "./ProfileEditor";
import { SyncModal } from "./SyncModal";
import { AboutModal } from "./AboutModal";
import { SettingsModal } from "./SettingsModal";
import { Icon, type IconName } from "./Icon";
import { isSyncOn, toggleSync, subscribeSync } from "./broadcast";
import { getSettings, setSettings, subscribeSettings } from "./settings";
import { maskText } from "./privacy";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api";
import { connColor, DB_ENGINES } from "./types";
import type {
  ConnKind,
  DbEngine,
  DbProfile,
  Note,
  ProfileStore,
  SftpProfile,
  SshProfile,
  TunnelProfile,
} from "./types";
import "./App.css";

type PaneKind = "local" | "ssh" | "sftp" | "tunnel" | "db" | "note";

interface Pane {
  id: string;
  kind: PaneKind;
  title: string;
  sshProfile?: SshProfile | null;
  dbProfile?: DbProfile | null;
  sftpProfile?: SftpProfile | null;
  tunnelProfile?: TunnelProfile | null;
  noteId?: string | null;
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
  | { kind: "db"; profile?: DbProfile; engine?: DbEngine }
  | { kind: "sftp"; profile?: SftpProfile }
  | { kind: "tunnel"; profile?: TunnelProfile }
  | null;

const KIND_META: Record<PaneKind, { icon: IconName; label: string }> = {
  local: { icon: "terminal", label: "Local" },
  ssh: { icon: "server", label: "SSH" },
  sftp: { icon: "sftp", label: "SFTP" },
  tunnel: { icon: "tunnel", label: "Tunnel" },
  db: { icon: "database", label: "Database" },
  note: { icon: "note", label: "Note" },
};

// Kinds the user can spawn from the +/split menus. Note panes aren't here —
// they're opened from the sidebar because each needs a specific note.
const MENU_KINDS: PaneKind[] = ["local", "ssh", "sftp", "tunnel", "db"];

/** A short tab/pane title for a note: its title, else its first line, capped. */
function noteDisplayTitle(n: Note): string {
  const first = n.body.split("\n").map((s) => s.trim()).find(Boolean) ?? "";
  return (n.title.trim() || first.replace(/^#+\s*/, "") || "Untitled").slice(0, 60);
}


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
    notes: [],
  });
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // When set, this pane fills the whole pane-area; its header toolbar stays
  // visible so it can be restored.
  const [maxPane, setMaxPane] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Privacy mode master. Persisted in settings and applied at load via
  // applyAppTheme (before first paint, so a persisted "on" never flashes the
  // content unblurred). Which sections it blurs is configured in Settings.
  const [privacy, setPrivacyState] = useState(() => getSettings().privacyOn);
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
  // Each pane's real <section> is mounted ONCE into a detached "portal node"
  // (react-reverse-portal). The layout tree renders an <OutPortal> in the pane's
  // current slot, which adopts that node via appendChild. Restructuring the tree
  // (split/close/move/detach) moves the node between slots WITHOUT ever remounting
  // the component — so SSH/DB/SFTP sessions + terminal state fully survive.
  const portalNodes = useRef<Map<string, HtmlPortalNode>>(new Map());
  const paneNode = (id: string): HtmlPortalNode => {
    let n = portalNodes.current.get(id);
    if (!n) {
      n = createHtmlPortalNode({ attributes: { class: "pane-node" } });
      portalNodes.current.set(id, n);
    }
    return n;
  };

  async function reload() {
    setStore(await api.profilesLoad());
  }
  // Google Drive auto-sync. Arm push only after the initial load + launch pull
  // have settled, so we never overwrite Drive with a half-loaded store or bounce
  // a push immediately after pulling. The backend no-ops all of these unless the
  // account is connected, auto-sync is on, and a passphrase is cached — and the
  // commands are harmless stubs on mobile.
  const autoPushArmed = useRef(false);
  const autoPushTimer = useRef<number | null>(null);

  // The <html> data-privacy attribute is set by applyAppTheme (settings). Mirror
  // the button state, and force a re-render on any settings change so masked
  // labels (privacy patterns) update live.
  const [, setSettingsRev] = useState(0);
  useEffect(
    () =>
      subscribeSettings(() => {
        setPrivacyState(getSettings().privacyOn);
        setSettingsRev((n) => n + 1);
      }),
    [],
  );
  const togglePrivacy = () => setSettings({ privacyOn: !getSettings().privacyOn });

  // Global shortcut: Cmd/Ctrl+Shift+. toggles privacy from anywhere. Uses e.code
  // ("Period") so it fires regardless of the shifted character the layout emits.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.code === "Period" || e.key === ".")) {
        e.preventDefault();
        togglePrivacy();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    (async () => {
      await reload();
      try {
        const pulled = await api.gdriveAutoPull();
        if (pulled) await reload();
      } catch {
        /* offline / not connected — ignore on launch */
      }
      autoPushArmed.current = true;
    })();
    return () => {
      if (autoPushTimer.current) window.clearTimeout(autoPushTimer.current);
    };
  }, []);
  // Debounced push ~10s after the store changes (mirrors MJourney's cadence).
  useEffect(() => {
    if (!autoPushArmed.current) return;
    if (autoPushTimer.current) window.clearTimeout(autoPushTimer.current);
    autoPushTimer.current = window.setTimeout(() => {
      api.gdriveAutoPush().catch(() => {});
    }, 10_000);
  }, [store]);

  async function saveNote(note: Note): Promise<Note> {
    const saved = await api.noteSave(note);
    await reload();
    return saved;
  }
  async function deleteNote(id: string) {
    await api.noteDelete(id);
    await reload();
  }
  // Pop a note out into its own tab/pane in the main area, beside connections.
  function openNoteInPane(note: Note) {
    openTab({ kind: "note", title: noteDisplayTitle(note), noteId: note.id });
  }

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  const paneCount = activeTab ? flattenNodes(activeTab.root).length : 0;
  const layoutSig = `${activeId}:${paneCount}:${maxPane}`;
  // `tabs` is a new array identity on every tree mutation, so move/detach/merge
  // (which keep paneCount the same but relocate panes) also pulse a resize → the
  // relocated xterm/CodeMirror refits to its new slot.
  useEffect(() => {
    // Pulse a resize after a layout change so each relocated xterm/grid refits +
    // repaints. Fire a few times because the portal DOM move + flex settle can
    // land a frame or two after this render commits (a single pulse can hit while
    // a pane is still detached/zero-size and get skipped, leaving it blank).
    const fire = () => window.dispatchEvent(new Event("resize"));
    const r = requestAnimationFrame(fire);
    const t1 = setTimeout(fire, 60);
    const t2 = setTimeout(fire, 200);
    return () => {
      cancelAnimationFrame(r);
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [layoutSig, tabs]);
  // Re-render pane headers when the input-broadcast set changes.
  const [, bumpSync] = useState(0);
  useEffect(() => subscribeSync(() => bumpSync((n) => n + 1)), []);

  // Drop portal nodes for panes that no longer exist so closed panes don't leak.
  useEffect(() => {
    const ids = new Set(tabs.flatMap((t) => flattenNodes(t.root).map((p) => p.id)));
    for (const id of [...portalNodes.current.keys()]) {
      if (!ids.has(id)) portalNodes.current.delete(id);
    }
  }, [tabs]);

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
    const first = flat[0];
    let label = first.title;
    if (first.kind === "note") {
      const note = store.notes.find((n) => n.id === first.noteId);
      label = note ? noteDisplayTitle(note) : "Note (deleted)";
    }
    return label + (flat.length > 1 ? ` +${flat.length - 1}` : "");
  };

  // ---- Recursive layout render ----
  // A leaf pane card. `grow` is its flex weight within the parent split. A
  // maximized pane drops out of flex flow (CSS .pane.maximized = fixed inset:0).
  function renderPane(p: Pane, tabId: string) {
    const active = tabId === activeId;
    // Note panes show the note's current title (it can be renamed after open).
    const noteForPane = p.kind === "note" ? store.notes.find((n) => n.id === p.noteId) : null;
    const headTitle =
      p.kind === "note" ? (noteForPane ? noteDisplayTitle(noteForPane) : "Note (deleted)") : p.title;
    const isMax = active && maxPane === p.id;
    const isTerm = p.kind === "ssh" || p.kind === "local";
    const syncOn = isTerm && isSyncOn(p.id);
    return (
      <section
        key={p.id}
        className={
          "pane" +
          (isMax ? " maximized" : "") +
          (syncOn ? " sync-on" : "") +
          (dropPane === p.id ? (dropPanePos === "before" ? " drop-before" : " drop-after") : "")
        }
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
          <Icon name={KIND_META[p.kind].icon} size={14} className="tab-icon" color={connColor(p.kind)} />
          {paneSession[p.id] ? (
            <span className="pane-title connected">
              <span className="dot ok" /> {maskText(paneSession[p.id])}
            </span>
          ) : (
            <span className="pane-title">{maskText(headTitle)}</span>
          )}
          <div className="pane-actions">
            {isTerm && (
              <button
                className={"icon pane-sync" + (syncOn ? " on" : "")}
                title={
                  syncOn
                    ? "Input sync on — typing here is sent to every synced terminal (click to stop)"
                    : "Sync input — broadcast typing to all synced terminals"
                }
                onClick={() => toggleSync(p.id)}
              >
                <Icon name="broadcast" size={14} />
              </button>
            )}
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
                {MENU_KINDS.map((k) => (
                  <button key={k} onClick={() => splitPane(tabId, p.id, k, splitFor.dir)}>
                    <Icon name={KIND_META[k].icon} size={15} color={connColor(k)} />{" "}
                    {splitFor.dir === "right" ? "Right" : "Down"}: {KIND_META[k].label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div
          className={
            "pane-body" +
            (p.kind === "ssh" || p.kind === "local" || p.kind === "note" ? " flush" : "")
          }
        >
          {p.kind === "local" && <LocalPanel paneId={p.id} />}
          {p.kind === "ssh" && (
            <SshPanel
              prefill={p.sshProfile}
              autoConnect={p.autoConnect}
              sshProfiles={store.ssh}
              folders={store.folders}
              paneId={p.id}
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
          {p.kind === "db" &&
            (() => {
              const fam = p.dbProfile ? DB_ENGINES[p.dbProfile.engine]?.family : "sql";
              if (fam === "mongo" && p.dbProfile) {
                return (
                  <MongoPanel
                    prefill={p.dbProfile}
                    sshProfiles={store.ssh}
                    onSession={(label) => setSession(p.id, label)}
                    dcSignal={paneDc[p.id] || 0}
                  />
                );
              }
              if (fam === "redis" && p.dbProfile) {
                return (
                  <RedisPanel
                    prefill={p.dbProfile}
                    sshProfiles={store.ssh}
                    onSession={(label) => setSession(p.id, label)}
                    dcSignal={paneDc[p.id] || 0}
                  />
                );
              }
              if (fam === "s3" && p.dbProfile) {
                return (
                  <S3Panel
                    prefill={p.dbProfile}
                    sshProfiles={store.ssh}
                    onSession={(label) => setSession(p.id, label)}
                    dcSignal={paneDc[p.id] || 0}
                  />
                );
              }
              return (
                <DbPanel
                  prefill={p.dbProfile}
                  sshProfiles={store.ssh}
                  dbProfiles={store.db}
                  savedQueries={store.queries}
                  onQueriesChanged={reload}
                  onSession={(label) => setSession(p.id, label)}
                  dcSignal={paneDc[p.id] || 0}
                />
              );
            })()}
          {p.kind === "note" && <NotePane note={noteForPane ?? undefined} onSave={saveNote} />}
        </div>
      </section>
    );
  }

  // A leaf renders ONLY an empty positioned slot that carries the flex weight +
  // per-pane maximize-hide; the real <section> is portaled in (see pane host).
  function renderSlot(p: Pane, tabId: string, grow: number): React.ReactNode {
    const active = tabId === activeId;
    const isMax = active && maxPane === p.id;
    const hiddenByMax = active && maximizedHere && !isMax;
    const style: React.CSSProperties = isMax
      ? { flexGrow: 0, flexBasis: 0, minWidth: 0, minHeight: 0 }
      : hiddenByMax
        ? { display: "none" }
        : { flexGrow: grow, flexBasis: 0, minWidth: 0, minHeight: 0, display: "flex" };
    return (
      <div key={p.id} className="pane-slot" data-pane-id={p.id} style={style}>
        <OutPortal node={paneNode(p.id)} />
      </div>
    );
  }

  // Recursively render a split tree: a split is a flex container with a draggable
  // gutter between each child; a leaf is a positioned slot for its pane.
  function renderNode(
    node: LayoutNode,
    tabId: string,
    path: number[],
    grow: number,
  ): React.ReactNode {
    if (node.type === "pane") return renderSlot(node.pane, tabId, grow);
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
        <button
          className={"icon topbar-privacy" + (privacy ? " on" : "")}
          title={privacy ? "Privacy mode: ON — click to reveal (⌘/Ctrl+⇧+.)" : "Privacy mode: OFF — blur sensitive info (⌘/Ctrl+⇧+.)"}
          aria-pressed={privacy}
          onClick={togglePrivacy}
        >
          <Icon name={privacy ? "eyeOff" : "eye"} size={18} />
        </button>
        <button
          className="icon topbar-settings"
          title="Settings"
          onClick={() => setSettingsOpen(true)}
        >
          <Icon name="cog" size={18} />
        </button>
        <button
          className="icon topbar-about"
          title="About BalauDeck"
          onClick={() => setAboutOpen(true)}
        >
          <Icon name="info" size={18} />
        </button>
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
          onNew={(kind, engine) => openEditor(kind === "db" ? { kind, engine } : { kind })}
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
          notes={store.notes}
          onSaveNote={saveNote}
          onDeleteNote={deleteNote}
          onOpenNote={openNoteInPane}
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
                <Icon name={KIND_META[flattenNodes(t.root)[0].kind].icon} size={14} className="tab-icon" color={connColor(flattenNodes(t.root)[0].kind)} />
                <span className="tab-title">{maskText(tabLabel(t))}</span>
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
                  if (r) {
                    // Flip the menu leftward (align its right edge to the button)
                    // when opening at the button's left would spill off-screen.
                    const MENU_W = 190;
                    const left =
                      r.left + MENU_W > window.innerWidth - 8
                        ? Math.max(8, r.right - MENU_W)
                        : r.left;
                    setTabMenuPos({ top: r.bottom + 4, left });
                  }
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
            {/* Each pane's <section> is mounted once here via <InPortal> into a
                detached node; the tree's <OutPortal> adopts that node into the
                pane's current slot. Moving between slots never remounts the
                component — SSH/DB/SFTP sessions + terminal state survive. */}
            <div className="pane-portals">
              {tabs.flatMap((t) =>
                flattenNodes(t.root).map((p) => (
                  <InPortal key={p.id} node={paneNode(p.id)}>
                    {renderPane(p, t.id)}
                  </InPortal>
                )),
              )}
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
            {MENU_KINDS.map((k) => (
              <button
                key={k}
                onClick={() => openTab({ kind: k, title: `New ${KIND_META[k].label}` })}
              >
                <Icon name={KIND_META[k].icon} size={15} color={connColor(k)} /> New {KIND_META[k].label}
              </button>
            ))}
          </div>
        </>
      )}

      {editor && (
        <ProfileEditor
          kind={editor.kind}
          initial={editor.profile}
          presetEngine={editor.kind === "db" ? editor.engine : undefined}
          sshProfiles={store.ssh}
          folders={store.folders}
          onClose={() => setEditor(null)}
          onSaved={reload}
        />
      )}

      {syncOpen && (
        <SyncModal onClose={() => setSyncOpen(false)} onImported={reload} />
      )}

      {aboutOpen && <AboutModal onClose={() => setAboutOpen(false)} />}

      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          privacy={privacy}
          onPrivacyChange={(v) => setSettings({ privacyOn: v })}
        />
      )}
    </div>
  );
}

export default App;
