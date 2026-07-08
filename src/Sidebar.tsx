import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { ConnKind, DbEngine, Folder, Note, ProfileStore } from "./types";
import { connColor, DB_ENGINES } from "./types";
import { Icon, type IconName } from "./Icon";
import { AskModal, type AskOptions } from "./AskModal";
import { maskText } from "./privacy";
import { NotesPanel } from "./NotesPanel";

interface Props {
  open?: boolean;
  width?: number;
  store: ProfileStore;
  onSelect: (kind: ConnKind, id: string) => void;
  onEdit: (kind: ConnKind, id: string) => void;
  onDelete: (kind: ConnKind, id: string) => void;
  onNew: (kind: ConnKind, engine?: DbEngine, folderId?: string | null) => void;
  onDuplicate: (kind: ConnKind, id: string) => void;
  onNewFolder: () => Promise<Folder>;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
  onMoveProfile: (kind: ConnKind, id: string, folderId: string | null) => void;
  onMoveFolder: (id: string, parentId: string | null, beforeId: string | null) => void;
  onSync: () => void;
  notes: Note[];
  onSaveNote: (note: Note) => Promise<Note>;
  onDeleteNote: (id: string) => Promise<void> | void;
  onOpenNote: (note: Note) => void;
}

interface Item {
  id: string;
  kind: ConnKind;
  name: string;
  sub: string;
  glyph: IconName;
  /** Overrides the per-kind glyph colour (DB items colour by engine). */
  color?: string;
  /** Short engine tag shown after the name (non-MySQL DB engines only). */
  badge?: string;
  folderId: string | null;
}

type Drag =
  | { type: "profile"; kind: ConnKind; id: string }
  | { type: "folder"; id: string };

const GLYPH: Record<ConnKind, IconName> = {
  ssh: "server",
  sftp: "sftp",
  tunnel: "tunnel",
  db: "database",
};

const NEW_TYPES: {
  kind: ConnKind;
  label: string;
  /** Preselects a DB engine in the editor (e.g. the Object storage entry). */
  engine?: DbEngine;
  icon?: IconName;
  color?: string;
}[] = [
  { kind: "ssh", label: "SSH host" },
  { kind: "sftp", label: "SFTP" },
  { kind: "tunnel", label: "Tunnel" },
  { kind: "db", label: "Database" },
  { kind: "db", label: "Object storage", engine: "s3", icon: "bucket", color: DB_ENGINES.s3.color },
];

const endpoint = (user: string, host: string, port: number) =>
  host ? `${user ? user + "@" : ""}${host}:${port}` : "";

export function Sidebar(props: Props) {
  const { store } = props;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dropZone, setDropZone] = useState<string | null>(null);
  const [editingFolder, setEditingFolder] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [newMenu, setNewMenu] = useState(false);
  const [ask, setAsk] = useState<AskOptions | null>(null);
  // Right-click context menu: on a folder (add connection / subfolder / rename /
  // delete) or a connection (duplicate / edit / delete), positioned at the cursor.
  const [ctx, setCtx] = useState<
    | { x: number; y: number; type: "folder"; id: string; name: string }
    | { x: number; y: number; type: "item"; item: Item }
    | null
  >(null);
  const ctxRef = useRef<HTMLDivElement>(null);
  // Close the context menu on any outside pointer-down or Escape. (A full-screen
  // backdrop div would sit in the sidebar's stacking context and swallow the
  // menu's own clicks, so use a document listener instead.)
  useEffect(() => {
    if (!ctx) return;
    const onDown = (e: PointerEvent) => {
      if (!ctxRef.current?.contains(e.target as Node)) setCtx(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtx(null);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [ctx]);

  // Notes panel: pinned to the bottom of the sidebar, toggled from the header,
  // its open state + height persisted across launches.
  const [notesOpen, setNotesOpen] = useState(
    () => localStorage.getItem("balaudeck.notesOpen") === "1",
  );
  const [notesHeight, setNotesHeight] = useState(() => {
    const v = Number(localStorage.getItem("balaudeck.notesHeight"));
    return v >= 120 && v <= 4000 ? v : 240;
  });
  const [notesResizing, setNotesResizing] = useState(false);
  const resizingRef = useRef(false);

  function toggleNotes() {
    setNotesOpen((v) => {
      localStorage.setItem("balaudeck.notesOpen", v ? "0" : "1");
      return !v;
    });
  }

  // Drag the panel's top edge to resize its height; drag up = taller.
  function startNotesResize(e: ReactPointerEvent) {
    e.preventDefault();
    if (resizingRef.current) return;
    const handle = e.currentTarget as HTMLElement;
    const sidebar = handle.closest(".sidebar") as HTMLElement | null;
    // Can grow right up to just below the Connections header — the list
    // scrolls away — so the panel's ceiling tracks the live sidebar height.
    const maxHeight = () => {
      if (!sidebar) return 700;
      const head = sidebar.querySelector(".sidebar-head") as HTMLElement | null;
      const headH = head ? head.getBoundingClientRect().height : 36;
      return Math.max(160, sidebar.clientHeight - headH - 8);
    };
    const startY = e.clientY;
    const startH = Math.min(notesHeight, maxHeight());
    resizingRef.current = true;
    handle.setPointerCapture(e.pointerId);
    setNotesResizing(true);
    function onMove(ev: PointerEvent) {
      const h = Math.min(maxHeight(), Math.max(120, startH + (startY - ev.clientY)));
      setNotesHeight(h);
      window.dispatchEvent(new Event("resize"));
    }
    function onUp() {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      resizingRef.current = false;
      setNotesResizing(false);
      setNotesHeight((h) => {
        localStorage.setItem("balaudeck.notesHeight", String(Math.round(h)));
        return h;
      });
      window.dispatchEvent(new Event("resize"));
    }
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }

  const clearDrag = () => {
    setDrag(null);
    setDropZone(null);
  };

  function commitRename(id: string) {
    const name = editName.trim();
    if (name) props.onRenameFolder(id, name);
    setEditingFolder(null);
  }

  async function createFolder(parentId?: string) {
    const f = await props.onNewFolder();
    if (parentId) {
      props.onMoveFolder(f.id, parentId, null);
      setExpanded((e) => ({ ...e, [parentId]: true, [f.id]: true }));
    } else {
      setExpanded((e) => ({ ...e, [f.id]: true }));
    }
    setEditingFolder(f.id);
    setEditName(f.name);
  }

  // Keep the context menu fully on-screen: the folder variant is ~300px tall,
  // so shift up/left when the click is near the viewport's bottom/right edge.
  function clampMenu(x: number, y: number): { x: number; y: number } {
    return {
      x: Math.min(x, window.innerWidth - 190),
      y: Math.min(y, window.innerHeight - 300),
    };
  }

  // Shared by the folder trash button and the context menu.
  function askDeleteFolder(id: string, name: string) {
    const n = subtreeCount(id);
    setAsk({
      title: "Delete folder",
      label:
        `Delete folder "${name}"?` +
        (n > 0
          ? ` Its ${n} connection${n === 1 ? "" : "s"} will move to the parent (not deleted).`
          : ""),
      confirmText: "Delete",
      danger: true,
      run: () => props.onDeleteFolder(id),
    });
  }

  // Shared by the item trash button and the context menu.
  function askDeleteItem(it: Item) {
    setAsk({
      title: "Delete connection",
      label: `Delete "${it.name}"? This can't be undone.`,
      confirmText: "Delete",
      danger: true,
      run: () => props.onDelete(it.kind, it.id),
    });
  }

  const items: Item[] = [
    ...store.ssh.map((p) => ({
      id: p.id,
      kind: "ssh" as ConnKind,
      name: p.name || endpoint(p.user, p.host, p.port) || "SSH host",
      sub: p.name ? endpoint(p.user, p.host, p.port) : "",
      glyph: GLYPH.ssh,
      folderId: p.folder_id ?? null,
    })),
    ...store.sftp.map((p) => ({
      id: p.id,
      kind: "sftp" as ConnKind,
      name: p.name || endpoint(p.user, p.host, p.port) || "SFTP",
      sub: p.name ? endpoint(p.user, p.host, p.port) : "",
      glyph: GLYPH.sftp,
      folderId: p.folder_id ?? null,
    })),
    ...store.tunnel.map((p) => ({
      id: p.id,
      kind: "tunnel" as ConnKind,
      name: p.name || endpoint(p.user, p.host, p.port) || "Tunnel",
      sub:
        (p.name ? endpoint(p.user, p.host, p.port) + " " : "") +
        `→ ${p.remote_host}:${p.remote_port}`,
      glyph: GLYPH.tunnel,
      folderId: p.folder_id ?? null,
    })),
    ...store.db.map((p) => {
      const meta = DB_ENGINES[(p.engine as DbEngine) ?? "mysql"] ?? DB_ENGINES.mysql;
      const endp = meta.fileBased
        ? (p.file ?? "").split("/").pop() || "file"
        : endpoint(p.user, p.host, p.port);
      return {
        id: p.id,
        kind: "db" as ConnKind,
        name: p.name || endp || "Database",
        sub: (p.name ? endp : "") + (p.via_ssh_profile_id ? " · tunnel" : ""),
        glyph: meta.family === "s3" ? "bucket" : GLYPH.db,
        color: meta.color,
        badge: p.engine && p.engine !== "mysql" ? meta.badge : undefined,
        folderId: p.folder_id ?? null,
      };
    }),
  ];

  function renderItem(it: Item) {
    return (
      <div
        key={it.kind + ":" + it.id}
        className="item"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          setDrag({ type: "profile", kind: it.kind, id: it.id });
        }}
        onDragEnd={clearDrag}
        onClick={() => props.onSelect(it.kind, it.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          setCtx({ ...clampMenu(e.clientX, e.clientY), type: "item", item: it });
        }}
      >
        <Icon name={it.glyph} size={16} className="item-glyph" color={it.color ?? connColor(it.kind)} />
        <div className="item-main">
          <div className="item-name">
            {maskText(it.name)}
            {it.badge && <span className="engine-badge">{it.badge}</span>}
          </div>
          {it.sub.trim() && <div className="item-sub">{maskText(it.sub)}</div>}
        </div>
        <div className="item-actions">
          <button className="icon" title="Edit" onClick={(e) => { e.stopPropagation(); props.onEdit(it.kind, it.id); }}>
            <Icon name="edit" size={14} />
          </button>
          <button
            className="icon"
            title="Delete"
            onClick={(e) => {
              e.stopPropagation();
              askDeleteItem(it);
            }}
          >
            <Icon name="trash" size={14} />
          </button>
        </div>
      </div>
    );
  }

  const folders = store.folders;
  const rootFolders = folders.filter((f) => !f.parent_id);
  const rootItems = items.filter((it) => it.folderId === null);

  // Total connections inside a folder, including all nested sub-folders.
  function subtreeCount(folderId: string): number {
    const direct = items.filter((it) => it.folderId === folderId).length;
    return folders
      .filter((cf) => cf.parent_id === folderId)
      .reduce((sum, cf) => sum + subtreeCount(cf.id), direct);
  }

  const folderNode = (f: Folder) => {
    const childFolders = folders.filter((cf) => cf.parent_id === f.id);
    const fItems = items.filter((it) => it.folderId === f.id);
    const directCount = childFolders.length + fItems.length;
    const count = subtreeCount(f.id);
    const cls =
      "folder" +
      (dropZone === f.id ? " drop" : "") +
      (dropZone === "before:" + f.id ? " drop-before" : "");
    return (
      <div key={f.id} className="folder-node">
        <div
          className={cls}
          draggable={editingFolder !== f.id}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            setDrag({ type: "folder", id: f.id });
          }}
          onDragEnd={clearDrag}
          onClick={() => setExpanded((e) => ({ ...e, [f.id]: !e[f.id] }))}
          onContextMenu={(e) => {
            e.preventDefault();
            setCtx({ ...clampMenu(e.clientX, e.clientY), type: "folder", id: f.id, name: f.name });
          }}
          onDragOver={(e) => {
            if (!drag || (drag.type === "folder" && drag.id === f.id)) return;
            e.preventDefault();
            if (drag.type === "folder") {
              const r = e.currentTarget.getBoundingClientRect();
              const before = e.clientY - r.top < r.height * 0.4;
              setDropZone(before ? "before:" + f.id : f.id);
            } else {
              setDropZone(f.id);
            }
          }}
          onDragLeave={() =>
            setDropZone((d) => (d === f.id || d === "before:" + f.id ? null : d))
          }
          onDrop={(e) => {
            e.preventDefault();
            if (drag) {
              if (drag.type === "folder" && drag.id !== f.id) {
                const r = e.currentTarget.getBoundingClientRect();
                const before = e.clientY - r.top < r.height * 0.4;
                if (before) props.onMoveFolder(drag.id, f.parent_id ?? null, f.id);
                else props.onMoveFolder(drag.id, f.id, null);
              } else if (drag.type === "profile") {
                props.onMoveProfile(drag.kind, drag.id, f.id);
              }
            }
            clearDrag();
          }}
        >
          <Icon
            name={expanded[f.id] ? "chevronDown" : "chevronRight"}
            size={14}
            className="chevron"
          />
          <Icon name="folder" size={15} className="item-glyph" />
          {editingFolder === f.id ? (
            <input
              className="folder-edit"
              autoFocus
              value={editName}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={() => commitRename(f.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename(f.id);
                if (e.key === "Escape") setEditingFolder(null);
              }}
            />
          ) : (
            <span className="folder-name">{f.name}</span>
          )}
          <span className="folder-count">{count || ""}</span>
          <div className="item-actions">
            <button
              className="icon"
              title="Rename"
              onClick={(e) => {
                e.stopPropagation();
                setEditingFolder(f.id);
                setEditName(f.name);
              }}
            >
              <Icon name="edit" size={14} />
            </button>
            <button
              className="icon"
              title="Delete folder"
              onClick={(e) => {
                e.stopPropagation();
                askDeleteFolder(f.id, f.name);
              }}
            >
              <Icon name="trash" size={14} />
            </button>
          </div>
        </div>
        {expanded[f.id] && (
          <div className="folder-children">
            {childFolders.map(folderNode)}
            {fItems.map(renderItem)}
            {directCount === 0 && <p className="empty sub">empty</p>}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside
      className={"sidebar" + (props.open ? " open" : "")}
      style={props.width ? ({ "--sidebar-w": `${props.width}px` } as CSSProperties) : undefined}
    >
      <div className="section-head sidebar-head">
        <span>Connections</span>
        <div className="head-actions">
          <button
            className={"icon" + (notesOpen ? " on" : "")}
            title={notesOpen ? "Hide notes" : "Show notes"}
            onClick={toggleNotes}
          >
            <Icon name="note" size={15} />
          </button>
          <button
            className="icon"
            title="Sync / backup connections"
            onClick={props.onSync}
          >
            <Icon name="refresh" size={15} />
          </button>
          <button className="icon" title="New folder" onClick={() => createFolder()}>
            <Icon name="folder" size={15} />
          </button>
          <div className="new-conn-wrap">
            <button
              className="icon"
              title="New connection"
              onClick={() => setNewMenu((v) => !v)}
            >
              <Icon name="plus" size={15} />
            </button>
            {newMenu && (
              <>
                <div className="menu-backdrop" onClick={() => setNewMenu(false)} />
                <div className="side-menu">
                  {NEW_TYPES.map((t) => (
                    <button
                      key={t.kind + ":" + (t.engine ?? "")}
                      onClick={() => {
                        setNewMenu(false);
                        props.onNew(t.kind, t.engine);
                      }}
                    >
                      <Icon
                        name={t.icon ?? GLYPH[t.kind]}
                        size={15}
                        color={t.color ?? connColor(t.kind)}
                      />{" "}
                      New {t.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="sidebar-scroll">
      <section>
        {rootFolders.map(folderNode)}

        <div
          className={"root-zone" + (dropZone === "root" ? " drop" : "")}
          onDragOver={(e) => {
            if (drag) {
              e.preventDefault();
              setDropZone("root");
            }
          }}
          onDragLeave={() => setDropZone((d) => (d === "root" ? null : d))}
          onDrop={(e) => {
            e.preventDefault();
            if (drag) {
              if (drag.type === "folder") props.onMoveFolder(drag.id, null, null);
              else props.onMoveProfile(drag.kind, drag.id, null);
            }
            clearDrag();
          }}
        >
          {rootItems.map(renderItem)}
          {rootItems.length === 0 && rootFolders.length === 0 && (
            <p className="empty">No connections yet</p>
          )}
        </div>
      </section>
      </div>
      <NotesPanel
        open={notesOpen}
        notes={props.notes}
        height={notesHeight}
        resizing={notesResizing}
        onResizeStart={startNotesResize}
        onClose={toggleNotes}
        onSave={props.onSaveNote}
        onDelete={props.onDeleteNote}
        onOpenInPane={props.onOpenNote}
      />
      {ask && <AskModal ask={ask} onClose={() => setAsk(null)} />}
      {ctx && (
        <>
          <div ref={ctxRef} className="side-menu ctx-menu" style={{ left: ctx.x, top: ctx.y }}>
            {ctx.type === "folder" ? (
              <>
                {NEW_TYPES.map((t) => (
                  <button
                    key={t.kind + ":" + (t.engine ?? "")}
                    onClick={() => {
                      const id = ctx.id;
                      setCtx(null);
                      setExpanded((e) => ({ ...e, [id]: true }));
                      props.onNew(t.kind, t.engine, id);
                    }}
                  >
                    <Icon name={t.icon ?? GLYPH[t.kind]} size={15} color={t.color ?? connColor(t.kind)} />{" "}
                    New {t.label}
                  </button>
                ))}
                <div className="menu-sep" />
                <button
                  onClick={() => {
                    const id = ctx.id;
                    setCtx(null);
                    createFolder(id);
                  }}
                >
                  <Icon name="folder" size={15} /> New subfolder
                </button>
                <button
                  onClick={() => {
                    setEditingFolder(ctx.id);
                    setEditName(ctx.name);
                    setCtx(null);
                  }}
                >
                  <Icon name="edit" size={15} /> Rename
                </button>
                <button
                  onClick={() => {
                    const { id, name } = ctx;
                    setCtx(null);
                    askDeleteFolder(id, name);
                  }}
                >
                  <Icon name="trash" size={15} /> Delete folder
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => {
                    const it = ctx.item;
                    setCtx(null);
                    props.onDuplicate(it.kind, it.id);
                  }}
                >
                  <Icon name="copy" size={15} /> Duplicate
                </button>
                <button
                  onClick={() => {
                    const it = ctx.item;
                    setCtx(null);
                    props.onEdit(it.kind, it.id);
                  }}
                >
                  <Icon name="edit" size={15} /> Edit
                </button>
                <button
                  onClick={() => {
                    const it = ctx.item;
                    setCtx(null);
                    askDeleteItem(it);
                  }}
                >
                  <Icon name="trash" size={15} /> Delete
                </button>
              </>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
