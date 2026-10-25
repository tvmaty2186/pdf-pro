// PDF.Pro — comentarios: resaltar, subrayar, tachar, notas, cuadros de texto y dibujo a mano
// Como las firmas, viven aparte en p.comentarios mientras se trabaja y se escriben como anotaciones estándar al guardar
// (Highlight, Underline, StrikeOut, Text, FreeText, Ink: también las ve Acrobat). La geometría va en puntos del PDF:
//   marcas (resaltar, subrayar, tachar): quads = un [arribaIzq, arribaDer, abajoIzq, abajoDer] por renglón; texto = lo marcado
//   nota: x, y = esquina de arriba a la izquierda del ícono      texto: rect [x0, y0, x1, y1], tam (puntos)
//   dibujo: trazos = [[x, y, x, y, …], …], grosor (puntos)        todos: id, n (página), tipo, color ('#rrggbb'), nota
import { renglonEn, letraDeRenglon } from './cuentagotas.js';

export const COLORES = [['#ffd400', 'Amarillo'], ['#7ed957', 'Verde'], ['#4fc3f7', 'Celeste'], ['#ff80bf', 'Rosa'],
  ['#ff9800', 'Naranja'], ['#e53935', 'Rojo'], ['#1e5bd8', 'Azul'], ['#1a1a1a', 'Negro']];
export const TIPOS = { resaltar: 'Resaltado', subrayar: 'Subrayado', tachar: 'Tachado', nota: 'Nota', texto: 'Cuadro de texto', dibujo: 'Dibujo' };
const HERRAMIENTAS = { ...TIPOS, resaltar: 'Resaltar', subrayar: 'Subrayar', tachar: 'Tachar', dibujo: 'Dibujar a mano', captura: 'Copiar área como imagen', leer: 'Reconocer texto de un área', censurar: 'Censurar (borra de verdad)', rellenar: 'Rellenar' };
const COLOR_INICIAL = { resaltar: '#ffd400', subrayar: '#1e5bd8', tachar: '#e53935', nota: '#ffd400', texto: '#1a1a1a', dibujo: '#e53935', rellenar: '#1a1a1a' };
export const hoy = () => new Date().toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const normalEtiqueta = t => String(t || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(-40);
export const ICONO_NOTA = 20; // lado del ícono de la nota, en puntos
export const LINEA = 1.2;     // alto de renglón del cuadro de texto (veces el tamaño de letra)
export const esMarca = c => c.tipo === 'resaltar' || c.tipo === 'subrayar' || c.tipo === 'tachar';
const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
const limitar = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------- Texto en renglones (igual en pantalla, impresión y el PDF guardado) ----------
export function partirLineas(texto, ancho, medir) {
  const lineas = [];
  for (const parrafo of String(texto ?? '').split('\n')) {
    let linea = '';
    for (const palabra of parrafo.split(' ')) {
      const prueba = linea ? linea + ' ' + palabra : palabra;
      if (!linea || medir(prueba) <= ancho) { linea = prueba; continue; }
      lineas.push(linea); linea = palabra;
    }
    while (linea.length > 1 && medir(linea) > ancho) { // palabra más larga que el cuadro: se corta por letras
      let k = linea.length - 1;
      while (k > 1 && medir(linea.slice(0, k)) > ancho) k--;
      lineas.push(linea.slice(0, k)); linea = linea.slice(k);
    }
    lineas.push(linea);
  }
  return lineas;
}
// Renglones de un cuadro de texto: los de "Rellenar" (auto) no se cortan nunca
export const lineasDe = (c, medir) => c.auto ? String(c.nota ?? '').split('\n') : partirLineas(c.nota, c.rect[2] - c.rect[0] - 4, medir);
let lienzoMedir;
// Letra de los cuadros de texto y de Rellenar: 'sans' | 'serif' | 'mono' | 'f:<familia instalada o de Mis fuentes>'
export const cssLetra = l => !l || l === 'sans' ? 'Helvetica, Arial, sans-serif' : l === 'serif' ? '"Times New Roman", Times, serif'
  : l === 'mono' ? '"Courier New", Courier, monospace' : `"${l.slice(2).replace(/"/g, '')}", Helvetica, Arial, sans-serif`;
export function medidorPantalla(tam, letra) {
  const g = (lienzoMedir ||= document.createElement('canvas')).getContext('2d');
  return s => { g.font = `${tam}px ${cssLetra(letra)}`; return g.measureText(s).width; };
}
// Alto del cuadro de texto según cuántos renglones ocupa
export const altoTexto = (c, lineas) => Math.max(1, lineas.length) * c.tam * LINEA + 4;

// ---------- Geometría compartida ----------
// Línea del subrayado o tachado de un renglón, en coordenadas de la vista: [x1, y1, x2, y2, grosor]
export function lineaMarca(tipo, [tl, tr, bl, br]) {
  const alto = Math.hypot(tl[0] - bl[0], tl[1] - bl[1]);
  const t = tipo === 'subrayar' ? 0.1 : 0.5; // desde abajo
  const p = (a, b) => [b[0] + (a[0] - b[0]) * t, b[1] + (a[1] - b[1]) * t];
  const [x1, y1] = p(tl, bl), [x2, y2] = p(tr, br);
  return [x1, y1, x2, y2, Math.max(1, alto * 0.08)];
}
const enVista = (vista, [x, y]) => vista.convertToViewportPoint(x, y);
// Cuadros de texto en páginas giradas (/Rotate): `rect` se guarda "derecho", como se lee en pantalla, y `giro` (90, 180, 270)
// dice cómo pasarlo a la página. Así el texto queda derecho en pantalla, al imprimir y al guardar.
export const girarPunto = (g, [x, y]) => g === 90 ? [-y, x] : g === 180 ? [-x, -y] : g === 270 ? [y, -x] : [x, y];
const desgirar = (g, pt) => girarPunto((360 - (g || 0)) % 360, pt);
const rectGirado = (g, r, f) => { const [a, b] = f(g, [r[0], r[1]]), [c, d] = f(g, [r[2], r[3]]); return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)]; };
export const rectEnPagina = c => c.giro ? rectGirado(c.giro, c.rect, girarPunto) : c.rect;
export const rectDerecho = (g, r) => g ? rectGirado(g, r, desgirar) : r;
// Caja (en la vista) que ocupa un comentario: { x, y, w, h }
function cajaEnVista(c, vista) {
  let pts;
  if (esMarca(c)) pts = c.quads.flat();
  else if (c.tipo === 'nota') pts = [[c.x, c.y], [c.x + ICONO_NOTA, c.y - ICONO_NOTA]];
  else if (c.tipo === 'texto') { const r = rectEnPagina(c); pts = [[r[0], r[1]], [r[2], r[3]]]; }
  else pts = c.trazos.flatMap(t => t.flatMap((v, i) => i % 2 ? [] : [[v, t[i + 1]]]));
  const v = pts.map(p => enVista(vista, p)), xs = v.map(p => p[0]), ys = v.map(p => p[1]);
  const pad = c.tipo === 'dibujo' ? c.grosor * vista.scale / 2 : 0;
  const x = Math.min(...xs) - pad, y = Math.min(...ys) - pad;
  return { x, y, w: Math.max(...xs) - x + pad, h: Math.max(...ys) - y + pad };
}
// Mueve un comentario dx, dy puntos del PDF
export function trasladar(c, dx, dy) {
  const m = ([x, y]) => [x + dx, y + dy];
  if (esMarca(c)) return { ...c, quads: c.quads.map(q => q.map(m)) };
  if (c.tipo === 'nota') return { ...c, x: c.x + dx, y: c.y + dy };
  if (c.tipo === 'texto') { [dx, dy] = desgirar(c.giro, [dx, dy]); return { ...c, rect: [c.rect[0] + dx, c.rect[1] + dy, c.rect[2] + dx, c.rect[3] + dy] }; }
  return { ...c, trazos: c.trazos.map(t => t.map((v, i) => v + (i % 2 ? dy : dx))) };
}
// Rectángulo en la vista → rect del PDF [x0, y0, x1, y1] ordenado
function rectDeVista(vista, x0, y0, x1, y1) {
  const [a, b] = vista.convertToPdfPoint(x0, y0), [c, d] = vista.convertToPdfPoint(x1, y1);
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}
// Puntos de la vista ↔ del PDF dentro de una página dibujada
const deVista = (vista, x, y) => vista.convertToPdfPoint(x, y);

// ---------- Dibujar en un lienzo (miniaturas e impresión) ----------
export function pintarComentarios(g, lista, vista, { notas = true } = {}) {
  for (const c of lista) {
    g.save();
    if (esMarca(c)) for (const q of c.quads) {
      const v = q.map(p => enVista(vista, p));
      if (c.tipo === 'resaltar') {
        g.globalCompositeOperation = 'multiply'; g.fillStyle = c.color;
        g.beginPath(); g.moveTo(...v[0]); g.lineTo(...v[1]); g.lineTo(...v[3]); g.lineTo(...v[2]); g.closePath(); g.fill();
      } else {
        const [x1, y1, x2, y2, w] = lineaMarca(c.tipo, v);
        g.strokeStyle = c.color; g.lineWidth = w; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
      }
    } else if (c.tipo === 'nota') {
      if (notas) { const [x, y] = enVista(vista, [c.x, c.y]); dibujarIconoNota(g, x, y, ICONO_NOTA * vista.scale, c.color); }
    } else if (c.tipo === 'texto') {
      const k = cajaEnVista(c, vista), lineas = lineasDe(c, medidorPantalla(c.tam, c.letra));
      if (c.tapar) { g.fillStyle = '#fff'; g.fillRect(k.x, k.y, k.w, k.h); } // tapa lo impreso abajo ("--/--/----")
      g.fillStyle = c.color; g.font = `${c.tam * vista.scale}px ${cssLetra(c.letra)}`; g.textBaseline = 'alphabetic';
      lineas.forEach((l, i) => g.fillText(l, k.x + 2 * vista.scale, k.y + (2 + c.tam * (i * LINEA + 0.92)) * vista.scale));
    } else {
      g.strokeStyle = c.color; g.lineWidth = c.grosor * vista.scale; g.lineCap = 'round'; g.lineJoin = 'round';
      for (const t of c.trazos) {
        g.beginPath();
        for (let i = 0; i < t.length; i += 2) g[i ? 'lineTo' : 'moveTo'](...enVista(vista, [t[i], t[i + 1]]));
        if (t.length === 2) g.lineTo(...enVista(vista, [t[0] + 0.01, t[1]]));
        g.stroke();
      }
    }
    g.restore();
  }
}
function dibujarIconoNota(g, x, y, s, color) {
  g.fillStyle = color; g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = Math.max(1, s / 20);
  g.beginPath(); g.moveTo(x + s * .1, y + s * .1); g.lineTo(x + s * .9, y + s * .1); g.lineTo(x + s * .9, y + s * .7);
  g.lineTo(x + s * .45, y + s * .7); g.lineTo(x + s * .25, y + s * .9); g.lineTo(x + s * .28, y + s * .7); g.lineTo(x + s * .1, y + s * .7); g.closePath(); g.fill(); g.stroke();
  g.beginPath(); [.28, .42, .56].forEach(f => { g.moveTo(x + s * .22, y + s * f); g.lineTo(x + s * .78, y + s * f); }); g.stroke();
}
const iconoNota = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 2h16v12H9l-4 4 .6-4H2z" fill="currentColor" stroke="rgba(0,0,0,.55)" stroke-width="1"/><path d="M4.5 5.6h11M4.5 8.4h11M4.5 11.2h7" stroke="rgba(0,0,0,.55)" stroke-width="1"/></svg>';

// ---------- Comentarios sobre la página ----------
export class Comentarios {
  // ctx: { el, aviso, icono, cambiarComentarios(p, lista, mensaje), pestana(), alSeleccionar() }
  constructor(ctx) {
    this.ctx = ctx; this.sel = null; this.herramienta = null;
    this.color = { ...COLOR_INICIAL }; this.grosor = 2; this.tam = 12;
    this.relleno = 'texto'; // qué pone la herramienta Rellenar: texto, tilde, cruz o fecha
    this.letra = 'sans'; // letra de los cuadros de texto y de Rellenar (la última elegida se toma de Preferencias al arrancar)
  }
  get p() { return this.ctx.pestana(); }
  buscar(id) { return this.p?.comentarios.find(c => c.id === id); }
  cambiar(c, cambios, msg) { const p = this.p; this.ctx.cambiarComentarios(p, p.comentarios.map(x => x.id === c.id ? { ...x, ...cambios } : x), msg); }
  agregar(c, msg) { const p = this.p; this.ctx.cambiarComentarios(p, [...p.comentarios, c], msg); }
  borrar(id = this.sel) {
    const p = this.p, c = this.buscar(id);
    if (!c) return;
    if (this.sel === id) this.sel = null;
    this.ctx.cambiarComentarios(p, p.comentarios.filter(x => x.id !== id), `${TIPOS[c.tipo]} borrado (Ctrl+Z para deshacer)`.replace('Nota borrado', 'Nota borrada'));
  }
  seleccionar(id, { nota = false } = {}) {
    this.sel = id; this.notaAbierta = nota ? id : null;
    this.ctx.alSeleccionar?.();
    const p = this.p; if (p) this.redibujar(p);
  }
  deseleccionar() {
    if (!this.sel && !this.editando) return;
    document.activeElement?.closest?.('.com-popup, .com-editor') && document.activeElement.blur(); // guarda lo que se estaba escribiendo
    this.sel = null; this.notaAbierta = null;
    const p = this.p; if (p) this.redibujar(p);
  }

  // ---------- Herramientas ----------
  usar(h) {
    this.ctx.api?.miga?.('herramienta: ' + h);
    const v = this.p?.visor;
    if (!v?.doc) return;
    this.herramienta = this.herramienta === h ? null : h;
    if (this.herramienta) this.ctx.antesDeUsar?.();
    this.dibujoActual = null;
    this.deseleccionar();
    if (this.herramienta && esMarca({ tipo: h }) && !getSelection().isCollapsed && this.marcarSeleccion(h)) this.herramienta = null;
    this.mostrarHerramienta();
  }
  terminarHerramienta() { if (this.herramienta) { this.herramienta = null; this.dibujoActual = null; this.mostrarHerramienta(); } }
  mostrarHerramienta() {
    const { el } = this.ctx, h = this.herramienta, v = this.p?.visor;
    document.querySelectorAll('.documento').forEach(d => { d.dataset.herramienta = ''; });
    document.querySelector('.barra-herramienta')?.remove();
    if (!h || !v) return this.ctx.alCambiarHerramienta?.();
    v.el.dataset.herramienta = h;
    const ayuda = { resaltar: 'Pintá el texto con el mouse', subrayar: 'Pintá el texto con el mouse', tachar: 'Pintá el texto con el mouse',
      nota: 'Hacé clic donde va la nota', texto: 'Hacé clic donde va el texto', dibujo: 'Dibujá con el mouse apretado', captura: 'Marcá un recuadro con el mouse', leer: 'Marcá con el mouse la parte que querés leer', censurar: 'Marcá con el mouse lo que querés borrar del archivo',
      rellenar: { texto: 'Hacé clic en el renglón y escribí', tilde: 'Hacé clic en el casillero', cruz: 'Hacé clic en el casillero', fecha: 'Hacé clic donde va la fecha' }[this.relleno] }[h];
    const barra = el('div', { class: 'barra-herramienta' }, el('b', {}, HERRAMIENTAS[h]));
    if (h === 'rellenar') barra.append(el('div', { class: 'segmentos-botones' }, ...[['texto', 'Escribir'], ['tilde', '✓ Tilde'], ['cruz', '✗ Cruz'], ['fecha', 'Fecha de hoy']].map(([m, t]) =>
      el('button', { class: 'btn-texto', 'aria-pressed': String(this.relleno === m), title: { texto: 'Escribir', tilde: 'Tilde', cruz: 'Cruz', fecha: 'Fecha de hoy (' + hoy() + ')' }[m],
        onclick: () => { this.relleno = m; this.mostrarHerramienta(); } }, t))));
    barra.append(el('span', { class: 'sutil' }, ayuda));
    if (h === 'texto' || (h === 'rellenar' && ['texto', 'fecha'].includes(this.relleno))) barra.append(this.elegirLetra(this.letra, l => { this.letra = l; this.ctx.guardarPref?.('letraTexto', l); }));
    if (h !== 'captura' && h !== 'censurar' && h !== 'leer') barra.append(this.paleta(this.color[h], color => { this.color[h] = color; this.mostrarHerramienta(); }));
    if (h === 'dibujo') barra.append(el('label', { class: 'casilla' }, 'Grosor', el('input', { type: 'range', min: 1, max: 12, value: this.grosor, class: 'deslizador', style: 'width:90px', oninput: e => { this.grosor = +e.target.value; } })));
    barra.append(el('button', { class: 'btn-texto boton-secundario', onclick: () => this.terminarHerramienta() }, 'Listo (Esc)'));
    document.querySelector('#area').append(barra);
    this.ctx.alCambiarHerramienta?.();
  }
  paleta(actual, elegir) {
    const { el } = this.ctx;
    return el('div', { class: 'paleta' }, ...COLORES.map(([c, nombre]) => el('button', { class: 'color' + (c === actual ? ' elegido' : ''), title: nombre, 'aria-label': nombre, style: `--c:${c}`,
      onpointerdown: e => e.stopPropagation(), onclick: e => { e.stopPropagation(); elegir(c); } })));
  }

  // Conecta los eventos del visor de una pestaña (se llama cada vez que se crea un visor)
  conectar(v, p) {
    v.el.addEventListener('pointerdown', e => this.pulsar(e, v, p));
    v.el.addEventListener('pointerup', () => {
      const h = this.herramienta;
      if (h && esMarca({ tipo: h })) setTimeout(() => this.marcarSeleccion(h), 0);
    });
    v.el.addEventListener('click', e => {
      if (this.herramienta || e.button !== 0 || !getSelection().isCollapsed || e.target.closest('.com, .com-barra, .com-popup, .estampa, .estampa-barra')) return;
      const m = this.marcaEn(e, v, p);
      if (m) this.seleccionar(m.id);
    });
  }
  // Dónde cayó el puntero: { pg, x, y } en píxeles de la vista de esa página
  puntoEn(e, v) {
    const div = e.target.closest?.('.pagina') || document.elementsFromPoint(e.clientX, e.clientY).find(x => x.classList?.contains('pagina'));
    const pg = div && v.paginas[div.dataset.n - 1];
    if (!pg?.vista) return null;
    const R = pg.div.getBoundingClientRect(), k = pg.vista.width / R.width;
    return { pg, x: (e.clientX - R.left) * k, y: (e.clientY - R.top) * k, k, R };
  }
  // Resaltado/subrayado/tachado que está bajo el puntero (no tienen elemento propio para no tapar el texto)
  marcaEn(e, v, p) {
    const q = this.puntoEn(e, v);
    if (!q) return null;
    return [...p.comentarios].reverse().find(c => c.n === q.pg.n && esMarca(c) && c.quads.some(quad => {
      const pts = quad.map(pt => enVista(q.pg.vista, pt)), xs = pts.map(a => a[0]), ys = pts.map(a => a[1]);
      return q.x >= Math.min(...xs) - 2 && q.x <= Math.max(...xs) + 2 && q.y >= Math.min(...ys) - 2 && q.y <= Math.max(...ys) + 2;
    })) || null;
  }
  pulsar(e, v, p) {
    const h = this.herramienta;
    if (!h || esMarca({ tipo: h }) || e.button !== 0 || e.target.closest('.com-barra, .com-popup, .barra-herramienta, .com-editor, .com-sugerencias')) return;
    const q = this.puntoEn(e, v);
    if (!q) return;
    e.preventDefault(); e.stopPropagation();
    this.guardarEdicion();
    const existente = h === 'rellenar' && this.buscar(e.target.closest('.com-texto')?.dataset.id);
    if (existente) { this.editando = { c: existente, nuevo: false }; return this.redibujar(p); }
    if (h === 'rellenar') return this.rellenar(q);
    if (h === 'nota') { this.herramienta = null; this.mostrarHerramienta(); return this.nuevaNota(q); }
    if (h === 'texto') { this.herramienta = null; this.mostrarHerramienta(); return this.nuevoTexto(q); }
    if (h === 'dibujo') return this.trazar(e, q, p);
    if (h === 'captura' || h === 'censurar' || h === 'leer') return this.capturar(e, q, h);
  }

  // ---------- Crear ----------
  // Rectángulos del texto pintado, agrupados por página y renglón
  seleccionEnPaginas() {
    const v = this.p?.visor, s = getSelection();
    if (!v || !s.rangeCount || s.isCollapsed) return [];
    const porPagina = new Map();
    for (let k = 0; k < s.rangeCount; k++) for (const r of s.getRangeAt(k).getClientRects()) {
      if (r.width < 1 || r.height < 2) continue;
      const pg = v.paginas.find(pg => { const R = pg.div.getBoundingClientRect(); return r.left < R.right && r.right > R.left && r.top + r.height / 2 > R.top && r.top + r.height / 2 < R.bottom; });
      if (!pg?.vista || r.height > pg.div.getBoundingClientRect().height * 0.25) continue;
      (porPagina.get(pg) || porPagina.set(pg, []).get(pg)).push(r);
    }
    const salida = [];
    for (const [pg, rects] of porPagina) {
      rects.sort((a, b) => a.top - b.top || a.left - b.left);
      const lineas = [];
      for (const r of rects) {
        const l = lineas.find(l => Math.min(l.bottom, r.bottom) - Math.max(l.top, r.top) > Math.min(l.bottom - l.top, r.height) * 0.5);
        if (l) { l.left = Math.min(l.left, r.left); l.right = Math.max(l.right, r.right); l.top = Math.min(l.top, r.top); l.bottom = Math.max(l.bottom, r.bottom); }
        else lineas.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
      }
      const R = pg.div.getBoundingClientRect(), k = pg.vista.width / R.width;
      const P = (x, y) => deVista(pg.vista, (x - R.left) * k, (y - R.top) * k);
      salida.push({ pg, quads: lineas.map(l => [P(l.left, l.top), P(l.right, l.top), P(l.left, l.bottom), P(l.right, l.bottom)]) });
    }
    return salida;
  }
  // Resalta, subraya o tacha el texto pintado. Devuelve el comentario creado (o null).
  marcarSeleccion(tipo, { conNota = false } = {}) {
    const p = this.p, partes = this.seleccionEnPaginas();
    if (!partes.length) return null;
    const texto = getSelection().toString().replace(/\s+/g, ' ').trim();
    const nuevas = partes.map(({ pg, quads }) => ({ id: crypto.randomUUID(), n: pg.n, tipo, color: this.color[tipo], quads, texto, nota: '' }));
    getSelection().removeAllRanges();
    this.ctx.cambiarComentarios(p, [...p.comentarios, ...nuevas]);
    if (conNota) this.seleccionar(nuevas[0].id, { nota: true });
    return nuevas[0];
  }
  nuevaNota(q) {
    const [x, y] = deVista(q.pg.vista, q.x, q.y);
    const c = { id: crypto.randomUUID(), n: q.pg.n, tipo: 'nota', color: this.color.nota, x, y, nota: '' };
    this.sel = c.id; this.notaAbierta = c.id;
    this.agregar(c);
  }
  nuevoTexto(q, texto = '') {
    this.guardarEdicion();
    const vista = q.pg.vista, ancho = Math.min(220 * vista.scale, vista.width - q.x - 4);
    const r = rectDeVista(vista, q.x, q.y, q.x + Math.max(40 * vista.scale, ancho), q.y + this.tam * LINEA * vista.scale + 4 * vista.scale);
    const giro = this.giroDe(q.pg);
    const c = { id: crypto.randomUUID(), n: q.pg.n, tipo: 'texto', color: this.color.texto, rect: rectDerecho(giro, r), ...(giro ? { giro } : {}), tam: this.tam, nota: texto, letra: this.letra };
    if (texto) { c.rect = ajustarAlto(c); this.sel = c.id; this.agregar(c, 'Texto pegado'); return; }
    this.editando = { c, nuevo: true };
    this.dibujarPagina(this.p, q.pg);
  }
  // Giro propio de la página (/Rotate), sin contar "Rotar vista"
  giroDe(pg) { return (((pg.vista.rotation || 0) - (this.p?.visor?.rotacion || 0)) % 360 + 360) % 360; }
  // Si se estaba escribiendo en un cuadro, lo guarda (antes de empezar otro)
  guardarEdicion() { const a = document.activeElement; if (a?.classList?.contains('com-editor')) a.blur(); }

  // ---------- Rellenar formularios sin casilleros ----------
  // Renglón del formulario donde se hizo clic: busca el texto impreso a la izquierda ("Domicilio:") para alinear con él
  filaEn(pg, x, y) {
    const R = pg.div.getBoundingClientRect(), k = pg.vista.width / R.width, fila = [];
    for (const s of pg.div.querySelectorAll('.textLayer span:not(.markedContent)')) {
      const r = s.getBoundingClientRect(), texto = s.textContent.trim();
      if (!r.height || !texto) continue;
      const top = (r.top - R.top) * k, h = r.height * k, base = top + h * 0.8;
      if (h > pg.vista.height * 0.06 || y < top - h * 0.25 || y > base + h * 0.7) continue;
      fila.push({ izq: (r.left - R.left) * k, der: (r.right - R.left) * k, base, h, texto });
    }
    if (!fila.length) return null;
    // la etiqueta es lo impreso que empieza a la izquierda del clic (muchas veces viene pegada a la línea: "Domicilio:_____")
    const antes = fila.filter(f => f.izq < x).sort((a, b) => b.izq - a.izq);
    const ref = antes[0] || fila.sort((a, b) => Math.abs(a.base - y) - Math.abs(b.base - y))[0];
    const etiqueta = antes.filter(f => Math.abs(f.base - ref.base) < ref.h * 0.5 && ref.izq - f.der < 200 * pg.vista.scale).reverse().map(f => f.texto).join(' ');
    return { base: ref.base, alto: ref.h, etiqueta };
  }
  rellenar(q, modo = this.relleno) {
    const { pg } = q, vista = pg.vista, fila = this.filaEn(pg, q.x, q.y);
    const tamFila = fila ? Math.round(fila.alto / vista.scale) : 0;
    const tam = tamFila >= 7 && tamFila <= 16 ? tamFila : this.tam > 14 ? 11 : this.tam;
    const color = this.color.rellenar;
    if (modo === 'tilde' || modo === 'cruz') {
      const s = Math.max(7, tam) * vista.scale;
      const forma = modo === 'tilde' ? [[[0.08, 0.55], [0.38, 0.88], [0.95, 0.1]]] : [[[0.12, 0.12], [0.88, 0.88]], [[0.88, 0.12], [0.12, 0.88]]];
      const trazos = forma.map(t => t.flatMap(([fx, fy]) => deVista(vista, q.x + (fx - 0.5) * s, q.y + (fy - 0.5) * s).map(v => Math.round(v * 100) / 100)));
      return this.agregar({ id: crypto.randomUUID(), n: pg.n, tipo: 'dibujo', color, grosor: Math.max(1, Math.round(tam * 0.13 * 10) / 10), trazos, nota: '' });
    }
    // El texto arranca donde se hizo clic y apoya sobre el mismo renglón que la etiqueta
    const base = fila ? fila.base : q.y - 2 * vista.scale, top = base - (2 + 0.92 * tam) * vista.scale, izq = q.x - 2 * vista.scale;
    const r = rectDeVista(vista, izq, top, Math.max(izq + 30 * vista.scale, vista.width - 8 * vista.scale), top + (tam * LINEA + 4) * vista.scale);
    const giro = this.giroDe(pg);
    const c = { id: crypto.randomUUID(), n: pg.n, tipo: 'texto', color, rect: rectDerecho(giro, r), ...(giro ? { giro } : {}), tam, nota: '', auto: true, letra: this.letra };
    if (modo === 'fecha') { c.nota = hoy(); c.rect = ajustarCaja(c); return this.agregar(c); }
    this.editando = { c, nuevo: true, etiqueta: normalEtiqueta(fila?.etiqueta) };
    this.dibujarPagina(this.p, pg);
  }
  // Memoria de lo que se escribe en cada renglón, para sugerirlo la próxima vez
  recordar(etiqueta, texto) {
    const m = this.ctx.memoria?.();
    if (!m || !texto || texto.length > 120 || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(texto)) return;
    m.valores ||= {}; m.etiquetas ||= {};
    m.valores[texto] = { n: (m.valores[texto]?.n || 0) + 1, f: Date.now() };
    const lista = Object.entries(m.valores);
    if (lista.length > 300) lista.sort((a, b) => a[1].f - b[1].f).slice(0, lista.length - 300).forEach(([t]) => delete m.valores[t]);
    if (etiqueta) m.etiquetas[etiqueta] = [texto, ...(m.etiquetas[etiqueta] || []).filter(t => t !== texto)].slice(0, 5);
    this.ctx.guardarMemoria(m);
  }
  sugerencias(etiqueta, escrito) {
    const m = this.ctx.memoria?.() || {}, q = normalEtiqueta(escrito);
    const propias = (etiqueta && m.etiquetas?.[etiqueta]) || [];
    const otras = Object.entries(m.valores || {}).sort((a, b) => b[1].n - a[1].n || b[1].f - a[1].f).map(([t]) => t);
    const coincide = t => !q || normalEtiqueta(t).startsWith(q) || normalEtiqueta(t).includes(' ' + q);
    return [...new Set([...propias.filter(coincide), ...(q ? otras.filter(coincide) : [])])].filter(t => t !== escrito).slice(0, 6);
  }
  // Dibujo a mano: cada trazo se suma al dibujo actual mientras la herramienta siga activa en la misma página
  trazar(e, q, p) {
    const { pg } = q, capa = pg.div.querySelector('.capa-com');
    if (!capa) return;
    const pts = [q.x, q.y], camino = svg('path', { class: 'com-trazo-vivo', stroke: this.color.dibujo, 'stroke-width': this.grosor * pg.vista.scale });
    capa.append(camino);
    const dibujar = () => camino.setAttribute('d', 'M' + pts.join(' '));
    dibujar();
    const R = pg.div.getBoundingClientRect(), k = pg.vista.width / R.width;
    const mover = ev => {
      const x = (ev.clientX - R.left) * k, y = (ev.clientY - R.top) * k;
      if (Math.hypot(x - pts[pts.length - 2], y - pts[pts.length - 1]) < 1.5) return;
      pts.push(x, y); dibujar();
    };
    const soltar = () => {
      removeEventListener('pointermove', mover); removeEventListener('pointerup', soltar);
      const trazo = [];
      for (let i = 0; i < pts.length; i += 2) trazo.push(...deVista(pg.vista, pts[i], pts[i + 1]).map(v => Math.round(v * 100) / 100));
      const actual = this.dibujoActual && p.comentarios.find(c => c.id === this.dibujoActual && c.n === pg.n);
      if (actual) this.cambiar(actual, { trazos: [...actual.trazos, trazo] });
      else {
        const c = { id: crypto.randomUUID(), n: pg.n, tipo: 'dibujo', color: this.color.dibujo, grosor: this.grosor, trazos: [trazo], nota: '' };
        this.dibujoActual = c.id; this.agregar(c);
      }
    };
    addEventListener('pointermove', mover); addEventListener('pointerup', soltar);
  }
  // Copiar área como imagen: recuadro sobre la página → imagen al portapapeles (con firmas y comentarios)
  capturar(e, q, h = 'captura') {
    const { pg } = q, marco = this.ctx.el('div', { class: 'captura-caja' });
    pg.div.append(marco);
    const ini = { x: q.x, y: q.y }, k = q.k;
    let fin = ini;
    const ubicar = () => Object.assign(marco.style, { left: Math.min(ini.x, fin.x) / k + 'px', top: Math.min(ini.y, fin.y) / k + 'px', width: Math.abs(fin.x - ini.x) / k + 'px', height: Math.abs(fin.y - ini.y) / k + 'px' });
    ubicar();
    const mover = ev => { fin = { x: limitar((ev.clientX - q.R.left) * k, 0, pg.vista.width), y: limitar((ev.clientY - q.R.top) * k, 0, pg.vista.height) }; ubicar(); };
    const soltar = async () => {
      removeEventListener('pointermove', mover); removeEventListener('pointerup', soltar);
      marco.remove(); this.herramienta = null; this.mostrarHerramienta();
      const x = Math.min(ini.x, fin.x), y = Math.min(ini.y, fin.y), w = Math.abs(fin.x - ini.x), alto = Math.abs(fin.y - ini.y);
      if (w < 4 || alto < 4) return this.ctx.aviso('Marcá un recuadro más grande.');
      if (h === 'censurar') return this.ctx.censurar(pg, { x, y, w, h: alto });
      if (h === 'leer') return this.ctx.leerArea(pg, { x, y, w, h: alto });
      await this.ctx.copiarImagenDe(pg, { x, y, w, h: alto });
    };
    addEventListener('pointermove', mover); addEventListener('pointerup', soltar);
  }

  // ---------- Dibujar sobre la página ----------
  redibujar(p) {
    if (this.sel && !p.comentarios.some(c => c.id === this.sel)) this.sel = null;
    p.visor?.paginas.forEach(pg => pg.dibujada && this.dibujarPagina(p, pg));
  }
  dibujarPagina(p, pg) {
    pg.div.querySelectorAll('.capa-marcas, .capa-com, .com, .com-barra, .com-popup, .com-editor, .com-sugerencias').forEach(x => x.remove());
    const vista = pg.vista;
    if (!vista) return;
    const caja = `0 0 ${vista.width} ${vista.height}`;
    const marcas = svg('svg', { class: 'capa-marcas', viewBox: caja, preserveAspectRatio: 'none' });
    const capa = svg('svg', { class: 'capa-com', viewBox: caja, preserveAspectRatio: 'none' });
    pg.div.append(marcas, capa);
    const propios = p.comentarios.filter(c => c.n === pg.n);
    for (const c of propios) {
      const sel = c.id === this.sel;
      if (esMarca(c)) {
        for (const q of c.quads) {
          const v = q.map(pt => enVista(vista, pt));
          if (c.tipo === 'resaltar') marcas.append(svg('polygon', { points: [v[0], v[1], v[3], v[2]].map(a => a.join(',')).join(' '), fill: c.color }));
          else { const [x1, y1, x2, y2, w] = lineaMarca(c.tipo, v); marcas.append(svg('line', { x1, y1, x2, y2, stroke: c.color, 'stroke-width': w })); }
        }
        if (c.nota && !sel) { const k = cajaEnVista(c, vista); capa.append(svg('circle', { class: 'com-tiene-nota', cx: k.x + k.w, cy: k.y, r: 4, fill: c.color })); }
      } else if (c.tipo === 'dibujo') {
        const d = c.trazos.map(t => 'M' + t.flatMap((_, i) => i % 2 ? [] : [enVista(vista, [t[i], t[i + 1]]).join(' ')]).join(' L')).join(' ');
        const g = svg('g', { class: 'com com-dibujo' + (sel ? ' sel' : ''), 'data-id': c.id });
        g.append(svg('path', { d, class: 'com-toque', 'stroke-width': Math.max(12, c.grosor * vista.scale + 8) }), svg('path', { d, stroke: c.color, 'stroke-width': c.grosor * vista.scale, class: 'com-trazo' }));
        capa.append(g);
        this.arrastrable(g, c);
      } else if (c.tipo === 'nota') {
        const [x, y] = enVista(vista, [c.x, c.y]), s = ICONO_NOTA * vista.scale;
        const e = this.ctx.el('div', { class: 'com com-nota' + (sel ? ' sel' : ''), 'data-id': c.id, title: c.nota || 'Nota (doble clic para escribir)', html: iconoNota,
          style: `left:${x / vista.width * 100}%;top:${y / vista.height * 100}%;width:${s / vista.width * 100}%;height:${s / vista.height * 100}%;color:${c.color}` });
        pg.div.append(e);
        this.arrastrable(e, c);
      } else if (c.tipo === 'texto' && this.editando?.c.id !== c.id) {
        pg.div.append(this.elementoTexto(c, vista, sel));
      }
      if (sel) {
        const k = cajaEnVista(c, vista);
        if (esMarca(c)) capa.append(svg('rect', { class: 'com-marco', x: k.x - 2, y: k.y - 2, width: k.w + 4, height: k.h + 4 }));
        pg.div.append(this.barra(c, k, vista));
        if (this.notaAbierta === c.id && c.tipo !== 'texto') pg.div.append(this.popup(c, k, vista));
      }
    }
    if (this.editando?.c.n === pg.n) pg.div.append(...this.editorTexto(this.editando.c, vista));
  }
  elementoTexto(c, vista, sel) {
    const { el } = this.ctx, k = cajaEnVista(c, vista);
    const lineas = lineasDe(c, medidorPantalla(c.tam, c.letra));
    const e = el('div', { class: 'com com-texto' + (sel ? ' sel' : ''), 'data-id': c.id, title: sel ? 'Doble clic para escribir' : '',
      style: `left:${k.x / vista.width * 100}%;top:${k.y / vista.height * 100}%;width:${k.w / vista.width * 100}%;height:${k.h / vista.height * 100}%;` +
        `color:${c.color};${c.tapar ? 'background:#fff;' : ''}font-size:${c.tam * vista.scale}px;padding:${2 * vista.scale}px;line-height:${LINEA};font-family:${cssLetra(c.letra)}` },
      ...lineas.map(l => el('div', {}, l || ' ')));
    if (sel) e.append(el('span', { class: 'asa se', 'data-ancho': '1', title: 'Cambiar el ancho' }));
    this.arrastrable(e, c);
    return e;
  }
  // Cuadro para escribir (texto nuevo o al editar uno existente)
  editorTexto(c, vista) {
    const { el } = this.ctx, k = cajaEnVista(c, vista), ed = this.editando;
    const ancho = c.auto ? Math.max(k.w, vista.width - k.x - 6 * vista.scale) : k.w;
    const area = el('textarea', { class: 'com-editor' + (c.auto ? ' auto' : ''), rows: 1, spellcheck: 'true', placeholder: c.auto ? 'Escribí' : 'Escribí acá',
      style: `left:${k.x / vista.width * 100}%;top:${k.y / vista.height * 100}%;width:${ancho / vista.width * 100}%;` +
        `color:${c.color};${c.tapar ? 'background:#fff;' : ''}font-size:${c.tam * vista.scale}px;padding:${2 * vista.scale}px;line-height:${LINEA};font-family:${cssLetra(c.letra)}` });
    area.value = c.nota;
    const crecer = () => { area.style.height = 'auto'; area.style.height = area.scrollHeight + 2 + 'px'; };
    let listo = false;
    const terminar = guardar => {
      if (listo) return; listo = true;
      const { nuevo } = this.editando || {}; this.editando = null;
      const texto = area.value.replace(/\s+$/, '');
      if (!guardar || (texto === c.nota && !nuevo)) return this.redibujar(this.p);
      if (!texto) return nuevo ? this.redibujar(this.p) : this.borrar(c.id);
      const nuevoC = { ...c, nota: texto }; nuevoC.rect = ajustarCaja(nuevoC);
      if (c.auto) this.recordar(ed?.etiqueta, texto); else this.sel = c.id;
      if (nuevo) this.agregar(nuevoC); else this.cambiar(c, { nota: texto, rect: nuevoC.rect });
    };
    // Sugerencias: lo que ya se escribió en este renglón otras veces, o lo que empieza igual
    const lista = el('div', { class: 'com-sugerencias', hidden: true });
    let opciones = [], marcada = -1;
    const elegir = t => { area.value = t; crecer(); area.focus(); area.blur(); };
    const mostrar = () => {
      opciones = c.auto ? this.sugerencias(ed?.etiqueta, area.value.trim()) : [];
      marcada = !area.value.trim() && opciones.length && ed?.etiqueta && this.sugerencias(ed.etiqueta, '').length ? 0 : -1;
      lista.hidden = !opciones.length;
      lista.style.left = area.style.left; lista.style.top = `calc(${area.style.top} + ${area.offsetHeight + 2}px)`;
      lista.replaceChildren(...opciones.map((t, i) => el('button', { class: 'com-sugerencia', 'aria-selected': String(i === marcada),
        onmousedown: e => e.preventDefault(), onclick: () => elegir(t) }, t)));
    };
    const mover = d => { if (!opciones.length) return; marcada = (marcada + d + opciones.length) % opciones.length; lista.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-selected', String(i === marcada))); };
    lista.addEventListener('pointerdown', e => e.stopPropagation());
    area.addEventListener('input', () => { crecer(); mostrar(); });
    area.addEventListener('blur', () => { lista.remove(); terminar(true); });
    area.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); terminar(!this.editando?.nuevo || !!area.value.trim()); }
      else if (e.key === 'ArrowDown' && !lista.hidden) { e.preventDefault(); mover(1); }
      else if (e.key === 'ArrowUp' && !lista.hidden) { e.preventDefault(); mover(-1); }
      else if (e.key === 'Tab' && !lista.hidden) { e.preventDefault(); elegir(opciones[Math.max(0, marcada)]); }
      else if (e.key === 'Enter' && !e.shiftKey && marcada >= 0 && !lista.hidden) { e.preventDefault(); elegir(opciones[marcada]); }
      else if (e.key === 'Enter' && (e.ctrlKey || (c.auto && !e.shiftKey))) { e.preventDefault(); area.blur(); }
    });
    area.addEventListener('pointerdown', e => e.stopPropagation());
    setTimeout(() => { crecer(); area.focus(); area.setSelectionRange(area.value.length, area.value.length); mostrar(); }, 0);
    return [area, lista];
  }
  // Barra flotante del comentario elegido: color, nota, letra y borrar
  barra(c, k, vista) {
    const { el, icono: ic } = this.ctx;
    const b = el('div', { class: 'com-barra', style: `left:${(k.x + k.w / 2) / vista.width * 100}%;top:${(k.y + k.h) / vista.height * 100}%` },
      this.paleta(c.color, color => { this.color[c.tipo] = color; this.cambiar(c, { color }); }));
    if (c.tipo === 'texto') b.append(
      this.elegirLetra(c.letra || 'sans', letra => this.cambiar(c, { letra, rect: ajustarCaja({ ...c, letra }) })),
      el('button', { class: 'btn-icono', title: 'Letra más chica', onclick: () => this.cambiarTam(c, -1) }, 'A−'),
      el('button', { class: 'btn-icono', title: 'Letra más grande', onclick: () => this.cambiarTam(c, 1) }, 'A+'),
      el('button', { class: 'btn-icono', title: 'Copiar la letra de un texto de la hoja (cuentagotas)', html: ic.cuentagotas, onclick: () => this.cuentagotas(c) }),
      el('button', { class: 'btn-icono', title: 'Escribir', html: ic.editar, onclick: () => { this.editando = { c, nuevo: false }; this.redibujar(this.p); } }));
    else b.append(el('button', { class: 'btn-icono', title: c.tipo === 'nota' ? 'Escribir la nota' : 'Agregar una nota', html: ic.nota, onclick: () => this.seleccionar(c.id, { nota: true }) }));
    b.append(el('button', { class: 'btn-icono peligro', title: 'Borrar (Supr)', html: ic.borrar, onclick: () => this.borrar(c.id) }));
    b.addEventListener('pointerdown', e => e.stopPropagation());
    return b;
  }
  // Desplegable de letras: básicas, "Mis fuentes" y las instaladas en Windows
  elegirLetra(actual, elegir) {
    const { el, fuentes } = this.ctx;
    const s = el('select', { class: 'campo com-letra', title: 'Letra' }, el('option', { value: actual }, actual.startsWith('f:') ? actual.slice(2) : 'Sans (Helvetica)'));
    for (const t of ['pointerdown', 'keydown', 'mousedown']) s.addEventListener(t, e => e.stopPropagation());
    fuentes?.cargar().then(() => {
      const op = (v, t) => el('option', { value: v, selected: v === actual }, t);
      const grupo = (t, lista) => lista.length ? el('optgroup', { label: t }, ...lista) : null;
      s.replaceChildren(...[grupo('Básicas', [op('sans', 'Sans (Helvetica)'), op('serif', 'Serif (Times)'), op('mono', 'Mono (Courier)')]),
        grupo('Mis fuentes', [...fuentes.biblioteca.values()].map(f => op('f:' + f.familia, f.familia))),
        grupo('Instaladas en Windows', [...fuentes.sistema.values()].sort((a, b) => a.familia.localeCompare(b.familia)).map(f => op('f:' + f.familia, f.familia)))].filter(Boolean));
      s.value = actual;
    }).catch(() => {});
    s.onchange = async () => { await fuentes?.css(s.value); elegir(s.value); };
    return s;
  }
  // Cuentagotas: el próximo clic en un texto de la hoja copia su letra, tamaño y color al cuadro de texto (Esc cancela)
  cuentagotas(c) {
    const p = this.p, { aviso } = this.ctx;
    document.body.classList.add('cuentagotas');
    aviso('Tocá un texto de la hoja para copiar su letra (Esc para cancelar).');
    const fin = () => { document.body.classList.remove('cuentagotas'); removeEventListener('pointerdown', tocar, true); removeEventListener('keydown', tecla, true); };
    const tecla = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fin(); aviso('Listo'); } };
    const tocar = async e => {
      const div = e.target.closest?.('.pagina');
      if (!div || e.button !== 0) return;
      e.preventDefault(); e.stopPropagation(); fin();
      const n = +div.dataset.n, pagina = p.visor.paginas[n - 1], v = pagina?.vista, R = div.getBoundingClientRect();
      if (!v) return;
      const punto = v.convertToPdfPoint((e.clientX - R.left) * v.width / R.width, (e.clientY - R.top) * v.height / R.height);
      try {
        const { lineas = [] } = await this.ctx.api.paginaContenido(p.datos, n);
        const linea = renglonEn(lineas, punto);
        if (!linea) return aviso('Ahí no hay texto para copiar la letra. Probá tocando justo sobre las letras.', true);
        const r = await letraDeRenglon(linea, { fuentes: this.ctx.fuentes, pagina });
        const actual = this.buscar(c.id) || c;
        await this.ctx.fuentes?.css(r.letra);
        this.cambiar(actual, { letra: r.letra, tam: r.tam, color: r.color, rect: ajustarCaja({ ...actual, letra: r.letra, tam: r.tam }) });
        // nunca a escondidas: si no es la misma letra del PDF, se dice cuál se eligió
        aviso(r.como === 'igual' ? `Letra copiada: ${r.nombre}, ${r.tam} pt${r.negrita ? ' (sin negrita: los cuadros de texto no la tienen)' : ''}.`
          : `La letra del PDF (${r.original || 'sin nombre'}) no está en esta compu. Elegí la más parecida por la forma: ${r.nombre}, ${r.tam} pt.`);
      } catch (err) { aviso('No se pudo copiar la letra: ' + (err?.message || err), true); }
    };
    setTimeout(() => { addEventListener('pointerdown', tocar, true); addEventListener('keydown', tecla, true); }, 0);
  }
  cambiarTam(c, d) {
    const tam = limitar(c.tam + d * (c.tam >= 14 ? 2 : 1), 6, 48);
    const nuevo = { ...c, tam }; if (!c.auto) this.tam = tam;
    this.cambiar(c, { tam, rect: ajustarCaja(nuevo) });
  }
  // Ventanita para escribir la nota de un comentario
  popup(c, k, vista) {
    const { el } = this.ctx;
    const area = el('textarea', { class: 'campo', rows: 5, placeholder: 'Escribí tu nota…' });
    area.value = c.nota || '';
    const guardar = () => { const t = area.value.trim(); if (t !== (c.nota || '')) this.cambiar(c, { nota: t }); };
    area.addEventListener('change', guardar);
    area.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') { area.blur(); this.deseleccionar(); } });
    const izquierda = (k.x + k.w) / vista.width > 0.6;
    const pop = el('div', { class: 'com-popup', style: `${izquierda ? 'right' : 'left'}:${(izquierda ? vista.width - k.x + 8 : k.x + k.w + 8) / vista.width * 100}%;top:${k.y / vista.height * 100}%` },
      el('div', { class: 'com-popup-titulo' }, el('b', {}, TIPOS[c.tipo]), c.texto ? el('span', { class: 'sutil' }, '“' + c.texto.slice(0, 60) + (c.texto.length > 60 ? '…' : '') + '”') : null), area);
    pop.addEventListener('pointerdown', e => e.stopPropagation());
    setTimeout(() => area.focus(), 0);
    return pop;
  }
  // Doble clic: escribir (cuadro de texto) o abrir la nota
  abrir(c) {
    if (c.tipo === 'texto') { this.editando = { c, nuevo: false }; this.redibujar(this.p); }
    else this.seleccionar(c.id, { nota: true });
  }
  // Seleccionar y mover arrastrando (notas, cuadros de texto y dibujos). El cuadro de texto también cambia de ancho.
  arrastrable(e, c) {
    e.addEventListener('pointerdown', ev => {
      if (ev.button !== 0 || this.herramienta) return;
      ev.preventDefault(); ev.stopPropagation();
      const ahora = Date.now(), doble = this.toque?.id === c.id && ahora - this.toque.t < 450;
      this.toque = { id: c.id, t: ahora };
      if (doble) return this.abrir(c);
      if (this.sel !== c.id) { this.seleccionar(c.id); const nuevo = document.querySelector(`.com[data-id="${c.id}"]`); if (!nuevo) return; e = nuevo; }
      const div = e.closest('.pagina'), vista = this.p.visor.paginas[div.dataset.n - 1].vista;
      const R = div.getBoundingClientRect(), k = vista.width / R.width, ini = { x: ev.clientX, y: ev.clientY };
      const ancho = ev.target.dataset?.ancho, base = cajaEnVista(c, vista);
      let dx = 0, dy = 0, movido = false;
      const mover = m => {
        dx = (m.clientX - ini.x) * k; dy = (m.clientY - ini.y) * k;
        if (!movido && Math.hypot(dx, dy) < 3) return;
        movido = true;
        if (ancho) e.style.width = Math.max(30, base.w + dx) / vista.width * 100 + '%';
        else e.style.transform = `translate(${dx / k}px, ${dy / k}px)`;
      };
      const soltar = () => {
        removeEventListener('pointermove', mover); removeEventListener('pointerup', soltar);
        if (!movido) return;
        if (ancho) {
          const r = rectDerecho(c.giro, rectDeVista(vista, base.x, base.y, base.x + Math.max(30, base.w + dx), base.y + base.h));
          const nuevo = { ...c, rect: r, auto: false }; return this.cambiar(c, { rect: ajustarAlto(nuevo), auto: false });
        }
        const [a, b] = deVista(vista, 0, 0), [x, y] = deVista(vista, dx, dy);
        this.ctx.cambiarComentarios(this.p, this.p.comentarios.map(x0 => x0.id === c.id ? trasladar(x0, x - a, y - b) : x0));
      };
      addEventListener('pointermove', mover); addEventListener('pointerup', soltar);
    });
  }
  // Teclas cuando hay un comentario elegido. Devuelve true si la usó.
  tecla(e) {
    if (e.key === 'Escape' && this.herramienta) { this.terminarHerramienta(); return true; }
    if (!this.sel || e.target.matches?.('input, textarea, select')) return false;
    if (e.key === 'Delete' || e.key === 'Backspace') { this.borrar(); return true; }
    if (e.key === 'Escape') { this.deseleccionar(); return true; }
    if (e.key === 'Enter' || e.key === 'F2') { const c = this.buscar(this.sel); if (c) this.abrir(c); return true; }
    const flecha = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    const c = this.buscar(this.sel);
    if (flecha && c && !esMarca(c)) {
      const vista = this.p.visor.paginas[c.n - 1]?.vista;
      if (!vista) return true;
      const d = (e.shiftKey ? 10 : 1) * vista.scale, [a, b] = deVista(vista, 0, 0), [x, y] = deVista(vista, flecha[0] * d, flecha[1] * d);
      this.ctx.cambiarComentarios(this.p, this.p.comentarios.map(x0 => x0.id === c.id ? trasladar(x0, x - a, y - b) : x0));
      return true;
    }
    return false;
  }
  // Copia de un comentario para pegar: en el punto dado (vista) o corrida un poco
  copiaPara(c, q) {
    if (esMarca(c)) return null;
    const nuevo = { ...structuredClone(c), id: crypto.randomUUID() };
    if (!q) return trasladar(nuevo, 12, -12);
    const [x0, y1] = esquinaPdf(c), [x, y] = deVista(q.pg.vista, q.x, q.y);
    return trasladar({ ...nuevo, n: q.pg.n }, x - x0, y - y1);
  }
}

// Esquina de arriba a la izquierda (en el PDF) de una nota, cuadro de texto o dibujo
function esquinaPdf(c) {
  if (c.tipo === 'nota') return [c.x, c.y];
  if (c.tipo === 'texto') return girarPunto(c.giro, [c.rect[0], c.rect[3]]);
  const xs = c.trazos.flatMap(t => t.filter((_, i) => !(i % 2))), ys = c.trazos.flatMap(t => t.filter((_, i) => i % 2));
  return [Math.min(...xs), Math.max(...ys)];
}
// Texto de "Rellenar": el cuadro mide lo que mide el texto (no corta renglones)
export function ajustarCaja(c) {
  if (!c.auto) return ajustarAlto(c);
  const medir = medidorPantalla(c.tam, c.letra), lineas = String(c.nota).split('\n');
  const w = Math.max(12, ...lineas.map(l => medir(l))) + 6;
  return [c.rect[0], c.rect[3] - altoTexto(c, lineas), c.rect[0] + w, c.rect[3]];
}
// El cuadro de texto mantiene arriba fijo y crece hacia abajo según los renglones
export function ajustarAlto(c) {
  const lineas = partirLineas(c.nota, c.rect[2] - c.rect[0] - 4, medidorPantalla(c.tam, c.letra));
  return [c.rect[0], c.rect[3] - altoTexto(c, lineas), c.rect[2], c.rect[3]];
}
