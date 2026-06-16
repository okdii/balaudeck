import { useEffect, useState } from "react";
import { SshPanel } from "./SshPanel";
import { DbPanel } from "./DbPanel";
import { Sidebar } from "./Sidebar";
import { ProfileEditor } from "./ProfileEditor";
import { api } from "./api";
import type { DbProfile, ProfileStore, SshProfile } from "./types";
import "./App.css";

type Tab = "ssh" | "db";
type EditorState =
  | { kind: "ssh"; profile?: SshProfile }
  | { kind: "db"; profile?: DbProfile }
  | null;

function App() {
  const [tab, setTab] = useState<Tab>("ssh");
  const [store, setStore] = useState<ProfileStore>({ ssh: [], db: [] });
  const [sshPrefill, setSshPrefill] = useState<SshProfile | null>(null);
  const [dbPrefill, setDbPrefill] = useState<DbProfile | null>(null);
  const [editor, setEditor] = useState<EditorState>(null);

  async function reload() {
    setStore(await api.profilesLoad());
  }

  useEffect(() => {
    reload();
  }, []);

  return (
    <div className="app">
      <Sidebar
        store={store}
        onSelectSsh={(p) => {
          setSshPrefill(p);
          setTab("ssh");
        }}
        onSelectDb={(p) => {
          setDbPrefill(p);
          setTab("db");
        }}
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
        <div className="tabs">
          <button className={tab === "ssh" ? "active" : ""} onClick={() => setTab("ssh")}>
            SSH Terminal
          </button>
          <button className={tab === "db" ? "active" : ""} onClick={() => setTab("db")}>
            MySQL / MariaDB
          </button>
        </div>
        <div style={{ display: tab === "ssh" ? "block" : "none" }}>
          <SshPanel prefill={sshPrefill} />
        </div>
        <div style={{ display: tab === "db" ? "block" : "none" }}>
          <DbPanel prefill={dbPrefill} />
        </div>
      </main>

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
