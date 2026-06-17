import { useState } from "react";
import type { DbProfile, Folder, ProfileStore, SshProfile } from "./types";
import { Icon, type IconName } from "./Icon";

interface Props {
  open?: boolean;
  store: ProfileStore;
  onSelectSsh: (p: SshProfile) => void;
  onSelectDb: (p: DbProfile) => void;
  onEditSsh: (p: SshProfile) => void;
  onEditDb: (p: DbProfile) => void;
  onDeleteSsh: (p: SshProfile) => void;
  onDeleteDb: (p: DbProfile) => void;
  onNewSsh: () => void;
  onNewDb: () => void;
  onNewFolder: (kind: "ssh" | "db") => Promise<Folder>;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
  onMoveProfile: (kind: "ssh" | "db", id: string, folderId: string | null) => void;
  onMoveFolder: (id: string, parentId: string | null, beforeId: string | null) => void;
}

interface Item {
  id: string;
  kind: "ssh" | "db";
  name: string;
  sub: string;
  glyph: IconName;
  folderId: string | null;
}

type Drag = { type: "profile" | "folder"; kind: "ssh" | "db"; id: string };

export function Sidebar(props: Props) {
  const { store } = props;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dropZone, setDropZone] = useState<string | null>(null);
  const [editingFolder, setEditingFolder] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  const clearDrag = () => {
    setDrag(null);
    setDropZone(null);
  };

  function commitRename(id: string) {
    const name = editName.trim();
    if (name) props.onRenameFolder(id, name);
    setEditingFolder(null);
  }

  async function createFolder(kind: "ssh" | "db") {
    const f = await props.onNewFolder(kind);
    setExpanded((e) => ({ ...e, [f.id]: true }));
    setEditingFolder(f.id);
    setEditName(f.name);
  }

  const endpoint = (user: string, host: string, port: number) =>
    host ? `${user ? user + "@" : ""}${host}:${port}` : "";
  const sshItems: Item[] = store.ssh.map((p) => ({
    id: p.id,
    kind: "ssh",
    name: p.name || endpoint(p.user, p.host, p.port) || "SSH host",
    sub: p.name ? endpoint(p.user, p.host, p.port) : "",
    glyph: "server",
    folderId: p.folder_id ?? null,
  }));
  const dbItems: Item[] = store.db.map((p) => ({
    id: p.id,
    kind: "db",
    name: p.name || endpoint(p.user, p.host, p.port) || "Database",
    sub:
      (p.name ? endpoint(p.user, p.host, p.port) : "") +
      (p.via_ssh_profile_id ? " · tunnel" : ""),
    glyph: "database",
    folderId: p.folder_id ?? null,
  }));

  function select(it: Item) {
    if (it.kind === "ssh") props.onSelectSsh(store.ssh.find((p) => p.id === it.id)!);
    else props.onSelectDb(store.db.find((p) => p.id === it.id)!);
  }
  function edit(it: Item) {
    if (it.kind === "ssh") props.onEditSsh(store.ssh.find((p) => p.id === it.id)!);
    else props.onEditDb(store.db.find((p) => p.id === it.id)!);
  }
  function del(it: Item) {
    if (it.kind === "ssh") props.onDeleteSsh(store.ssh.find((p) => p.id === it.id)!);
    else props.onDeleteDb(store.db.find((p) => p.id === it.id)!);
  }

  function renderItem(it: Item) {
    return (
      <div
        key={it.id}
        className="item"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          setDrag({ type: "profile", kind: it.kind, id: it.id });
        }}
        onDragEnd={clearDrag}
        onClick={() => select(it)}
      >
        <Icon name={it.glyph} size={16} className="item-glyph" />
        <div className="item-main">
          <div className="item-name">{it.name}</div>
          {it.sub.trim() && <div className="item-sub">{it.sub}</div>}
        </div>
        <div className="item-actions">
          <button className="icon" title="Edit" onClick={(e) => { e.stopPropagation(); edit(it); }}>
            <Icon name="edit" size={14} />
          </button>
          <button className="icon" title="Delete" onClick={(e) => { e.stopPropagation(); del(it); }}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      </div>
    );
  }

  function section(kind: "ssh" | "db", label: string, items: Item[], onNew: () => void) {
    const folders = store.folders.filter((f) => f.kind === kind);
    const rootFolders = folders.filter((f) => !f.parent_id);
    const rootItems = items.filter((it) => it.folderId === null);
    const rootZone = `root:${kind}`;

    const folderNode = (f: Folder) => {
      const childFolders = folders.filter((cf) => cf.parent_id === f.id);
      const fItems = items.filter((it) => it.folderId === f.id);
      const count = childFolders.length + fItems.length;
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
              setDrag({ type: "folder", kind, id: f.id });
            }}
            onDragEnd={clearDrag}
            onClick={() => setExpanded((e) => ({ ...e, [f.id]: !e[f.id] }))}
            onDragOver={(e) => {
              if (!drag || drag.kind !== kind || (drag.type === "folder" && drag.id === f.id)) return;
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
              if (drag && drag.kind === kind) {
                if (drag.type === "folder" && drag.id !== f.id) {
                  const r = e.currentTarget.getBoundingClientRect();
                  const before = e.clientY - r.top < r.height * 0.4;
                  if (before) props.onMoveFolder(drag.id, f.parent_id ?? null, f.id);
                  else props.onMoveFolder(drag.id, f.id, null);
                } else if (drag.type === "profile") {
                  props.onMoveProfile(kind, drag.id, f.id);
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
              {count === 0 && <p className="empty sub">empty</p>}
            </div>
          )}
        </div>
      );
    };

    return (
      <section key={kind}>
        <div className="section-head">
          <span>{label}</span>
          <div className="head-actions">
            <button className="icon" title="New folder" onClick={() => createFolder(kind)}>
              <Icon name="folder" size={15} />
            </button>
            <button
              className="icon"
              title={`New ${kind === "ssh" ? "host" : "database"}`}
              onClick={onNew}
            >
              <Icon name="plus" size={15} />
            </button>
          </div>
        </div>

        {rootFolders.map(folderNode)}

        <div
          className={"root-zone" + (dropZone === rootZone ? " drop" : "")}
          onDragOver={(e) => {
            if (drag && drag.kind === kind) {
              e.preventDefault();
              setDropZone(rootZone);
            }
          }}
          onDragLeave={() => setDropZone((d) => (d === rootZone ? null : d))}
          onDrop={(e) => {
            e.preventDefault();
            if (drag && drag.kind === kind) {
              if (drag.type === "folder") props.onMoveFolder(drag.id, null, null);
              else props.onMoveProfile(kind, drag.id, null);
            }
            clearDrag();
          }}
        >
          {rootItems.map(renderItem)}
          {rootItems.length === 0 && rootFolders.length === 0 && (
            <p className="empty">No {label.toLowerCase()} yet</p>
          )}
        </div>
      </section>
    );
  }

  return (
    <aside className={"sidebar" + (props.open ? " open" : "")}>
      {section("ssh", "SSH Hosts", sshItems, props.onNewSsh)}
      {section("db", "Databases", dbItems, props.onNewDb)}
    </aside>
  );
}
