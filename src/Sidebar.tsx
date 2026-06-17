import type { DbProfile, ProfileStore, SshProfile } from "./types";
import { Icon } from "./Icon";

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
}

export function Sidebar(props: Props) {
  const { store } = props;
  return (
    <aside className={"sidebar" + (props.open ? " open" : "")}>
      <section>
        <div className="section-head">
          <span>SSH Hosts</span>
          <button className="icon" title="New SSH host" onClick={props.onNewSsh}>
            <Icon name="plus" size={15} />
          </button>
        </div>
        {store.ssh.length === 0 && <p className="empty">No hosts yet</p>}
        {store.ssh.map((p) => (
          <div key={p.id} className="item" onClick={() => props.onSelectSsh(p)}>
            <Icon name="server" size={16} className="item-glyph" />
            <div className="item-main">
              <div className="item-name">{p.name || `${p.user}@${p.host}`}</div>
              <div className="item-sub">
                {p.user}@{p.host}:{p.port}
              </div>
            </div>
            <div className="item-actions">
              <button className="icon" title="Edit" onClick={(e) => { e.stopPropagation(); props.onEditSsh(p); }}>
                <Icon name="edit" size={14} />
              </button>
              <button className="icon" title="Delete" onClick={(e) => { e.stopPropagation(); props.onDeleteSsh(p); }}>
                <Icon name="trash" size={14} />
              </button>
            </div>
          </div>
        ))}
      </section>

      <section>
        <div className="section-head">
          <span>Databases</span>
          <button className="icon" title="New database" onClick={props.onNewDb}>
            <Icon name="plus" size={15} />
          </button>
        </div>
        {store.db.length === 0 && <p className="empty">No databases yet</p>}
        {store.db.map((p) => (
          <div key={p.id} className="item" onClick={() => props.onSelectDb(p)}>
            <Icon name="database" size={16} className="item-glyph" />
            <div className="item-main">
              <div className="item-name">{p.name || `${p.user}@${p.host}`}</div>
              <div className="item-sub">
                {p.user}@{p.host}:{p.port}
                {p.via_ssh_profile_id ? " · tunnel" : ""}
              </div>
            </div>
            <div className="item-actions">
              <button className="icon" title="Edit" onClick={(e) => { e.stopPropagation(); props.onEditDb(p); }}>
                <Icon name="edit" size={14} />
              </button>
              <button className="icon" title="Delete" onClick={(e) => { e.stopPropagation(); props.onDeleteDb(p); }}>
                <Icon name="trash" size={14} />
              </button>
            </div>
          </div>
        ))}
      </section>
    </aside>
  );
}
