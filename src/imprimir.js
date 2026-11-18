// PDF.Pro — módulo de impresión: vista previa, impresora, copias, páginas, papel, orientación, márgenes, escala, páginas por
// hoja, color, calidad, doble faz, pie de página. Cada hoja de papel se arma como imagen (las páginas con sus firmas y
// comentarios encima; las notas no se imprimen) y se manda a la impresora desde una ventana oculta. La vista previa usa el
// mismo armado, así se ve exactamente lo que sale.
import * as pdfjs from '../node_modules/pdfjs-dist/build/pdf.min.mjs';
import * as ops from './paginas.js';
import { pintarFirmas } from './firmas.js';
import { pintarComentarios } from './comentarios.js';

const BASE = new URL('../node_modules/pdfjs-dist/', import.meta.url).href;
// Tamaños de hoja en mm, por grupo. La clave 'Oficio' es el Legal de EE.UU. (se mantiene por las preferencias ya guardadas).
const cm = v => String(+(v / 10).toFixed(2)).replace('.', ',');
const P = (t, w, h, g) => ({ t: `${t} (${cm(w)} × ${cm(h)} cm)`, w, h, g });
export const PAPELES = {
  A4: P('A4', 210, 297, 'Hojas'), Carta: P('Carta', 215.9, 279.4, 'Hojas'), OficioAR: P('Oficio argentino', 216, 340, 'Hojas'),
  Oficio: P('Legal / Oficio EE.UU.', 215.9, 355.6, 'Hojas'), A3: P('A3', 297, 420, 'Hojas'), A5: P('A5', 148, 210, 'Hojas'),
  A6: P('A6', 105, 148, 'Hojas'), B5: P('B5', 176, 250, 'Hojas'), Ejecutivo: P('Ejecutivo', 184.2, 266.7, 'Hojas'),
  SobreDL: P('Sobre DL', 110, 220, 'Sobres'), SobreC5: P('Sobre C5', 162, 229, 'Sobres'), SobreC6: P('Sobre C6', 114, 162, 'Sobres'),
  Sobre10: P('Sobre N.º 10', 104.8, 241.3, 'Sobres'),
  Foto9x13: P('Foto 9 × 13', 89, 127, 'Fotos'), Foto10x15: P('Foto 10 × 15', 101.6, 152.4, 'Fotos'), Foto13x18: P('Foto 13 × 18', 127, 177.8, 'Fotos'),
  EtiqEnvio: P('Etiqueta de envío', 100, 150, 'Etiquetas'), Etiq100x50: P('Etiqueta', 100, 50, 'Etiquetas'),
  Etiq62x29: P('Etiqueta Brother', 62, 29, 'Etiquetas'), Etiq89x36: P('Etiqueta Dymo', 89, 36, 'Etiquetas'), Etiq50x25: P('Etiqueta', 50, 25, 'Etiquetas'),
  Personalizado: { t: 'Tamaño personalizado…', g: 'Otro' }
};
// Medidas (mm) del papel elegido: común, de la impresora ('imp:…') o personalizado (papelW/papelH en cm)
export function medidasPapel(o) {
  const c = PAPELES[o.papel];
  if (c?.w) return c;
  const w = Math.min(120, Math.max(2, +o.papelW || 21)) * 10, h = Math.min(120, Math.max(2, +o.papelH || 29.7)) * 10;
  return { w, h };
}
// Opciones del desplegable de papel, en grupos. Si se conocen los tamaños de la impresora, primero los que acepta.
export function opcionesPapel(el, elegido, deImpresora = []) {
  const opt = (v, t) => el('option', { value: v, selected: v === elegido }, t);
  const parecido = (a, b) => (Math.abs(a.w - b.w) < 2 && Math.abs(a.h - b.h) < 2) || (Math.abs(a.w - b.h) < 2 && Math.abs(a.h - b.w) < 2);
  const comunes = Object.entries(PAPELES).filter(([, v]) => v.w);
  const grupos = [];
  if (deImpresora.length) {
    const acepta = comunes.filter(([, v]) => deImpresora.some(d => parecido(d, v)));
    const otrosImp = deImpresora.filter(d => !comunes.some(([, v]) => parecido(d, v)));
    grupos.push(['Los acepta esta impresora', [...acepta.map(([k, v]) => opt(k, v.t)), ...otrosImp.map(d => opt('imp:' + d.nombre, `${d.nombre} (${cm(d.w)} × ${cm(d.h)} cm)`))]]);
    grupos.push(['Otros tamaños', comunes.filter(e => !acepta.includes(e)).map(([k, v]) => opt(k, v.t))]);
  } else for (const g of ['Hojas', 'Sobres', 'Fotos', 'Etiquetas']) grupos.push([g, comunes.filter(([, v]) => v.g === g).map(([k, v]) => opt(k, v.t))]);
  grupos.push(['Otro', [opt('Personalizado', PAPELES.Personalizado.t)]]);
  return grupos.filter(([, l]) => l.length).map(([g, l]) => el('optgroup', { label: g }, ...l));
}
const PT_MM = 25.4 / 72;
const margenMinimo = papel => Math.min(papel.w, papel.h) < 80 ? 1.5 : 5; // mm (las impresoras no llegan al borde; en etiquetas casi nada)
export const OPCIONES_BASE = { impresora: '', copias: 1, intercalar: true, paginas: 'todas', rango: '', subconjunto: 'todas', papel: 'A4', papelW: 21, papelH: 29.7,
  orientacion: 'auto', margenes: 'minimos', margenMm: 10, ajuste: 'ajustar', escala: 100, porHoja: 1, bordes: false, girarAuto: true,
  color: true, dobleFaz: 'simplex', calidad: 'normal', comentarios: true, firmas: true, pie: false, invertir: false };
const PUNTOS = { borrador: 150, normal: 200, alta: 300 }; // puntos por pulgada de cada calidad
// columnas × filas para cada cantidad de páginas por hoja (en hoja horizontal; en vertical se dan vuelta las de 2 y 6)
const GRILLAS = { 1: [1, 1], 2: [2, 1], 4: [2, 2], 6: [3, 2], 9: [3, 3], 16: [4, 4] };

// Qué páginas (base 1) se imprimen según las opciones, ya en el orden de impresión
export function elegirPaginas(o, total, actual) {
  let lista = o.paginas === 'actual' ? [actual] : o.paginas === 'rango' ? ops.leerRangos(o.rango, total).flat().map(i => i + 1) : [...Array(total).keys()].map(i => i + 1);
  if (o.subconjunto === 'impares') lista = lista.filter(n => n % 2);
  if (o.subconjunto === 'pares') lista = lista.filter(n => !(n % 2));
  if (o.invertir) lista.reverse();
  return lista;
}
// Las hojas de papel: grupos de páginas (de a una, o de a 2, 4… si se imprimen varias por hoja)
export function hojasDe(lista, o) {
  const n = GRILLAS[o.porHoja] ? +o.porHoja : 1, out = [];
  for (let i = 0; i < lista.length; i += n) out.push(lista.slice(i, i + n));
  return out;
}
// Cómo se arma una hoja: papel (con su orientación), márgenes, lugar de cada página (celdas) y del pie. Todo en mm.
export function disposicion(o) {
  const base = medidasPapel(o), n = GRILLAS[o.porHoja] ? +o.porHoja : 1;
  const corto = Math.min(base.w, base.h), largo = Math.max(base.w, base.h);
  // automática: como viene el papel, salvo 2 y 6 por hoja, que entran mejor con la hoja acostada
  const horizontal = o.orientacion === 'horizontal' || (o.orientacion === 'auto' && (n === 2 || n === 6 ? true : base.w > base.h));
  const papel = horizontal ? { w: largo, h: corto } : { w: corto, h: largo };
  let [cols, filas] = GRILLAS[n];
  if (!horizontal && (n === 2 || n === 6)) [cols, filas] = [filas, cols];
  const m = o.margenes === 'sin' ? 0 : o.margenes === 'normales' ? 10 : o.margenes === 'personalizados' ? Math.max(0, Math.min(corto / 3, +o.margenMm || 0)) : margenMinimo(papel);
  const pieAlto = o.pie ? 5 : 0, hueco = n > 1 ? 4 : 0;
  const libreW = papel.w - 2 * m, libreH = papel.h - 2 * m - pieAlto;
  const cw = (libreW - hueco * (cols - 1)) / cols, ch = (libreH - hueco * (filas - 1)) / filas;
  const celdas = [];
  for (let f = 0; f < filas; f++) for (let c = 0; c < cols; c++) celdas.push({ x: m + c * (cw + hueco), y: m + f * (ch + hueco), w: cw, h: ch });
  return { papel, horizontal, margen: m, celdas, pie: o.pie ? { x: m, y: papel.h - m - pieAlto, w: libreW, h: pieAlto } : null };
}
// Una página dentro de su celda: si se gira para aprovechar el lugar, y su tamaño en mm (centrada en la celda)
export function ubicar(anchoPt, altoPt, celda, o) {
  const pw = anchoPt * PT_MM, ph = altoPt * PT_MM;
  // solo con una página por hoja: con varias, giradas de costado cuestan leerse (la orientación del papel ya las acomoda)
  const girar = o.girarAuto !== false && !(+o.porHoja > 1) && Math.abs(pw - ph) > 1 && (pw > ph) !== (celda.w > celda.h);
  let w = girar ? ph : pw, h = girar ? pw : ph;
  const entra = Math.min(celda.w / w, celda.h / h);
  const f = o.ajuste === 'ajustar' ? entra : o.ajuste === 'reducir' ? Math.min(1, entra) : o.ajuste === 'escala' ? Math.max(0.1, Math.min(4, (+o.escala || 100) / 100)) : 1;
  w *= f; h *= f;
  return { girar, w, h, x: celda.x + (celda.w - w) / 2, y: celda.y + (celda.h - h) / 2, factor: f };
}
// Arma una hoja de papel como imagen (lienzo) a "ppp" puntos por pulgada
export async function componerHoja(doc, numeros, o, ppp, extras = {}) {
  const L = disposicion(o), k = ppp / 25.4;
  const lienzo = document.createElement('canvas');
  lienzo.width = Math.max(1, Math.round(L.papel.w * k)); lienzo.height = Math.max(1, Math.round(L.papel.h * k));
  const g = lienzo.getContext('2d', { alpha: false });
  g.fillStyle = '#fff'; g.fillRect(0, 0, lienzo.width, lienzo.height);
  for (let i = 0; i < numeros.length; i++) {
    const celda = L.celdas[i], pagina = await doc.getPage(numeros[i]);
    const v1 = pagina.getViewport({ scale: 1, rotation: pagina.rotate }), u = ubicar(v1.width, v1.height, celda, o);
    // la página se dibuja al tamaño justo (sin pasarse de unos 40 millones de puntos)
    const anchoPx = (u.girar ? u.h : u.w) * k, escala = Math.min(anchoPx / v1.width, Math.sqrt(4e7 / (v1.width * v1.height)));
    const v = pagina.getViewport({ scale: escala, rotation: pagina.rotate });
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(v.width)); c.height = Math.max(1, Math.round(v.height));
    const gc = c.getContext('2d', { alpha: false });
    gc.fillStyle = '#fff'; gc.fillRect(0, 0, c.width, c.height);
    await pagina.render({ canvasContext: gc, viewport: v }).promise;
    if (o.comentarios !== false) pintarComentarios(gc, (extras.comentarios || []).filter(x => x.n === numeros[i]), v, { notas: false });
    if (o.firmas !== false) await pintarFirmas(gc, (extras.firmas || []).filter(x => x.n === numeros[i]), v);
    g.save();
    g.beginPath(); g.rect(celda.x * k, celda.y * k, celda.w * k, celda.h * k); g.clip(); // lo que no entra en la celda no se imprime
    if (!o.color) g.filter = 'grayscale(1)';
    g.translate((u.x + u.w / 2) * k, (u.y + u.h / 2) * k);
    if (u.girar) g.rotate(-Math.PI / 2); // el borde de arriba de la página queda a la izquierda
    const dw = (u.girar ? u.h : u.w) * k, dh = (u.girar ? u.w : u.h) * k;
    g.drawImage(c, -dw / 2, -dh / 2, dw, dh);
    g.restore();
    if (o.bordes) { g.strokeStyle = '#888'; g.lineWidth = Math.max(1, 0.25 * k); g.strokeRect(u.x * k, u.y * k, u.w * k, u.h * k); }
    c.width = c.height = 0;
  }
  if (L.pie && extras.pie) { // pie: nombre del archivo, fecha y número de hoja
    g.fillStyle = '#555'; g.font = `${Math.round(2.6 * k)}px sans-serif`; g.textBaseline = 'middle';
    const y = (L.pie.y + L.pie.h / 2) * k;
    g.textAlign = 'left'; g.fillText(extras.pie.izquierda || '', L.pie.x * k, y);
    g.textAlign = 'right'; g.fillText(extras.pie.derecha || '', (L.pie.x + L.pie.w) * k, y);
  }
  return { lienzo, L };
}
const aJpg = c => new Promise(r => c.toBlob(async b => r(new Uint8Array(await b.arrayBuffer())), 'image/jpeg', 0.92));
const fechaHoy = () => new Date().toLocaleDateString('es-AR');

export async function abrirImpresion(ctx) {
  const { el, api, aviso, pestana } = ctx;
  const p = pestana();
  if (!p?.visor?.doc) return;
  const guardadas = { ...OPCIONES_BASE, ...(ctx.prefs().impresion || {}) };
  const o = { ...guardadas, copias: 1, paginas: 'todas', rango: '', subconjunto: 'todas', invertir: false };
  const impresoras = await api.impresoras().catch(() => []);
  const pre = ctx.prefs().impresoraPredeterminada;
  if (!impresoras.some(i => i.name === o.impresora)) o.impresora = (impresoras.find(i => i.name === pre) || impresoras.find(i => i.isDefault) || impresoras[0])?.name || '';

  // las firmas se dibujan sobre cada hoja: así también sirve con PDF que tienen contraseña
  const { firmas, comentarios } = p;
  const doc = await pdfjs.getDocument({ data: (Object.keys(p.campos || {}).length ? await ops.ponerCampos(p.datos, p.campos) : p.datos).slice(), isEvalSupported: false, cMapUrl: BASE + 'cmaps/', cMapPacked: true, standardFontDataUrl: BASE + 'standard_fonts/', password: p.clave || undefined }).promise;
  const total = doc.numPages, actual = p.visor.actual;
  const extras = { firmas, comentarios };

  // ---- Controles ----
  const radios = (nombre, valores, actualV) => el('div', { class: 'segmentos' }, ...valores.map(([v, t]) =>
    el('label', {}, el('input', { type: 'radio', name: nombre, value: v, checked: String(v) === String(actualV) }), el('span', {}, t))));
  const elegido = c => c.querySelector('input:checked').value;
  const opcionesSelect = (valores, actualV) => valores.map(([v, t]) => el('option', { value: v, selected: String(v) === String(actualV) }, t));
  const casilla = (t, valor) => el('label', { class: 'casilla' }, el('input', { type: 'checkbox', checked: !!valor }), el('span', {}, t));
  const marcada = c => c.querySelector('input').checked;
  const cImpresora = el('select', { class: 'campo' }, ...(impresoras.length ? opcionesSelect(impresoras.map(i => [i.name, (i.displayName || i.name) + (i.isDefault ? ' (predeterminada)' : '')]), o.impresora) : [el('option', { value: '' }, 'No hay impresoras instaladas')]));
  const cCopias = el('input', { class: 'campo', type: 'number', min: 1, max: 99, value: 1, style: 'width:64px' });
  const cIntercalar = casilla('Intercalar', o.intercalar);
  const cPaginas = el('div', { class: 'imp-paginas' },
    ...[['todas', `Todas (${total})`], ['actual', `Página actual (${actual})`], ['rango', 'Páginas:']].map(([v, t]) =>
      el('label', { class: 'casilla' }, el('input', { type: 'radio', name: 'imp-pag', value: v, checked: v === 'todas' }), el('span', {}, t))));
  const cRango = el('input', { class: 'campo', type: 'text', placeholder: 'ej.: 1-3, 5', style: 'width:110px;text-align:left' });
  cPaginas.lastChild.append(cRango);
  const cSub = el('select', { class: 'campo' }, ...opcionesSelect([['todas', 'Todas'], ['impares', 'Solo las impares (1, 3, 5…)'], ['pares', 'Solo las pares (2, 4, 6…)']], 'todas'));
  const cInvertir = casilla('En orden inverso (la última primero)', false);
  const cPapel = el('select', { class: 'campo' }, ...opcionesPapel(el, o.papel));
  const numero = (v, min, max, paso, ancho = 64) => el('input', { class: 'campo', type: 'number', min, max, step: paso, value: v, style: `width:${ancho}px` });
  const cAncho = numero(o.papelW, 2, 120, 0.1), cAlto = numero(o.papelH, 2, 120, 0.1);
  const cMedida = el('div', { class: 'imp-medida' }, cAncho, el('span', {}, '×'), cAlto, el('span', { class: 'sutil' }, 'cm (ancho × alto)'));
  const cOrientacion = radios('imp-ori', [['auto', 'Automática'], ['vertical', 'Vertical'], ['horizontal', 'Horizontal']], o.orientacion);
  const cPorHoja = el('select', { class: 'campo' }, ...opcionesSelect([[1, '1 página por hoja'], [2, '2 páginas por hoja'], [4, '4 páginas por hoja'], [6, '6 páginas por hoja'], [9, '9 páginas por hoja'], [16, '16 páginas por hoja']], o.porHoja));
  const cBordes = casilla('Con borde alrededor de cada página', o.bordes);
  const cMargenes = el('select', { class: 'campo' }, ...opcionesSelect([['sin', 'Sin márgenes (hasta el borde)'], ['minimos', 'Mínimos'], ['normales', 'Normales (1 cm)'], ['personalizados', 'Personalizados…']], o.margenes));
  const cMargenMm = numero(o.margenMm, 0, 50, 1);
  const filaMargen = el('div', { class: 'imp-medida' }, cMargenMm, el('span', { class: 'sutil' }, 'mm en cada borde'));
  const cAjuste = el('select', { class: 'campo' }, ...opcionesSelect([['ajustar', 'Ajustar a la hoja'], ['reducir', 'Reducir solo si no entra'], ['real', 'Tamaño real (100 %)'], ['escala', 'Escala personalizada…']], o.ajuste));
  const cEscala = numero(o.escala, 10, 400, 5);
  const filaEscala = el('div', { class: 'imp-medida' }, cEscala, el('span', { class: 'sutil' }, '%'));
  const cGirar = casilla('Girar las páginas para aprovechar la hoja', o.girarAuto);
  const cColor = radios('imp-color', [['1', 'Color'], ['0', 'Blanco y negro']], o.color ? '1' : '0');
  const cDoble = el('select', { class: 'campo' }, ...opcionesSelect([['simplex', 'Una sola cara'], ['longEdge', 'Doble faz (da vuelta por el borde largo)'], ['shortEdge', 'Doble faz (da vuelta por el borde corto)']], o.dobleFaz));
  const cCalidad = radios('imp-calidad', [['borrador', 'Borrador'], ['normal', 'Normal'], ['alta', 'Alta']], o.calidad);
  const cComentarios = casilla('Comentarios (resaltados, textos, dibujos)', o.comentarios);
  const cFirmas = casilla('Firmas y sellos', o.firmas);
  const cPie = casilla('Pie con nombre, fecha y número de hoja', o.pie);
  const fila = (t, ...c) => el('div', { class: 'imp-fila' }, el('span', { class: 'sutil' }, t), el('div', { class: 'imp-control' }, ...c));
  const titulo = t => el('h4', { class: 'imp-titulo' }, t);
  const filaMedida = fila('', cMedida), filaMargenes = fila('', filaMargen), filaEscalaF = fila('', filaEscala), filaBordes = fila('', cBordes);
  const error = el('p', { class: 'dialogo-error', hidden: true });

  // ---- Vista previa: la hoja armada igual que para imprimir (en baja resolución) ----
  const hoja = el('div', { class: 'imp-hoja' }), imgPrevia = el('img', { alt: 'Vista previa de la hoja' });
  hoja.append(imgPrevia);
  const pie = el('span', { class: 'sutil' });
  const ant = el('button', { class: 'btn-icono', title: 'Hoja anterior', html: ctx.icono.arriba, style: 'transform:rotate(-90deg)' });
  const sig = el('button', { class: 'btn-icono', title: 'Hoja siguiente', html: ctx.icono.abajo, style: 'transform:rotate(-90deg)' });
  const resumen = el('p', { class: 'sutil imp-resumen' });
  let lista = [], hojas = [], idx = 0, turno = 0;
  const previas = new Map();
  const textoPie = (i, de) => ({ izquierda: `${p.nombre} · ${fechaHoy()}`, derecha: `Hoja ${i + 1} de ${de}` });
  async function previa() {
    const t = ++turno;
    error.hidden = true;
    try { lista = elegirPaginas(o, total, actual); } catch (e) { error.textContent = e.message; error.hidden = false; lista = []; }
    hojas = hojasDe(lista, o);
    if (!hojas.length) { imgPrevia.hidden = true; pie.textContent = error.hidden ? 'No hay páginas para imprimir' : ''; resumen.textContent = ''; botonImprimir.disabled = true; return; }
    botonImprimir.disabled = !o.impresora;
    idx = Math.min(idx, hojas.length - 1);
    const L = disposicion(o);
    const copias = o.copias > 1 ? ` × ${o.copias} copias` : '', caras = o.dobleFaz !== 'simplex' ? ` (${Math.ceil(hojas.length / 2)} ${Math.ceil(hojas.length / 2) === 1 ? 'papel' : 'papeles'} a doble faz)` : '';
    resumen.textContent = `${lista.length} ${lista.length === 1 ? 'página' : 'páginas'} en ${hojas.length} ${hojas.length === 1 ? 'hoja' : 'hojas'}${copias}${caras} · ${L.horizontal ? 'horizontal' : 'vertical'} · ${String(+(L.papel.w / 10).toFixed(1)).replace('.', ',')} × ${String(+(L.papel.h / 10).toFixed(1)).replace('.', ',')} cm`;
    pie.textContent = `Hoja ${idx + 1} de ${hojas.length} · ${hojas[idx].length === 1 ? 'página ' + hojas[idx][0] : 'páginas ' + hojas[idx].join(', ')}`;
    ant.disabled = idx === 0; sig.disabled = idx === hojas.length - 1;
    // el recuadro toma la forma del papel: el lado largo ocupa el lugar disponible
    const marco = hoja.parentElement, ancho = marco?.clientWidth || 340, alto = marco?.clientHeight || 440;
    const esc = Math.min((ancho - 32) / L.papel.w, (alto - 32) / L.papel.h);
    Object.assign(hoja.style, { aspectRatio: `${L.papel.w} / ${L.papel.h}`, width: L.papel.w * esc + 'px', height: L.papel.h * esc + 'px' });
    const clave = JSON.stringify([hojas[idx], idx, hojas.length, o.papel, o.papelW, o.papelH, o.orientacion, o.margenes, o.margenMm, o.ajuste, o.escala, o.porHoja, o.bordes, o.girarAuto, o.color, o.comentarios, o.firmas, o.pie]);
    if (!previas.has(clave)) {
      const ppp = Math.min(90, 900 / Math.max(L.papel.w, L.papel.h) * 25.4); // unos 900 puntos del lado largo
      const { lienzo } = await componerHoja(doc, hojas[idx], o, ppp, { ...extras, pie: textoPie(idx, hojas.length) });
      if (previas.size > 40) previas.clear();
      previas.set(clave, lienzo.toDataURL('image/jpeg', 0.85));
      lienzo.width = lienzo.height = 0;
    }
    if (t !== turno) return;
    imgPrevia.src = previas.get(clave); imgPrevia.hidden = false; imgPrevia.style.width = imgPrevia.style.height = '100%'; // la imagen ya es la hoja entera
  }
  ant.onclick = () => { idx--; previa(); }; sig.onclick = () => { idx++; previa(); };

  let tamImp = []; // tamaños que acepta la impresora elegida (los pide al sistema)
  async function papelesDeImpresora() {
    const nombre = o.impresora;
    const l = nombre ? await api.papelesImpresora(nombre).catch(() => []) : [];
    if (nombre !== o.impresora) return;
    tamImp = l || [];
    if (o.papel.startsWith('imp:') && !tamImp.some(d => 'imp:' + d.nombre === o.papel)) o.papel = 'Personalizado';
    cPapel.replaceChildren(...opcionesPapel(el, o.papel, tamImp));
    cPapel.value = o.papel;
  }
  const num = (c, d) => +String(c.value).replace(',', '.') || d;
  const leer = () => {
    o.impresora = cImpresora.value; o.copias = Math.max(1, Math.min(99, Math.floor(+cCopias.value) || 1));
    o.intercalar = marcada(cIntercalar);
    o.paginas = elegido(cPaginas); o.rango = cRango.value; o.subconjunto = cSub.value; o.invertir = marcada(cInvertir);
    o.papel = cPapel.value;
    const di = tamImp.find(d => 'imp:' + d.nombre === o.papel);
    if (di) { o.papelW = +(di.w / 10).toFixed(2); o.papelH = +(di.h / 10).toFixed(2); }
    else if (o.papel === 'Personalizado') { o.papelW = Math.min(120, Math.max(2, num(cAncho, 21))); o.papelH = Math.min(120, Math.max(2, num(cAlto, 29.7))); }
    o.orientacion = elegido(cOrientacion); o.porHoja = +cPorHoja.value; o.bordes = marcada(cBordes);
    o.margenes = cMargenes.value; o.margenMm = Math.max(0, Math.min(50, num(cMargenMm, 0)));
    o.ajuste = cAjuste.value; o.escala = Math.max(10, Math.min(400, num(cEscala, 100))); o.girarAuto = marcada(cGirar);
    o.color = elegido(cColor) === '1'; o.dobleFaz = cDoble.value; o.calidad = elegido(cCalidad);
    o.comentarios = marcada(cComentarios); o.firmas = marcada(cFirmas); o.pie = marcada(cPie);
    filaMedida.hidden = o.papel !== 'Personalizado'; filaMargenes.hidden = o.margenes !== 'personalizados'; filaEscalaF.hidden = o.ajuste !== 'escala';
    filaBordes.hidden = o.porHoja === 1; cIntercalar.hidden = o.copias < 2;
  };
  const cambio = e => { const otra = e?.currentTarget === cImpresora && cImpresora.value !== o.impresora; leer(); previa(); if (otra) papelesDeImpresora(); };
  cRango.addEventListener('focus', () => { cPaginas.querySelector('[value=rango]').checked = true; });
  for (const c of [cImpresora, cCopias, cIntercalar, cPaginas, cSub, cInvertir, cPapel, cAncho, cAlto, cOrientacion, cPorHoja, cBordes, cMargenes, cMargenMm, cAjuste, cEscala, cGirar, cColor, cDoble, cCalidad, cComentarios, cFirmas, cPie]) c.addEventListener('change', cambio);
  for (const c of [cRango, cEscala, cMargenMm]) c.addEventListener('input', () => { clearTimeout(c.t); c.t = setTimeout(cambio, 300); });
  // los números se escriben sin que las teclas lleguen al programa (Ctrl+P, flechas, Supr)
  for (const c of [cCopias, cRango, cAncho, cAlto, cMargenMm, cEscala]) c.addEventListener('keydown', e => e.stopPropagation());

  const botonImprimir = el('button', { class: 'btn-primario' }, 'Imprimir');
  const botonCancelar = el('button', { class: 'btn-texto boton-secundario' }, 'Cancelar');
  const botonRestablecer = el('button', { class: 'btn-texto boton-secundario', title: 'Volver a las opciones de fábrica (no cambia la impresora)' }, 'Restablecer');
  const d = el('dialog', { class: 'dialogo dialogo-ancho imprimir' },
    el('h3', {}, 'Imprimir'),
    el('div', { class: 'imp-cuerpo' },
      el('div', { class: 'imp-previa' }, el('div', { class: 'imp-marco' }, hoja), el('div', { class: 'imp-nav' }, ant, pie, sig), resumen),
      el('div', { class: 'imp-opciones' },
        fila('Impresora', cImpresora), fila('Copias', cCopias, cIntercalar),
        titulo('Páginas'), fila('Cuáles', cPaginas), fila('', cSub), fila('', cInvertir),
        titulo('Papel y diseño'), fila('Papel', cPapel), filaMedida, fila('Orientación', cOrientacion), fila('Por hoja', cPorHoja), filaBordes,
        fila('Márgenes', cMargenes), filaMargenes, fila('Tamaño', cAjuste), filaEscalaF, fila('', cGirar),
        titulo('Impresión'), fila('Color', cColor), fila('Calidad', cCalidad), fila('Caras', cDoble),
        titulo('Qué se imprime'), fila('', cComentarios), fila('', cFirmas), fila('', cPie), error)),
    el('div', { class: 'dialogo-botones' }, botonRestablecer, el('span', { style: 'flex:1' }), botonCancelar, botonImprimir));
  document.body.append(d);
  botonRestablecer.onclick = () => {
    const base = { ...OPCIONES_BASE, impresora: o.impresora };
    cPapel.value = base.papel; cAncho.value = base.papelW; cAlto.value = base.papelH;
    for (const [c, v] of [[cOrientacion, base.orientacion], [cColor, '1'], [cCalidad, base.calidad]]) c.querySelector(`input[value="${v}"]`).checked = true;
    cPorHoja.value = base.porHoja; cMargenes.value = base.margenes; cMargenMm.value = base.margenMm; cAjuste.value = base.ajuste; cEscala.value = base.escala; cDoble.value = base.dobleFaz;
    for (const [c, v] of [[cBordes, base.bordes], [cGirar, base.girarAuto], [cComentarios, base.comentarios], [cFirmas, base.firmas], [cPie, base.pie], [cInvertir, false]]) c.querySelector('input').checked = v;
    cambio();
  };
  leer();
  d.showModal();
  papelesDeImpresora().then(() => { leer(); previa(); });
  await previa();

  const r = await new Promise(res => {
    botonCancelar.onclick = () => res(false);
    botonImprimir.onclick = () => res(true);
    d.addEventListener('cancel', () => res(false));
  });
  if (!r) { d.close(); d.remove(); doc.destroy(); return; }
  leer();
  const grupos = hojas.slice();
  const { copias, paginas, rango, subconjunto, invertir, ...recordar } = o; // lo de este documento no se recuerda
  ctx.guardarPref('impresion', recordar);
  botonImprimir.disabled = true; botonCancelar.disabled = true; botonRestablecer.disabled = true;
  try {
    const datos = [], ppp = PUNTOS[o.calidad] || 200, L = disposicion(o);
    for (let i = 0; i < grupos.length; i++) {
      botonImprimir.textContent = `Preparando ${i + 1} de ${grupos.length}…`;
      const { lienzo } = await componerHoja(doc, grupos[i], o, ppp, { ...extras, pie: textoPie(i, grupos.length) });
      datos.push({ datos: await aJpg(lienzo), ancho: L.papel.w, alto: L.papel.h });
      lienzo.width = lienzo.height = 0;
    }
    botonImprimir.textContent = 'Enviando a la impresora…';
    const res = await api.imprimir({ hojas: datos, papel: { w: L.papel.w, h: L.papel.h }, horizontal: L.horizontal, impresora: o.impresora, copias: o.copias, intercalar: o.intercalar, color: o.color, dobleFaz: o.dobleFaz, nombre: p.nombre });
    if (res.ok) aviso(`Enviado a ${o.impresora}: ${grupos.length} ${grupos.length === 1 ? 'hoja' : 'hojas'}${o.copias > 1 ? ` × ${o.copias} copias` : ''}.`);
    else aviso(res.error && !/cancel/i.test(res.error) ? 'La impresora no respondió: ' + res.error : 'Impresión cancelada.', !!res.error && !/cancel/i.test(res.error));
  } catch (e) { ctx.error(e); }
  finally { d.close(); d.remove(); doc.destroy(); }
}
