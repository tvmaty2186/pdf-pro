// PDF.Pro — módulo de impresión: vista previa, impresora, copias, páginas, papel, ajuste, color, doble faz.
// Cada hoja se dibuja como imagen (con las firmas y comentarios encima; las notas no se imprimen) y se manda a la impresora desde una ventana oculta.
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
const margen = papel => Math.min(papel.w, papel.h) < 80 ? 1.5 : 5; // mm libres al ajustar (las impresoras no llegan al borde; en etiquetas casi nada)
const OPCIONES_BASE = { impresora: '', copias: 1, intercalar: true, paginas: 'todas', rango: '', subconjunto: 'todas', papel: 'A4', papelW: 21, papelH: 29.7, ajuste: 'ajustar', color: true, dobleFaz: 'simplex', calidad: 'normal' };

// Qué páginas (base 1) se imprimen según las opciones
function elegirPaginas(o, total, actual) {
  let lista = o.paginas === 'actual' ? [actual] : o.paginas === 'rango' ? ops.leerRangos(o.rango, total).flat().map(i => i + 1) : [...Array(total).keys()].map(i => i + 1);
  if (o.subconjunto === 'impares') lista = lista.filter(n => n % 2);
  if (o.subconjunto === 'pares') lista = lista.filter(n => !(n % 2));
  return lista;
}
// Ubicación de una página en la hoja: tamaño en mm y si se gira para aprovechar el papel
function ubicar(anchoPt, altoPt, o) {
  const papel = medidasPapel(o);
  const girar = (anchoPt > altoPt) !== (papel.w > papel.h); // página apaisada en hoja vertical: se gira sola
  let w = (girar ? altoPt : anchoPt) * PT_MM, h = (girar ? anchoPt : altoPt) * PT_MM;
  const m = margen(papel), libreW = papel.w - m * 2, libreH = papel.h - m * 2;
  const esc = Math.min(libreW / w, libreH / h);
  if (o.ajuste === 'ajustar' || (o.ajuste === 'reducir' && esc < 1)) { w *= esc; h *= esc; }
  return { girar, w, h, papel };
}

async function dibujarHoja(pagina, o, escala, firmas, comentarios) {
  const v = pagina.getViewport({ scale: escala, rotation: pagina.rotate });
  const c = document.createElement('canvas');
  c.width = Math.round(v.width); c.height = Math.round(v.height);
  const g = c.getContext('2d', { alpha: false });
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  await pagina.render({ canvasContext: g, viewport: v }).promise;
  pintarComentarios(g, comentarios.filter(c => c.n === pagina.pageNumber), v, { notas: false });
  await pintarFirmas(g, firmas.filter(f => f.n === pagina.pageNumber), v);
  const u = ubicar(v.width, v.height, o);
  if (!u.girar && o.color) return { lienzo: c, u };
  const f = document.createElement('canvas');
  f.width = u.girar ? c.height : c.width; f.height = u.girar ? c.width : c.height;
  const gf = f.getContext('2d', { alpha: false });
  if (!o.color) gf.filter = 'grayscale(1)';
  if (u.girar) { gf.translate(0, f.height); gf.rotate(-Math.PI / 2); } // el borde de arriba queda a la izquierda
  gf.drawImage(c, 0, 0);
  return { lienzo: f, u };
}
const aJpg = c => new Promise(r => c.toBlob(async b => r(new Uint8Array(await b.arrayBuffer())), 'image/jpeg', 0.92));

export async function abrirImpresion(ctx) {
  const { el, api, aviso, pestana } = ctx;
  const p = pestana();
  if (!p?.visor?.doc) return;
  const guardadas = { ...OPCIONES_BASE, ...(ctx.prefs().impresion || {}) };
  const o = { ...guardadas, copias: 1, paginas: 'todas', rango: '', subconjunto: 'todas' };
  const impresoras = await api.impresoras().catch(() => []);
  const pre = ctx.prefs().impresoraPredeterminada;
  if (!impresoras.some(i => i.name === o.impresora)) o.impresora = (impresoras.find(i => i.name === pre) || impresoras.find(i => i.isDefault) || impresoras[0])?.name || '';

  // las firmas se dibujan sobre cada hoja: así también sirve con PDF que tienen contraseña
  const { firmas, comentarios } = p;
  const doc = await pdfjs.getDocument({ data: (Object.keys(p.campos || {}).length ? await ops.ponerCampos(p.datos, p.campos) : p.datos).slice(), isEvalSupported: false, cMapUrl: BASE + 'cmaps/', cMapPacked: true, standardFontDataUrl: BASE + 'standard_fonts/', password: p.clave || undefined }).promise;
  const total = doc.numPages, actual = p.visor.actual;

  // ---- Controles ----
  const radios = (nombre, valores, actualV) => el('div', { class: 'segmentos' }, ...valores.map(([v, t]) =>
    el('label', {}, el('input', { type: 'radio', name: nombre, value: v, checked: v === actualV }), el('span', {}, t))));
  const opcionesSelect = (valores, actualV) => valores.map(([v, t]) => el('option', { value: v, selected: v === actualV }, t));
  const cImpresora = el('select', { class: 'campo' }, ...(impresoras.length ? opcionesSelect(impresoras.map(i => [i.name, (i.displayName || i.name) + (i.isDefault ? ' (predeterminada)' : '')]), o.impresora) : [el('option', { value: '' }, 'No hay impresoras instaladas')]));
  const cCopias = el('input', { class: 'campo', type: 'number', min: 1, max: 99, value: 1, style: 'width:64px' });
  const cIntercalar = el('label', { class: 'casilla' }, el('input', { type: 'checkbox', checked: o.intercalar }), el('span', {}, 'Intercalar'));
  const cPaginas = el('div', { class: 'imp-paginas' },
    ...[['todas', `Todas (${total})`], ['actual', `Página actual (${actual})`], ['rango', 'Páginas:']].map(([v, t]) =>
      el('label', { class: 'casilla' }, el('input', { type: 'radio', name: 'imp-pag', value: v, checked: v === 'todas' }), el('span', {}, t))));
  const cRango = el('input', { class: 'campo', type: 'text', placeholder: 'ej.: 1-3, 5', style: 'width:110px;text-align:left' });
  cPaginas.lastChild.append(cRango);
  const cSub = el('select', { class: 'campo' }, ...opcionesSelect([['todas', 'Todas'], ['impares', 'Solo las impares (1, 3, 5…)'], ['pares', 'Solo las pares (2, 4, 6…)']], 'todas'));
  const cPapel = el('select', { class: 'campo' }, ...opcionesPapel(el, o.papel));
  const numero = v => el('input', { class: 'campo', type: 'number', min: 2, max: 120, step: 0.1, value: v, style: 'width:64px' });
  const cAncho = numero(o.papelW), cAlto = numero(o.papelH);
  const cMedida = el('div', { class: 'imp-medida' }, cAncho, el('span', {}, '×'), cAlto, el('span', { class: 'sutil' }, 'cm (ancho × alto)'));
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
  const cAjuste = radios('imp-ajuste', [['ajustar', 'Ajustar'], ['real', 'Tamaño real'], ['reducir', 'Reducir si no entra']], o.ajuste);
  const cColor = radios('imp-color', [['1', 'Color'], ['0', 'Blanco y negro']], o.color ? '1' : '0');
  const cDoble = el('select', { class: 'campo' }, ...opcionesSelect([['simplex', 'Una sola cara'], ['longEdge', 'Doble faz (borde largo)'], ['shortEdge', 'Doble faz (borde corto)']], o.dobleFaz));
  const cCalidad = radios('imp-calidad', [['normal', 'Normal'], ['alta', 'Alta']], o.calidad);
  const fila = (t, ...c) => el('div', { class: 'imp-fila' }, el('span', { class: 'sutil' }, t), el('div', { class: 'imp-control' }, ...c));
  const filaMedida = fila('', cMedida);
  const error = el('p', { class: 'dialogo-error', hidden: true });

  // ---- Vista previa ----
  const hoja = el('div', { class: 'imp-hoja' }), imgPrevia = el('img', { alt: '' });
  hoja.append(imgPrevia);
  const pie = el('span', { class: 'sutil' });
  const ant = el('button', { class: 'btn-icono', title: 'Anterior', html: ctx.icono.arriba, style: 'transform:rotate(-90deg)' });
  const sig = el('button', { class: 'btn-icono', title: 'Siguiente', html: ctx.icono.abajo, style: 'transform:rotate(-90deg)' });
  let lista = [], idx = 0, turno = 0;
  const previas = new Map();
  async function previa() {
    const t = ++turno;
    error.hidden = true;
    try { lista = elegirPaginas(o, total, actual); } catch (e) { error.textContent = e.message; error.hidden = false; lista = []; }
    if (!lista.length) { imgPrevia.hidden = true; pie.textContent = error.hidden ? 'No hay páginas para imprimir' : ''; botonImprimir.disabled = true; return; }
    botonImprimir.disabled = !o.impresora;
    idx = Math.min(idx, lista.length - 1);
    const n = lista[idx];
    pie.textContent = `Hoja ${idx + 1} de ${lista.length} · página ${n} del documento`;
    ant.disabled = idx === 0; sig.disabled = idx === lista.length - 1;
    const papel = medidasPapel(o);
    hoja.style.aspectRatio = `${papel.w} / ${papel.h}`;
    const clave = n + '|' + o.color;
    if (!previas.has(clave)) {
      const pg = await doc.getPage(n);
      const r = await dibujarHoja(pg, { ...o, papel: 'A4', ajuste: 'ajustar' }, 0.9, firmas, comentarios);
      previas.set(clave, { url: r.lienzo.toDataURL('image/jpeg', 0.85), ancho: pg.getViewport({ scale: 1, rotation: pg.rotate }) });
    }
    if (t !== turno) return;
    const pv = previas.get(clave), u = ubicar(pv.ancho.width, pv.ancho.height, o);
    imgPrevia.src = pv.url; imgPrevia.hidden = false;
    imgPrevia.style.width = (u.w / papel.w * 100) + '%'; imgPrevia.style.height = (u.h / papel.h * 100) + '%';
  }
  ant.onclick = () => { idx--; previa(); }; sig.onclick = () => { idx++; previa(); };

  const leer = () => {
    o.impresora = cImpresora.value; o.copias = Math.max(1, Math.min(99, Math.floor(+cCopias.value) || 1));
    o.intercalar = cIntercalar.querySelector('input').checked;
    o.paginas = cPaginas.querySelector('input:checked').value; o.rango = cRango.value; o.subconjunto = cSub.value;
    o.papel = cPapel.value;
    const di = tamImp.find(d => 'imp:' + d.nombre === o.papel);
    if (di) { o.papelW = +(di.w / 10).toFixed(2); o.papelH = +(di.h / 10).toFixed(2); }
    else if (o.papel === 'Personalizado') { o.papelW = Math.min(120, Math.max(2, +String(cAncho.value).replace(',', '.') || 21)); o.papelH = Math.min(120, Math.max(2, +String(cAlto.value).replace(',', '.') || 29.7)); }
    filaMedida.hidden = o.papel !== 'Personalizado';
    o.ajuste = cAjuste.querySelector('input:checked').value;
    o.color = cColor.querySelector('input:checked').value === '1'; o.dobleFaz = cDoble.value;
    o.calidad = cCalidad.querySelector('input:checked').value;
    cIntercalar.hidden = o.copias < 2;
  };
  const cambio = e => { const otra = e?.currentTarget === cImpresora && cImpresora.value !== o.impresora; leer(); previa(); if (otra) papelesDeImpresora(); };
  cRango.addEventListener('focus', () => { cPaginas.querySelector('[value=rango]').checked = true; });
  for (const c of [cImpresora, cCopias, cIntercalar, cPaginas, cSub, cPapel, cAncho, cAlto, cAjuste, cColor, cDoble, cCalidad]) c.addEventListener('change', cambio);
  cRango.addEventListener('input', () => { clearTimeout(cRango.t); cRango.t = setTimeout(cambio, 300); });

  const botonImprimir = el('button', { class: 'btn-primario' }, 'Imprimir');
  const botonCancelar = el('button', { class: 'btn-texto boton-secundario' }, 'Cancelar');
  const d = el('dialog', { class: 'dialogo dialogo-ancho imprimir' },
    el('h3', {}, 'Imprimir'),
    el('div', { class: 'imp-cuerpo' },
      el('div', { class: 'imp-previa' }, el('div', { class: 'imp-marco' }, hoja), el('div', { class: 'imp-nav' }, ant, pie, sig)),
      el('div', { class: 'imp-opciones' },
        fila('Impresora', cImpresora), fila('Copias', cCopias, cIntercalar), fila('Páginas', cPaginas), fila('', cSub),
        fila('Papel', cPapel), filaMedida, fila('Tamaño', cAjuste), fila('Color', cColor), fila('Caras', cDoble), fila('Calidad', cCalidad), error)),
    el('div', { class: 'dialogo-botones' }, botonCancelar, botonImprimir));
  document.body.append(d);
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
  const paginas = lista.slice();
  ctx.guardarPref('impresion', { impresora: o.impresora, intercalar: o.intercalar, papel: o.papel, papelW: o.papelW, papelH: o.papelH, ajuste: o.ajuste, color: o.color, dobleFaz: o.dobleFaz, calidad: o.calidad });
  botonImprimir.disabled = true; botonCancelar.disabled = true;
  try {
    const hojas = [], escala = (o.calidad === 'alta' ? 300 : 200) / 72;
    for (let i = 0; i < paginas.length; i++) {
      botonImprimir.textContent = `Preparando ${i + 1} de ${paginas.length}…`;
      const { lienzo, u } = await dibujarHoja(await doc.getPage(paginas[i]), o, escala, firmas, comentarios);
      hojas.push({ datos: await aJpg(lienzo), ancho: u.w, alto: u.h });
      lienzo.width = lienzo.height = 0;
    }
    botonImprimir.textContent = 'Enviando a la impresora…';
    const papel = medidasPapel(o);
    const res = await api.imprimir({ hojas, papel: { w: papel.w, h: papel.h }, impresora: o.impresora, copias: o.copias, intercalar: o.intercalar, color: o.color, dobleFaz: o.dobleFaz, nombre: p.nombre });
    if (res.ok) aviso(`Enviado a ${o.impresora}: ${paginas.length} ${paginas.length === 1 ? 'hoja' : 'hojas'}${o.copias > 1 ? ` × ${o.copias} copias` : ''}.`);
    else aviso(res.error && !/cancel/i.test(res.error) ? 'La impresora no respondió: ' + res.error : 'Impresión cancelada.', !!res.error && !/cancel/i.test(res.error));
  } catch (e) { ctx.error(e); }
  finally { d.close(); d.remove(); doc.destroy(); }
}
