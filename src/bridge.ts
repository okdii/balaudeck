// Open S3 and SFTP panes announce where they are (connection + current
// folder) so the other kind can send files straight there: "Copy to SFTP →
// web-01:/var/www" from an S3 pane, "Copy to S3 → minio:backups/2026/" from
// an SFTP pane. Bytes stream SFTP ⇄ S3 in the backend (bridge.rs).

import type { DbConnParams } from "./api";

export interface S3Target {
  kind: "s3";
  paneId: string;
  label: string;
  params: DbConnParams;
  bucket: string;
  prefix: string;
  refresh: () => void;
}

export interface SftpTarget {
  kind: "sftp";
  paneId: string;
  label: string;
  sessionId: string;
  dir: string;
  refresh: () => void;
}

export type BridgeTarget = S3Target | SftpTarget;

const targets = new Map<string, BridgeTarget>();
const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());

/** Announce (or update) a pane's current location; null withdraws it. */
export function setBridgeTarget(paneId: string, t: BridgeTarget | null) {
  if (t) targets.set(paneId, t);
  else targets.delete(paneId);
  notify();
}

export function s3Targets(): S3Target[] {
  return [...targets.values()].filter((t): t is S3Target => t.kind === "s3");
}

export function sftpTargets(): SftpTarget[] {
  return [...targets.values()].filter((t): t is SftpTarget => t.kind === "sftp");
}

export function subscribeBridge(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

/** "label — bucket/prefix" / "label — /dir" for menus. */
export function targetText(t: BridgeTarget): string {
  return t.kind === "s3" ? `${t.label} — ${t.bucket}/${t.prefix}` : `${t.label} — ${t.dir}`;
}
