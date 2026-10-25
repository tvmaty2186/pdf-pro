// pdf.pro — formas rápidas de llegar a las herramientas (ideas de la guía de Acrobat):
// la barra vertical pegada al documento, el panel "Todas las herramientas" y el menú que aparece al pintar un texto.
export class Herramientas {
  // ctx: { el, icono, a (acciones de app.js), comentarios, edicion, mascota, pestana(), prefs() }
  constructor(ctx) { this.ctx = ctx; this.abierto = false; this.filtro = ''; }

  // ---------- Lista de todas las herramientas ----------
  // hay: hay un documento abierto (y no se está organizando)
  catalogo() {
    const { icono: ic, a, comentarios: com, edicion, mascota } = this.ctx, p = this.ctx.pestana();
    const hay = !!p?.visor?.doc && !a.organizando(), usar = h => () => com.usar(h);
    return [
      ['Crear y convertir', [
        { t: 'Crear PDF desde imágenes', d: 'Fotos o escaneos (JPG, PNG, HEIC…) en un PDF', ic: ic.imagen, f: a.crearDesdeImagenes },
        { t: 'Unir varios PDF', d: 'Juntar archivos en uno solo', ic: ic.unir, f: a.unirVarios },
        { t: 'Word, Excel o PowerPoint a PDF', d: 'Abre el archivo convertido', ic: ic.word, f: a.officeAPdf },
        { t: 'Convertir a Word', d: 'Para seguir editando en Word', ic: ic.word, f: () => a.exportar('docx'), off: !hay },
        { t: 'Convertir a Excel', d: 'Las tablas pasan a planilla', ic: ic.organizar, f: () => a.exportar('xlsx'), off: !hay }]],
      ['Editar', [
        { t: 'Editar texto e imágenes', d: 'Cambiar lo que dice el PDF', ic: ic.editar, f: a.editar, activo: edicion.activo, off: !hay },
        { t: 'Organizar páginas', d: 'Mover, girar, borrar, insertar, separar', ic: ic.organizar, f: a.organizar, off: !p?.visor?.doc },
        { t: 'Reconocer texto (OCR)', d: 'Para buscar y copiar en escaneos', ic: ic.ocr, f: () => a.ocr(), off: !hay },
        { t: 'Reconocer texto de un área', d: 'Marcá una parte y copiala', ic: ic.ocr, f: usar('leer'), activo: com.herramienta === 'leer', off: !hay }]],
      ['Asistente', [
        { t: 'Resumir', d: 'El documento en pocas líneas', ic: ic.ia, f: a.resumir, off: !hay },
        { t: 'Preguntar', d: 'Lo que quieras del documento', ic: ic.ia, f: a.preguntar, off: !hay }]],
      ['Comentar', [
        { t: 'Resaltar', d: 'Pintá el texto', ic: ic.resaltar, f: usar('resaltar'), activo: com.herramienta === 'resaltar', off: !hay },
        { t: 'Subrayar', d: 'Pintá el texto', ic: ic.subrayar, f: usar('subrayar'), activo: com.herramienta === 'subrayar', off: !hay },
        { t: 'Tachar', d: 'Pintá el texto', ic: ic.tachar, f: usar('tachar'), activo: com.herramienta === 'tachar', off: !hay },
        { t: 'Nota', d: 'Un papelito con un comentario', ic: ic.nota, f: usar('nota'), activo: com.herramienta === 'nota', off: !hay },
        { t: 'Cuadro de texto', d: 'Escribir encima de la hoja', ic: ic.cuadroTexto, f: usar('texto'), activo: com.herramienta === 'texto', off: !hay },
        { t: 'Dibujar a mano', d: 'Con el mouse', ic: ic.dibujo, f: usar('dibujo'), activo: com.herramienta === 'dibujo', off: !hay },
        { t: 'Copiar área como imagen', d: 'Marcá un recuadro', ic: ic.captura, f: usar('captura'), activo: com.herramienta === 'captura', off: !hay }]],
      ['Rellenar y firmar', [
        { t: 'Rellenar', d: 'Escribir en los renglones del formulario', ic: ic.texto, f: usar('rellenar'), activo: com.herramienta === 'rellenar', off: !hay },
        { t: `Completar con ${mascota.nombre}`, d: 'Propone los datos de tus perfiles', ic: ic.ia, f: () => mascota.completar(), off: !hay },
        { t: 'Firmar', d: 'Poner una firma o sello guardado', ic: ic.firmar, f: (e, b) => a.menuFirmar(b), off: !hay },
        { t: 'Agregar firma o sello', d: 'Desde una foto, con el fondo quitado solo', ic: ic.firmar, f: a.agregarFirma }]],
      ['Documento', [
        { t: 'Comprimir', d: 'Achicar el archivo (para mandarlo por mail)', ic: ic.guardar, f: a.comprimir, off: !hay },
        { t: 'Numerar páginas', d: 'Abajo o arriba, desde la hoja que quieras', ic: ic.texto, f: a.numerar, off: !hay },
        { t: 'Quitar hojas en blanco', d: 'Las busca y te pregunta', ic: ic.eliminar, f: a.blancas, off: !hay },
        { t: 'Reparar un PDF dañado', d: 'Si no abre bien o se ve raro', ic: ic.escudo, f: a.reparar, off: !hay },
        { t: 'Censurar', d: 'Borra de verdad lo que marques', ic: ic.borrar, f: usar('censurar'), activo: com.herramienta === 'censurar', off: !hay },
        { t: 'Copia editable', d: 'De un PDF con firma digital', ic: ic.duplicar, f: a.copiaEditable, off: !hay },
        { t: 'Propiedades', d: 'Título, autor, páginas, tamaño', ic: ic.documento, f: a.propiedades, off: !hay },
        { t: 'Buscar un comando', d: 'Ctrl+K: escribí qué querés hacer', ic: ic.buscar, f: a.comandos }]],
      ['Proteger', [
        { t: 'Proteger con contraseña', d: 'Para abrir, imprimir o copiar', ic: ic.candado, f: a.proteger, off: !hay },
        { t: 'Quitar la contraseña', d: 'Al guardar queda sin clave', ic: ic.escudo, f: a.quitarClave, off: !p?.proteccion }]],
      ['Imprimir y leer', [
        { t: 'Imprimir', d: 'Con vista previa', ic: ic.imprimir, f: a.imprimir, off: !hay },
        { t: 'Buscar en el documento', d: 'Ctrl+F', ic: ic.buscar, f: a.buscar, off: !hay },
        { t: 'Leer en voz alta', d: 'Ctrl+Mayús+L', ic: ic.voz, f: a.leer, off: !hay }]]
    ];
  }

  // ---------- Panel "Todas las herramientas" (va en el panel lateral, en lugar de las miniaturas) ----------
  dibujarPanel(cont) {
    const { el, icono: ic } = this.ctx;
    const buscar = el('input', { class: 'campo herr-buscar', type: 'search', placeholder: 'Buscar una herramienta', value: this.filtro,
      oninput: e => { this.filtro = e.target.value; lista.replaceChildren(...this.grupos()); } });
    buscar.addEventListener('keydown', e => e.stopPropagation());
    const lista = el('div', { class: 'herr-lista' }, ...this.grupos());
    cont.replaceChildren(
      el('div', { class: 'herr-cabeza' }, el('b', {}, 'Todas las herramientas'),
        el('button', { class: 'btn-icono', title: 'Volver a las páginas', html: ic.cerrar, onclick: () => this.alternar(false) })),
      buscar, lista);
  }
  grupos() {
    const { el } = this.ctx, f = this.filtro.trim().toLowerCase();
    const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    return this.catalogo().map(([g, items]) => {
      const vis = items.filter(it => !f || norm(it.t + ' ' + it.d + ' ' + g).includes(norm(f)));
      if (!vis.length) return null;
      return el('section', { class: 'herr-grupo' }, el('h5', {}, g), ...vis.map(it => {
        const b = el('button', { class: 'herr-item', disabled: !!it.off, 'aria-pressed': String(!!it.activo), title: it.d },
          el('span', { class: 'herr-icono', html: it.ic }), el('span', { class: 'herr-textos' }, el('b', {}, it.t), el('small', {}, it.d)));
        b.addEventListener('mousedown', e => e.preventDefault());
        b.onclick = e => { it.f(e, b); this.refrescar(); };
        return b;
      }));
    }).filter(Boolean);
  }
  alternar(abrir = !this.abierto) { this.abierto = abrir; this.ctx.a.refrescarPanel(); this.actualizar(); }
  refrescar() { if (this.abierto) setTimeout(() => this.ctx.a.refrescarPanel(), 0); }

  // ---------- Barra vertical de herramientas rápidas ----------
  armarBarra() {
    const { el, icono: ic, a, comentarios: com } = this.ctx;
    // ícono con su nombre abajo: se reconoce sin tener que pasar el mouse
    const ETIQUETA = { seleccionar: 'Elegir', mano: 'Mano', resaltar: 'Resaltar', nota: 'Nota', texto: 'Texto', dibujo: 'Dibujar', rellenar: 'Rellenar', firmar: 'Firmar', editar: 'Editar', todas: 'Más' };
    const b = (id, icono, titulo, f) => { const x = el('button', { class: 'rapida', title: titulo, 'aria-label': titulo, html: icono + `<small>${ETIQUETA[id]}</small>`, 'data-rapida': id }); x.addEventListener('mousedown', e => e.preventDefault()); x.onclick = e => f(e, x); return x; };
    this.barra = document.querySelector('#rapidas');
    this.barra.append(
      b('seleccionar', ic.cursor, 'Seleccionar texto e imágenes (V)', () => this.usarMano(false)),
      b('mano', ic.mano, 'Mano: agarrar y arrastrar la hoja (H, o mantené apretada la barra espaciadora)', () => this.usarMano(true)),
      el('span', { class: 'sep' }),
      b('resaltar', ic.resaltar, 'Resaltar texto', () => com.usar('resaltar')),
      b('nota', ic.nota, 'Agregar una nota', () => com.usar('nota')),
      b('texto', ic.cuadroTexto, 'Cuadro de texto', () => com.usar('texto')),
      b('dibujo', ic.dibujo, 'Dibujar a mano', () => com.usar('dibujo')),
      el('span', { class: 'sep' }),
      b('rellenar', ic.texto, 'Rellenar formulario', () => com.usar('rellenar')),
      b('firmar', ic.firmar, 'Firmar', (e, x) => a.menuFirmar(x)),
      b('editar', ic.editar, 'Editar texto e imágenes', a.editar),
      el('span', { class: 'sep' }),
      b('todas', ic.todas, 'Todas las herramientas', () => this.alternar()));
    this.mano = this.ctx.prefs().cursor === 'mano';
    this.vigilarMano();
  }

  // ---------- Mano para agarrar y mover la hoja ----------
  // Elegida queda guardada; otra herramienta (resaltar, editar…) la reemplaza mientras se usa y después vuelve.
  usarMano(si) {
    const { comentarios: com, edicion } = this.ctx;
    com.terminarHerramienta(); edicion.terminar();
    this.mano = si; this.ctx.a.guardarPref('cursor', si ? 'mano' : 'seleccionar');
    if (si) getSelection().removeAllRanges();
    this.actualizar();
  }
  manoActiva() {
    const { comentarios: com, edicion } = this.ctx;
    return (this.mano || this.espacio) && !com.herramienta && !edicion.activo && !this.ctx.a.organizando();
  }
  vigilarMano() {
    const libre = e => !e.target.closest?.('input, textarea, select, [contenteditable]') && !document.querySelector('dialog[open]');
    document.addEventListener('keydown', e => {
      if (!this.ctx.pestana()?.visor?.doc || !libre(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'h' && !e.repeat) return this.usarMano(true);
      if (k === 'v' && !e.repeat) return this.usarMano(false);
      // barra espaciadora apretada: mano por un rato (en "una página" el espacio pasa de página)
      if (e.key === ' ' && this.ctx.pestana().visor.modo !== 'unica') { e.preventDefault(); e.stopImmediatePropagation(); if (!this.espacio) { this.espacio = true; this.actualizar(); } }
    }, true);
    document.addEventListener('keyup', e => { if (e.key === ' ' && this.espacio) { this.espacio = false; this.actualizar(); } });
    window.addEventListener('blur', () => { if (this.espacio) { this.espacio = false; this.actualizar(); } });
    document.addEventListener('pointerdown', e => {
      const doc = e.target.closest?.('.documento');
      if (e.button !== 0 || !doc || doc.dataset.mano !== '1') return;
      // las firmas, comentarios, casilleros y botones siguen respondiendo al clic
      if (e.target.closest('.estampa, .estampa-barra, .com, .com-barra, .com-popup, .com-editor, .campo-pdf, .fantasma, input, textarea, select, button, a, .mascota, .mascota-panel, .mascota-globo')) return;
      e.preventDefault(); e.stopPropagation();
      const x = e.clientX, y = e.clientY, sl = doc.scrollLeft, st = doc.scrollTop;
      doc.dataset.arrastrando = '1';
      const mover = ev => { doc.scrollLeft = sl - (ev.clientX - x); doc.scrollTop = st - (ev.clientY - y); };
      const soltar = () => { delete doc.dataset.arrastrando; removeEventListener('pointermove', mover); removeEventListener('pointerup', soltar); removeEventListener('pointercancel', soltar); };
      addEventListener('pointermove', mover); addEventListener('pointerup', soltar); addEventListener('pointercancel', soltar);
    }, true);
  }
  // Muestra la barra y marca la herramienta que está en uso
  actualizar() {
    if (!this.barra) return;
    const p = this.ctx.pestana(), { comentarios: com, edicion } = this.ctx;
    this.barra.hidden = !p?.visor?.doc || this.ctx.a.organizando() || this.ctx.prefs().rapidas === false;
    const activa = edicion.activo ? 'editar' : com.herramienta || (this.mano ? 'mano' : 'seleccionar');
    const mano = this.manoActiva() ? '1' : '';
    document.querySelectorAll('.documento').forEach(d => { if (d.dataset.mano !== mano) d.dataset.mano = mano; });
    this.barra.querySelectorAll('[data-rapida]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.rapida === activa || (x.dataset.rapida === 'todas' && this.abierto))));
  }

  // ---------- Menú que aparece al pintar un texto ----------
  vigilarSeleccion() {
    const revisar = () => setTimeout(() => this.mostrarMenuTexto(), 0);
    document.addEventListener('pointerup', e => { if (e.button === 0 && !e.target.closest?.('.sel-barra')) revisar(); });
    document.addEventListener('keyup', e => { if (e.shiftKey || e.key === 'Shift' || (e.ctrlKey && e.key.toLowerCase() === 'a')) revisar(); });
    document.addEventListener('selectionchange', () => { if (getSelection().isCollapsed) this.cerrarMenuTexto(); });
    document.addEventListener('pointerdown', e => { if (!e.target.closest?.('.sel-barra')) this.cerrarMenuTexto(); }, true);
    document.addEventListener('scroll', () => this.cerrarMenuTexto(), true);
  }
  cerrarMenuTexto() { this.menu?.remove(); this.menu = null; }
  mostrarMenuTexto() {
    const { el, icono: ic, a, comentarios: com, edicion, mascota } = this.ctx;
    const p = this.ctx.pestana(), v = p?.visor, sel = getSelection();
    this.cerrarMenuTexto();
    if (!v?.doc || sel.isCollapsed || com.herramienta || edicion.activo || a.organizando() || this.manoActiva()) return;
    const nodo = sel.anchorNode?.nodeType === 1 ? sel.anchorNode : sel.anchorNode?.parentElement;
    if (!nodo?.closest('.textLayer') || !v.el.contains(nodo)) return;
    const texto = sel.toString().replace(/\s+/g, ' ').trim();
    if (!texto) return;
    const rango = sel.getRangeAt(0).cloneRange(), r = rango.getBoundingClientRect(), primero = rango.getClientRects()[0] || r;
    const conRango = fn => () => { const s = getSelection(); s.removeAllRanges(); s.addRange(rango); this.cerrarMenuTexto(); fn(); };
    const b = (icono, t, f, clase = '') => { const x = el('button', { class: 'btn-icono ' + clase, title: t, 'aria-label': t, html: icono }); x.addEventListener('mousedown', e => e.preventDefault()); x.onclick = f; return x; };
    const bt = (icono, t, f) => { const x = el('button', { class: 'btn-texto', title: t, html: icono + `<span>${t}</span>` }); x.addEventListener('mousedown', e => e.preventDefault()); x.onclick = f; return x; };
    // la página y el punto (en la vista) donde empieza lo pintado, para "Editar"
    const div = document.elementsFromPoint(primero.left + 2, primero.top + primero.height / 2).find(x => x.classList?.contains('pagina'));
    const pg = div && v.paginas[div.dataset.n - 1];
    const editar = () => {
      if (!pg?.vista) return;
      const R = pg.div.getBoundingClientRect(), k = pg.vista.width / R.width;
      this.cerrarMenuTexto(); getSelection().removeAllRanges();
      a.editar(); edicion.editarEn(p, pg, (primero.left + 2 - R.left) * k, (primero.top + primero.height / 2 - R.top) * k);
    };
    const preguntar = () => { this.cerrarMenuTexto(); mascota.alternar(true); mascota.enviar(`Explicame en pocas palabras esta parte del documento: «${texto.slice(0, 1500)}»`); };
    this.menu = el('div', { class: 'sel-barra', role: 'toolbar', 'aria-label': 'Acciones con el texto pintado' },
      b(ic.resaltar, 'Resaltar', conRango(() => com.marcarSeleccion('resaltar'))),
      b(ic.subrayar, 'Subrayar', conRango(() => com.marcarSeleccion('subrayar'))),
      b(ic.tachar, 'Tachar', conRango(() => com.marcarSeleccion('tachar'))),
      b(ic.nota, 'Resaltar y escribir una nota', conRango(() => com.marcarSeleccion('resaltar', { conNota: true }))),
      el('span', { class: 'sep' }),
      b(ic.copiar, 'Copiar (Ctrl+C)', conRango(() => { document.execCommand('copy'); this.ctx.aviso('Texto copiado'); })),
      pg ? b(ic.editar, 'Editar este texto', editar) : null,
      el('span', { class: 'sep' }),
      bt(ic.ia, `Preguntar a ${mascota.nombre}`, preguntar));
    document.body.append(this.menu);
    // arriba de lo pintado; si no entra, abajo. Siempre dentro de la ventana.
    const w = this.menu.offsetWidth, h = this.menu.offsetHeight, m = 8;
    const x = Math.max(m, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - m));
    const y = r.top - h - 8 >= 90 ? r.top - h - 8 : Math.min(r.bottom + 8, innerHeight - h - m);
    Object.assign(this.menu.style, { left: x + 'px', top: y + 'px' });
  }
}
