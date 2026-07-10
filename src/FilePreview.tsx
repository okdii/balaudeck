import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { PdfPreview } from "./PdfPreview";
import { maskText, redactText } from "./privacy";
import type { S3Preview } from "./types";

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/**
 * Shared preview pane for a fetched file — text, image, PDF, or a
 * binary/too-large fallback. Used by both the S3 and SFTP browsers so the two
 * file panels render previews identically; each supplies its own backend that
 * returns the same `S3Preview` shape.
 */
export function FilePreview({
  data,
  name,
  meta,
  onBack,
  onDownload,
  downloadDisabled,
}: {
  data: S3Preview;
  /** Basename, used as the image alt text and PDF label. */
  name: string;
  /** Leading text of the meta line (e.g. the masked key/path). */
  meta: ReactNode;
  onBack: () => void;
  onDownload: () => void;
  downloadDisabled?: boolean;
}) {
  // An image sniffed purely by extension (SFTP has no server content type) may
  // not actually be a decodable image; fall back to the download hint instead of
  // a broken-image glyph.
  const [imgError, setImgError] = useState(false);
  useEffect(() => setImgError(false), [data.content]);

  // Escape returns to the file list — the preview replaces the whole grid, and
  // keyboard/iPad-with-keyboard users expect Esc to dismiss an overlay view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  // Privacy masking never reaches HTML attributes, so redact the filename before
  // it lands in alt / aria-label (it's the one name in the preview that escapes
  // the visual mask).
  const safeName = redactText(name);

  return (
    <>
      <div className="form-row">
        <button className="ghost" onClick={onBack}>
          <Icon name="back" size={14} /> Back
        </button>
        <button className="ghost" onClick={onDownload} disabled={downloadDisabled}>
          <Icon name="download" size={14} /> Download
        </button>
      </div>
      <div className="mongo-meta">
        {meta} · {data.content_type} · {fmtSize(data.size)}
        {data.truncated ? " · truncated" : ""}
      </div>
      {data.kind === "text" && (
        <div className="mongo-docs">
          <pre className="mongo-doc">{maskText(data.content)}</pre>
        </div>
      )}
      {data.kind === "image" &&
        (imgError ? (
          <p className="empty">Can't render this image — use Download.</p>
        ) : (
          <div className="mongo-docs">
            <img
              className="s3-preview-img"
              src={`data:${data.content_type};base64,${data.content}`}
              alt={safeName}
              onError={() => setImgError(true)}
            />
          </div>
        ))}
      {data.kind === "pdf" && <PdfPreview data={data.content} name={safeName} />}
      {(data.kind === "binary" || data.kind === "too-large") && (
        <p className="empty">
          {data.kind === "too-large"
            ? "Too large to preview — use Download."
            : "Binary content — no preview. Use Download."}
        </p>
      )}
    </>
  );
}
