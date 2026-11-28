// Profile editor section: "Before connecting" — a local command (VPN up,
// cloud firewall open…), a port-knock sequence and/or an fwknop SPA packet,
// run by the backend on every connect of the profile
// (src-tauri/src/preconnect.rs, spa.rs).

import { useState, type ClipboardEvent } from "react";
import { api } from "./api";
import { Spinner } from "./Icon";
import type { PreConnect, SpaKeys } from "./types";
import { storeBuild } from "./updater";

/** A local command needs a desktop shell outside the App Store sandbox. */
export const preCommandAvailable =
  !storeBuild &&
  !/iPhone|iPad|Android/i.test(navigator.userAgent) &&
  !(navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/** Same rules as preconnect.rs parse_knock — instant feedback while typing. */
export function knockError(spec: string): string {
  for (const tok of spec.split(/[\s,]+/).filter(Boolean)) {
    const m = tok.match(/^(\d+)(?:\/(tcp|udp))?$/i);
    const n = m ? Number(m[1]) : NaN;
    if (!m || n < 1 || n > 65535) return `"${tok}" isn't a port — use e.g. 7000, 8000/udp`;
  }
  return "";
}

/** Same rules as spa.rs normalize_access. */
export function spaAccessError(spec: string): string {
  for (const tok of spec.split(/[\s,]+/).filter(Boolean)) {
    const m = tok.match(/^(tcp|udp)\/(\d+)$/i);
    const n = m ? Number(m[2]) : NaN;
    if (!m || n < 1 || n > 65535) return `"${tok}" — write ports as tcp/22 or udp/53`;
  }
  return "";
}

/** IPv4 or blank (blank = the packet's source address). */
export function spaIpError(ip: string): string {
  const v = ip.trim();
  if (!v) return "";
  const parts = v.split(".");
  const ok = parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
  return ok ? "" : `"${v}" isn't an IPv4 address`;
}

/** Pull KEY_BASE64 / HMAC_KEY_BASE64 out of pasted `fwknop --key-gen` output
 *  (or a ~/.fwknoprc / access.conf stanza). Null when it isn't that. */
export function parseKeyGen(text: string): SpaKeys | null {
  const key = text.match(/(?:^|\s)KEY_BASE64[:\s]\s*(\S+)/m)?.[1];
  const hmac = text.match(/HMAC_KEY_BASE64[:\s]\s*(\S+)/m)?.[1];
  if (!key && !hmac) return null;
  return { key: key ?? null, hmac_key: hmac ?? null };
}

/** All SPA settings + key errors, for the editor's Save/Test gate. */
export function spaError(v: PreConnect, keys: SpaKeys, saved: { key: boolean; hmac: boolean }): string {
  if (!v.spa) return "";
  if (!keys.key?.trim() && !saved.key) return "SPA: paste the encryption key (KEY_BASE64).";
  if (!keys.hmac_key?.trim() && !saved.hmac) return "SPA: paste the HMAC key (HMAC_KEY_BASE64).";
  return spaAccessError(v.spa_access ?? "") || spaIpError(v.spa_allow_ip ?? "");
}

export function PreConnectFields({
  value,
  onChange,
  host,
  port,
  user,
  spaKeys,
  onSpaKeys,
  spaSaved,
  profileId,
}: {
  value: PreConnect;
  onChange: (v: PreConnect) => void;
  host: string;
  port: number;
  user: string;
  spaKeys: SpaKeys;
  onSpaKeys: (k: SpaKeys) => void;
  /** Keys already in the keychain for this profile (blank field = keep). */
  spaSaved: { key: boolean; hmac: boolean };
  profileId?: string | null;
}) {
  const hasAny = !!(value.knock_ports?.trim() || value.pre_connect?.trim() || value.spa);
  const sErr = spaError(value, spaKeys, spaSaved);
  const [open, setOpen] = useState(hasAny);
  const [test, setTest] = useState<{ busy: boolean; msg: string; ok: boolean } | null>(null);
  const kErr = knockError(value.knock_ports ?? "");
  const set = (p: Partial<PreConnect>) => onChange({ ...value, ...p });

  function onKey(slot: "key" | "hmac_key", text: string) {
    const parsed = parseKeyGen(text);
    if (parsed) onSpaKeys({ key: parsed.key ?? spaKeys.key, hmac_key: parsed.hmac_key ?? spaKeys.hmac_key });
    else onSpaKeys({ ...spaKeys, [slot]: text });
  }
  // Pasting the multi-line --key-gen output into either field fills both.
  function onPasteKeys(e: ClipboardEvent<HTMLInputElement>) {
    const parsed = parseKeyGen(e.clipboardData.getData("text"));
    if (!parsed) return;
    e.preventDefault();
    onSpaKeys({ key: parsed.key ?? spaKeys.key, hmac_key: parsed.hmac_key ?? spaKeys.hmac_key });
    set({ spa_key_b64: true, spa_hmac_b64: true });
  }

  async function runTest() {
    setTest({ busy: true, msg: "", ok: false });
    try {
      await api.preconnectTest(value, host.trim(), port, user.trim(), spaKeys, profileId);
      setTest({ busy: false, ok: true, msg: "Done — the steps ran without errors." });
    } catch (e) {
      setTest({ busy: false, ok: false, msg: String(e) });
    }
  }

  if (!open) {
    return (
      <button type="button" className="ghost pre-toggle" onClick={() => setOpen(true)}>
        + Before connecting (port knock, fwknop SPA{preCommandAvailable ? ", VPN or other command" : ""})
      </button>
    );
  }
  return (
    <fieldset className="pre-box">
      <legend>Before connecting</legend>
      {preCommandAvailable ? (
        <>
          <label>
            Run this command first{" "}
            <small>— on this computer; waited for, a failure stops the connect</small>
            <input
              value={value.pre_connect ?? ""}
              onChange={(e) => set({ pre_connect: e.target.value || null })}
              placeholder="e.g. tailscale up   ·   wg-quick up office   ·   ~/bin/open-fw.sh"
              spellCheck={false}
            />
          </label>
          {value.pre_connect?.trim() && (
            <label className="pre-inline">
              Wait up to
              <input
                type="number"
                min={1}
                max={600}
                value={value.pre_connect_timeout ?? 30}
                onChange={(e) => set({ pre_connect_timeout: Number(e.target.value) || 30 })}
              />
              seconds <small>· $BD_HOST, $BD_PORT and $BD_USER are set for the command</small>
            </label>
          )}
        </>
      ) : (
        value.pre_connect?.trim() && (
          <p className="settings-hint">
            This profile also runs <code>{value.pre_connect}</code> before connecting, which only
            works in the desktop app — remove it there to connect from this device.
          </p>
        )
      )}
      <label>
        Port knock sequence <small>— in order; TCP unless /udp</small>
        <input
          value={value.knock_ports ?? ""}
          onChange={(e) => set({ knock_ports: e.target.value || null })}
          placeholder="7000, 8000, 9000/udp"
          spellCheck={false}
        />
      </label>
      {kErr && <span className="field-err">{kErr}</span>}
      {value.knock_ports?.trim() && !kErr && (
        <label className="pre-inline">
          Pause after each knock
          <input
            type="number"
            min={0}
            max={10000}
            step={50}
            value={value.knock_delay_ms ?? 300}
            onChange={(e) => set({ knock_delay_ms: Number(e.target.value) })}
          />
          ms <small>· skipped when connecting through a jump host</small>
        </label>
      )}
      <label className="pre-check">
        <input type="checkbox" checked={!!value.spa} onChange={(e) => set({ spa: e.target.checked })} />
        <span>
          Send an fwknop SPA packet <small>— Single Packet Authorization; works on every device</small>
        </span>
      </label>
      {value.spa && (
        <div className="spa-box">
          <label>
            Encryption key <small>— KEY_BASE64 · paste the whole <code>fwknop --key-gen</code> output to fill both</small>
            <div className="spa-key-row">
              <input
                type="password"
                value={spaKeys.key ?? ""}
                onChange={(e) => onKey("key", e.target.value)}
                onPaste={onPasteKeys}
                placeholder={spaSaved.key ? "(saved — leave blank to keep)" : "KEY_BASE64"}
                spellCheck={false}
                autoComplete="off"
              />
              <label className="pre-check inline">
                <input
                  type="checkbox"
                  checked={value.spa_key_b64 ?? true}
                  onChange={(e) => set({ spa_key_b64: e.target.checked })}
                />
                base64
              </label>
            </div>
          </label>
          <label>
            HMAC key <small>— HMAC_KEY_BASE64</small>
            <div className="spa-key-row">
              <input
                type="password"
                value={spaKeys.hmac_key ?? ""}
                onChange={(e) => onKey("hmac_key", e.target.value)}
                onPaste={onPasteKeys}
                placeholder={spaSaved.hmac ? "(saved — leave blank to keep)" : "HMAC_KEY_BASE64"}
                spellCheck={false}
                autoComplete="off"
              />
              <select
                value={value.spa_hmac_digest ?? "sha256"}
                onChange={(e) => set({ spa_hmac_digest: e.target.value === "sha256" ? null : e.target.value })}
                title="HMAC digest (HMAC_DIGEST_TYPE)"
              >
                <option value="sha256">SHA-256</option>
                <option value="sha384">SHA-384</option>
                <option value="sha512">SHA-512</option>
                <option value="sha1">SHA-1</option>
              </select>
              <label className="pre-check inline">
                <input
                  type="checkbox"
                  checked={value.spa_hmac_b64 ?? true}
                  onChange={(e) => set({ spa_hmac_b64: e.target.checked })}
                />
                base64
              </label>
            </div>
          </label>
          <div className="spa-grid">
            <label>
              Open ports
              <input
                value={value.spa_access ?? ""}
                onChange={(e) => set({ spa_access: e.target.value || null })}
                placeholder={`tcp/${port || 22}`}
                spellCheck={false}
              />
            </label>
            <label>
              fwknopd port
              <input
                type="number"
                min={1}
                max={65535}
                value={value.spa_port ?? ""}
                onChange={(e) => set({ spa_port: Number(e.target.value) || null })}
                placeholder="62201"
              />
            </label>
            <label>
              Allow IP
              <input
                value={value.spa_allow_ip ?? ""}
                onChange={(e) => set({ spa_allow_ip: e.target.value || null })}
                placeholder="packet source"
                spellCheck={false}
              />
            </label>
            <label>
              Username
              <input
                value={value.spa_user ?? ""}
                onChange={(e) => set({ spa_user: e.target.value || null })}
                placeholder={user || "SSH user"}
                spellCheck={false}
              />
            </label>
            <label>
              Close after (sec)
              <input
                type="number"
                min={0}
                max={86400}
                value={value.spa_timeout ?? ""}
                onChange={(e) => set({ spa_timeout: Number(e.target.value) || null })}
                placeholder="server"
              />
            </label>
            <label>
              Wait after send (ms)
              <input
                type="number"
                min={0}
                max={10000}
                step={100}
                value={value.spa_wait_ms ?? ""}
                onChange={(e) => set({ spa_wait_ms: e.target.value === "" ? null : Number(e.target.value) })}
                placeholder="500"
              />
            </label>
          </div>
          <small className="settings-hint">
            Sent over UDP right before connecting (skipped through a jump host). Allow IP blank = the
            address fwknopd sees, which works behind NAT unless the server sets REQUIRE_SOURCE_ADDRESS.
          </small>
          {sErr && <span className="field-err">{sErr}</span>}
        </div>
      )}
      <div className="pre-actions">
        <button
          type="button"
          className="ghost"
          onClick={runTest}
          disabled={!!kErr || !!sErr || !host.trim() || test?.busy || !hasAny}
        >
          {test?.busy ? <Spinner size={12} /> : null} Test steps
        </button>
        {test && !test.busy && (
          <span className={test.ok ? "pre-ok" : "field-err"} style={{ whiteSpace: "pre-wrap" }}>
            {test.msg}
          </span>
        )}
      </div>
    </fieldset>
  );
}
