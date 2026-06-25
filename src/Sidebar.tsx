import {
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { ConnKind, Folder, Note, ProfileStore } from "./types";
import { Icon, type IconName } from "./Icon";
import { NotesPanel } from "./NotesPanel";

interface Props {
  open?: boolean;
  width?: number;
  store: ProfileStore;
  onSelect: (kind: ConnKind, id: string) => void;
  onEdit: (kind: ConnKind, id: string) => void;
  onDelete: (kind: ConnKind, id: string) => void;
  onNew: (kind: ConnKind) => void;
  onNewFolder: () => Promise<Folder>;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
  onMoveProfile: (kind: ConnKind, id: string, folderId: string | null) => void;
  onMoveFolder: (id: string, parentId: string | null, beforeId: string | null) => void;
  onSync: () => void;
  notes: Note[];
  onSaveNote: (note: Note) => Promise<Note>;
  onDeleteNote: (id: string) => Promise<void> | void;
}

interface Item {
  id: string;
  kind: ConnKind;
  name: string;
  sub: string;
  glyph: IconName;
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

const NEW_TYPES: { kind: ConnKind; label: string }[] = [
  { kind: "ssh", label: "SSH host" },
  { kind: "sftp", label: "SFTP" },
  { kind: "tunnel", label: "Tunnel" },
  { kind: "db", label: "Database" },
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

  // Notes panel: pinned to the bottom of the sidebar, toggled from the header,
  // its open state + height persisted across launches.
  const [notesOpen, setNotesOpen] = useState(
    () => localStorage.getItem("balaudeck.notesOpen") === "1",
  );
  const [notesHeight, setNotesHeight] = useState(() => {
    const v = Number(localStorage.getItem("balaudeck.notesHeight"));
    return v >= 120 && v <= 700 ? v : 240;
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
    const startY = e.clientY;
    const startH = notesHeight;
    const handle = e.currentTarget as HTMLElement;
    resizingRef.current = true;
    handle.setPointerCapture(e.pointerId);
    setNotesResizing(true);
    function onMove(ev: PointerEvent) {
      const h = Math.min(700, Math.max(120, startH + (startY - ev.clientY)));
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

  async function createFolder() {
    const f = await props.onNewFolder();
    setExpanded((e) => ({ ...e, [f.id]: true }));
    setEditingFolder(f.id);
    setEditName(f.name);
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
    ...store.db.map((p) => ({
      id: p.id,
      kind: "db" as ConnKind,
      name: p.name || endpoint(p.user, p.host, p.port) || "Database",
      sub:
        (p.name ? endpoint(p.user, p.host, p.port) : "") +
        (p.via_ssh_profile_id ? " · tunnel" : ""),
      glyph: GLYPH.db,
      folderId: p.folder_id ?? null,
    })),
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
      >
        <Icon name={it.glyph} size={16} className="item-glyph" />
        <div className="item-main">
          <div className="item-name">{it.name}</div>
          {it.sub.trim() && <div className="item-sub">{it.sub}</div>}
        </div>
        <div className="item-actions">
          <button className="icon" title="Edit" onClick={(e) => { e.stopPropagation(); props.onEdit(it.kind, it.id); }}>
            <Icon name="edit" size={14} />
          </button>
          <button className="icon" title="Delete" onClick={(e) => { e.stopPropagation(); props.onDelete(it.kind, it.id); }}>
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
                props.onDeleteFolder(f.id);
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
          <button className="icon" title="New folder" onClick={createFolder}>
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
                      key={t.kind}
                      onClick={() => {
                        setNewMenu(false);
                        props.onNew(t.kind);
                      }}
                    >
                      <Icon name={GLYPH[t.kind]} size={15} /> New {t.label}
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
      />
    </aside>
  );
}
