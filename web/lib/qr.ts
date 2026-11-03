// QR codes drawn in the page: no outside service ever sees the deposit address.
import qrcode from "qrcode-generator";

export interface QrMatrix {
  size: number;
  dark: (row: number, col: number) => boolean;
}

export function qrMatrix(text: string): QrMatrix {
  const q = qrcode(0, "M");
  q.addData(text, "Byte");
  q.make();
  const size = q.getModuleCount();
  return { size, dark: (r, c) => q.isDark(r, c) };
}

/** An SVG path of the dark modules, one unit per module, with a 4-module quiet zone. */
export function qrPath(m: QrMatrix, quiet = 4): string {
  let d = "";
  for (let r = 0; r < m.size; r++) {
    for (let c = 0; c < m.size; c++) {
      if (m.dark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  return d;
}
