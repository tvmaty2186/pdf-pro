// PDF.Pro — trabajos con MuPDF. Corren en un proceso aparte (motor.js): si MuPDF se cuelga o se queda sin memoria
// con un documento, se cae solo ese proceso; el programa sigue y el archivo original queda intacto.
// Se registran con handle(nombre, fn) igual que los ipcMain.handle de main.js (el primer argumento no se usa).
const crypto = require('crypto');

module.exports = function registrar(ipcMain) {
// solo en las pruebas automáticas: tirar el motor a propósito para ver que el programa se recupera
if (process.env.PDFPRO_CAPTURA) ipcMain.handle('motor-caer', () => process.exit(3));
ipcMain.handle('controlar-pdf', (_e, datos, control) => controlarPdf(datos, control));
ipcMain.handle('pdf-a-office', async (_e, tipo, datos) => {
  const conv = require('./convertir.js'), d = await abrirMu(datos);
  try { return tipo === 'xlsx' ? conv.pdfAExcel(await mu(), d) : conv.pdfAWord(await mu(), d); } finally { d.destroy(); }
});
async function controlarPdf(datos, { paginas, clave } = {}) {
  const d = await abrirMu(datos);
  try {
    if (d.needsPassword() && !d.authenticatePassword(clave || '')) throw new Error('no abre con su contraseña');
    const n = d.countPages();
    if (!n || (paginas && n !== paginas)) throw new Error(`tiene ${n} páginas y tenía que tener ${paginas}`);
    d.loadPage(0).getBounds();
  } finally { d.destroy(); }
}

let mupdfMod = null;
const mu = async () => (mupdfMod ||= await import('mupdf'));
async function abrirMu(datos) { const m = await mu(); return m.Document.openDocument(Buffer.from(datos), 'application/pdf'); }
ipcMain.handle('clave-info', async (_e, datos) => {
  const d = await abrirMu(datos);
  try { const metodo = d.getMetaData('encryption') || 'None'; return { cifrado: metodo !== 'None', necesitaClave: d.needsPassword() }; }
  finally { d.destroy(); }
});
// Devuelve el PDF sin cifrar y cómo estaba protegido (permisos: número P del PDF, o null si permitía todo)
ipcMain.handle('clave-quitar', async (_e, datos, clave) => {
  const d = await abrirMu(datos);
  try {
    // authenticatePassword: 2 = clave para abrir, 4 = clave de dueño (las dos = 6)
    const tipo = d.needsPassword() ? d.authenticatePassword(clave || '') : 0;
    if (d.needsPassword() && !tipo) return { error: 'clave' };
    const pdf = d.asPDF();
    let permisos = null;
    try { const P = pdf.getTrailer().get('Encrypt').get('P').asNumber(); if (Number.isInteger(P) && P >= -0x80000000 && P <= 0x7fffffff && (P | 0) !== -1) permisos = P | 0; } catch {}
    return { datos: pdf.saveToBuffer('encrypt=none').asUint8Array(), permisos, abrir: !!clave, duenio: !!(tipo & 4) && !(tipo & 2) };
  } finally { d.destroy(); }
});
// Cifra con AES-256. clave: para abrir (vacía = se abre sin clave); permisos: restricciones (null = ninguna)
// ¿Tiene firmas digitales (con certificado)? Si se cambia y se guarda, dejan de valer: se avisa al abrir.
ipcMain.handle('firmas-digitales', async (_e, datos) => {
  const d = await abrirMu(datos);
  try {
    let n = 0;
    const revisar = (campo, prof = 0) => {
      campo = campo.resolve();
      const ft = campo.get('FT'), v = campo.get('V');
      if (!ft.isNull() && ft.asName() === 'Sig' && !v.isNull()) n++;
      const hijos = campo.get('Kids');
      if (!hijos.isNull() && prof < 6) hijos.resolve().forEach(k => revisar(k, prof + 1));
    };
    const campos = d.asPDF().getTrailer().get('Root').get('AcroForm').get('Fields');
    if (!campos.isNull()) campos.resolve().forEach(c => revisar(c));
    return n;
  } catch { return 0; } finally { d.destroy(); }
});
ipcMain.handle('clave-poner', async (_e, datos, { clave = '', permisos = null, duenio: claveDuenio = '' } = {}) => {
  if (!clave && permisos == null) return datos;
  const usuario = clave, duenio = claveDuenio || (clave && permisos == null ? clave : crypto.randomBytes(16).toString('hex'));
  // MuPDF lee las opciones separadas por comas: una contraseña con coma se cifra con una provisoria y después se cambia
  const conComa = /,/.test(usuario + duenio);
  const provU = conComa && usuario ? 'p' + crypto.randomBytes(12).toString('hex') : usuario, provD = conComa ? 'd' + crypto.randomBytes(12).toString('hex') : duenio;
  const d = await abrirMu(datos);
  let cifrado;
  try {
    const op = `encrypt=aes-256,owner-password=${provD}` + (usuario ? `,user-password=${provU}` : '') + (permisos != null ? `,permissions=${permisos}` : '');
    cifrado = d.asPDF().saveToBuffer(op).asUint8Array();
  } finally { d.destroy(); }
  return conComa ? cambiarClaves(cifrado, provD, usuario, duenio) : cifrado;
});
// AES-256 (PDF 2.0, revisión 6): la clave del archivo no cambia; se vuelven a calcular U/UE (usuario) y O/OE (dueño)
function hashClave(clave, sal, extra) { // ISO 32000-2, algoritmo 2.B
  const P = Buffer.from(clave, 'utf8').subarray(0, 127);
  let K = crypto.createHash('sha256').update(Buffer.concat([P, sal, extra])).digest();
  for (let i = 0; ; i++) {
    const c = crypto.createCipheriv('aes-128-cbc', K.subarray(0, 16), K.subarray(16, 32)); c.setAutoPadding(false);
    const E = Buffer.concat([c.update(Buffer.concat(Array(64).fill(Buffer.concat([P, K, extra])))), c.final()]);
    let s = 0; for (let j = 0; j < 16; j++) s += E[j];
    K = crypto.createHash(['sha256', 'sha384', 'sha512'][s % 3]).update(E).digest();
    if (i >= 63 && E[E.length - 1] <= i - 32) break;
  }
  return K.subarray(0, 32);
}
const aes256 = (descifrar, clave, datos) => { const c = (descifrar ? crypto.createDecipheriv : crypto.createCipheriv)('aes-256-cbc', clave, Buffer.alloc(16)); c.setAutoPadding(false); return Buffer.concat([c.update(datos), c.final()]); };
async function cambiarClaves(cifrado, provDuenio, usuario, duenio) {
  const d = await abrirMu(cifrado);
  try {
    if (!d.authenticatePassword(provDuenio)) throw new Error('No se pudo poner la contraseña.');
    const pdf = d.asPDF(), enc = pdf.getTrailer().get('Encrypt').resolve(), leer = k => Buffer.from(enc.get(k).asByteString?.() ?? enc.get(k).asString());
    const O = leer('O'), nada = Buffer.alloc(0);
    const archivo = aes256(true, hashClave(provDuenio, O.subarray(40, 48), leer('U')), leer('OE')); // la clave del archivo, por el lado del dueño
    const al = () => crypto.randomBytes(8);
    const [uv, uk, ov, ok] = [al(), al(), al(), al()];
    const U = Buffer.concat([hashClave(usuario, uv, nada), uv, uk]), UE = aes256(false, hashClave(usuario, uk, nada), archivo);
    const nO = Buffer.concat([hashClave(duenio, ov, U), ov, ok]), OE = aes256(false, hashClave(duenio, ok, U), archivo);
    for (const [k, v] of [['U', U], ['UE', UE], ['O', nO], ['OE', OE]]) enc.put(k, pdf.newByteString([...v]));
    return pdf.saveToBuffer('').asUint8Array();
  } finally { d.destroy(); }
}


// ---- Editar texto e imágenes (MuPDF): qué hay en una página, borrar zonas y sacar imágenes ----
// MuPDF mide desde arriba a la izquierda; el visor usa puntos del PDF (desde abajo). getTransform pasa de PDF a MuPDF.
const invertir = ([a, b, c, d, e, f]) => { const k = a * d - b * c; return [d / k, -b / k, -c / k, a / k, (c * f - d * e) / k, (b * e - a * f) / k]; };
const transformar = ([a, b, c, d, e, f], x, y) => [a * x + c * y + e, b * x + d * y + f];
const rectCon = (m, x0, y0, x1, y1) => { const p = transformar(m, x0, y0), q = transformar(m, x1, y1); return [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])]; };
// Renglones partidos en pedazos (la etiqueta impresa, la raya de completar y lo escrito quedan separados) e imágenes
ipcMain.handle('pagina-contenido', async (_e, datos, n) => {
  const d = await abrirMu(datos);
  try {
    const pg = d.loadPage(n - 1), m = invertir(pg.getTransform()), [, , anchoP, altoP] = pg.getBounds();
    const lineas = [], imagenes = [];
    let seg = null, finAnterior = null, saltar = false, espacio = false;
    const cerrar = () => {
      if (seg && seg.texto.trim()) lineas.push({ texto: seg.texto.trim(), rect: rectCon(m, seg.x0, seg.y0, seg.x1, seg.y1), base: transformar(m, ...seg.base),
        fuente: { name: seg.f.getName(), size: seg.tam, weight: seg.f.isBold() ? 'bold' : 'normal', style: seg.f.isItalic() ? 'italic' : 'normal',
          family: seg.f.isMono() ? 'monospace' : seg.f.isSerif() ? 'serif' : 'sans-serif' }, color: seg.color });
      seg = null;
    };
    const rgb = c => !c ? null : c.length === 1 ? [c[0], c[0], c[0]] : c.length === 4 ? [0, 1, 2].map(i => (1 - c[i]) * (1 - c[3])) : c.slice(0, 3);
    pg.toStructuredText('preserve-images').walk({
      onImageBlock(b) { imagenes.push({ indice: imagenes.length, rect: rectCon(m, ...b), entera: (b[2] - b[0]) * (b[3] - b[1]) > anchoP * altoP * 0.8 }); },
      beginLine(_b, wmode, dir) { cerrar(); finAnterior = null; espacio = false; saltar = !!wmode || Math.abs(dir[1]) > 0.1; },
      onChar(c, origen, f, tam, q, color) {
        if (saltar) return;
        const x0 = Math.min(q[0], q[4]), x1 = Math.max(q[2], q[6]), y0 = Math.min(q[1], q[3]), y1 = Math.max(q[5], q[7]), raya = c === '_';
        if (c === ' ') { if (seg) espacio = true; if (!seg) return; }
        // también se corta después de "Etiqueta:" (en escaneos la etiqueta y lo escrito suelen venir juntos)
        const tras2puntos = c !== ' ' && espacio && /:\s*$/.test(seg?.texto || '');
        const corte = !seg || (finAnterior != null && x0 - finAnterior > Math.max(tam * 0.8, 2)) || raya !== seg.raya || Math.abs(tam - seg.tam) > 0.6 || tras2puntos;
        if (c !== ' ') espacio = false;
        if (corte) { cerrar(); seg = { texto: '', x0, y0, x1, y1, base: origen, tam, raya, f, color: rgb(color) }; }
        seg.texto += c; seg.x0 = Math.min(seg.x0, x0); seg.y0 = Math.min(seg.y0, y0); seg.x1 = Math.max(seg.x1, x1); seg.y1 = Math.max(seg.y1, y1);
        if (c !== ' ') finAnterior = x1;
      },
      endLine() { cerrar(); }
    });
    let ocr = false;
    try { ocr = !!d.asPDF().findPage(n - 1).get('PDFProOCR')?.asBoolean?.(); } catch {}
    return { lineas, imagenes, ocr };
  } finally { d.destroy(); }
});
// Letras que no se ven: invisibles (salvo el texto reconocido sobre un escaneo) o tapadas por algo opaco dibujado
// después (un recuadro blanco encima de un dato viejo). Se recorre la página en orden y se anota quién va arriba.
async function letrasOcultas(pg) {
  const m = await mu(), glifos = new Map(), tapas = [], imagenes = [], bordes = [];
  const raya = r => { if (r[2] - r[0] < 2.5 && r[3] - r[1] > 6) bordes.push(r); };
  let orden = 0, raro = 0;
  const clave = (x, y, u) => Math.round(x * 2) + '|' + Math.round(y * 2) + '|' + u;
  const anotar = (t, ctm, visible) => {
    const o = orden++;
    t.walk({ showGlyph(_f, trm, _g, u) { const [x, y] = transformar(ctm, trm[4], trm[5]); const k = clave(x, y, u); if (!glifos.has(k)) glifos.set(k, []); glifos.get(k).push({ o, visible }); } });
  };
  const caja = ctm => { const p = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => transformar(ctm, x, y)); return [Math.min(...p.map(v => v[0])), Math.min(...p.map(v => v[1])), Math.max(...p.map(v => v[0])), Math.max(...p.map(v => v[1]))]; };
  try {
    const dev = new m.Device({
      fillText(t, ctm, _cs, _c, alpha) { anotar(t, ctm, alpha > 0.05); },
      strokeText(t, _s, ctm) { anotar(t, ctm, true); },
      clipText(t, ctm) { anotar(t, ctm, false); },
      clipStrokeText(t, _s, ctm) { anotar(t, ctm, false); },
      ignoreText(t, ctm) { anotar(t, ctm, false); },
      fillPath(p, _eo, ctm, _cs, _c, alpha) { const r = p.getBounds(null, ctm); raya(r); if (!raro && alpha > 0.99) tapas.push({ o: orden++, r }); },
      strokePath(p, st, ctm) { raya(p.getBounds(st, ctm)); },
      fillImage(_i, ctm) { imagenes.push({ o: orden++, r: caja(ctm) }); },
      beginGroup(_a, _cs, _iso, _ko, modo, alpha) { if (raro || modo !== 'Normal' || alpha < 0.99) raro++; },
      endGroup() { if (raro) raro--; },
      beginMask() { raro++; }, endMask() { if (raro) raro--; }
    });
    pg.run(dev, m.Matrix.identity); dev.close();
  } catch (e) { console.error('letrasOcultas', e); return Object.assign(() => false, { bordes: [] }); }
  const dentro = (r, x, y) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
  const oculta = (o, c, tam = 10) => {
    // la misma letra en el mismo lugar dos veces (dato viejo tapado y el nuevo encima): se toman en el orden en que se dibujaron
    const g = glifos.get(clave(o[0], o[1], c.codePointAt(0)))?.shift();
    if (!g) return false;
    if (!g.visible && !imagenes.some(im => im.o < g.o && dentro(im.r, o[0], o[1]))) return true;
    return tapas.some(t => t.o > g.o && dentro(t.r, o[0] + tam * 0.2, o[1] - tam * 0.3));
  };
  oculta.bordes = bordes; // rayas verticales finas (bordes de celdas), para saber si un renglón está pegado a una
  return oculta;
}
// Letra de código de barras (o un texto con su forma: #.123.456.#, *ABC123*): es un dibujo, no se edita
const esBarras = (f, t) => /bar ?code|code ?(39|93|128)|3 ?of ?9|idautomat|i2of5|interleaved|ean-?13|upc-?a|postnet|datamatrix|pdf417|qr ?code|(^|\+)c(39|128)/i.test(f)
  || /^[#*!][.\-]?[\dA-Z.\-]{4,}[.\-]?[#*!]$/.test(t.replace(/\s/g, ''));
// Párrafos de una página, para editar como en Word: renglones completos agrupados por letra, interlineado y margen.
// Se trabaja en coordenadas de MuPDF (y hacia abajo) y se devuelve en puntos del PDF. reflow = se puede reacomodar
// (no es una fila de tabla con huecos grandes, ni texto girado).
ipcMain.handle('pagina-parrafos', async (_e, datos, n) => {
  const d = await abrirMu(datos);
  try {
    const pg = d.loadPage(n - 1), T = pg.getTransform(), m = invertir(T), B = pg.getBounds(), anchoP = B[2] - B[0], altoP = B[3] - B[1];
    // todo sale en "hoja derecha" (ver src/lugar.js): la página como se ve, en puntos, y hacia arriba. Con lugar.m se
    // pasa a puntos del PDF (en una hoja girada o recortada no son lo mismo)
    const enD = (x, y) => [x - B[0], B[3] - y], rectD = (x0, y0, x1, y1) => [x0 - B[0], B[3] - y1, x1 - B[0], B[3] - y0];
    const lugar = { ancho: anchoP, alto: altoP, m: (([a, b, c, d, e, f], A) => [a * A[0] + c * A[1], b * A[0] + d * A[1], a * A[2] + c * A[3], b * A[2] + d * A[3], a * A[4] + c * A[5] + e, b * A[4] + d * A[5] + f])(m, [1, 0, 0, -1, B[0], B[3]]) };
    const lineas = [], oculta = await letrasOcultas(pg);
    let ln = null;
    pg.toStructuredText('preserve-whitespace').walk({
      beginLine(_b, wmode, dir) { ln = { chars: [], girada: !!wmode || Math.abs(dir[1]) > 0.05 }; },
      onChar(c, o, f, tam, q, color) {
        if (!ln || oculta(o, c, tam)) return;
        ln.chars.push({ c, x0: Math.min(q[0], q[4]), x1: Math.max(q[2], q[6]), y0: Math.min(q[1], q[3]), y1: Math.max(q[5], q[7]), ox: o[0], oy: o[1], f, tam, color });
      },
      endLine() {
        const ch = ln?.chars || []; ln = ln && { ...ln, chars: ch };
        if (ch.some(x => x.c.trim())) lineas.push(ln);
        ln = null;
      }
    });
    const rgb = c => !c ? [0, 0, 0] : c.length === 1 ? [c[0], c[0], c[0]] : c.length === 4 ? [0, 1, 2].map(i => (1 - c[i]) * (1 - c[3])) : c.slice(0, 3);
    // cada renglón se parte en tramos donde hay un hueco de columna (tabla): un hueco mucho más grande que los espacios
    // normales de ese renglón (en un renglón justificado todos los espacios son anchos y parejos, no se parte)
    const R = [];
    for (const l of lineas) {
      const vis = l.chars.filter(x => x.c.trim());
      const huecos = [];
      for (let k = 1; k < vis.length; k++) huecos.push(vis[k].x0 - vis[k - 1].x1);
      const espacios = huecos.filter(h => h > vis[0].tam * 0.12).sort((a, b) => a - b), tipico = espacios[espacios.length >> 1] || 0;
      let tramo = [];
      const cerrarTramo = () => {
        if (!tramo.length) return;
        const cuenta = new Map();
        for (const x of tramo) { const k = x.f.getName() + '|' + Math.round(x.tam * 10); cuenta.set(k, (cuenta.get(k) || 0) + 1); }
        const clave = [...cuenta.entries()].sort((a, b) => b[1] - a[1])[0][0], ref = tramo.find(x => x.f.getName() + '|' + Math.round(x.tam * 10) === clave);
        let texto = '';
        const palabras = [];
        // cada palabra con su estilo (una palabra en negrita dentro de un renglón normal se respeta al reescribir)
        const estilo = x => x.f.getName() + '|' + Math.round(x.tam * 10) + '|' + rgb(x.color).map(v => Math.round(v * 50)).join(',');
        tramo.forEach((x, k) => {
          const hueco = k && x.x0 - tramo[k - 1].x1 > ref.tam * 0.12, otro = k && estilo(x) !== estilo(tramo[k - 1]);
          if (hueco) texto += ' ';
          texto += x.c;
          if (!k || hueco || otro) palabras.push({ t: x.c, x0: x.x0, x1: x.x1, y: x.oy, pegada: !!(k && !hueco), f: x.f.getName(), b: x.f.isBold(), i: x.f.isItalic(), tam: x.tam, color: rgb(x.color) });
          else { const w = palabras.at(-1); w.t += x.c; w.x1 = Math.max(w.x1, x.x1); }
        });
        const bases = tramo.map(x => x.oy).sort((a, b) => a - b);
        R.push({ texto: texto.trim(), x0: Math.min(...tramo.map(x => x.x0)), x1: Math.max(...tramo.map(x => x.x1)), y0: Math.min(...tramo.map(x => x.y0)), y1: Math.max(...tramo.map(x => x.y1)),
          base: bases[bases.length >> 1], tam: ref.tam, f: ref.f, color: rgb(ref.color), tab: l.girada || esBarras(ref.f.getName(), texto.trim()), palabras, vineta: /^([•·▪◦‣∙*–-]|\d{1,2}[.)])(\s|$)/.test(texto.trim()) });
        tramo = [];
      };
      vis.forEach((x, k) => {
        const h = k ? huecos[k - 1] : 0;
        if (k && h > x.tam * 0.5 && (espacios.length < 3 ? h > x.tam * 0.55 : h > tipico * 2.2)) cerrarTramo();
        tramo.push(x);
      });
      cerrarTramo();
    }
    // MuPDF a veces parte un renglón en dos (la viñeta y su texto): se juntan los que comparten base y están cerca
    for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++) {
      const a = R[i], b = R[j];
      if (!a || !b || a.tab || b.tab || Math.abs(a.base - b.base) > a.tam * 0.3 || Math.abs(a.tam - b.tam) > 2) continue;
      const [izq, der] = a.x0 <= b.x0 ? [a, b] : [b, a];
      const hueco = der.x0 - izq.x1, soloVineta = /^([•·▪◦‣∙*–-]|\d{1,2}[.)])$/.test(izq.texto);
      if (hueco < -1 || hueco > a.tam * (soloVineta ? 2.5 : 0.4)) continue;
      R[i] = { ...(izq.texto.length >= der.texto.length && !izq.vineta ? izq : der.vineta ? der : izq), texto: izq.texto + ' ' + der.texto, x0: izq.x0, x1: der.x1,
        y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1), palabras: [...izq.palabras, ...der.palabras], vineta: /^([•·▪◦‣∙*–-]|\d{1,2}[.)])\s/.test(izq.texto + ' ' + der.texto) };
      if (izq.texto.length < der.texto.length) Object.assign(R[i], { tam: der.tam, f: der.f, color: der.color });
      R.splice(j, 1); j = i;
    }
    // dos textos encimados (un dato viejo y uno nuevo en el mismo lugar): no se sabe cuál vale, quedan como están
    for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++) {
      const a = R[i], b = R[j], dy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0), dx = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      if (dy > Math.min(a.y1 - a.y0, b.y1 - b.y0) * 0.5 && dx > Math.min(a.x1 - a.x0, b.x1 - b.x0) * 0.3) a.tab = b.tab = true;
    }
    // agrupar renglones seguidos en párrafos
    const parrafos = [];
    let actual = null;
    const mismaLetra = (a, b) => Math.abs(a.tam - b.tam) < 0.6 && a.f.isBold() === b.f.isBold();
    for (const r of R) {
      const ult = actual?.lineas.at(-1);
      let sigue = !!actual && !r.tab && !ult.tab && !r.vineta && mismaLetra(ult, r);
      if (sigue) {
        const salto = r.base - ult.base, lead = actual.lineas.length > 1 ? actual.interlineado : null;
        if (salto <= r.tam * 0.5) sigue = false; // mismo renglón (otra columna)
        else if (lead ? Math.abs(salto - lead) > lead * 0.3 : salto > r.tam * 1.9) sigue = false;
        const tol = r.tam * 1.2, l0 = Math.min(...actual.lineas.slice(actual.lineas.length > 1 ? 1 : 0).map(x => x.x0));
        const alineado = Math.abs(r.x0 - l0) < tol || Math.abs(r.x0 - actual.lineas[0].x0) < tol || Math.abs(r.x1 - ult.x1) < tol || Math.abs((r.x0 + r.x1) / 2 - (ult.x0 + ult.x1) / 2) < tol
          || (actual.lineas.length === 1 && r.x0 < ult.x0 && ult.x0 - r.x0 < r.tam * 4); // sangría de la primera línea
        if (!alineado) sigue = false;
        // un renglón corto en el medio corta el párrafo (dirección, lista sin viñetas), salvo que el párrafo esté centrado
        if (sigue && actual.lineas.length > 1 && ult.x1 < actual.x1 - r.tam * 6 && Math.abs(ult.x0 - actual.lineas[0].x0) < tol) sigue = false;
      }
      if (sigue) {
        if (actual.lineas.length === 1) actual.interlineado = r.base - ult.base;
        actual.lineas.push(r); actual.x1 = Math.max(actual.x1, r.x1);
      } else { actual = { lineas: [r], interlineado: 0, x1: r.x1 }; parrafos.push(actual); }
    }
    const texto = R.filter(r => !r.tab);
    // márgenes: el izquierdo es donde empieza el texto; el derecho, el más lejano entre lo escrito y el simétrico al izquierdo
    const margenIzq = texto.length ? Math.min(...texto.map(r => r.x0)) : 56, margenDer = Math.max(texto.length ? Math.max(...texto.map(r => r.x1)) : 0, anchoP - margenIzq);
    const salida = parrafos.map((P, i) => {
      const L = P.lineas, a = L[0], tol = a.tam * 0.6, rango = v => Math.max(...v) - Math.min(...v);
      const izq = L.length > 1 ? L.slice(1).map(x => x.x0) : [a.x0], der = L.slice(0, -1).map(x => x.x1);
      let alineacion = 'izq';
      // justificado: todos los renglones (menos el último) terminan exactamente en el mismo punto
      if (L.length > 2 && rango(izq) < tol && rango(der) < a.tam * 0.2) alineacion = 'just';
      else if (L.length >= 2 && rango(izq) < tol) alineacion = 'izq';
      else if (L.length >= 2 && rango(L.map(x => x.x1)) < tol) alineacion = 'der';
      else if (L.length >= 2 && rango(L.map(x => (x.x0 + x.x1) / 2)) < tol) alineacion = 'centro';
      // un renglón pegado al borde izquierdo de una celda está alineado a la izquierda aunque caiga en el centro de la hoja
      else if (L.length === 1 && !oculta.bordes.some(r => r[2] <= a.x0 + 0.5 && a.x0 - r[2] < 12 && r[1] < a.y1 && r[3] > a.y0) && a.x0 > margenIzq + 20 && [anchoP / 2, (margenIzq + margenDer) / 2].some(c => Math.abs((a.x0 + a.x1) / 2 - c) < 10)) alineacion = 'centro';
      else if (L.length === 1 && a.x0 > anchoP * 0.4 && Math.abs(a.x1 - margenDer) < 6) alineacion = 'der';
      const x0 = Math.min(...L.map(x => x.x0)), x1 = Math.max(...L.map(x => x.x1));
      // ancho disponible: un renglón solo puede crecer hasta el margen (o hasta lo que tenga al lado en el mismo renglón)
      let lim0 = x0, lim1 = x1, ampliable = null;
      // un párrafo de varios renglones alineado a la izquierda puede crecer hasta el margen (o hasta lo que tenga al
      // costado): el editor lo ensancha recién cuando lo escrito ya no entra en su ancho original
      if (L.length > 1 && !a.tab && alineacion === 'izq') {
        const arriba = Math.min(...L.map(x => x.y0)), abajo = Math.max(...L.map(x => x.y1));
        const alLado = R.filter(r => !L.includes(r) && r.y1 > arriba && r.y0 < abajo && r.x0 >= x1);
        const tope = Math.max(x1, Math.min(margenDer, ...alLado.map(r => r.x0 - a.tam)));
        if (tope > x1 + a.tam) ampliable = tope;
      }
      if (L.length === 1 && !a.tab) {
        const alLado = R.filter(r => r !== a && Math.abs(r.base - a.base) < a.tam * 0.6);
        const tope1 = Math.min(margenDer, ...alLado.filter(r => r.x0 >= a.x1).map(r => r.x0 - a.tam)), tope0 = Math.max(margenIzq, ...alLado.filter(r => r.x1 <= a.x0).map(r => r.x1 + a.tam));
        if (alineacion === 'izq') lim1 = Math.max(x1, tope1);
        else if (alineacion === 'der') lim0 = Math.min(x0, tope0);
        else if (alineacion === 'centro') { const medio = (x0 + x1) / 2, mitad = Math.max((x1 - x0) / 2, Math.min(medio - tope0, tope1 - medio)); lim0 = medio - mitad; lim1 = medio + mitad; }
      }
      const f = a.f, enPdf = enD;
      return { id: 'q' + i, reflow: !L.some(x => x.tab), alineacion, interlineado: P.interlineado || a.tam * 1.2, sangria: L.length > 1 ? L[0].x0 - Math.min(...L.slice(1).map(x => x.x0)) : 0,
        rect: rectD(x0, Math.min(...L.map(x => x.y0)), x1, Math.max(...L.map(x => x.y1))), limites: [enPdf(lim0, 0)[0], enPdf(lim1, 0)[0]], ampliable: ampliable && enPdf(ampliable, 0)[0],
        fuente: { name: f.getName(), size: a.tam, weight: f.isBold() ? 'bold' : 'normal', style: f.isItalic() ? 'italic' : 'normal', family: f.isMono() ? 'monospace' : f.isSerif() ? 'serif' : 'sans-serif' }, color: a.color,
        lineas: L.map(x => ({ texto: x.texto, rect: rectD(x.x0, x.y0, x.x1, x.y1), base: enPdf(x.x0, x.base), palabras: x.palabras.map(w => ({ ...w, x0: enPdf(w.x0, x.base)[0], x1: enPdf(w.x1, x.base)[0], y: enPdf(w.x0, w.y)[1] })) })) };
    });
    return { parrafos: salida, lugar };
  } finally { d.destroy(); }
});
// ---------- Escribir con la letra original del PDF ----------
// Las fuentes que vienen dentro de un PDF casi siempre están recortadas y con códigos propios: no sirven como fuente
// normal. Lo que se hace es escribir con esa misma fuente del PDF usando sus códigos (ToUnicode al revés) y sus anchos.
// Así lo nuevo se ve idéntico, aunque la fuente no esté instalada. Si falta alguna letra, quien llama usa otra.
function leerToUnicode(txt) {
  const mapa = new Map(), aTexto = h => { let s = ''; for (let i = 0; i + 4 <= h.length; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16)); return s; };
  for (const b of txt.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const m of b[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) mapa.set(m[1].toUpperCase(), aTexto(m[2]));
  for (const b of txt.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) for (const m of b[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
    const a = parseInt(m[1], 16), z = parseInt(m[2], 16), w = m[1].length;
    if (z - a > 5000) continue;
    const lista = m[4] ? [...m[4].matchAll(/<([0-9a-fA-F]+)>/g)].map(x => x[1]) : null;
    for (let c = a; c <= z; c++) {
      const u = lista ? lista[c - a] : (parseInt(m[3].slice(-4), 16) + c - a).toString(16).padStart(4, '0');
      if (u) mapa.set(c.toString(16).toUpperCase().padStart(w, '0'), lista ? aTexto(u) : aTexto(m[3].slice(0, -4) + u));
    }
  }
  return mapa;
}
function fuenteOriginal(pdf, n, nombre) {
  const sin = x => String(x || '').replace(/^[A-Z]{6}\+/, '');
  const pagina = pdf.findPage(n - 1), fuentes = pagina.getInheritable('Resources').get('Font');
  if (!fuentes || fuentes.isNull()) return null;
  let hallada = null;
  fuentes.forEach((v, k) => { if (!hallada) { const f = v.resolve(), b = f.get('BaseFont'); if (b && !b.isNull() && (b.asName() === nombre || sin(b.asName()) === sin(nombre))) hallada = { recurso: String(k), obj: v, f }; } });
  if (!hallada) return null;
  const { f } = hallada, tipo = f.get('Subtype').asName(), dosBytes = tipo === 'Type0';
  if (dosBytes && !/Identity-H/.test(f.get('Encoding')?.asName?.() || '')) return null;
  if (tipo === 'Type3') return null;
  const tu = f.get('ToUnicode');
  if (!tu || tu.isNull()) return null;
  const codigos = leerToUnicode(tu.readStream().asString?.() ?? Buffer.from(tu.readStream().asUint8Array()).toString('latin1'));
  const anchos = {};
  if (dosBytes) {
    const df = f.get('DescendantFonts').resolve().get(0).resolve(), dw = df.get('DW')?.isNumber?.() ? df.get('DW').asNumber() : 1000, W = df.get('W');
    for (const c of codigos.keys()) anchos[c] = dw;
    if (W && !W.isNull()) {
      const w = W.resolve(), L = w.length;
      for (let i = 0; i < L;) {
        const c0 = w.get(i).asNumber(), sig = w.get(i + 1);
        if (sig.isArray()) { for (let j = 0; j < sig.length; j++) anchos[(c0 + j).toString(16).toUpperCase().padStart(4, '0')] = sig.get(j).asNumber(); i += 2; }
        else { const c1 = sig.asNumber(), ancho = w.get(i + 2).asNumber(); for (let c = c0; c <= c1 && c - c0 < 5000; c++) anchos[c.toString(16).toUpperCase().padStart(4, '0')] = ancho; i += 3; }
      }
    }
  } else {
    const primero = f.get('FirstChar')?.asNumber?.() ?? 0, W = f.get('Widths');
    if (W && !W.isNull()) { const w = W.resolve(); for (let j = 0; j < w.length; j++) anchos[(primero + j).toString(16).toUpperCase().padStart(2, '0')] = w.get(j).asNumber(); }
  }
  const mapa = {};
  for (const [c, u] of codigos) if (u.length === 1 && !(u in mapa) && anchos[c] != null) mapa[u] = c;
  return { recurso: hallada.recurso, num: hallada.obj.isIndirect() ? hallada.obj.asIndirect() : 0, dosBytes, mapa, anchos, nombre: sin(f.get('BaseFont').asName()) };
}
ipcMain.handle('fuente-original', async (_e, datos, n, nombre) => {
  const d = await abrirMu(datos);
  try { return fuenteOriginal(d.asPDF(), n, nombre); } catch (e) { console.error('Fuente original', e?.message); return null; } finally { d.destroy(); }
});
// entradas: [{ x, y, hex, tam, color }] en puntos del PDF. Si al borrar el texto la fuente quedó sin usar y MuPDF la sacó
// de la página, se vuelve a enganchar (el objeto sigue en el archivo con el mismo número).
ipcMain.handle('escribir-original', async (_e, datos, n, fuenteComun, entradas) => {
  const d = await abrirMu(datos);
  try {
    const pdf = d.asPDF(), pagina = pdf.findPage(n - 1);
    // cada entrada puede traer su propia fuente ({ recurso, num }); si no, va la común
    let res = pagina.get('Resources');
    if (!res || res.isNull()) { res = pdf.newDictionary(); const her = pagina.getInheritable('Resources'); if (her && !her.isNull()) her.resolve().forEach((v, k) => res.put(k, v)); pagina.put('Resources', res); }
    res = res.resolve();
    let fuentes = res.get('Font');
    if (!fuentes || fuentes.isNull()) { fuentes = pdf.newDictionary(); res.put('Font', fuentes); }
    fuentes = fuentes.resolve();
    // la fuente va con su nombre en la página; si en esta página ese nombre ya es otra fuente (texto que viene de otra
    // hoja), va con un nombre propio
    const nombres = new Map(), clave = f => f.recurso + '|' + (f.num || '');
    for (const e of entradas) {
      const f = e.fuente || fuenteComun;
      if (!f || nombres.has(clave(f))) continue;
      let nombre = f.recurso, ya = fuentes.get(nombre);
      if (ya && !ya.isNull() && f.num && ya.isIndirect() && ya.asIndirect() !== f.num) { nombre = f.recurso + 'P' + f.num; ya = fuentes.get(nombre); }
      if (!ya || ya.isNull()) { if (!f.num) throw new Error('La fuente original ya no está.'); fuentes.put(nombre, pdf.newIndirect(f.num)); }
      nombres.set(clave(f), nombre);
    }
    const r = v => Math.round(v * 1000) / 1000;
    const ops = entradas.map(e => `BT /${nombres.get(clave(e.fuente || fuenteComun))} ${r(e.tam)} Tf ${e.color.map(r).join(' ')} rg ${(e.giro || [1, 0, 0, 1]).map(r).join(' ')} ${r(e.x)} ${r(e.y)} Tm <${e.hex}> Tj ET`).join('\n'); // giro: hoja girada (src/lugar.js)
    // lo de antes queda entre q … Q, así lo nuevo no hereda giros o escalas que haya dejado el contenido original
    const antes = pagina.get('Contents'), lista = pdf.newArray();
    lista.push(pdf.addStream('q\n', pdf.newDictionary()));
    if (antes && !antes.isNull()) { const a = antes.resolve(); if (a.isArray()) a.forEach(x => lista.push(x)); else lista.push(antes); }
    lista.push(pdf.addStream('Q\nq\n' + ops + '\nQ\n', pdf.newDictionary()));
    pagina.put('Contents', lista);
    return pdf.saveToBuffer('compress').asUint8Array();
  } finally { d.destroy(); }
});
// Fondo para el modo documento: la página dibujada sin el texto que se está editando (quedan imágenes, líneas, tablas
// y el texto que no se edita). Las zonas son tiras dentro de cada renglón editable, en puntos del PDF.
// MuPDF, al borrar texto, reescribe el contenido de la hoja. En algunos PDF (hechos con Word, con el modo de dibujo
// del texto heredado de un bloque a otro) lo pierde y el resto del texto sale con contorno: más grueso, como negrita.
// Se cuenta el texto con contorno antes y después; si aparece más, en vez de reescribir la hoja se tapan las letras
// de esas zonas con el color del papel (el texto viejo queda escondido debajo; pdf.pro ya no lo muestra ni lo lee).
function textoConContorno(m, pg) {
  let n = 0;
  const dev = new m.Device({ strokeText() { n++; }, clipStrokeText() { n++; } });
  pg.run(dev, m.Matrix.identity); dev.close();
  return n;
}
function agregarContenido(pdf, n, ops) {
  const pagina = pdf.findPage(n - 1), antes = pagina.get('Contents'), lista = pdf.newArray();
  lista.push(pdf.addStream('q\n', pdf.newDictionary()));
  if (antes && !antes.isNull()) { const a = antes.resolve(); if (a.isArray()) a.forEach(x => lista.push(x)); else lista.push(antes); }
  lista.push(pdf.addStream('Q\nq\n' + ops.join('\n') + '\nQ\n', pdf.newDictionary()));
  pagina.put('Contents', lista);
}
// zonasMu: rects en coordenadas de MuPDF. Tapa justo las letras que caen adentro (su caja entera, no solo la zona)
function taparLetras(m, pdf, pg, n, zonasMu) {
  const cajas = zonasMu.map(() => null);
  // la caja de la tinta (de la base hacia arriba lo alto de una mayúscula, hacia abajo lo que baja una "p"), no la
  // de la letra entera: así no tapa el borde de la celda que pasa justo abajo
  pg.toStructuredText('preserve-whitespace').walk({ onChar(c, o, _f, s, q) {
    if (!c.trim()) return;
    const b = [Math.min(q[0], q[4]), o[1] - s * 0.8, Math.max(q[2], q[6]), o[1] + s * (/[gjpqyQç,;()[\]{}|]/.test(c) ? 0.24 : 0.05)], cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
    zonasMu.forEach((z, i) => { if (cx >= z[0] && cx <= z[2] && cy >= z[1] && cy <= z[3]) { const a = cajas[i]; cajas[i] = a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b; } });
  } });
  const usar = cajas.filter(Boolean).map(b => [b[0] - 0.5, b[1] - 0.3, b[2] + 0.5, b[3] + 0.15]);
  if (!usar.length) return;
  const papel = colorAlrededor(m, pg, usar), inv = invertir(pg.getTransform()), r3 = v => Math.round(v * 1000) / 1000;
  agregarContenido(pdf, n, usar.map((r, i) => { const [a, b, c, d] = rectCon(inv, ...r); return `${(papel[i] || [255, 255, 255]).map(v => (v / 255).toFixed(3)).join(' ')} rg ${r3(a)} ${r3(b)} ${r3(c - a)} ${r3(d - b)} re f`; }));
}
// Borra el texto de esas zonas (rects en coordenadas de MuPDF) en la página; si MuPDF engrosa el resto, devuelve false
// y no sirve esa copia (quien llama usa taparLetras sobre una copia nueva)
function borrarTexto(m, pg, zonasMu) {
  const antes = textoConContorno(m, pg);
  for (const r of zonasMu) pg.createAnnotation('Redact').setRect(r);
  pg.applyRedactions(false, m.PDFPage.REDACT_IMAGE_NONE, m.PDFPage.REDACT_LINE_ART_NONE, m.PDFPage.REDACT_TEXT_REMOVE);
  return textoConContorno(m, pg) <= antes;
}
ipcMain.handle('pagina-fondo', async (_e, datos, n, zonas, escala) => {
  let d = await abrirMu(datos);
  try {
    const m = await mu();
    let pdf = d.asPDF(), pg = pdf.loadPage(n - 1);
    const Z = zonas.map(r => rectCon(pg.getTransform(), ...r));
    if (Z.length && !borrarTexto(m, pg, Z)) { d.destroy(); d = await abrirMu(datos); pdf = d.asPDF(); pg = pdf.loadPage(n - 1); taparLetras(m, pdf, pg, n, Z); pg = pdf.loadPage(n - 1); }
    const px = pg.toPixmap(m.Matrix.scale(escala, escala), m.ColorSpace.DeviceRGB, false, true);
    return px.asPNG();
  } finally { d.destroy(); }
});
// Garantía al editar: dibuja la página antes y después y cuenta los puntos que cambiaron FUERA de las zonas permitidas
// (rects en puntos del PDF). Devuelve cuántos y el recuadro donde están (en puntos del PDF), para avisar si algo más se movió.
ipcMain.handle('comparar-paginas', async (_e, antes, despues, n, permitidas = []) => {
  const m = await mu(), esc = 1.5;
  const dibujar = async datos => {
    const d = await abrirMu(datos);
    try {
      const pg = d.loadPage(n - 1), T = pg.getTransform();
      const px = pg.toPixmap(m.Matrix.scale(esc, esc), m.ColorSpace.DeviceGray, false, true);
      return { w: px.getWidth(), h: px.getHeight(), datos: px.getPixels().slice(), T };
    } finally { d.destroy(); }
  };
  const a = await dibujar(antes), b = await dibujar(despues);
  if (a.w !== b.w || a.h !== b.h) return { fuera: a.w * a.h, caja: null };
  const zonas = permitidas.map(r => rectCon(a.T, ...r).map(v => v * esc)).map(([x0, y0, x1, y1]) => [x0 - 3, y0 - 3, x1 + 3, y1 + 3]);
  const libre = (x, y) => zonas.some(z => x >= z[0] && x <= z[2] && y >= z[1] && y <= z[3]);
  let fuera = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
    const i = y * a.w + x;
    if (Math.abs(a.datos[i] - b.datos[i]) > 48 && !libre(x, y)) { fuera++; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  }
  return { fuera, caja: fuera ? rectCon(invertir(a.T), x0 / esc, y0 / esc, (x1 + 1) / esc, (y1 + 1) / esc) : null };
});
// Comparar dos versiones del documento: por cada hoja, dónde cambió el dibujo (recuadros en puntos del PDF) y qué
// palabras se sacaron o se agregaron. Las hojas de más o de menos se cuentan aparte.
ipcMain.handle('comparar-documentos', async (_e, antes, despues) => {
  const m = await mu(), esc = 1;
  const leer = async datos => {
    const d = await abrirMu(datos), hojas = [];
    try {
      for (let i = 0; i < d.countPages(); i++) {
        const pg = d.loadPage(i), T = pg.getTransform(), px = pg.toPixmap(m.Matrix.scale(esc, esc), m.ColorSpace.DeviceGray, false, true);
        const palabras = [];
        let w = '';
        pg.toStructuredText('preserve-whitespace').walk({ onChar(c) { if (c.trim()) w += c; else if (w) { palabras.push(w); w = ''; } }, endLine() { if (w) palabras.push(w); w = ''; } });
        hojas.push({ w: px.getWidth(), h: px.getHeight(), px: px.getPixels().slice(), T, palabras });
      }
    } finally { d.destroy(); }
    return hojas;
  };
  const A = await leer(antes), B = await leer(despues), salida = [];
  for (let i = 0; i < Math.min(A.length, B.length); i++) {
    const a = A[i], b = B[i], cajas = [];
    if (a.w === b.w && a.h === b.h) {
      // celdas de 6 px que cambiaron, juntadas en recuadros
      const C = 6, cw = Math.ceil(a.w / C), ch = Math.ceil(a.h / C), marca = new Uint8Array(cw * ch);
      for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) if (Math.abs(a.px[y * a.w + x] - b.px[y * a.w + x]) > 40) marca[(y / C | 0) * cw + (x / C | 0)] = 1;
      const visto = new Uint8Array(cw * ch);
      for (let k = 0; k < marca.length; k++) {
        if (!marca[k] || visto[k]) continue;
        let x0 = cw, y0 = ch, x1 = 0, y1 = 0; const pila = [k]; visto[k] = 1;
        while (pila.length) {
          const q = pila.pop(), qx = q % cw, qy = q / cw | 0;
          x0 = Math.min(x0, qx); y0 = Math.min(y0, qy); x1 = Math.max(x1, qx); y1 = Math.max(y1, qy);
          for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { // vecinos cercanos (une letras de una misma palabra)
            const nx = qx + dx, ny = qy + dy, nk = ny * cw + nx;
            if (nx >= 0 && ny >= 0 && nx < cw && ny < ch && marca[nk] && !visto[nk]) { visto[nk] = 1; pila.push(nk); }
          }
        }
        cajas.push(rectCon(invertir(a.T), x0 * C / esc - 2, y0 * C / esc - 2, (x1 + 1) * C / esc + 2, (y1 + 1) * C / esc + 2));
      }
    } else cajas.push(null); // cambió el tamaño de la hoja
    // palabras: lo común más largo (LCS) y lo demás es lo que se sacó o se agregó, en tramos seguidos
    const pa = a.palabras.slice(0, 3000), pb = b.palabras.slice(0, 3000), quitado = [], agregado = [];
    if (pa.join(' ') !== pb.join(' ')) {
      const n = pa.length, k = pb.length, L = Array.from({ length: n + 1 }, () => new Uint16Array(k + 1));
      for (let x = n - 1; x >= 0; x--) for (let y = k - 1; y >= 0; y--) L[x][y] = pa[x] === pb[y] ? L[x + 1][y + 1] + 1 : Math.max(L[x + 1][y], L[x][y + 1]);
      let x = 0, y = 0, q = [], g = [];
      const cerrar = () => { if (q.length) quitado.push(q.join(' ')); if (g.length) agregado.push(g.join(' ')); q = []; g = []; };
      while (x < n || y < k) {
        if (x < n && y < k && pa[x] === pb[y]) { cerrar(); x++; y++; }
        else if (y < k && (x >= n || L[x][y + 1] >= L[x + 1][y])) g.push(pb[y++]);
        else q.push(pa[x++]);
      }
      cerrar();
    }
    if (cajas.length || quitado.length || agregado.length) salida.push({ n: i + 1, cajas: cajas.filter(Boolean), tamano: cajas.includes(null), quitado, agregado });
  }
  return { hojas: salida, antes: A.length, despues: B.length };
});
// Borra lo que hay en esas zonas (rects en puntos del PDF): el texto y, si se pide, las imágenes (deja ese pedazo en blanco)
// imagenes: false | 'quitar' (saca la imagen entera: se marca solo su centro para no tocar nada más) | 'pixeles' (deja en blanco ese pedazo)
// Color que más se repite en un anillo alrededor de cada rect (coordenadas de MuPDF); null si alrededor no es parejo
function colorAlrededor(m, pg, rects) {
  const px = pg.toPixmap(m.Matrix.identity, m.ColorSpace.DeviceRGB, false, true), w = px.getWidth(), h = px.getHeight(), ox = px.getX(), oy = px.getY(), d = px.getPixels(), nc = px.getNumberOfComponents(), st = px.getStride();
  return rects.map(([x0, y0, x1, y1]) => {
    const cuenta = new Map(), suma = new Map(), pon = (x, y) => {
      x = Math.round(x - ox); y = Math.round(y - oy);
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = y * st + x * nc, k = [0, 1, 2].map(c => d[i + c] >> 3).join(','), s = suma.get(k) || [0, 0, 0];
      cuenta.set(k, (cuenta.get(k) || 0) + 1); suma.set(k, s.map((v, c) => v + d[i + c]));
    };
    for (let t = 3; t <= 7; t += 2) {
      for (let x = x0 - t; x <= x1 + t; x += 2) { pon(x, y0 - t); pon(x, y1 + t); }
      for (let y = y0 - t; y <= y1 + t; y += 2) { pon(x0 - t, y); pon(x1 + t, y); }
    }
    const total = [...cuenta.values()].reduce((a, b) => a + b, 0), [k, n] = [...cuenta.entries()].sort((a, b) => b[1] - a[1])[0] || [];
    return k && n > total * 0.3 ? suma.get(k).map(v => v / n) : null;
  });
}
ipcMain.handle('borrar-zona', async (_e, datos, n, rects, { texto = true, imagenes = false } = {}) => {
  let d = await abrirMu(datos);
  try {
    const m = await mu();
    // solo texto (lo que hace el editor): con control de que MuPDF no engrose el resto de la hoja
    if (texto && !imagenes) {
      let pdf = d.asPDF(), pg = pdf.loadPage(n - 1);
      const Z = rects.map(r => rectCon(pg.getTransform(), ...r));
      if (!borrarTexto(m, pg, Z)) { d.destroy(); d = await abrirMu(datos); pdf = d.asPDF(); pg = pdf.loadPage(n - 1); taparLetras(m, pdf, pg, n, Z); }
      return pdf.saveToBuffer('compress').asUint8Array();
    }
    const pdf = d.asPDF(), pg = pdf.loadPage(n - 1), M = pg.getTransform();
    // sobre una hoja escaneada, el hueco de la imagen se rellena con el color del papel de alrededor (no queda un cuadro)
    const papel = imagenes && imagenes !== 'quitar' ? colorAlrededor(m, pg, rects.map(r => rectCon(M, ...r))) : [];
    for (const r of rects) {
      const [x0, y0, x1, y1] = rectCon(M, ...r), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      pg.createAnnotation('Redact').setRect(imagenes === 'quitar' ? [cx - 0.5, cy - 0.5, cx + 0.5, cy + 0.5] : [x0, y0, x1, y1]);
    }
    const metodo = imagenes === 'quitar' ? m.PDFPage.REDACT_IMAGE_REMOVE : imagenes ? m.PDFPage.REDACT_IMAGE_PIXELS : m.PDFPage.REDACT_IMAGE_NONE;
    pg.applyRedactions(false, metodo, m.PDFPage.REDACT_LINE_ART_NONE,
      texto ? m.PDFPage.REDACT_TEXT_REMOVE : m.PDFPage.REDACT_TEXT_NONE);
    // al sacar una imagen también se va lo dibujado que quedaba entero debajo o encima de ella (marco, sombra, recuadro
    // gris de fondo): si no, en su lugar queda un cuadro
    if (imagenes) {
      for (const r of rects) { const [x0, y0, x1, y1] = rectCon(M, ...r); const e = Math.max(6, Math.min(x1 - x0, y1 - y0) * 0.08); pg.createAnnotation('Redact').setRect([x0 - e, y0 - e, x1 + e, y1 + e]); }
      pg.applyRedactions(false, m.PDFPage.REDACT_IMAGE_NONE, m.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED, m.PDFPage.REDACT_TEXT_NONE);
    }
    const tapas = rects.map((r, i) => papel[i] && `${papel[i].map(v => (v / 255).toFixed(3)).join(' ')} rg ${Math.min(r[0], r[2])} ${Math.min(r[1], r[3])} ${Math.abs(r[2] - r[0])} ${Math.abs(r[3] - r[1])} re f`).filter(Boolean);
    if (tapas.length) agregarContenido(pdf, n, tapas);
    return pdf.saveToBuffer('compress').asUint8Array();
  } finally { d.destroy(); }
});
// Imagen número "indice" de la página en su resolución original, como píxeles RGBA (con su transparencia, que en el PDF va aparte)
ipcMain.handle('imagen-de-pagina', async (_e, datos, n, indice) => {
  const d = await abrirMu(datos);
  try {
    const m = await mu(); let k = 0, salida = null;
    d.loadPage(n - 1).toStructuredText('preserve-images').walk({ onImageBlock(_b, _t, img) {
      if (k++ !== indice || salida) return;
      const px = img.toPixmap().convertToColorSpace(m.ColorSpace.DeviceRGB, true);
      // copias: al pedir memoria nueva, MuPDF invalida las vistas de píxeles anteriores
      const w = px.getWidth(), h = px.getHeight(), src = px.getPixels().slice(), nc = src.length / (w * h);
      const mascara = img.getMask()?.toPixmap(), mw = mascara?.getWidth(), mh = mascara?.getHeight(), mp = mascara?.getPixels().slice(), mn = mascara ? mp.length / (mw * mh) : 0;
      const rgba = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * nc, o = (y * w + x) * 4;
        rgba[o] = src[i]; rgba[o + 1] = src[i + 1]; rgba[o + 2] = src[i + 2];
        rgba[o + 3] = mascara ? mp[(Math.floor(y * mh / h) * mw + Math.floor(x * mw / w)) * mn] : nc === 4 ? src[i + 3] : 255;
      }
      salida = { ancho: w, alto: h, rgba };
    } });
    return salida;
  } finally { d.destroy(); }
});


// ---------- Herramientas: reparar, comprimir, hojas en blanco ----------
// Reparar: MuPDF arregla al abrir lo que puede (tabla de objetos rota, archivo cortado) y se guarda limpio
ipcMain.handle('reparar', async (_e, datos) => {
  const d = await abrirMu(datos);
  try {
    const pdf = d.asPDF(), n = d.countPages();
    let reparado = false; try { reparado = pdf.wasRepaired(); } catch {}
    // si estaba sano no se toca nada (reescribir el contenido podía cambiar cómo se ven algunas letras)
    if (!reparado) return { datos, reparado, paginas: n };
    return { datos: pdf.saveToBuffer('garbage=1,compress').asUint8Array(), reparado, paginas: n };
  } finally { d.destroy(); }
});
// Comprimir: las imágenes grandes se achican (lado mayor en px) y pasan a JPEG; se sacan objetos repetidos o sin usar.
// Solo se cambia una imagen si queda más chica. Las máscaras (transparencias) y las de 1 bit no se tocan.
ipcMain.handle('comprimir', async (_e, datos, { lado = 2000, calidad = 75 } = {}) => {
  const m = await mu(), d = await abrirMu(datos);
  try {
    const pdf = d.asPDF(), total = pdf.countObjects(), mascaras = new Set();
    const nombre = o => { try { return o.isName() ? o.asName() : ''; } catch { return ''; } };
    for (let i = 1; i < total; i++) {
      try { const o = pdf.newIndirect(i).resolve(); if (o.isDictionary()) for (const k of ['SMask', 'Mask']) { const r = o.get(k); if (r.isIndirect()) mascaras.add(r.asIndirect()); } } catch {}
    }
    let cambiadas = 0, ahorro = 0;
    for (let i = 1; i < total; i++) {
      try {
        const ref = pdf.newIndirect(i), o = ref; // el stream se lee y escribe por la referencia (el objeto resuelto no lo tiene)
        if (!ref.isStream() || nombre(o.get('Subtype')) !== 'Image' || mascaras.has(i)) continue;
        if (o.get('ImageMask').isBoolean?.() && o.get('ImageMask').asBoolean()) continue;
        const bpc = o.get('BitsPerComponent'); if (bpc.isNumber() && bpc.asNumber() < 8) continue;
        const antes = o.readRawStream().length;
        const img = pdf.loadImage(ref), w = img.getWidth(), h = img.getHeight();
        const f = Math.min(1, lado / Math.max(w, h));
        let px = img.toPixmap();
        const cs = px.getColorSpace(), gris = cs && cs.isGray?.();
        if (px.getAlpha() || !(gris || cs?.isRGB?.())) px = px.convertToColorSpace(gris ? m.ColorSpace.DeviceGray : m.ColorSpace.DeviceRGB, false);
        const W = Math.max(1, Math.round(w * f)), H = Math.max(1, Math.round(h * f));
        if (f < 1) px = px.warp([[0, 0], [w, 0], [w, h], [0, h]], W, H);
        const jpg = px.asJPEG(calidad);
        if (jpg.length >= antes * 0.9) continue; // no vale la pena
        o.writeRawStream(jpg);
        o.put('Filter', pdf.newName('DCTDecode')); o.delete('DecodeParms'); o.delete('Decode');
        o.put('Width', W); o.put('Height', H); o.put('BitsPerComponent', 8);
        o.put('ColorSpace', pdf.newName(gris ? 'DeviceGray' : 'DeviceRGB'));
        cambiadas++; ahorro += antes - jpg.length;
      } catch (e) { if (process.env.PDFPRO_DEPURAR) console.error('comprimir', i, e.message); }
    }
    return { datos: pdf.saveToBuffer('garbage=4,compress,compress-fonts').asUint8Array(), cambiadas, ahorro };
  } finally { d.destroy(); }
});
// Hojas en blanco: sin texto y casi sin tinta (se dibuja chica; los escaneos con un poco de "ruido" también cuentan)
ipcMain.handle('hojas-en-blanco', async (_e, datos) => {
  const m = await mu(), d = await abrirMu(datos);
  try {
    const blancas = [];
    for (let i = 0; i < d.countPages(); i++) {
      const pg = d.loadPage(i);
      if (pg.toStructuredText().asText().trim()) continue;
      const [x0, y0, x1, y1] = pg.getBounds(), esc = 60 / Math.max(1, Math.max(x1 - x0, y1 - y0));
      const px = pg.toPixmap([esc, 0, 0, esc, 0, 0], m.ColorSpace.DeviceGray, false).getPixels();
      let tinta = 0; for (const v of px) if (v < 200) tinta++;
      if (tinta / px.length < 0.004) blancas.push(i);
    }
    return blancas;
  } finally { d.destroy(); }
});


// Censurar de verdad: lo que está en los recuadros (texto, imágenes, dibujos) se borra del archivo y queda negro
ipcMain.handle('censurar', async (_e, datos, n, rects) => {
  const m = await mu(), d = await abrirMu(datos);
  try {
    const pdf = d.asPDF(), pg = pdf.loadPage(n - 1), M = pg.getTransform();
    for (const r of rects) pg.createAnnotation('Redact').setRect(rectCon(M, ...r));
    pg.applyRedactions(true, m.PDFPage.REDACT_IMAGE_PIXELS, m.PDFPage.REDACT_LINE_ART_REMOVE_IF_TOUCHED, m.PDFPage.REDACT_TEXT_REMOVE);
    return pdf.saveToBuffer('garbage=4,compress').asUint8Array(); // garbage: que no quede lo borrado escondido en el archivo
  } finally { d.destroy(); }
});
// Copia editable de un PDF con firma digital: cada firma queda dibujada en la hoja (como se veía), se sacan sus campos,
// el bloqueo de cambios (DocMDP) y la marca de "firmado". Lo demás (casilleros, comentarios) queda igual.
ipcMain.handle('copia-editable', async (_e, datos) => {
  const d = await abrirMu(datos);
  try {
    const pdf = d.asPDF(), raiz = pdf.getTrailer().get('Root');
    const esFirma = w => { for (let x = w, k = 0; x && !x.isNull() && k < 6; x = x.get('Parent'), k++) { const ft = x.get('FT'); if (!ft.isNull() && ft.asName() === 'Sig') return true; } return false; };
    let firmas = 0;
    for (let i = 0; i < d.countPages(); i++) {
      const pagina = pdf.findPage(i), annots = pagina.get('Annots');
      if (!annots || annots.isNull()) continue;
      const lista = annots.resolve(), quedan = pdf.newArray(), dibujos = [];
      lista.forEach(a => {
        const w = a.resolve(), sub = w.get('Subtype');
        if (sub.isNull() || sub.asName() !== 'Widget' || !esFirma(w)) return quedan.push(a);
        firmas++;
        const ap = w.get('AP'), nrm = ap.isNull() ? null : ap.get('N');
        if (!nrm || nrm.isNull() || !nrm.isStream()) return; // firma invisible: no hay nada que dibujar
        const R = w.get('Rect'), B = nrm.get('BBox');
        if (R.isNull() || B.isNull()) return;
        const [x0, y0, x1, y1] = [0, 1, 2, 3].map(k => R.get(k).asNumber()), [bx0, by0, bx1, by1] = [0, 1, 2, 3].map(k => B.get(k).asNumber());
        const a2 = (Math.abs(x1 - x0)) / ((bx1 - bx0) || 1), d2 = (Math.abs(y1 - y0)) / ((by1 - by0) || 1);
        const nombre = 'FirmaDig' + firmas;
        dibujos.push({ nombre, ref: nrm, cm: [a2, 0, 0, d2, Math.min(x0, x1) - bx0 * a2, Math.min(y0, y1) - by0 * d2] });
      });
      pagina.put('Annots', quedan);
      if (dibujos.length) {
        let res = pagina.get('Resources');
        if (!res || res.isNull()) { res = pdf.newDictionary(); pagina.put('Resources', res); }
        res = res.resolve();
        let xo = res.get('XObject'); if (!xo || xo.isNull()) { xo = pdf.newDictionary(); res.put('XObject', xo); } xo = xo.resolve();
        for (const x of dibujos) xo.put(x.nombre, x.ref);
        const antes = pagina.get('Contents'), contenidos = pdf.newArray();
        contenidos.push(pdf.addStream('q\n', pdf.newDictionary()));
        if (antes && !antes.isNull()) { const c = antes.resolve(); if (c.isArray()) c.forEach(z => contenidos.push(z)); else contenidos.push(antes); }
        contenidos.push(pdf.addStream('Q\n' + dibujos.map(x => `q ${x.cm.map(v => Math.round(v * 1000) / 1000).join(' ')} cm /${x.nombre} Do Q`).join('\n') + '\n', pdf.newDictionary()));
        pagina.put('Contents', contenidos);
      }
    }
    // los campos de firma salen del formulario; el bloqueo de cambios y la marca de firmado también
    const form = raiz.get('AcroForm');
    if (form && !form.isNull()) {
      const f = form.resolve(), campos = f.get('Fields');
      if (campos && !campos.isNull()) { const quedan = pdf.newArray(); campos.resolve().forEach(c => { if (!esFirma(c.resolve())) quedan.push(c); }); f.put('Fields', quedan); }
      f.delete('SigFlags');
    }
    raiz.delete('Perms');
    return { datos: pdf.saveToBuffer('garbage=1,compress').asUint8Array(), firmas };
  } finally { d.destroy(); }
});

};
