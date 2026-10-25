// PDF.Pro — operaciones sobre las páginas del archivo (pdf-lib). Cada función recibe los bytes y devuelve bytes nuevos.
import { PDFDocument, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList, PDFDict, PDFName, PDFArray, PDFHexString, PDFString, PDFNumber, PDFBool, StandardFonts, TextRenderingMode, degrees, decodePDFRawStream,
  pushGraphicsState, popGraphicsState, beginText, endText, setFontAndSize, setCharacterSqueeze, setTextMatrix, setTextRenderingMode, showText, setFillingRgbColor } from '../node_modules/pdf-lib/dist/pdf-lib.esm.min.js';
import { esMarca, lineaMarca, lineasDe, ICONO_NOTA, LINEA, rectEnPagina, rectDerecho } from './comentarios.js';

const abrir = bytes => PDFDocument.load(bytes, { updateMetadata: false });
const guardar = doc => doc.save({ useObjectStreams: true });

export class ErrorProtegido extends Error {}
async function abrirEditable(bytes) {
  try { return await abrir(bytes); }
  catch (e) { if (/encrypt/i.test(e?.message)) throw new ErrorProtegido('protegido'); throw e; }
}

// Orden nuevo: lista de índices (base 0) en el orden final
export async function reordenar(bytes, orden) {
  const doc = await abrirEditable(bytes);
  const pags = doc.getPages();
  for (let i = pags.length - 1; i >= 0; i--) doc.removePage(i);
  orden.forEach(i => doc.addPage(pags[i]));
  return guardar(doc);
}

export async function rotar(bytes, indices, grados) {
  const doc = await abrirEditable(bytes);
  for (const i of indices) {
    const p = doc.getPage(i);
    p.setRotation(degrees(((p.getRotation().angle + grados) % 360 + 360) % 360));
  }
  return guardar(doc);
}

export async function eliminar(bytes, indices) {
  const doc = await abrirEditable(bytes);
  if (indices.length >= doc.getPageCount()) throw new Error('No se pueden eliminar todas las páginas.');
  [...indices].sort((a, b) => b - a).forEach(i => doc.removePage(i));
  return guardar(doc);
}

// Inserta las páginas de otros PDF después de la posición indicada (-1 = al principio)
export async function insertarDesde(bytes, otros, despuesDe) {
  const doc = await abrirEditable(bytes);
  let pos = despuesDe + 1;
  for (const b of otros) {
    const otro = await abrirEditable(b);
    const copias = await doc.copyPages(otro, otro.getPageIndices());
    for (const c of copias) doc.insertPage(pos++, c);
  }
  return guardar(doc);
}

export async function insertarBlanco(bytes, despuesDe, tam = null, desborde = 0) {
  const doc = await abrirEditable(bytes);
  const ref = doc.getPage(Math.max(0, Math.min(despuesDe, doc.getPageCount() - 1)));
  const { width, height } = ref.getSize();
  const nueva = doc.insertPage(despuesDe + 1, tam || [width, height]); // tam: [ancho, alto] (por ejemplo, el de la hoja como se ve)
  if (desborde) marcarDesborde(nueva, desborde);
  return guardar(doc);
}
// Hoja de desborde: la que armó el editor con lo que no entraba en la hoja de arriba. 1 = empieza con un párrafo,
// 2 = empieza con la continuación del último párrafo de la hoja de arriba. 0 = hoja común.
const marcarDesborde = (pagina, tipo) => pagina.node.set(N('PDFProDesborde'), PDFNumber.of(tipo));
export async function tipoDesborde(bytes, i) {
  const doc = await abrirEditable(bytes);
  if (i < 0 || i >= doc.getPageCount()) return 0;
  const v = doc.getPage(i).node.get(N('PDFProDesborde'));
  return v instanceof PDFNumber ? v.asNumber() : 0;
}
// Baja todo lo que hay en la hoja (dy puntos), para hacer lugar arriba
export async function bajarContenido(bytes, i, dy, desborde) {
  const doc = await abrirEditable(bytes), pg = doc.getPage(i), ctx = doc.context;
  const antes = pg.node.get(N('Contents')), lista = PDFArray.withContext(ctx);
  lista.push(ctx.register(ctx.stream(`q 1 0 0 1 0 ${redondo(-dy)} cm\n`)));
  const viejo = antes && ctx.lookup(antes);
  if (viejo instanceof PDFArray) viejo.asArray().forEach(x => lista.push(x)); else if (antes) lista.push(antes);
  lista.push(ctx.register(ctx.stream('\nQ\n')));
  pg.node.set(N('Contents'), lista);
  if (desborde) marcarDesborde(pg, desborde);
  return guardar(doc);
}

// Copia las páginas indicadas a un PDF nuevo
export async function extraer(bytes, indices) {
  const doc = await abrirEditable(bytes);
  const nuevo = await PDFDocument.create();
  const copias = await nuevo.copyPages(doc, indices);
  copias.forEach(c => nuevo.addPage(c));
  return guardar(nuevo);
}

// Grupos: lista de listas de índices → un PDF por grupo
export async function separar(bytes, grupos) {
  const salida = [];
  for (const g of grupos) salida.push(await extraer(bytes, g));
  return salida;
}

// Imágenes (JPG o PNG) → PDF con una página por imagen, del tamaño de la imagen (máx. A4 a 150 ppp)
export async function desdeImagenes(imagenes) {
  const doc = await PDFDocument.create();
  for (const { datos, tipo } of imagenes) {
    const img = tipo === 'png' ? await doc.embedPng(datos) : await doc.embedJpg(datos);
    const a4 = [595.28, 841.89];
    const vertical = img.height >= img.width;
    const [aw, ah] = vertical ? a4 : [a4[1], a4[0]];
    const esc = Math.min(aw / img.width, ah / img.height);
    const w = img.width * esc, h = img.height * esc;
    const pag = doc.addPage([aw, ah]);
    pag.drawImage(img, { x: (aw - w) / 2, y: (ah - h) / 2, width: w, height: h });
  }
  return guardar(doc);
}

// Interpreta rangos escritos por el usuario: "1-3, 5, 8-10" → grupos de índices base 0
export function leerRangos(texto, total) {
  const grupos = [];
  for (const parte of texto.split(/[,;]/).map(s => s.trim()).filter(Boolean)) {
    const m = parte.match(/^(\d+)\s*(?:-|a|al)\s*(\d+)$/i) || parte.match(/^(\d+)$/);
    if (!m) throw new Error(`No entiendo "${parte}". Escribí por ejemplo: 1-3, 4, 5-8`);
    const desde = +m[1], hasta = +(m[2] || m[1]);
    if (desde < 1 || hasta > total || desde > hasta) throw new Error(`"${parte}" está fuera del documento (tiene ${total} páginas).`);
    grupos.push(Array.from({ length: hasta - desde + 1 }, (_, i) => desde - 1 + i));
  }
  if (!grupos.length) throw new Error('Escribí al menos un rango.');
  return grupos;
}

// Une varios PDF en uno nuevo, en el orden recibido
export async function unirVarios(lista) {
  const nuevo = await PDFDocument.create();
  for (const b of lista) {
    const otro = await abrirEditable(b);
    (await nuevo.copyPages(otro, otro.getPageIndices())).forEach(c => nuevo.addPage(c));
  }
  return guardar(nuevo);
}

// ---------- Firmas y sellos editables ----------
// Mientras se trabaja, las firmas viven aparte de los bytes del PDF (lista p.firmas) y se dibujan encima.
// Al guardar se escriben como anotaciones de sello (/Stamp), igual que Acrobat: se pueden volver a mover.
// Cada firma: { id, n (página, base 1), cx, cy (centro en puntos del PDF), w, h, angulo (grados), png, nombre, clave }
const N = s => PDFName.of(s);
const giro = a => { const r = a * Math.PI / 180; return [Math.cos(r), Math.sin(r)]; };
const caja = f => { const [c, s] = giro(f.angulo).map(Math.abs); return [f.w * c + f.h * s, f.w * s + f.h * c]; };
const redondo = v => Math.round(v * 1000) / 1000;

// Escribe firmas y comentarios en el PDF. aplanar = true: las firmas quedan pegadas al contenido (ya no se mueven).
export async function componerTodo(bytes, firmas = [], comentarios = [], aplanar = false, campos = {}, letras = new Map()) {
  if (!firmas.length && !comentarios.length && !Object.keys(campos || {}).length) return bytes;
  const doc = await abrirEditable(bytes);
  await escribirCampos(doc, campos);
  await escribirFirmas(doc, firmas, aplanar);
  const aviso = await escribirComentarios(doc, comentarios, letras);
  const salida = await guardar(doc);
  if (aviso) salida.cambioLetra = aviso; // 'basica' (faltaba en la letra elegida) o 'signo' (ni la básica la tiene: va '?')
  return salida;
}
export const componerFirmas = (bytes, firmas, aplanar = false) => componerTodo(bytes, firmas, [], aplanar);
async function escribirFirmas(doc, firmas, aplanar) {
  const ctx = doc.context;
  const imagenes = new Map();
  for (const f of firmas) {
    if (f.n > doc.getPageCount()) continue;
    if (!imagenes.has(f.clave)) imagenes.set(f.clave, { img: await doc.embedPng(f.png), png: aplanar ? null : ctx.register(ctx.stream(f.png)) });
    const { img, png } = imagenes.get(f.clave), pagina = doc.getPage(f.n - 1);
    const [cos, sin] = giro(f.angulo);
    if (aplanar) {
      const x = f.cx - cos * f.w / 2 + sin * f.h / 2, y = f.cy - sin * f.w / 2 - cos * f.h / 2;
      pagina.drawImage(img, { x, y, width: f.w, height: f.h, rotate: degrees(f.angulo) });
      continue;
    }
    const [W, H] = caja(f);
    const contenido = `q 1 0 0 1 ${redondo(W / 2)} ${redondo(H / 2)} cm ${redondo(cos)} ${redondo(sin)} ${redondo(-sin)} ${redondo(cos)} 0 0 cm ${redondo(f.w)} 0 0 ${redondo(f.h)} ${redondo(-f.w / 2)} ${redondo(-f.h / 2)} cm /Im Do Q`;
    const ap = ctx.register(ctx.stream(contenido, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, W, H], Resources: { XObject: { Im: img.ref } } }));
    const anot = ctx.register(ctx.obj({
      Type: 'Annot', Subtype: 'Stamp', F: 4, Rect: [f.cx - W / 2, f.cy - H / 2, f.cx + W / 2, f.cy + H / 2].map(redondo),
      NM: PDFHexString.fromText('pdfpro-' + f.id), Contents: PDFHexString.fromText(f.nombre || 'Firma'),
      AP: { N: ap }, PDFProFirma: true, PDFProAngulo: redondo(f.angulo), PDFProProp: f.h / f.w, PDFProPNG: png
    }));
    pagina.node.addAnnot(anot);
  }
}

// ---------- Comentarios (anotaciones estándar con apariencia propia, para que se vean igual en cualquier programa) ----------
const rgb = c => [1, 3, 5].map(i => redondo(parseInt(c.slice(i, i + 2), 16) / 255));
const hexDe = arr => '#' + arr.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
const SUBTIPO = { resaltar: 'Highlight', subrayar: 'Underline', tachar: 'StrikeOut', nota: 'Text', texto: 'FreeText', dibujo: 'Ink' };
const TIPO_DE = Object.fromEntries(Object.entries(SUBTIPO).map(([k, v]) => [v, k]));
const ptos = arr => arr.map(redondo).join(' ');
// letras: Map 'f:Familia' → { clave, bytes } de las fuentes elegidas en cuadros de texto (las básicas no hacen falta)
async function escribirComentarios(doc, lista, letras = new Map()) {
  if (!lista.length) return null;
  const ctx = doc.context, embebidas = new Map();
  let conFontkit = false, aviso = null;
  const BASICA = { sans: StandardFonts.Helvetica, serif: StandardFonts.TimesRoman, mono: StandardFonts.Courier };
  const letraDe = async (letra, texto) => {
    const datos = letras.get(letra);
    if (datos?.bytes) {
      if (!embebidas.has(datos.clave)) {
        if (!conFontkit) { await import('../node_modules/@pdf-lib/fontkit/dist/fontkit.umd.min.js'); doc.registerFontkit(self.fontkit); conFontkit = true; }
        embebidas.set(datos.clave, await doc.embedFont(datos.bytes, { subset: true }).catch(() => null));
      }
      const f = embebidas.get(datos.clave), fk = f?.embedder?.font;
      if (f && !(fk && [...texto].some(ch => ch.trim() && !fk.hasGlyphForCodePoint(ch.codePointAt(0))))) return f;
      aviso ||= 'basica';
    }
    const nombre = BASICA[letra] || StandardFonts.Helvetica; // si a la fuente le falta alguna letra, va con la básica
    if (!embebidas.has(nombre)) embebidas.set(nombre, await doc.embedFont(nombre));
    return embebidas.get(nombre);
  };
  for (const c of lista) {
    if (c.n > doc.getPageCount()) continue;
    const [r, g, b] = rgb(c.color), extra = {}, recursos = {};
    let contenido, xs, ys, cajaPropia = null, matriz = null;
    if (esMarca(c)) {
      const pts = c.quads.flat(); xs = pts.map(p => p[0]); ys = pts.map(p => p[1]);
      if (c.tipo === 'resaltar') {
        recursos.ExtGState = { GS0: { Type: 'ExtGState', BM: 'Multiply' } };
        contenido = `/GS0 gs ${r} ${g} ${b} rg ` + c.quads.map(([tl, tr, bl, br]) => `${ptos(tl)} m ${ptos(tr)} l ${ptos(br)} l ${ptos(bl)} l h f`).join(' ');
      } else contenido = `${r} ${g} ${b} RG ` + c.quads.map(q => { const [x1, y1, x2, y2, w] = lineaMarca(c.tipo, q); return `${redondo(w)} w ${ptos([x1, y1])} m ${ptos([x2, y2])} l S`; }).join(' ');
      extra.QuadPoints = c.quads.flatMap(q => q.flat()).map(redondo);
      if (c.texto) extra.PDFProTexto = PDFHexString.fromText(c.texto);
    } else if (c.tipo === 'nota') {
      const s = ICONO_NOTA, P = (fx, fy) => ptos([c.x + s * fx, c.y - s * fy]);
      xs = [c.x, c.x + s]; ys = [c.y - s, c.y];
      contenido = `${r} ${g} ${b} rg 0.45 0.45 0.45 RG 1 w ${P(.1, .1)} m ${P(.9, .1)} l ${P(.9, .7)} l ${P(.45, .7)} l ${P(.25, .9)} l ${P(.28, .7)} l ${P(.1, .7)} l h B ` +
        [.28, .42, .56].map(f => `${P(.22, f)} m ${P(.78, f)} l`).join(' ') + ' S';
      Object.assign(extra, { Name: 'Comment', Open: false });
    } else if (c.tipo === 'texto') {
      const fuente = await letraDe(c.letra || 'sans', String(c.nota || ''));
      const limpio = t => [...t].map(ch => { try { fuente.encodeText(ch); return ch; } catch { aviso = 'signo'; return '?'; } }).join('');
      const [x0, y0, x1, y1] = c.rect, enPag = rectEnPagina(c); xs = [enPag[0], enPag[2]]; ys = [enPag[1], enPag[3]];
      // en páginas giradas el texto se dibuja "derecho" (en su caja sin girar) y la matriz lo gira a la página
      if (c.giro) { cajaPropia = [x0, y0, x1, y1].map(redondo); matriz = { 90: [0, 1, -1, 0, 0, 0], 180: [-1, 0, 0, -1, 0, 0], 270: [0, -1, 1, 0, 0, 0] }[c.giro]; extra.PDFProGiro = c.giro; }
      const lineas = lineasDe(c, t => fuente.widthOfTextAtSize(limpio(t), c.tam));
      recursos.Font = { Helv: fuente.ref };
      contenido = (c.tapar ? `1 1 1 rg ${redondo(x0)} ${redondo(y0)} ${redondo(x1 - x0)} ${redondo(y1 - y0)} re f ` : '') + `BT /Helv ${c.tam} Tf ${r} ${g} ${b} rg ` + lineas.map((l, i) => `1 0 0 1 ${redondo(x0 + 2)} ${redondo(y1 - 2 - c.tam * (i * LINEA + 0.92))} Tm ${fuente.encodeText(limpio(l)).toString()} Tj`).join(' ') + ' ET';
      Object.assign(extra, { DA: PDFString.of(`/Helv ${c.tam} Tf ${r} ${g} ${b} rg`), PDFProTam: c.tam, ...(c.auto ? { PDFProAuto: true } : {}), ...(c.tapar ? { PDFProTapar: true } : {}), ...(c.letra && c.letra !== 'sans' ? { PDFProLetra: PDFHexString.fromText(c.letra) } : {}) });
    } else {
      const todos = c.trazos.flat(), w = c.grosor;
      xs = todos.filter((_, i) => !(i % 2)); ys = todos.filter((_, i) => i % 2);
      xs = [Math.min(...xs) - w, Math.max(...xs) + w]; ys = [Math.min(...ys) - w, Math.max(...ys) + w];
      contenido = `${r} ${g} ${b} RG ${w} w 1 J 1 j ` + c.trazos.map(t => {
        const pares = []; for (let i = 0; i < t.length; i += 2) pares.push(ptos([t[i], t[i + 1]]));
        if (pares.length === 1) pares.push(ptos([t[0] + 0.01, t[1]]));
        return pares[0] + ' m ' + pares.slice(1).map(p => p + ' l').join(' ') + ' S';
      }).join(' ');
      Object.assign(extra, { InkList: c.trazos.map(t => t.map(redondo)), BS: { W: w, S: 'S' } });
    }
    const rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(redondo);
    const ap = ctx.register(ctx.stream(contenido, { Type: 'XObject', Subtype: 'Form', BBox: cajaPropia || rect, ...(matriz ? { Matrix: matriz } : {}), Resources: recursos }));
    const anot = ctx.register(ctx.obj({
      Type: 'Annot', Subtype: SUBTIPO[c.tipo], F: 4, Rect: rect, C: [r, g, b], CA: 1, AP: { N: ap },
      NM: PDFHexString.fromText('pdfpro-' + c.id), Contents: PDFHexString.fromText(c.nota || ''), PDFProComentario: true, ...extra
    }));
    doc.getPage(c.n - 1).node.addAnnot(anot);
  }
  return aviso;
}
// Lee un comentario de PDF.Pro (respeta lo que se haya cambiado en otro programa: lugar, texto, color)
function leerComentario(d, n) {
  const num = k => d.lookup(N(k))?.asNumber?.();
  const arr = k => d.lookup(N(k), PDFArray)?.asArray().map(x => x.asNumber()) || [];
  const tipo = TIPO_DE[d.lookup(N('Subtype'), PDFName).decodeText()];
  if (!tipo) return null;
  const c = { id: crypto.randomUUID(), n, tipo, color: hexDe(arr('C').length === 3 ? arr('C') : [1, 0.83, 0]), nota: d.lookup(N('Contents'))?.decodeText?.() || '' };
  const r = arr('Rect'), rect = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
  if (esMarca(c)) {
    const q = arr('QuadPoints'); c.quads = [];
    for (let i = 0; i + 7 < q.length; i += 8) c.quads.push([[q[i], q[i + 1]], [q[i + 2], q[i + 3]], [q[i + 4], q[i + 5]], [q[i + 6], q[i + 7]]]);
    c.texto = d.lookup(N('PDFProTexto'))?.decodeText?.() || '';
    if (!c.quads.length) return null;
  } else if (tipo === 'nota') { c.x = rect[0]; c.y = rect[3]; }
  else if (tipo === 'texto') { const g = num('PDFProGiro'); if ([90, 180, 270].includes(g)) c.giro = g; c.rect = rectDerecho(c.giro, rect); c.tam = num('PDFProTam') || 12; if (d.get(N('PDFProAuto'))) c.auto = true; if (d.get(N('PDFProTapar'))) c.tapar = true; const l = d.lookup(N('PDFProLetra'))?.decodeText?.(); if (l) c.letra = l; }
  else {
    c.trazos = d.lookup(N('InkList'), PDFArray).asArray().map(t => t.asArray().map(x => x.asNumber()));
    c.grosor = d.lookup(N('BS'), PDFDict)?.lookup(N('W'))?.asNumber?.() || 1;
  }
  return c;
}

// Saca del PDF las firmas y comentarios hechos con PDF.Pro (aunque se hayan movido en Acrobat) y los devuelve como listas editables.
export async function separarTodo(bytes) {
  let doc;
  try { doc = await abrir(bytes); } catch { return { datos: bytes, firmas: [], comentarios: [] }; }
  const ctx = doc.context, firmas = [], comentarios = [], borrar = new Set(), pngs = new Map();
  doc.getPages().forEach((pagina, i) => {
    const anots = pagina.node.Annots();
    if (!anots) return;
    const inicio = firmas.length, inicioC = comentarios.length;
    for (let k = anots.size() - 1; k >= 0; k--) {
      const d = anots.lookup(k);
      if (!(d instanceof PDFDict)) continue;
      if (d.get(N('PDFProComentario'))) {
        let c = null;
        try { c = leerComentario(d, i + 1); } catch {}
        if (!c) continue;
        comentarios.splice(inicioC, 0, c);
        const ap = d.lookup(N('AP'), PDFDict)?.get(N('N'));
        [anots.get(k), ap].forEach(x => x && borrar.add(x));
        anots.remove(k);
        continue;
      }
      if (!d.get(N('PDFProFirma'))) continue;
      try {
        const r = d.lookup(N('Rect'), PDFArray).asArray().map(x => x.asNumber());
        const angulo = d.lookup(N('PDFProAngulo'), PDFNumber).asNumber(), prop = d.lookup(N('PDFProProp'), PDFNumber).asNumber();
        const pngRef = d.get(N('PDFProPNG'));
        if (!pngs.has(pngRef)) pngs.set(pngRef, decodePDFRawStream(ctx.lookup(pngRef)).decode());
        const [c, s] = giro(angulo).map(Math.abs);
        const W = Math.abs(r[2] - r[0]), H = Math.abs(r[3] - r[1]);
        const w = Math.min(W / (c + prop * s || 1), H / (s + prop * c || 1)); // entra en el rectángulo aunque Acrobat lo haya estirado
        const nombre = d.lookup(N('Contents'))?.decodeText?.() || 'Firma';
        firmas.splice(inicio, 0, { id: crypto.randomUUID(), n: i + 1, cx: (r[0] + r[2]) / 2, cy: (r[1] + r[3]) / 2, w, h: w * prop, angulo, png: pngs.get(pngRef), nombre });
        // limpiar los objetos que quedan sueltos (si no, el archivo crece en cada guardado)
        const ap = d.lookup(N('AP'), PDFDict)?.get(N('N'));
        const apS = ap && ctx.lookup(ap);
        const im = apS?.dict?.lookup(N('Resources'), PDFDict)?.lookup(N('XObject'), PDFDict)?.get(N('Im'));
        const sm = im && ctx.lookup(im)?.dict?.get(N('SMask'));
        [anots.get(k), ap, im, sm, pngRef].forEach(x => x && borrar.add(x));
      } catch { continue; }
      anots.remove(k);
    }
  });
  if (!firmas.length && !comentarios.length) return { datos: bytes, firmas, comentarios };
  borrar.forEach(ref => { try { ctx.delete(ref); } catch {} });
  return { datos: await guardar(doc), firmas, comentarios };
}
export const separarFirmas = separarTodo;

// ---------- Texto reconocido (OCR) ----------
// Escribe el texto invisible sobre las páginas escaneadas, palabra por palabra en su lugar: así se puede buscar, copiar y pintar.
// porPagina: Map(n → [{ texto, x, y (inicio de la línea de base, puntos del PDF), ang (radianes), ancho, tam }])
export async function agregarTextoOcr(bytes, porPagina) {
  const doc = await abrirEditable(bytes), fuente = await doc.embedFont(StandardFonts.Helvetica);
  const limpio = t => [...t].map(ch => { try { fuente.encodeText(ch); return ch; } catch { return ''; } }).join('');
  for (const [n, palabras] of porPagina) {
    const pagina = doc.getPage(n - 1), clave = pagina.node.newFontDictionary('PDFProOCR', fuente.ref);
    const lista = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
    for (const w of palabras) {
      const t = limpio(w.texto), natural = t && fuente.widthOfTextAtSize(t, w.tam);
      if (!natural || !(w.tam > 0)) continue;
      const c = Math.cos(w.ang), s = Math.sin(w.ang);
      lista.push(setFontAndSize(clave, redondo(w.tam)), setCharacterSqueeze(redondo(Math.max(10, Math.min(500, w.ancho / natural * 100)))),
        setTextMatrix(redondo(c), redondo(s), redondo(-s), redondo(c), redondo(w.x), redondo(w.y)), showText(fuente.encodeText(t)));
    }
    lista.push(endText(), popGraphicsState());
    pagina.pushOperators(...lista);
    pagina.node.set(N('PDFProOCR'), PDFBool.True);
  }
  return guardar(doc);
}

// ---------- Editar texto ----------
// Escribe un renglón de texto nuevo (con una de las 14 letras estándar). Si "tapar", antes pinta el fondo para cubrir lo de abajo (escaneos).
// e: { n, x, y (línea de base), texto, fuente: 'sans'|'serif'|'mono', negrita, cursiva, tam, color [r,g,b] 0-1, tapar: [x0,y0,x1,y1] | null, fondo [r,g,b] }
const LETRAS = { sans: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'], serif: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'],
  mono: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'] };
// Recibe uno o varios renglones (los que se borraron sin querer por estar encima se vuelven a escribir igual).
export async function escribirTexto(bytes, lista) {
  lista = [].concat(lista);
  const doc = await abrirEditable(bytes), fuentes = new Map();
  const { rgb } = await import('../node_modules/pdf-lib/dist/pdf-lib.esm.min.js');
  for (const e of lista) if (e.tapar) doc.getPage(e.n - 1).drawRectangle({ x: e.tapar[0], y: e.tapar[1], width: e.tapar[2] - e.tapar[0], height: e.tapar[3] - e.tapar[1], color: rgb(...(e.fondo || [1, 1, 1])) });
  let conFontkit = false, cambioLetra = false;
  const claves = new Map();
  const basica = async e => {
    const nombre = LETRAS[typeof e.fuente === 'string' ? e.fuente : 'sans'][(e.negrita ? 1 : 0) + (e.cursiva ? 2 : 0)];
    if (!fuentes.has(nombre)) fuentes.set(nombre, await doc.embedFont(StandardFonts[nombre]));
    return fuentes.get(nombre);
  };
  for (const e of lista) {
    let fuente;
    if (e.fuente?.bytes) { // una fuente de Windows o de "Mis fuentes": se incrusta solo con las letras usadas
      if (!fuentes.has(e.fuente.clave)) {
        if (!conFontkit) { await import('../node_modules/@pdf-lib/fontkit/dist/fontkit.umd.min.js'); doc.registerFontkit(self.fontkit); conFontkit = true; } // se carga como global
        fuentes.set(e.fuente.clave, await doc.embedFont(e.fuente.bytes, { subset: true }).catch(err => { console.warn('Fuente', err); return null; }));
      }
      fuente = fuentes.get(e.fuente.clave);
      // si le falta alguna letra (pasa con fuentes copiadas de otro PDF), va con la básica
      const fk = fuente?.embedder?.font;
      if (fk && [...e.texto].some(ch => ch.trim() && !fk.hasGlyphForCodePoint(ch.codePointAt(0)))) { fuente = null; if (!e.invisible) cambioLetra = true; }
    }
    fuente ||= await basica(e);
    const limpio = [...e.texto].map(ch => { try { fuente.encodeText(ch); return ch; } catch { return '?'; } }).join('');
    if (!limpio.trim()) continue;
    if (e.invisible) { // texto reconocido de un escaneo: se vuelve a poner invisible, del mismo ancho que tenía
      const pagina = doc.getPage(e.n - 1), clave = pagina.node.newFontDictionary('PDFProOCR', fuente.ref), natural = fuente.widthOfTextAtSize(limpio, e.tam);
      pagina.pushOperators(pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible), setFontAndSize(clave, e.tam),
        setCharacterSqueeze(redondo(Math.max(10, Math.min(500, (e.ancho || natural) / natural * 100)))), setTextMatrix(1, 0, 0, 1, redondo(e.x), redondo(e.y)),
        showText(fuente.encodeText(limpio)), endText(), popGraphicsState());
    } else {
      // una sola entrada de fuente por página y fuente (drawText agregaba una por cada palabra)
      const pagina = doc.getPage(e.n - 1), k = (e.n - 1) + '|' + fuente.ref.toString();
      if (!claves.has(k)) claves.set(k, pagina.node.newFontDictionary(fuente.name, fuente.ref));
      pagina.pushOperators(pushGraphicsState(), beginText(), setFontAndSize(claves.get(k), e.tam), setFillingRgbColor(...e.color),
        setTextMatrix(...(e.giro || [1, 0, 0, 1]), redondo(e.x), redondo(e.y)), showText(fuente.encodeText(limpio)), endText(), popGraphicsState());
    }
  }
  const salida = await guardar(doc);
  salida.cambioLetra = cambioLetra; // a la letra elegida le faltaba alguna letra y ese texto fue con la básica: quien llama avisa
  return salida;
}

// ---------- Formularios con casilleros ----------
// campos: { nombre: texto | true/false (tilde) | valor de la opción elegida (radio o lista) }
async function escribirCampos(doc, campos) {
  const nombres = Object.keys(campos || {});
  if (!nombres.length) return;
  const form = doc.getForm();
  for (const nombre of nombres) {
    const v = campos[nombre];
    try {
      const f = form.getField(nombre);
      if (f instanceof PDFTextField) { const max = f.getMaxLength(), t = String(v ?? ''); f.setText(max ? t.slice(0, max) : t); } // si es más largo que lo que admite el casillero, se corta (antes se perdía entero)
      else if (f instanceof PDFCheckBox) { if (v === true || (typeof v === 'string' && v && v !== 'Off')) f.check(); else f.uncheck(); }
      else if (f instanceof PDFRadioGroup) { if (v && v !== 'Off') f.select(String(v)); else f.clear(); }
      else if (f instanceof PDFDropdown || f instanceof PDFOptionList) { if (v) f.select(String(v)); else f.clear(); }
    } catch (e) { console.warn('Casillero', nombre, e?.message); }
  }
  // apariencia (lo que se ve en cualquier programa) con Helvetica si la letra del formulario no sirve
  try { form.updateFieldAppearances(); } catch { try { form.updateFieldAppearances(await doc.embedFont(StandardFonts.Helvetica)); } catch {} }
  // si alguna letra no se pudo dibujar, que el lector arme la apariencia con el valor nuevo
  try { form.acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True); } catch {}
}
export async function ponerCampos(bytes, campos) {
  if (!Object.keys(campos || {}).length) return bytes;
  const doc = await abrirEditable(bytes);
  await escribirCampos(doc, campos);
  return guardar(doc);
}

// Numerar páginas. Los números van en un contenido aparte y marcado (PDFProNumero) en cada hoja: así se pueden sacar o
// cambiar después sin tocar lo demás (al volver a numerar se reemplazan). La configuración queda en el documento
// (Root → PDFProNumeracion) para mostrarla al abrir el diálogo.
// activo: false = sacar los números. posicion 'abajo-centro' | 'abajo-derecha' | 'abajo-izquierda' | 'arriba-derecha' | 'arriba-centro';
// formato 'n' (3) | 'n/t' (3/10) | 'pagina' (Página 3 de 10); desde: la primera hoja que lleva número; primero: con qué número empieza
export async function numerar(bytes, { activo = true, posicion = 'abajo-centro', formato = 'n', desde = 1, primero = 1, tam = 10 } = {}) {
  const doc = await abrirEditable(bytes), ctx = doc.context, paginas = doc.getPages();
  // primero se sacan los números que ya había
  for (const pg of paginas) {
    const c = pg.node.get(N('Contents')), lista = c && ctx.lookup(c);
    if (lista instanceof PDFArray) {
      const quedan = lista.asArray().filter(r => !(ctx.lookup(r)?.dict?.get(N('PDFProNumero'))));
      if (quedan.length !== lista.size()) pg.node.set(N('Contents'), ctx.obj(quedan));
    }
  }
  doc.catalog.delete(N('PDFProNumeracion'));
  if (activo) {
    const f = await doc.embedFont(StandardFonts.Helvetica), total = paginas.length - desde + primero;
    paginas.forEach((pg, i) => {
      if (i + 1 < desde) return;
      const n = i + 1 - desde + primero, t = formato === 'n/t' ? `${n}/${total}` : formato === 'pagina' ? `Página ${n} de ${total}` : String(n);
      // se mide sobre la hoja como se ve (recortada y girada) y se pasa a puntos del PDF
      const { x, y, width, height } = pg.getCropBox(), giro = ((pg.getRotation().angle % 360) + 360) % 360;
      const W = giro % 180 ? height : width, H = giro % 180 ? width : height, ancho = f.widthOfTextAtSize(t, tam), margen = 28;
      const vx = posicion.endsWith('derecha') ? W - margen - ancho : posicion.endsWith('izquierda') ? margen : (W - ancho) / 2;
      const vy = posicion.startsWith('arriba') ? H - margen - tam * 0.7 : margen;
      // de la hoja como se ve (u, v desde abajo a la izquierda) a puntos del PDF; la letra va girada igual que la hoja
      const [qx, qy] = giro === 90 ? [width - vy, vx] : giro === 180 ? [width - vx, height - vy] : giro === 270 ? [vy, height - vx] : [vx, vy];
      const m = { 0: [1, 0, 0, 1], 90: [0, 1, -1, 0], 180: [-1, 0, 0, -1], 270: [0, -1, 1, 0] }[giro];
      const clave = pg.node.newFontDictionary('PDFProNum', f.ref);
      const ops = `q BT /${clave.asString().replace(/^\//, '')} ${tam} Tf 0.25 0.25 0.25 rg ${m.join(' ')} ${redondo(x + qx)} ${redondo(y + qy)} Tm ${f.encodeText(t).toString()} Tj ET Q`;
      const ref = ctx.register(ctx.stream(ops, { PDFProNumero: true }));
      const c = pg.node.get(N('Contents')), actual = c && ctx.lookup(c);
      const lista = actual instanceof PDFArray ? actual.asArray() : c ? [c] : [];
      pg.node.set(N('Contents'), ctx.obj([...lista, ref]));
    });
    doc.catalog.set(N('PDFProNumeracion'), PDFString.of(JSON.stringify({ posicion, formato, desde, primero, tam })));
  }
  return guardar(doc);
}
// La numeración que puso pdf.pro (o null)
export async function leerNumeracion(bytes) {
  try { const v = (await abrir(bytes)).catalog.get(N('PDFProNumeracion')); return v ? JSON.parse(v.decodeText()) : null; } catch { return null; }
}

// Propiedades del documento (las que se pueden editar)
export async function leerPropiedades(bytes) {
  const doc = await abrirEditable(bytes), pg = doc.getPage(0), { width, height } = pg.getSize();
  const version = new TextDecoder().decode(bytes.slice(0, 16)).match(/%PDF-(\d\.\d)/)?.[1] || '?';
  return { titulo: doc.getTitle() || '', autor: doc.getAuthor() || '', asunto: doc.getSubject() || '', claves: doc.getKeywords() || '',
    programa: doc.getCreator() || '', productor: doc.getProducer() || '', creado: doc.getCreationDate() || null, modificado: doc.getModificationDate() || null,
    paginas: doc.getPageCount(), ancho: width, alto: height, version };
}
export async function ponerPropiedades(bytes, { titulo, autor, asunto, claves }) {
  const doc = await abrirEditable(bytes);
  doc.setTitle(titulo || ''); doc.setAuthor(autor || ''); doc.setSubject(asunto || ''); doc.setKeywords(claves ? claves.split(/\s*,\s*/).filter(Boolean) : []);
  doc.setModificationDate(new Date());
  return guardar(doc);
}
