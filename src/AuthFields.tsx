import { open } from "@tauri-apps/plugin-dialog";
import { homeDir, join } from "@tauri-apps/api/path";
import { api } from "./api";
import type { SshAuth } from "./types";

export interface AuthValue {
  auth: SshAuth;
  password: string;
  key: string;
  passphrase: string;
}

export function emptyAuth(): AuthValue {
  return { auth: "password", password: "", key: "", passphrase: "" };
}

/**
 * Authentication method picker shared by SSH / SFTP / Tunnel forms:
 * password, or a private key (paste or import from file) with optional passphrase.
 */
export function AuthFields({
  value,
  onChange,
  saved,
}: {
  value: AuthValue;
  onChange: (v: AuthValue) => void;
  saved?: boolean;
}) {
  async function importKey() {
    // Open the picker inside ~/.ssh — that folder is hidden, but the keys in it
    // (id_rsa, id_ed25519, …) are not, so starting there lets the user pick a key
    // without having to reveal the hidden folder. Falls back to the OS default if
    // ~/.ssh can't be resolved. No extension filter, or extension-less keys hide.
    let defaultPath: string | undefined;
    try {
      defaultPath = await join(await homeDir(), ".ssh");
    } catch {
      /* ignored — fall back to the default open location */
    }
    const path = await open({
      multiple: false,
      defaultPath,
      title: "Select SSH private key",
    });
    if (!path || Array.isArray(path)) return;
    try {
      const text = await api.readTextFile(path);
      onChange({ ...value, key: text });
    } catch {
      /* ignored — invalid path */
    }
  }

  return (
    <div className="auth-fields">
      <div className="auth-toggle">
        <button
          className={value.auth === "password" ? "active" : ""}
          onClick={() => onChange({ ...value, auth: "password" })}
        >
          Password
        </button>
        <button
          className={value.auth === "key" ? "active" : ""}
          onClick={() => onChange({ ...value, auth: "key" })}
        >
          Public key
        </button>
      </div>

      {value.auth === "password" ? (
        <input
          type="password"
          placeholder={saved ? "password (saved)" : "password"}
          value={value.password}
          onChange={(e) => onChange({ ...value, password: e.target.value })}
        />
      ) : (
        <div className="auth-key">
          <div className="form-row">
            <button className="ghost" onClick={importKey}>
              Import key file…
            </button>
            <input
              type="password"
              placeholder="key passphrase (optional)"
              value={value.passphrase}
              onChange={(e) => onChange({ ...value, passphrase: e.target.value })}
            />
          </div>
          <textarea
            className="sql key-area"
            placeholder={
              saved
                ? "private key (saved — leave blank to use stored key)"
                : "-----BEGIN OPENSSH PRIVATE KEY----- …"
            }
            value={value.key}
            onChange={(e) => onChange({ ...value, key: e.target.value })}
            rows={4}
            spellCheck={false}
          />
        </div>
      )}
    </div>
  );
}
