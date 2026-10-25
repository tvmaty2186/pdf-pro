// PDF.Pro — visor de un documento (una pestaña)
import * as pdfjs from '../node_modules/pdfjs-dist/build/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href;
const BASE = new URL('../node_modules/pdfjs-dist/', import.meta.url).href;
const MARGEN = 18, ESPACIO = 14;
const ZOOM_MIN = 0.1, ZOOM_MAX = 8;
export const PASOS_ZOOM = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8];

const normalizar = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// Texto de búsqueda de una página, armado igual que la capa de texto (un trozo por renglón no vacío, separados por espacio).
// mapa[k] = [trozo, desde, hasta]: de qué parte del texto original sale cada letra normalizada (-1 = separador).
function indexar(trozos) {
  let texto = ''; const mapa = [];
  trozos.forEach((t, j) => {
    if (j) { texto += ' '; mapa.push([-1, 0, 0]); }
    let i = 0;
    for (const c of t) {
      const n = normalizar(c).replace(/\s/g, ' ');
      for (let k = 0; k < n.length; k++) mapa.push([j, i, i + c.length]);
      texto += n; i += c.length;
    }
  });
  return { texto, mapa };
}

export class Visor {
  constructor({ datos, nombre, ruta, modo = 'continuo', pedirClave }) {
    this.nombre = nombre; this.ruta = ruta; this.modo = modo;
    this.datos = datos; this.pedirClave = pedirClave;
    this.zoom = 'ancho'; this.escala = 1; this.rotacion = 0;
    this.actual = 1; this.paginas = []; this.textos = []; this.trozos = [];
    this.busqueda = { texto: '', resultados: [], indice: -1 };
    this.alCambiar = () => {};
    this.alDibujar = () => {}; // para agregar capas propias (ej. firma que se está colocando)
    this.alMiniatura = async () => {}; // para dibujar encima de la miniatura (firmas editables)
    this.el = document.createElement('div');
    this.el.className = 'documento'; this.el.tabIndex = 0;
    this.lista = document.createElement('div');
    this.lista.className = 'paginas';
    this.el.append(this.lista);
  }

  async cargar() {
    const tarea = pdfjs.getDocument({
      data: this.datos.slice(), isEvalSupported: false, // copia: pdf.js se queda con los bytes que recibe
      cMapUrl: BASE + 'cmaps/', cMapPacked: true, standardFontDataUrl: BASE + 'standard_fonts/'
    });
    tarea.onPassword = async (responder, motivo) => {
      const clave = await this.pedirClave(motivo === pdfjs.PasswordResponses.INCORRECT_PASSWORD);
      if (clave == null) tarea.destroy(); else responder(clave);
    };
    this.doc = await tarea.promise;
    this.total = this.doc.numPages;
    const p1 = await this.doc.getPage(1);
    const v = p1.getViewport({ scale: 1 });
    this.base = { ancho: v.width, alto: v.height };
    for (let i = 1; i <= this.total; i++) {
      const div = document.createElement('div');
      div.className = 'pagina'; div.dataset.n = i;
      div.innerHTML = '<div class="cargando">' + i + '</div>';
      this.paginas.push({ n: i, div, tam: i === 1 ? { ancho: v.width, alto: v.height } : null, dibujada: 0, tarea: null });
      this.lista.append(div);
    }
    this.observador = new IntersectionObserver(ents => {
      for (const e of ents) if (e.isIntersecting) this.dibujar(this.paginas[e.target.dataset.n - 1]);
    }, { root: this.el, rootMargin: '600px 0px' });
    this.paginas.forEach(p => this.observador.observe(p.div));
    this.el.addEventListener('scroll', () => this.detectarActual(), { passive: true });
    this.el.addEventListener('wheel', e => this.ruedaZoom(e), { passive: false });
    this.redimension = new ResizeObserver(() => { if (typeof this.zoom === 'string') this.aplicarZoom(); });
    this.redimension.observe(this.el);
    this.aplicarModo();
    this.aplicarZoom();
  }

  // ---- Tamaños y zoom ----
  tamPagina(p) {
    const t = p.tam || this.base;
    return this.rotacion % 180 ? { ancho: t.alto, alto: t.ancho } : t;
  }
  calcularEscala() {
    if (typeof this.zoom === 'number') return this.zoom;
    const t = this.tamPagina(this.paginas[this.actual - 1] || this.paginas[0]);
    const columnas = this.modo === 'doble' && this.total > 1 ? 2 : 1;
    const anchoUtil = this.el.clientWidth - MARGEN * 2 - (columnas - 1) * ESPACIO - 2;
    const altoUtil = this.el.clientHeight - MARGEN * 2;
    const enAncho = anchoUtil / (t.ancho * columnas);
    const val = this.zoom === 'ancho' ? enAncho : Math.min(enAncho, altoUtil / t.alto);
    return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, val));
  }
  aplicarZoom(mantener = true) {
    const fraccion = mantener && this.el.scrollHeight ? this.el.scrollTop / this.el.scrollHeight : 0;
    const anterior = this.escala;
    this.escala = this.calcularEscala();
    for (const p of this.paginas) {
      const t = this.tamPagina(p);
      p.div.style.width = Math.floor(t.ancho * this.escala) + 'px';
      p.div.style.height = Math.floor(t.alto * this.escala) + 'px';
      p.div.style.setProperty('--scale-factor', this.escala);
    }
    if (this.modo === 'doble') {
      const t = this.tamPagina(this.paginas[0]);
      this.lista.style.setProperty('--ancho-doble', (Math.floor(t.ancho * this.escala) * 2 + ESPACIO + MARGEN * 2 + 4) + 'px');
    }
    if (Math.abs(anterior - this.escala) > 0.001 || !this.paginas.some(p => p.dibujada)) {
      this.paginas.forEach(p => { p.dibujada = 0; });
      if (mantener) this.el.scrollTop = fraccion * this.el.scrollHeight;
      this.redibujarVisibles();
    }
    this.alCambiar();
  }
  setZoom(z) { this.zoom = typeof z === 'number' ? Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z)) : z; this.aplicarZoom(); }
  acercar(dir) {
    const e = this.escala;
    const sig = dir > 0 ? PASOS_ZOOM.find(s => s > e + 0.001) : [...PASOS_ZOOM].reverse().find(s => s < e - 0.001);
    this.setZoom(sig ?? e);
  }
  ruedaZoom(e) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    this.setZoom(this.escala * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }

  // ---- Modos de vista y rotación ----
  setModo(m) { this.modo = m; this.aplicarModo(); this.aplicarZoom(false); this.irAPagina(this.actual); }
  aplicarModo() {
    this.lista.classList.toggle('doble', this.modo === 'doble');
    this.lista.classList.toggle('unica', this.modo === 'unica');
    this.marcarActual();
  }
  rotar() { this.rotacion = (this.rotacion + 90) % 360; this.paginas.forEach(p => { p.dibujada = 0; }); this.aplicarZoom(false); this.redibujarVisibles(); this.irAPagina(this.actual); }

  // ---- Dibujo de páginas ----
  redibujarVisibles() {
    const caja = this.el.getBoundingClientRect(), lejos = Math.max(2400, caja.height * 4);
    for (const p of this.paginas) {
      const r = p.div.getBoundingClientRect();
      if (r.bottom > caja.top - 600 && r.top < caja.bottom + 600 && r.width) this.dibujar(p);
      // las páginas que quedaron lejos se borran de la memoria (cada una ocupa varios MB); se vuelven a dibujar al volver
      else if (p.dibujada && (r.bottom < caja.top - lejos || r.top > caja.bottom + lejos)) this.liberar(p);
    }
  }
  liberar(p) {
    if (p.tarea) { try { p.tarea.cancel(); } catch {} p.tarea = null; }
    p.div.querySelectorAll('canvas').forEach(c => { c.width = 0; c.height = 0; });
    p.div.replaceChildren();
    p.dibujada = 0;
    this.doc?.getPage(p.n).then(pg => pg.cleanup()).catch(() => {});
  }
  async dibujar(p) {
    const clave = this.escala + '|' + this.rotacion;
    if (p.dibujada === clave || !this.doc) return;
    p.dibujada = clave;
    if (p.tarea) { try { p.tarea.cancel(); } catch {} }
    const pagina = await this.doc.getPage(p.n);
    if (!p.tam) {
      const v1 = pagina.getViewport({ scale: 1 });
      p.tam = { ancho: v1.width, alto: v1.height };
      const t = this.tamPagina(p);
      p.div.style.width = Math.floor(t.ancho * this.escala) + 'px';
      p.div.style.height = Math.floor(t.alto * this.escala) + 'px';
    }
    const vista = pagina.getViewport({ scale: this.escala, rotation: (pagina.rotate + this.rotacion) % 360 });
    // con mucho zoom se baja la resolución para no pasar de ~16 millones de puntos por página
    const dpr = Math.min(window.devicePixelRatio || 1, 3, Math.sqrt(16e6 / Math.max(1, vista.width * vista.height)));
    const lienzo = document.createElement('canvas');
    lienzo.width = Math.floor(vista.width * dpr); lienzo.height = Math.floor(vista.height * dpr);
    const tarea = pagina.render({ canvasContext: lienzo.getContext('2d', { alpha: false }), viewport: vista, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });
    p.tarea = tarea;
    try { await tarea.promise; } catch { return; }
    if (p.dibujada !== clave) return;
    p.div.replaceChildren(lienzo);
    p.vista = vista;
    const capa = document.createElement('div');
    capa.className = 'textLayer';
    p.div.append(capa);
    this.alDibujar(p);
    try {
      const tl = new pdfjs.TextLayer({ textContentSource: pagina.streamTextContent(), container: capa, viewport: vista });
      await tl.render();
      this.marcarCoincidencias(p.n);
    } catch {}
  }

  // ---- Navegación ----
  detectarActual() {
    if (this.modo === 'unica') return;
    const caja = this.el.getBoundingClientRect();
    const centro = caja.top + caja.height * 0.35;
    let mejor = this.actual;
    for (const p of this.paginas) {
      const r = p.div.getBoundingClientRect();
      if (r.top <= centro && r.bottom >= centro) { mejor = p.n; break; }
    }
    if (mejor !== this.actual) { this.actual = mejor; this.alCambiar(); }
  }
  marcarActual() {
    this.paginas.forEach(p => p.div.classList.toggle('actual', p.n === this.actual));
  }
  irAPagina(n, alinear = 'start') {
    n = Math.max(1, Math.min(this.total || 1, Math.round(n)));
    this.actual = n;
    this.marcarActual();
    const p = this.paginas[n - 1];
    if (!p) return;
    if (this.modo === 'unica') { this.el.scrollTop = 0; this.dibujar(p); }
    else p.div.scrollIntoView({ block: alinear, inline: 'nearest' });
    this.alCambiar();
  }
  siguiente() { this.irAPagina(this.actual + (this.modo === 'doble' ? 2 : 1)); }
  anterior() { this.irAPagina(this.actual - (this.modo === 'doble' ? 2 : 1)); }

  // ---- Texto ----
  async texto(n) {
    if (this.textos[n] == null) {
      const pg = await this.doc.getPage(n);
      const tc = await pg.getTextContent();
      this.textos[n] = tc.items.map(i => i.str + (i.hasEOL ? '\n' : ' ')).join('');
      this.trozos[n] = tc.items.map(i => i.str).filter(Boolean);
    }
    return this.textos[n];
  }
  async buscar(texto) {
    const q = normalizar(texto.trim()).replace(/\s+/g, ' ');
    this.busqueda = { texto: q, resultados: [], indice: -1 };
    if (!q) { this.paginas.forEach(p => this.marcarCoincidencias(p.n)); return this.busqueda; }
    for (let n = 1; n <= this.total; n++) {
      await this.texto(n);
      if (this.busqueda.texto !== q) return this.busqueda; // se cambió la búsqueda mientras tanto
      const t = indexar(this.trozos[n]).texto;
      let i = t.indexOf(q);
      while (i !== -1) { this.busqueda.resultados.push({ n, i }); i = t.indexOf(q, i + q.length); }
    }
    this.paginas.forEach(p => this.marcarCoincidencias(p.n));
    return this.busqueda;
  }
  moverBusqueda(dir) {
    const b = this.busqueda;
    if (!b.resultados.length) return b;
    if (b.indice === -1) {
      const desde = b.resultados.findIndex(r => r.n >= this.actual);
      b.indice = dir > 0 ? (desde === -1 ? 0 : desde) : (desde <= 0 ? b.resultados.length - 1 : desde - 1);
    } else b.indice = (b.indice + dir + b.resultados.length) % b.resultados.length;
    const r = b.resultados[b.indice];
    this.irAPagina(r.n);
    this.paginas.forEach(p => this.marcarCoincidencias(p.n));
    return b;
  }
  // Resalta solo las letras encontradas (no el renglón entero), aunque la palabra esté repartida en varios trozos
  marcarCoincidencias(n) {
    const capa = this.paginas[n - 1]?.div.querySelector('.textLayer');
    if (!capa) return;
    const spans = [...capa.querySelectorAll('span:not(.markedContent)')];
    for (const s of spans) if (s.firstElementChild) s.textContent = s.textContent; // saca las marcas anteriores
    const { texto: q, resultados, indice } = this.busqueda;
    const propios = q ? resultados.filter(r => r.n === n) : [];
    if (!propios.length) return;
    const { mapa } = indexar(spans.map(s => s.textContent));
    const actual = resultados[indice]?.n === n ? resultados[indice].i : -1;
    const porSpan = new Map(); // span → [[desde, hasta, esActual]]
    for (const r of propios) {
      for (let k = r.i; k < r.i + q.length && k < mapa.length; k++) {
        const [j, a, b] = mapa[k];
        if (j < 0) continue;
        const l = porSpan.get(j) || porSpan.set(j, []).get(j), ult = l[l.length - 1];
        if (ult && ult[2] === (r.i === actual) && ult[1] >= a) ult[1] = Math.max(ult[1], b);
        else l.push([a, b, r.i === actual]);
      }
    }
    let primera = null;
    for (const [j, rangos] of porSpan) {
      const s = spans[j], t = s.textContent, partes = [];
      let pos = 0;
      for (const [a, b, esActual] of rangos) {
        if (a > pos) partes.push(t.slice(pos, a));
        const m = document.createElement('mark');
        m.className = 'coincide' + (esActual ? ' actual' : ''); m.textContent = t.slice(a, b);
        if (esActual && !primera) primera = m;
        partes.push(m); pos = b;
      }
      if (pos < t.length) partes.push(t.slice(pos));
      s.replaceChildren(...partes);
    }
    primera?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }

  // ---- Marcadores e índice ----
  async marcadores() {
    const lista = await this.doc.getOutline();
    if (!lista) return [];
    const resolver = async items => Promise.all(items.map(async it => {
      let n = null;
      try {
        const dest = typeof it.dest === 'string' ? await this.doc.getDestination(it.dest) : it.dest;
        if (dest) n = (await this.doc.getPageIndex(dest[0])) + 1;
      } catch {}
      return { titulo: it.title, n, hijos: it.items?.length ? await resolver(it.items) : [] };
    }));
    return resolver(lista);
  }
  async miniatura(n, ancho) {
    const pg = await this.doc.getPage(n);
    const v1 = pg.getViewport({ scale: 1, rotation: (pg.rotate + this.rotacion) % 360 });
    const v = pg.getViewport({ scale: (ancho * 2) / v1.width, rotation: (pg.rotate + this.rotacion) % 360 });
    const c = document.createElement('canvas');
    c.width = Math.floor(v.width); c.height = Math.floor(v.height);
    const g = c.getContext('2d', { alpha: false });
    await pg.render({ canvasContext: g, viewport: v }).promise;
    await this.alMiniatura(n, g, v);
    return c;
  }
  proporcion(n) { const t = this.tamPagina(this.paginas[n - 1]); return t.alto / t.ancho; }

  destruir() {
    this.observador?.disconnect(); this.redimension?.disconnect();
    this.doc?.destroy(); this.el.remove();
  }
}
