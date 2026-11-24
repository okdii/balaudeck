import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { homeDir, join } from "@tauri-apps/api/path";
import { api } from "./api";
import type { SshAuth } from "./types";
import { storeBuild } from "./updater";

/** ssh-agent needs a local agent socket: desktop, outside the App Store sandbox. */
const agentAvailable =
  !storeBuild &&
  !/iPhone|iPad|Android/i.test(navigator.userAgent) &&
  !(navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

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
  const [keyPath, setKeyPath] = useState("");
  const [keyErr, setKeyErr] = useState("");
  // Show a stored password as masked dots (like the escalation field); flips true
  // once the user starts replacing it so the real (blank) value drives save.
  const [pwEditing, setPwEditing] = useState(false);

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
    setKeyErr("");
    try {
      const text = await api.readTextFile(path);
      onChange({ ...value, key: text });
    } catch {
      setKeyErr("Couldn't read that key file.");
    }
  }

  // Load a key from a typed path, expanding a leading ~. Works on desktop; a
  // sandboxed Mac App Store build can only read files chosen via the picker.
  async function loadKeyPath() {
    const raw = keyPath.trim();
    if (!raw) return;
    setKeyErr("");
    try {
      let p = raw;
      if (p.startsWith("~")) p = await join(await homeDir(), p.replace(/^~[/\\]?/, ""));
      const text = await api.readTextFile(p);
      onChange({ ...value, key: text });
      setKeyPath("");
    } catch {
      setKeyErr(
        "Couldn't read that path — check it exists (sandboxed builds only allow picked files).",
      );
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
        {(agentAvailable || value.auth === "agent") && (
          <button
            className={value.auth === "agent" ? "active" : ""}
            onClick={() => onChange({ ...value, auth: "agent" })}
            title="Use the keys loaded in your ssh-agent (ssh-add, 1Password, Secretive)"
          >
            ssh-agent
          </button>
        )}
      </div>

      {value.auth === "agent" ? (
        <div className="auth-agent-hint">
          Uses the keys in your running ssh-agent (<code>SSH_AUTH_SOCK</code>), or the 1Password /
          Secretive agent if that's what you use. No key is stored in BalauDeck. Check with{" "}
          <code>ssh-add -l</code>.
        </div>
      ) : value.auth === "password" ? (
        <input
          type="password"
          placeholder={saved ? "password (saved) — click to replace" : "password"}
          value={saved && !pwEditing ? "••••••••" : value.password}
          onFocus={() => {
            if (saved && !pwEditing) setPwEditing(true);
          }}
          onBlur={() => {
            // Nothing typed after clicking in — restore the saved dots.
            if (saved && pwEditing && !value.password) setPwEditing(false);
          }}
          onChange={(e) => {
            setPwEditing(true);
            onChange({ ...value, password: e.target.value });
          }}
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
          <div className="form-row">
            <input
              type="text"
              placeholder="or type a key path, e.g. ~/.ssh/id_rsa"
              value={keyPath}
              onChange={(e) => setKeyPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  loadKeyPath();
                }
              }}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            <button className="ghost" onClick={loadKeyPath} disabled={!keyPath.trim()}>
              Load
            </button>
          </div>
          {keyErr && (
            <div style={{ color: "#e5534b", fontSize: "0.8em", marginTop: "0.25rem" }}>
              {keyErr}
            </div>
          )}
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
