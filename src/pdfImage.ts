// A one-page PDF wrapping a single JPEG — enough for "export the diagram as
// PDF" without a PDF library. The JPEG goes in as-is (DCTDecode), the page is
// sized to the image so nothing is cropped or letterboxed.

const enc = new TextEncoder();

/** PDF pages can't exceed 14400pt a side; scale the page down to fit. */
export const PDF_MAX_PT = 14400;

export function jpegToPdf(
  jpeg: Uint8Array,
  pxW: number,
  pxH: number,
  pageW: number,
  pageH: number,
  title = "",
): Uint8Array {
  const f = Math.min(1, PDF_MAX_PT / Math.max(pageW, pageH));
  const W = +(pageW * f).toFixed(2);
  const H = +(pageH * f).toFixed(2);
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => "\\" + c).replace(/[^\x20-\x7e]/g, "?");
  const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
  const parts: (string | Uint8Array)[] = [];
  const offsets: number[] = [];
  let len = 0;
  const push = (p: string | Uint8Array) => {
    const b = typeof p === "string" ? enc.encode(p) : p;
    parts.push(b);
    len += b.length;
  };
  const obj = (n: number, body: string | (string | Uint8Array)[]) => {
    offsets[n] = len;
    push(`${n} 0 obj\n`);
    for (const p of Array.isArray(body) ? body : [body]) push(p);
    push("\nendobj\n");
  };
  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  obj(4, [
    `<< /Type /XObject /Subtype /Image /Width ${pxW} /Height ${pxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
    jpeg,
    "\nendstream",
  ]);
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  obj(6, `<< /Title (${esc(title)}) /Producer (BalauDeck) >>`);
  const xref = len;
  let x = `xref\n0 7\n0000000000 65535 f \n`;
  for (let i = 1; i <= 6; i++) x += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  push(x);
  push(`trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p as Uint8Array, o);
    o += (p as Uint8Array).length;
  }
  return out;
}
