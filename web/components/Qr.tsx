import { qrMatrix, qrPath } from "../lib/qr";

/** A QR code drawn as SVG in the page; no outside service is asked to draw it. */
export function Qr({ text, label }: { text: string; label: string }) {
  const m = qrMatrix(text);
  const n = m.size + 8;
  return (
    <svg className="qr" viewBox={`0 0 ${n} ${n}`} role="img" aria-label={label} data-testid="qr" data-text={text} shapeRendering="crispEdges">
      <rect width={n} height={n} />
      <path d={qrPath(m)} />
    </svg>
  );
}
