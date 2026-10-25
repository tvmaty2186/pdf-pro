// Un solo traductor de lugar.
// "Hoja derecha" (D): la página tal como se ve (con su giro /Rotate y su recorte CropBox ya aplicados), en puntos, con
// (0,0) abajo a la izquierda e y hacia arriba. El modo documento piensa todo en D (renglones horizontales, margen de
// abajo = y chico) y recién al escribir pasa a puntos del PDF (P); para dibujar en pantalla pasa por P a la vista de pdf.js.
// En una hoja sin girar ni recortar, D y P son lo mismo.
export class Lugar {
  // m: matriz D → P [a b c d e f]; ancho y alto de la hoja derecha
  constructor({ m = [1, 0, 0, 1, 0, 0], ancho = 595, alto = 842 } = {}) {
    this.m = m; this.ancho = ancho; this.alto = alto;
    const [a, b, c, d, e, f] = m, det = a * d - b * c;
    this.inv = [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
  }
  get identidad() { return this.m.every((v, i) => Math.abs(v - [1, 0, 0, 1, 0, 0][i]) < 1e-6); }
  static aplicar([a, b, c, d, e, f], x, y) { return [a * x + c * y + e, b * x + d * y + f]; }
  aPdf(x, y) { return Lugar.aplicar(this.m, x, y); }
  dePdf(x, y) { return Lugar.aplicar(this.inv, x, y); }
  static caja(pts) { const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; }
  rectAPdf([x0, y0, x1, y1]) { return Lugar.caja([[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(p => this.aPdf(...p))); }
  rectDePdf([x0, y0, x1, y1]) { return Lugar.caja([[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(p => this.dePdf(...p))); }
  // giro del texto escrito en D, para la matriz de texto del PDF (Tm a b c d)
  get giro() { return this.m.slice(0, 4); }
  // en la vista de pdf.js (píxeles de la página dibujada)
  enVista(v, x, y) { return v.convertToViewportPoint(...this.aPdf(x, y)); }
  // rect D → { left, top, width, height } en % de la página dibujada
  rectEnVista(v, r) {
    const [a, b, c, d] = v.convertToViewportRectangle(this.rectAPdf(r));
    return { left: Math.min(a, c) / v.width * 100, top: Math.min(b, d) / v.height * 100, width: Math.abs(c - a) / v.width * 100, height: Math.abs(d - b) / v.height * 100 };
  }
}
