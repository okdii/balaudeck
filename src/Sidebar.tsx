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
}

interface Item {
  id: string;
  kind: "ssh" | "db";
  name: string;
  sub: string;
  glyph: IconName;
  folderId: string | null;
}

export function Sidebar(props: Props) {
  const { store } = props;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [drag, setDrag] = useState<{ kind: "ssh" | "db"; id: string } | null>(null);
  const [dropZone, setDropZone] = useState<string | null>(null);
  const [editingFolder, setEditingFolder] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

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

  const sshItems: Item[] = store.ssh.map((p) => ({
    id: p.id,
    kind: "ssh",
    name: p.name || `${p.user}@${p.host}`,
    sub: `${p.user}@${p.host}:${p.port}`,
    glyph: "server",
    folderId: p.folder_id ?? null,
  }));
  const dbItems: Item[] = store.db.map((p) => ({
    id: p.id,
    kind: "db",
    name: p.name || `${p.user}@${p.host}`,
    sub: `${p.user}@${p.host}:${p.port}${p.via_ssh_profile_id ? " · tunnel" : ""}`,
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
          setDrag({ kind: it.kind, id: it.id });
        }}
        onDragEnd={() => {
          setDrag(null);
          setDropZone(null);
        }}
        onClick={() => select(it)}
      >
        <Icon name={it.glyph} size={16} className="item-glyph" />
        <div className="item-main">
          <div className="item-name">{it.name}</div>
          <div className="item-sub">{it.sub}</div>
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
    const rootItems = items.filter((it) => it.folderId === null);
    const rootZone = `root:${kind}`;
    const canDrop = (zoneKind: "ssh" | "db") => drag && drag.kind === zoneKind;

    return (
      <section key={kind}>
        <div className="section-head">
          <span>{label}</span>
          <div className="head-actions">
            <button className="icon" title="New folder" onClick={() => createFolder(kind)}>
              <Icon name="folder" size={15} />
            </button>
            <button className="icon" title={`New ${kind === "ssh" ? "host" : "database"}`} onClick={onNew}>
              <Icon name="plus" size={15} />
            </button>
          </div>
        </div>

        {folders.map((f) => {
          const fItems = items.filter((it) => it.folderId === f.id);
          const isDrop = dropZone === f.id;
          return (
            <div key={f.id}>
              <div
                className={"folder" + (isDrop ? " drop" : "")}
                onClick={() => setExpanded((e) => ({ ...e, [f.id]: !e[f.id] }))}
                onDragOver={(e) => {
                  if (canDrop(kind)) {
                    e.preventDefault();
                    setDropZone(f.id);
                  }
                }}
                onDragLeave={() => setDropZone((d) => (d === f.id ? null : d))}
                onDrop={(e) => {
                  e.preventDefault();
                  if (drag && drag.kind === kind) props.onMoveProfile(kind, drag.id, f.id);
                  setDrag(null);
                  setDropZone(null);
                }}
              >
                <Icon name={expanded[f.id] ? "chevronDown" : "chevronRight"} size={13} />
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
                <span className="folder-count">{fItems.length}</span>
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
                  {fItems.length === 0 && <p className="empty sub">empty</p>}
                  {fItems.map(renderItem)}
                </div>
              )}
            </div>
          );
        })}

        <div
          className={"root-zone" + (dropZone === rootZone ? " drop" : "")}
          onDragOver={(e) => {
            if (canDrop(kind)) {
              e.preventDefault();
              setDropZone(rootZone);
            }
          }}
          onDragLeave={() => setDropZone((d) => (d === rootZone ? null : d))}
          onDrop={(e) => {
            e.preventDefault();
            if (drag && drag.kind === kind) props.onMoveProfile(kind, drag.id, null);
            setDrag(null);
            setDropZone(null);
          }}
        >
          {rootItems.map(renderItem)}
          {rootItems.length === 0 && folders.length === 0 && (
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
