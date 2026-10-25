// PDF.Pro — vista "Organizar páginas": mover, rotar, eliminar, insertar, extraer, unir y separar
import * as ops from './paginas.js';
import { icono } from './iconos.js';

const ANCHO = 150;

export class Organizador {
  // ctx: { pestana(), aplicar(fn, opciones), aviso(texto, error, accion), dialogo(opciones), api, el(), cerrar() }
  constructor(ctx) {
    this.ctx = ctx;
    this.sel = new Set();
    this.ultimo = null;
    const el = ctx.el;
    this.raiz = el('div', { class: 'organizar', tabindex: '0' });
    const b = (ic, txt, titulo, f) => el('button', { class: 'btn-texto', title: titulo, html: ic + `<span>${txt}</span>`, onclick: f });
    this.btn = {
      izq: b(icono.rotarIzq, 'Girar a la izquierda', 'Girar a la izquierda', () => this.rotar(-90)),
      der: b(icono.rotar, 'Girar a la derecha', 'Girar a la derecha', () => this.rotar(90)),
      eliminar: b(icono.eliminar, 'Eliminar', 'Eliminar páginas elegidas (Supr)', () => this.eliminar()),
      extraer: b(icono.extraer, 'Extraer', 'Guardar las páginas elegidas en un PDF nuevo', () => this.extraer())
    };
    this.barra = el('div', { class: 'organizar-barra' },
      b(icono.volver, 'Volver al documento', 'Volver (Esc)', () => ctx.cerrar()),
      el('span', { class: 'separador' }),
      this.btn.izq, this.btn.der, this.btn.eliminar, this.btn.extraer,
      el('span', { class: 'separador' }),
      b(icono.insertar, 'Insertar PDF', 'Insertar páginas de otro PDF después de la elegida', () => this.insertarArchivo()),
      b(icono.documento, 'Página en blanco', 'Insertar una página en blanco después de la elegida', () => this.insertarBlanco()),
      b(icono.unir, 'Unir', 'Agregar otros PDF al final', () => this.unir()),
      b(icono.separar, 'Separar', 'Dividir este documento en varios PDF', () => this.separar()),
      b(icono.ia, 'Al asistente', 'Mandar las páginas elegidas al chat del asistente (para que aprenda o las mire)', () => { const e = this.elegidas(); if (!e.length) return ctx.aviso('Elegí primero las páginas (clic, o Ctrl+clic para varias).'); ctx.alAsistente(e); }),
      el('span', { class: 'espacio' }),
      b(icono.todo, 'Elegir todas', 'Elegir todas (Ctrl+A)', () => this.elegirTodas()));
    this.ayuda = el('div', { class: 'organizar-ayuda' });
    this.grilla = el('div', { class: 'organizar-grilla', role: 'listbox', 'aria-multiselectable': 'true' });
    this.raiz.append(this.barra, this.ayuda, this.grilla);
    this.raiz.addEventListener('keydown', e => this.teclas(e));
    this.grilla.addEventListener('mousedown', e => { if (e.target === this.grilla) { this.sel.clear(); this.marcar(); } });
  }

  get p() { return this.ctx.pestana(); }
  get total() { return this.p.visor.total; }
  elegidas() { return [...this.sel].sort((a, b) => a - b); }

  // ---- Dibujo ----
  dibujar() {
    const v = this.p.visor, el = this.ctx.el;
    this.observador?.disconnect();
    this.observador = new IntersectionObserver(ents => {
      for (const e of ents) if (e.isIntersecting && !e.target.dataset.lista) {
        e.target.dataset.lista = '1';
        v.miniatura(+e.target.dataset.n, ANCHO).then(c => { e.target.style.height = Math.round(e.target.offsetWidth * c.height / c.width) + 'px'; e.target.replaceChildren(c); }).catch(() => {});
      }
    }, { root: this.grilla, rootMargin: '300px 0px' });
    const fichas = [];
    for (let n = 1; n <= v.total; n++) {
      const marco = el('div', { class: 'marco', 'data-n': n, style: `width:${ANCHO}px;height:${Math.round(ANCHO * v.proporcion(n))}px` });
      const ficha = el('div', { class: 'ficha', role: 'option', draggable: 'true', 'data-i': n - 1, title: 'Página ' + n },
        el('div', { class: 'ficha-acciones' },
          el('button', { class: 'btn-icono', title: 'Rotar a la derecha', html: icono.rotar, onclick: e => { e.stopPropagation(); this.rotar(90, [n - 1]); } }),
          el('button', { class: 'btn-icono', title: 'Eliminar', html: icono.eliminar, onclick: e => { e.stopPropagation(); this.eliminar([n - 1]); } })),
        marco, el('span', { class: 'num' }, n));
      ficha.addEventListener('mousedown', e => this.clic(e, n - 1));
      ficha.addEventListener('dblclick', () => { this.ctx.cerrar(); v.irAPagina(n); });
      ficha.addEventListener('dragstart', e => this.arrastreInicio(e, n - 1));
      ficha.addEventListener('dragover', e => this.arrastreSobre(e, ficha));
      ficha.addEventListener('drop', e => this.soltar(e, ficha));
      ficha.addEventListener('dragend', () => this.limpiarMarcas());
      fichas.push(ficha);
      this.observador.observe(marco);
    }
    this.grilla.replaceChildren(...fichas);
    for (const i of [...this.sel]) if (i >= v.total) this.sel.delete(i);
    this.marcar();
  }
  marcar() {
    this.grilla.querySelectorAll('.ficha').forEach(f => f.setAttribute('aria-selected', this.sel.has(+f.dataset.i)));
    const n = this.sel.size;
    this.ayuda.textContent = n
      ? `${n} ${n === 1 ? 'página elegida' : 'páginas elegidas'} de ${this.total}. Arrastrá para moverlas.`
      : `${this.total} páginas. Hacé clic para elegir, Ctrl+clic para varias, Mayús+clic para un rango. Arrastrá para cambiar el orden. Doble clic para verla.`;
    for (const k of ['izq', 'der', 'eliminar', 'extraer']) this.btn[k].disabled = !n;
  }
  clic(e, i) {
    if (e.button !== 0 || e.target.closest('button')) return;
    if (e.shiftKey && this.ultimo != null) {
      const [a, b] = [Math.min(this.ultimo, i), Math.max(this.ultimo, i)];
      if (!e.ctrlKey) this.sel.clear();
      for (let k = a; k <= b; k++) this.sel.add(k);
    } else if (e.ctrlKey) {
      this.sel.has(i) ? this.sel.delete(i) : this.sel.add(i);
      this.ultimo = i;
    } else {
      if (!this.sel.has(i)) { this.sel.clear(); this.sel.add(i); }
      this.ultimo = i;
    }
    this.marcar();
  }
  elegirTodas() { for (let i = 0; i < this.total; i++) this.sel.add(i); this.marcar(); }

  // ---- Arrastrar para mover ----
  arrastreInicio(e, i) {
    if (!this.sel.has(i)) { this.sel.clear(); this.sel.add(i); this.marcar(); }
    this.moviendo = this.elegidas();
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', 'paginas');
  }
  posicionSoltar(e, ficha) {
    const r = ficha.getBoundingClientRect();
    return +ficha.dataset.i + (e.clientX > r.left + r.width / 2 ? 1 : 0);
  }
  arrastreSobre(e, ficha) {
    if (!this.moviendo) return;
    e.preventDefault(); e.stopPropagation();
    this.limpiarMarcas();
    ficha.classList.add(e.clientX > ficha.getBoundingClientRect().left + ficha.offsetWidth / 2 ? 'soltar-der' : 'soltar-izq');
  }
  limpiarMarcas() { this.grilla.querySelectorAll('.soltar-izq, .soltar-der').forEach(f => f.classList.remove('soltar-izq', 'soltar-der')); }
  async soltar(e, ficha) {
    if (!this.moviendo) return;
    e.preventDefault(); e.stopPropagation();
    this.limpiarMarcas();
    const mover = this.moviendo; this.moviendo = null;
    const destino = this.posicionSoltar(e, ficha);
    const resto = [...Array(this.total).keys()].filter(i => !mover.includes(i));
    const insertarEn = destino - mover.filter(i => i < destino).length;
    const orden = [...resto.slice(0, insertarEn), ...mover, ...resto.slice(insertarEn)];
    if (orden.every((v, k) => v === k)) return;
    const ok = await this.ctx.aplicar(b => ops.reordenar(b, orden), { mensaje: mover.length === 1 ? 'Página movida' : `${mover.length} páginas movidas` });
    if (ok) { this.sel = new Set(mover.map((_, k) => insertarEn + k)); this.marcar(); }
  }

  // ---- Acciones ----
  async rotar(grados, indices = this.elegidas()) {
    if (!indices.length) return;
    await this.ctx.aplicar(b => ops.rotar(b, indices, grados), { mensaje: indices.length === 1 ? 'Página rotada' : `${indices.length} páginas rotadas` });
  }
  async eliminar(indices = this.elegidas()) {
    if (!indices.length) return;
    if (indices.length >= this.total) return this.ctx.aviso('No se pueden eliminar todas las páginas.', true);
    const ok = await this.ctx.aplicar(b => ops.eliminar(b, indices), { mensaje: indices.length === 1 ? 'Página eliminada (Ctrl+Z para deshacer)' : `${indices.length} páginas eliminadas (Ctrl+Z para deshacer)` });
    if (ok) { this.sel.clear(); this.marcar(); }
  }
  despuesDe() { const s = this.elegidas(); return s.length ? s[s.length - 1] : this.total - 1; }
  async insertarArchivo() {
    const rutas = await this.ctx.api.elegirPdf();
    if (!rutas.length) return;
    const otros = await Promise.all(rutas.map(r => this.ctx.api.leerBytes(r)));
    const pos = this.despuesDe();
    await this.ctx.aplicar(b => ops.insertarDesde(b, otros, pos), { mensaje: 'Páginas insertadas' });
  }
  async insertarBlanco() {
    const pos = this.despuesDe();
    const ok = await this.ctx.aplicar(b => ops.insertarBlanco(b, pos), { mensaje: 'Página en blanco insertada' });
    if (ok) { this.sel = new Set([pos + 1]); this.marcar(); }
  }
  async unir() {
    const rutas = await this.ctx.api.elegirPdf();
    if (!rutas.length) return;
    const otros = await Promise.all(rutas.map(r => this.ctx.api.leerBytes(r)));
    const antes = this.total;
    const ok = await this.ctx.aplicar(b => ops.insertarDesde(b, otros, antes - 1), { mensaje: 'Documentos unidos al final. Podés moverlos arrastrando.' });
    if (ok) { this.sel = new Set([...Array(this.total - antes).keys()].map(k => antes + k)); this.marcar(); this.grilla.lastElementChild?.scrollIntoView({ block: 'nearest' }); }
  }
  async extraer(indices = this.elegidas()) {
    if (!indices.length) return;
    await extraerPaginas(this.ctx, this.p, indices);
  }
  separar() { return separarDocumento(this.ctx, this.p); }

  teclas(e) {
    if (e.target.matches('input')) return;
    if (e.key === 'Delete') { e.preventDefault(); this.eliminar(); }
    else if (e.ctrlKey && e.key.toLowerCase() === 'a') { e.preventDefault(); e.stopPropagation(); this.elegirTodas(); }
    else if (e.key === 'Escape') { e.stopPropagation(); this.ctx.cerrar(); }
  }
  destruir() { this.observador?.disconnect(); this.raiz.remove(); }
}

// Texto de rango legible: [0,1,2,4] → "1-3, 5"
export function textoRango(indices) {
  const s = [...indices].sort((a, b) => a - b).map(i => i + 1), partes = [];
  for (let k = 0; k < s.length; k++) {
    let j = k;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    partes.push(j > k ? `${s[k]}-${s[j]}` : `${s[k]}`);
    k = j;
  }
  return partes.join(', ');
}

const base = nombre => nombre.replace(/\.pdf$/i, '');

export async function extraerPaginas(ctx, p, indices) {
  try {
    const bytes = await ops.extraer(await ctx.completo(p), indices);
    const destino = await ctx.api.elegirDestino(`${base(p.nombre)} (páginas ${textoRango(indices).replace(/, /g, ',')}).pdf`, p.carpeta);
    if (!destino) return;
    await ctx.api.guardarArchivo(destino, bytes);
    ctx.aviso(`Se guardaron ${indices.length} ${indices.length === 1 ? 'página' : 'páginas'} en un PDF nuevo.`, false, { t: 'Abrir', f: () => ctx.abrir([destino]) });
  } catch (e) { ctx.error(e); }
}

export async function separarDocumento(ctx, p) {
  const total = p.visor.total, el = ctx.el;
  if (total < 2) return ctx.aviso('El documento tiene una sola página: no hay nada para separar.', true);
  const cada = el('input', { class: 'campo', type: 'number', min: '1', max: String(total), value: '1', style: 'width:64px' });
  const rangos = el('input', { class: 'campo', type: 'text', placeholder: 'Ej.: 1-3, 4-6, 7', style: 'width:100%;text-align:left' });
  const op = (valor, contenido, marcada) => el('label', { class: 'opcion' }, el('input', { type: 'radio', name: 'modo-separar', value: valor, checked: marcada }), contenido);
  const r = await ctx.dialogo({
    titulo: 'Separar documento',
    texto: `El documento tiene ${total} páginas. ¿Cómo lo querés dividir?`,
    contenido: el('div', { class: 'opciones' },
      op('cada', el('span', {}, 'Un archivo cada ', cada, ' páginas'), true),
      op('rangos', el('span', { style: 'flex:1' }, 'Por rangos, un archivo por rango:', rangos))),
    botones: [{ t: 'Cancelar', v: null }, { t: 'Elegir carpeta y separar', v: 'ok', primario: true }],
    validar: raiz => {
      const modo = raiz.querySelector('input[name="modo-separar"]:checked').value;
      if (modo === 'cada') {
        const n = Math.floor(+cada.value);
        if (!(n >= 1)) return 'Escribí cuántas páginas va a tener cada archivo.';
        if (n >= total) return `Con ${n} páginas por archivo queda un solo archivo. Probá con un número menor a ${total}.`;
        return null;
      }
      try { ops.leerRangos(rangos.value, total); return null; } catch (e) { return e.message; }
    }
  });
  if (r?.boton !== 'ok') return;
  const modo = r.raiz.querySelector('input[name="modo-separar"]:checked').value;
  let grupos;
  if (modo === 'cada') {
    const n = Math.floor(+cada.value); grupos = [];
    for (let i = 0; i < total; i += n) grupos.push([...Array(Math.min(n, total - i)).keys()].map(k => i + k));
  } else grupos = ops.leerRangos(rangos.value, total);
  const carpeta = await ctx.api.elegirCarpeta(p.carpeta);
  if (!carpeta) return;
  try {
    const archivos = await ops.separar(await ctx.completo(p), grupos);
    for (let k = 0; k < archivos.length; k++) {
      const ruta = await ctx.api.rutaLibre(carpeta, `${base(p.nombre)} - parte ${k + 1} (pág. ${textoRango(grupos[k]).replace(/, /g, ',')}).pdf`);
      await ctx.api.guardarArchivo(ruta, archivos[k]);
    }
    ctx.aviso(`Listo: se crearon ${archivos.length} archivos.`, false, { t: 'Abrir carpeta', f: () => ctx.api.abrirCarpeta(carpeta) });
  } catch (e) { ctx.error(e); }
}
