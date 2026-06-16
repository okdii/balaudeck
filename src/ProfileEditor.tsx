import { useState } from "react";
import { api } from "./api";
import {
  type DbProfile,
  type SshProfile,
  emptyDbProfile,
  emptySshProfile,
} from "./types";

type Kind = "ssh" | "db";

interface Props {
  kind: Kind;
  initial?: SshProfile | DbProfile;
  sshProfiles: SshProfile[];
  onClose: () => void;
  onSaved: () => void;
}

export function ProfileEditor({ kind, initial, sshProfiles, onClose, onSaved }: Props) {
  const isSsh = kind === "ssh";
  const [ssh, setSsh] = useState<SshProfile>(
    isSsh ? ((initial as SshProfile) ?? emptySshProfile()) : emptySshProfile(),
  );
  const [db, setDb] = useState<DbProfile>(
    !isSsh ? ((initial as DbProfile) ?? emptyDbProfile()) : emptyDbProfile(),
  );
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    setError("");
    try {
      if (isSsh) {
        await api.sshProfileSave(ssh, password ? password : undefined);
      } else {
        await api.dbProfileSave(db, password ? password : undefined);
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{initial && (initial as any).id ? "Edit" : "New"} {isSsh ? "SSH" : "Database"} profile</h3>
        <label>
          Name
          <input
            value={isSsh ? ssh.name : db.name}
            onChange={(e) =>
              isSsh ? setSsh({ ...ssh, name: e.target.value }) : setDb({ ...db, name: e.target.value })
            }
            placeholder="My server"
          />
        </label>
        <div className="form-row">
          <label className="grow">
            Host
            <input
              value={isSsh ? ssh.host : db.host}
              onChange={(e) =>
                isSsh ? setSsh({ ...ssh, host: e.target.value }) : setDb({ ...db, host: e.target.value })
              }
            />
          </label>
          <label className="port-label">
            Port
            <input
              value={String(isSsh ? ssh.port : db.port)}
              onChange={(e) => {
                const p = Number(e.target.value) || 0;
                isSsh ? setSsh({ ...ssh, port: p }) : setDb({ ...db, port: p });
              }}
            />
          </label>
        </div>
        <label>
          User
          <input
            value={isSsh ? ssh.user : db.user}
            onChange={(e) =>
              isSsh ? setSsh({ ...ssh, user: e.target.value }) : setDb({ ...db, user: e.target.value })
            }
          />
        </label>
        {!isSsh && (
          <>
            <label>
              Database (optional)
              <input
                value={db.database ?? ""}
                onChange={(e) => setDb({ ...db, database: e.target.value || null })}
              />
            </label>
            <label>
              Connect through SSH tunnel (optional)
              <select
                value={db.via_ssh_profile_id ?? ""}
                onChange={(e) => setDb({ ...db, via_ssh_profile_id: e.target.value || null })}
              >
                <option value="">— direct —</option>
                {sshProfiles.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name || `${s.user}@${s.host}`}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <label>
          Password {initial && (initial as any).id ? "(leave blank to keep)" : ""}
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <pre className="error">{error}</pre>}
        <div className="form-row end">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
