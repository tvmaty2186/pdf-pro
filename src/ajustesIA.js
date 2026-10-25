// PDF.Pro — Ajustes de la IA (menú Asistente): con qué inteligencia trabaja el asistente (Claude o Gemini), su clave,
// su modelo y la mascota. Lo del programa (impresora, archivos…) está en src/preferencias.js. Cada cambio se guarda al instante.
const IAS = {
  claude: { nombre: 'Claude', empieza: 'sk-ant-…', enlace: 'https://console.anthropic.com/settings/keys', sitio: 'console.anthropic.com',
    texto: 'De Anthropic. Se paga por uso: centavos por consulta.' },
  gemini: { nombre: 'Gemini', empieza: 'AIza…', enlace: 'https://aistudio.google.com/apikey', sitio: 'aistudio.google.com',
    texto: 'De Google. Con la clave gratis de AI Studio no se paga.' }
};

let alBajar = null, escuchando = false; // el avance de la bajada va a la ventana de ajustes abierta

export async function abrirAjustesIA(ctx) {
  const { el, api, dialogo } = ctx;
  const prefs = ctx.prefs();
  const guardar = (clave, valor) => { prefs[clave] = valor; return ctx.guardarPref(clave, valor); };
  const fila = (t, control) => el('div', { class: 'pref-fila' }, el('span', {}, t), control);
  const seccion = (titulo, ...cosas) => el('section', { class: 'pref-seccion' }, el('h4', {}, titulo), ...cosas);
  const boton = (t, f) => el('button', { class: 'btn-texto boton-secundario', onclick: f }, t);

  const est = await api.asistenteEstado(), d = await api.asistenteDatos();
  let ia = d.proveedor || 'claude';
  const tiene = { claude: est.tieneClaude, gemini: est.tieneGemini };

  // Elegir la IA: dos botones grandes, el elegido marcado
  const opciones = el('div', { class: 'ia-opciones' });
  const zona = el('div');
  const dibujarOpciones = () => opciones.replaceChildren(...Object.entries(IAS).map(([k, x]) =>
    el('button', { class: 'ia-opcion' + (k === ia ? ' elegida' : ''), 'aria-pressed': String(k === ia),
      onclick: async () => { if (k === ia) return; ia = k; await api.asistenteGuardar({ proveedor: k }); dibujarOpciones(); dibujarZona(); ctx.alCambiarMascota?.(); } },
      el('b', {}, x.nombre), el('small', {}, x.texto))));

  // Lo de la IA elegida: su clave y su modelo
  function dibujarZona() {
    const x = IAS[ia];
    const cClave = el('input', { class: 'campo', type: 'password', placeholder: tiene[ia] ? '•••••••• (ya está guardada)' : x.empieza, style: 'width:100%;text-align:left' });
    const estado = el('small', { class: 'sutil' }, tiene[ia] ? 'Clave guardada.' : 'Todavía no hay clave: sin ella, la mascota completa solo con tus perfiles.');
    const cModelo = el('select', { class: 'campo', style: 'width:100%' });
    const precio = el('small', { class: 'sutil' });
    const llenarModelos = () => {
      const lista = ia === 'claude' ? d.modelosClaude : d.modelosGemini, actual = ia === 'claude' ? d.modelo : d.modeloGemini;
      cModelo.replaceChildren(...(lista.length ? lista.map(m => el('option', { value: m.id, selected: m.id === actual }, m.nombre)) : [el('option', { value: '' }, 'Primero guardá la clave')]));
      cModelo.disabled = !lista.length;
      precio.textContent = lista.find(m => m.id === cModelo.value)?.precio || '';
    };
    cModelo.onchange = async () => {
      if (ia === 'claude') { d.modelo = cModelo.value; await api.asistenteGuardar({ modelo: cModelo.value }); }
      else { d.modeloGemini = cModelo.value; await api.asistenteGuardar({ modeloGemini: cModelo.value }); }
      llenarModelos(); ctx.alCambiarMascota?.();
    };
    const guardarClave = async valor => {
      estado.textContent = valor ? 'Guardando y probando…' : 'Borrando…';
      let r;
      if (ia === 'gemini') {
        r = await api.asistenteClaveGemini(valor);
        if (r.ok) { const dd = await api.asistenteDatos(); d.modelosGemini = dd.modelosGemini; d.modeloGemini = dd.modeloGemini; }
      } else {
        r = await api.asistenteClave(valor);
        if (r.ok && valor) { const p = await api.asistenteProbar(); r = p.ok ? r : p; }
      }
      if (!r.ok) { estado.textContent = r.error; return; }
      tiene[ia] = !!valor; cClave.value = ''; cClave.placeholder = valor ? '•••••••• (ya está guardada)' : x.empieza;
      estado.textContent = !valor ? 'Clave borrada.' : ia === 'gemini' ? `¡Funciona! Google respondió con ${d.modelosGemini.length - 1} ${d.modelosGemini.length === 2 ? "modelo" : "modelos"}. Abajo elegí uno o dejá Automático.` : '¡Funciona! Claude respondió.';
      llenarModelos(); ctx.alCambiarMascota?.();
    };
    llenarModelos();
    const tope = ia === 'claude' ? fila('Tope de gasto por mes (US$)', el('div', { class: 'imp-control' },
      el('input', { class: 'campo', type: 'number', min: 0, step: 1, value: d.tope ?? 5, style: 'width:80px', onchange: e => api.asistenteGuardar({ tope: +e.target.value || 0 }) }),
      el('small', { class: 'sutil' }, `Este mes: US$ ${est.gasto.toFixed(2)}`))) : null;
    zona.replaceChildren(
      el('p', { class: 'sutil' }, `La clave se saca en ${x.sitio}. `, el('a', { href: x.enlace, target: '_blank', class: 'enlace' }, 'Crear la clave →')),
      fila('Clave de ' + x.nombre, cClave),
      el('div', { class: 'imp-control' }, boton('Guardar y probar', () => cClave.value.trim() && guardarClave(cClave.value.trim())), boton('Borrar', () => guardarClave('')), estado),
      fila('Modelo', el('div', {}, cModelo, precio)),
      ...(tope ? [tope] : []));
  }
  dibujarOpciones(); dibujarZona();

  // IA sin internet: bajar el modelo una vez (lo elige el programa según la memoria de la PC)
  const local = el('div');
  const gb = n => (n / 1e9).toFixed(1).replace('.', ',') + ' GB';
  async function dibujarLocal(b) {
    const e = await api.iaLocalEstado(); b ||= e.bajada;
    const r = e.recomendado, barra = el('progress', { class: 'ia-local-barra', max: b?.total || 1, value: b?.bajado || 0 });
    const poca = e.memoriaGB < 7.5 ? ` Tu PC tiene ${Math.round(e.memoriaGB)} GB de memoria: puede andar lento.` : '';
    let cosas;
    if (b && !b.error && !b.listo) cosas = [el('p', { class: 'sutil' }, `Bajando ${b.nombre}: ${gb(b.bajado)} de ${gb(b.total)}. Podés cerrar esta ventana, sigue bajando.`), barra,
      el('div', { class: 'imp-control' }, boton('Cancelar', () => api.iaLocalCancelarBajada()))];
    else if (e.modelo) cosas = [el('p', { class: 'sutil' }, `Listo: ${e.modelo} está en tu PC. Usalo desde Asistente → Resumir.`),
      el('div', { class: 'imp-control' }, boton('Borrar el modelo', async () => { await api.iaLocalBorrar(); dibujarLocal(); }))];
    else cosas = [el('p', { class: 'sutil' }, `Resume y responde preguntas sin mandar nada a internet. Se baja una sola vez: para tu PC conviene ${r.nombre} (${gb(r.tam)}).${poca}`),
      ...(b?.error && b.error !== 'cancelada' ? [el('p', { class: 'dialogo-error' }, b.error)] : []),
      el('div', { class: 'imp-control' }, el('button', { class: 'btn-primario', onclick: () => api.iaLocalBajar() }, b?.bajado ? 'Seguir bajando' : `Bajar (${gb(r.tam)})`))];
    local.replaceChildren(...cosas);
  }
  alBajar = b => { if (local.isConnected) dibujarLocal(b); };
  if (!escuchando) { api.alIaLocalBajada(b => alBajar?.(b)); escuchando = true; }
  dibujarLocal();

  const cNombre = el('input', { class: 'campo', value: prefs.mascotaNombre || 'Pipo', maxlength: 20, style: 'width:100%;text-align:left', onchange: e => { guardar('mascotaNombre', e.target.value.trim() || 'Pipo'); ctx.alCambiarMascota?.(); } });
  const cMostrar = el('input', { type: 'checkbox', checked: !!prefs.mascota, onchange: e => { guardar('mascota', e.target.checked); ctx.alCambiarMascota?.(); } });
  const contenido = el('div', { class: 'pref' },
    seccion('Con qué inteligencia trabaja', opciones, zona),
    seccion('Sin internet', local),
    seccion('Mascota',
      fila('Nombre', cNombre),
      el('label', { class: 'pref-casilla' }, cMostrar, el('span', {}, el('b', {}, 'Mostrar la mascota'), el('small', {}, 'Si la apagás, igual queda en el menú Asistente.'))),
      el('p', { class: 'sutil' }, 'Los datos de cada persona y la carpeta de ejemplos se eligen en Asistente → Perfiles de datos.')));
  setTimeout(() => document.querySelector('dialog[open] .dialogo-botones .btn-primario')?.focus(), 0);
  await dialogo({ titulo: 'Ajustes de la IA', contenido, clase: 'dialogo-ancho', botones: [{ t: 'Listo', v: null, primario: true }] });
}
