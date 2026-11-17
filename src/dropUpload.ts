import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Drag-and-drop uploads from Finder / Explorer / the Files app.
 *
 * Dropped items arrive as browser File objects without filesystem paths, so we
 * stream them into a backend staging dir (mirroring dropped folders) and then
 * hand the staged paths to the normal SFTP/S3 upload commands.
 */

export interface DroppedFile {
  /** Path relative to the drop root, "/"-separated: "a.txt" or "folder/sub/b.txt". */
  rel: string;
  file: File;
}
export interface DropTree {
  files: DroppedFile[];
  /** Folder paths (relative), including empty ones — so they're recreated. */
  dirs: string[];
  /** The top-level names dropped, with whether each is a folder. */
  tops: { name: string; isDir: boolean }[];
}

/** True while dragging something that carries files (not an in-app tab drag). */
export function isFileDrag(e: { dataTransfer: DataTransfer | null }): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
}

type Entry = FileSystemEntry;

function readAllEntries(dir: FileSystemDirectoryEntry): Promise<Entry[]> {
  const reader = dir.createReader();
  const out: Entry[] = [];
  return new Promise((resolve, reject) => {
    // readEntries returns batches (≤100 in Chromium); call until empty.
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(out);
        else {
          out.push(...batch);
          next();
        }
      }, reject);
    next();
  });
}

function entryFile(e: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => e.file(resolve, reject));
}

/** Walk a drop's items (files and whole folders) into a flat tree. Must be
 *  called synchronously from the drop handler — DataTransfer items expire
 *  once the event returns, so grab the entries first. */
export function readDrop(dt: DataTransfer): Promise<DropTree> {
  const entries: Entry[] = [];
  const loose: File[] = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind !== "file") continue;
    const en = item.webkitGetAsEntry?.();
    if (en) entries.push(en);
    else {
      const f = item.getAsFile();
      if (f) loose.push(f);
    }
  }
  if (entries.length === 0 && loose.length === 0) loose.push(...Array.from(dt.files));

  return (async () => {
    const tree: DropTree = { files: [], dirs: [], tops: [] };
    const walk = async (en: Entry, rel: string) => {
      if (en.isFile) {
        tree.files.push({ rel, file: await entryFile(en as FileSystemFileEntry) });
      } else if (en.isDirectory) {
        tree.dirs.push(rel);
        for (const child of await readAllEntries(en as FileSystemDirectoryEntry)) {
          await walk(child, `${rel}/${child.name}`);
        }
      }
    };
    for (const en of entries) {
      tree.tops.push({ name: en.name, isDir: en.isDirectory });
      await walk(en, en.name);
    }
    for (const f of loose) {
      tree.tops.push({ name: f.name, isDir: false });
      tree.files.push({ rel: f.name, file: f });
    }
    return tree;
  })();
}

const CHUNK = 4 * 1024 * 1024;

export interface StagedDrop {
  /** Backend staging dir; call `cleanupStage(dir)` when the uploads settle. */
  dir: string;
  /** Absolute staged path of each top-level item. */
  tops: { name: string; isDir: boolean; path: string }[];
  /** Absolute staged path of every file, with its drop-relative path. */
  files: { rel: string; path: string }[];
}

/** Copy a dropped tree into a staging dir. `onProgress(done, total)` in bytes. */
export async function stageDrop(tree: DropTree, onProgress?: (done: number, total: number) => void): Promise<StagedDrop> {
  const dir = await invoke<string>("stage_new");
  const sep = dir.includes("\\") ? "\\" : "/";
  const abs = (rel: string) => dir + sep + rel.split("/").join(sep);
  const total = tree.files.reduce((n, f) => n + f.file.size, 0);
  let done = 0;
  try {
    for (const d of tree.dirs) await invoke("stage_mkdir", { dir, rel: d });
    for (const f of tree.files) {
      const rel = encodeURIComponent(f.rel);
      let off = 0;
      do {
        const end = Math.min(f.file.size, off + CHUNK);
        const buf = new Uint8Array(await f.file.slice(off, end).arrayBuffer());
        await invoke("stage_write", buf, { headers: { "x-dir": dir, "x-rel": rel, "x-offset": String(off) } });
        done += end - off;
        off = end;
        onProgress?.(done, total);
      } while (off < f.file.size);
    }
  } catch (e) {
    void cleanupStage(dir);
    throw e;
  }
  return {
    dir,
    tops: tree.tops.map((t) => ({ ...t, path: abs(t.name) })),
    files: tree.files.map((f) => ({ rel: f.rel, path: abs(f.rel) })),
  };
}

export function cleanupStage(dir: string): Promise<void> {
  return invoke<void>("stage_cleanup", { dir }).catch(() => {});
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Drop-zone handlers for a panel. `dragging` is true while files hover over
 * it (enter/leave are counted so child elements don't flicker it off).
 * In-app drags (tabs, panes) are ignored — only real file drags count.
 */
export function useFileDrop(enabled: boolean, onDrop: (tree: DropTree) => void) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const cb = useRef(onDrop);
  cb.current = onDrop;
  const handlers = {
    onDragEnter: (e: React.DragEvent) => {
      if (!enabled || !isFileDrag(e)) return;
      e.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!enabled || !isFileDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!enabled || !isFileDrag(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (!enabled || !isFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      depth.current = 0;
      setDragging(false);
      void readDrop(e.dataTransfer).then((t) => {
        if (t.files.length || t.dirs.length) cb.current(t);
      });
    },
  };
  return { dragging, handlers };
}
