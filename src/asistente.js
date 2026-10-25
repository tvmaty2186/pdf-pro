// PDF.Pro — la mascota: botón en la esquina, panel de charla, completar formularios con vista previa de colores y perfiles.
// Reglas del plan: no interrumpe (saluda una vez por documento y queda chiquita), siempre muestra antes de escribir,
// y todo lo que completa se deshace de una sola vez (Ctrl+Z). La parte de Claude corre en main.js (asistente.js).
import { ajustarCaja, LINEA, pintarComentarios, medidorPantalla } from './comentarios.js';
import { icono } from './iconos.js';

const COLOR = { seguro: '#1f9d55', duda: '#d4a017', no_se: '#d64545' };
const norm = t => String(t || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const CARA = `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="34" r="24" fill="var(--mascota-cuerpo)"/><circle cx="23" cy="31" r="4.5" fill="#fff"/><circle cx="41" cy="31" r="4.5" fill="#fff"/>
<circle class="ojo" cx="24" cy="32" r="2.3" fill="#1a1a1a"/><circle class="ojo" cx="42" cy="32" r="2.3" fill="#1a1a1a"/><path class="boca" d="M24 43c4 4 12 4 16 0" stroke="#1a1a1a" stroke-width="2.4" fill="none" stroke-linecap="round"/>
<path d="M14 18l6 6M50 18l-6 6" stroke="var(--mascota-cuerpo)" stroke-width="5" stroke-linecap="round"/></svg>`;

// Dónde va un texto que propone Claude (en puntos del PDF, y hacia arriba): según "ubicacion", con su tamaño y sus correcciones
function ubicarTexto(c, destino, etiqueta, pedazos, escritos, n) {
  const ref = c.ubicacion === 'como_existente' && escritos.find(e => e.id === c.como_id)?.c;
  let tam = c.tam > 0 ? c.tam : Math.min(14, Math.max(7, (ref?.tam || etiqueta.tam || 11))), x, arriba, letra = ref?.letra, tapar = c.ubicacion === 'tapando_destino';
  const arribaDe = base => base + 2 + 0.92 * tam;
  if (ref) {
    // el pedazo impreso que le corresponde al texto de referencia (su celda): el que más se le superpone, o el más cercano
    const cx = (ref.rect[0] + ref.rect[2]) / 2, cy = (ref.rect[1] + ref.rect[3]) / 2;
    const dist = x => Math.max(0, x.rect[0] - cx, cx - x.rect[2]) + 2 * Math.max(0, x.rect[1] - cy, cy - x.rect[3]);
    const ancla = pedazos.filter(x => !x.casillero).sort((a, b) => dist(a) - dist(b))[0] || destino;
    x = destino.rect[0] + (ref.rect[0] - ancla.rect[0]) + 2;
    arriba = destino.base[1] + (ref.rect[3] - ancla.base[1]);
    if (!(c.tam > 0)) tam = ref.tam;
    tapar = !!ref.tapar;
  } else if (c.ubicacion === 'centrado_en_destino' || tapar) {
    const w = medidorPantalla(tam, letra)(c.valor || '');
    x = tapar ? destino.rect[0] + 2 : (destino.rect[0] + destino.rect[2]) / 2 - w / 2;
    arriba = arribaDe(destino.base[1]);
  } else if (c.ubicacion === 'despues_de_etiqueta' || (c.ubicacion !== 'sobre_raya' && !destino.raya && destino === etiqueta)) {
    x = etiqueta.rect[2] + 4; arriba = arribaDe(etiqueta.base[1]);
  } else if (destino.raya || c.ubicacion === 'sobre_raya') {
    x = destino.rect[0] + 2; arriba = arribaDe(destino.base[1] + 1.5);
  } else { x = destino.rect[0]; arriba = arribaDe(destino.base[1]); }
  x += c.ajuste_x || 0; arriba += c.ajuste_y || 0;
  return { id: crypto.randomUUID(), n, tipo: 'texto', color: '#1a1a1a', rect: [x - 2, arriba - (tam * LINEA + 4), x + 40, arriba], tam, nota: c.valor || '', auto: true, ...(letra ? { letra } : {}), ...(tapar ? { tapar: true } : {}) };
}

// El audio grabado (webm) a WAV mono de 16 kHz: el formato que Gemini seguro entiende
async function aWav(datos) {
  const ac = new AudioContext(), buf = await ac.decodeAudioData(datos); ac.close();
  const off = new OfflineAudioContext(1, Math.ceil(buf.duration * 16000), 16000), src = off.createBufferSource();
  src.buffer = buf; src.connect(off.destination); src.start();
  const pcm = (await off.startRendering()).getChannelData(0), n = pcm.length, v = new DataView(new ArrayBuffer(44 + n * 2));
  const txt = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  txt(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); txt(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); txt(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return new Uint8Array(v.buffer);
}
export class Mascota {
  // ctx: { el, api, aviso, dialogo, pestana(), cambiarComentarios(p, lista, msg), prefs(), guardarPref(k, v), preferencias() }
  constructor(ctx) { this.ctx = ctx; this.historial = []; this.saludados = new Set(); this.propuesta = null; }
  get nombre() { return this.ctx.prefs().mascotaNombre || 'Pipo'; }

  // ---------- Botón y panel ----------
  armar() {
    const { el } = this.ctx;
    this.boton = el('button', { class: 'mascota', title: 'Asistente', 'aria-label': 'Asistente', html: CARA, onclick: () => this.alternar() });
    this.globo = el('div', { class: 'mascota-globo', hidden: true });
    this.mensajes = el('div', { class: 'mascota-mensajes' });
    this.entrada = el('textarea', { class: 'campo', rows: 2, placeholder: 'Pedile algo… (Enter para mandar)' });
    this.entrada.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.enviar(); } });
    const accion = (t, f) => el('button', { class: 'btn-texto mascota-accion', onclick: f }, t);
    this.panel = el('aside', { class: 'mascota-panel', hidden: true },
      el('header', {}, el('span', { class: 'mascota-mini', html: CARA }), el('b', { class: 'mascota-nombre' }, this.nombre),
        el('button', { class: 'btn-texto mascota-perfil', title: 'Cambiar el perfil con el que trabajo en este documento', hidden: true, onclick: () => { const p = this.ctx.pestana(); if (p?.visor?.doc) this.preguntarPerfil(p); } }),
        el('span', { class: 'espacio' }), this.selModelo = el('select', { class: 'mascota-modelo', title: 'Con qué modelo te respondo (se puede cambiar cuando quieras)', onchange: () => this.cambiarModelo() }),
        el('button', { class: 'btn-icono', title: 'Perfiles de datos', html: icono.persona, onclick: () => this.perfiles() }),
        el('button', { class: 'btn-icono', title: 'Cerrar', onclick: () => this.alternar(false) }, '✕')),
      this.mensajes,
      el('div', { class: 'mascota-acciones' }, accion('Completar este documento', () => this.completar()), accion('¿Qué es esto?', () => this.enviar('¿Qué documento es este? Decímelo en dos frases.')),
        accion('Resumir', () => this.enviar('Resumime este documento en pocas frases.')), accion('Estudiar ejemplos', () => this.estudiar())),
      this.chips = el('div', { class: 'mascota-adjuntos', hidden: true }),
      el('div', { class: 'mascota-escribir' },
        el('button', { class: 'btn-icono', title: 'Adjuntar imágenes o PDF (también podés arrastrarlos o pegarlos acá)', html: icono.clip, onclick: async () => (await this.ctx.api.asistenteElegirAdjuntos()).forEach(a => this.adjuntar(a.datos, a.nombre, a.tipo, false)) }),
        this.entrada, this.botonVoz = el('button', { class: 'btn-icono mascota-voz', title: 'Hablar (tocá para empezar y de nuevo para terminar)', html: icono.voz, onclick: () => this.dictar() }),
        el('button', { class: 'btn-primario', onclick: () => this.enviar() }, 'Mandar')));
    this.adjuntos = [];
    // arrastrar o pegar imágenes y PDF en el chat
    this.panel.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.stopPropagation(); this.panel.classList.add('soltando'); } });
    this.panel.addEventListener('dragleave', () => this.panel.classList.remove('soltando'));
    this.panel.addEventListener('drop', async e => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault(); e.stopPropagation(); this.panel.classList.remove('soltando');
      for (const f of e.dataTransfer.files) await this.adjuntarArchivo(f);
    });
    this.entrada.addEventListener('paste', async e => {
      const archivos = [...(e.clipboardData?.files || [])];
      if (!archivos.length) return;
      e.preventDefault();
      for (const f of archivos) await this.adjuntarArchivo(f);
    });
    this.ctx.api.alAsistenteProgreso?.(d => this.progreso(d));
    document.querySelector('#area').append(this.panel, this.globo, this.boton);
    this.hacerMovible();
    this.mostrar();
  }
  mostrar() { const si = this.ctx.prefs().mascota !== false; this.boton.hidden = !si; if (!si) { this.panel.hidden = true; this.globo.hidden = true; } this.panel.querySelector('.mascota-nombre').textContent = this.nombre; this.mostrarModelo(); }
  // Desplegable del chat: los modelos de Claude y de Gemini que tienen clave (el mismo que en Ajustes de la IA)
  async mostrarModelo() {
    const { el, api } = this.ctx, s = this.selModelo;
    const [d, e] = await Promise.all([api.asistenteDatos(), api.asistenteEstado()]).catch(() => [null, null]);
    if (!d) return;
    const corto = n => n.replace(/ \(.*\)$/, '');
    const grupo = (ia, titulo, lista, actual) => lista.length ? el('optgroup', { label: titulo }, ...lista.map(m => el('option', { value: ia + '|' + m.id, selected: d.proveedor === ia && m.id === actual }, m.id === 'auto' ? titulo + ': automático' : corto(m.nombre)))) : null;
    s.replaceChildren(...[e.tieneClaude || d.proveedor === 'claude' ? grupo('claude', 'Claude', d.modelosClaude, d.modelo) : null,
      grupo('gemini', 'Gemini', d.modelosGemini, d.modeloGemini)].filter(Boolean));
    s.hidden = !s.options.length;
  }
  async cambiarModelo() {
    const [ia, id] = this.selModelo.value.split('|');
    await this.ctx.api.asistenteGuardar(ia === 'gemini' ? { proveedor: 'gemini', modeloGemini: id } : { proveedor: 'claude', modelo: id });
    this.decir(id === 'auto' ? `Listo: uso ${ia === 'gemini' ? 'Gemini' : 'Claude'} y elijo el modelo según lo que me pidas.` : `Listo: ahora te respondo con ${this.selModelo.selectedOptions[0]?.textContent}.`);
  }
  alternar(abrir = this.panel.hidden) {
    this.panel.hidden = !abrir; this.globo.hidden = true;
    if (abrir) {
      this.ubicarChat?.();
      if (!this.mensajes.children.length) this.decir(`¡Hola! Soy ${this.nombre}. Completo y firmo documentos como vos, mirando tus ejemplos. Enseñame: pasame imágenes o PDF con el clip (o arrastralos acá), escribime la ruta de una carpeta con ejemplos, o decime “acordate que…”.`);
      this.entrada.focus();
      const p = this.ctx.pestana();
      if (p?.visor?.doc && p.perfil === undefined) this.preguntarPerfil(p);
    }
  }
  // Con qué perfil se trabaja en este documento: de ahí salen los datos y la carpeta de contexto
  async preguntarPerfil(p, luego = null) {
    const { el } = this.ctx, { perfiles } = await this.ctx.api.asistenteDatos();
    if (!perfiles.length) { p.perfil = ''; return luego?.(null); }
    if (perfiles.length === 1 && luego) { this.usarPerfil(p, perfiles[0].nombre); return luego(perfiles[0]); }
    const elegir = x => { this.usarPerfil(p, x?.nombre || ''); luego?.(x); };
    this.decir(`¿Con qué perfil trabajamos en “${p.nombre}”?`, { extra: el('div', { class: 'mascota-opciones' },
      ...perfiles.map(x => el('button', { class: 'btn-texto', title: x.carpeta ? 'Tiene carpeta de contexto' : '', html: (x.carpeta ? icono.carpeta : '') + `<span>${x.nombre.replace(/[<>&]/g, '')}</span>`, onclick: () => elegir(x) })),
      luego ? null : el('button', { class: 'btn-texto', onclick: () => elegir(null) }, 'Ninguno')) });
  }
  usarPerfil(p, nombre) {
    p.perfil = nombre;
    this.historial = [];
    this.mostrarPerfil();
    if (nombre) this.decir(`Listo, trabajo con “${nombre}”.`);
  }
  mostrarPerfil() {
    const p = this.ctx.pestana(), c = this.panel.querySelector('.mascota-perfil');
    c.hidden = !p?.visor?.doc;
    c.textContent = p?.perfil ? 'Perfil: ' + p.perfil : 'Elegir perfil';
  }
  estado(e) { this.boton.dataset.estado = e || ''; }

  // ---------- Ventana del chat: se arrastra desde arriba, se pega a un borde y se agranda desde bordes y esquinas ----------
  // Lugar guardado en Preferencias (chatLugar): { modo: 'libre'|'izq'|'der'|'arriba'|'abajo', x, y, w, h } en píxeles del área.
  hacerMovible() {
    const { el } = this.ctx, panel = this.panel, area = () => document.querySelector('#area').getBoundingClientRect();
    this.lugar = { modo: 'libre', w: 400, h: 560, ...(this.ctx.prefs().chatLugar || {}) };
    const M = 8, MIN_W = 300, MIN_H = 280;
    const guardar = () => this.ctx.guardarPref('chatLugar', this.lugar);
    this.ubicarChat = () => {
      const A = area(), L = this.lugar;
      L.w = Math.max(MIN_W, Math.min(L.w || 400, A.width - 2 * M)); L.h = Math.max(MIN_H, Math.min(L.h || 560, A.height - 2 * M));
      if (L.x == null) { L.x = A.width - L.w - 18; L.y = A.height - L.h - 86; }
      let r;
      if (L.modo === 'izq') r = { x: M, y: M, w: L.w, h: A.height - 2 * M };
      else if (L.modo === 'der') r = { x: A.width - L.w - M, y: M, w: L.w, h: A.height - 2 * M };
      else if (L.modo === 'arriba') r = { x: M, y: M, w: A.width - 2 * M, h: L.h };
      else if (L.modo === 'abajo') r = { x: M, y: A.height - L.h - M, w: A.width - 2 * M, h: L.h };
      else r = { x: Math.max(M, Math.min(L.x, A.width - L.w - M)), y: Math.max(M, Math.min(L.y, A.height - L.h - M)), w: L.w, h: L.h };
      Object.assign(panel.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px', right: 'auto', bottom: 'auto' });
      panel.dataset.modo = L.modo;
      return r;
    };
    // arrastrar desde la barra de arriba
    const cabeza = panel.querySelector('header');
    cabeza.title = 'Arrastrá para mover. Llevala contra un borde para pegarla ahí.';
    cabeza.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target.closest('button, select')) return; // el desplegable de modelo tiene que poder abrirse
      e.preventDefault();
      const A = area(), r0 = panel.getBoundingClientRect(), dx = e.clientX - r0.left, dy = e.clientY - r0.top;
      // si estaba pegada, se despega con el tamaño libre
      if (this.lugar.modo !== 'libre') { this.lugar.modo = 'libre'; this.lugar.x = e.clientX - A.left - Math.min(dx, this.lugar.w - 40); this.lugar.y = e.clientY - A.top - 16; }
      let borde = null;
      const mover = ev => {
        const x = ev.clientX - A.left, y = ev.clientY - A.top;
        this.lugar.x = x - Math.min(dx, this.lugar.w - 40); this.lugar.y = y - Math.min(dy, 30);
        borde = x < 30 ? 'izq' : x > A.width - 30 ? 'der' : y < 24 ? 'arriba' : y > A.height - 24 ? 'abajo' : null;
        panel.dataset.pegar = borde || '';
        this.ubicarChat();
      };
      const soltar = () => {
        removeEventListener('pointermove', mover); removeEventListener('pointerup', soltar);
        delete panel.dataset.pegar;
        if (borde) this.lugar.modo = borde;
        this.ubicarChat(); guardar();
      };
      addEventListener('pointermove', mover); addEventListener('pointerup', soltar);
    });
    // agrandar desde los bordes y las esquinas
    for (const lado of ['n', 's', 'e', 'o', 'ne', 'no', 'se', 'so']) {
      const asa = el('div', { class: 'chat-asa ' + lado });
      asa.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        const A = area(), r = this.ubicarChat(), x0 = e.clientX, y0 = e.clientY;
        const L = this.lugar, interno = { izq: 'e', der: 'o', arriba: 's', abajo: 'n' }[L.modo];
        if (L.modo !== 'libre' && lado !== interno) Object.assign(L, { modo: 'libre', x: r.x, y: r.y, w: r.w, h: r.h });
        const mover = ev => {
          const dx = ev.clientX - x0, dy = ev.clientY - y0;
          let { x, y, w, h } = r;
          if (lado.includes('e')) w = r.w + dx;
          if (lado.includes('o')) { w = r.w - dx; x = r.x + dx; }
          if (lado.includes('s')) h = r.h + dy;
          if (lado.includes('n')) { h = r.h - dy; y = r.y + dy; }
          w = Math.max(MIN_W, Math.min(w, A.width - 2 * M)); h = Math.max(MIN_H, Math.min(h, A.height - 2 * M));
          if (lado.includes('o')) x = r.x + r.w - w;
          if (lado.includes('n')) y = r.y + r.h - h;
          Object.assign(L, { x, y, w, h });
          this.ubicarChat();
        };
        const soltar = () => { removeEventListener('pointermove', mover); removeEventListener('pointerup', soltar); guardar(); };
        addEventListener('pointermove', mover); addEventListener('pointerup', soltar);
      });
      panel.append(asa);
    }
    new ResizeObserver(() => { if (!panel.hidden) this.ubicarChat(); }).observe(document.querySelector('#area'));
    this.ubicarChat();
  }
  // Saluda una sola vez por documento, sin abrir nada
  alAbrirDocumento(p) {
    // el globito aparece las primeras veces nada más, para no tapar la hoja siempre
    const veces = this.ctx.prefs().saludosMascota || 0;
    if (this.ctx.prefs().mascota === false || this.saludados.has(p.id) || veces >= 3) return;
    this.saludados.add(p.id); this.ctx.guardarPref('saludosMascota', veces + 1);
    this.globo.textContent = '¿Te ayudo con este documento? Tocame.';
    this.globo.hidden = false;
    clearTimeout(this.tGlobo); this.tGlobo = setTimeout(() => { this.globo.hidden = true; }, 6000);
  }
  decir(texto, { yo = false, extra = null } = {}) {
    const { el } = this.ctx;
    const m = el('div', { class: 'mascota-msg' + (yo ? ' yo' : '') }, el('div', { class: 'texto' }, texto), extra);
    this.mensajes.append(m); this.mensajes.scrollTop = this.mensajes.scrollHeight;
    return m;
  }

  // ---------- Charla ----------
  async textoDocumento(p, max = 30000) {
    const v = p.visor; let t = '';
    for (let n = 1; n <= v.total && t.length < max; n++) t += `\n--- Página ${n} ---\n` + (await v.texto(n)).replace(/[ \t]+/g, ' ');
    return t.slice(0, max);
  }
  // ---------- Adjuntos del chat (imágenes y PDF para que aprenda o los mire) ----------
  async adjuntarArchivo(f) {
    const tipo = f.type || (/\.pdf$/i.test(f.name) ? 'application/pdf' : '');
    if (!/^image\/|application\/pdf/.test(tipo)) return this.ctx.aviso('Al chat se le pueden pasar imágenes y PDF.', true);
    if (f.size > 30e6) return this.ctx.aviso('Ese archivo es muy grande (más de 30 MB).', true);
    this.adjuntar(new Uint8Array(await f.arrayBuffer()), f.name || 'imagen.png', tipo, false);
  }
  // datos: bytes; abrir: abre el chat y sugiere qué escribir (cuando viene de "Mandar al asistente")
  adjuntar(datos, nombre, tipo, abrir = true) {
    this.adjuntos.push({ datos: new Uint8Array(datos), nombre, tipo });
    this.dibujarAdjuntos();
    if (abrir) {
      if (this.panel.hidden) this.alternar(true);
      if (!this.entrada.value) this.entrada.value = 'Aprendé de esto: ';
      this.entrada.focus(); this.entrada.setSelectionRange(this.entrada.value.length, this.entrada.value.length);
    }
  }
  dibujarAdjuntos() {
    const { el } = this.ctx;
    this.chips.hidden = !this.adjuntos.length;
    this.chips.replaceChildren(...this.adjuntos.map((a, i) => el('span', { class: 'mascota-chip', title: a.nombre },
      el('span', { html: a.tipo === 'application/pdf' ? icono.documento : icono.imagen }), el('span', { class: 'nom' }, a.nombre),
      el('button', { class: 'btn-icono', title: 'Quitar', onclick: () => { this.adjuntos.splice(i, 1); this.dibujarAdjuntos(); } }, '✕'))));
  }
  progreso(d) {
    if (!this.msgEstudio || d.fin) { if (d.fin) { this.msgEstudio = null; } return; }
    this.msgEstudio.querySelector('.texto').textContent = `Estudiando ejemplos… ${d.hechas} de ${d.total}${d.archivo ? ` (${d.archivo})` : ''}`;
  }
  // Estudia la carpeta de ejemplos del perfil (y las rutas que le pasaron por el chat)
  async estudiar(perfil = this.ctx.pestana()?.perfil) {
    if (!perfil) return this.decir('Primero elegí con qué perfil trabajamos (arriba del chat).');
    const c = await this.ctx.api.asistenteCuantosEjemplos(perfil);
    if (!c.archivos) return this.decir('Este perfil no tiene carpeta de ejemplos. Elegila en Perfiles (el ícono de la persona, arriba) o pasame la ruta acá en el chat.');
    if (!c.nuevos) return this.decir(`Ya estudié los ${c.archivos} ejemplos de “${perfil}”. Si agregás más, decime “estudiá los ejemplos”.`);
    this.msgEstudio = this.decir(`Estudiando ejemplos… 0 de ${c.nuevos}`); this.estado('pensando');
    const r = await this.ctx.api.asistenteEstudiar(perfil);
    this.estado(); this.msgEstudio?.remove(); this.msgEstudio = null;
    if (!r.ok) return this.decir(r.error, { extra: this.botonClave(r.error) });
    this.decir(`Listo: estudié ${r.nuevos} ejemplos nuevos de “${perfil}” (${r.estudiados} en total${r.errores ? `, ${r.errores} no los pude leer` : ''}). Gasté US$ ${(r.costo || 0).toFixed(2)}. Ahora los uso para completar.`);
  }

  async enviar(texto = this.entrada.value.trim()) {
    const adjuntos = this.adjuntos.splice(0); this.dibujarAdjuntos();
    if (!texto && !adjuntos.length) return;
    texto ||= 'Mirá esto.';
    this.entrada.value = '';
    this.decir(texto + (adjuntos.length ? `\n📎 ${adjuntos.map(a => a.nombre).join(', ')}` : ''), { yo: true });
    const p = this.ctx.pestana();
    this.historial.push({ rol: 'yo', texto, adjuntos });
    const pensando = this.decir('Pensando…'); this.estado('pensando');
    let hist = this.historial.slice(-12); while (hist.length && hist[0].rol !== 'yo') hist = hist.slice(1); // Claude necesita que empiece el usuario
    const r = await this.ctx.api.asistenteCharlar({ historial: hist, perfil: p?.perfil || '', documento: p?.visor?.doc ? { nombre: p.nombre, texto: await this.textoDocumento(p) } : null });
    pensando.remove(); this.estado();
    if (!r.ok) { this.historial.pop(); return this.decir(r.error, { extra: this.botonClave(r.error) }); }
    const respuesta = r.rechazo ? 'Eso no lo puedo responder.' : r.texto || 'Listo.';
    this.historial.push({ rol: 'mascota', texto: respuesta });
    this.decir(respuesta + (r.aprendidos?.length ? `\n\n✔ Aprendí: ${r.aprendidos.join(' · ')}` : ''));
    for (const a of r.acciones || []) {
      if (a.tipo === 'completar') this.completar(a.indicaciones);
      if (a.tipo === 'estudiar') this.estudiar(p?.perfil);
    }
  }
  botonClave(error) {
    // sin saldo: el link a la página de Claude donde se carga
    if (/saldo/i.test(error || '')) return this.ctx.el('button', { class: 'btn-texto', onclick: () => window.open('https://console.anthropic.com/settings/billing') }, 'Cargar saldo');
    if (!/clave|Ajustes de la IA/.test(error || '')) return null;
    return this.ctx.el('button', { class: 'btn-texto', onclick: () => this.ctx.preferencias() }, 'Abrir Ajustes de la IA');
  }

  // ---------- Completar un formulario sin casilleros ----------
  // 1) pedazos de la página (MuPDF), 2) qué va en cada lugar: primero con los perfiles (sin internet) y, si hay clave, con Claude,
  // 3) vista previa en colores, 4) al aceptar se escriben como textos de Rellenar (un solo Ctrl+Z).
  async completar(indicaciones = '') {
    const p = this.ctx.pestana(), v = p?.visor;
    if (!v?.doc) return this.decir('Abrí primero el documento que querés completar.');
    if (this.panel.hidden) this.alternar(true);
    const { perfiles } = await this.ctx.api.asistenteDatos();
    if (!perfiles.length) return this.decir('Todavía no hay perfiles con datos (por ejemplo "Tizi" o "Cintia"). Creá uno y lo uso para completar.',
      { extra: this.ctx.el('button', { class: 'btn-texto', onclick: () => this.perfiles() }, 'Crear un perfil') });
    const ya = p.perfil && perfiles.find(x => x.nombre === p.perfil);
    if (ya) return this.completarCon(p, ya, indicaciones);
    this.preguntarPerfil(p, x => x && this.completarCon(p, x, indicaciones));
  }
  async completarCon(p, perfil, indicaciones = '') {
    const v = p.visor, n = v.actual;
    // si ya había una vista previa de esta página, Claude la recibe para aplicar las correcciones del usuario
    const previa = this.propuesta?.p === p && this.propuesta.n === n ? this.propuesta.propuestas.filter(x => x.com?.rect && !x.casillero && !x.firma) : [];
    // lo que el usuario ya escribió con Rellenar en esta página: Claude copia su lugar y tamaño (por ejemplo, la fila 1 de una tabla)
    const escritos = p.comentarios.filter(c => c.n === n && c.tipo === 'texto' && String(c.nota || '').trim()).map((c, i) => ({ id: 'e' + i, c }));
    this.limpiarPropuesta();
    this.decir(`Completar la página ${n} con "${perfil.nombre}"`, { yo: true });
    const pensando = this.decir('Mirando el formulario…'); this.estado('pensando');
    const cont = await this.ctx.api.paginaContenido(p.datos, n);
    const pedazos = cont.lineas.map((l, i) => ({ id: 'p' + i, texto: l.texto, raya: /^_+$/.test(l.texto.replace(/\s/g, '')), rect: l.rect, base: l.base, tam: l.fuente?.size || 11 }));
    // casilleros del formulario (si tiene): el nombre del casillero sirve de etiqueta; si es "fill_9" se usa el texto impreso a su izquierda
    const widgets = (await this.ctx.campos.todos(p)).filter(a => a.n === n);
    widgets.forEach((a, i) => {
      let nombre = a.alternativeText || a.fieldName.replace(/_\d+$/, '').replace(/\s+/g, ' ').trim();
      if (/^(fill|text|campo|untitled)[\s_]*\d*$/i.test(nombre) || nombre.length < 2) {
        const izq = pedazos.filter(x => !x.raya && Math.abs(x.base[1] - a.rect[1]) < 10 && x.rect[2] <= a.rect[0] + 4).sort((x, y) => y.rect[2] - x.rect[2])[0];
        nombre = izq ? izq.texto.replace(/_+/g, '').trim() : nombre;
      }
      pedazos.push({ id: 'c' + i, texto: nombre, raya: false, casillero: a, tilde: !!(a.checkBox || a.radioButton), rect: a.rect, base: [a.rect[0], a.rect[1]], tam: 10 });
    });
    let campos = this.porPerfil(pedazos, perfil), firmasIA = [], comentario = '';
    const estado = await this.ctx.api.asistenteEstado();
    if (estado.tieneClave) {
      pensando.querySelector('.texto').textContent = 'Mirando la hoja y tus ejemplos…';
      // Claude ve la página (con lo que ya tiene escrito encima) y la ubicación de cada pedazo, para relacionar imagen y texto
      const pagina = await v.doc.getPage(n), vp1 = pagina.getViewport({ scale: 1 }), vp = pagina.getViewport({ scale: 1.6 });
      const caja = r => { const [a, b, c, d] = vp1.convertToViewportRectangle(r); return [Math.min(a, c) / vp1.width, Math.min(b, d) / vp1.height, Math.max(a, c) / vp1.width, Math.max(b, d) / vp1.height].map(z => Math.round(z * 1000)); };
      let imagen = null;
      try {
        const lienzo = document.createElement('canvas'); lienzo.width = Math.floor(vp.width); lienzo.height = Math.floor(vp.height);
        const g = lienzo.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, lienzo.width, lienzo.height);
        await pagina.render({ canvasContext: g, viewport: vp }).promise;
        pintarComentarios(g, p.comentarios.filter(c => c.n === n), vp, { notas: false });
        imagen = new Uint8Array(await (await new Promise(r => lienzo.toBlob(r, 'image/png'))).arrayBuffer());
      } catch (e) { console.warn('Imagen de la página', e); }
      const firmasLib = this.ctx.firmas?.() || [];
      const r = await this.ctx.api.asistenteCompletar({
        pagina: { n, imagen, pedazos: pedazos.map(({ id, texto, raya, casillero, tilde, rect, tam }) => ({ id, texto, raya, caja: caja(rect), tam: casillero ? 0 : Math.round(tam * 10) / 10, casillero: casillero ? (tilde ? 'tilde' : 'texto') : null })),
          escritos: escritos.map(({ id, c }) => ({ id, caja: caja(c.rect), tam: c.tam, tapar: !!c.tapar, valor: c.nota })),
          anterior: previa.map(x => ({ destino_id: x.destino_id, valor: x.com.nota, caja: caja(x.com.rect), tam: x.com.tam, ubicacion: x.ubicacion, como_id: x.como_id, ajuste_x: x.ajuste_x, ajuste_y: x.ajuste_y })) },
        perfil: perfil.nombre, indicaciones, firmas: firmasLib.map(f => ({ nombre: f.nombre, tipo: f.tipo || 'firma' })),
        documento: { nombre: p.nombre, texto: (await this.textoDocumento(p, 4000)) } });
      if (r.ok && (r.campos?.length || r.firmas?.length)) { campos = r.campos || []; firmasIA = r.firmas || []; comentario = (r.comentario || '') + (r.ejemplos?.length ? ` (Me guié por: ${r.ejemplos.join(', ')})` : ''); }
      else if (!r.ok) { comentario = r.error + ' Uso solo los datos del perfil.'; if (/saldo/i.test(r.error)) this.decir(r.error, { extra: this.botonClave(r.error) }); }
    } else comentario = 'Completé solo con los datos del perfil, porque no hay clave de la IA (Asistente → Ajustes de la IA). Con la clave miro la hoja, tus ejemplos y lo que aprendí.';
    pensando.remove(); this.estado();
    const porId = new Map(pedazos.map(x => [x.id, x]));
    const propuestas = campos.map(c => {
      const destino = porId.get(c.destino_id) || porId.get(c.etiqueta_id), etiqueta = porId.get(c.etiqueta_id) || destino;
      if (!destino) return null;
      if (destino.casillero) { // va directo al casillero del formulario
        const a = destino.casillero, si = /^(s[ií]|x|true|on|✓)$/i.test(String(c.valor).trim());
        if (destino.tilde && !si) return null;
        return { ...c, etiqueta: destino.texto, casillero: a.fieldName, valorCasillero: destino.tilde ? (a.radioButton ? a.buttonValue : true) : c.valor,
          com: { n, rect: a.rect, tilde: destino.tilde, tam: Math.min(12, Math.max(7, (a.rect[3] - a.rect[1]) * 0.7)), nota: destino.tilde ? '✓' : c.valor || '' }, elegido: !!c.valor && c.seguridad !== 'no_se' };
      }
      const com = ubicarTexto(c, destino, etiqueta, pedazos, escritos, n);
      if (com.nota) com.rect = ajustarCaja(com);
      if (com.tapar) com.rect[2] = Math.max(com.rect[2], destino.rect[2] + 2); // tapa todo lo impreso ("--/--/----")
      return { ...c, etiqueta: etiqueta.texto.replace(/_+/g, '').trim(), com, valorOriginal: c.valor || '', elegido: !!c.valor && c.seguridad !== 'no_se' };
    }).filter(Boolean);
    // firmas y sellos: sobre la raya donde van, del ancho que se usa en los ejemplos (sin pasarse de la raya ni del alto del renglón)
    const lib = this.ctx.firmas?.() || [];
    for (const g of firmasIA) {
      const item = lib.find(f => norm(f.nombre) === norm(g.firma)) || lib.find(f => norm(f.nombre).includes(norm(g.firma)) || norm(g.firma).includes(norm(f.nombre)));
      let destino = porId.get(g.destino_id);
      if (!item || !destino || destino.casillero) continue;
      // si apuntó a la etiqueta "Firma", se busca la raya que está justo arriba (lo más común: ______ / Firma)
      if (!destino.raya) {
        const solapa = x => x.rect[0] < destino.rect[2] + 20 && x.rect[2] > destino.rect[0] - 20;
        destino = pedazos.find(x => x.raya && solapa(x) && x.rect[1] >= destino.rect[3] - 4 && x.rect[1] - destino.rect[3] < 30) || destino;
      }
      const r = destino.rect, prop = (item.alto || 1) / (item.ancho || 1);
      let w = Math.max(30, Math.min(300, (g.ancho_cm || (item.tipo === 'sello' ? 3.5 : 5)) * 72 / 2.54));
      if (destino.raya) w = Math.min(w, (r[2] - r[0]) * 1.05);
      let h = w * prop; if (h > 80) { h = 80; w = h / prop; }
      const cx = destino.raya ? (r[0] + r[2]) / 2 : r[2] + w / 2 + 6, cy = destino.raya ? r[1] + h * 0.4 : (r[1] + r[3]) / 2;
      propuestas.push({ firma: { id: crypto.randomUUID(), n, cx, cy, w, h, angulo: 0, png: item.bytes, nombre: item.nombre, clave: 'lib-' + item.id }, url: item.url,
        etiqueta: (item.tipo === 'sello' ? 'Sello: ' : 'Firma: ') + item.nombre, motivo: g.motivo || '', seguridad: 'duda', elegido: true, com: { nota: item.nombre } });
    }
    if (!propuestas.length) return this.decir(comentario || 'No encontré lugares para completar con ese perfil en esta página.');
    this.propuesta = { p, n, propuestas };
    this.dibujarPropuesta();
    this.mostrarPropuesta(comentario);
  }
  // Sin Claude: busca cada etiqueta del formulario entre los datos del perfil (por palabras parecidas)
  porPerfil(pedazos, perfil) {
    const campos = [], usados = new Set(), valoresUsados = new Set();
    const hayCasilleros = pedazos.some(x => x.casillero);
    pedazos.forEach((x, i) => {
      if (x.raya || (hayCasilleros && !x.casillero) || x.tilde) return; // si el formulario tiene casilleros, se completan esos
      const et = norm(x.texto.replace(/_+/g, ''));
      if (!et || et.length > 60) return;
      const palabras = new Set(et.split(' ').filter(w => w.length > 2));
      let mejor = null, puntos = 0;
      for (const c of perfil.campos) {
        if (!c.etiqueta || !c.valor) continue;
        const pc = norm(c.etiqueta).split(' ').filter(w => w.length > 2), comunes = pc.filter(w => palabras.has(w)).length;
        const s = comunes / Math.max(1, pc.length, palabras.size);
        if (s > puntos) { puntos = s; mejor = c; }
      }
      if (!mejor || puntos < 0.5 || usados.has(x.id)) return;
      const sig = pedazos[i + 1];
      const destino = sig?.raya && Math.abs(sig.base[1] - x.base[1]) < 4 ? sig : x;
      usados.add(x.id);
      // el mismo dato en dos lugares (por ejemplo dos "DNI:") puede ser de otra persona: queda para revisar
      const repetido = valoresUsados.has(mejor.valor); valoresUsados.add(mejor.valor);
      campos.push({ etiqueta_id: x.id, destino_id: destino.id, valor: mejor.valor, seguridad: puntos >= 0.99 && !repetido ? 'seguro' : 'duda', motivo: repetido ? `Perfil: ${mejor.etiqueta} (ya usado arriba: revisá)` : `Perfil: ${mejor.etiqueta}` });
    });
    return campos;
  }
  // Vista previa: el texto "fantasma" en su lugar, con borde verde (seguro), amarillo (duda) o rojo (no sabe)
  dibujarPropuesta() {
    document.querySelectorAll('.fantasma').forEach(x => x.remove());
    const pr = this.propuesta; if (!pr) return;
    const pg = pr.p.visor.paginas[pr.n - 1]; if (!pg?.vista) return;
    const v = pg.vista, { el } = this.ctx;
    for (const [i, x] of pr.propuestas.entries()) {
      if (x.firma) {
        const f = x.firma, [a, b, c, d] = v.convertToViewportRectangle([f.cx - f.w / 2, f.cy - f.h / 2, f.cx + f.w / 2, f.cy + f.h / 2]);
        pg.div.append(el('img', { class: 'fantasma firma' + (x.elegido ? '' : ' apagado'), src: x.url, alt: '', title: x.etiqueta, 'data-i': i,
          style: `left:${Math.min(a, c) / v.width * 100}%;top:${Math.min(b, d) / v.height * 100}%;width:${Math.abs(c - a) / v.width * 100}%;height:${Math.abs(d - b) / v.height * 100}%;--c:${COLOR.duda}` }));
        continue;
      }
      const [a, b, c, d] = v.convertToViewportRectangle(x.com.rect);
      pg.div.append(el('div', { class: 'fantasma' + (x.elegido ? '' : ' apagado') + (x.com.tapar ? ' tapar' : ''), title: `${x.etiqueta}: ${x.motivo || ''}`, 'data-i': i,
        style: `left:${Math.min(a, c) / v.width * 100}%;top:${Math.min(b, d) / v.height * 100}%;min-width:${Math.max(18, Math.abs(c - a)) / v.width * 100}%;` +
          `height:${Math.abs(d - b) / v.height * 100}%;font-size:${x.com.tam * v.scale}px;--c:${COLOR[x.seguridad] || COLOR.duda}` }, x.com.nota || '?'));
    }
  }
  mostrarPropuesta(comentario) {
    const { el } = this.ctx, pr = this.propuesta;
    const lista = el('div', { class: 'mascota-campos' }, ...pr.propuestas.map((x, i) => {
      const caja = el('input', { type: 'checkbox', checked: x.elegido, disabled: !x.com.nota, onchange: e => { x.elegido = e.target.checked; this.dibujarPropuesta(); } });
      if (x.firma) return el('label', { class: 'mascota-campo', style: `--c:${COLOR.duda}` }, caja, el('span', { class: 'etq', title: x.motivo || '' }, x.etiqueta), el('span', { class: 'sutil' }, 'Después la podés mover o agrandar'));
      const valor = el('input', { class: 'campo', value: x.com.nota, placeholder: 'escribilo vos', onchange: e => {
        x.com.nota = e.target.value.trim(); if (x.casillero) { if (!x.com.tilde) x.valorCasillero = x.com.nota; } else x.com.rect = ajustarCaja(x.com); x.elegido = !!x.com.nota; caja.disabled = !x.com.nota; caja.checked = x.elegido;
        if (x.com.nota && x.seguridad === 'no_se') x.seguridad = 'duda'; this.dibujarPropuesta(); } });
      return el('label', { class: 'mascota-campo', style: `--c:${COLOR[x.seguridad] || COLOR.duda}` }, caja, el('span', { class: 'etq', title: x.motivo || '' }, x.etiqueta || '—'), valor);
    }));
    const verdes = pr.propuestas.filter(x => x.seguridad === 'seguro').length, amarillos = pr.propuestas.filter(x => x.seguridad === 'duda').length, rojos = pr.propuestas.length - verdes - amarillos;
    this.propuestaMsg = this.decir(`${comentario ? comentario + ' ' : ''}Te muestro lo que pondría: ${verdes} seguros (verde), ${amarillos} para revisar (amarillo)${rojos ? ` y ${rojos} que no sé (rojo)` : ''}. Revisá y aceptá.`, {
      extra: el('div', {}, lista, el('div', { class: 'mascota-opciones' },
        el('button', { class: 'btn-primario', onclick: () => this.aceptar() }, 'Aceptar los marcados'),
        el('button', { class: 'btn-texto', onclick: () => { this.limpiarPropuesta(); this.decir('Listo, no escribí nada.'); } }, 'Cancelar'))) });
  }
  aceptar() {
    const pr = this.propuesta; if (!pr) return;
    const elegidos = pr.propuestas.filter(x => x.elegido && x.com.nota);
    this.limpiarPropuesta();
    if (!elegidos.length) return this.decir('No había nada marcado.');
    const textos = elegidos.filter(x => !x.casillero && !x.firma).map(x => x.com);
    const casilleros = Object.fromEntries(elegidos.filter(x => x.casillero).map(x => [x.casillero, x.valorCasillero === true ? true : (x.valorCasillero ?? x.com.nota)]));
    const firmas = elegidos.filter(x => x.firma).map(x => x.firma);
    const nuevos = elegidos;
    // los rojos que quedaron vacíos: si después los completás a mano con Rellenar, te pregunto si me acuerdo (alCambiarComentarios)
    this.rojos = { p: pr.p, n: pr.n, items: pr.propuestas.filter(x => !x.firma && !x.casillero && !x.elegido && x.seguridad === 'no_se' && x.com?.rect).map(x => ({ etiqueta: x.etiqueta, rect: x.com.rect })) };
    this.ctx.aplicarPropuesta(pr.p, textos, casilleros, `${this.nombre} completó ${nuevos.length} ${nuevos.length === 1 ? 'dato' : 'datos'} (Ctrl+Z para deshacer todo)`, firmas);
    // lo que corregiste antes de aceptar queda aprendido para la próxima (en este perfil)
    const perfil = pr.p.perfil;
    // (los que estaban en rojo y completaste vos: pregunto antes, porque pueden ser de una sola vez)
    const deRojo = elegidos.filter(x => !x.firma && !x.valorOriginal && x.com.nota);
    if (perfil) for (const x of elegidos.filter(x => !x.firma && x.valorOriginal && x.com.nota !== x.valorOriginal)) {
      const doc = pr.p.nombre.replace(/\.pdf$/i, '');
      this.ctx.api.asistenteAprender(perfil, x.valorOriginal
        ? `En documentos como "${doc}", en «${x.etiqueta}» va «${x.com.nota}» (no «${x.valorOriginal}»).`
        : `En documentos como "${doc}", en «${x.etiqueta}» va «${x.com.nota}».`, 'correccion');
    }
    this.decir(`Listo, escribí ${nuevos.length}. Si algo no va, Ctrl+Z lo saca todo junto. Lo podés mover o corregir con "Rellenar".`);
    if (perfil) for (const x of deRojo) this.ofrecerReceta(pr.p, x.etiqueta, x.com.nota);
  }
  // Dictado: graba el micrófono y Gemini lo pasa a texto; queda en el cuadro para revisarlo antes de mandar
  async dictar() {
    const b = this.botonVoz;
    if (this.grabando) { this.grabando.stop(); return; }
    let flujo;
    try { flujo = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { return this.decir('No pude usar el micrófono. Fijate que esté conectado y que Windows deje usarlo (Configuración → Privacidad → Micrófono).'); }
    const partes = [], rec = new MediaRecorder(flujo, { mimeType: 'audio/webm' });
    rec.ondataavailable = e => e.data.size && partes.push(e.data);
    rec.onstop = async () => {
      flujo.getTracks().forEach(t => t.stop()); this.grabando = null; b.classList.remove('grabando'); b.title = 'Hablar (tocá para empezar y de nuevo para terminar)';
      let audio;
      try { audio = await aWav(await new Blob(partes, { type: 'audio/webm' }).arrayBuffer()); } catch { return this.decir('No se grabó nada. Probá de nuevo.'); }
      if (audio.length < 8000) return; // menos de un cuarto de segundo
      this.estado('pensando'); b.disabled = true;
      const r = await this.ctx.api.asistenteTranscribir(audio, 'audio/wav').catch(e => ({ ok: false, error: e.message }));
      this.estado(''); b.disabled = false;
      if (!r.ok) return this.decir(r.error, { extra: this.botonClave(r.error) });
      if (!r.texto) return this.decir('No te entendí. Probá de nuevo, más cerca del micrófono.');
      this.entrada.value = (this.entrada.value ? this.entrada.value + ' ' : '') + r.texto; this.entrada.focus();
    };
    rec.start(); this.grabando = rec; b.classList.add('grabando'); b.title = 'Grabando… tocá para terminar';
  }
  // Un rojo que quedó vacío y lo completaste a mano (Rellenar) cerca de su lugar: te pregunto si lo aprendo
  alCambiarComentarios(p, antes, nuevas) {
    const r = this.rojos;
    if (!r || r.p !== p || !p.perfil || !r.items.length) return;
    const cerca = (a, b) => Math.min(a[2], b[2]) + 14 > Math.max(a[0], b[0]) && Math.min(a[3], b[3]) + 8 > Math.max(a[1], b[1]);
    for (const c of nuevas) {
      if (c.tipo !== 'texto' || c.n !== r.n || !c.nota?.trim() || antes.find(a => a.id === c.id)?.nota?.trim()) continue; // solo lo recién escrito
      const item = r.items.find(i => cerca(i.rect, c.rect));
      if (!item) continue;
      r.items = r.items.filter(i => i !== item);
      this.ofrecerReceta(p, item.etiqueta, c.nota.trim());
    }
  }
  // La receta: "en tal lugar va tal cosa". Si parece de una sola vez (fecha, monto, mes), lo aclaro; "cambia cada vez"
  // también se guarda, así la próxima lo marco para revisar en vez de inventarlo
  ofrecerReceta(p, etiqueta, valor) {
    const { el, api } = this.ctx, perfil = p.perfil, doc = p.nombre.replace(/\.pdf$/i, '');
    if (!perfil || !etiqueta) return;
    const variable = /\d{1,2}\s*[\/.-]\s*\d{1,2}|\b(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b|\$|\b\d+[.,]\d{2}\b|\b(19|20)\d{2}\b/i.test(valor);
    let msg;
    const listo = t => { msg?.querySelectorAll('button').forEach(b => { b.disabled = true; }); this.decir(t); };
    msg = this.decir(`En «${etiqueta}» pusiste «${valor}».${variable ? ' Parece un dato que cambia (fecha, mes o monto).' : ''} ¿Me lo acuerdo para la próxima?`, { extra: el('div', { class: 'mascota-opciones' },
      el('button', { class: 'btn-texto', onclick: () => { api.asistenteAprender(perfil, `En documentos como "${doc}", en «${etiqueta}» va «${valor}».`, 'rojo'); listo('Listo, la próxima lo pongo yo.'); } }, 'Sí, siempre'),
      el('button', { class: 'btn-texto', onclick: () => { api.asistenteAprender(perfil, `En documentos como "${doc}", «${etiqueta}» cambia cada vez (por ejemplo «${valor}»): deducilo del documento o de las indicaciones; si no se puede, dejalo para revisar.`, 'rojo'); listo('Anotado: la próxima te lo marco para revisar.'); } }, 'No, cambia cada vez'),
      el('button', { class: 'btn-texto', onclick: () => listo('Bueno, no lo guardo.') }, 'No')) });
  }
  // al aceptar, cancelar o pedir otra, los botones y casillas de esa propuesta quedan apagados (no se puede aceptar dos veces)
  limpiarPropuesta() {
    this.propuesta = null; document.querySelectorAll('.fantasma').forEach(x => x.remove());
    this.propuestaMsg?.querySelectorAll('button, input').forEach(x => { x.disabled = true; });
    this.propuestaMsg?.classList.add('cerrada'); this.propuestaMsg = null;
  }
  redibujar() { if (this.propuesta) this.dibujarPropuesta(); }

  // ---------- Perfiles de datos ----------
  async perfiles() {
    const { el, dialogo, api } = this.ctx;
    const datos = await api.asistenteDatos();
    const perfiles = structuredClone(datos.perfiles || []);
    let actual = 0;
    const lista = el('div', { class: 'perfiles-lista' }), detalle = el('div', { class: 'perfiles-detalle' });
    const guardables = () => perfiles.map(x => ({ nombre: x.nombre.trim() || 'Perfil', carpeta: x.carpeta || '', ejemplosExtra: x.ejemplosExtra || [], aprendizajes: x.aprendizajes || [],
      campos: x.campos.filter(c => c.etiqueta.trim() || c.valor.trim()) }));
    const dibujar = () => {
      lista.replaceChildren(...perfiles.map((x, i) => el('button', { class: 'perfil-item', 'aria-pressed': String(i === actual), onclick: () => { actual = i; dibujar(); } }, x.nombre || '(sin nombre)')),
        el('button', { class: 'btn-texto', onclick: () => { perfiles.push({ nombre: 'Nuevo perfil', campos: [{ etiqueta: 'Apellido y nombre', valor: '' }, { etiqueta: 'DNI', valor: '' }] }); actual = perfiles.length - 1; dibujar(); } }, '+ Perfil nuevo'));
      const x = perfiles[actual];
      if (!x) return detalle.replaceChildren(el('p', { class: 'sutil' }, 'Creá un perfil (por ejemplo "Tizi", "Cintia" o "Obra social") con los datos que se repiten en los formularios.'));
      const nombre = el('input', { class: 'campo', value: x.nombre, oninput: e => { x.nombre = e.target.value; lista.children[actual].textContent = x.nombre || '(sin nombre)'; } });
      const filas = x.campos.map((c, j) => el('div', { class: 'perfil-campo' },
        el('input', { class: 'campo', value: c.etiqueta, placeholder: 'Dato (ej. Domicilio)', oninput: e => { c.etiqueta = e.target.value; } }),
        el('input', { class: 'campo', value: c.valor, placeholder: 'Valor', oninput: e => { c.valor = e.target.value; } }),
        el('button', { class: 'btn-icono', title: 'Quitar', onclick: () => { x.campos.splice(j, 1); dibujar(); } }, '✕')));
      const carpeta = el('div', { class: 'carpeta-ruta', title: x.carpeta || '' }, x.carpeta || 'Sin carpeta de contexto');
      const filaCarpeta = el('div', { class: 'perfil-carpeta' }, el('span', { class: 'sutil' }, 'Carpeta de contexto (los papeles de esta persona: autorizaciones, informes, formularios ya hechos)'),
        el('div', { class: 'imp-control' }, carpeta,
          el('button', { class: 'btn-texto boton-secundario', onclick: async () => { const c = await api.elegirCarpeta(x.carpeta); if (c) { x.carpeta = c; dibujar(); } } }, 'Elegir…'),
          x.carpeta ? el('button', { class: 'btn-texto boton-secundario', onclick: () => { x.carpeta = ''; dibujar(); } }, 'Quitar') : null));
      // ejemplos agregados desde el chat ("acá tenés ejemplos: C:\…") y cuántos se estudiaron
      const extras = (x.ejemplosExtra || []).map((r, j) => el('div', { class: 'perfil-extra' }, el('span', { class: 'carpeta-ruta', title: r }, r),
        el('button', { class: 'btn-icono', title: 'Quitar', onclick: () => { x.ejemplosExtra.splice(j, 1); dibujar(); } }, '✕')));
      const estudio = el('div', { class: 'imp-control' }, el('span', { class: 'sutil' }, `Ejemplos estudiados: ${datos.estudiados?.[x.nombre] || 0}`),
        el('button', { class: 'btn-texto boton-secundario', title: 'Mira cada ejemplo (con lo rellenado y las firmas) y aprende cómo se completa', onclick: async () => {
          await api.asistenteGuardar({ perfiles: guardables() }); this.alternar(true); this.estudiar(x.nombre); } }, 'Estudiar ejemplos ahora'));
      const aprendido = (x.aprendizajes || []).map((a, j) => el('div', { class: 'perfil-aprendido' }, el('span', {}, a.texto),
        el('button', { class: 'btn-icono', title: 'Olvidar esto', onclick: () => { x.aprendizajes.splice(j, 1); dibujar(); } }, '✕')));
      detalle.replaceChildren(el('label', { class: 'firma-fila' }, el('span', { class: 'sutil' }, 'Nombre del perfil'), nombre), filaCarpeta, ...extras, estudio,
        el('h5', { class: 'perfil-titulo' }, `Lo que aprendí (${aprendido.length})`),
        aprendido.length ? el('div', { class: 'perfil-aprendidos' }, ...aprendido) : el('p', { class: 'sutil' }, 'Todavía nada. Enseñame en el chat ("acordate que…"), pasame ejemplos o corregí lo que propongo.'),
        el('h5', { class: 'perfil-titulo' }, 'Datos'), ...filas,
        el('div', { class: 'mascota-opciones' },
          el('button', { class: 'btn-texto', onclick: () => { x.campos.push({ etiqueta: '', valor: '' }); dibujar(); } }, '+ Agregar dato'),
          el('button', { class: 'btn-texto', title: 'Trae lo que escribiste con Rellenar en otros formularios', onclick: () => { this.importarRellenos(x); dibujar(); } }, 'Traer lo que recuerda Rellenar'),
          el('button', { class: 'btn-texto peligro', onclick: () => { perfiles.splice(actual, 1); actual = 0; dibujar(); } }, 'Borrar perfil')));
    };
    dibujar();
    const r = await dialogo({ titulo: 'Perfiles de datos', texto: 'Los datos que se repiten en los formularios. Se guardan cifrados, solo en esta computadora.',
      contenido: el('div', { class: 'perfiles' }, lista, detalle), clase: 'dialogo-ancho', botones: [{ t: 'Cancelar', v: null }, { t: 'Guardar', v: 'ok', primario: true }] });
    if (!r) return;
    await api.asistenteGuardar({ perfiles: guardables() });
    this.ctx.aviso('Perfiles guardados.');
  }
  // Lo que Rellenar recordó por etiqueta ("domicilio" → "Gral. Ferre 221") pasa al perfil
  importarRellenos(perfil) {
    const et = this.ctx.prefs().rellenos?.etiquetas || {};
    const ya = new Set(perfil.campos.map(c => norm(c.etiqueta)));
    for (const [etiqueta, valores] of Object.entries(et)) {
      const nombre = etiqueta.replace(/\b\w/g, l => l.toUpperCase());
      if (!valores?.[0] || ya.has(norm(nombre))) continue;
      perfil.campos.push({ etiqueta: nombre, valor: valores[0] });
    }
  }
}
