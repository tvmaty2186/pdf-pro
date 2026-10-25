// PDF.Pro — editar el texto y las imágenes que ya vienen en el PDF.
// MuPDF (main.js) dice qué renglones e imágenes hay en cada página; al cambiar un renglón se borra el original
// y se escribe el nuevo en el mismo lugar con una letra parecida (`escribirTexto`). En escaneos con texto reconocido
// además se tapa lo de abajo con el color del papel, para que no se note.
import * as ops from './paginas.js';
import { COLORES } from './comentarios.js';
import { Fuentes } from './fuentes.js';
import { ModoWord } from './word.js';
import { Lugar } from './lugar.js';

const limitar = (v, a, b) => Math.max(a, Math.min(b, v));
// Familia de letra según el nombre de la fuente original (lo que dice MuPDF a veces no acierta)
function familia(f = {}) {
  const n = String(f.name || '');
  if (/courier|mono|consol/i.test(n) || f.family === 'monospace') return 'mono';
  if (/times|georgia|garamond|cambria|palatino|bookman|serif(?!.*sans)/i.test(n) && !/sans/i.test(n)) return 'serif';
  if (/arial|helvetica|sans|calibri|verdana|tahoma|syntax|myriad|frutiger|segoe|roboto|futura|gill/i.test(n)) return 'sans';
  return f.family === 'serif' ? 'serif' : 'sans';
}
const aHex = c => '#' + c.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
const deHex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);

// Colores de la tinta y del papel en ese rectángulo, mirando la página ya dibujada
function colores(pg, r) {
  const lienzo = pg.div.querySelector('canvas');
  const v = pg.vista, f = lienzo.width / v.width, [a, b, c, d] = v.convertToViewportRectangle(r);
  const x0 = Math.floor(Math.min(a, c) * f) - 3, y0 = Math.floor(Math.min(b, d) * f) - 3;
  const w = Math.ceil(Math.abs(c - a) * f) + 6, h = Math.ceil(Math.abs(d - b) * f) + 6;
  const px = lienzo.getContext('2d', { willReadFrequently: true }).getImageData(Math.max(0, x0), Math.max(0, y0), Math.max(1, Math.min(w, lienzo.width - x0)), Math.max(1, Math.min(h, lienzo.height - y0))).data;
  const lum = i => 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2], todos = [];
  for (let i = 0; i < px.length; i += 4) todos.push(i);
  todos.sort((i, j) => lum(i) - lum(j));
  const prom = lista => [0, 1, 2].map(k => lista.reduce((s, i) => s + px[i + k], 0) / Math.max(1, lista.length) / 255);
  const fondo = prom(todos.slice(Math.floor(todos.length * 0.6)));   // lo más claro: el papel
  const tinta = prom(todos.slice(0, Math.max(1, Math.floor(todos.length * 0.06)))); // lo más oscuro: la letra
  const contraste = (fondo[0] + fondo[1] + fondo[2] - tinta[0] - tinta[1] - tinta[2]) / 3;
  return { fondo, tinta: contraste > 0.25 ? tinta : [0, 0, 0] };
}

export class Edicion {
  // ctx: { el, aviso, api, icono, pestana(), aplicar(fn, opciones), error, alCambiar(), firmas }
  constructor(ctx) { this.ctx = ctx; this.activo = false; this.cache = new Map(); this.fuentes = ctx.fuentes || new Fuentes(ctx.api); this.word = new ModoWord(this, colores); }
  get p() { return this.ctx.pestana(); }

  activar() {
    const v = this.p?.visor;
    if (!v?.doc) return;
    if (this.activo) return this.terminar();
    this.activo = true;
    this.cerrarEditor();
    this.mostrarBarra();
    this.redibujar();
    this.ctx.alCambiar?.();
    this.ctx.aviso('Escribí directo sobre el texto, como en Word. Lo que cambies se pasa solo al PDF. Esc para terminar.');
  }
  // Salir de Editar: primero se pasa al PDF lo que falte y después se vuelve a dibujar el documento
  async terminar() {
    if (!this.activo) return;
    const p = this.p;
    this.activo = false;
    this.cerrarEditor(); this.mostrarBarra(); this.redibujar(); this.ctx.alCambiar?.();
    const hubo = await this.word.cerrar();
    if (hubo || p?.recargarPendiente) await this.ctx.recargar?.(p);
  }
  // Abre el editor sobre el renglón que está en (x, y) de la vista de la página (para "Editar" del menú del texto pintado)
  // Vuelve a armar el modo documento (por ejemplo, después de agregar una hoja) y muestra esa página
  async reabrir(pagina) {
    if (!this.activo) return;
    const p = this.p;
    this.cerrarEditor();
    await this.word.cerrar();
    if (p) await this.ctx.recargar?.(p, pagina);
    this.redibujar();
    if (pagina) setTimeout(() => p?.visor?.irAPagina?.(pagina), 400);
  }
  async editarEn(p, pg, x, y) {
    if (!this.activo) this.activar();
    const c = await this.contenido(p, pg.n), [px, py] = pg.vista.convertToPdfPoint(x, y);
    const dentro = r => px >= Math.min(r[0], r[2]) - 1 && px <= Math.max(r[0], r[2]) + 1 && py >= Math.min(r[1], r[3]) - 1 && py <= Math.max(r[1], r[3]) + 1;
    const l = c.lineas.find(l => dentro(l.rect));
    if (l) this.editar(p, pg, l, c.ocr, c.lineas);
  }
  mostrarBarra() {
    const { el } = this.ctx, v = this.p?.visor;
    document.querySelector('.barra-herramienta.edicion')?.remove();
    document.querySelectorAll('.documento').forEach(d => { if (d.dataset.herramienta === 'editar') d.dataset.herramienta = ''; });
    if (!this.activo || !v) return;
    v.el.dataset.herramienta = 'editar';
    document.querySelector('#area').append(el('div', { class: 'barra-herramienta edicion' }, el('b', {}, 'Editar'),
      this.word.controles(), el('button', { class: 'btn-texto boton-secundario', onclick: () => this.terminar() }, 'Listo (Esc)')));
  }
  redibujar() { const p = this.p; p?.visor?.paginas.forEach(pg => pg.vista && this.dibujarPagina(p, pg)); }

  async contenido(p, n) {
    const clave = n;
    if (this.cache.datos !== p.datos) { this.cache = new Map(); this.cache.datos = p.datos; }
    if (!this.cache.has(clave)) this.cache.set(clave, this.ctx.api.paginaContenido(p.datos, n).catch(e => { this.cache.delete(clave); throw e; })); // si falla, se puede reintentar
    return this.cache.get(clave);
  }
  async parrafos(p, n) {
    if (this.cache.datos !== p.datos) { this.cache = new Map(); this.cache.datos = p.datos; }
    const clave = 'par' + n;
    if (!this.cache.has(clave)) this.cache.set(clave, this.ctx.api.paginaParrafos(p.datos, n).catch(e => { this.cache.delete(clave); throw e; }));
    return this.cache.get(clave);
  }
  // Recuadros sobre cada párrafo, renglón suelto e imagen (solo con la herramienta activa)
  async dibujarPagina(p, pg) {
    pg.div.querySelectorAll('.ed-caja').forEach(x => x.remove());
    if (!this.activo || !pg.vista) return;
    let c, pars, lugar;
    try { [c, { parrafos: pars, lugar }] = await Promise.all([this.contenido(p, pg.n), this.parrafos(p, pg.n).catch(() => ({ parrafos: [] }))]); } catch (e) { return console.error(e); }
    lugar = new Lugar(lugar); // los párrafos vienen en "hoja derecha" (src/lugar.js)
    if (!this.activo || !pg.vista) return;
    pg.div.querySelectorAll('.ed-caja').forEach(x => x.remove());
    const { el } = this.ctx, v = pg.vista;
    const caja = (r, clase, titulo, accion) => {
      const [a, b, cc, d] = v.convertToViewportRectangle(r);
      const e = el('div', { class: 'ed-caja ' + clase, title: titulo, style: `left:${Math.min(a, cc) / v.width * 100}%;top:${Math.min(b, d) / v.height * 100}%;` +
        `width:${Math.abs(cc - a) / v.width * 100}%;height:${Math.abs(d - b) / v.height * 100}%` });
      e.addEventListener('pointerdown', ev => { if (ev.button === 0) { ev.preventDefault(); ev.stopPropagation(); accion(ev); } });
      pg.div.append(e);
    };
    const hayFondo = c.imagenes.some(x => x.entera);
    for (const im of c.imagenes) if (!im.entera) caja(im.rect, 'imagen', 'Imagen: clic para moverla, cambiarla o borrarla', () => this.menuImagen(p, pg, { ...im, metodo: hayFondo ? 'pixeles' : 'quitar' }));
    // modo documento: los párrafos se escriben directo sobre la hoja (src/word.js); lo que no es párrafo (texto girado,
    // escaneos) sigue con el editor de a renglón
    const conWord = await this.word.armar(p, pg, c, pars, lugar).catch(e => { console.error('Modo documento', e); return false; });
    if (!this.activo) return;
    // el editor viejo de párrafos trabaja en puntos del PDF: solo sirve en hojas sin girar ni recortar
    const editables = (c.ocr || !lugar.identidad) && !conWord ? [] : pars.filter(x => x.reflow);
    const centro = r => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2], dentro = (pt, r) => pt[0] >= r[0] - 1 && pt[0] <= r[2] + 1 && pt[1] >= r[1] - 1 && pt[1] <= r[3] + 1;
    for (const l of c.lineas) if (!editables.some(x => x.lineas.some(y => dentro(centro(l.rect), lugar.rectAPdf(y.rect))))) caja(l.rect, 'texto', 'Clic para cambiar este texto', () => this.editar(p, pg, l, c.ocr, c.lineas));
    if (!conWord) for (const x of editables) caja([x.rect[0] - 1, x.rect[1] - 1, x.rect[2] + 1, x.rect[3] + 1], 'texto parrafo', 'Clic para editar este párrafo', ev => this.editarParrafo(p, pg, x, c, pars, ev && { x: ev.clientX, y: ev.clientY }));
  }

  // ---------- Texto ----------
  cerrarEditor() { document.querySelectorAll('.ed-editor, .ed-barra, .ed-parrafo, .ed-imagen-elegida').forEach(x => x.remove()); this.editando = null; }
  editar(p, pg, l, ocr, todas = []) {
    this.cerrarEditor();
    const { el } = this.ctx, v = pg.vista;
    const col = colores(pg, l.rect);
    const est = { fuente: familia(l.fuente), negrita: l.fuente?.weight === 'bold', cursiva: l.fuente?.style === 'italic',
      tam: Math.round((l.fuente?.size || 11) * 10) / 10, color: !ocr && l.color ? l.color : col.tinta, tapar: ocr, fondo: col.fondo };
    const [a, b, c, d] = v.convertToViewportRectangle(l.rect);
    const x = Math.min(a, c), y = Math.min(b, d), w = Math.abs(c - a), h = Math.abs(d - b);
    const campo = el('input', { class: 'ed-editor', type: 'text', spellcheck: 'true',
      style: `left:${x / v.width * 100}%;top:${y / v.height * 100}%;min-width:${w / v.width * 100}%;height:${h / v.height * 100}%` });
    campo.value = l.texto;
    const estilo = () => { this.fuentes.css(est.fuente, est.negrita, est.cursiva).then(ff => { campo.style.fontFamily = ff; }); Object.assign(campo.style, { fontWeight: est.negrita ? 700 : 400, fontStyle: est.cursiva ? 'italic' : 'normal',
      fontSize: est.tam * v.scale + 'px', color: aHex(est.color), background: aHex(est.fondo) }); };
    const ajustarAncho = () => { campo.style.width = Math.max(w, (campo.scrollWidth || 0)) + 'px'; };
    const boton = (t, titulo, f, activo) => el('button', { class: 'btn-icono', title: titulo, 'aria-pressed': activo == null ? false : String(activo), onclick: () => { f(); dibujarBarra(); estilo(); campo.focus(); } }, t);
    const barra = el('div', { class: 'ed-barra', style: `left:${x / v.width * 100}%;top:${(y + h) / v.height * 100}%` });
    // Letra: las del documento, "Mis fuentes", las básicas y todas las instaladas en Windows
    const letra = el('select', { class: 'campo ed-letra', title: 'Letra' }, el('option', { value: est.fuente }, 'Cargando letras…'));
    const llenarLetras = async () => {
      letra.replaceChildren(...await this.fuentes.opciones(el, p, est.fuente));
      if (est.orig) letra.prepend(el('option', { value: 'orig' }, `${est.orig.nombre} (la del documento)`));
      letra.value = est.fuente;
    };
    letra.addEventListener('pointerdown', e => e.stopPropagation());
    letra.addEventListener('keydown', e => e.stopPropagation());
    letra.onchange = async () => {
      const v = letra.value;
      if (v === 'agregar') {
        const r = await this.ctx.api.fuenteAgregarArchivo();
        if (r.n) { await this.fuentes.cargar(true); this.ctx.aviso(r.n === 1 ? 'Fuente agregada a Mis fuentes.' : `${r.n} fuentes agregadas a Mis fuentes.`); }
      } else if (v.startsWith('doc:')) {
        const nombre = v.slice(4), r = await this.ctx.api.fuenteCopiarDelPdf(p.datos, nombre);
        if (r.error) this.ctx.aviso(r.error, true);
        else {
          await this.fuentes.cargar(true);
          const fam = this.fuentes.parecida(nombre) || this.fuentes.lista.find(f => f.variantes.some(x => x.ruta.includes(nombre.replace(/[^\w.-]+/g, '_'))));
          if (fam) est.fuente = 'f:' + fam.familia;
          this.ctx.aviso(r.recortada ? `“${nombre}” quedó en Mis fuentes. Ojo: el documento trae solo las letras que usa; si escribís una que no está, va con una letra básica.` : `“${nombre}” quedó en Mis fuentes.`);
        }
      } else est.fuente = v;
      await llenarLetras(); estilo(); campo.focus();
    };
    const dibujarBarra = () => barra.replaceChildren(
      letra,
      boton('N', 'Negrita', () => { est.negrita = !est.negrita; }, est.negrita), boton('K', 'Cursiva', () => { est.cursiva = !est.cursiva; }, est.cursiva),
      boton('A−', 'Más chica', () => { est.tam = Math.max(4, Math.round((est.tam - 0.5) * 10) / 10); }), el('span', { class: 'sutil' }, est.tam + ' pt'),
      boton('A+', 'Más grande', () => { est.tam = Math.min(96, Math.round((est.tam + 0.5) * 10) / 10); }),
      el('input', { type: 'color', value: aHex(est.color), title: 'Color de la letra', oninput: e => { est.color = deHex(e.target.value); estilo(); } }),
      el('label', { class: 'casilla', title: 'Pinta el fondo con el color del papel para tapar lo que había (para escaneos)' },
        el('input', { type: 'checkbox', checked: est.tapar, onchange: e => { est.tapar = e.target.checked; } }), 'Tapar fondo'),
      el('button', { class: 'btn-texto boton-secundario', onclick: () => this.cerrarEditor() }, 'Cancelar'),
      el('button', { class: 'btn-primario', onclick: () => this.guardarTexto(p, pg, l, campo.value, est, todas, ocr) }, 'Aplicar'));
    dibujarBarra(); estilo();
    // si la letra original está instalada (o en Mis fuentes), se usa esa
    this.fuentes.cargar().then(() => { const fam = this.fuentes.parecida(l.fuente?.name); if (fam) est.fuente = 'f:' + fam.familia; return llenarLetras(); }).then(estilo).catch(e => console.error(e));
    for (const e of [campo, barra]) e.addEventListener('pointerdown', ev => ev.stopPropagation());
    campo.addEventListener('input', ajustarAncho);
    campo.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); this.guardarTexto(p, pg, l, campo.value, est, todas, ocr); }
      if (e.key === 'Escape') { e.preventDefault(); this.cerrarEditor(); }
    });
    pg.div.append(campo, barra);
    this.editando = { campo };
    setTimeout(() => { ajustarAncho(); campo.focus(); campo.select(); }, 0);
  }
  async guardarTexto(p, pg, l, texto, est, todas = [], ocr = false) {
    this.cerrarEditor();
    if (texto === l.texto && !est.tapar) return;
    const r = l.rect, alto = r[3] - r[1];
    // se borra una franja del renglón; MuPDF borra todo lo que la toca, así que lo que estaba encima (por ejemplo
    // un dato escrito sobre la línea) se vuelve a escribir igual en su lugar
    const zona = [r[0] + 0.3, r[1] + alto * 0.35, r[2] - 0.3, r[3] - alto * 0.35];
    const toca = o => o !== l && o.rect[0] < zona[2] && o.rect[2] > zona[0] && o.rect[1] < zona[3] && o.rect[3] > zona[1];
    await this.fuentes.cargar().catch(() => {});
    const rehacer = await Promise.all(todas.filter(toca).map(async o => { const f = o.fuente || {}, col = colores(pg, o.rect), fam = !ocr && this.fuentes.parecida(f.name);
      const negrita = f.weight === 'bold', cursiva = f.style === 'italic';
      return { n: pg.n, x: o.base[0], y: o.base[1], texto: o.texto, fuente: fam ? await this.fuentes.paraEscribir('f:' + fam.familia, negrita, cursiva) : familia(f), negrita, cursiva, tam: f.size || 11, color: o.color || col.tinta, invisible: ocr, ancho: o.rect[2] - o.rect[0] }; }));
    const tapar = est.tapar ? [r[0] - 1, r[1] - 1, r[2] + 1, r[3] + 1] : null;
    const fuente = await this.fuentes.paraEscribir(est.fuente, est.negrita, est.cursiva);
    const nuevo = { n: pg.n, x: l.base[0], y: l.base[1], texto, fuente, negrita: est.negrita, cursiva: est.cursiva, tam: est.tam, color: est.color, tapar, fondo: est.fondo };
    await this.ctx.aplicar(async base => ops.escribirTexto(await this.ctx.api.borrarZona(base, pg.n, [zona], { texto: true }), [nuevo, ...rehacer]),
      { mensaje: texto.trim() ? 'Texto cambiado (Ctrl+Z para deshacer)' : 'Texto borrado (Ctrl+Z para deshacer)' });
  }

  // ---------- Párrafos, como en Word ----------
  // Se edita el párrafo entero en su lugar: misma letra, tamaño, color, alineación e interlineado; el texto baja solo de
  // renglón y Enter hace un renglón nuevo. Al aplicar se toca solo lo que cambió y se controla que el resto de la hoja
  // quede igual (`aplicarParrafo`).
  editarParrafo(p, pg, par, cont, todos, clic = null) {
    this.cerrarEditor();
    const { el } = this.ctx, v = pg.vista, f = par.fuente || {};
    const col = colores(pg, par.rect);
    const est = { fuente: familia(f), respaldo: familia(f), negrita: f.weight === 'bold', cursiva: f.style === 'italic', tam: Math.round((f.size || 11) * 10) / 10,
      color: par.color || col.tinta, fondo: col.fondo, alineacion: par.alineacion, interlineado: par.interlineado, orig: null };
    // con 'orig' se escribe con la fuente que trae el PDF (se ve idéntico); para mostrar en el editor se usa la parecida
    const cssDe = () => this.fuentes.css(est.fuente === 'orig' ? est.respaldo : est.fuente, est.negrita, est.cursiva);
    const faltan = () => est.orig ? [...new Set([...ed.textContent].filter(ch => ch.trim() && !(ch in est.orig.mapa)))].join('') : '';
    const [lim0, lim1] = par.limites, L = par.lineas;
    // texto inicial: los renglones se juntan con espacio (o sin el guion de corte); un renglón corto en el medio es un Enter
    let texto = L[0].texto;
    for (let i = 1; i < L.length; i++) {
      const ant = L[i - 1];
      if (/[a-záéíóúñ]-$/i.test(ant.texto) && /^[a-záéíóúñ]/.test(L[i].texto)) texto = texto.slice(0, -1) + L[i].texto;
      else texto += (par.alineacion !== 'just' && ant.rect[2] < lim1 - est.tam * 4 ? '\n' : ' ') + L[i].texto;
    }
    const ed = el('div', { class: 'ed-parrafo', contenteditable: 'plaintext-only', spellcheck: 'true' });
    ed.textContent = texto;
    const aviso = el('span', { class: 'ed-aviso sutil' });
    const ubicar = () => {
      const s = v.scale, F = est.tam * s, LH = est.interlineado * s;
      const [x0] = v.convertToViewportPoint(lim0, 0), [x1] = v.convertToViewportPoint(lim1, 0), [, yb] = v.convertToViewportPoint(0, L[0].base[1]);
      Object.assign(ed.style, { left: Math.min(x0, x1) + 'px', top: (yb - LH / 2 - 0.33 * F) + 'px', width: Math.abs(x1 - x0) + 'px', fontSize: F + 'px', lineHeight: LH + 'px',
        textAlign: { izq: 'left', der: 'right', centro: 'center', just: 'justify' }[est.alineacion], textIndent: (par.sangria || 0) * s + 'px',
        color: aHex(est.color), background: aHex(est.fondo), fontWeight: est.negrita ? 700 : 400, fontStyle: est.cursiva ? 'italic' : 'normal' });
      cssDe().then(ff => { ed.style.fontFamily = ff; revisar(); });
    };
    // lo que hay abajo: si el párrafo crece y llega, se avisa
    const obstaculos = [...todos.filter(x => x !== par).map(x => x.rect), ...cont.imagenes.filter(i => !i.entera).map(i => i.rect)]
      .filter(r => r[3] <= par.rect[1] + 1 && r[0] < lim1 && r[2] > lim0);
    const techo = obstaculos.length ? Math.max(...obstaculos.map(r => r[3])) : 20;
    const revisar = () => {
      const n = this.lineasVisuales(ed, est).length, fondo = L[0].base[1] - (n - 1) * est.interlineado - est.tam * 0.25;
      const pisa = fondo < techo + est.tam * 0.35; // también si queda pegado a lo de abajo
      aviso.textContent = n === L.length ? '' : `${n} ${n === 1 ? 'renglón' : 'renglones'} (antes ${L.length})` + (pisa ? ' · queda encima o pegado a lo de abajo' : '');
      aviso.classList.toggle('peligro', pisa); ed.classList.toggle('pisa', pisa);
      entrar.hidden = !pisa;
      const sinLetra = est.fuente === 'orig' ? faltan() : '';
      nota.textContent = sinLetra ? `La letra original del documento no trae “${sinLetra}”: al aplicar se usa una parecida para este párrafo.` : est.notaLetra || '';
      nota.classList.toggle('peligro', !!sinLetra);
    };
    // si no entra: se achica un poco la letra (y el interlineado) hasta que entre, sin bajar de 3/4 del tamaño original
    const entrar = el('button', { class: 'btn-texto', hidden: true, title: 'Achica un poco la letra para que el párrafo entre en su lugar', onclick: async () => {
      const minimo = est.tam * 0.75;
      while (est.tam > minimo) {
        const t = Math.round((est.tam - 0.1) * 10) / 10; est.interlineado *= t / est.tam; est.tam = t; ubicar();
        await new Promise(r => requestAnimationFrame(r));
        const n = this.lineasVisuales(ed).length;
        if (L[0].base[1] - (n - 1) * est.interlineado - est.tam * 0.25 >= techo + est.tam * 0.35) break;
      }
      dibujarBarra(); revisar(); ed.focus();
    } }, 'Hacer que entre');
    const boton = (t, titulo, fn, activo) => el('button', { class: 'btn-icono', title: titulo, 'aria-pressed': activo == null ? false : String(activo), onclick: () => { fn(); dibujarBarra(); ubicar(); ed.focus(); } }, t);
    const letra = el('select', { class: 'campo ed-letra', title: 'Letra' }, el('option', { value: est.fuente }, 'Cargando letras…'));
    const llenarLetras = async () => {
      letra.replaceChildren(...await this.fuentes.opciones(el, p, est.fuente));
      if (est.orig) letra.prepend(el('option', { value: 'orig' }, `${est.orig.nombre} (la del documento)`));
      letra.value = est.fuente;
    };
    for (const ev of ['pointerdown', 'keydown']) letra.addEventListener(ev, e => e.stopPropagation());
    letra.onchange = async () => { if (letra.value !== 'agregar' && !letra.value.startsWith('doc:')) est.fuente = letra.value; await llenarLetras(); ubicar(); ed.focus(); };
    const nota = el('span', { class: 'sutil ed-nota' });
    const barra = el('div', { class: 'ed-barra' });
    const dibujarBarra = () => barra.replaceChildren(
      letra,
      // la fuente del documento viene en un solo estilo: si se pide negrita o cursiva, se pasa a la parecida
      boton('N', 'Negrita', () => { est.negrita = !est.negrita; if (est.fuente === 'orig') est.fuente = est.respaldo; }, est.negrita),
      boton('K', 'Cursiva', () => { est.cursiva = !est.cursiva; if (est.fuente === 'orig') est.fuente = est.respaldo; }, est.cursiva),
      boton('A−', 'Más chica', () => { est.tam = Math.max(4, Math.round((est.tam - 0.5) * 10) / 10); est.interlineado *= (est.tam) / (est.tam + 0.5); }),
      el('span', { class: 'sutil' }, est.tam + ' pt'),
      boton('A+', 'Más grande', () => { est.tam = Math.min(96, Math.round((est.tam + 0.5) * 10) / 10); est.interlineado *= est.tam / (est.tam - 0.5); }),
      el('input', { type: 'color', value: aHex(est.color), title: 'Color de la letra', oninput: e => { est.color = deHex(e.target.value); est.colorCambiado = true; ubicar(); } }),
      el('div', { class: 'segmentos-botones' }, ...[['izq', 'Izq.', 'Alinear a la izquierda'], ['centro', 'Centro', 'Centrar'], ['der', 'Der.', 'Alinear a la derecha'], ['just', 'Just.', 'Justificar']]
        .map(([a, t, ti]) => boton(t, ti, () => { est.alineacion = a; }, est.alineacion === a))),
      aviso, entrar, nota,
      el('button', { class: 'btn-texto boton-secundario', onclick: () => this.cerrarEditor() }, 'Cancelar'),
      el('button', { class: 'btn-primario', title: 'Ctrl+Enter', onclick: () => this.aplicarParrafo(p, pg, par, ed, est, cont, todos) }, 'Aplicar'));
    // la barra va debajo del párrafo (o arriba si no entra)
    const ubicarBarra = () => { const r = ed.getBoundingClientRect(), R = pg.div.getBoundingClientRect(); barra.style.left = (r.left - R.left) + 'px'; barra.style.top = (r.bottom - R.top + 6) + 'px'; };
    dibujarBarra(); ubicar();
    Promise.all([this.fuentes.cargar(), this.ctx.api.fuenteOriginal(p.datos, pg.n, f.name).catch(() => null)]).then(([, orig]) => {
      const fam = this.fuentes.parecida(f.name);
      if (fam) est.respaldo = est.fuente = 'f:' + fam.familia;
      // si la fuente del documento trae las letras, se escribe con ella (idéntico al original)
      if (orig && Object.keys(orig.mapa).length > 3) { est.orig = orig; est.fuente = 'orig'; }
      else if (!fam) est.notaLetra = `Letra parecida: la original (${String(f.name || '').replace(/^[A-Z]{6}\+/, '')}) no está en esta computadora.`;
      return llenarLetras();
    }).then(() => { ubicar(); dibujarBarra(); revisar(); }).catch(e => console.error(e));
    for (const e of [ed, barra]) e.addEventListener('pointerdown', ev => ev.stopPropagation());
    ed.addEventListener('input', () => { revisar(); ubicarBarra(); });
    ed.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.aplicarParrafo(p, pg, par, ed, est, cont, todos); }
      if (e.key === 'Escape') { e.preventDefault(); this.cerrarEditor(); }
    });
    ed.classList.add('ed-editor-parrafo'); barra.classList.add('ed-barra-parrafo');
    pg.div.append(ed, barra);
    this.editando = { campo: ed };
    // el cursor queda donde se hizo clic (como en Word); si no se puede, al final
    const ponerCursor = () => {
      ed.focus();
      let r = clic && document.caretRangeFromPoint?.(clic.x, clic.y);
      if (!r || !ed.contains(r.startContainer)) { r = document.createRange(); r.selectNodeContents(ed); r.collapse(false); }
      getSelection().removeAllRanges(); getSelection().addRange(r);
    };
    setTimeout(() => { ubicarBarra(); revisar(); ponerCursor(); }, 0);
    document.fonts.ready.then(() => setTimeout(() => { if (this.editando?.campo === ed && clic) ponerCursor(); }, 120));
  }
  // Los renglones tal como quedaron en el editor (lo que se ve es lo que se escribe): [{ texto, duro }]
  // duro = termina por Enter o es el último (no se justifica)
  lineasVisuales(ed) {
    const nodo = ed.firstChild, t = ed.textContent;
    if (!nodo || !t) return [];
    const r = document.createRange(), lineas = [];
    let actual = '', arriba = null;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (ch === '\n') { lineas.push({ texto: actual, duro: true }); actual = ''; arriba = null; continue; }
      r.setStart(nodo, i); r.setEnd(nodo, i + 1);
      const rc = r.getClientRects()[0];
      if (rc && ch.trim()) {
        if (arriba != null && rc.top > arriba + rc.height * 0.5) { lineas.push({ texto: actual, duro: false }); actual = ''; }
        arriba = rc.top;
      }
      actual += ch;
    }
    lineas.push({ texto: actual, duro: true });
    return lineas.map(l => ({ ...l, texto: l.texto.replace(/\s+/g, ' ').trim() }));
  }
  async aplicarParrafo(p, pg, par, ed, est, cont, todos) {
    const nuevas = this.lineasVisuales(ed);
    this.cerrarEditor();
    // la fuente del documento solo si trae todas las letras y el estilo es el original
    let letraOriginalFalto = false;
    if (est.fuente === 'orig' && (!est.orig || nuevas.some(l => [...l.texto].some(ch => ch.trim() && !(ch in est.orig.mapa))))) { est.fuente = est.respaldo; letraOriginalFalto = true; }
    const conOriginal = est.fuente === 'orig';
    const L = par.lineas, [lim0, lim1] = par.limites, mismaLetra = conOriginal || est.fuente === familia(par.fuente) || this.fuentes.parecida(par.fuente?.name) && est.fuente === 'f:' + this.fuentes.parecida(par.fuente.name).familia;
    const sinCambioDeEstilo = mismaLetra && est.tam === Math.round((par.fuente?.size || 11) * 10) / 10 && est.alineacion === par.alineacion && !est.colorCambiado
      && est.negrita === (par.fuente?.weight === 'bold') && est.cursiva === (par.fuente?.style === 'italic');
    if (sinCambioDeEstilo && nuevas.length === L.length && nuevas.every((l, i) => l.texto === L[i].texto)) return;
    // medir con la misma letra que se va a escribir (en el editor y en el PDF es la misma)
    const css = await this.fuentes.css(conOriginal ? est.respaldo : est.fuente, est.negrita, est.cursiva), lienzo = document.createElement('canvas').getContext('2d');
    lienzo.font = `${est.cursiva ? 'italic ' : ''}${est.negrita ? 700 : 400} ${est.tam}px ${css}`;
    await document.fonts.load(lienzo.font).catch(() => {});
    const O = est.orig, anchoOrig = ch => ch in O.mapa ? O.anchos[O.mapa[ch]] / 1000 * est.tam : ch === ' ' ? lienzo.measureText(' ').width : 0;
    const medir = conOriginal ? t => [...t].reduce((a, ch) => a + anchoOrig(ch), 0) : t => lienzo.measureText(t).width;
    const fuente = conOriginal ? null : await this.fuentes.paraEscribir(est.fuente, est.negrita, est.cursiva);
    const originales = []; // lo que va con la fuente del documento: { x, y, hex, tam, color }
    const aHexOrig = t => [...t].map(ch => O.mapa[ch]).join('');
    // un pedazo de texto en x, y: con la fuente del documento (palabra por palabra si no trae el espacio) o con la elegida
    const poner = (comun, x, texto) => {
      if (!conOriginal) return escribir.push({ ...comun, x, texto });
      if (' ' in O.mapa || !texto.includes(' ')) return originales.push({ x, y: comun.y, hex: aHexOrig(texto), tam: est.tam, color: est.color });
      let cx = x;
      for (const w of texto.split(' ')) { if (w) originales.push({ x: cx, y: comun.y, hex: aHexOrig(w), tam: est.tam, color: est.color }); cx += medir(w) + medir(' '); }
    };
    const borrar = [], escribir = [], permitidas = [], lecturas = []; // lecturas: dónde se controla después qué quedó escrito
    const y0 = L[0].base[1], tiraDe = (x0, x1, l) => { const h = l.rect[3] - l.rect[1]; return [x0 + 0.3, l.rect[1] + h * 0.35, x1 - 0.3, l.rect[3] - h * 0.35]; };
    const total = Math.max(nuevas.length, L.length);
    for (let i = 0; i < total; i++) {
      const orig = L[i], nueva = nuevas[i];
      // renglón igual y en el mismo lugar: no se toca (fidelidad: lo que no cambió queda exactamente como estaba)
      if (sinCambioDeEstilo && orig && nueva && nueva.texto === orig.texto) continue;
      let desde = orig ? orig.rect[0] : null, prefijo = 0;
      // alineado a la izquierda y mismo estilo: las palabras del principio que no cambiaron quedan en su lugar
      if (orig && nueva && sinCambioDeEstilo && est.alineacion === 'izq') {
        const pal = nueva.texto.split(' ');
        while (prefijo < pal.length && prefijo < orig.palabras.length && pal[prefijo] === orig.palabras[prefijo].t) prefijo++;
        if (prefijo === pal.length && prefijo === orig.palabras.length) continue;
        if (prefijo > 0 && prefijo < orig.palabras.length) desde = orig.palabras[prefijo].x0 - 0.5;
        else if (prefijo >= orig.palabras.length) desde = orig.rect[2] + 0.5;
      }
      if (orig) { borrar.push(tiraDe(desde, orig.rect[2], orig)); permitidas.push([desde - 1, orig.rect[1] - 1, orig.rect[2] + 1, orig.rect[3] + 1]); }
      if (!nueva?.texto) { if (orig) lecturas.push({ x0: desde - 0.5, x1: orig.rect[2] + 1, b: orig.base[1], texto: '' }); continue; }
      const base = orig && sinCambioDeEstilo ? orig.base[1] : y0 - i * est.interlineado;
      const pal = nueva.texto.split(' '), resto = pal.slice(prefijo).join(' ');
      lecturas.push({ x0: prefijo > 0 ? desde - 0.5 : lim0 - 2, x1: Math.max(lim1, orig?.rect[2] || 0) + 2, b: base, texto: prefijo > 0 ? resto : nueva.texto });
      if (orig && Math.abs(orig.base[1] - base) > 0.5) lecturas.push({ x0: desde - 0.5, x1: orig.rect[2] + 1, b: orig.base[1], texto: '' });
      const comun = { n: pg.n, fuente, negrita: est.negrita, cursiva: est.cursiva, tam: est.tam, color: est.color, y: base };
      const ancho = medir(nueva.texto), sang = i === 0 ? (par.sangria || 0) : 0;
      if (prefijo > 0) poner(comun, prefijo < orig.palabras.length ? orig.palabras[prefijo].x0 : orig.palabras.at(-1).x1 + medir(' '), resto);
      else if (est.alineacion === 'just' && !nueva.duro && pal.length > 1) {
        // justificado: cada palabra en su lugar, repartiendo el espacio que sobra
        const anchos = pal.map(medir), hueco = (lim1 - lim0 - sang - anchos.reduce((a, b) => a + b, 0)) / (pal.length - 1);
        let x = lim0 + sang;
        pal.forEach((w, k) => { poner(comun, x, w); x += anchos[k] + hueco; });
      } else {
        const x = est.alineacion === 'der' ? lim1 - ancho : est.alineacion === 'centro' ? (lim0 + lim1) / 2 - ancho / 2 : lim0 + sang;
        poner(comun, x, nueva.texto);
      }
      permitidas.push([lim0 - 2, base - est.tam * 0.35, lim1 + 2, base + est.tam * 1.05]);
    }
    if (!borrar.length && !escribir.length && !originales.length) return;
    // lo que no es del párrafo pero toca lo que se borra (un dato escrito encima) se vuelve a escribir igual
    const enPar = l => { const cx = (l.rect[0] + l.rect[2]) / 2, cy = (l.rect[1] + l.rect[3]) / 2; return L.some(x => cx >= x.rect[0] - 1 && cx <= x.rect[2] + 1 && cy >= x.rect[1] - 1 && cy <= x.rect[3] + 1); };
    const toca = o => !enPar(o) && borrar.some(z => o.rect[0] < z[2] && o.rect[2] > z[0] && o.rect[1] < z[3] && o.rect[3] > z[1]);
    await this.fuentes.cargar().catch(() => {});
    const rehacer = await Promise.all(cont.lineas.filter(toca).map(async o => { const fo = o.fuente || {}, fam = this.fuentes.parecida(fo.name);
      permitidas.push([o.rect[0] - 1, o.rect[1] - 1, o.rect[2] + 1, o.rect[3] + 1]);
      return { n: pg.n, x: o.base[0], y: o.base[1], texto: o.texto, fuente: fam ? await this.fuentes.paraEscribir('f:' + fam.familia, fo.weight === 'bold', fo.style === 'italic') : familia(fo),
        negrita: fo.weight === 'bold', cursiva: fo.style === 'italic', tam: fo.size || 11, color: o.color || [0, 0, 0] }; }));
    let letraCambiada = false, control = null;
    const ok = await this.ctx.aplicar(async base => {
      // la fuente del documento se busca en estos mismos bytes (al borrar, MuPDF puede sacarla de la página; se vuelve a enganchar)
      const info = originales.length ? await this.ctx.api.fuenteOriginal(base, pg.n, par.fuente.name) : null;
      if (originales.length && !info) throw new Error('No se pudo usar la letra original del documento.');
      let bytes = await this.ctx.api.borrarZona(base, pg.n, borrar, { texto: true });
      if (originales.length) bytes = await this.ctx.api.escribirOriginal(bytes, pg.n, { recurso: info.recurso, num: info.num }, originales);
      const nuevo = escribir.length || rehacer.length ? await ops.escribirTexto(bytes, [...escribir, ...rehacer]) : bytes;
      letraCambiada = !!nuevo.cambioLetra;
      // garantía 1: dentro del párrafo tiene que quedar exactamente el texto nuevo (que no haya quedado nada del viejo)
      // se compara renglón por renglón: en la altura de cada renglón del párrafo (nuevo o borrado) tiene que estar justo lo esperado
      const enBanda = (x, y) => lecturas.some(z => x >= z.x0 && x <= z.x1 && Math.abs(y - z.b) < est.tam * 0.45);
      const letras = t => [...String(t).normalize('NFC').replace(/\s+/g, '')].sort().join('');
      const esperado = letras([...lecturas.map(z => z.texto), ...rehacer.filter(o => enBanda(o.x + 1, o.y)).map(o => o.texto)].join(''));
      const leido = await this.ctx.api.paginaParrafos(nuevo, pg.n).then(r => letras(r.parrafos.flatMap(x => x.lineas)
        .flatMap(l => l.palabras.filter(w => enBanda((w.x0 + w.x1) / 2, w.y ?? l.base[1])).map(w => w.t)).join(''))).catch(() => null);
      // garantía 2: fuera del párrafo la hoja tiene que quedar igual
      control = await this.ctx.api.compararPaginas(base, nuevo, pg.n, permitidas).catch(() => null);
      if (leido != null && leido !== esperado) {
        const r = await this.ctx.dialogo?.({ titulo: 'No quedó como se esperaba', texto: 'Revisé el párrafo después de aplicar el cambio y el texto que quedó no es exactamente el que escribiste (puede haber quedado algo del texto anterior). ¿Lo aplico igual? (Después lo podés deshacer con Ctrl+Z.)',
          botones: [{ t: 'No aplicar', v: null }, { t: 'Aplicar igual', v: 'si', primario: true }] });
        if (r?.boton !== 'si') throw Object.assign(new Error('cancelado'), { cancelado: true });
        control = { ...control, dudoso: true };
      } else if (control?.fuera > 40) {
        const r = await this.ctx.dialogo?.({ titulo: 'Ojo: cambió algo más', texto: 'Al aplicar el cambio, en la hoja también se movió o se borró algo fuera de este párrafo. ¿Lo aplico igual? (Si lo aplicás, después lo podés deshacer con Ctrl+Z.)',
          botones: [{ t: 'No aplicar', v: null }, { t: 'Aplicar igual', v: 'si', primario: true }] });
        if (r?.boton !== 'si') throw Object.assign(new Error('cancelado'), { cancelado: true });
      }
      return nuevo;
    }, { mensaje: 'Párrafo editado' });
    if (!ok) return;
    if (letraOriginalFalto && !letraCambiada) return this.ctx.aviso('Párrafo editado con una letra parecida: la del documento no traía alguna de las letras que escribiste.');
    this.ctx.aviso(letraCambiada ? 'Párrafo editado. Ojo: alguna letra no está en la fuente elegida y se escribió con una básica.'
      : control && control.fuera <= 40 && !control.dudoso ? 'Párrafo editado. Lo controlé: quedó el texto nuevo y el resto de la hoja no cambió.' : 'Párrafo editado.', letraCambiada);
  }

  // ---------- Imágenes ----------
  menuImagen(p, pg, im) {
    const { el, icono: ic } = this.ctx, v = pg.vista;
    this.cerrarEditor();
    const [a, b, c, d] = v.convertToViewportRectangle(im.rect);
    // la imagen queda marcada mientras está la barra (no solo cuando el mouse está encima)
    const marco = el('div', { class: 'ed-imagen-elegida', style: `left:${Math.min(a, c) / v.width * 100}%;top:${Math.min(b, d) / v.height * 100}%;width:${Math.abs(c - a) / v.width * 100}%;height:${Math.abs(d - b) / v.height * 100}%` });
    // antes de tocar la imagen: lo escrito en el modo documento pasa al PDF y se saca su foto de la hoja (si no, la
    // imagen vieja seguiría tapando el cambio); al volver a dibujarse la página se arma de nuevo
    const hacer = f => async () => { this.cerrarEditor(); await this.word.cerrar(); await f(); this.redibujar(); };
    const barra = el('div', { class: 'ed-barra', style: `left:${Math.min(a, c) / v.width * 100}%;top:${Math.max(b, d) / v.height * 100}%` },
      el('button', { class: 'btn-texto', onclick: hacer(() => this.imagenAObjeto(p, pg, im)) }, 'Mover o cambiar tamaño'),
      el('button', { class: 'btn-texto', onclick: hacer(() => this.reemplazarImagen(p, pg, im)) }, 'Reemplazar…'),
      el('button', { class: 'btn-texto', onclick: () => this.copiarImagen(p, pg, im) }, 'Copiar'),
      el('button', { class: 'btn-texto peligro', html: ic.borrar + '<span>Borrar</span>', onclick: hacer(() => this.borrarImagen(p, pg, im)) }),
      el('button', { class: 'btn-texto boton-secundario', onclick: () => this.cerrarEditor() }, 'Cerrar'));
    pg.div.append(marco);
    barra.addEventListener('pointerdown', ev => ev.stopPropagation());
    pg.div.append(barra);
  }
  async png(p, n, im) {
    const r = await this.ctx.api.imagenDePagina(p.datos, n, im.indice);
    if (!r) throw new Error('No se pudo sacar esa imagen.');
    const c = Object.assign(document.createElement('canvas'), { width: r.ancho, height: r.alto });
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.rgba), r.ancho, r.alto), 0, 0);
    return new Promise(res => c.toBlob(async b => res(new Uint8Array(await b.arrayBuffer())), 'image/png'));
  }
  async copiarImagen(p, pg, im) {
    this.cerrarEditor();
    try { await this.ctx.api.portapapelesEscribir({ png: await this.png(p, pg.n, im) }); this.ctx.aviso('Imagen copiada. Pegala con Ctrl+V.'); } catch (e) { this.ctx.error(e); }
  }
  async borrarImagen(p, pg, im) {
    this.cerrarEditor();
    await this.ctx.aplicar(base => this.ctx.api.borrarZona(base, pg.n, [im.rect], { texto: false, imagenes: im.metodo || 'quitar' }), { mensaje: 'Imagen borrada (Ctrl+Z para deshacer)' });
  }
  // Saca la imagen del contenido y la pone como objeto que se arrastra y agranda (igual que una firma)
  async imagenAObjeto(p, pg, im, png = null, mensaje = 'Ahora la imagen se puede mover, agrandar o girar.') {
    this.cerrarEditor();
    try { png ||= await this.png(p, pg.n, im); } catch (e) { return this.ctx.error(e); }
    const r = im.rect, f = { id: crypto.randomUUID(), n: pg.n, cx: (r[0] + r[2]) / 2, cy: (r[1] + r[3]) / 2, w: r[2] - r[0], h: r[3] - r[1], angulo: 0, png, nombre: 'Imagen', clave: 'img-' + crypto.randomUUID() };
    const ok = await this.ctx.aplicar(async base => ops.componerFirmas(await this.ctx.api.borrarZona(base, pg.n, [im.rectOriginal || r], { texto: false, imagenes: im.metodo || 'quitar' }), [f]), { mensaje });
    if (ok) { this.terminar(); const nueva = this.p.firmas.find(x => x.n === pg.n && Math.abs(x.cx - f.cx) < 0.5 && Math.abs(x.cy - f.cy) < 0.5); if (nueva) { this.ctx.firmas.sel = nueva.id; this.ctx.firmas.redibujar(this.p); } }
  }
  async reemplazarImagen(p, pg, im) {
    this.cerrarEditor();
    const archivo = await this.ctx.api.elegirImagenFirma();
    if (!archivo) return;
    let img;
    try { img = await createImageBitmap(archivo.tipo === 'rgba' ? new ImageData(new Uint8ClampedArray(archivo.datos), archivo.ancho, archivo.alto) : new Blob([archivo.datos])); }
    catch { return this.ctx.aviso('No se pudo leer esa imagen. Probá con un JPG o PNG.', true); }
    // la nueva entra en el lugar de la anterior sin deformarse
    const r = im.rect, W = r[2] - r[0], H = r[3] - r[1], esc = Math.min(W / img.width, H / img.height);
    const w = img.width * esc, h = img.height * esc, max = 2000 / Math.max(img.width, img.height);
    const c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * Math.min(1, max)), height: Math.round(img.height * Math.min(1, max)) });
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const png = await new Promise(res => c.toBlob(async b => res(new Uint8Array(await b.arrayBuffer())), 'image/png'));
    const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
    await this.imagenAObjeto(p, pg, { ...im, rect: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], rectOriginal: r }, png, 'Imagen reemplazada. Se puede mover y agrandar.');
  }
  tecla(e) {
    if (!this.activo) return false;
    if (e.key === 'Escape') { if (document.querySelector('.ed-barra')) this.cerrarEditor(); else this.terminar(); return true; }
    return false;
  }
}
