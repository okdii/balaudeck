import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { Icon } from "./Icon";

/** Decode a base64 payload to bytes — atob loop, since WebViews have no Buffer. */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** In-panel PDF viewer backed by bundled pdf.js — Linux webkitgtk and the
 *  Android WebView ship no native PDF plugin, so an <embed> would show nothing.
 *  pdf.js (and its worker) load lazily on first use to keep the main bundle
 *  small; one page renders to a canvas at a time behind a Prev/Next pager. */
export function PdfPreview({ data, name }: { data: string; name: string }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState("");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fitRef = useRef<HTMLDivElement | null>(null);
  // Bumped (debounced) when the container resizes so the current page re-fits.
  const [fitRev, setFitRev] = useState(0);
  const lastFitWidthRef = useRef(0);
  // Hard busy-guard mirroring `rendering` — a ref flips synchronously, so two
  // rapid clicks can't both slip through before React re-renders the buttons.
  const busyRef = useRef(false);

  // Parse the document. The pdf.js import stays inside the effect so Vite
  // splits it into a lazy chunk that only loads when a PDF is actually opened.
  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    setDoc(null);
    setPage(1);
    setError("");
    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        // Vite's ?url import points the worker at the emitted asset file.
        const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        const d = await pdfjs.getDocument({ data: base64ToBytes(data) }).promise;
        if (cancelled) {
          d.destroy();
          return;
        }
        loaded = d;
        setDoc(d);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
      loaded?.destroy();
    };
  }, [data]);

  // Re-fit on container resize (window resize, sidebar collapse, split drag).
  // Keyed on `doc` because the fitRef div only exists once the document loads.
  useEffect(() => {
    const el = fitRef.current;
    if (!doc || !el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      // Ignore hidden panes (w=0) and the initial no-op fire on observe().
      if (!w || w === lastFitWidthRef.current) return;
      clearTimeout(timer);
      timer = setTimeout(() => setFitRev((r) => r + 1), 150);
    });
    ro.observe(el);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
    };
  }, [doc]);

  // Draw the current page. `page` only changes while idle (the pager guards),
  // so two renders never race on the shared canvas; a leftover in-flight task
  // is cancelled if the document is swapped out from underneath it.
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    busyRef.current = true;
    setRendering(true);
    (async () => {
      try {
        const p = await doc.getPage(page);
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        // Fit the page to the container width; the canvas backing store is
        // scaled by devicePixelRatio so text stays sharp on hidpi screens.
        const base = p.getViewport({ scale: 1 });
        const width = fitRef.current?.clientWidth || base.width;
        lastFitWidthRef.current = fitRef.current?.clientWidth || 0;
        const dpr = window.devicePixelRatio || 1;
        const viewport = p.getViewport({ scale: (width / base.width) * dpr });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
        canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        task = p.render({ canvasContext: ctx, viewport });
        await task.promise;
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        busyRef.current = false;
        if (!cancelled) setRendering(false);
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page, fitRev]);

  function go(delta: number) {
    if (!doc || busyRef.current) return;
    setPage((p) => Math.min(Math.max(p + delta, 1), doc.numPages));
  }

  if (error) return <pre className="error">{error}</pre>;
  if (!doc) return <p className="empty">Loading PDF…</p>;

  return (
    <>
      <div className="form-row">
        <button className="ghost" onClick={() => go(-1)} disabled={page <= 1 || rendering}>
          <Icon name="back" size={14} /> Prev
        </button>
        <span>
          Page {page} / {doc.numPages}
        </span>
        <button
          className="ghost"
          onClick={() => go(1)}
          disabled={page >= doc.numPages || rendering}
        >
          Next <Icon name="chevronRight" size={14} />
        </button>
      </div>
      <div className="mongo-docs">
        <div ref={fitRef}>
          <canvas ref={canvasRef} aria-label={name} />
        </div>
      </div>
    </>
  );
}
