// PDF.Pro — modo documento: la hoja se edita como un Word.
// Al entrar a Editar, cada página se arma así: abajo, la hoja dibujada SIN el texto editable (quedan imágenes, líneas,
// tablas y el texto que no se edita); arriba, cada párrafo como un bloque de texto editable, con su letra, tamaño,
// color, negritas, alineación e interlineado. Se escribe de corrido: flechas, selección, Ctrl+N / Ctrl+K, copiar y
// pegar, Enter. No hay botón Aplicar: cuando el cursor sale de un párrafo, ese párrafo se escribe en el PDF (solo lo que
// cambió, con la letra original del documento si la trae) y se controla el resultado. Si un párrafo crece, empuja hacia
// abajo los que siguen en la misma columna mientras haya lugar.
import * as ops from './paginas.js';
import { CSS_BASICA, normalizar } from './fuentes.js';
import { Lugar } from './lugar.js';

const familiaDe = (nombre = '', serif) => /courier|mono|consol/i.test(nombre) ? 'mono'
  : /times|georgia|garamond|cambria|palatino|bookman|serif/i.test(nombre) && !/sans/i.test(nombre) ? 'serif'
  : serif ? 'serif' : 'sans';
const sinPrefijo = n => String(n || '').replace(/^[A-Z]{6}\+/, '');
const baseFamilia = n => sinPrefijo(n).replace(/[-,](bold|italic|oblique|semibold|black|regular|roman|book|medium|light|bd|it|bi)+.*$/i, '').replace(/(PSMT|MT|PS)$/, '').toLowerCase();
const aHex = c => '#' + c.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
const deCss = c => { const m = String(c).match(/[\d.]+/g); return m ? m.slice(0, 3).map(v => +v / 255) : [0, 0, 0]; };
const mismoColor = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 0.03);

export class ModoWord {
  // colores(pg, rect): papel y tinta de esa zona de la página dibujada (para escaneos)
  constructor(edicion, colores) { this.ed = edicion; this.colores = colores; this.hojas = new Map(); this.cola = Promise.resolve(); this.ultimo = null; this.orig = new Map(); }
  get ctx() { return this.ed.ctx; }
  get fuentes() { return this.ed.fuentes; }
  clave(p, n) { return p.id + '|' + n; }

  // ---------- Armar una página ----------
  // (si se pide dos veces seguidas mientras se arma, se espera la primera: nunca dos hojas para la misma página)
  // lugar: traductor de la hoja (src/lugar.js); los párrafos vienen en "hoja derecha"
  armar(p, pg, cont, pars, lugar = new Lugar()) {
    const k = this.clave(p, pg.n);
    this.armando ||= new Map();
    if (this.armando.has(k)) return this.armando.get(k).then(r => { const h = this.hojas.get(k); if (h) { if (!pg.div.contains(h.el)) pg.div.append(h.el); h.pg = pg; this.escalar(h); } return r; });
    const t = this.armar2(p, pg, cont, pars, lugar).finally(() => this.armando.delete(k));
    this.armando.set(k, t);
    return t;
  }
  async armar2(p, pg, cont, pars, lugar) {
    const k = this.clave(p, pg.n), ya = this.hojas.get(k);
    if (ya) { // la página se volvió a dibujar (zoom, scroll): se vuelve a poner lo mismo, sin perder lo escrito
      if (!pg.div.contains(ya.el)) pg.div.append(ya.el);
      if (ya.pg.div !== pg.div) { ya.ro?.disconnect(); ya.ro?.observe(pg.div); }
      ya.pg = pg; this.escalar(ya); return true;
    }
    const editables = pars.filter(x => x.reflow);
    if (!editables.length || p.visor?.rotacion) return false; // con la vista girada (Ver → Girar) se edita de a renglón
    const { el } = this.ctx;
    const hoja = { p, n: pg.n, pg, lugar, bloques: [], cont, pars, fuentesPagina: new Map(), datosFondo: p.datos, cargando: [], escaneo: !!cont.ocr };
    for (const x of pars) for (const l of x.lineas) for (const w of l.palabras) if (w.f && !hoja.fuentesPagina.has(w.f)) hoja.fuentesPagina.set(w.f, { b: w.b, i: w.i });
    hoja.el = el('div', { class: 'ed-hoja' });
    hoja.fondo = el('img', { class: 'ed-fondo', alt: '' });
    hoja.raiz = el('div', { class: 'ed-texto', contenteditable: 'true', spellcheck: 'true' });
    hoja.el.append(hoja.fondo, hoja.raiz);
    // fondo: la hoja sin el texto de los párrafos editables (tiras dentro de cada renglón, como al borrar)
    // en un escaneo las letras son parte de la imagen: el fondo es la página tal cual (el texto reconocido es invisible)
    hoja.zonas = hoja.escaneo ? [] : editables.flatMap(x => x.lineas.map(l => this.tira(l.rect[0], l.rect[2], l)));
    for (const par of editables) hoja.bloques.push(await this.bloque(hoja, par));
    this.pie(hoja);
    hoja.limite = el('div', { class: 'ed-limite' }, el('span', {}, 'Lo que pase de esta línea sigue en la hoja de abajo'));
    hoja.el.append(hoja.limite);
    this.eventos(hoja);
    this.hojas.set(k, hoja);
    pg.div.append(hoja.el);
    // el texto sigue al zoom en el mismo instante que la hoja (no espera a que se vuelva a dibujar)
    hoja.anchoPt = pg.vista.width / pg.vista.scale;
    hoja.ro = new ResizeObserver(() => { const w = hoja.pg.div.clientWidth; if (w) hoja.el.style.setProperty('--k', w / hoja.anchoPt); });
    hoja.ro.observe(pg.div);
    this.escalar(hoja);
    // los renglones de cada bloque se cuentan con la letra ya puesta (con la provisoria pueden dar otro número)
    Promise.all(hoja.cargando).then(() => document.fonts.ready).then(() => requestAnimationFrame(() => this.medirBase(hoja)));
    return true;
  }
  // Fin de la hoja, como el margen de abajo de Word: lo que lo pase va a una hoja nueva. Los pies de página (renglones
  // sueltos muy abajo y lejos del texto) no se corren.
  pie(hoja) {
    const piso = 0, alto = hoja.lugar.alto, B = hoja.bloques;
    for (const b of B) {
      const r = b.par.rect, arriba = B.filter(o => o !== b && o.par.rect[1] > r[3]).map(o => o.par.rect[1] - r[3]);
      if (r[3] < piso + alto * 0.12 && b.par.lineas.length <= 2 && (!arriba.length || Math.min(...arriba) > b.par.interlineado * 2)) b.fijo = true;
      // encabezado: renglón suelto muy arriba, lejos del texto y con letra no más grande que la de abajo (un título no lo es)
      const abajo = B.filter(o => o !== b && o.par.rect[3] < r[1]);
      if (r[1] > piso + alto * 0.88 && b.par.lineas.length <= 2 && abajo.length && Math.min(...abajo.map(o => r[1] - o.par.rect[3])) > b.par.interlineado * 2
        && (b.par.fuente?.size || 11) <= Math.min(...abajo.map(o => o.par.fuente?.size || 11))) b.fijo = 'arriba';
    }
    const cuerpo = B.filter(b => !b.fijo), fijos = B.filter(b => b.fijo);
    if (!cuerpo.length) return;
    const margen = Math.min(90, Math.max(36, Math.min(...cuerpo.map(b => b.par.limites[0]))));
    const masBajo = Math.min(...cuerpo.map(b => b.par.lineas.at(-1).base[1]));
    hoja.abajo = Math.min(piso + margen, masBajo - 0.5);
    const pies = fijos.filter(b => b.fijo === true);
    if (pies.length) hoja.abajo = Math.max(hoja.abajo, Math.max(...pies.map(b => b.par.rect[3])) + 12);
    hoja.arriba = Math.max(...cuerpo.map(b => b.par.lineas[0].base[1])); // dónde empieza el texto (para la hoja nueva)
  }
  tira(x0, x1, l) { const h = l.rect[3] - l.rect[1]; return [x0 + 0.3, l.rect[1] + h * 0.35, x1 - 0.3, l.rect[3] - h * 0.35]; }
  async escalar(hoja) {
    const v = hoja.pg.vista;
    if (!v) return;
    hoja.el.style.setProperty('--k', (hoja.pg.div.clientWidth && hoja.anchoPt) ? hoja.pg.div.clientWidth / hoja.anchoPt : v.scale);
    for (const b of hoja.bloques) this.ubicar(hoja, b);
    if (hoja.abajo != null) hoja.limite.style.top = hoja.lugar.enVista(v, 0, hoja.abajo)[1] / v.height * 100 + '%';
    const esc = Math.min(3, v.scale * (window.devicePixelRatio || 1));
    if (hoja.escalaFondo === esc && hoja.fondo.src) return;
    hoja.escalaFondo = esc;
    try {
      const png = await this.ctx.api.paginaFondo(hoja.datosFondo, hoja.n, hoja.zonas.map(r => hoja.lugar.rectAPdf(r)), esc); // siempre de la hoja como estaba al entrar
      if (hoja.fondo.src) URL.revokeObjectURL(hoja.fondo.src);
      hoja.fondo.src = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
    } catch (e) { console.error('Fondo', e); }
  }
  // Un párrafo como bloque editable: palabras agrupadas en tramos del mismo estilo
  async bloque(hoja, par) {
    const { el } = this.ctx, f = par.fuente || {};
    const b = { id: par.id, par: structuredClone(par), dy: 0, sucio: false, ampliado: !!par.ampliable }; // angosto: ancho hasta el margen desde el principio
    if (hoja.escaneo) { // papel y tinta de verdad (lo reconocido no trae color ni letra)
      const col = this.colores(hoja.pg, hoja.lugar.rectAPdf(par.rect));
      b.fondo = col.fondo; b.tinta = col.tinta.map(x => x * 0.8); // en un escaneo la letra se ve más gruesa: un poco más oscura se parece más
      for (const l of b.par.lineas) for (const w of l.palabras) { w.f = null; w.color = col.tinta; }
      par = b.par;
    }
    // el bloque lleva la letra y el tamaño del párrafo: lo que se le una (o se escriba fuera de un tramo) los toma
    b.el = el('div', { class: 'ed-bloque' + (hoja.escaneo ? ' escaneo' : ''), 'data-id': par.id, 'data-f': hoja.escaneo ? '' : f.name || '', 'data-tam': Math.round((f.size || 11) * 10) / 10 });
    const tramos = [];
    let actual = null;
    const agregar = (texto, w) => {
      const st = { f: w.f, b: !!w.b, i: !!w.i, tam: Math.round((w.tam || f.size || 11) * 10) / 10, color: w.color || par.color || [0, 0, 0] };
      const clave = JSON.stringify(st);
      if (actual?.clave === clave) actual.texto += texto; else { actual = { clave, st, texto }; tramos.push(actual); }
    };
    const L = par.lineas, lim1 = par.limites[1];
    L.forEach((l, i) => {
      if (i) {
        const ant = L[i - 1], w0 = l.palabras[0] || {};
        if (/[a-záéíóúñ]-$/i.test(ant.texto) && /^[a-záéíóúñ]/.test(l.texto)) { actual.texto = actual.texto.replace(/-$/, ''); }
        // un corte es "a propósito" (Enter) si la primera palabra del renglón siguiente hubiera entrado en el anterior
        // en un escaneo, y en un párrafo angosto que se puede ensanchar, cada renglón original queda como un Enter (así
        // al escribir crece solo ese renglón y los demás no se mueven)
        else agregar(hoja.escaneo || par.ampliable || (par.alineacion !== 'just' && ant.rect[2] + (f.size || 11) * 0.3 + (w0.x1 - w0.x0 || 0) < lim1 - 1) ? '\n' : ' ', ant.palabras.at(-1) || w0);
      }
      l.palabras.forEach((w, j) => {
        // un hueco grande dentro del renglón (después de una viñeta o un número de lista) va como tabulación, como en Word
        const ant = l.palabras[j - 1], hueco = ant ? w.x0 - ant.x1 : 0;
        if (j && !w.pegada && hueco > (w.tam || 11) * 0.6) { b.tab ||= Math.max(4, w.x0 - par.limites[0]); agregar('\t' + w.t, w); }
        else agregar((j && !w.pegada ? ' ' : '') + w.t, w);
      });
    });
    // la letra del párrafo también va en el bloque (lo que se le une sin tramo propio se ve y se mide con esa)
    const dom = { f: f.name, b: f.weight === 'bold', i: f.style === 'italic', tam: f.size || 11 };
    if (hoja.escaneo) dom.f = null;
    Object.assign(b.el.style, { fontWeight: dom.b ? 700 : 400, fontStyle: dom.i ? 'italic' : 'normal', color: aHex(b.tinta || par.color || [0, 0, 0]) });
    if (!hoja.escaneo) hoja.cargando.push(this.cssFuente(dom).then(ff => { b.el.style.fontFamily = ff; }));
    if (hoja.escaneo) { // la letra que más se parece a la del escaneo, en el tamaño justo (comparando la forma)
      const elegida = await this.letraEscaneo(hoja, b.par, b, dom).catch(e => { console.error('Letra del escaneo', e); return null; }) || { clave: 'serif', css: CSS_BASICA.serif, tam: f.size || 11 };
      b.el.dataset.letra = elegida.clave; b.el.dataset.tam = elegida.tam; b.el.style.fontFamily = elegida.css;
      for (const t of tramos) t.st.tam = elegida.tam;
    }
    for (const t of tramos) {
      const s = el('span', { 'data-f': t.st.f || '' });
      s.textContent = t.texto;
      Object.assign(s.style, { fontWeight: t.st.b ? 700 : 400, fontStyle: t.st.i ? 'italic' : 'normal', color: aHex(t.st.color),
        fontSize: `calc(var(--k) * ${t.st.tam}px)` });
      s.dataset.tam = t.st.tam;
      if (!hoja.escaneo) hoja.cargando.push(this.cssFuente(t.st).then(ff => { s.style.fontFamily = ff; }));
      b.el.append(s);
    }
    hoja.raiz.append(b.el);
    return b;
  }
  // Letra para MOSTRAR (la del documento casi nunca se puede usar en pantalla): la instalada igual o una parecida
  async cssFuente(st) {
    await this.fuentes.cargar().catch(() => {});
    const fam = st.f && this.fuentes.parecida(st.f);
    if (fam) return this.fuentes.css('f:' + fam.familia, st.b, st.i);
    return CSS_BASICA[familiaDe(st.f)];
  }
  ubicar(hoja, b) {
    const v = hoja.pg.vista, par = b.par, f = par.fuente || {}, s = v.scale;
    const F = (f.size || 11), LH = par.interlineado;
    const lim = this.limites(b);
    const yB = par.lineas[0].base[1] - b.dy, [x0, yb] = hoja.lugar.enVista(v, lim[0], yB), [x1] = hoja.lugar.enVista(v, lim[1], yB);
    const top = (yb - (LH / 2 + 0.33 * F) * s) / v.height * 100;
    Object.assign(b.el.style, { left: Math.min(x0, x1) / v.width * 100 + '%', top: top + '%', width: Math.abs(x1 - x0) / v.width * 100 + '%',
      fontSize: `calc(var(--k) * ${F * (b.escala || 1)}px)`, lineHeight: `calc(var(--k) * ${LH}px)`,
      textAlign: { izq: 'left', der: 'right', centro: 'center', just: 'justify' }[par.alineacion], textIndent: `calc(var(--k) * ${par.sangria || 0}px)`,
      tabSize: `calc(var(--k) * ${b.tab || 36}px)` });
    // un renglón suelto sin lugar al costado (una etiqueta "Fecha:" pegada a su dato) no se corta aunque la letra de la
    // pantalla sea un poco más ancha que la del PDF
    const r = par.lineas[0].rect;
    if (par.lineas.length === 1 && !par.ampliable && Math.abs(lim[1] - lim[0]) < r[2] - r[0] + F * 2) b.el.style.whiteSpace = 'pre';
  }

  // ---------- Escribir ----------
  eventos(hoja) {
    const r = hoja.raiz, bloqueDe = n => (n?.nodeType === 1 ? n : n?.parentElement)?.closest?.('.ed-bloque');
    r.addEventListener('beforeinput', e => {
      // Enter: un salto de renglón dentro del mismo bloque (como texto, para que se pueda deshacer con Ctrl+Z)
      if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') { e.preventDefault(); document.execCommand('insertHTML', false, '\n'); }
    });
    r.addEventListener('paste', e => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain').replace(/\r/g, '')); });
    r.addEventListener('drop', e => e.preventDefault());
    r.addEventListener('keydown', e => {
      const ctrl = e.ctrlKey || e.metaKey, t = e.key.toLowerCase();
      if (ctrl && (t === 'b' || t === 'n')) { e.preventDefault(); document.execCommand('bold'); }
      else if (ctrl && (t === 'i' || t === 'k')) { e.preventDefault(); document.execCommand('italic'); }
      else if (e.key === 'Escape') { e.preventDefault(); this.ed.terminar(); return; }
      else if (ctrl && t === 's') return; // guardar: lo maneja el programa (antes escribe lo pendiente)
      e.stopPropagation(); // el resto de las teclas son para escribir, no atajos del programa
    });
    r.addEventListener('input', () => {
      const b = hoja.bloques.find(x => x.el === bloqueDe(getSelection().anchorNode));
      // al unir párrafos el navegador envuelve lo movido con medidas fijas (letra, tamaño, interlineado): se sacan,
      // así toma las del párrafo y sigue el zoom
      if (b) for (const sp of b.el.querySelectorAll('span[style]:not([data-f]):not([data-tam]):not([data-letra])')) {
        for (const prop of ['font-family', 'font-size', 'line-height', 'white-space', 'text-indent', 'text-align']) sp.style.removeProperty(prop);
        if (!sp.getAttribute('style')?.trim()) sp.removeAttribute('style');
      }
      if (b) { b.sucio = true; this.ultimo = { hoja, b }; if (hoja.escaneo) this.tocarEscaneo(b); }
      // bloques que se borraron enteros (por ejemplo al unir dos párrafos con Borrar)
      for (const x of hoja.bloques) if (!x.el.isConnected) x.sucio = true;
      this.empujar(hoja, b);
    });
    // al salir de un párrafo, ese párrafo se escribe en el PDF
    hoja.selCambio = () => {
      const sel = getSelection();
      if (sel.rangeCount && hoja.raiz.contains(sel.anchorNode)) { this.rango = sel.getRangeAt(0).cloneRange(); this.hojaRango = hoja; this.actualizarControles(); }
      const b = hoja.bloques.find(x => x.el === bloqueDe(getSelection().anchorNode));
      if (this.ultimo && this.ultimo.hoja === hoja && this.ultimo.b !== b) this.confirmarHoja(hoja, b);
      if (b) this.ultimo = { hoja, b };
    };
    document.addEventListener('selectionchange', hoja.selCambio);
  }
  // Cuántos renglones tiene cada bloque recién armado y a qué distancia (de base a base) estaba del de abajo
  medirBase(hoja) {
    for (const b of hoja.bloques) if (b.n0 == null && b.el.isConnected) b.n0 = this.lineas(b).length;
    for (const a of hoja.bloques) if (a.salto0 === undefined) { const s = this.siguiente(hoja, a); a.salto0 = s ? a.par.lineas.at(-1).base[1] - s.par.lineas[0].base[1] : null; }
  }
  // ¿Es parte de una fila de tabla? (hay otro bloque a la misma altura, al costado): esas no se corren nunca
  enFila(hoja, b) {
    const r = b.par.rect;
    return hoja.bloques.some(c => c !== b && c.el.isConnected && Math.min(r[3], c.par.rect[3]) - Math.max(r[1], c.par.rect[1]) > (r[3] - r[1]) * 0.5
      && (c.par.limites[0] >= b.par.limites[1] || c.par.limites[1] <= b.par.limites[0]));
  }
  // El bloque que tiene inmediatamente debajo (solapándose en lo ancho), entre los que siguen en la hoja
  // Cuentagotas para escaneos: se dibuja el renglón más largo con cada letra candidata (palabra por palabra, en el lugar
  // de cada palabra y del tamaño que ocupa el original) y se compara punto por punto con la imagen. Gana la más parecida.
  async letraEscaneo(hoja, par, b, dom) {
    const pg = hoja.pg, lienzo = pg.div.querySelector('canvas'), v = pg.vista;
    if (!lienzo || !v) return null;
    const f = lienzo.width / v.width, L = [...par.lineas].sort((a, z) => z.texto.length - a.texto.length)[0];
    const [a, bb, c, d] = v.convertToViewportRectangle(hoja.lugar.rectAPdf(L.rect));
    const x0 = Math.max(0, Math.floor(Math.min(a, c) * f) - 2), y0 = Math.max(0, Math.floor(Math.min(bb, d) * f) - 2);
    const w = Math.min(lienzo.width - x0, Math.ceil(Math.abs(c - a) * f) + 4), h = Math.min(lienzo.height - y0, Math.ceil(Math.abs(d - bb) * f) + 4);
    if (w < 10 || h < 4) return null;
    const px = lienzo.getContext('2d', { willReadFrequently: true }).getImageData(x0, y0, w, h).data;
    const lum = (r, g, bl) => 0.299 * r + 0.587 * g + 0.114 * bl, papel = lum(...b.fondo.map(x => x * 255)), tinta = lum(...b.tinta.map(x => x * 255)), corte = (papel + tinta) / 2;
    const tintaImg = new Uint8Array(w * h);
    for (let k = 0; k < w * h; k++) tintaImg[k] = lum(px[k * 4], px[k * 4 + 1], px[k * 4 + 2]) < corte ? 1 : 0;
    const [, baseY] = hoja.lugar.enVista(v, L.base[0], L.base[1]), base = baseY * f - y0;
    const pal = L.palabras.map(p => ({ t: p.t, x: hoja.lugar.enVista(v, p.x0, L.base[1])[0] * f - x0, ancho: (p.x1 - p.x0) * v.scale * f }));
    await this.fuentes.cargar().catch(() => {});
    const comunes = ['Times New Roman', 'Arial', 'Calibri', 'Cambria', 'Georgia', 'Verdana', 'Tahoma', 'Garamond', 'Book Antiqua', 'Century Gothic', 'Arial Narrow', 'Courier New'];
    const candidatas = ['serif', 'sans', 'mono', ...comunes.filter(n => this.fuentes.familia(n)).map(n => 'f:' + n)];
    const lienzo2 = new OffscreenCanvas(w, h), g = lienzo2.getContext('2d', { willReadFrequently: true });
    let mejor = null;
    for (const clave of candidatas) {
      const css = await this.fuentes.css(clave, dom.b, dom.i);
      const peso = `${dom.i ? 'italic ' : ''}${dom.b ? 700 : 400}`;
      g.font = `${peso} 100px ${css}`;
      const natural = pal.reduce((s, p) => s + g.measureText(p.t).width, 0), ocupa = pal.reduce((s, p) => s + p.ancho, 0);
      if (!natural) continue;
      const tamPx = 100 * ocupa / natural;
      g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.fillStyle = '#000'; g.font = `${peso} ${tamPx}px ${css}`; g.textBaseline = 'alphabetic';
      for (const p of pal) g.fillText(p.t, p.x, base);
      const q = g.getImageData(0, 0, w, h).data;
      let ambos = 0, a1 = 0, a2 = 0;
      for (let k = 0; k < w * h; k++) { const t2 = q[k * 4] < 128 ? 1 : 0; a1 += tintaImg[k]; a2 += t2; if (t2 && tintaImg[k]) ambos++; }
      const parecido = 2 * ambos / Math.max(1, a1 + a2);
      if (!mejor || parecido > mejor.parecido) mejor = { clave, css, tam: Math.round(tamPx / (v.scale * f) * 2) / 2, parecido };
    }
    return mejor;
  }
  // En un escaneo, el párrafo que se toca tapa lo de abajo con el color del papel y se ve con el de la tinta
  tocarEscaneo(b) {
    if (b.el.classList.contains('tocado')) return;
    b.el.classList.add('tocado');
    const papel = aHex(b.fondo || [1, 1, 1]);
    Object.assign(b.el.style, { background: papel, boxShadow: `0 0 0 calc(var(--k) * 2px) ${papel}` });
  }
  // ancho del bloque: el original, o hasta el margen si ya se ensanchó (porque lo escrito no entraba)
  limites(b) { return b.ampliado && b.par.ampliable ? [b.par.limites[0], b.par.ampliable] : b.par.limites; }
  // un bloque que se vació del todo cuenta como si no estuviera (el de abajo sube a su lugar)
  presente(b) { return b.el.isConnected && (!b.editado || !!b.el.textContent.trim()); }
  siguiente(hoja, a) {
    return hoja.bloques.filter(b => b !== a && this.presente(b) && b.par.rect[3] <= a.par.rect[1] + 1 && Math.min(a.par.limites[1], b.par.limites[1]) > Math.max(a.par.limites[0], b.par.limites[0]))
      .sort((x, y) => y.par.rect[3] - x.par.rect[3])[0] || null;
  }
  // Texto corrido, como en Word: cada bloque va a la misma distancia del de arriba que tenía al principio. Si el de arriba
  // creció, baja; si se achicó o se unió con otro, sube. Las tablas, imágenes y el fin de la hoja no se corren: si algo
  // no entra, se marca en rojo.
  empujar(hoja, editado) {
    if (!hoja.pg.vista) return;
    if (hoja.escaneo) { // lo de alrededor es parte de la imagen: no se corre; si crece y pisa algo, se marca
      if (editado) { editado.editado = true; this.medirBase(hoja); const s = this.siguiente(hoja, editado), n = this.lineas(editado).length;
        editado.el.classList.toggle('sin-lugar', editado.el.scrollWidth > editado.el.clientWidth + 2 || // un renglón se pasa del margen
          (!!s && editado.par.lineas[0].base[1] - (n - 1) * editado.par.interlineado - editado.par.fuente.size * 0.3 < s.par.rect[3])); }
      return;
    }
    this.medirBase(hoja);
    if (editado) editado.editado = true;
    if (editado && editado.par.ampliable && !editado.ampliado && editado.n0 != null && this.lineas(editado).length > editado.n0) { editado.ampliado = true; this.ubicar(hoja, editado); }
    const vivos = hoja.bloques.filter(b => this.presente(b)).sort((a, b) => b.par.rect[3] - a.par.rect[3]); // de arriba hacia abajo
    const renglones = b => b.editado ? this.lineas(b).length : (b.n0 ?? b.par.lineas.length);
    const columna = (a, b) => Math.abs(a.par.limites[0] - b.par.limites[0]) < (b.par.fuente?.size || 11) * 3 && b.par.limites[1] > a.par.limites[0];
    const primera = b => b.par.lineas[0].base[1];
    const dy = new Map(vivos.map(b => [b, 0]));
    // lo que llega de la hoja de arriba (hacerLugar): los primeros párrafos de cada columna bajan
    if (hoja.empuje) for (const b of vivos) if (!b.fijo && !this.enFila(hoja, b) && !vivos.some(a => a !== b && !a.fijo && this.siguiente(hoja, a) === b)) dy.set(b, hoja.empuje);
    for (const b of vivos) { b.el.classList.remove('sin-lugar'); b.crece = renglones(b) - (b.n0 ?? b.par.lineas.length); }
    for (const a of vivos) {
      if (a.salto0 == null || (a.fijo && hoja.empuje)) continue;
      // dónde queda su último renglón (si no se tocó, donde está; si se editó, según cuántos renglones tiene ahora)
      const ultima = a.par.lineas.at(-1).base[1] - (a.editado ? (renglones(a) - (a.n0 ?? a.par.lineas.length)) * a.par.interlineado : 0) - dy.get(a);
      const s = this.siguiente(hoja, a);
      if (!s) continue;
      const deseada = ultima - a.salto0; // dónde debería empezar el de abajo
      if (columna(a, s) && !this.enFila(hoja, s) && !s.fijo) dy.set(s, primera(s) - deseada);
      else if (s.fijo) continue; // el pie no se corre: lo que llegue hasta ahí ya pasa a la hoja nueva
      else if (deseada > primera(s) + 0.5 && ultima - (a.par.fuente?.size || 11) * 0.3 < s.par.rect[3]) a.el.classList.add('sin-lugar'); // no se corre y lo pisaría
    }
    for (const b of vivos) {
      const d = dy.get(b);
      if (Math.abs(d - b.dy) > 0.3) { b.dy = d; b.sucio = true; this.ubicar(hoja, b); }
      b.el.classList.toggle('pasa', !b.fijo && hoja.abajo != null && primera(b) - b.dy - (renglones(b) - 1) * b.par.interlineado < hoja.abajo - 0.5);
    }
    // un renglón que no se corta (celda de tabla, etiqueta) y se sale de su lugar hacia el costado también pisa algo
    if (editado?.el.style.whiteSpace === 'pre' && editado.el.clientWidth && editado.el.scrollWidth > editado.el.clientWidth + 2) {
      const [l0, l1] = this.limites(editado), ptPorPx = (l1 - l0) / editado.el.clientWidth, r = editado.par.rect;
      // lugar libre: hasta lo que está a la derecha en el mismo renglón (otra celda) o hasta el margen
      const derecha = hoja.bloques.filter(o => o !== editado && this.presente(o) && o.par.limites[0] >= l1 - 1 && Math.min(r[3], o.par.rect[3]) > Math.max(r[1], o.par.rect[1]))
        .map(o => o.par.limites[0] - 3);
      const tope = Math.min(hoja.lugar.ancho - 30, ...derecha);
      if (l0 + editado.el.scrollWidth * ptPorPx > tope) editado.el.classList.add('sin-lugar');
    }
    hoja.el.classList.toggle('desborda', vivos.some(b => b.el.classList.contains('pasa')));
    this.ofrecerAjuste(hoja, editado);
  }
  // Párrafo vivo: si lo que escribiste no entra en su lugar (una celda de tabla, algo que no se corre debajo), se ofrece
  // achicar la letra (hasta 75 %) o dejarlo así. Nunca se achica a escondidas.
  ofrecerAjuste(hoja, b) {
    if (b?.achicando) return;
    hoja.ajuste?.remove(); hoja.ajuste = null;
    if (!b || !b.el.classList.contains('sin-lugar') || b.dejado) return;
    const { el } = this.ctx, sinFoco = e => e.preventDefault();
    hoja.ajuste = el('div', { class: 'ed-ajuste', contenteditable: 'false' }, el('span', {}, 'No entra en su lugar:'),
      el('button', { class: 'btn-texto', onmousedown: sinFoco, onclick: () => this.achicarParaQueEntre(hoja, b) }, 'Achicar la letra'),
      el('button', { class: 'btn-texto', onmousedown: sinFoco, onclick: () => { b.dejado = true; hoja.ajuste?.remove(); hoja.ajuste = null; } }, 'Dejarlo así'));
    Object.assign(hoja.ajuste.style, { left: b.el.style.left, top: `calc(${b.el.style.top} + ${b.el.offsetHeight + 4}px)` });
    hoja.el.append(hoja.ajuste);
  }
  achicarParaQueEntre(hoja, b) {
    const spans = [...b.el.querySelectorAll('[data-tam]')], orig = spans.map(x => +x.dataset.tam), base = +b.el.dataset.tam || b.par.fuente?.size || 11;
    const poner = f => { spans.forEach((x, i) => { x.dataset.tam = Math.round(orig[i] * f * 10) / 10; x.style.fontSize = `calc(var(--k) * ${orig[i] * f}px)`; }); b.el.dataset.tam = Math.round(base * f * 10) / 10; b.escala = f; this.ubicar(hoja, b); };
    b.achicando = true;
    let f = 1;
    for (const g of [0.95, 0.9, 0.85, 0.8, 0.75]) { poner(g); this.empujar(hoja, b); if (!b.el.classList.contains('sin-lugar')) { f = g; break; } }
    b.achicando = false;
    if (f === 1) { poner(1); this.empujar(hoja, b); return this.ctx.aviso('Ni achicando la letra a 75 % entra. Podés acortar el texto o dejarlo así.', true); }
    b.sucio = true; hoja.ajuste?.remove(); hoja.ajuste = null;
    this.ctx.aviso(`Achiqué la letra a ${Math.round(f * 100)} % para que entre. Se pasa al PDF al salir del párrafo (Ctrl+Z lo deshace).`);
  }
  // ---------- Barra de formato (como la de Word) ----------
  // Va en la barra de Editar. Lo elegido se aplica a lo seleccionado (o a la palabra donde está el cursor) y la
  // alineación al párrafo entero. Los botones no le sacan el foco al texto.
  controles() {
    const { el } = this.ctx, sinFoco = e => e.addEventListener('mousedown', ev => { if (ev.target.tagName !== 'SELECT' && ev.target.tagName !== 'INPUT') ev.preventDefault(); });
    const boton = (t, titulo, f, clase = '') => { const b = el('button', { class: 'btn-icono ' + clase, title: titulo, onclick: f }, t); sinFoco(b); return b; };
    this.ui = {};
    const letra = this.ui.letra = el('select', { class: 'campo com-letra', title: 'Letra' }, el('option', { value: '' }, 'Letra del documento'));
    this.fuentes.cargar().then(async () => { const p = this.ed.p; if (p) letra.append(...(await this.fuentes.opciones(el, p, '')).filter(o => o.tagName === 'OPTGROUP' && !/Del documento/.test(o.label))); }).catch(() => {});
    letra.addEventListener('change', () => { this.formato('letra', letra.value); });
    const tam = this.ui.tam = el('input', { class: 'campo ed-tam', type: 'number', min: 4, max: 96, step: 0.5, title: 'Tamaño de letra' });
    tam.addEventListener('change', () => { const v = Math.max(4, Math.min(96, +tam.value || 11)); this.formato('tam', v); });
    const color = this.ui.color = el('input', { type: 'color', title: 'Color de la letra', value: '#000000' });
    color.addEventListener('input', () => this.formato('color', color.value));
    const alin = this.ui.alin = ['izq', 'centro', 'der', 'just'].map((a, k) => boton(['Izq.', 'Centro', 'Der.', 'Just.'][k], ['Alinear a la izquierda', 'Centrar', 'Alinear a la derecha', 'Justificar'][k], () => this.alinear(a)));
    alin.forEach((b, k) => { b.dataset.a = ['izq', 'centro', 'der', 'just'][k]; });
    for (const x of [letra, tam, color]) x.addEventListener('keydown', e => e.stopPropagation());
    return el('div', { class: 'ed-formato' }, letra, tam,
      boton('N', 'Negrita (Ctrl+N), como en Word', () => this.formato('negrita'), 'fuerte'), boton('K', 'Cursiva (Ctrl+K), como en Word', () => this.formato('cursiva'), 'cursiva'),
      boton('A−', 'Más chica', () => this.formato('tam', '-')), boton('A+', 'Más grande', () => this.formato('tam', '+')),
      color, el('div', { class: 'segmentos-botones' }, ...alin));
  }
  // Cómo está el texto donde está el cursor
  actualizarControles() {
    if (!this.ui || !this.rango) return;
    const n = this.rango.startContainer, e = n.nodeType === 1 ? n : n.parentElement;
    if (!e) return;
    const cs = getComputedStyle(e);
    this.ui.letra.value = e.closest('[data-letra]')?.dataset.letra || '';
    this.ui.tam.value = e.closest('[data-tam]')?.dataset.tam || '';
    this.ui.color.value = aHex(deCss(cs.color));
    const b = this.hojaRango?.bloques.find(x => x.el.contains(e));
    this.ui.alin.forEach(x => x.setAttribute('aria-pressed', String(x.dataset.a === b?.par.alineacion)));
  }
  // Los pedazos de texto seleccionados, cada uno envuelto en su propio <span> (sin mover los bloques de lugar)
  pedazos() {
    const r = this.rango;
    if (!r) return [];
    if (r.collapsed) { // sin selección: la palabra donde está el cursor
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      sel.modify('move', 'backward', 'word'); sel.modify('extend', 'forward', 'word');
      this.rango = sel.getRangeAt(0).cloneRange();
    }
    const R = this.rango, raiz = this.hojaRango.raiz, out = [];
    const t = document.createTreeWalker(R.commonAncestorContainer.nodeType === 3 ? R.commonAncestorContainer.parentElement : R.commonAncestorContainer, NodeFilter.SHOW_TEXT);
    const nodos = [];
    for (let n = t.nextNode(); n; n = t.nextNode()) if (R.intersectsNode(n) && raiz.contains(n)) nodos.push(n);
    for (let n of nodos) {
      let a = n === R.startContainer ? R.startOffset : 0, z = n === R.endContainer ? R.endOffset : n.length;
      if (a >= z) continue;
      if (z < n.length) n.splitText(z);
      if (a > 0) { n = n.splitText(a); }
      const s = document.createElement('span');
      n.parentNode.insertBefore(s, n); s.append(n);
      out.push(s);
    }
    if (out.length) { const nr = document.createRange(); nr.setStartBefore(out[0]); nr.setEndAfter(out.at(-1)); this.rango = nr; const sel = getSelection(); sel.removeAllRanges(); sel.addRange(nr); }
    return out;
  }
  async formato(tipo, valor) {
    const hoja = this.hojaRango;
    if (!hoja || !this.rango) return this.ctx.aviso('Primero hacé clic en el texto o seleccioná lo que querés cambiar.');
    hoja.raiz.focus();
    if (tipo === 'negrita' || tipo === 'cursiva') {
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(this.rango);
      document.execCommand(tipo === 'negrita' ? 'bold' : 'italic');
    } else {
      const partes = this.pedazos();
      for (const s of partes) {
        const actual = s.parentElement, tam0 = +(actual.closest('[data-tam]')?.dataset.tam || 11);
        if (tipo === 'tam') { const v = valor === '+' ? tam0 + 0.5 : valor === '-' ? Math.max(4, tam0 - 0.5) : valor; s.dataset.tam = v; s.style.fontSize = `calc(var(--k) * ${v}px)`; }
        if (tipo === 'color') s.style.color = valor;
        if (tipo === 'letra') {
          if (valor) { const cs = getComputedStyle(actual); s.dataset.letra = valor; s.style.fontFamily = await this.fuentes.css(valor, +cs.fontWeight >= 600, cs.fontStyle === 'italic'); }
          else { s.removeAttribute('data-letra'); s.style.fontFamily = ''; for (const x of s.querySelectorAll('[data-letra]')) { x.removeAttribute('data-letra'); x.style.fontFamily = ''; } }
        }
      }
    }
    for (const b of hoja.bloques) if (b.el.isConnected && this.rango?.intersectsNode(b.el)) { b.sucio = true; this.ultimo = { hoja, b }; this.empujar(hoja, b); }
    this.actualizarControles();
  }
  alinear(a) {
    const hoja = this.hojaRango;
    if (!hoja || !this.rango) return this.ctx.aviso('Primero hacé clic en el párrafo que querés alinear.');
    for (const b of hoja.bloques) if (b.el.isConnected && this.rango.intersectsNode(b.el)) { b.par.alineacion = a; b.forzar = true; b.sucio = true; this.ubicar(hoja, b); this.ultimo = { hoja, b }; }
    hoja.raiz.focus(); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(this.rango);
    this.actualizarControles();
  }

  // Escribe en el PDF los párrafos de la página que cambiaron (salvo el que se está editando, si se pasa `menos`)
  confirmarHoja(hoja, menos = null) {
    // orden (así cada uno siempre se escribe en un lugar libre): primero los que se achicaron o solo cambiaron; después
    // los que suben, de arriba hacia abajo; después los que bajan, de abajo hacia arriba; los que crecieron, al final
    const orden = b => b.dy < -0.3 ? 1e4 - b.par.rect[3] : b.dy > 0.3 ? 2e4 + b.par.rect[1] : b.crece > 0 ? 3e4 : 0;
    const pendientes = hoja.bloques.filter(b => b.sucio && b !== menos).sort((a, b) => orden(a) - orden(b));
    for (const b of pendientes) { b.sucio = false; this.cola = this.cola.then(() => this.confirmar(hoja, b)).catch(e => console.error(e)); }
    this.cola = this.cola.then(() => this.pasarDesborde(hoja)).catch(e => this.ctx.error?.(e));
    return this.cola;
  }
  async confirmarTodo() { for (const h of this.hojas.values()) this.confirmarHoja(h); return this.cola; }
  // Saca todo (después de confirmar). Devuelve si hubo cambios (para volver a dibujar el documento)
  async cerrar() {
    this.cerrando = true;
    try { await this.confirmarTodo(); } finally { this.cerrando = false; }
    let hubo = false;
    for (const h of this.hojas.values()) { document.removeEventListener('selectionchange', h.selCambio); h.ro?.disconnect(); h.el.remove(); if (h.fondo.src) URL.revokeObjectURL(h.fondo.src); hubo ||= !!h.cambios; }
    this.hojas.clear(); this.ultimo = null;
    return hubo;
  }

  // Lo que no entró en la hoja sigue en la hoja de abajo, como en Word: va arriba del texto de esa hoja y lo que había
  // ahí baja (y si se pasa, sigue en la otra). Encabezados y pies quedan fijos. Si la de abajo es una hoja que armó el
  // editor, se baja todo lo que tiene. Si no se puede correr (tablas o imágenes arriba, escaneo) o no hay hoja de
  // abajo, se pone una hoja nueva en el medio. arriba: es el primer paso (no uno de la cascada).
  async pasarDesborde(hoja, arriba = true) {
    const piezas = (hoja.desborde || []).sort((a, b) => b.arriba - a.arriba);
    hoja.desborde = [];
    if (!piezas.length) return hoja.n;
    const n = hoja.n + 1, tipo = piezas[0].inicio ? 1 : 2, ultima = piezas.at(-1);
    let modo = 'nueva', lugar = null;
    const destino = await this.hojaSiguiente(hoja).catch(e => { console.error('Hoja de abajo', e); return null; });
    if (destino && await this.hacerLugar(destino, this.armarDesborde(piezas, n, destino.arriba).fin, ultima)) { modo = 'siguiente'; lugar = destino.lugar; }
    else if (await ops.tipoDesborde(hoja.p.datos, hoja.n)) modo = 'desborde';
    const { originales, escribir, fin } = this.armarDesborde(piezas, n, modo === 'siguiente' ? destino.arriba : hoja.arriba ?? piezas[0].lim1);
    // de "hoja derecha" a puntos del PDF (en la hoja de abajo puede estar girada o recortada; la hoja nueva va derecha)
    const aP = e => { if (!lugar) return e; const [x, y] = lugar.aPdf(e.x, e.y); return { ...e, x, y, giro: lugar.giro }; };
    let siguio = modo === 'siguiente';
    const ok = await this.ctx.aplicar(async base => {
      let bytes = modo === 'siguiente' ? base : modo === 'desborde' ? await this.enHojaDeAbajo(base, hoja, fin, ultima, tipo) : null;
      siguio = !!bytes;
      bytes ||= await ops.insertarBlanco(base, hoja.n - 1, [hoja.lugar.ancho, hoja.lugar.alto], tipo); // la hoja nueva, derecha y del tamaño que se ve
      if (originales.length) bytes = await this.ctx.api.escribirOriginal(bytes, n, null, originales.map(aP));
      return escribir.length ? await ops.escribirTexto(bytes, escribir.map(aP)) : bytes;
    }, { mensaje: siguio ? 'Lo que no entraba siguió en la hoja de abajo' : 'Lo que no entraba en la hoja pasó a una hoja nueva', sinRecargar: true });
    if (!ok) return hoja.n;
    hoja.cambios = (hoja.cambios || 0) + 1;
    let ultimaHoja = n;
    // lo que bajó en la hoja de abajo y ya no entra ahí, sigue en la otra
    // (también si no se pudo seguir en ella pero algo ya había bajado: nunca se pierde texto)
    if (modo === 'siguiente' || destino?.desborde?.length) { if (!siguio) destino.n++; /* se puso una hoja en el medio */ destino.cambios = (destino.cambios || 0) + 1; ultimaHoja = await this.pasarDesborde(destino, false); }
    if (arriba && siguio) this.ctx.aviso?.('Lo que no entraba siguió en la hoja de abajo');
    // las hojas cambiaron: se arma todo de nuevo, mostrando la última a la que llegó el texto
    if (arriba && !this.cerrando) setTimeout(() => this.ed.reabrir(Math.min(n, ultimaHoja)), 0);
    return ultimaHoja;
  }
  // Ubica lo que no entró, renglón por renglón, desde y hacia abajo. Devuelve lo que hay que escribir y dónde termina.
  armarDesborde(piezas, n, y) {
    const originales = [], escribir = [];
    let primera = true;
    for (const pz of piezas) {
      if (!primera) y -= pz.salto;
      pz.pal.forEach((ws, i) => {
        if (i) y -= pz.lead;
        primera = false;
        if (!ws.length) return;
        const anchos = ws.map(w => pz.ancho(w)), esp = w => pz.ancho(w, ' ');
        const natural = ws.reduce((a, w, k) => a + anchos[k] + (k && !w.pegada ? esp(w) : 0), 0);
        let x = pz.alineacion === 'der' ? pz.lim1 - natural : pz.alineacion === 'centro' ? (pz.lim0 + pz.lim1) / 2 - natural / 2 : pz.lim0 + (i === 0 ? pz.sangria : 0), hueco = null;
        const huecos = ws.filter((w, k) => k && !w.pegada && !w.tab).length;
        if (pz.alineacion === 'just' && !pz.duro[i] && huecos) hueco = (pz.lim1 - x - anchos.reduce((a, v) => a + v, 0)) / huecos;
        ws.forEach((w, k) => {
          if (k && w.tab) { const t = pz.tab || 36; x = pz.lim0 + Math.ceil((x - pz.lim0 + 0.5) / t) * t; }
          else if (k && !w.pegada) x += hueco ?? esp(w);
          const r = pz.recursos.get(JSON.stringify(w.st));
          if (r.orig) originales.push({ x, y, hex: [...w.t].map(ch => r.orig.mapa[ch]).join(''), tam: w.st.tam, color: w.st.color, fuente: { recurso: r.orig.recurso, num: r.orig.num } });
          else escribir.push({ n, x, y, texto: w.t, fuente: r.fuente, negrita: w.st.b, cursiva: w.st.i, tam: w.st.tam, color: w.st.color });
          x += anchos[k];
        });
      });
    }
    return { originales, escribir, fin: y };
  }
  // La hoja de abajo, armada en el modo documento (aunque no se haya mirado todavía), o null si no hay o no se puede
  async hojaSiguiente(hoja) {
    const p = hoja.p, pg = p.visor?.paginas?.[hoja.n];
    if (!pg || p.visor.rotacion) return null;
    if (!pg.vista) await p.visor.dibujar(pg).catch(() => {});
    if (!pg.vista) return null;
    if (!this.hojas.has(this.clave(p, pg.n))) {
      const [c, r] = await Promise.all([this.ed.contenido(p, pg.n), this.ed.parrafos(p, pg.n)]);
      await this.armar(p, pg, c, r.parrafos, new Lugar(r.lugar));
    }
    const h = this.hojas.get(this.clave(p, pg.n));
    if (!h || h.escaneo || h.arriba == null) return null;
    await Promise.all(h.cargando); await document.fonts.ready; this.medirBase(h);
    return h;
  }
  // Hace lugar arriba en la hoja h para lo que llega de la de arriba (termina en fin): baja sus párrafos (los pasa al
  // PDF) como cuando crece el de arriba. Si algo que no se corre (tabla, imagen, texto suelto) quedaría debajo de lo
  // nuevo, no toca nada y devuelve false.
  async hacerLugar(h, fin, ultima) {
    const cuerpo = h.bloques.filter(b => this.presente(b) && !b.fijo).sort((a, b) => b.par.rect[3] - a.par.rect[3]);
    if (!cuerpo.length) return false;
    // si la hoja empieza en minúscula, es la continuación del párrafo de arriba: va a un renglón de distancia
    const sigue = /^[a-záéíóúñü]/.test(cuerpo[0].par.lineas[0].texto || '');
    const empuje = h.arriba - (fin - (sigue ? ultima.lead : ultima.salto));
    const zona = [fin - ultima.lead, h.arriba + (cuerpo[0].par.fuente?.size || 11)], choca = r => r[1] < zona[1] && r[3] > zona[0];
    const enBloque = r => h.bloques.some(b => this.presente(b) && r[0] >= b.par.rect[0] - 2 && r[2] <= b.par.rect[2] + 2 && r[1] >= b.par.rect[1] - 2 && r[3] <= b.par.rect[3] + 2);
    const sueltos = [...h.cont.imagenes.filter(im => !im.entera), ...h.cont.lineas].map(o => h.lugar.rectDePdf(o.rect)).filter(r => !enBloque(r));
    if (sueltos.some(choca)) return false;
    if (empuje <= 0.3) return true;
    h.empuje = empuje; this.empujar(h, null); h.empuje = 0;
    const quietos = cuerpo.filter(b => Math.abs(b.dy) < 0.3 && choca(b.par.rect));
    if (quietos.length || h.bloques.some(b => b.el.classList.contains('sin-lugar'))) { this.empujar(h, null); return false; }
    // se pasan al PDF de abajo hacia arriba (así cada uno va a un lugar libre); lo que pase el fin de la hoja sigue en la otra
    const bajan = h.bloques.filter(b => b.sucio && b.dy > 0.3).sort((a, b) => a.par.rect[1] - b.par.rect[1]);
    for (const b of bajan) { b.sucio = false; await this.confirmar(h, b); }
    return bajan.every(b => !b.el.isConnected || Math.abs(b.dy) < 0.3); // los que pasaron enteros a la otra hoja ya no están
  }

  // Hace lugar arriba en la hoja de desborde que sigue: baja lo que tiene hasta justo debajo de lo nuevo (que termina en
  // fin). Devuelve los bytes, o null si no es hoja de desborde o si lo que tiene ya no entraría.
  async enHojaDeAbajo(base, hoja, fin, ultima, tipo) {
    const abajo = await ops.tipoDesborde(base, hoja.n);
    if (!abajo) return null;
    const { lineas = [] } = await this.ctx.api.paginaContenido(base, hoja.n + 1);
    const bases = lineas.map(l => l.base[1]);
    if (!bases.length) return null;
    // si arriba de la hoja de abajo sigue el mismo párrafo, va a un renglón de distancia; si no, a un salto de párrafo
    const dy = Math.max(...bases) - (fin - (abajo === 2 ? ultima.lead : ultima.salto));
    if (dy <= 0) return null;
    if (Math.min(...bases) - dy < Math.min(hoja.abajo ?? 36, 72)) return null;
    return ops.bajarContenido(base, hoja.n, dy, tipo);
  }

  // Lo protegido que aparece en un texto: códigos y números largos (si está activado) y los textos que eligió el usuario
  protegidos(texto) {
    const pr = this.ctx.prefs?.() || {}, t = texto.replace(/\s+/g, ' '), out = new Set();
    if (pr.protegerCodigos !== false) for (const m of t.matchAll(/\b\d{2}-?\d{8}-?\d\b|\b\d{1,2}\.\d{3}\.\d{3}\b|[#*][\d.\-]{6,}[#*]|\b(?=[A-Z0-9\-\/.]*\d)(?=[A-Z0-9\-\/.]*[A-Z])[A-Z0-9][A-Z0-9\-\/.]{6,}[A-Z0-9]\b|\b\d{7,}\b/g)) out.add(m[0]);
    for (const x of String(pr.textosProtegidos || '').split('\n').map(v => v.trim()).filter(Boolean)) if (t.toLowerCase().includes(x.toLowerCase())) out.add(t.substr(t.toLowerCase().indexOf(x.toLowerCase()), x.length));
    return [...out];
  }
  // ---------- Leer lo escrito ----------
  // Renglones tal como se ven, con el estilo de cada letra: [{ tramos: [{ t, st }], duro }]
  lineas(b) {
    const out = [], rango = document.createRange(), estilos = new Map();
    let linea = { tramos: [], duro: false }, arriba = null;
    const estiloDe = nodo => {
      const e = nodo.parentElement;
      if (!estilos.has(e)) {
        const cs = getComputedStyle(e), span = e.closest('[data-f]');
        const elegida = e.closest('[data-letra]')?.dataset.letra;
        estilos.set(e, { f: span?.dataset.f || null, b: +cs.fontWeight >= 600, i: cs.fontStyle === 'italic', tam: +(e.closest('[data-tam]')?.dataset.tam || b.par.fuente?.size || 11), color: deCss(cs.color), ...(elegida ? { letra: elegida } : {}) });
      }
      return estilos.get(e);
    };
    const poner = (ch, st) => {
      const u = linea.tramos.at(-1);
      if (u && JSON.stringify(u.st) === JSON.stringify(st)) u.t += ch; else linea.tramos.push({ t: ch, st });
    };
    const caminar = document.createTreeWalker(b.el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let nodo = caminar.nextNode(); nodo; nodo = caminar.nextNode()) {
      // por si el navegador metió un <br> o un <div> al cortar: cuentan como Enter
      if (nodo.nodeType === 1) { if ((nodo.tagName === 'BR' || (nodo.tagName === 'DIV' && nodo.previousSibling)) && linea.tramos.length) { linea.duro = true; out.push(linea); linea = { tramos: [], duro: false }; arriba = null; } continue; }
      const t = nodo.textContent, st = estiloDe(nodo);
      for (let i = 0; i < t.length; i++) {
        const ch = t[i];
        if (ch === '\n') { linea.duro = true; out.push(linea); linea = { tramos: [], duro: false }; arriba = null; continue; }
        if (ch.trim()) {
          rango.setStart(nodo, i); rango.setEnd(nodo, i + 1);
          const rc = rango.getClientRects()[0];
          if (rc) { if (arriba != null && rc.top > arriba + rc.height * 0.5) { out.push(linea); linea = { tramos: [], duro: false }; } arriba = rc.top; }
        }
        poner(ch, st);
      }
    }
    linea.duro = true; out.push(linea);
    // espacios: sin dobles ni en las puntas de cada renglón
    return out.map(l => {
      let tr = l.tramos.map(x => ({ ...x, t: x.t.replace(/[^\S\t]+/g, ' ') }));
      tr = tr.filter(x => x.t);
      while (tr.length && !tr[0].t.trim()) tr.shift();
      if (tr.length) tr[0].t = tr[0].t.replace(/^ /, '');
      while (tr.length && !tr.at(-1).t.trim()) tr.pop();
      if (tr.length) tr.at(-1).t = tr.at(-1).t.replace(/ $/, '');
      for (let i = 1; i < tr.length; i++) if (tr[i - 1].t.endsWith(' ') && tr[i].t.startsWith(' ')) tr[i].t = tr[i].t.slice(1);
      return { tramos: tr.filter(x => x.t), duro: l.duro };
    }).filter((l, i, a) => l.tramos.length || (l.duro && i < a.length - 1));
  }
  // Palabras de un renglón con su estilo: [{ t, st, pegada }] (pegada = va junto a la anterior, sin espacio: cambio de estilo dentro de una palabra)
  palabras(l) {
    const out = [];
    let separado = true, tab = false, pendienteTab = false;
    for (const tr of l.tramos) {
      let buf = '';
      const cerrar = () => { if (buf) { out.push({ t: buf, st: tr.st, pegada: out.length > 0 && !separado, tab: pendienteTab }); separado = false; pendienteTab = false; buf = ''; } };
      for (const ch of tr.t) { if (ch === ' ') { cerrar(); separado = true; } else if (ch === '\t') { cerrar(); separado = true; tab = true; } else { if (!buf && tab) { pendienteTab = true; tab = false; } buf += ch; } }
      cerrar();
    }
    return out;
  }

  // ---------- Fuentes para escribir ----------
  async original(p, n, nombre) {
    const k = p.datos.byteLength + '|' + n + '|' + nombre;
    if (!this.orig.has(k)) this.orig.set(k, this.ctx.api.fuenteOriginal(p.datos, n, nombre).catch(() => null));
    return this.orig.get(k);
  }
  // Con qué se escribe un pedazo con ese estilo: la fuente del documento (si es ese estilo y trae las letras),
  // otra fuente del documento de la misma familia con ese estilo (negrita que ya existía), o la instalada parecida.
  async resolver(hoja, st, texto) {
    if (st.letra) return { fuente: await this.fuentes.paraEscribir(st.letra, st.b, st.i), css: await this.fuentes.css(st.letra, st.b, st.i), elegida: true }; // la que eligió en la barra
    if (hoja.escaneo) return { fuente: await this.fuentes.paraEscribir('sans', st.b, st.i), css: CSS_BASICA.sans, parecida: true };
    const p = hoja.p, cubre = info => info && [...texto].every(ch => !ch.trim() || ch in info.mapa);
    const propio = st.f && hoja.fuentesPagina.get(st.f);
    if (propio && propio.b === st.b && propio.i === st.i) { const info = await this.original(p, hoja.n, st.f); if (cubre(info)) return { orig: info }; }
    if (st.f) for (const [nombre, x] of hoja.fuentesPagina) if (x.b === st.b && x.i === st.i && baseFamilia(nombre) === baseFamilia(st.f)) {
      const info = await this.original(p, hoja.n, nombre); if (cubre(info)) return { orig: info };
    }
    await this.fuentes.cargar().catch(() => {});
    const fam = st.f && this.fuentes.parecida(st.f), clave = fam ? 'f:' + fam.familia : familiaDe(st.f);
    return { fuente: await this.fuentes.paraEscribir(clave, st.b, st.i), css: await this.fuentes.css(clave, st.b, st.i), parecida: true };
  }

  // ---------- Pasar un párrafo al PDF ----------
  async confirmar(hoja, b) {
    // si mientras tanto se unió o se borró algún párrafo, primero se saca ese del PDF (si no, el que lo absorbió
    // se escribiría encima de su texto viejo)
    for (const x of hoja.bloques) if (x !== b && !this.presente(x) && x.sucio) { x.sucio = false; await this.confirmar(hoja, x); }
    const p = hoja.p, n = hoja.n, par = b.par, L = par.lineas, [lim0, lim1] = this.limites(b);
    const borrado = !b.el.isConnected;
    const nuevas = borrado ? [] : this.lineas(b);
    const color = c => (c || [0, 0, 0]).map(v => Math.round(v * 20)).join('.');
    const firma = ws => ws.map((w, k) => (w.pegada ? '' : k && (w.tab || (w.x0 != null && ws[k - 1] && w.x0 - ws[k - 1].x1 > (w.tam || 11) * 0.6)) ? '\t' : ' ') + w.t + '|' + (w.st ? [w.st.f, w.st.b, w.st.i, w.st.tam, color(w.st.color), w.st.letra || ''] : [w.f, !!w.b, !!w.i, Math.round(w.tam * 10) / 10, color(w.color), '']).join(',')).join('');
    const pal = nuevas.map(l => this.palabras(l));
    const lead = par.interlineado, y0 = L[0].base[1] - b.dy;
    // lo que ya no entra en la hoja (pasó el margen de abajo) sigue en una hoja nueva, como un salto de página de Word
    let corte = -1;
    if (!borrado && !hoja.escaneo && !b.fijo && hoja.abajo != null)
      corte = pal.findIndex((_, i) => (L[i] && !b.dy ? L[i].base[1] : y0 - i * lead) < hoja.abajo - 0.5);
    const sobra = corte >= 0 ? { pal: pal.splice(corte), duro: nuevas.splice(corte).map(l => l.duro) } : null;
    // medir y escribir cada palabra con su fuente
    const lienzo = document.createElement('canvas').getContext('2d'), recursos = new Map();
    const fuenteDe = async (st, texto) => { const k = JSON.stringify(st); if (!recursos.has(k)) recursos.set(k, await this.resolver(hoja, st, texto)); return recursos.get(k); };
    // las letras de todo el párrafo con ese estilo, para saber si la fuente del documento las trae
    const porEstilo = new Map();
    for (const ws of pal) for (const w of ws) { const k = JSON.stringify(w.st); porEstilo.set(k, (porEstilo.get(k) || '') + w.t + ' '); }
    for (const ws of sobra?.pal || []) for (const w of ws) { const k = JSON.stringify(w.st); porEstilo.set(k, (porEstilo.get(k) || '') + w.t + ' '); }
    for (const [k, t] of porEstilo) await fuenteDe(JSON.parse(k), t);
    const ancho = (w, t = w.t) => {
      const r = recursos.get(JSON.stringify(w.st)), tam = w.st.tam;
      if (r.orig) return [...t].reduce((a, ch) => a + (ch in r.orig.mapa ? r.orig.anchos[r.orig.mapa[ch]] / 1000 * tam : tam * 0.25), 0);
      lienzo.font = `${w.st.i ? 'italic ' : ''}${w.st.b ? 700 : 400} ${tam}px ${r.css}`;
      return lienzo.measureText(t).width;
    };
    await document.fonts.ready;
    const borrar = [], escribir = [], originales = [], permitidas = [], lecturas = [], nuevasLineas = [], tapas = [];
    let parecida = false;
    const total = Math.max(pal.length, L.length);
    for (let i = 0; i < total; i++) {
      const orig = L[i], ws = pal[i], dura = nuevas[i]?.duro;
      if (orig && ws && !b.dy && !b.forzar && firma(ws) === firma(orig.palabras)) { nuevasLineas.push(orig); continue; } // igual: no se toca
      // escaneo: se tapa y se escribe solo el pedazo que cambió (lo de antes y lo de después sigue siendo la imagen)
      if (hoja.escaneo && orig && ws?.length && !b.forzar) {
        const ow = orig.palabras.map(x => x.t), nw = ws.map(x => x.t);
        let pre = 0, suf = 0;
        while (pre < ow.length && pre < nw.length && ow[pre] === nw[pre]) pre++;
        while (suf < ow.length - pre && suf < nw.length - pre && ow[ow.length - 1 - suf] === nw[nw.length - 1 - suf]) suf++;
        if (pre === ow.length && pre === nw.length) { nuevasLineas.push(orig); continue; }
        const esp = ancho(ws[0], ' '), medio = ws.slice(pre, nw.length - suf), x0 = pre < ow.length ? orig.palabras[pre].x0 : orig.palabras.at(-1).x1 + esp;
        const anchoMedio = medio.reduce((a, w, k) => a + ancho(w) + (k ? esp : 0), 0);
        const tope = suf ? orig.palabras[ow.length - suf].x0 - esp * 0.95 : lim1 + 1; // que quede un espacio entero antes de lo que sigue
        const cabe = x0 + anchoMedio <= tope;
        const va = cabe ? medio : ws.slice(pre), hasta = cabe ? (ow.length - suf - 1 >= pre ? orig.palabras[ow.length - suf - 1].x1 : x0) : orig.rect[2];
        if (hasta > x0) {
          const t = [x0 - 1, orig.rect[1] - 1.5, hasta + 1.5, orig.rect[3] + 1.5];
          borrar.push(this.tira(x0 - 0.5, hasta + 0.5, orig)); tapas.push(t); permitidas.push([t[0] - 1, t[1] - 1, t[2] + 1, t[3] + 1]);
        }
        let x = x0;
        const enLinea = [];
        va.forEach((w, k) => { if (k) x += esp; const r = recursos.get(JSON.stringify(w.st)); parecida = true;
          escribir.push({ n, x, y: orig.base[1], texto: w.t, fuente: r.fuente, negrita: w.st.b, cursiva: w.st.i, tam: w.st.tam, color: w.st.color });
          enLinea.push({ t: w.t, x0: x, x1: x + ancho(w), y: orig.base[1], pegada: false, f: null, b: w.st.b, i: w.st.i, tam: w.st.tam, color: w.st.color }); x += ancho(w); });
        permitidas.push([x0 - 2, orig.rect[1] - 2, Math.max(x, hasta) + 2, orig.rect[3] + 2]);
        lecturas.push({ x0: x0 - 0.5, x1: Math.max(x, hasta) + 0.5, b: orig.base[1], texto: va.map(w => w.t).join('') });
        const palabras = [...orig.palabras.slice(0, pre), ...enLinea, ...(cabe ? orig.palabras.slice(ow.length - suf) : [])];
        nuevasLineas.push({ ...orig, texto: palabras.map(w => w.t).join(' '), palabras });
        continue;
      }
      // alineado a la izquierda: las palabras del principio que no cambiaron quedan donde están
      let prefijo = 0, desde = orig ? orig.rect[0] : null;
      if (orig && ws && !b.dy && !b.forzar && par.alineacion === 'izq') {
        while (prefijo < ws.length && prefijo < orig.palabras.length && firma([ws[prefijo]]) === firma([orig.palabras[prefijo]])) prefijo++;
        if (prefijo > 0 && prefijo < orig.palabras.length) desde = orig.palabras[prefijo].x0 - 0.5;
        else if (prefijo >= orig.palabras.length) desde = orig.rect[2] + 0.5;
      }
      if (orig) { borrar.push(this.tira(desde, orig.rect[2], orig)); permitidas.push([desde - 1, orig.rect[1] - 1, orig.rect[2] + 1, orig.rect[3] + 1]); }
      // escaneo: lo que había en la imagen se tapa con el color del papel
      if (orig && hoja.escaneo) { const t = [desde - 1, orig.rect[1] - 1.5, orig.rect[2] + 1.5, orig.rect[3] + 1.5]; tapas.push(t); permitidas.push([t[0] - 1, t[1] - 1, t[2] + 1, t[3] + 1]); }
      if (!ws?.length) { if (orig) lecturas.push({ x0: desde - 0.5, x1: orig.rect[2] + 1, b: orig.base[1], texto: '' }); continue; }
      const base = orig && !b.dy ? orig.base[1] : y0 - i * lead;
      const resto = ws.slice(prefijo), anchos = resto.map(w => ancho(w)), espacio = w => ancho(w, ' ');
      const sang = i === 0 ? (par.sangria || 0) : 0;
      let x, hueco = null;
      const natural = resto.reduce((a, w, k) => a + anchos[k] + (k && !w.pegada ? espacio(w) : 0), 0);
      if (prefijo > 0) x = prefijo < orig.palabras.length ? orig.palabras[prefijo].x0 : orig.palabras.at(-1).x1 + espacio(resto[0]);
      else if (par.alineacion === 'der') x = lim1 - natural;
      else if (par.alineacion === 'centro') x = (lim0 + lim1) / 2 - natural / 2;
      else {
        x = lim0 + sang;
        const huecos = resto.filter((w, k) => k && !w.pegada && !w.tab).length;
        if (par.alineacion === 'just' && !dura && huecos) hueco = (lim1 - x - resto.reduce((a, w, k) => a + anchos[k], 0)) / huecos;
      }
      const x0 = x, enLinea = [];
      resto.forEach((w, k) => {
        if (k && w.tab) { const t = b.tab || 36; x = lim0 + Math.ceil((x - lim0 + 0.5) / t) * t; }
        else if (k && !w.pegada) x += hueco ?? espacio(w);
        const r = recursos.get(JSON.stringify(w.st));
        if (r.orig) originales.push({ x, y: base, hex: [...w.t].map(ch => r.orig.mapa[ch]).join(''), tam: w.st.tam, color: w.st.color, nombre: r.orig.nombre, fuente: { recurso: r.orig.recurso, num: r.orig.num } });
        else { parecida ||= true; escribir.push({ n, x, y: base, texto: w.t, fuente: r.fuente, negrita: w.st.b, cursiva: w.st.i, tam: w.st.tam, color: w.st.color }); }
        enLinea.push({ t: w.t, x0: x, x1: x + anchos[k], y: base, pegada: !!w.pegada, f: w.st.f, b: w.st.b, i: w.st.i, tam: w.st.tam, color: w.st.color });
        x += anchos[k];
      });
      const tam = Math.max(...resto.map(w => w.st.tam));
      permitidas.push([Math.min(lim0, x0) - 2, base - tam * 0.35, Math.max(lim1, x) + 2, base + tam * 1.05]);
      lecturas.push({ x0: prefijo > 0 ? desde - 0.5 : Math.min(lim0, x0) - 2, x1: Math.max(lim1, x, orig?.rect[2] || 0) + 2, b: base, texto: resto.map(w => w.t).join('') });
      if (orig && Math.abs(orig.base[1] - base) > 0.5) lecturas.push({ x0: desde - 0.5, x1: orig.rect[2] + 1, b: orig.base[1], texto: '' });
      const palabras = [...(prefijo ? orig.palabras.slice(0, prefijo) : []), ...enLinea];
      nuevasLineas.push({ texto: palabras.map((w, k) => (k && !w.pegada ? ' ' : '') + w.t).join(''), base: [palabras[0].x0, base], palabras,
        rect: [palabras[0].x0, base - tam * 0.25, palabras.at(-1).x1, base + tam * 0.8] });
    }
    if (sobra?.pal.some(ws => ws.length)) (hoja.desborde ||= []).push({ arriba: par.rect[3], salto: b.salto0 || lead * 1.5, lead, alineacion: par.alineacion, lim0, lim1, tab: b.tab, sangria: corte === 0 ? par.sangria || 0 : 0, inicio: corte === 0, ...sobra, recursos, ancho });
    if (!borrar.length && !escribir.length && !originales.length && !tapas.length) { b.dy = 0; return; }
    // lo que no es del párrafo pero toca lo que se borra (un dato escrito encima) se vuelve a escribir igual
    const enPar = l => { const cx = (l.rect[0] + l.rect[2]) / 2, cy = (l.rect[1] + l.rect[3]) / 2; return L.some(x => cx >= x.rect[0] - 1 && cx <= x.rect[2] + 1 && cy >= x.rect[1] - 1 && cy <= x.rect[3] + 1); };
    const LG = hoja.lugar, enD = o => ({ ...o, rect: LG.rectDePdf(o.rect) }); // lo del editor de renglones viene en puntos del PDF
    const toca = o => { const r = LG.rectDePdf(o.rect); return !enPar({ rect: r }) && borrar.some(z => r[0] < z[2] && r[2] > z[0] && r[1] < z[3] && r[3] > z[1]); };
    const rehacer = await Promise.all(hoja.cont.lineas.filter(toca).map(async o => {
      const fo = o.fuente || {}, fam = this.fuentes.parecida(fo.name);
      const rD = LG.rectDePdf(o.rect); permitidas.push([rD[0] - 1, rD[1] - 1, rD[2] + 1, rD[3] + 1]);
      return { n, x: o.base[0], y: o.base[1], texto: o.texto, fuente: fam ? await this.fuentes.paraEscribir('f:' + fam.familia, fo.weight === 'bold', fo.style === 'italic') : familiaDe(fo.name),
        negrita: fo.weight === 'bold', cursiva: fo.style === 'italic', tam: fo.size || 11, color: o.color || [0, 0, 0] };
    }));
    // reglas del usuario: un código o un texto protegido que estaba y ya no está igual se pregunta antes de escribir
    const perdidos = this.protegidos(L.map(l => l.texto).join('\n')).filter(t => ![...nuevasLineas.map(l => l.texto), ...(sobra?.pal || []).map(ws => ws.map(w => w.t).join(' '))].join(' ').replace(/\s+/g, ' ').includes(t));
    if (perdidos.length && !borrado) {
      const r = await this.ctx.dialogo?.({ titulo: 'Cambiaste algo protegido', texto: `Este párrafo tenía ${perdidos.map(t => `"${t}"`).join(', ')} y ya no está igual. ¿Lo dejo así? (Se cuida en Preferencias → Protección al editar.)`,
        botones: [{ t: 'No, lo corrijo', v: null }, { t: 'Dejarlo así', v: 'si', primario: true }] });
      if (r?.boton !== 'si') { b.sucio = true; this.ctx.aviso('Corregí el párrafo y hacé clic afuera para guardarlo (o Ctrl+Z).'); return; }
    }
    let dudoso = false, letraCambiada = false;
    const ok = await this.ctx.aplicar(async base => {
      // la fuente del documento se vuelve a buscar en estos bytes (al borrar, MuPDF la puede sacar de la página)
      const frescas = new Map();
      for (const nombre of new Set(originales.map(e => e.nombre))) {
        const info = await this.ctx.api.fuenteOriginal(base, n, [...hoja.fuentesPagina.keys()].find(k => sinPrefijo(k) === nombre) || nombre);
        if (!info) throw new Error('No se pudo usar la letra original del documento.');
        frescas.set(nombre, { recurso: info.recurso, num: info.num });
      }
      // de "hoja derecha" a puntos del PDF (en una hoja girada, el texto va con su giro)
      const aP = e => { const [x, y] = LG.aPdf(e.x, e.y); return { ...e, x, y, giro: LG.giro }; };
      let bytes = await this.ctx.api.borrarZona(base, n, borrar.map(r => LG.rectAPdf(r)), { texto: true });
      if (originales.length) bytes = await this.ctx.api.escribirOriginal(bytes, n, null, originales.map(e => ({ ...aP(e), fuente: frescas.get(e.nombre) })));
      const tapar = tapas.map(t => ({ n, tapar: LG.rectAPdf(t), fondo: b.fondo || [1, 1, 1], texto: '', fuente: 'sans', tam: 1, color: [0, 0, 0] }));
      const nuevo = escribir.length || rehacer.length || tapar.length ? await ops.escribirTexto(bytes, [...tapar, ...escribir.map(aP), ...rehacer.map(e => ({ ...e, giro: LG.giro }))]) : bytes;
      letraCambiada = !!nuevo.cambioLetra;
      // control: renglón por renglón tiene que haber quedado justo lo escrito, y el resto de la hoja igual
      const enBanda = (x, y) => lecturas.some(z => x >= z.x0 && x <= z.x1 && Math.abs(y - z.b) < (par.fuente?.size || 11) * 0.45);
      const letras = t => [...String(t).normalize('NFC').replace(/\s+/g, '')].sort().join('');
      const esperado = letras([...lecturas.map(z => z.texto), ...rehacer.filter(o => enBanda(...LG.dePdf(o.x + 1, o.y))).map(o => o.texto)].join(''));
      const leido = await this.ctx.api.paginaParrafos(nuevo, n).then(r => letras(r.parrafos.flatMap(x => x.lineas)
        .flatMap(l => l.palabras.filter(w => enBanda((w.x0 + w.x1) / 2, w.y ?? l.base[1])).map(w => w.t)).join(''))).catch(() => null);
      const control = await this.ctx.api.compararPaginas(base, nuevo, n, permitidas.map(r => LG.rectAPdf(r))).catch(() => null);
      // en un escaneo alcanza con que esté todo lo nuevo (el texto reconocido es invisible y se pega al nuevo al leerlo)
      const contiene = (grande, chico) => { const c = new Map(); for (const ch of grande) c.set(ch, (c.get(ch) || 0) + 1); for (const ch of chico) { if (!c.get(ch)) return false; c.set(ch, c.get(ch) - 1); } return true; };
      const mal = leido != null && (hoja.escaneo ? !contiene(leido, esperado) : leido !== esperado);
      if (window.pdfproPrueba && (mal || control?.fuera > 40)) console.error('CONTROL esperado=' + esperado + ' leido=' + leido + ' fuera=' + control?.fuera);
      if (mal || control?.fuera > 40) {
        dudoso = true;
        const r = await this.ctx.dialogo?.({ titulo: 'Revisá este párrafo', texto: mal
          ? 'Al pasar el párrafo al PDF, lo que quedó no es exactamente lo que escribiste (puede haber quedado algo del texto anterior). ¿Lo dejo así? (Después se puede deshacer con Ctrl+Z.)'
          : 'Al pasar el párrafo al PDF, también cambió algo fuera de él en la hoja. ¿Lo dejo así? (Después se puede deshacer con Ctrl+Z.)',
          botones: [{ t: 'No, dejarlo como estaba', v: null }, { t: 'Dejarlo así', v: 'si', primario: true }] });
        if (r?.boton !== 'si') throw Object.assign(new Error('cancelado'), { cancelado: true });
      }
      return nuevo;
    }, { mensaje: borrado ? 'Párrafo borrado' : 'Texto editado', sinRecargar: true });
    if (!ok) { b.sucio = true; return; } // queda pendiente (se vuelve a intentar al salir del párrafo)
    hoja.cambios = (hoja.cambios || 0) + 1;
    this.orig.clear(); // los bytes cambiaron: las fuentes se vuelven a leer
    if (!borrado && !nuevasLineas.length) { b.el.remove(); hoja.bloques = hoja.bloques.filter(x => x !== b); return; } // pasó entero a la hoja nueva
    if (!borrado) { b.par.limites = [lim0, lim1]; if (b.ampliado) { b.par.ampliable = null; b.ampliado = false; } b.par.lineas = nuevasLineas; b.par.rect = [lim0, Math.min(...nuevasLineas.map(l => l.rect[1])), lim1, Math.max(...nuevasLineas.map(l => l.rect[3]))]; }
    b.dy = 0;
    if (borrado) hoja.bloques = hoja.bloques.filter(x => x !== b);
    else { this.ubicar(hoja, b); b.n0 = nuevasLineas.length; b.crece = 0; b.forzar = false; b.editado = false; } // lo escrito pasa a ser la nueva base
    this.ctx.aviso(letraCambiada ? 'Guardado en el PDF. Ojo: alguna letra no estaba en la fuente y se escribió con una básica.'
      : dudoso ? 'Guardado en el PDF (lo revisaste vos).' : parecida && ![...recursos.values()].some(r => r.elegida) ? 'Guardado en el PDF con una letra parecida a la del documento. Controlado.' : 'Guardado en el PDF con la letra del documento. Controlado: el resto de la hoja quedó igual.', letraCambiada);
  }
}
