import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Icon } from "./Icon";
import { getSettings, subscribeSettings } from "./settings";
import { maskText } from "./privacy";

type Prompt = { req_id: string; host_key: string; fingerprint: string };

/**
 * App-wide host-key prompt. With Settings → Security → "Ask before trusting
 * new hosts" on, every SSH-based connect (shell, SFTP, tunnel, DB over SSH)
 * pauses on an unseen host and the backend emits `ssh-hostkey-prompt`; this
 * shows the fingerprint and answers. Also keeps the backend flag in sync
 * with the setting. Mount once, near the app root.
 */
export function HostKeyPrompt() {
  const [queue, setQueue] = useState<Prompt[]>([]);

  // Mirror the setting into the backend (it lives in a process-wide flag).
  useEffect(() => {
    let last: boolean | null = null;
    const sync = () => {
      const on = getSettings().askNewHosts;
      if (on === last) return;
      last = on;
      invoke("ssh_set_ask_new_hosts", { on }).catch(() => {});
    };
    sync();
    return subscribeSettings(sync);
  }, []);

  useEffect(() => {
    const un = listen<Prompt>("ssh-hostkey-prompt", (e) => setQueue((q) => [...q, e.payload]));
    return () => {
      un.then((f) => f());
    };
  }, []);

  const cur = queue[0];
  if (!cur) return null;

  const answer = (accept: boolean) => {
    invoke("ssh_hostkey_answer", { reqId: cur.req_id, accept }).catch(() => {});
    setQueue((q) => q.slice(1));
  };

  return (
    <div className="modal-backdrop hk-backdrop">
      <div className="modal hk-modal" onClick={(e) => e.stopPropagation()}>
        <div className="hk-head">
          <span className="hk-ic">
            <Icon name="lock" size={18} />
          </span>
          <div>
            <h3>New host key</h3>
            <div className="hk-host">{maskText(cur.host_key)}</div>
          </div>
        </div>
        <p className="hk-text">
          This is the first connection to this server. Check that the fingerprint
          matches the one your server admin gave you (on the server:{" "}
          <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code>) before you trust it.
        </p>
        <div className="hk-fp">{cur.fingerprint}</div>
        <p className="hk-text muted">
          Once trusted, the key is pinned. If it ever changes, BalauDeck refuses to connect.
        </p>
        <div className="form-row end">
          <button onClick={() => answer(false)}>Cancel</button>
          <button className="primary" autoFocus onClick={() => answer(true)}>
            Trust &amp; connect
          </button>
        </div>
      </div>
    </div>
  );
}

/** Settings → Security: review / remove / add pinned host keys. */
export function KnownHostsSection() {
  const [hosts, setHosts] = useState<[string, string][]>([]);
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState("");
  const [adding, setAdding] = useState(false);
  const [newHost, setNewHost] = useState("");
  const [newFp, setNewFp] = useState("");

  const load = () =>
    invoke<Record<string, string>>("ssh_known_hosts")
      .then((m) => setHosts(Object.entries(m).sort((a, b) => a[0].localeCompare(b[0]))))
      .catch((e) => setErr(String(e)));
  useEffect(() => {
    load();
  }, []);

  const forget = async (hostKey: string) => {
    await invoke("ssh_forget_host", { hostKey }).catch((e) => setErr(String(e)));
    load();
  };

  const add = async () => {
    setErr("");
    let h = newHost.trim();
    if (h && !h.includes(":")) h = `${h}:22`;
    try {
      await invoke("ssh_trust_host", { hostKey: h, fingerprint: newFp.trim() });
      setNewHost("");
      setNewFp("");
      setAdding(false);
      load();
    } catch (e) {
      setErr(String(e));
    }
  };

  const q = filter.trim().toLowerCase();
  const shown = q ? hosts.filter(([h, f]) => h.toLowerCase().includes(q) || f.toLowerCase().includes(q)) : hosts;

  return (
    <>
      <div className="settings-label">
        Known hosts <span className="settings-count">{hosts.length}</span>
      </div>
      <p className="settings-hint">
        Server keys pinned on first connect (SHA256). Remove an entry when a server
        was legitimately rebuilt; its new key is then accepted on the next connect.
      </p>
      <div className="kh-tools">
        <input
          className="kh-filter"
          placeholder="Filter hosts…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button onClick={() => setAdding((v) => !v)}>
          <Icon name="plus" size={13} /> Add
        </button>
      </div>
      {adding && (
        <div className="kh-add">
          <input placeholder="host:port" value={newHost} onChange={(e) => setNewHost(e.target.value)} />
          <input
            placeholder="SHA256:… fingerprint"
            value={newFp}
            onChange={(e) => setNewFp(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <button className="primary" disabled={!newHost.trim() || !newFp.trim()} onClick={add}>
            Pin
          </button>
        </div>
      )}
      {err && <div className="settings-err">{err}</div>}
      <div className="kh-list">
        {shown.length === 0 && (
          <div className="kh-empty">{hosts.length === 0 ? "No hosts yet — they appear after the first SSH connect." : "No match."}</div>
        )}
        {shown.map(([h, f]) => (
          <div className="kh-row" key={h}>
            <div className="kh-main">
              <div className="kh-host">{maskText(h)}</div>
              <div className="kh-fp" title={f}>
                {f}
              </div>
            </div>
            <button className="icon" title="Copy fingerprint" onClick={() => navigator.clipboard?.writeText(f).catch(() => {})}>
              <Icon name="copy" size={13} />
            </button>
            <button className="icon danger" title="Forget this host" onClick={() => forget(h)}>
              <Icon name="trash" size={13} />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

type AuthPromptReq = {
  req_id: string;
  host: string;
  user: string;
  name: string;
  instructions: string;
  prompts: { prompt: string; echo: boolean }[];
};

const OTP_RE = /code|otp|token|verification|authenticator|one[- ]?time|2fa|totp/i;

/**
 * App-wide keyboard-interactive prompt (2FA / OTP / PAM). The backend answers
 * a lone password prompt with the saved password; everything else lands here.
 * Mount once, near the app root.
 */
export function SshAuthPrompt() {
  const [queue, setQueue] = useState<AuthPromptReq[]>([]);
  const [values, setValues] = useState<string[]>([]);

  useEffect(() => {
    const un = listen<AuthPromptReq>("ssh-auth-prompt", (e) => setQueue((q) => [...q, e.payload]));
    return () => {
      un.then((f) => f());
    };
  }, []);

  const cur = queue[0];
  useEffect(() => {
    setValues(cur ? cur.prompts.map(() => "") : []);
  }, [cur]);
  if (!cur) return null;

  const answer = (answers: string[] | null) => {
    invoke("ssh_auth_answer", { reqId: cur.req_id, answers }).catch(() => {});
    setQueue((q) => q.slice(1));
  };
  const submit = () => answer(values);

  return (
    <div className="modal-backdrop hk-backdrop">
      <form
        className="modal hk-modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="hk-head">
          <span className="hk-ic">
            <Icon name="lock" size={18} />
          </span>
          <div>
            <h3>{cur.name.trim() || "Verification required"}</h3>
            <div className="hk-host">
              {maskText(cur.user)}@{maskText(cur.host)}
            </div>
          </div>
        </div>
        {cur.instructions.trim() && <p className="hk-text">{cur.instructions.trim()}</p>}
        {cur.prompts.map((p, i) => {
          const otp = OTP_RE.test(p.prompt);
          return (
            <label className="auth-field" key={i}>
              <span>{p.prompt.trim().replace(/:$/, "") || "Response"}</span>
              <input
                autoFocus={i === 0}
                // One-time codes stay visible (they expire in seconds, and the
                // OS one-time-code autofill works best on a text field).
                type={p.echo || otp ? "text" : "password"}
                inputMode={otp ? "numeric" : undefined}
                autoComplete={otp ? "one-time-code" : p.echo ? "off" : "current-password"}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                value={values[i] ?? ""}
                onChange={(e) => setValues((v) => v.map((x, j) => (j === i ? e.target.value : x)))}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    answer(null);
                  }
                }}
              />
            </label>
          );
        })}
        <div className="form-row end">
          <button type="button" onClick={() => answer(null)}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Continue
          </button>
        </div>
      </form>
    </div>
  );
}
