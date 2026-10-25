// PDF.Pro — reconocer texto en páginas escaneadas (OCR). El trabajo pesado lo hace main.js (tesseract.js, español).
import * as ops from './paginas.js';

// Dibuja la página a ~300 ppp (sin pasar de 4000 píxeles) y la manda a reconocer.
// Devuelve las palabras en coordenadas del PDF, listas para agregarTextoOcr.
async function reconocerPagina(api, doc, n) {
  const pagina = await doc.getPage(n);
  const v1 = pagina.getViewport({ scale: 1, rotation: pagina.rotate });
  const vista = pagina.getViewport({ scale: Math.min(300 / 72, 4000 / Math.max(v1.width, v1.height)), rotation: pagina.rotate });
  const c = Object.assign(document.createElement('canvas'), { width: Math.round(vista.width), height: Math.round(vista.height) });
  const g = c.getContext('2d', { alpha: false });
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  await pagina.render({ canvasContext: g, viewport: vista }).promise;
  const png = await new Promise(r => c.toBlob(async b => r(new Uint8Array(await b.arrayBuffer())), 'image/png'));
  c.width = c.height = 0;
  const renglones = await api.ocr(png), palabras = [];
  for (const l of renglones) {
    const b = l.base, alto = l.caja.y1 - l.caja.y0;
    for (const w of l.palabras) {
      if (w.confianza < 20) continue;
      // línea de base del renglón a la altura de la palabra (si no viene, se estima desde la caja)
      const yEn = x => b && b.x1 !== b.x0 ? b.y0 + (b.y1 - b.y0) * (x - b.x0) / (b.x1 - b.x0) : w.caja.y1 - (w.caja.y1 - w.caja.y0) * 0.2;
      const p0 = vista.convertToPdfPoint(w.caja.x0, yEn(w.caja.x0)), p1 = vista.convertToPdfPoint(w.caja.x1, yEn(w.caja.x1));
      const ancho = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      if (ancho < 0.5) continue;
      palabras.push({ texto: w.texto, x: p0[0], y: p0[1], ang: Math.atan2(p1[1] - p0[1], p1[0] - p0[0]), ancho, tam: alto * 0.8 / vista.scale });
    }
  }
  return palabras;
}

// soloActual: solo la página que se está viendo (aunque ya tenga texto). Si no, todas las que no tienen texto.
export async function reconocerTexto(ctx, { soloActual = false } = {}) {
  const { el, api, aviso, pestana, aplicar } = ctx, p = pestana(), v = p?.visor;
  if (!v?.doc) return;
  const lista = soloActual ? [v.actual] : [...Array(v.total).keys()].map(i => i + 1);
  let cancelado = false;
  const barra = el('progress', { max: lista.length, value: 0, style: 'width:100%' }), texto = el('p', { class: 'sutil' }, 'Preparando…');
  const d = el('dialog', { class: 'dialogo' }, el('h3', {}, 'Reconociendo texto'), texto, barra,
    el('div', { class: 'dialogo-botones' }, el('button', { class: 'btn-texto boton-secundario', onclick: () => { cancelado = true; texto.textContent = 'Cancelando…'; } }, 'Cancelar')));
  d.addEventListener('cancel', e => { e.preventDefault(); cancelado = true; });
  document.body.append(d); d.showModal();
  const porPagina = new Map();
  let saltadas = 0;
  try {
    for (const [i, n] of lista.entries()) {
      if (cancelado) break;
      barra.value = i;
      if (!soloActual && (await v.texto(n)).replace(/\s/g, '').length > 20) { saltadas++; continue; } // ya tiene texto
      texto.textContent = `Página ${n} de ${v.total}…`;
      const palabras = await reconocerPagina(api, v.doc, n);
      if (palabras.length) porPagina.set(n, palabras);
    }
  } catch (e) { d.close(); d.remove(); return ctx.error(e); }
  d.close(); d.remove();
  if (cancelado && !porPagina.size) return aviso('Reconocimiento cancelado.');
  if (!porPagina.size) return aviso(saltadas ? 'Todas las páginas ya tienen texto: no hace falta reconocerlo.' : 'No se encontró texto para reconocer en esas páginas.');
  const k = porPagina.size;
  await aplicar(b => ops.agregarTextoOcr(b, porPagina), { mensaje: `Texto reconocido en ${k} ${k === 1 ? 'página' : 'páginas'}. Ya podés buscar, copiar, pintar y rellenar.` });
}

// ¿Parece un escaneo? (las primeras páginas no tienen texto)
export async function pareceEscaneado(v) {
  for (let n = 1; n <= Math.min(2, v.total); n++) if ((await v.texto(n)).replace(/\s/g, '').length > 20) return false;
  return true;
}
