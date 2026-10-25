// pdf.pro — cuentagotas de letra: se toca un texto de la hoja y se copia su letra, tamaño y color.
// Si la fuente del PDF está en la compu (o en Mis fuentes), va esa. Si no (o el PDF trae solo algunas letras), se
// dibuja el renglón con las letras que hay y gana la que más coincide punto por punto con lo que se ve; se dice cuál.

const COMUNES = ['Times New Roman', 'Arial', 'Calibri', 'Cambria', 'Georgia', 'Verdana', 'Tahoma', 'Garamond', 'Book Antiqua', 'Century Gothic', 'Arial Narrow', 'Courier New', 'Segoe UI'];
const aHex = c => '#' + (c || [0, 0, 0]).map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
export const NOMBRE_BASICA = { sans: 'Sans (Helvetica)', serif: 'Serif (Times)', mono: 'Mono (Courier)' };

// El renglón de la hoja que está en el punto (en puntos del PDF), o el más cercano a menos de 6 puntos
export function renglonEn(lineas, [x, y]) {
  const dist = l => { const [x0, y0, x1, y1] = l.rect; return Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(y0 - y, 0, y - y1)); };
  const cerca = lineas.map(l => ({ l, d: dist(l) })).filter(o => o.d <= 6).sort((a, b) => a.d - b.d);
  return cerca[0]?.l || null;
}

// La letra para escribir como ese renglón: { letra: 'f:Familia' | 'sans' | 'serif' | 'mono', tam, color, nombre, como }
// como: 'igual' (la misma fuente, instalada) o 'forma' (la más parecida por la forma de las letras)
export async function letraDeRenglon(linea, { fuentes, pagina }) {
  const f = linea.fuente || {}, tam = Math.round((f.size || 11) * 2) / 2, color = aHex(linea.color);
  await fuentes.cargar().catch(() => {});
  const fam = fuentes.parecida(f.name);
  if (fam) return { letra: 'f:' + fam.familia, tam, color, nombre: fam.familia, como: 'igual', negrita: f.weight === 'bold' };
  const mejor = await porForma(linea, pagina, fuentes, f.weight === 'bold', f.style === 'italic');
  const basica = f.family === 'monospace' ? 'mono' : f.family === 'serif' ? 'serif' : 'sans';
  const letra = mejor?.clave || basica;
  return { letra, tam: mejor?.tam || tam, color, nombre: letra.startsWith('f:') ? letra.slice(2) : NOMBRE_BASICA[letra], como: 'forma', original: String(f.name || '').replace(/^[A-Z]{6}\+/, '') };
}

// Compara lo dibujado en la hoja con el mismo texto escrito en cada letra candidata (como el editor con los escaneos)
async function porForma(linea, pagina, fuentes, negrita, cursiva) {
  const tamPdf = linea.fuente?.size;
  const lienzo = pagina?.div?.querySelector('canvas'), v = pagina?.vista;
  if (!lienzo || !v || !linea.texto?.trim()) return null;
  const f = lienzo.width / v.width;
  const [a, b, c, d] = v.convertToViewportRectangle(linea.rect);
  const x0 = Math.max(0, Math.floor(Math.min(a, c) * f) - 2), y0 = Math.max(0, Math.floor(Math.min(b, d) * f) - 2);
  const w = Math.min(lienzo.width - x0, Math.ceil(Math.abs(c - a) * f) + 4), h = Math.min(lienzo.height - y0, Math.ceil(Math.abs(d - b) * f) + 4);
  if (w < 10 || h < 4) return null;
  const px = lienzo.getContext('2d', { willReadFrequently: true }).getImageData(x0, y0, w, h).data;
  const lum = k => 0.299 * px[k * 4] + 0.587 * px[k * 4 + 1] + 0.114 * px[k * 4 + 2];
  const lums = Array.from({ length: w * h }, (_, k) => lum(k)), orden = [...lums].sort((p, q) => p - q);
  const tinta = orden[Math.floor(orden.length * 0.03)], papel = orden[Math.floor(orden.length * 0.9)];
  if (papel - tinta < 40) return null; // no se distingue la letra del fondo
  const corte = (papel + tinta) / 2, tintaImg = lums.map(l => l < corte ? 1 : 0);
  const [bx, by] = v.convertToViewportPoint(linea.base[0], linea.base[1]), base = by * f - y0, inicio = bx * f - x0, ocupa = Math.abs(c - a) * f;
  const candidatas = ['serif', 'sans', 'mono', ...COMUNES.filter(n => fuentes.familia(n)).map(n => 'f:' + n), ...[...(fuentes.biblioteca?.keys() || [])].map(n => 'f:' + n)];
  const lienzo2 = new OffscreenCanvas(w, h), g = lienzo2.getContext('2d', { willReadFrequently: true });
  const peso = `${cursiva ? 'italic ' : ''}${negrita ? 700 : 400}`;
  let mejor = null;
  for (const clave of [...new Set(candidatas)]) {
    const css = await fuentes.css(clave, negrita, cursiva);
    // al tamaño que dice el PDF (estirar al ancho del renglón favorece a las letras anchas si hay espacios al final)
    const tamPx = tamPdf ? tamPdf * v.scale * f : (g.font = `${peso} 100px ${css}`, 100 * ocupa / Math.max(1, g.measureText(linea.texto).width));
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.fillStyle = '#000'; g.font = `${peso} ${tamPx}px ${css}`; g.textBaseline = 'alphabetic';
    g.fillText(linea.texto, inicio, base);
    const q = g.getImageData(0, 0, w, h).data;
    let ambos = 0, a1 = 0, a2 = 0;
    for (let k = 0; k < w * h; k++) { const t2 = q[k * 4] < 128 ? 1 : 0; a1 += tintaImg[k]; a2 += t2; if (t2 && tintaImg[k]) ambos++; }
    const parecido = 2 * ambos / Math.max(1, a1 + a2);
    if (!mejor || parecido > mejor.parecido) mejor = { clave, tam: Math.round(tamPx / (v.scale * f) * 2) / 2, parecido };
  }
  return mejor;
}
