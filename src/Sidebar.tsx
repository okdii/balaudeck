import type { DbProfile, ProfileStore, SshProfile } from "./types";

interface Props {
  store: ProfileStore;
  onSelectSsh: (p: SshProfile) => void;
  onSelectDb: (p: DbProfile) => void;
  onEditSsh: (p: SshProfile) => void;
  onEditDb: (p: DbProfile) => void;
  onDeleteSsh: (p: SshProfile) => void;
  onDeleteDb: (p: DbProfile) => void;
  onNewSsh: () => void;
  onNewDb: () => void;
}

export function Sidebar(props: Props) {
  const { store } = props;
  return (
    <aside className="sidebar">
      <section>
        <div className="section-head">
          <span>SSH Hosts</span>
          <button className="icon" title="New SSH host" onClick={props.onNewSsh}>
            +
          </button>
        </div>
        {store.ssh.length === 0 && <p className="empty">No hosts yet</p>}
        {store.ssh.map((p) => (
          <div key={p.id} className="item" onClick={() => props.onSelectSsh(p)}>
            <div className="item-main">
              <div className="item-name">{p.name || `${p.user}@${p.host}`}</div>
              <div className="item-sub">
                {p.user}@{p.host}:{p.port}
              </div>
            </div>
            <div className="item-actions">
              <button className="icon" title="Edit" onClick={(e) => { e.stopPropagation(); props.onEditSsh(p); }}>
                ✎
              </button>
              <button className="icon" title="Delete" onClick={(e) => { e.stopPropagation(); props.onDeleteSsh(p); }}>
                🗑
              </button>
            </div>
          </div>
        ))}
      </section>

      <section>
        <div className="section-head">
          <span>Databases</span>
          <button className="icon" title="New database" onClick={props.onNewDb}>
            +
          </button>
        </div>
        {store.db.length === 0 && <p className="empty">No databases yet</p>}
        {store.db.map((p) => (
          <div key={p.id} className="item" onClick={() => props.onSelectDb(p)}>
            <div className="item-main">
              <div className="item-name">{p.name || `${p.user}@${p.host}`}</div>
              <div className="item-sub">
                {p.user}@{p.host}:{p.port}
                {p.via_ssh_profile_id ? " · tunnel" : ""}
              </div>
            </div>
            <div className="item-actions">
              <button className="icon" title="Edit" onClick={(e) => { e.stopPropagation(); props.onEditDb(p); }}>
                ✎
              </button>
              <button className="icon" title="Delete" onClick={(e) => { e.stopPropagation(); props.onDeleteDb(p); }}>
                🗑
              </button>
            </div>
          </div>
        ))}
      </section>
    </aside>
  );
}
