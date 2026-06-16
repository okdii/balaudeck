import { useEffect, useRef, useState } from "react";
import { SshPanel } from "./SshPanel";
import { SftpPanel } from "./SftpPanel";
import { TunnelPanel } from "./TunnelPanel";
import { DbPanel } from "./DbPanel";
import { Sidebar } from "./Sidebar";
import { ProfileEditor } from "./ProfileEditor";
import { api } from "./api";
import type { DbProfile, ProfileStore, SshProfile } from "./types";
import "./App.css";

type TabKind = "ssh" | "sftp" | "tunnel" | "db";

interface Tab {
  id: string;
  kind: TabKind;
  title: string;
  sshProfile?: SshProfile | null;
  dbProfile?: DbProfile | null;
  autoConnect?: boolean;
}

type EditorState =
  | { kind: "ssh"; profile?: SshProfile }
  | { kind: "db"; profile?: DbProfile }
  | null;

const KIND_META: Record<TabKind, { icon: string; label: string }> = {
  ssh: { icon: "›_", label: "SSH" },
  sftp: { icon: "⤓", label: "SFTP" },
  tunnel: { icon: "⇄", label: "Tunnel" },
  db: { icon: "▦", label: "MySQL" },
};

function App() {
  const [store, setStore] = useState<ProfileStore>({ ssh: [], db: [] });
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const seq = useRef(0);

  async function reload() {
    setStore(await api.profilesLoad());
  }

  useEffect(() => {
    reload();
  }, []);

  // Re-fit the active terminal when tabs switch (xterm needs a visible container).
  useEffect(() => {
    const t = setTimeout(() => window.dispatchEvent(new Event("resize")), 30);
    return () => clearTimeout(t);
  }, [activeId]);

  function openTab(tab: Omit<Tab, "id">) {
    const id = `t${seq.current++}`;
    setTabs((prev) => [...prev, { ...tab, id }]);
    setActiveId(id);
    setMenuOpen(false);
  }

  function closeTab(id: string) {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      if (activeId === id) {
        const fallback = next[idx] ?? next[idx - 1] ?? next[next.length - 1];
        setActiveId(fallback ? fallback.id : null);
      }
      return next;
    });
  }

  function sshTitle(p: SshProfile) {
    return p.name || `${p.user}@${p.host}`;
  }
  function dbTitle(p: DbProfile) {
    return p.name || p.database || `${p.user}@${p.host}`;
  }

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
                className={"tab" + (t.id === activeId ? " active" : "")}
                onClick={() => setActiveId(t.id)}
              >
                <span className="tab-icon">{KIND_META[t.kind].icon}</span>
                <span className="tab-title">{t.title}</span>
                <button
                  className="tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.id);
                  }}
                >
                  ×
                </button>
              </div>
            ))}
            <div className="tab-add-wrap">
              <button className="tab-add" onClick={() => setMenuOpen((v) => !v)}>
                +
              </button>
              {menuOpen && (
                <div className="tab-menu" onMouseLeave={() => setMenuOpen(false)}>
                  {(Object.keys(KIND_META) as TabKind[]).map((k) => (
                    <button
                      key={k}
                      onClick={() => openTab({ kind: k, title: `New ${KIND_META[k].label}` })}
                    >
                      <span className="tab-icon">{KIND_META[k].icon}</span> New {KIND_META[k].label}
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
              </div>
            )}
            {tabs.map((t) => (
              <div
                key={t.id}
                className="tab-pane"
                style={{ display: t.id === activeId ? "block" : "none" }}
              >
                {t.kind === "ssh" && (
                  <SshPanel prefill={t.sshProfile} autoConnect={t.autoConnect} />
                )}
                {t.kind === "sftp" && <SftpPanel prefill={t.sshProfile} />}
                {t.kind === "tunnel" && <TunnelPanel sshProfiles={store.ssh} />}
                {t.kind === "db" && <DbPanel prefill={t.dbProfile} sshProfiles={store.ssh} />}
              </div>
            ))}
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
