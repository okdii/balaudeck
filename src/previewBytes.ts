// Bytes of a PDF / image preview. The backend sends them as raw IPC bytes
// (`blob:<id>` in the preview JSON, fetched once with preview_blob_take);
// older payloads were base64. Fetched bytes are memoised per reference so a
// re-mounted viewer (pane moved, tab switched) doesn't need a second fetch.

import { invoke } from "@tauri-apps/api/core";

const cache = new Map<string, Promise<Uint8Array>>();
const KEEP = 6;

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function previewBytes(content: string): Promise<Uint8Array> {
  if (!content.startsWith("blob:")) return Promise.resolve(base64ToBytes(content));
  let p = cache.get(content);
  if (!p) {
    p = invoke<ArrayBuffer>("preview_blob_take", { id: content }).then((b) => new Uint8Array(b));
    p.catch(() => cache.delete(content));
    cache.set(content, p);
    while (cache.size > KEEP) cache.delete(cache.keys().next().value as string);
  }
  return p;
}
