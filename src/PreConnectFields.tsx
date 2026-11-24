// Profile editor section: "Before connecting" — a local command (VPN up,
// cloud firewall open…) and/or a port-knock sequence, run by the backend on
// every connect of the profile (src-tauri/src/preconnect.rs).

import { useState } from "react";
import { api } from "./api";
import { Spinner } from "./Icon";
import type { PreConnect } from "./types";
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

export function PreConnectFields({
  value,
  onChange,
  host,
  port,
  user,
}: {
  value: PreConnect;
  onChange: (v: PreConnect) => void;
  host: string;
  port: number;
  user: string;
}) {
  const hasAny = !!(value.knock_ports?.trim() || value.pre_connect?.trim());
  const [open, setOpen] = useState(hasAny);
  const [test, setTest] = useState<{ busy: boolean; msg: string; ok: boolean } | null>(null);
  const kErr = knockError(value.knock_ports ?? "");
  const set = (p: Partial<PreConnect>) => onChange({ ...value, ...p });

  async function runTest() {
    setTest({ busy: true, msg: "", ok: false });
    try {
      await api.preconnectTest(value, host.trim(), port, user.trim());
      setTest({ busy: false, ok: true, msg: "Done — the steps ran without errors." });
    } catch (e) {
      setTest({ busy: false, ok: false, msg: String(e) });
    }
  }

  if (!open) {
    return (
      <button type="button" className="ghost pre-toggle" onClick={() => setOpen(true)}>
        + Before connecting (port knock{preCommandAvailable ? ", VPN or other command" : ""})
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
      <div className="pre-actions">
        <button
          type="button"
          className="ghost"
          onClick={runTest}
          disabled={!!kErr || !host.trim() || test?.busy || !hasAny}
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
