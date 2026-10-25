// PDF.Pro — ventana de Preferencias (lo del programa; lo de la IA está en src/ajustesIA.js). Cada cambio se guarda y se aplica al instante.
import { opcionesPapel } from './imprimir.js';

export async function abrirPreferencias(ctx) {
  const { el, api, dialogo } = ctx;
  const prefs = ctx.prefs();
  const impresoras = await api.impresoras().catch(() => []);
  const guardar = (clave, valor) => { prefs[clave] = valor; return ctx.guardarPref(clave, valor); };

  const select = (clave, valores, alCambiar) => {
    const s = el('select', { class: 'campo' }, ...valores.map(([v, t]) => el('option', { value: v, selected: String(prefs[clave]) === String(v) }, t)));
    s.onchange = () => { const v = s.value === 'true' ? true : s.value === 'false' ? false : /^\d+(\.\d+)?$/.test(s.value) ? +s.value : s.value; guardar(clave, v); alCambiar?.(v); };
    return s;
  };
  const casilla = (clave, texto, ayuda, alCambiar) => {
    const c = el('input', { type: 'checkbox', checked: !!prefs[clave] });
    c.onchange = () => { guardar(clave, c.checked); alCambiar?.(c.checked); };
    return el('label', { class: 'pref-casilla' }, c, el('span', {}, el('b', {}, texto), ayuda ? el('small', {}, ayuda) : null));
  };
  const fila = (t, control) => el('div', { class: 'pref-fila' }, el('span', {}, t), control);
  const seccion = (titulo, ...cosas) => el('section', { class: 'pref-seccion' }, el('h4', {}, titulo), ...cosas);

  const cerrarBandeja = casilla('cerrarABandeja', 'Al cerrar la ventana, seguir abierto junto al reloj', 'Para volver, hacé clic en el ícono. Para cerrar del todo: clic derecho en el ícono → Salir.');
  const iniciar = casilla('iniciarConWindows', 'Iniciar con Windows', 'Arranca escondido junto al reloj, listo para usar.');
  const dependientes = [cerrarBandeja, iniciar];
  const actualizar = v => dependientes.forEach(d => { d.classList.toggle('apagado', !v); d.querySelector('input').disabled = !v; });

  // Papel: lista común + tamaño personalizado (ancho × alto en cm)
  const imp = () => prefs.impresion || {};
  const cPapel = el('select', { class: 'campo' }, ...opcionesPapel(el, String(prefs.papelPredeterminado || 'A4').startsWith('imp:') ? 'Personalizado' : prefs.papelPredeterminado || 'A4'));
  const num = v => el('input', { class: 'campo', type: 'number', min: 2, max: 120, step: 0.1, value: v, style: 'width:64px' });
  const cAncho = num(imp().papelW || 21), cAlto = num(imp().papelH || 29.7);
  const filaMedida = fila('Medida', el('div', { class: 'imp-medida' }, cAncho, el('span', {}, '×'), cAlto, el('span', { class: 'sutil' }, 'cm')));
  const guardarPapel = () => {
    const v = cPapel.value, lim = (x, d) => Math.min(120, Math.max(2, +x || d));
    guardar('papelPredeterminado', v);
    guardar('impresion', { ...imp(), papel: v, ...(v === 'Personalizado' ? { papelW: lim(cAncho.value, 21), papelH: lim(cAlto.value, 29.7) } : {}) });
    filaMedida.hidden = v !== 'Personalizado';
  };
  filaMedida.hidden = cPapel.value !== 'Personalizado';
  for (const c of [cPapel, cAncho, cAlto]) c.onchange = guardarPapel;
  // Protección al editar: lo que el editor y la mascota no tocan sin preguntar
  const cCodigos = el('input', { type: 'checkbox', checked: prefs.protegerCodigos !== false, onchange: e => guardar('protegerCodigos', e.target.checked) });
  const cTextos = el('textarea', { class: 'campo', rows: 3, placeholder: 'Uno por renglón. Por ejemplo: Folio Nº', style: 'width:100%;height:auto;text-align:left;resize:vertical',
    onchange: e => guardar('textosProtegidos', e.target.value) });
  cTextos.value = prefs.textosProtegidos || '';
  cTextos.addEventListener('keydown', e => e.stopPropagation());
  const contenido = el('div', { class: 'pref' },
    seccion('Apariencia',
      fila('Tema', select('tema', [['sistema', 'Igual que Windows'], ['claro', 'Claro'], ['oscuro', 'Oscuro']], v => ctx.cambiarTema(v))),
      fila('Tu nombre (para el saludo)', el('input', { class: 'campo', value: prefs.nombre || '', maxlength: 30, placeholder: 'Opcional', style: 'width:100%;text-align:left',
        onchange: e => { guardar('nombre', e.target.value.trim()); ctx.alCambiarNombre?.(); } })),
      fila('Panel de páginas y comentarios', select('panelLado', [['izquierda', 'A la izquierda'], ['derecha', 'A la derecha']], v => ctx.cambiarLadoPanel?.(v)))),
    seccion('Al abrir un PDF',
      fila('Tamaño inicial', select('zoomInicial', [['ancho', 'Ajustar al ancho'], ['pagina', 'Página completa'], ['1', 'Tamaño real (100%)']])),
      fila('Forma de ver', select('modo', [['continuo', 'Desplazamiento continuo'], ['doble', 'Dos páginas'], ['unica', 'Una página']])),
      casilla('panel', 'Mostrar el panel de páginas', null, () => ctx.refrescarPanel())),
    seccion('Ícono junto al reloj',
      casilla('bandeja', 'Mostrar el ícono de PDF.Pro junto al reloj', 'Con clic derecho: abrir, crear PDF desde imágenes, recientes y más.', actualizar),
      cerrarBandeja, iniciar),
    seccion('Clic derecho en el Explorador de Windows',
      casilla('menuPdf', '"Abrir con PDF.Pro" en los PDF'),
      casilla('menuImagenes', '"Crear PDF con PDF.Pro" en las imágenes JPG y PNG', 'Si elegís varias imágenes juntas, se arma un solo PDF.'),
      el('p', { class: 'sutil' }, 'En Windows 11 aparecen en "Mostrar más opciones".')),
    seccion('Impresión',
      fila('Impresora', select('impresoraPredeterminada', [['', 'La predeterminada de Windows'], ...impresoras.map(i => [i.name, i.displayName || i.name])])),
      fila('Papel', cPapel), filaMedida),
    seccion('Firmas y sellos',
      fila('Ancho al poner una firma', select('anchoFirmaCm', [3, 4, 4.5, 5, 5.5, 6, 7, 8].map(v => [v, String(v).replace('.', ',') + ' cm'])))),
    seccion('Protección al editar',
      el('label', { class: 'pref-casilla' }, cCodigos, el('span', {}, el('b', {}, 'Cuidar códigos, CUIT, DNI y números de trámite'), el('small', {}, 'Si al editar un párrafo uno de esos números cambia o desaparece, pregunta antes de guardarlo. La mascota tampoco los cambia.'))),
      fila('Textos que no se tocan', cTextos)));
  actualizar(!!prefs.bandeja);
  // que arranque con el foco en Listo
  setTimeout(() => document.querySelector('dialog[open] .dialogo-botones .btn-primario')?.focus(), 0);
  await dialogo({ titulo: 'Preferencias', contenido, clase: 'dialogo-ancho', botones: [{ t: 'Listo', v: null, primario: true }] });
}
