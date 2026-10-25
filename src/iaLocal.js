// PDF.Pro — IA sin internet: resumen y preguntas sobre el documento con el modelo de la PC (ia-local-cliente.js).
// Un panel que no bloquea el programa: arriba el resumen que se va escribiendo, abajo una caja para preguntar.
// Se puede achicar (sigue trabajando en segundo plano) y avisa cuando termina; cerrarlo (×) corta lo que esté haciendo.
let sig = 1;
const escuchas = new Map();
let conectado = false;

import { PDFDocument, StandardFonts, rgb } from '../node_modules/pdf-lib/dist/pdf-lib.esm.min.js';

// el modelo escribe con viñetas "- " y **negritas**: renglones con sus partes en negrita o no
const renglones = texto => texto.trim().split('\n').map(l => l.replace(/^\s*[-*•]\s+/, '• ').replace(/^#+\s*/, '')
  .split(/\*\*(.+?)\*\*/g).map((t, i) => ({ t, b: i % 2 === 1 })).filter(p => p.t));
function pintar(el, caja, texto) {
  caja.replaceChildren(...renglones(texto).map(l => el('div', {}, ...l.map(p => p.b ? el('b', {}, p.t) : p.t))));
}

// el resumen como PDF: hoja A4, título y renglones partidos al ancho, con negritas
async function resumenPdf(titulo, lineas) {
  const doc = await PDFDocument.create(), normal = await doc.embedFont(StandardFonts.Helvetica), negrita = await doc.embedFont(StandardFonts.HelveticaBold);
  const limpio = t => t.replace(/[^\x20-\x7e\xa0-\xff•–—“”‘’…€]/g, ''); // solo lo que entra en la letra básica
  const M = 56, ANCHO = 595 - 2 * M, TAM = 11, ALTO = 16;
  let pg = doc.addPage([595, 842]), y = 842 - M;
  const nueva = () => { if (y < M) { pg = doc.addPage([595, 842]); y = 842 - M; } };
  pg.drawText(limpio(titulo), { x: M, y: y - 6, size: 16, font: negrita, color: rgb(0.1, 0.05, 0.07) }); y -= 36;
  for (const l of lineas) {
    // palabras con su letra, y se van poniendo hasta llenar el renglón
    const palabras = l.flatMap(p => limpio(p.t).split(/(?<= )/).filter(Boolean).map(t => ({ t, f: p.b ? negrita : normal })));
    let x = M;
    nueva();
    for (const w of palabras) {
      const ancho = w.f.widthOfTextAtSize(w.t, TAM);
      if (x + ancho > M + ANCHO && x > M) { y -= ALTO; nueva(); x = M + (l[0]?.t.startsWith('• ') ? normal.widthOfTextAtSize('• ', TAM) : 0); }
      pg.drawText(w.t, { x, y, size: TAM, font: w.f, color: rgb(0.1, 0.05, 0.07) }); x += ancho;
    }
    y -= ALTO + 4;
  }
  return doc.save();
}

const paneles = new Map(); // un panel por documento

export async function sinInternet(ctx, p, { resumir = true } = {}) {
  const { el, api, dialogo } = ctx;
  const est = await api.iaLocalEstado();
  if (!est.modelo) {
    const r = await dialogo({ titulo: 'Asistente', texto: est.bajada && !est.bajada.error ? 'El modelo se está bajando. Mirá cómo va en Ajustes de la IA.' : 'Para usarlo primero hay que bajar el modelo, una sola vez. Se hace desde Ajustes de la IA.',
      botones: [{ t: 'Ahora no', v: null }, { t: 'Ir a Ajustes de la IA', v: 'si', primario: true }] });
    if (r) ctx.ajustesIA?.();
    return;
  }
  if (!conectado) { api.alIaLocal(d => escuchas.get(d.clave)?.(d)); conectado = true; }
  let panel = paneles.get(p);
  if (!panel) { panel = await armarPanel(ctx, p, est.modelo); paneles.set(p, panel); }
  for (const otro of paneles.values()) if (otro !== panel) otro.achicar();
  panel.mostrar();
  if (resumir && !panel.resumido) panel.resumir(); else panel.pregunta.focus();
}

async function armarPanel(ctx, p, modelo) {
  const { el, api, aviso, textoDocumento } = ctx;
  const base = p.nombre.replace(/\.pdf$/i, '');
  const texto = await textoDocumento(p, 400000);
  const salida = el('div', { class: 'ia-local-salida' }), estado = el('p', { class: 'sutil ia-local-estado' });
  const pregunta = el('input', { class: 'campo', placeholder: 'Preguntá algo del documento…', style: 'flex:1;text-align:left' });
  const boton = el('button', { class: 'btn-primario' }, 'Preguntar');
  const claves = [];
  let ocupado = 0;
  const raiz = el('section', { class: 'ia-panel', role: 'dialog', 'aria-label': 'Asistente: ' + p.nombre },
    el('header', { class: 'ia-panel-cabecera' }, el('h3', { title: p.nombre }, base),
      el('button', { class: 'btn-icono ia-achicar', title: 'Achicar: sigue trabajando y te aviso cuando termina', onclick: () => achicar() }, '—'),
      el('button', { class: 'btn-icono ia-cerrar', title: 'Cerrar (corta lo que esté haciendo)', onclick: () => cerrar() }, '×')),
    el('div', { class: 'ia-panel-cuerpo' }, salida, estado, el('div', { class: 'ia-local-preguntar' }, pregunta, boton)));
  // achicado queda un botón chiquito abajo que muestra cómo va; tocarlo lo abre de nuevo
  const chip = el('button', { class: 'ia-chip', hidden: true, onclick: () => mostrar() });
  document.body.append(raiz, chip);
  const ponerChip = () => { chip.textContent = `${ocupado ? '⏳ ' + (estado.textContent.startsWith('Leyendo') || estado.textContent.startsWith('Juntando') ? estado.textContent.replace('…', '') : 'Pensando') : '✓ Listo'} · ${base}`; };
  function mostrar() { raiz.hidden = false; chip.hidden = true; }
  function achicar() { if (raiz.hidden) return; raiz.hidden = true; chip.hidden = false; ponerChip(); }
  function cerrar() {
    for (const c of claves) api.iaLocalCortar(c).catch(() => {});
    raiz.remove(); chip.remove(); paneles.delete(p);
  }
  // terminó: si no se está mirando (achicado o el programa en otra ventana), aviso abajo y del sistema
  function avisarFin(que) {
    if (!raiz.isConnected || (!raiz.hidden && document.hasFocus())) return;
    const txt = `${que}: ${p.nombre}`;
    aviso(txt, false, { t: 'Ver', f: () => mostrar() });
    try {
      const n = new Notification('pdf.pro', { body: txt, silent: false });
      n.onclick = () => { window.focus(); mostrar(); };
    } catch {}
  }
  // un pedido: escribe en un bloque nuevo a medida que llega
  async function correr(titulo, pedir, listo) {
    const clave = 'l' + sig++; claves.push(clave);
    const bloque = el('div', { class: 'ia-local-bloque' }), cuerpo = el('div', { class: 'ia-local-texto' });
    let escrito = '';
    bloque.append(el('h4', {}, titulo), cuerpo); salida.append(bloque);
    estado.textContent = `Pensando con ${modelo} en tu PC (sin internet)…`;
    boton.disabled = true; ocupado++; ponerChip();
    escuchas.set(clave, d => {
      if (d.paso) { estado.textContent = d.paso; ponerChip(); }
      if (d.trozo) { pintar(el, cuerpo, escrito += d.trozo); salida.scrollTop = salida.scrollHeight; }
    });
    try {
      const r = await pedir(clave);
      const final = r.texto || escrito;
      pintar(el, cuerpo, final);
      estado.textContent = r.aviso || 'Listo. Lo hizo tu PC, sin mandar nada a internet.';
      if (titulo === 'Resumen' && final.trim()) bloque.append(el('div', { class: 'ia-local-acciones' }, el('button', { class: 'btn-texto boton-secundario', onclick: async () => {
        const lineas = renglones(final), t = `Resumen de ${base}`;
        const g = await api.guardarResumen(`${base} - resumen`, p.carpeta, { titulo: t, lineas, pdf: await resumenPdf(t, lineas) });
        // el PDF se abre en una pestaña nueva de pdf.pro (no por Windows: abría otra copia del programa y rompía la ventana)
        if (g) aviso(`Guardado: ${g.nombre}`, false, { t: 'Abrir', f: () => /\.pdf$/i.test(g.ruta) && ctx.abrirRutas ? ctx.abrirRutas([g.ruta]) : api.abrirConSistema(g.ruta) });
      } }, 'Guardar como…')));
      avisarFin(listo);
    } catch (e) {
      if (!escrito) cuerpo.textContent = '—';
      estado.textContent = String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      avisarFin('No se pudo terminar');
    } finally { escuchas.delete(clave); boton.disabled = false; ocupado--; ponerChip(); if (!raiz.hidden) pregunta.focus(); }
  }
  const preguntar = () => {
    const q = pregunta.value.trim();
    if (!q || boton.disabled) return;
    pregunta.value = '';
    correr(q, clave => api.iaLocalPreguntar(clave, texto, q), 'Respuesta lista');
  };
  boton.onclick = preguntar;
  pregunta.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); preguntar(); } if (e.key === 'Escape') achicar(); });
  const panel = { pregunta, mostrar, achicar, cerrar, resumido: false,
    resumir() { panel.resumido = true; correr('Resumen', clave => api.iaLocalResumir(clave, texto), 'Resumen listo'); } };
  return panel;
}

// al cerrar un documento se cierra su panel (y se corta lo que estaba haciendo)
export function cerrarPanel(p) { paneles.get(p)?.cerrar(); }
