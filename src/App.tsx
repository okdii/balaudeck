import { useEffect, useRef, useState } from "react";
import { SshPanel } from "./SshPanel";
import { SftpPanel } from "./SftpPanel";
import { TunnelPanel } from "./TunnelPanel";
import { DbPanel } from "./DbPanel";
import { Sidebar } from "./Sidebar";
import { ProfileEditor } from "./ProfileEditor";
import { Icon, type IconName } from "./Icon";
import { api } from "./api";
import type { DbProfile, ProfileStore, SshProfile } from "./types";
import "./App.css";

type PaneKind = "ssh" | "sftp" | "tunnel" | "db";

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
  ssh: { icon: "terminal", label: "SSH" },
  sftp: { icon: "folder", label: "SFTP" },
  tunnel: { icon: "tunnel", label: "Tunnel" },
  db: { icon: "database", label: "MySQL" },
};

function App() {
  const [store, setStore] = useState<ProfileStore>({ ssh: [], db: [] });
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(null);
  const [tabMenu, setTabMenu] = useState(false);
  const [splitFor, setSplitFor] = useState<string | null>(null); // pane id
  const [dragTab, setDragTab] = useState<string | null>(null);
  const [dropTab, setDropTab] = useState<string | null>(null);
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

  // Drag a tab onto another tab to merge its panes in as splits.
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
                  "tab" + (t.id === activeId ? " active" : "") + (t.id === dropTab ? " drop" : "")
                }
                draggable
                onClick={() => setActiveId(t.id)}
                onDragStart={() => setDragTab(t.id)}
                onDragEnd={() => {
                  setDragTab(null);
                  setDropTab(null);
                }}
                onDragOver={(e) => {
                  if (dragTab && dragTab !== t.id) {
                    e.preventDefault();
                    setDropTab(t.id);
                  }
                }}
                onDragLeave={() => setDropTab((d) => (d === t.id ? null : d))}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragTab) mergeTabs(dragTab, t.id);
                  setDragTab(null);
                  setDropTab(null);
                }}
                title="Drag onto another tab to merge as split panes"
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
              className="pane-grid"
              data-count={Math.min(activeTab?.panes.length ?? 0, 6)}
              style={{ display: tabs.length ? "grid" : "none" }}
            >
              {allPanes.map(({ pane: p, tabId }) => (
                <section
                  key={p.id}
                  className="pane"
                  style={{ display: tabId === activeId ? "flex" : "none" }}
                >
                  <div className="pane-head">
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
                    {p.kind === "ssh" && <SshPanel prefill={p.sshProfile} autoConnect={p.autoConnect} />}
                    {p.kind === "sftp" && <SftpPanel prefill={p.sshProfile} />}
                    {p.kind === "tunnel" && <TunnelPanel sshProfiles={store.ssh} />}
                    {p.kind === "db" && <DbPanel prefill={p.dbProfile} sshProfiles={store.ssh} />}
                  </div>
                </section>
              ))}
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
