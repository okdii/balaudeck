import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

export type TunnelRoute = {
  /** "local" | "dynamic" | "remote" */
  mode: string;
  /** The endpoint on THIS machine (or the server-exposed port for remote). */
  source: string;
  /** The far endpoint the traffic reaches (or "anywhere" for dynamic). */
  target: string;
  /** Visually mark a route as live vs. a config preview. */
  active?: boolean;
  /** Optional id so a route can carry an action (e.g. Stop). */
  id?: string;
};

const MODE_LABEL: Record<string, string> = {
  local: "Local  -L",
  dynamic: "Dynamic  -D",
  remote: "Remote  -R",
};

/**
 * Cloudflare-tunnel-style topology: each forwarding route is a card on the left
 * that curves into the SSH-server hub on the right (like a Cloudflare "route →
 * tunnel" graph). Several routes through the same server fan into one hub. The
 * connectors are measured SVG beziers so the layout stays correct at any width
 * and with any number of routes.
 */
export function TunnelDiagram({
  server,
  via,
  routes,
  onRouteAction,
  actionLabel,
}: {
  /** The SSH server hub label, e.g. "deploy@10.0.0.4". */
  server: string;
  /** Optional jump host shown as a muted "via …" line under the hub. */
  via?: string | null;
  routes: TunnelRoute[];
  /** When set, each route card shows an action button (e.g. Stop). */
  onRouteAction?: (route: TunnelRoute) => void;
  actionLabel?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const hubRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [paths, setPaths] = useState<string[]>([]);
  const [box, setBox] = useState({ w: 0, h: 0 });

  const signature = JSON.stringify({ routes, server, via });

  useLayoutEffect(() => {
    function compute() {
      const wrap = wrapRef.current;
      const hub = hubRef.current;
      if (!wrap || !hub) return;
      const wb = wrap.getBoundingClientRect();
      const hb = hub.getBoundingClientRect();
      const hubX = hb.left - wb.left; // hub's left edge
      const hubY = hb.top - wb.top + hb.height / 2;
      const next = rowRefs.current.slice(0, routes.length).map((row) => {
        if (!row) return "";
        const rb = row.getBoundingClientRect();
        const x0 = rb.right - wb.left;
        const y0 = rb.top - wb.top + rb.height / 2;
        const dx = Math.max(22, (hubX - x0) * 0.5);
        return `M ${x0.toFixed(1)} ${y0.toFixed(1)} C ${(x0 + dx).toFixed(1)} ${y0.toFixed(1)}, ${(hubX - dx).toFixed(1)} ${hubY.toFixed(1)}, ${hubX.toFixed(1)} ${hubY.toFixed(1)}`;
      });
      setBox({ w: wb.width, h: wb.height });
      setPaths(next);
    }
    compute();
    const ro = new ResizeObserver(compute);
    if (wrapRef.current) ro.observe(wrapRef.current);
    // Fonts settling can shift widths after first paint.
    const t = window.setTimeout(compute, 60);
    return () => {
      ro.disconnect();
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  // Keep the ref array tight to the current routes.
  useEffect(() => {
    rowRefs.current = rowRefs.current.slice(0, routes.length);
  }, [routes.length]);

  return (
    <div className="tunnel-diagram" ref={wrapRef}>
      <svg className="td-svg" width={box.w} height={box.h} aria-hidden="true">
        {paths.map((d, i) => (d ? <path key={i} d={d} className="td-link" /> : null))}
      </svg>

      <div className="td-routes">
        {routes.map((r, i) => (
          <div
            className={"td-route" + (r.active ? " on" : "")}
            key={r.id ?? i}
            ref={(el) => {
              rowRefs.current[i] = el;
            }}
          >
            <span className={"td-badge " + (r.mode || "local")}>{MODE_LABEL[r.mode] ?? r.mode}</span>
            <span className="td-pill" title={r.source}>
              {r.source}
            </span>
            <span className="td-arrow">→</span>
            <span className="td-pill td-pill-target" title={r.target}>
              {r.target}
            </span>
            {onRouteAction && (
              <button className="td-stop" onClick={() => onRouteAction(r)} title={actionLabel ?? "Stop"}>
                <Icon name="power" size={12} />
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="td-hub" ref={hubRef}>
        <span className="td-hub-icon">
          <Icon name="server" size={17} />
        </span>
        <span className="td-hub-text">
          <b title={server}>{server}</b>
          {via && <small title={via}>via {via}</small>}
        </span>
      </div>
    </div>
  );
}
