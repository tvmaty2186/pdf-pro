// PDF.Pro — firmas y sellos desde imagen: quitar el fondo, biblioteca y colocación sobre la página
import { leerRangos } from './paginas.js';

const COLORES = { negro: [22, 22, 28], azul: [24, 44, 150] };
const limitar = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));

// ---------- Quitar el fondo ----------
// Toma una foto o escaneo de una firma/sello y devuelve un lienzo con fondo transparente, recortado a la tinta.
// sensibilidad 0–100: más alto = conserva trazos más claros. color: original | negro | azul.
export function quitarFondo(imagen, { sensibilidad = 50, color = 'original' } = {}) {
  const MAX = 1200; // suficiente para imprimir una firma de ~10 cm a 300 ppp
  const esc = Math.min(1, MAX / Math.max(imagen.width, imagen.height));
  const w = Math.max(1, Math.round(imagen.width * esc)), h = Math.max(1, Math.round(imagen.height * esc));
  const lienzo = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const g = lienzo.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); // las imágenes con transparencia se apoyan sobre blanco
  g.drawImage(imagen, 0, 0, w, h);
  const img = g.getImageData(0, 0, w, h), d = img.data, N = w * h;

  // 1) Color del papel: el tono claro que más se repite
  const lum = new Float32Array(N), histo = new Uint32Array(256);
  for (let i = 0; i < N; i++) { const l = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; lum[i] = l; histo[l | 0]++; }
  let acum = 0, papel = 255;
  for (let v = 0; v < 256; v++) { acum += histo[v]; if (acum >= N * 0.7) { papel = Math.max(v, 60); break; } }
  const fondo = [0, 0, 0]; let nf = 0;
  for (let i = 0; i < N; i++) if (Math.abs(lum[i] - papel) < 14) { fondo[0] += d[i * 4]; fondo[1] += d[i * 4 + 1]; fondo[2] += d[i * 4 + 2]; nf++; }
  for (let k = 0; k < 3; k++) fondo[k] = nf ? fondo[k] / nf : 255;

  // 2) Qué tan oscura es la tinta (para que los trazos queden opacos aunque la foto sea clara)
  const osc = new Float32Array(N), hOsc = new Uint32Array(101);
  let nTinta = 0;
  for (let i = 0; i < N; i++) { const o = limitar((papel - lum[i]) / papel); osc[i] = o; if (o > 0.2) { hOsc[Math.round(o * 100)]++; nTinta++; } }
  let tinta = 1; acum = 0;
  for (let v = 0; v <= 100 && nTinta; v++) { acum += hOsc[v]; if (acum >= nTinta * 0.9) { tinta = Math.max(v / 100, 0.25); break; } }

  // 3) Transparencia y color de cada punto
  const corte = 0.3 - limitar(sensibilidad, 0, 100) * 0.0026;
  const lleno = Math.max(tinta * 0.75, corte + 0.06);
  const fijo = COLORES[color];
  for (let i = 0; i < N; i++) {
    const a = limitar((osc[i] - corte) / (lleno - corte)), j = i * 4;
    if (a <= 0) { d[j + 3] = 0; continue; }
    if (fijo) { d[j] = fijo[0]; d[j + 1] = fijo[1]; d[j + 2] = fijo[2]; }
    else { // se le "resta" el papel para que el borde no quede con halo claro
      const cob = Math.max(limitar(osc[i] / tinta), 0.25);
      for (let k = 0; k < 3; k++) d[j + k] = limitar((d[j + k] - fondo[k] * (1 - cob)) / cob, 0, 255);
    }
    d[j + 3] = Math.round(a * 255);
  }

  // 4) Recortar al contenido (ignora puntitos sueltos)
  const minimo = Math.max(1, Math.round(Math.min(w, h) * 0.004));
  const filas = new Uint32Array(h), cols = new Uint32Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 60) { filas[y]++; cols[x]++; }
  const borde = (arr, n) => { let a = 0, b = n - 1; while (a < n && arr[a] < minimo) a++; while (b > a && arr[b] < minimo) b--; return [a, b]; };
  let [y0, y1] = borde(filas, h), [x0, x1] = borde(cols, w);
  if (y0 >= h || x0 >= w) { x0 = 0; y0 = 0; x1 = w - 1; y1 = h - 1; } // no encontró tinta: deja todo
  const m = Math.round(Math.max(w, h) * 0.01);
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(w - 1, x1 + m); y1 = Math.min(h - 1, y1 + m);
  g.putImageData(img, 0, 0);
  const salida = Object.assign(document.createElement('canvas'), { width: x1 - x0 + 1, height: y1 - y0 + 1 });
  salida.getContext('2d').drawImage(lienzo, x0, y0, salida.width, salida.height, 0, 0, salida.width, salida.height);
  return salida;
}
// Imagen girada (de a 90°) y recortada (x, y, w, h de 0 a 1, sobre la imagen ya girada)
function prepararImagen(imagen, giro = 0, recorte = null) {
  const de = giro % 180 ? [imagen.height, imagen.width] : [imagen.width, imagen.height];
  const r = recorte || { x: 0, y: 0, w: 1, h: 1 };
  const sx = Math.round(r.x * de[0]), sy = Math.round(r.y * de[1]);
  const w = Math.max(1, Math.round(r.w * de[0])), h = Math.max(1, Math.round(r.h * de[1]));
  const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const g = c.getContext('2d');
  g.translate(-sx, -sy); g.translate(de[0] / 2, de[1] / 2); g.rotate(giro * Math.PI / 180);
  g.drawImage(imagen, -imagen.width / 2, -imagen.height / 2);
  return c;
}
// El recorte acompaña a la imagen cuando se gira
const girarRecorte = (r, sentido) => r && (sentido > 0 ? { x: 1 - r.y - r.h, y: r.x, w: r.h, h: r.w } : { x: r.y, y: 1 - r.x - r.w, w: r.h, h: r.w });

// Ventana para elegir qué parte de la foto usar: se arrastra el recuadro, se agranda desde las esquinas o se dibuja uno nuevo
async function elegirRecorte({ el, dialogo }, imagen, giro, recorte) {
  const lienzo = prepararImagen(imagen, giro);
  const r = { ...(recorte || { x: 0.05, y: 0.05, w: 0.9, h: 0.9 }) };
  const caja = el('div', { class: 'recorte-caja' }, ...['no', 'ne', 'so', 'se'].map(c => el('span', { class: 'asa ' + c, 'data-esquina': c })));
  const zona = el('div', { class: 'recorte' }, lienzo, caja);
  const ubicar = () => Object.assign(caja.style, { left: r.x * 100 + '%', top: r.y * 100 + '%', width: r.w * 100 + '%', height: r.h * 100 + '%' });
  ubicar();
  zona.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const R = zona.getBoundingClientRect();
    const punto = ev => ({ x: limitar((ev.clientX - R.left) / R.width), y: limitar((ev.clientY - R.top) / R.height) });
    const ini = punto(e), antes = { ...r }, esquina = e.target.dataset.esquina, mover = e.target === caja;
    // esquina: la opuesta queda fija; afuera del recuadro: se dibuja uno nuevo desde ese punto
    const fijo = esquina ? { x: esquina[1] === 'o' ? antes.x + antes.w : antes.x, y: esquina[0] === 'n' ? antes.y + antes.h : antes.y } : ini;
    const seguir = ev => {
      const q = punto(ev);
      if (mover) {
        r.x = limitar(antes.x + q.x - ini.x, 0, 1 - antes.w); r.y = limitar(antes.y + q.y - ini.y, 0, 1 - antes.h);
      } else {
        r.x = Math.min(fijo.x, q.x); r.y = Math.min(fijo.y, q.y);
        r.w = Math.max(0.02, Math.abs(q.x - fijo.x)); r.h = Math.max(0.02, Math.abs(q.y - fijo.y));
        r.w = Math.min(r.w, 1 - r.x); r.h = Math.min(r.h, 1 - r.y);
      }
      ubicar();
    };
    const soltar = () => { removeEventListener('pointermove', seguir); removeEventListener('pointerup', soltar); };
    addEventListener('pointermove', seguir); addEventListener('pointerup', soltar);
  });
  const res = await dialogo({ titulo: 'Recortar', texto: 'Dejá adentro del recuadro solo la firma o el sello. Arrastralo, agrandalo desde las esquinas o dibujá uno nuevo.',
    contenido: zona, clase: 'dialogo-ancho', botones: [{ t: 'Cancelar', v: null }, { t: 'Usar toda la imagen', v: 'todo' }, { t: 'Recortar', v: 'ok', primario: true }] });
  if (!res) return recorte;
  return res.boton === 'todo' ? null : { ...r };
}

const aPng = lienzo => new Promise(r => lienzo.toBlob(async b => r(new Uint8Array(await b.arrayBuffer())), 'image/png'));
const nombreDeArchivo = n => n.replace(/\.\w+$/, '').replace(/[_-]+/g, ' ').trim().toLowerCase().replace(/(^|\s)\S/g, s => s.toUpperCase());

// ---------- Biblioteca y colocación ----------
export class Firmas {
  constructor(ctx) { this.ctx = ctx; this.lista = []; this.col = null; }

  async cargar() {
    this.lista.forEach(f => URL.revokeObjectURL(f.url));
    this.lista = (await this.ctx.api.firmasLista()).map(f => {
      const bytes = new Uint8Array(f.datos);
      return { ...f, datos: undefined, bytes, url: URL.createObjectURL(new Blob([bytes], { type: 'image/png' })) };
    });
    return this.lista;
  }

  // Procesa una imagen y la guarda en la biblioteca (sin preguntar)
  async crearDesdeBytes(datos, { nombre, tipo = 'firma', sensibilidad = 50, color = 'original' }) {
    const imagen = await createImageBitmap(new Blob([datos]));
    const lienzo = quitarFondo(imagen, { sensibilidad, color });
    const id = await this.ctx.api.firmasGuardar({ nombre, tipo, png: await aPng(lienzo), ancho: lienzo.width, alto: lienzo.height });
    await this.cargar();
    return this.lista.find(f => f.id === id);
  }

  // Elegir una imagen, ajustar cómo queda y guardarla
  async agregar(archivo) {
    const { el, dialogo, aviso } = this.ctx;
    archivo ||= await this.ctx.api.elegirImagenFirma();
    if (!archivo) return null;
    let imagen;
    try { imagen = await createImageBitmap(archivo.tipo === 'rgba' ? new ImageData(new Uint8ClampedArray(archivo.datos), archivo.ancho, archivo.alto) : new Blob([archivo.datos])); }
    catch { aviso('No se pudo leer esa imagen. Probá con un JPG o PNG.', true); return null; }
    const vista = el('div', { class: 'firma-vista damero' });
    const nombre = el('input', { class: 'campo', type: 'text', value: nombreDeArchivo(archivo.nombre), maxlength: 60, style: 'width:100%;text-align:left' });
    const tipo = el('div', { class: 'segmentos' }, ...[['firma', 'Firma'], ['sello', 'Sello']].map(([v, t], i) =>
      el('label', {}, el('input', { type: 'radio', name: 'firma-tipo', value: v, checked: (/sello/i.test(archivo.nombre) ? i === 1 : i === 0) }), el('span', {}, t))));
    const color = el('div', { class: 'segmentos' }, ...[['original', 'Original'], ['negro', 'Negro'], ['azul', 'Azul']].map(([v, t], i) =>
      el('label', {}, el('input', { type: 'radio', name: 'firma-color', value: v, checked: i === 0 }), el('span', {}, t))));
    const sens = el('input', { type: 'range', min: 0, max: 100, value: 50, class: 'deslizador', 'aria-label': 'Sensibilidad' });
    let lienzo, temporizador, giro = 0, recorte = null, fuente = imagen;
    const procesar = () => {
      lienzo = quitarFondo(fuente, { sensibilidad: +sens.value, color: color.querySelector('input:checked').value });
      vista.replaceChildren(lienzo);
    };
    const rehacer = () => { fuente = giro || recorte ? prepararImagen(imagen, giro, recorte) : imagen; procesar(); };
    const girar = sentido => { giro = (giro + sentido * 90 + 360) % 360; recorte = girarRecorte(recorte, sentido); rehacer(); };
    const { icono: ic } = this.ctx;
    const ajustes = el('div', { class: 'firma-ajustes' },
      el('button', { class: 'btn-texto', type: 'button', title: 'Girar a la izquierda', html: ic.girarIzq + '<span>Girar</span>', onclick: () => girar(-1) }),
      el('button', { class: 'btn-texto', type: 'button', title: 'Girar a la derecha', html: ic.rotar + '<span>Girar</span>', onclick: () => girar(1) }),
      el('button', { class: 'btn-texto', type: 'button', title: 'Elegir qué parte de la foto usar', html: ic.recortar + '<span>Recortar…</span>', onclick: async () => { recorte = await elegirRecorte(this.ctx, imagen, giro, recorte); rehacer(); } }));
    const pedir = () => { clearTimeout(temporizador); temporizador = setTimeout(procesar, 60); };
    sens.addEventListener('input', pedir); color.addEventListener('change', procesar);
    procesar();
    const fila = (t, ...c) => el('div', { class: 'firma-fila' }, el('span', { class: 'sutil' }, t), ...c);
    const contenido = el('div', { class: 'firma-editor' }, vista,
      fila('Imagen', ajustes), fila('Nombre', nombre), fila('Es una', tipo), fila('Color de la tinta', color),
      fila('Limpieza del fondo', el('div', { class: 'deslizador-fila' }, el('small', {}, 'Más limpio'), sens, el('small', {}, 'Más trazo'))));
    const r = await dialogo({ titulo: 'Nueva firma o sello', texto: 'El fondo se quita solo. Si ves manchas, mové la barra hacia "Más limpio"; si se cortan trazos, hacia "Más trazo".',
      contenido, botones: [{ t: 'Cancelar', v: null }, { t: 'Guardar', v: 'ok', primario: true }],
      validar: () => nombre.value.trim() ? null : 'Ponele un nombre.' });
    if (!r) return null;
    const id = await this.ctx.api.firmasGuardar({ nombre: nombre.value.trim(), tipo: tipo.querySelector('input:checked').value, png: await aPng(lienzo), ancho: lienzo.width, alto: lienzo.height });
    await this.cargar();
    aviso('Guardada en tu biblioteca: ' + nombre.value.trim());
    return this.lista.find(f => f.id === id);
  }

  // Ventana para renombrar y borrar
  async administrar() {
    const { el, dialogo } = this.ctx;
    const lista = el('div', { class: 'firmas-lista' });
    const dibujar = () => lista.replaceChildren(...(this.lista.length ? this.lista.map(f => {
      const borrar = el('button', { class: 'btn-texto firma-borrar', title: 'Borrar' }, 'Borrar');
      borrar.onclick = async () => {
        if (!borrar.dataset.confirmar) { borrar.dataset.confirmar = '1'; borrar.textContent = '¿Seguro?'; return; }
        await this.ctx.api.firmasBorrar(f.id); await this.cargar(); dibujar();
      };
      const nombre = el('input', { class: 'campo', value: f.nombre, maxlength: 60, 'aria-label': 'Nombre' });
      nombre.onchange = async () => { if (nombre.value.trim()) { await this.ctx.api.firmasCambiar(f.id, { nombre: nombre.value.trim() }); await this.cargar(); } };
      const tipo = el('select', { class: 'campo', 'aria-label': 'Tipo' }, el('option', { value: 'firma', selected: f.tipo === 'firma' }, 'Firma'), el('option', { value: 'sello', selected: f.tipo === 'sello' }, 'Sello'));
      tipo.onchange = async () => { await this.ctx.api.firmasCambiar(f.id, { tipo: tipo.value }); await this.cargar(); };
      return el('div', { class: 'firmas-item' }, el('span', { class: 'firmas-mini damero' }, el('img', { src: f.url, alt: '' })), nombre, tipo, borrar);
    }) : [el('p', { class: 'sutil' }, 'Todavía no guardaste ninguna firma ni sello.')]));
    dibujar();
    const r = await dialogo({ titulo: 'Firmas y sellos', contenido: lista,
      botones: [{ t: 'Agregar desde imagen…', v: 'agregar' }, { t: 'Listo', v: null, primario: true }] });
    if (r?.boton === 'agregar' && await this.agregar()) this.administrar();
  }

  // ---------- Firmas editables sobre la página (como en Acrobat) ----------
  // Se pueden seleccionar, mover, agrandar desde las esquinas, rotar y borrar en cualquier momento.
  // Las posiciones se guardan en puntos del PDF; en pantalla se calculan con la "vista" de pdf.js de cada página.

  // URL de imagen para cada PNG (se reutiliza si el PNG es el mismo)
  urlDe(f) {
    this.urls ||= new Map();
    f.clave ||= claveDe(f.png);
    if (!this.urls.has(f.clave)) this.urls.set(f.clave, URL.createObjectURL(new Blob([f.png], { type: 'image/png' })));
    return this.urls.get(f.clave);
  }
  preparar(lista) { lista.forEach(f => { f.clave ||= claveDe(f.png); }); return lista; }

  // Pone una firma de la biblioteca (o una imagen pegada) en la página actual, derecha en pantalla y ya seleccionada.
  // q = { pg, x, y }: punto de la vista donde centrarla (clic derecho); si no, al medio de lo que se ve.
  async nueva(item, q = null) {
    const p = this.ctx.pestana(), v = p?.visor;
    if (!v?.doc || !item) return;
    const pg = q?.pg || v.paginas[v.actual - 1], n = pg.n, vista = await this.vistaDe(v, pg);
    const caja = v.el.getBoundingClientRect(), r = pg.div.getBoundingClientRect();
    const k = vista.width / r.width;
    const cy = q ? q.y : ((Math.max(r.top, caja.top) + Math.min(r.bottom, caja.bottom)) / 2 - r.top) * k;
    const ancho = item.anchoPt || (this.ctx.prefs?.().anchoFirmaCm || 5.5) / 2.54 * 72 * (item.tipo === 'sello' ? 0.75 : 1);
    const w = Math.min(ancho * vista.scale, vista.width * 0.6), h = Math.min(w * item.alto / item.ancho, vista.height * 0.8), w2 = h * item.ancho / item.alto;
    const pos = dePantalla({ cx: limitar(q ? q.x : vista.width / 2, w2 / 2, vista.width - w2 / 2), cy: limitar(cy, h / 2, vista.height - h / 2), w: w2, h, ang: 0 }, vista);
    const f = { id: crypto.randomUUID(), n, ...pos, png: item.bytes, nombre: item.nombre, ...(item.id ? { clave: 'lib-' + item.id } : {}) };
    this.sel = f.id;
    const que = item.tipo === 'imagen' ? 'Imagen pegada' : item.tipo === 'sello' ? 'Sello agregado' : 'Firma agregada';
    this.ctx.cambiarFirmas(p, [...p.firmas, f], `${que}. Arrastrala, agrandala desde las esquinas o girala desde el punto de arriba.`);
  }
  // Copia de una firma para pegar: centrada en el punto dado (vista) o corrida un poco
  copiaPara(f, q) {
    const nueva = { ...f, id: crypto.randomUUID() };
    if (!q) return { ...nueva, cx: f.cx + 12, cy: f.cy - 12 };
    const [cx, cy] = q.pg.vista.convertToPdfPoint(q.x, q.y);
    return { ...nueva, n: q.pg.n, cx, cy };
  }
  async vistaDe(v, pg) {
    if (pg.vista) return pg.vista;
    const pagina = await v.doc.getPage(pg.n);
    return pagina.getViewport({ scale: v.escala, rotation: (pagina.rotate + v.rotacion) % 360 });
  }

  // Dibuja las firmas de una página (lo llama el visor cada vez que dibuja la página)
  dibujarPagina(p, pg) {
    pg.div.querySelectorAll('.estampa, .estampa-barra').forEach(x => x.remove());
    if (!pg.vista) return;
    for (const f of p.firmas) if (f.n === pg.n) pg.div.append(...[].concat(this.elemento(p, f, pg)));
  }
  redibujar(p) {
    if (this.sel && !p.firmas.some(f => f.id === this.sel)) this.sel = null;
    p.visor?.paginas.forEach(pg => pg.dibujada && this.dibujarPagina(p, pg));
  }
  deseleccionar() {
    if (!this.sel) return;
    this.sel = null;
    const p = this.ctx.pestana(); if (p) this.redibujar(p);
  }

  elemento(p, f, pg) {
    const { el } = this.ctx, vista = pg.vista, sel = f.id === this.sel;
    const m = aPantalla(f, vista);
    const caja = el('div', { class: 'estampa' + (sel ? ' sel' : ''), 'data-id': f.id, title: sel ? '' : f.nombre + ' (clic para editar)' },
      el('img', { src: this.urlDe(f), alt: f.nombre, draggable: 'false' }),
      ...(sel ? [...['no', 'ne', 'so', 'se'].map(c => el('span', { class: 'asa ' + c, 'data-esquina': c })), el('span', { class: 'asa-giro', 'data-giro': '1', title: 'Girar (Mayús: de a 15°)' })] : []));
    const ubicar = m => {
      Object.assign(caja.style, { left: (m.cx - m.w / 2) / vista.width * 100 + '%', top: (m.cy - m.h / 2) / vista.height * 100 + '%',
        width: m.w / vista.width * 100 + '%', height: m.h / vista.height * 100 + '%', transform: `rotate(${m.ang}deg)` });
      if (barra) { const [c, s] = [Math.abs(Math.cos(m.ang * Math.PI / 180)), Math.abs(Math.sin(m.ang * Math.PI / 180))];
        Object.assign(barra.style, { left: m.cx / vista.width * 100 + '%', top: (m.cy + (m.w * s + m.h * c) / 2) / vista.height * 100 + '%' }); }
    };
    const cambiar = (cambios, msg) => this.ctx.cambiarFirmas(p, p.firmas.map(x => x.id === f.id ? { ...x, ...cambios } : x), msg);
    let barra = null;
    if (sel) {
      const { icono: ic } = this.ctx;
      barra = el('div', { class: 'estampa-barra' },
        el('button', { class: 'btn-icono', title: 'Girar a la izquierda', html: ic.girarIzq, onclick: () => cambiar({ angulo: normalAng(f.angulo + 90) }) }),
        el('button', { class: 'btn-icono', title: 'Girar a la derecha', html: ic.rotar, onclick: () => cambiar({ angulo: normalAng(f.angulo - 90) }) }),
        el('button', { class: 'btn-icono', title: 'Poner en otras páginas…', html: ic.varias, onclick: () => this.copiarAPaginas(p, f) }),
        el('button', { class: 'btn-icono', title: 'Duplicar', html: ic.duplicar, onclick: () => { const d = { ...f, id: crypto.randomUUID(), cx: f.cx + 12, cy: f.cy - 12 }; this.sel = d.id; this.ctx.cambiarFirmas(p, [...p.firmas, d]); } }),
        el('button', { class: 'btn-icono peligro', title: 'Borrar (Supr)', html: ic.borrar, onclick: () => this.borrar(p) }));
      barra.addEventListener('pointerdown', e => e.stopPropagation());
    }
    ubicar(m);
    caja.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      if (!sel) { this.sel = f.id; this.ctx.alSeleccionar?.(); this.redibujar(p); return this.reenviar(e, p, f); }
      const R = pg.div.getBoundingClientRect(), k = vista.width / R.width;
      const punto = ev => ({ x: (ev.clientX - R.left) * k, y: (ev.clientY - R.top) * k });
      const ini = punto(e), esquina = e.target.dataset.esquina, girando = e.target.dataset.giro;
      const prop = m.h / m.w, a = m.ang * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
      let nuevo = m, movido = false;
      const mover = ev => {
        const q = punto(ev);
        if (!movido && Math.hypot(q.x - ini.x, q.y - ini.y) < 2) return;
        movido = true;
        if (girando) {
          let ang = Math.atan2(q.y - m.cy, q.x - m.cx) * 180 / Math.PI + 90;
          ang = ev.shiftKey ? Math.round(ang / 15) * 15 : (Math.abs(ang - Math.round(ang / 90) * 90) < 4 ? Math.round(ang / 90) * 90 : ang);
          nuevo = { ...m, ang };
        } else if (esquina) {
          const sx = esquina[1] === 'o' ? -1 : 1, sy = esquina[0] === 'n' ? -1 : 1;
          const ax = m.cx - cos * sx * m.w / 2 + sin * sy * m.h / 2, ay = m.cy - sin * sx * m.w / 2 - cos * sy * m.h / 2; // esquina opuesta
          const dx = q.x - ax, dy = q.y - ay, lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos;
          const w = Math.max(16 * k, sx * lx, sy * ly / prop), h = w * prop;
          nuevo = { ...m, w, h, cx: ax + cos * sx * w / 2 - sin * sy * h / 2, cy: ay + sin * sx * w / 2 + cos * sy * h / 2 };
        } else nuevo = { ...m, cx: m.cx + q.x - ini.x, cy: m.cy + q.y - ini.y };
        ubicar(nuevo);
      };
      const soltar = () => {
        removeEventListener('pointermove', mover); removeEventListener('pointerup', soltar);
        if (movido) cambiar(dePantalla(nuevo, vista));
      };
      addEventListener('pointermove', mover); addEventListener('pointerup', soltar);
    });
    return barra ? [caja, barra] : caja;
  }
  // Primer clic sobre una firma no seleccionada: la selecciona y ya permite arrastrarla
  reenviar(e, p, f) {
    const caja = [...document.querySelectorAll('.estampa.sel')].pop();
    caja?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: e.clientX, clientY: e.clientY, pointerId: e.pointerId }));
  }
  // Pone la misma firma, en el mismo lugar de la hoja, en otras páginas (todas o un rango)
  async copiarAPaginas(p, f) {
    const { el, dialogo } = this.ctx, v = p.visor, total = v.total;
    if (total < 2) return this.ctx.aviso('El documento tiene una sola página.');
    const rango = el('input', { class: 'campo', type: 'text', placeholder: 'Ej.: 2-5, 8', style: 'width:130px;text-align:left' });
    const op = (valor, texto, marcada, extra) => el('label', { class: 'opcion' }, el('input', { type: 'radio', name: 'firma-paginas', value: valor, checked: marcada }), el('span', {}, texto), extra || null);
    rango.addEventListener('focus', () => { rango.closest('dialog').querySelector('[value=rango]').checked = true; });
    const r = await dialogo({ titulo: 'Poner en otras páginas', texto: `Se copia en el mismo lugar de cada hoja. El documento tiene ${total} páginas.`,
      contenido: el('div', { class: 'opciones' }, op('todas', 'Todas las páginas', true), op('impares', 'Solo las impares', false), op('pares', 'Solo las pares', false), op('rango', 'Páginas:', false, rango)),
      botones: [{ t: 'Cancelar', v: null }, { t: 'Poner', v: 'ok', primario: true }],
      validar: d => { if (d.querySelector('input[name=firma-paginas]:checked').value !== 'rango') return null; try { leerRangos(rango.value, total); return null; } catch (e) { return e.message; } } });
    if (!r) return;
    const modo = r.raiz.querySelector('input[name=firma-paginas]:checked').value;
    let lista = modo === 'rango' ? leerRangos(rango.value, total).flat().map(i => i + 1) : [...Array(total).keys()].map(i => i + 1);
    if (modo === 'impares') lista = lista.filter(n => n % 2); else if (modo === 'pares') lista = lista.filter(n => !(n % 2));
    lista = [...new Set(lista)].filter(n => n !== f.n);
    if (!lista.length) return this.ctx.aviso('No quedan otras páginas para ponerla.');
    // posición relativa a la hoja como se ve, así sirve con páginas de otro tamaño o giradas
    const vistaDe = async n => { const pg = await v.doc.getPage(n); return pg.getViewport({ scale: 1, rotation: pg.rotate }); };
    const vo = await vistaDe(f.n), m = aPantalla(f, vo), copias = [];
    for (const n of lista) {
      const vd = await vistaDe(n);
      const pos = dePantalla({ ...m, cx: m.cx / vo.width * vd.width, cy: m.cy / vo.height * vd.height }, vd);
      copias.push({ ...f, id: crypto.randomUUID(), n, ...pos });
    }
    this.ctx.cambiarFirmas(p, [...p.firmas, ...copias], `${f.nombre || 'Firma'} puesta en ${copias.length} ${copias.length === 1 ? 'página más' : 'páginas más'} (Ctrl+Z para deshacer)`);
  }
  borrar(p) {
    if (!this.sel) return;
    const id = this.sel; this.sel = null;
    this.ctx.cambiarFirmas(p, p.firmas.filter(f => f.id !== id), 'Firma borrada (Ctrl+Z para deshacer)');
  }
  // Teclas cuando hay una firma seleccionada. Devuelve true si la usó.
  tecla(e, p) {
    if (!this.sel || e.target.matches?.('input, textarea, select')) return false;
    if (e.key === 'Delete' || e.key === 'Backspace') { this.borrar(p); return true; }
    if (e.key === 'Escape') { this.deseleccionar(); return true; }
    const flechas = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
    if (flechas) {
      const d = e.shiftKey ? 10 : 1, f = p.firmas.find(x => x.id === this.sel);
      const pg = p.visor.paginas[f.n - 1], vista = pg.vista;
      if (!vista) return true;
      const m = aPantalla(f, vista); m.cx += flechas[0] * d * vista.scale; m.cy -= flechas[1] * d * vista.scale;
      this.ctx.cambiarFirmas(p, p.firmas.map(x => x.id === f.id ? { ...x, ...dePantalla(m, vista) } : x));
      return true;
    }
    return false;
  }
}

// ---------- Firmas dibujadas en un lienzo (miniaturas e impresión) ----------
const mapas = new Map(); // clave del PNG → imagen ya decodificada
export async function pintarFirmas(g, lista, vista) {
  for (const f of lista) {
    f.clave ||= claveDe(f.png);
    if (!mapas.has(f.clave)) mapas.set(f.clave, createImageBitmap(new Blob([f.png], { type: 'image/png' })));
    const img = await mapas.get(f.clave), m = aPantalla(f, vista);
    g.save(); g.translate(m.cx, m.cy); g.rotate(m.ang * Math.PI / 180);
    g.drawImage(img, -m.w / 2, -m.h / 2, m.w, m.h);
    g.restore();
  }
}

// ---------- Conversión entre el PDF y la pantalla ----------
const normalAng = a => ((a % 360) + 540) % 360 - 180;
function claveDe(bytes) { let h = 2166136261; for (let i = 0; i < bytes.length; i += 7) h = Math.imul(h ^ bytes[i], 16777619); return 'png-' + bytes.length + '-' + (h >>> 0).toString(36); }
// f (en puntos del PDF) → { cx, cy, w, h, ang } en píxeles de la vista (y hacia abajo)
function aPantalla(f, vista) {
  const a = f.angulo * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
  const [cx, cy] = vista.convertToViewportPoint(f.cx, f.cy);
  const [bx, by] = vista.convertToViewportPoint(f.cx + cos, f.cy + sin);
  return { cx, cy, w: f.w * vista.scale, h: f.h * vista.scale, ang: Math.atan2(by - cy, bx - cx) * 180 / Math.PI };
}
function dePantalla(m, vista) {
  const a = m.ang * Math.PI / 180;
  const [cx, cy] = vista.convertToPdfPoint(m.cx, m.cy);
  const [bx, by] = vista.convertToPdfPoint(m.cx + Math.cos(a), m.cy + Math.sin(a));
  return { cx, cy, w: m.w / vista.scale, h: m.h / vista.scale, angulo: normalAng(Math.atan2(by - cy, bx - cx) * 180 / Math.PI) };
}
