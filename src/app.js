// PDF.Pro — interfaz principal: menús, pestañas, barra de comandos, panel lateral
import { Visor } from './visor.js';
import { icono } from './iconos.js';
import * as ops from './paginas.js';
import { Organizador, extraerPaginas, separarDocumento, textoRango } from './organizar.js';
import { Firmas, pintarFirmas } from './firmas.js';
import { Comentarios, pintarComentarios, TIPOS, COLORES, esMarca, hoy } from './comentarios.js';
import { abrirImpresion } from './imprimir.js';
import { abrirPreferencias } from './preferencias.js';
import { abrirAjustesIA } from './ajustesIA.js';
import { sinInternet, cerrarPanel } from './iaLocal.js';
import { repetirHaciaAbajo } from './repetir.js';
import { recorrido } from './recorrido.js';
import { reconocerTexto, pareceEscaneado } from './ocr.js';
import { Edicion } from './edicion.js';
import { Mascota } from './asistente.js';
import { Campos } from './campos.js';
import { Herramientas } from './herramientas.js';
import { Fuentes } from './fuentes.js';

const $ = s => document.querySelector(s);
const raiz = document.documentElement;
const api = window.pdfpro;
const fuentesApp = new Fuentes(api); // las fuentes de Windows y de Mis fuentes (editar, cuadros de texto, Rellenar)
const estado = { pestanas: [], activa: null, prefs: {}, leyendo: false, organizador: null, portapapeles: null };
const MAX_DESHACER = 20;

// ---------- Utilidades ----------
function el(tag, props = {}, ...hijos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...hijos.filter(h => h != null));
  return e;
}
let temporizadorAviso;
function aviso(texto, error = false, accion = null) {
  // el aviso queda en la barra de abajo hasta que llega otro (no tapa nada); después de un rato se pone gris
  const a = $('#aviso');
  a.replaceChildren(el('span', { title: texto }, texto));
  if (accion) a.append(el('button', { class: 'btn-texto aviso-accion', onclick: () => { avisoVacio(); accion.f(); } }, accion.t));
  a.classList.toggle('error', error); a.classList.remove('vacio'); a.hidden = false;
  clearTimeout(temporizadorAviso);
  if (!error && !accion) temporizadorAviso = setTimeout(() => a.classList.add('vacio'), Math.max(15000, texto.length * 150));
}
function avisoVacio() { const a = $('#aviso'); a.replaceChildren(el('span', {}, 'Listo')); a.classList.remove('error'); a.classList.add('vacio'); }
// Los errores que vienen del sistema llegan en inglés y con detalles técnicos: se pasan a algo entendible
function textoError(e) {
  const m = String(e?.message || e || '').replace(/^Error invoking remote method '[^']+': /, '').replace(/^(\w*Error): /, '');
  if (/EBUSY|EPERM|EACCES/.test(m)) return 'El archivo está abierto en otro programa o no hay permiso para usarlo.';
  if (/ENOSPC/.test(m)) return 'El disco está lleno.';
  if (/ENOENT/.test(m)) return 'No se encontró el archivo.';
  if (/out of memory|Array buffer allocation/i.test(m)) return 'Falta memoria para este documento.';
  // nuestros propios mensajes están en castellano: se muestran tal cual
  return /[áéíóúñ¿¡]|^(No |Esta |Este |El |La |Ese |Elegí|Primero|Falta)/.test(m) && m.length < 200 ? m : 'No se pudo completar la acción.';
}
function mostrarError(e) {
  if (!(e instanceof ops.ErrorProtegido)) api.anotarError('aviso', e?.message || String(e), { pila: e?.stack }).catch(() => {});
  if (e instanceof ops.ErrorProtegido) aviso('Este PDF tiene contraseña: por ahora no se pueden cambiar sus páginas.', true);
  else aviso(textoError(e), true);
  console.error(e);
}

// Ventana de diálogo genérica. Devuelve { boton, raiz } o null si se cancela.
function dialogo({ titulo, texto, contenido, botones, validar, clase = '' }) {
  return new Promise(resolver => {
    const errorEl = el('p', { class: 'dialogo-error', hidden: true });
    const d = el('dialog', { class: 'dialogo ' + clase },
      // lo de adentro se desplaza; los botones quedan siempre abajo, nunca encima del contenido
      el('div', { class: 'dialogo-cuerpo' }, el('h3', {}, titulo), texto ? el('p', { class: 'sutil' }, texto) : null, contenido || null, errorEl),
      el('div', { class: 'dialogo-botones' }, ...botones.map(b => el('button', {
        class: b.primario ? 'btn-primario' : 'btn-texto boton-secundario',
        onclick: () => {
          if (b.v != null && b.v !== 'no' && validar) { const msg = validar(d); if (msg) { errorEl.textContent = msg; errorEl.hidden = false; return; } }
          d.close(); resolver(b.v == null ? null : { boton: b.v, raiz: d });
        }
      }, b.t))));
    d.addEventListener('cancel', () => resolver(null));
    d.addEventListener('close', () => setTimeout(() => d.remove(), 0));
    document.body.append(d); d.showModal();
    (d.querySelector('input:not([type=radio]):not([type=checkbox])') || d.querySelector('.btn-primario'))?.focus();
  });
}
function hace(fecha) {
  const min = Math.round((Date.now() - fecha) / 60000);
  if (min < 1) return 'recién';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'ayer' : d < 30 ? `hace ${d} días` : new Date(fecha).toLocaleDateString('es-AR');
}
const visor = () => estado.activa?.visor;

async function pedirClave(incorrecta, texto = null) {
  const campo = el('input', { type: 'password', class: 'campo', style: 'width:100%;text-align:left;height:32px' });
  campo.addEventListener('keydown', e => { if (e.key === 'Enter') campo.closest('dialog').querySelector('.btn-primario').click(); });
  const r = await dialogo({ titulo: 'Documento protegido', texto: texto || (incorrecta ? 'La contraseña no es correcta. Probá de nuevo.' : 'Este PDF tiene contraseña para abrirlo.'),
    contenido: campo, botones: [{ t: 'Cancelar', v: null }, { t: 'Abrir', v: 'ok', primario: true }] });
  return r ? campo.value : null;
}

// ---------- Abrir, cambiar, guardar y cerrar documentos ----------
// Cada pestaña guarda los bytes actuales del PDF; cada cambio genera bytes nuevos y recarga el visor.
const modificada = p => !p.guardado || p.datos !== p.guardado.datos || p.firmas !== p.guardado.firmas || p.comentarios !== p.guardado.comentarios || p.proteccion !== p.guardado.proteccion || p.campos !== p.guardado.campos;
// Bytes completos para guardar o exportar: el PDF con las firmas y comentarios escritos como anotaciones editables
// las fuentes elegidas en cuadros de texto y Rellenar se incrustan al guardar
async function letrasDe(lista) {
  const m = new Map();
  for (const l of new Set(lista.filter(c => c.letra?.startsWith('f:')).map(c => c.letra))) { try { const f = await fuentesApp.paraEscribir(l, false, false); if (f?.bytes) m.set(l, f); } catch {} }
  return m;
}
const completo = async (p, aplanar = false) => {
  const r = await ops.componerTodo(p.datos, p.firmas, p.comentarios, aplanar, p.campos, await letrasDe(p.comentarios));
  // un cuadro de texto con una letra que no está en la fuente: se avisa (una vez por cada cambio de los comentarios)
  if (r.cambioLetra && p.avisoLetra !== p.comentarios) {
    p.avisoLetra = p.comentarios;
    setTimeout(() => aviso(r.cambioLetra === 'signo' ? 'Ojo: en un cuadro de texto hay una letra o símbolo que no se puede escribir en el PDF y quedó como "?". Probá con otra letra.'
      : 'Ojo: en un cuadro de texto, alguna letra no estaba en la fuente elegida y se escribió con una básica.', true), 50);
  }
  return r;
};
const instantanea = p => ({ datos: p.datos, firmas: p.firmas, comentarios: p.comentarios, proteccion: p.proteccion, campos: p.campos });
// PDF con contraseña o restricciones: se trabaja sin cifrar y al guardar se vuelve a cifrar igual (p.proteccion)
async function quitarProteccion(bytes) {
  const info = await api.claveInfo(bytes).catch(() => null);
  if (!info?.cifrado) return { bytes, proteccion: null };
  let clave = '', incorrecta = false;
  for (;;) {
    if (info.necesitaClave) { clave = await pedirClave(incorrecta); if (clave == null) throw new Error('password'); }
    const r = await api.claveQuitar(bytes, clave).catch(() => null);
    if (!r) return { bytes, proteccion: null }; // no se pudo: queda como antes (solo lectura)
    if (!r.error) {
      let proteccion = { clave: r.abrir ? clave : '', permisos: r.permisos };
      // se abrió con la clave de dueño: se pide la de abrir, para que al guardar los demás lo sigan abriendo con la suya
      if (r.duenio) {
        for (let mal = false; ;) {
          const u = await pedirClave(mal, 'Abriste con la clave de dueño. Escribí también la clave para abrir que usan los demás, así al guardar sigue igual. Si no la sabés, tocá Cancelar.');
          if (u == null) { aviso('Ojo: al guardar, para abrirlo va a hacer falta la clave de dueño.'); break; }
          const r2 = await api.claveQuitar(bytes, u).catch(() => null);
          if (r2 && !r2.error && !r2.duenio) { proteccion = { clave: u, permisos: r.permisos, duenio: clave }; break; }
          mal = true;
        }
      }
      return { bytes: new Uint8Array(r.datos), proteccion };
    }
    incorrecta = true;
  }
}
const carpetaDe = ruta => ruta ? ruta.replace(/[\\/][^\\/]+$/, '') : null;

function crearVisor(p, anterior) {
  const v = new Visor({ datos: p.datos, nombre: p.nombre, ruta: p.ruta, modo: anterior?.modo || estado.prefs.modo,
    pedirClave: async incorrecta => { if (!incorrecta && p.clave) return p.clave; const c = await pedirClave(incorrecta); p.clave = c; return c; } });
  if (anterior) { v.zoom = anterior.zoom; v.rotacion = anterior.rotacion; }
  else { const z = estado.prefs.zoomInicial; v.zoom = z === 1 || z === '1' ? 1 : z || 'ancho'; }
  v.alCambiar = () => { if (estado.activa === p) actualizarComandos(); };
  v.alDibujar = pg => { dibujarMarcasCambio(p, pg); campos.dibujarPagina(p, pg); firmas.dibujarPagina(p, pg); comentarios.dibujarPagina(p, pg); edicion.dibujarPagina(p, pg); if (pg.n === mascota.propuesta?.n && mascota.propuesta.p === p) mascota.redibujar(); };
  v.alMiniatura = async (n, g, vista) => { pintarComentarios(g, p.comentarios.filter(c => c.n === n), vista); await pintarFirmas(g, p.firmas.filter(f => f.n === n), vista); };
  comentarios.conectar(v, p);
  return v;
}
async function nuevaPestana(bytes, { ruta = null, nombre, guardada = true, fecha = null }) {
  const sinClave = await quitarProteccion(bytes);
  const r = await ops.separarTodo(sinClave.bytes); // las firmas y comentarios de PDF.Pro vuelven a ser editables
  const p = { id: crypto.randomUUID(), datos: r.datos, firmas: firmas.preparar(r.firmas), comentarios: r.comentarios, proteccion: sinClave.proteccion, campos: {},
    clave: sinClave.proteccion?.clave || null, ruta, nombre, carpeta: carpetaDe(ruta), historial: [], rehacer: [], fechaArchivo: fecha };
  p.guardado = guardada ? instantanea(p) : null;
  p.abierto = instantanea(p); // para "Comparar con como estaba al abrir"
  p.visor = crearVisor(p);
  estado.pestanas.push(p);
  $('#area').append(p.visor.el);
  activar(p);
  try { await p.visor.cargar(); }
  catch (e) { cerrar(p, true, true); throw e; }
  if (estado.activa === p) { actualizarComandos(); llenarPanel(); }
  // si los cuadros de texto usan una fuente de "Mis fuentes", se carga para verla igual
  for (const l of new Set(p.comentarios.filter(c => c.letra?.startsWith('f:')).map(c => c.letra))) fuentesApp.css(l).then(() => comentarios.redibujar(p)).catch(() => {});
  // firma digital: se puede trabajar igual, pero al guardar deja de valer
  const conFirmas = api.firmasDigitales(bytes).catch(() => 0);
  conFirmas.then(n => { if (n) aviso(n === 1 ? 'Este PDF tiene una firma digital: si lo cambiás y guardás, esa firma deja de valer. Conviene trabajar en una copia.' : `Este PDF tiene ${n} firmas digitales: si lo cambiás y guardás, dejan de valer. Conviene trabajar en una copia.`, false, { t: 'Hacer copia editable', f: copiaEditable }); }).catch(() => {});
  actualizarSinGuardar();
  mascota.alAbrirDocumento(p);
  // la primera vez que se abre un PDF: el recorrido de bienvenida (después, desde Ayuda)
  if (!estado.prefs.recorridoVisto && !api.prueba) setTimeout(verRecorrido, 1200);
  if (p.proteccion) aviso(p.proteccion.clave ? 'Este PDF tiene contraseña. Podés cambiarlo y al guardar queda con la misma contraseña.' : 'Este PDF tiene restricciones. Podés cambiarlo y al guardar las mantiene.');
  if (!p.proteccion) pareceEscaneado(p.visor).then(async si => { if (si && estado.activa === p && !(await conFirmas)) aviso('Parece un escaneo: todavía no se puede buscar ni copiar su texto.', false, { t: 'Reconocer texto', f: () => ocr() }); }).catch(() => {});
  return p;
}
const esOffice = ruta => /\.(docx?|odt|rtf|xlsx?|ods|csv|pptx?|odp)$/i.test(ruta);
// Word, Excel o PowerPoint: se pasa a PDF (con Office o LibreOffice) y se abre como documento nuevo
async function abrirOffice(ruta) {
  const nombre = ruta.split(/[\\/]/).pop();
  aviso('Pasando a PDF: ' + nombre + '…');
  document.body.classList.add('ocupado');
  try {
    const bytes = await api.officeAPdf(ruta);
    const p = await nuevaPestana(new Uint8Array(bytes), { nombre: nombre.replace(/\.[^.]+$/, '') + '.pdf', guardada: false });
    p.carpeta = carpetaDe(ruta);
    aviso('Listo, ya es PDF. Acordate de guardarlo (Ctrl+S).');
  } catch (e) { mostrarError(new Error(e?.message?.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') || 'No se pudo pasar a PDF.')); }
  finally { document.body.classList.remove('ocupado'); }
}
async function abrirRutas(rutas) {
  for (const ruta of rutas) {
    if (esOffice(ruta)) { await abrirOffice(ruta); continue; }
    const igual = (a, b) => a && b && (a === b || (/^[a-z]:\\/i.test(a) && a.toLowerCase() === b.toLowerCase())); // en Windows da igual mayúscula o minúscula
    const ya = estado.pestanas.find(p => igual(p.ruta, ruta));
    if (ya) { activar(ya); continue; }
    try {
      const a = await api.leerArchivo(ruta);
      await nuevaPestana(new Uint8Array(a.datos), { ruta, nombre: a.nombre, fecha: a.modificado });
    } catch (e) {
      aviso(/password/i.test(e?.name + e?.message) ? 'No se abrió: falta la contraseña.' : 'No se pudo abrir ' + ruta.split(/[\\/]/).pop(), true);
      if (!estado.pestanas.length) mostrarVistas();
    }
  }
}
async function abrirDialogo() { abrirRutas(await api.elegirPdf(true)); }
// Archivo → Guardar como Word / Excel (las firmas van pegadas; los comentarios no)
async function exportar(tipo) {
  const p = estado.activa;
  if (!p || estado.ocupado) return;
  const ruta = await api.elegirDestino(p.nombre.replace(/\.pdf$/i, '') + '.' + tipo, p.carpeta, tipo);
  if (!ruta) return;
  estado.ocupado = true; document.body.classList.add('ocupado');
  aviso(tipo === 'docx' ? 'Pasando a Word…' : 'Pasando a Excel…');
  try {
    const r = await api.exportar(tipo, await ops.componerTodo(p.datos, p.firmas, [], true, p.campos), ruta);
    aviso(`Listo: ${r.nombre}`, false, { t: 'Abrir', f: () => api.abrirConSistema(r.ruta) });
  } catch (e) { mostrarError(e); }
  finally { estado.ocupado = false; document.body.classList.remove('ocupado'); }
}

async function recargar(p, pagina) {
  // dónde estaba: la hoja y cuánto dentro de ella (antes de cerrar la vista vieja; después se pierde y volvía a la hoja 1)
  const anterior = p.visor, actual = anterior.actual, dHoja = anterior.paginas[actual - 1]?.div;
  const dentro = dHoja && dHoja.offsetHeight ? (anterior.el.scrollTop - dHoja.offsetTop) / dHoja.offsetHeight : 0;
  const v = crearVisor(p, anterior);
  v.el.hidden = true;
  anterior.el.after(v.el);
  await v.cargar();
  anterior.destruir();
  p.visor = v;
  v.el.hidden = estado.activa !== p || !!estado.organizador;
  // se armó escondida (ancho 0): ahora que se ve, el tamaño de las hojas se calcula de nuevo y se vuelve al mismo lugar
  if (!v.el.hidden) v.aplicarZoom(false);
  if (!pagina && v.total === anterior.total && !v.el.hidden) {
    const d = v.paginas[actual - 1]?.div;
    v.el.scrollTop = d ? d.offsetTop + dentro * d.offsetHeight : 0; v.actual = actual; v.marcarActual();
  } else v.irAPagina(Math.min(pagina || actual, v.total));
  if (estado.activa === p) { actualizarComandos(); llenarPanel(); estado.organizador?.dibujar(); }
}
// Aplica una operación sobre los bytes de la pestaña activa, con deshacer.
// Las flechas mueven firmas y comentarios de a poquito: los empujones seguidos cuentan como un solo paso.
// Además el historial no guarda más de ~300 MB de copias del PDF (los escaneos grandes pesan mucho).
// Todo cambio de un documento pasa por acá (operaciones de páginas, firmas, comentarios, casilleros, propuestas del
// asistente, contraseña): guarda cómo estaba para deshacer y anota qué se hizo (`p.registro`, para el historial y controles).
function registrarCambio(p, que = 'Cambio') {
  que = String(que).replace(/\s*\(.*?\)\s*/g, ' ').replace(/[.:]\s*$/, '').trim().slice(0, 60) || 'Cambio';
  if (p.marcasCambio) { p.marcasCambio = null; document.querySelectorAll('.marca-cambio').forEach(x => x.remove()); }
  if (!guardarHistorial(p, que)) return; // los empujones seguidos con las flechas cuentan como uno
  (p.registro ||= []).push({ que, fecha: Date.now() });
  if (p.registro.length > 300) p.registro.shift();
}
function guardarHistorial(p, que) {
  p.rehacer = [];
  const ahora = Date.now(), flecha = ahora - (estado.flecha || 0) < 300;
  if (flecha && p.histFlecha && ahora - p.histFlecha < 1500) { p.histFlecha = ahora; return false; }
  p.histFlecha = flecha ? ahora : 0;
  p.historial.push({ ...instantanea(p), que });
  const pesoDe = lista => { const vistos = new Set([p.datos]); let t = 0; for (const h of lista) if (!vistos.has(h.datos)) { vistos.add(h.datos); t += h.datos.byteLength; } return t; };
  while (p.historial.length > MAX_DESHACER || (p.historial.length > 2 && pesoDe(p.historial) > 300e6)) p.historial.shift();
  return true;
}
// Cambia solo las firmas (mover, agrandar, girar, borrar): no hace falta recargar el documento
function cambiarFirmas(p, nuevas, mensaje) {
  registrarCambio(p, mensaje || 'Firma');
  const antes = p.firmas;
  p.firmas = nuevas;
  firmas.redibujar(p); refrescarMiniaturas(p, antes, p.firmas);
  if (mensaje) aviso(mensaje);
  dibujarPestanas(); actualizarSinGuardar(); if (estado.activa === p) actualizarComandos();
}
// Casilleros de formularios: cambia el valor sin redibujar (así no se pierde dónde se está escribiendo)
function cambiarCampos(p, nuevos) {
  registrarCambio(p, 'Casillero');
  p.campos = nuevos;
  dibujarPestanas(); actualizarSinGuardar(); if (estado.activa === p) actualizarComandos();
}
const campos = new Campos({ el, pestana: () => estado.activa, cambiarCampos });
// Lo mismo para los comentarios (resaltados, notas, textos, dibujos)
function cambiarComentarios(p, nuevas, mensaje) {
  registrarCambio(p, mensaje || 'Comentario');
  const antes = p.comentarios;
  p.comentarios = nuevas;
  comentarios.redibujar(p); refrescarMiniaturas(p, antes, p.comentarios);
  mascota.alCambiarComentarios?.(p, antes, nuevas); // un dato rojo de Duki completado a mano: pregunta si lo aprende
  if (mensaje) aviso(mensaje);
  dibujarPestanas(); actualizarSinGuardar(); if (estado.activa === p) { actualizarComandos(); if (estado.prefs.panelVista === 'comentarios') llenarPanel(); }
}
async function aplicar(fn, { mensaje, pagina, fijar = false, sinRecargar = false } = {}) {
  const p = estado.activa;
  if (!p || estado.ocupado) return false;
  estado.ocupado = true; document.body.classList.add('ocupado');
  const t0 = performance.now();
  try {
    // las firmas se escriben antes de operar, así acompañan a su página (mover, rotar, borrar…)
    const base = await completo(p, fijar);
    const r = await ops.separarTodo(new Uint8Array(await fn(base)));
    if (!r.datos?.byteLength) throw new Error('La operación dejó el documento vacío; no se aplicó.');
    registrarCambio(p, mensaje || 'Cambio en las páginas');
    p.datos = new Uint8Array(r.datos); p.firmas = firmas.preparar(r.firmas); p.comentarios = r.comentarios; p.campos = {};
    // el modo documento muestra lo escrito él mismo: el documento se vuelve a dibujar al salir de Editar
    if (sinRecargar) p.recargarPendiente = true; else { p.recargarPendiente = false; await recargar(p, pagina); }
    if (mensaje) aviso(mensaje);
    return true;
  } catch (e) { if (!e?.cancelado) mostrarError(e); return false; } // cancelado: el usuario dijo que no (por ejemplo, en el control del editor)
  finally {
    const ms = performance.now() - t0;
    if (ms > 15000) api.anotarError('lento', `${mensaje || 'Cambio'}: tardó mucho`, { ms }).catch(() => {});
    estado.ocupado = false; document.body.classList.remove('ocupado'); dibujarPestanas(); actualizarSinGuardar();
  }
}
async function deshacer(sentido = 1) {
  if (edicion.activo) await edicion.terminar(); // en el modo documento, Ctrl+Z dentro del texto es del texto; afuera, se sale primero
  const p = estado.activa;
  const desde = sentido > 0 ? p?.historial : p?.rehacer, hacia = sentido > 0 ? p?.rehacer : p?.historial;
  if (!desde?.length || estado.ocupado) return;
  const antes = instantanea(p), entrada = desde.pop();
  hacia.push({ ...antes, que: entrada.que });
  ({ datos: p.datos, firmas: p.firmas, comentarios: p.comentarios = [], proteccion: p.proteccion = null, campos: p.campos = {} } = entrada);
  if (p.datos !== antes.datos) await recargar(p);
  else {
    firmas.redibujar(p); comentarios.redibujar(p); if (antes.campos !== p.campos) campos.redibujar(p);
    refrescarMiniaturas(p, antes.firmas, p.firmas); refrescarMiniaturas(p, antes.comentarios, p.comentarios);
    if (estado.prefs.panelVista === 'comentarios') llenarPanel();
  }
  aviso((sentido > 0 ? 'Deshecho: ' : 'Rehecho: ') + (entrada.que || 'cambio'));
  dibujarPestanas(); actualizarSinGuardar();
}
async function guardar(p = estado.activa, como = false) {
  if (!p) return false;
  if (estado.ocupado) { aviso('Esperá a que termine lo que está haciendo y guardá de nuevo.'); return false; }
  let ruta = p.ruta;
  if (como || !ruta) {
    ruta = await api.elegirDestino(p.nombre.match(/\.pdf$/i) ? p.nombre : p.nombre + '.pdf', p.carpeta);
    if (!ruta) return false;
  }
  if (edicion.activo && estado.activa === p) await edicion.word.confirmarTodo(); // lo escrito en el modo documento pasa antes al PDF
  const foto = instantanea(p); // lo que se guarda es esto: si algo cambia mientras tanto, sigue figurando sin guardar
  try {
    let bytes = await completo(p);
    if (p.proteccion) bytes = await api.clavePoner(bytes, p.proteccion);
    // se controla que lo guardado abra y tenga las mismas páginas; si el archivo cambió afuera desde que se abrió, se pregunta
    const control = { paginas: p.visor.total || 0, clave: p.proteccion?.clave || '', fechaEsperada: ruta === p.ruta ? p.fechaArchivo : null };
    let r = await api.guardarArchivo(ruta, bytes, control);
    if (r.cambiado) {
      const q = (await dialogo({ titulo: 'El archivo cambió', texto: `"${p.nombre}" se modificó en otro programa (o se sincronizó) después de que lo abriste. Si lo reemplazás, se pierden esos cambios de afuera (queda una copia en los respaldos).`,
        botones: [{ t: 'Cancelar', v: null }, { t: 'Guardar como…', v: 'como' }, { t: 'Reemplazar', v: 'si', primario: true }] }))?.boton;
      if (q === 'como') return guardar(p, true);
      if (q !== 'si') return false;
      r = await api.guardarArchivo(ruta, bytes, { ...control, forzar: true });
    }
    Object.assign(p, { ruta: r.ruta, nombre: r.nombre, carpeta: carpetaDe(r.ruta), guardado: foto, fechaArchivo: r.modificado });
    api.recuperarBorrar(p.id).catch(() => {});
    p.visor.ruta = r.ruta; p.visor.nombre = r.nombre;
    dibujarPestanas(); actualizarSinGuardar(); activar(p);
    aviso('Guardado: ' + r.nombre);
    return true;
  } catch (e) {
    aviso(/CONTROL:/.test(e?.message) ? 'No se guardó: al revisar el archivo nuevo salió con un problema. Tu archivo anterior quedó como estaba. Probá de nuevo o con "Guardar como".'
      : /EBUSY|EPERM|EACCES/.test(e?.message) ? 'No se pudo guardar: el archivo está abierto en otro programa o no tenés permiso. Probá con "Guardar como".'
      : /ENOSPC/.test(e?.message) ? 'No se pudo guardar: el disco está lleno.' : 'No se pudo guardar el archivo. ' + textoError(e), true);
    return false;
  }
}
function actualizarSinGuardar() { api.sinGuardar(estado.pestanas.filter(modificada).length); }

function activar(p) {
  if (estado.activa !== p) { firmas.deseleccionar(); comentarios.deseleccionar(); comentarios.terminarHerramienta(); edicion.terminar(); }
  if (estado.organizador && estado.activa !== p) cerrarOrganizador();
  estado.activa = p;
  for (const x of estado.pestanas) x.visor.el.hidden = x !== p;
  dibujarPestanas(); mostrarVistas();
  if (p?.visor.doc) { actualizarComandos(); llenarPanel(); p.visor.el.focus({ preventScroll: true }); }
  document.title = p ? p.nombre + ' — pdf.pro' : 'pdf.pro';
  mascota.mostrarPerfil?.();
}
async function cerrar(p = estado.activa, silencio = false, sinPreguntar = false) {
  if (!p) return;
  if (estado.ocupado && estado.activa === p && !sinPreguntar) return aviso('Esperá a que termine lo que está haciendo.');
  if (!sinPreguntar && modificada(p)) {
    activar(p);
    const r = await dialogo({ titulo: '¿Guardar los cambios?', texto: `"${p.nombre}" tiene cambios sin guardar.`,
      botones: [{ t: 'Cancelar', v: null }, { t: 'No guardar', v: 'no' }, { t: 'Guardar', v: 'si', primario: true }] });
    if (!r) return;
    if (r.boton === 'si' && !(await guardar(p))) return;
  }
  if (estado.leyendo) pararLectura();
  cerrarPanel(p);
  if (estado.activa === p) { cerrarOrganizador(); firmas.deseleccionar(); comentarios.deseleccionar(); comentarios.terminarHerramienta(); }
  const i = estado.pestanas.indexOf(p);
  cerradas.push(p.ruta ? { ruta: p.ruta } : { datos: p.datos, nombre: p.nombre }); if (cerradas.length > 10) cerradas.shift();
  estado.pestanas.splice(i, 1);
  p.visor.destruir();
  api.recuperarBorrar(p.id).catch(() => {});
  if (estado.activa === p) activar(estado.pestanas[Math.min(i, estado.pestanas.length - 1)] || null);
  else dibujarPestanas();
  actualizarSinGuardar();
  if (!estado.pestanas.length && !silencio) dibujarInicio();
}

// ---------- Crear documentos nuevos ----------
// JPG y PNG van tal cual; WEBP, HEIC (llega en píxeles), BMP y GIF se pasan a JPG sobre fondo blanco
async function imagenParaPdf(i) {
  if (i.tipo === 'jpg' || i.tipo === 'png') return { datos: new Uint8Array(i.datos), tipo: i.tipo };
  let img;
  try { img = await createImageBitmap(i.tipo === 'rgba' ? new ImageData(new Uint8ClampedArray(i.datos), i.ancho, i.alto) : new Blob([i.datos])); }
  catch { throw new Error('No se pudo leer la imagen ' + i.nombre); }
  const c = el('canvas', { width: img.width, height: img.height }), g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0);
  const datos = await new Promise(r => c.toBlob(async b => r(new Uint8Array(await b.arrayBuffer())), 'image/jpeg', 0.92));
  return { datos, tipo: 'jpg' };
}
async function crearDesdeImagenes(dadas) {
  let imgs;
  try { imgs = Array.isArray(dadas) ? dadas : await api.elegirImagenes(); }
  catch (e) { return aviso(e?.message?.match(/No se pudo leer la imagen .*/)?.[0] || 'No se pudo leer una de las imágenes.', true); }
  if (!imgs.length) return;
  try {
    const bytes = await ops.desdeImagenes(await Promise.all(imgs.map(imagenParaPdf)));
    const p = await nuevaPestana(new Uint8Array(bytes), { nombre: imgs.length === 1 ? imgs[0].nombre.replace(/\.\w+$/, '') + '.pdf' : 'Documento nuevo.pdf', guardada: false });
    if (imgs[0].carpeta) p.carpeta = imgs[0].carpeta; // "Guardar" propone la carpeta de las imágenes
    aviso(imgs.length > 1 ? `PDF creado con ${imgs.length} imágenes. Acordate de guardarlo (Ctrl+S).` : 'PDF creado. Acordate de guardarlo (Ctrl+S).');
  } catch (e) { mostrarError(e); }
}
async function unirVarios() {
  const rutas = await api.elegirPdf();
  if (rutas.length < 2) { if (rutas.length) aviso('Elegí dos o más PDF para unirlos (con Ctrl+clic en la ventana de abrir).', true); return; }
  try {
    const bytes = await ops.unirVarios(await Promise.all(rutas.map(r => api.leerBytes(r))));
    await nuevaPestana(new Uint8Array(bytes), { nombre: 'Documentos unidos.pdf', guardada: false });
    abrirOrganizador();
    aviso(`Se unieron ${rutas.length} PDF. Revisá el orden y guardalo (Ctrl+S).`);
  } catch (e) { mostrarError(e); }
}

// ---------- Organizar páginas ----------
const ctxOrganizador = {
  el, aviso, dialogo, api, error: mostrarError,
  pestana: () => estado.activa, aplicar, completo: p => completo(p), abrir: rutas => abrirRutas(rutas),
  cerrar: () => cerrarOrganizador(), alAsistente: indices => paginasAlAsistente(indices)
};
// Las páginas elegidas en Organizar, como imágenes (con lo rellenado y las firmas), al chat del asistente
async function paginasAlAsistente(indices) {
  const p = estado.activa; if (!p?.visor?.doc || !indices.length) return;
  const lista = indices.slice(0, 6);
  if (indices.length > 6) aviso('Mando las primeras 6 páginas (para más, pasale el PDF entero con el clip del chat).');
  for (const i of lista) {
    const pagina = await p.visor.doc.getPage(i + 1), vista = pagina.getViewport({ scale: 1.6 });
    const c = el('canvas', { width: Math.floor(vista.width), height: Math.floor(vista.height) }), g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    await pagina.render({ canvasContext: g, viewport: vista }).promise;
    pintarComentarios(g, p.comentarios.filter(x => x.n === i + 1), vista, { notas: false });
    await pintarFirmas(g, p.firmas.filter(x => x.n === i + 1), vista);
    const png = await new Promise(res => c.toBlob(async b => res(new Uint8Array(await b.arrayBuffer())), 'image/png'));
    mascota.adjuntar(png, `${p.nombre.replace(/\.pdf$/i, '')} - página ${i + 1}.png`, 'image/png', i === lista.at(-1));
  }
  cerrarOrganizador();
}
// ---------- Firmas y sellos ----------
const firmas = new Firmas({ el, aviso, dialogo, api, icono, cambiarFirmas, pestana: () => estado.activa, prefs: () => estado.prefs,
  alSeleccionar: () => comentarios.deseleccionar() });
// ---------- Comentarios ----------
const comentarios = new Comentarios({ el, aviso, icono, api, cambiarComentarios, pestana: () => estado.activa, copiarImagenDe, leerArea: (pg, r) => leerArea(pg, r), censurar: (pg, r) => censurar(pg, r), fuentes: fuentesApp,
  prefs: () => estado.prefs, guardarPref: (k, v) => { estado.prefs[k] = v; api.guardarPref(k, v); },
  alSeleccionar: () => firmas.deseleccionar(), alCambiarHerramienta: () => actualizarComandos(),
  // lo que se escribe con "Rellenar" se recuerda (solo en esta computadora) para sugerirlo la próxima vez
  memoria: () => (estado.prefs.rellenos ||= {}),
  antesDeUsar: () => edicion.terminar(), guardarMemoria: m => { estado.prefs.rellenos = m; api.guardarPref('rellenos', m); } });
// ---------- Copiar, cortar y pegar ----------
// Firmas y comentarios se copian también al portapapeles de Windows (la firma como imagen, el comentario como texto).
async function copiarObjeto(cortar = false) {
  const p = estado.activa;
  const f = firmas.sel && p?.firmas.find(x => x.id === firmas.sel);
  const c = !f && comentarios.sel && p?.comentarios.find(x => x.id === comentarios.sel);
  if (!f && !c) return false;
  if (c && esMarca(c)) {
    await api.portapapelesEscribir({ texto: c.texto || c.nota });
    estado.portapapeles = null;
    aviso('Texto copiado');
    return true;
  }
  const marca = crypto.randomUUID();
  estado.portapapeles = { marca, tipo: f ? 'firma' : 'comentario', obj: f || c };
  await api.portapapelesEscribir({ marca, png: f ? f.png : null, texto: c ? c.nota : '' });
  if (cortar) { if (f) firmas.borrar(p); else comentarios.borrar(c.id); aviso('Cortado. Pegalo con Ctrl+V donde quieras.'); }
  else aviso(f ? 'Copiada. Pegala con Ctrl+V.' : 'Copiado. Pegalo con Ctrl+V.');
  return true;
}
// Centro de lo que se ve de la página actual (para pegar sin clic derecho)
function puntoVisible() {
  const v = visor(), pg = v?.paginas[v.actual - 1];
  if (!pg?.vista) return null;
  const caja = v.el.getBoundingClientRect(), r = pg.div.getBoundingClientRect(), k = pg.vista.width / r.width;
  return { pg, x: pg.vista.width / 2, y: ((Math.max(r.top, caja.top) + Math.min(r.bottom, caja.bottom)) / 2 - r.top) * k };
}
// q = { pg, x, y }: dónde pegar (clic derecho). Pega lo copiado en PDF.Pro, una imagen o un texto de otro programa.
async function pegar(q = null) {
  const p = estado.activa, v = p?.visor;
  if (!v?.doc || estado.organizador) return;
  const r = await api.portapapelesLeer();
  const marca = r.html?.match(/pdfpro:([\w-]+?)-->/)?.[1], prop = estado.portapapeles;
  if (marca && prop?.marca === marca) {
    const destino = q || (prop.obj.n !== v.actual ? puntoVisible() : null);
    if (prop.tipo === 'firma') { const f = firmas.copiaPara(prop.obj, destino); firmas.sel = f.id; comentarios.deseleccionar(); return cambiarFirmas(p, [...p.firmas, f], 'Pegada'); }
    const c = comentarios.copiaPara(prop.obj, destino && { ...destino, x: destino.x - (q ? 0 : 40), y: destino.y - (q ? 0 : 20) });
    if (c) { firmas.deseleccionar(); comentarios.sel = c.id; return cambiarComentarios(p, [...p.comentarios, c], 'Pegado'); }
  }
  if (r.png) return firmas.nueva({ bytes: new Uint8Array(r.png), ancho: r.ancho, alto: r.alto, tipo: 'imagen', nombre: 'Imagen', anchoPt: r.ancho * 0.75 }, q);
  const texto = r.texto?.trim();
  if (texto) { const d = q || puntoVisible(); return d && comentarios.nuevoTexto(q || { ...d, x: Math.max(8, d.x - 110 * d.pg.vista.scale) }, texto); }
  aviso('No hay nada para pegar. Copiá un texto o una imagen primero.');
}
// Copiar área como imagen: dibuja ese pedazo de la página a 200 ppp, con firmas y comentarios, y lo copia
async function copiarImagenDe(pg, r) {
  const p = estado.activa;
  try {
    const pagina = await p.visor.doc.getPage(pg.n);
    const vista = pagina.getViewport({ scale: 200 / 72, rotation: pg.vista.rotation }), f = vista.width / pg.vista.width;
    const c = el('canvas', { width: Math.round(r.w * f), height: Math.round(r.h * f) }), g = c.getContext('2d');
    const t = [1, 0, 0, 1, -r.x * f, -r.y * f];
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    await pagina.render({ canvasContext: g, viewport: vista, transform: t }).promise;
    g.setTransform(...t);
    pintarComentarios(g, p.comentarios.filter(x => x.n === pg.n), vista);
    await pintarFirmas(g, p.firmas.filter(x => x.n === pg.n), vista);
    const png = await new Promise(res => c.toBlob(async b => res(new Uint8Array(await b.arrayBuffer())), 'image/png'));
    await api.portapapelesEscribir({ png });
    estado.portapapeles = null;
    aviso('Imagen copiada. Pegala donde quieras con Ctrl+V, o mandásela al asistente para que aprenda.', false, { t: 'Mandar al asistente', f: () => mascota.adjuntar(png, 'recorte.png', 'image/png') });
  } catch (e) { mostrarError(e); }
}

// Reconocer texto de un área (PaddleOCR en main.js): la parte marcada se dibuja a 300 ppp, se lee y se muestra el
// texto para revisarlo y copiarlo. Sirve para escaneos y fotos, y también para copiar texto de una imagen dentro del PDF.
async function leerArea(pg, r) {
  const p = estado.activa;
  try {
    aviso('Leyendo el texto de esa parte…');
    const pagina = await p.visor.doc.getPage(pg.n);
    const vista = pagina.getViewport({ scale: 300 / 72, rotation: pg.vista.rotation }), f = vista.width / pg.vista.width;
    const k = Math.min(1, 4000 / Math.max(r.w * f, r.h * f)); // sin pasar de 4000 píxeles por lado
    const c = el('canvas', { width: Math.max(8, Math.round(r.w * f * k)), height: Math.max(8, Math.round(r.h * f * k)) }), g = c.getContext('2d', { alpha: false });
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    await pagina.render({ canvasContext: g, viewport: pagina.getViewport({ scale: 300 / 72 * k, rotation: pg.vista.rotation }), transform: [1, 0, 0, 1, -r.x * f * k, -r.y * f * k] }).promise;
    const png = await new Promise(res => c.toBlob(async b => res(new Uint8Array(await b.arrayBuffer())), 'image/png'));
    c.width = c.height = 0;
    const res = await api.ejecutarOcr(png);
    avisoVacio();
    if (!res.texto.trim()) return aviso('No encontré texto en esa parte. Probá marcando un recuadro un poco más grande.', true);
    const caja = el('textarea', { class: 'campo ocr-area-texto', rows: Math.min(14, res.texto.split('\n').length + 1) }, res.texto);
    const conf = Math.round(100 * res.bloques.reduce((a, b) => a + b.confianza, 0) / res.bloques.length);
    const d = await dialogo({ titulo: 'Texto reconocido', texto: `Revisalo antes de usarlo (seguridad ${conf} %). Podés corregirlo acá.`, contenido: caja, clase: 'dialogo-ancho',
      botones: [{ t: 'Cerrar', v: null }, { t: 'Copiar', v: 'copiar', primario: true }] });
    if (d) { await navigator.clipboard.writeText(caja.value); aviso('Texto copiado. Pegalo donde quieras con Ctrl+V.'); }
  } catch (e) { mostrarError(e); }
}

// ---------- Imprimir y preferencias ----------
const ctxGeneral = { el, aviso, dialogo, api, icono, error: mostrarError, pestana: () => estado.activa, prefs: () => estado.prefs, alCambiarMascota: () => mascota.mostrar(),
  alCambiarNombre: () => saludar(), cambiarLadoPanel: v => { raiz.dataset.panelLado = v; },
  guardarPref: (k, v) => { estado.prefs[k] = v; return api.guardarPref(k, v); }, cambiarTema: t => cambiarTema(t),
  refrescarPanel: () => { $('#panel').hidden = !panelVisible(); if (!$('#panel').hidden) llenarPanel(); actualizarComandos(); } };
function imprimir() {
  if (!visor()?.doc || estado.ocupado) return;
  if (estado.organizador) cerrarOrganizador();
  abrirImpresion(ctxGeneral).catch(mostrarError);
}
const preferencias = () => abrirPreferencias(ctxGeneral).catch(mostrarError);
const ajustesIA = () => abrirAjustesIA(ctxGeneral).catch(mostrarError);
const iaLocal = op => estado.activa?.visor?.doc && sinInternet({ el, api, dialogo, aviso, ajustesIA, abrirRutas, textoDocumento: (p, max) => mascota.textoDocumento(p, max) }, estado.activa, op).catch(mostrarError);
// ---------- Editar texto e imágenes del PDF ----------
const edicion = new Edicion({ el, aviso, api, icono, dialogo, prefs: () => estado.prefs, recargar: (p, pagina) => recargar(p, pagina).then(() => { p.recargarPendiente = false; }), fuentes: fuentesApp, pestana: () => estado.activa, aplicar, error: mostrarError, alCambiar: () => actualizarComandos(), firmas });
function editar() { if (!visor()?.doc || estado.organizador) return; if (!edicion.activo) { comentarios.terminarHerramienta(); comentarios.deseleccionar(); firmas.deseleccionar(); } edicion.activar(); }
// ---------- La mascota (asistente con Claude) ----------
// Lo que acepta de la mascota entra junto (textos encima y casilleros): un solo Ctrl+Z lo saca todo
function aplicarPropuesta(p, textos, valores, mensaje, nuevasFirmas = []) {
  registrarCambio(p, 'Completar con el asistente');
  const antes = p.comentarios, antesF = p.firmas;
  if (textos.length) p.comentarios = [...p.comentarios, ...textos];
  if (Object.keys(valores).length) p.campos = { ...p.campos, ...valores };
  if (nuevasFirmas.length) { p.firmas = [...p.firmas, ...nuevasFirmas]; firmas.redibujar(p); refrescarMiniaturas(p, antesF, p.firmas); }
  comentarios.redibujar(p); campos.redibujar(p); refrescarMiniaturas(p, antes, p.comentarios);
  aviso(mensaje); dibujarPestanas(); actualizarSinGuardar(); if (estado.activa === p) actualizarComandos();
}
const mascota = new Mascota({ el, api, aviso, dialogo, pestana: () => estado.activa, cambiarComentarios, aplicarPropuesta, campos, prefs: () => estado.prefs, firmas: () => firmas.lista,
  guardarPref: (k, v) => { estado.prefs[k] = v; return api.guardarPref(k, v); }, preferencias: () => ajustesIA() });
const herramientas = new Herramientas({ el, icono, aviso, comentarios, edicion, mascota, pestana: () => estado.activa, prefs: () => estado.prefs, a: {
  organizando: () => !!estado.organizador, crearDesdeImagenes: () => crearDesdeImagenes(), unirVarios: () => unirVarios(), exportar: t => exportar(t),
  officeAPdf: async () => { for (const r of (await api.elegirPdf(true)).filter(esOffice)) await abrirOffice(r); },
  editar: () => { if (!edicion.activo) editar(); }, organizar: () => alternarOrganizador(), ocr: o => ocr(o),
  resumir: () => iaLocal(), preguntar: () => iaLocal({ resumir: false }),
  menuFirmar: b => abrirMenu('Firmar', b), agregarFirma: () => agregarYColocar(), proteger: () => protegerDialogo(),
  quitarClave: () => cambiarProteccion(estado.activa, null, 'Listo. Al guardar (Ctrl+S) queda sin contraseña ni restricciones.'),
  imprimir: () => imprimir(), buscar: () => abrirBusqueda(), leer: () => alternarLectura(),
  comprimir: () => comprimirDoc(), reparar: () => repararDoc(), blancas: () => quitarBlancas(), numerar: () => numerarDoc(),
  copiaEditable: () => copiaEditable(), propiedades: () => propiedadesDoc(), comandos: () => buscarComando(),
  guardarPref: (k, v) => { estado.prefs[k] = v; api.guardarPref(k, v); },
  refrescarPanel: () => { $('#panel').hidden = !panelVisible(); llenarPanel(); actualizarComandos(); } } });
const panelVisible = () => !!estado.activa && !estado.organizador && (!!estado.prefs.panel || herramientas.abierto);
const ocr = (opciones = {}) => { if (!visor()?.doc || estado.ocupado) return; if (estado.organizador) cerrarOrganizador(); reconocerTexto({ ...ctxGeneral, aplicar }, opciones).catch(mostrarError); };
async function agregarYColocar() { const f = await firmas.agregar(); if (f && visor() && !estado.organizador) firmas.nueva(f); }
// Archivo → Proteger con contraseña / Quitar la contraseña
async function protegerDialogo() {
  const p = estado.activa;
  if (!p) return;
  const campo = () => el('input', { type: 'password', class: 'campo', style: 'width:100%;text-align:left' });
  const c1 = campo(), c2 = campo();
  const r = await dialogo({ titulo: 'Proteger con contraseña', texto: 'Para abrir este PDF va a hacer falta la contraseña (en cualquier programa). Anotala: si se olvida, no se puede recuperar.',
    contenido: el('div', { class: 'opciones' }, el('label', { class: 'firma-fila' }, el('span', { class: 'sutil' }, 'Contraseña'), c1), el('label', { class: 'firma-fila' }, el('span', { class: 'sutil' }, 'Repetila'), c2)),
    botones: [{ t: 'Cancelar', v: null }, { t: 'Proteger', v: 'ok', primario: true }],
    validar: () => c1.value.length < 4 ? 'Usá por lo menos 4 letras o números.' : c1.value !== c2.value ? 'Las dos contraseñas no son iguales.' : null });
  if (!r) return;
  cambiarProteccion(p, { clave: c1.value, permisos: null }, 'Listo. Al guardar (Ctrl+S) queda con contraseña.');
}
function cambiarProteccion(p, proteccion, mensaje) {
  registrarCambio(p, proteccion ? 'Poner contraseña' : 'Quitar la contraseña');
  p.proteccion = proteccion; p.clave = proteccion?.clave || null;
  aviso(mensaje);
  dibujarPestanas(); actualizarSinGuardar(); actualizarComandos();
}
async function olvidarRellenos() {
  const n = Object.keys(estado.prefs.rellenos?.valores || {}).length;
  const r = await dialogo({ titulo: 'Olvidar datos de Rellenar', texto: `PDF.Pro recuerda ${n} ${n === 1 ? 'dato' : 'datos'} que escribiste en formularios (nombres, domicilios, números) para sugerirlos. Se guardan solo en esta computadora. ¿Borrarlos?`,
    botones: [{ t: 'Cancelar', v: null }, { t: 'Borrar', v: 'si', primario: true }] });
  if (r) { estado.prefs.rellenos = {}; api.guardarPref('rellenos', {}); aviso('Listo, ya no se sugieren.'); }
}
async function borrarComentarios() {
  const p = estado.activa, n = p?.comentarios.length;
  if (!n) return;
  const r = await dialogo({ titulo: 'Borrar todos los comentarios', texto: `Se borran ${n === 1 ? 'el comentario' : `los ${n} comentarios`} de este documento (resaltados, notas, textos y dibujos). Se puede deshacer con Ctrl+Z.`,
    botones: [{ t: 'Cancelar', v: null }, { t: 'Borrar', v: 'si', primario: true }] });
  if (r) { comentarios.deseleccionar(); cambiarComentarios(p, [], 'Comentarios borrados (Ctrl+Z para deshacer)'); }
}
function fijarFirmas() {
  const n = estado.activa?.firmas.length;
  if (!n) return aviso('No hay firmas para fijar en este documento.');
  aplicar(b => b, { fijar: true, mensaje: n === 1 ? 'Firma fijada: ya es parte de la página (Ctrl+Z para deshacer)' : `${n} firmas fijadas: ya son parte de las páginas (Ctrl+Z para deshacer)` });
}
function abrirOrganizador() {
  const p = estado.activa;
  if (!p?.visor.doc || estado.organizador) return;
  if (estado.leyendo) pararLectura();
  firmas.deseleccionar(); comentarios.deseleccionar(); comentarios.terminarHerramienta(); edicion.terminar();
  estado.organizador = new Organizador(ctxOrganizador);
  p.visor.el.hidden = true;
  $('#area').append(estado.organizador.raiz);
  estado.organizador.sel = new Set([p.visor.actual - 1]);
  estado.organizador.dibujar();
  estado.organizador.raiz.focus();
  $('#panel').hidden = true;
  actualizarComandos();
}
function cerrarOrganizador() {
  if (!estado.organizador) return;
  estado.organizador.destruir(); estado.organizador = null;
  const p = estado.activa;
  if (p) { p.visor.el.hidden = false; p.visor.el.focus({ preventScroll: true }); }
  $('#panel').hidden = !estado.prefs.panel || !p;
  if (p) { llenarPanel(); actualizarComandos(); }
}
const alternarOrganizador = () => estado.organizador ? cerrarOrganizador() : abrirOrganizador();

// Acciones de páginas desde el menú (sin abrir el organizador): actúan sobre la página actual
const actual0 = () => visor().actual - 1;
async function extraerDialogo() {
  const v = visor();
  const campo = el('input', { class: 'campo', type: 'text', value: String(v.actual), style: 'width:100%;text-align:left' });
  const r = await dialogo({ titulo: 'Extraer páginas', texto: `Escribí qué páginas querés guardar en un PDF nuevo (el documento tiene ${v.total}). Ej.: 1-3, 5`,
    contenido: campo, botones: [{ t: 'Cancelar', v: null }, { t: 'Extraer', v: 'ok', primario: true }],
    validar: () => { try { ops.leerRangos(campo.value, v.total); return null; } catch (e) { return e.message; } } });
  if (!r) return;
  const indices = [...new Set(ops.leerRangos(campo.value, v.total).flat())].sort((a, b) => a - b);
  extraerPaginas(ctxOrganizador, estado.activa, indices);
}

function mostrarVistas() {
  const hay = !!estado.activa;
  $('#inicio').hidden = hay;
  $('#barra-comandos').hidden = !hay;
  $('#cuerpo').hidden = !hay;
  $('#panel').hidden = !panelVisible();
  herramientas.actualizar();
  if (!hay) { $('#barra-buscar').hidden = true; dibujarInicio(); }
}

// ---------- Pestañas ----------
function dibujarPestanas() {
  const cont = $('#pestanas');
  cont.replaceChildren(...estado.pestanas.map(p => {
    const t = el('div', { class: 'pestana', role: 'tab', 'aria-selected': String(p === estado.activa), title: p.ruta || 'Sin guardar todavía',
      onmousedown: e => { if (e.button === 1) { e.preventDefault(); cerrar(p); } else activar(p); } },
      modificada(p) ? el('span', { class: 'punto', title: 'Cambios sin guardar' }, '●') : null,
      p.proteccion ? el('span', { class: 'candado', title: p.proteccion.clave ? 'Protegido con contraseña' : 'Con restricciones', html: icono.candado }) : null,
      el('span', { class: 'nombre' }, p.nombre),
      el('button', { class: 'x', title: 'Cerrar (Ctrl+W)', html: icono.cerrar, onmousedown: e => e.stopPropagation(), onclick: () => cerrar(p) }));
    return t;
  }));
  // si no entran todas: se ve la elegida y aparece el botón con la lista completa
  const sel = cont.querySelector('[aria-selected="true"]');
  requestAnimationFrame(() => {
    sel?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const b = $('#todas-pestanas'), sobran = cont.scrollWidth > cont.clientWidth + 2;
    b.hidden = !sobran;
    if (sobran) b.replaceChildren(String(estado.pestanas.length), el('span', { html: icono.abajo }));
  });
}
function listaDePestanas(boton) {
  const r = boton.getBoundingClientRect(), actual = estado.activa;
  mostrarMenu('pestanas', [
    { titulo: `${estado.pestanas.length} documentos abiertos` },
    ...estado.pestanas.map(p => ({ t: p.nombre + (modificada(p) ? ' (sin guardar)' : ''), check: p === actual, tip: p.ruta || '', f: () => activar(p) })),
    '-',
    { t: 'Cerrar todas menos la actual', off: estado.pestanas.length < 2, f: async () => { for (const p of estado.pestanas.filter(x => x !== actual)) await cerrar(p); } }
  ], r.left, r.bottom + 4, boton);
}

// ---------- Actualizaciones ----------
// manual: desde Ayuda (avisa también si no hay nada). Al abrir no vuelve a ofrecer una versión que se rechazó.
async function buscarActualizacion(manual = false) {
  const r = await api.actualizacionBuscar();
  if (r.error) { if (manual) aviso(r.error, true); return; }
  if (!r.hay) { if (manual) aviso(`Tenés la última versión (${r.actual}).`); return; }
  // si antes dijo "Ahora no", no se insiste con la ventana: queda el aviso abajo, con el botón para actualizar
  if (!manual && estado.prefs.versionDescartada === r.nueva) return aviso(`Hay una versión nueva de pdf.pro (${r.nueva}).`, false, { t: 'Actualizar', f: () => buscarActualizacion(true) });
  const si = (await dialogo({ titulo: 'Hay una versión nueva', texto: `Está la versión ${r.nueva} (tenés la ${r.actual}). ¿La descargo? Podés seguir trabajando mientras baja.`,
    botones: [{ t: 'Ahora no', v: false }, { t: 'Descargar', v: true, primario: true }] }))?.boton;
  if (!si) { estado.prefs.versionDescartada = r.nueva; api.guardarPref('versionDescartada', r.nueva); return; }
  aviso('Descargando la versión nueva…');
  const d = await api.actualizacionDescargar();
  if (d.error) aviso('No se pudo descargar: ' + d.error, true);
}
function vigilarActualizaciones() {
  api.alActualizacion(async d => {
    if (d.tipo === 'progreso') aviso(`Descargando la versión nueva… ${d.pct}%`);
    else if (d.tipo === 'error') aviso('Actualización: ' + d.mensaje, true);
    else if (d.tipo === 'lista') {
      const ya = (await dialogo({ titulo: `La versión ${d.version} está lista`, texto: 'Se instala al reiniciar el programa. Si elegís "Más tarde", se instala sola cuando lo cierres.',
        botones: [{ t: 'Más tarde', v: false }, { t: 'Reiniciar e instalar', v: true, primario: true }] }))?.boton;
      if (!ya) return;
      if (estado.pestanas.some(modificada)) return aviso('Primero guardá los documentos con cambios (Ctrl+S). La versión nueva se instala sola cuando cierres el programa.', true);
      const r = await api.actualizacionInstalar();
      if (r?.error) aviso('Primero guardá los documentos con cambios. La versión nueva se instala sola cuando cierres el programa.', true);
    }
  });
  setTimeout(() => buscarActualizacion(false), 8000);
  // el programa puede quedar abierto días (junto al reloj): se vuelve a buscar cada 3 horas, una vez por versión nueva
  let avisada = null;
  setInterval(async () => {
    const r = await api.actualizacionBuscar().catch(() => null);
    if (r?.hay && r.nueva !== avisada) { avisada = r.nueva; buscarActualizacion(false); }
  }, 3 * 3600 * 1000);
}

// Accesos rápidos de la pantalla de inicio (lo que se puede hacer sin abrir un PDF)
function armarAccesos() {
  const acceso = (ic, t, d, f) => el('button', { class: 'acceso', onclick: f }, el('span', { class: 'acceso-icono', html: ic }), el('b', {}, t), el('small', {}, d));
  $('#accesos').replaceChildren(
    acceso(icono.imagen, 'Crear PDF', 'Desde fotos o escaneos', () => crearDesdeImagenes()),
    acceso(icono.unir, 'Unir PDF', 'Juntar varios en uno', unirVarios),
    acceso(icono.word, 'Word o Excel a PDF', 'Convertir y abrir', async () => { for (const r of (await api.elegirPdf(true)).filter(esOffice)) await abrirOffice(r); }));
}
// Fallas que no pasan por mostrarError (código que se rompe): se anotan igual, sin el contenido del documento
// "ResizeObserver loop…" es un aviso del navegador sin consecuencias: no se anota (llenaba los informes)
window.addEventListener('error', e => { if (!/^ResizeObserver loop/.test(e.message)) api.anotarError('falla', e.message, { pila: e.error?.stack }).catch(() => {}); });
window.addEventListener('unhandledrejection', e => { if (!e.reason?.cancelado) api.anotarError('falla', e.reason?.message || String(e.reason), { pila: e.reason?.stack }).catch(() => {}); });
// Ayuda → Enviar informe de errores: lo que pasó (con palabras del usuario), la captura si quiere y lo anotado
async function enviarInforme() {
  const png = await api.capturaVentana().catch(() => null);
  const que = el('textarea', { class: 'campo', rows: 4, placeholder: 'Contá qué estabas haciendo y qué pasó (por ejemplo: "edité un párrafo y se borró una línea").', style: 'width:100%;height:auto;text-align:left;resize:vertical' });
  const conCaptura = el('input', { type: 'checkbox', checked: !!png });
  const vista = png ? el('img', { src: URL.createObjectURL(new Blob([png], { type: 'image/png' })), alt: 'Captura de la ventana', class: 'informe-captura' }) : null;
  const errores = await api.leerErrores().catch(() => []);
  const r = await dialogo({ titulo: 'Enviar informe de errores', texto: 'Le llega a Matías para arreglarlo. Se mandan también los errores que anotó el programa (sin tus documentos ni datos personales).',
    contenido: el('div', { class: 'informe' }, que,
      png ? el('label', { class: 'informe-opcion' }, conCaptura, ' Adjuntar esta captura de la ventana (fijate que no se vea nada privado)') : null, vista,
      el('small', { class: 'sutil' }, errores.length ? `Errores anotados: ${errores.length}. El último: ${errores.at(-1).mensaje.slice(0, 120)}` : 'El programa no anotó errores.')),
    validar: () => !que.value.trim() && !errores.length ? 'Contá en pocas palabras qué pasó.' : null,
    botones: [{ t: 'Cancelar', v: null }, { t: 'Enviar', v: 'ok', primario: true }] });
  if (vista) URL.revokeObjectURL(vista.src);
  if (!r) return;
  const res = await api.enviarInforme({ descripcion: que.value.trim(), captura: conCaptura.checked ? png : null }).catch(() => ({ enviado: false }));
  aviso(res.enviado ? '¡Gracias! El informe se envió.' : 'El informe quedó guardado y se va a enviar solo cuando se pueda (por ejemplo, cuando haya internet).');
}
// Herramientas → Comparar con como estaba al abrir: qué hojas cambiaron, qué palabras se sacaron o agregaron, y
// recuadros sobre las zonas que cambiaron (se van al hacer otro cambio)
// ---------- Herramientas del documento: comprimir, reparar, quitar hojas en blanco, numerar, propiedades ----------
const tamTexto = b => b > 1e6 ? (b / 1e6).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
async function comprimirDoc() {
  const p = estado.activa; if (!p) return;
  const r = await dialogo({ titulo: 'Comprimir', texto: `Ahora pesa ${tamTexto(p.datos.byteLength)}. Las fotos y escaneos grandes se achican; el texto no cambia. Poco: se ve igual. Medio: casi igual. Mucho: para mandar por mail. Se puede deshacer con Ctrl+Z.`,
    botones: [{ t: 'Cancelar', v: null }, { t: 'Poco', v: 'poco' }, { t: 'Medio', v: 'medio', primario: true }, { t: 'Mucho', v: 'mucho' }] });
  if (!r) return;
  const op = { poco: { lado: 2600, calidad: 82 }, medio: { lado: 1900, calidad: 72 }, mucho: { lado: 1300, calidad: 58 } }[r.boton], antes = p.datos.byteLength;
  aviso('Comprimiendo…');
  let info = null;
  const ok = await aplicar(async b => { info = await api.comprimir(b, op); if (info.datos.byteLength >= b.byteLength * 0.98) throw Object.assign(new Error('nada'), { cancelado: true }); return info.datos; },
    { mensaje: 'Comprimido (Ctrl+Z para deshacer)' });
  if (ok) aviso(`Listo: pasó de ${tamTexto(antes)} a ${tamTexto(p.datos.byteLength)}. Acordate de guardar (Ctrl+S).`);
  else if (info) aviso('No se pudo achicar más: este PDF ya está liviano.');
}
async function repararDoc() {
  const p = estado.activa; if (!p) return;
  let info = null;
  info = await api.reparar(p.datos).catch(e => { mostrarError(e); return null; });
  if (!info) return;
  if (!info.reparado) return aviso('El archivo está sano: no hacía falta reparar nada (no cambié nada).');
  const ok = await aplicar(async b => (await api.reparar(b)).datos, { mensaje: 'Reparado (Ctrl+Z para deshacer)' });
  if (ok) aviso(`Listo: tenía partes rotas y se arreglaron (${info.paginas} páginas). Guardalo con Ctrl+S.`);
}
async function quitarBlancas() {
  const p = estado.activa; if (!p) return;
  aviso('Buscando hojas en blanco…');
  const blancas = await api.hojasEnBlanco(await completo(p)).catch(e => { mostrarError(e); return null; });
  if (!blancas) return;
  if (!blancas.length) return aviso('No encontré hojas en blanco.');
  if (blancas.length === visor().total) return aviso('Todas las hojas parecen en blanco: no saco ninguna.', true);
  const lista = blancas.map(i => i + 1).join(', ');
  const r = await dialogo({ titulo: 'Quitar hojas en blanco', texto: blancas.length === 1 ? `La hoja ${lista} está en blanco. ¿La saco?` : `Estas ${blancas.length} hojas están en blanco: ${lista}. ¿Las saco?`,
    botones: [{ t: 'Cancelar', v: null }, { t: blancas.length === 1 ? 'Sacarla' : 'Sacarlas', v: 'si', primario: true }] });
  if (r) await aplicar(b => ops.eliminar(b, blancas), { mensaje: (blancas.length === 1 ? 'Hoja en blanco sacada' : `${blancas.length} hojas en blanco sacadas`) + ' (Ctrl+Z para deshacer)' });
}
async function numerarDoc() {
  const p = estado.activa; if (!p) return;
  const ya = await ops.leerNumeracion(p.datos), o = ya || { posicion: 'abajo-centro', formato: 'n', desde: 1, primero: 1, tam: 10 };
  const sel = (opciones, v) => el('select', { class: 'campo' }, ...opciones.map(([k, t]) => el('option', { value: k, selected: k === v }, t)));
  const cActivo = sel([['si', 'Con números'], ['no', 'Sin números']], 'si');
  const cPos = sel([['abajo-centro', 'Abajo, al centro'], ['abajo-derecha', 'Abajo, a la derecha'], ['abajo-izquierda', 'Abajo, a la izquierda'], ['arriba-centro', 'Arriba, al centro'], ['arriba-derecha', 'Arriba, a la derecha']], o.posicion);
  const cFor = sel([['n', '1, 2, 3…'], ['n/t', '1/10, 2/10…'], ['pagina', 'Página 1 de 10']], o.formato);
  const num = (v, min, max) => el('input', { class: 'campo', type: 'number', min, max, value: v, style: 'width:70px' });
  const cDesde = num(o.desde, 1, visor().total), cPrimero = num(o.primero ?? 1, 0, 9999), cTam = num(o.tam, 6, 24);
  const fila = (t, c) => el('div', { class: 'pref-fila' }, el('span', {}, t), c);
  const opciones = el('div', { class: 'pref-seccion' }, fila('Dónde', cPos), fila('Cómo', cFor), fila('Desde la hoja', cDesde), fila('Empezar en el número', cPrimero), fila('Tamaño de la letra', cTam));
  cActivo.onchange = () => { opciones.hidden = cActivo.value === 'no'; };
  const r = await dialogo({ titulo: 'Numerar páginas', texto: ya ? 'Este documento ya tiene números puestos por pdf.pro: podés cambiarlos o sacarlos.' : null,
    contenido: el('div', { class: 'pref-seccion' }, fila('Números de página', cActivo), opciones),
    botones: [{ t: 'Cancelar', v: null }, { t: 'Aplicar', v: 'si', primario: true }] });
  if (!r) return;
  if (cActivo.value === 'no') {
    if (!ya) return aviso('Este documento no tiene números puestos por pdf.pro.');
    return aplicar(b => ops.numerar(b, { activo: false }), { mensaje: 'Números de página sacados (Ctrl+Z para deshacer)' });
  }
  const desde = Math.min(visor().total, Math.max(1, +cDesde.value || 1));
  await aplicar(b => ops.numerar(b, { posicion: cPos.value, formato: cFor.value, desde, primero: Math.max(0, +cPrimero.value || 1), tam: Math.min(24, Math.max(6, +cTam.value || 10)) }),
    { mensaje: (ya ? 'Números de página cambiados' : 'Páginas numeradas') + ' (Ctrl+Z para deshacer)' });
}
async function propiedadesDoc() {
  const p = estado.activa; if (!p) return;
  const [pr, fuentes, firmasDig] = await Promise.all([ops.leerPropiedades(p.datos), api.fuentesDelPdf(p.datos).catch(() => []), api.firmasDigitales(p.datos).catch(() => 0)]);
  const campo = (v, ph) => el('input', { class: 'campo', value: v, placeholder: ph, style: 'width:100%;text-align:left' });
  const cT = campo(pr.titulo, 'Sin título'), cA = campo(pr.autor, 'Sin autor'), cS = campo(pr.asunto, ''), cK = campo(pr.claves, 'separadas por coma');
  const cm = v => (v / 72 * 2.54).toFixed(1).replace('.', ',');
  const fecha = d => d ? new Date(d).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '-';
  const fila = (t, c) => el('div', { class: 'pref-fila' }, el('span', {}, t), typeof c === 'string' ? el('span', {}, c) : c);
  const seguridad = p.proteccion ? (p.proteccion.clave ? 'Con contraseña para abrir' : 'Con restricciones') : 'Sin contraseña';
  const contenido = el('div', { class: 'pref' },
    el('section', { class: 'pref-seccion' }, el('h4', {}, 'Se pueden cambiar'), fila('Título', cT), fila('Autor', cA), fila('Asunto', cS), fila('Palabras clave', cK)),
    el('section', { class: 'pref-seccion' }, el('h4', {}, 'Datos del archivo'),
      fila('Páginas', String(pr.paginas)), fila('Tamaño de la hoja', `${cm(pr.ancho)} × ${cm(pr.alto)} cm`), fila('Peso', tamTexto(p.datos.byteLength)),
      fila('Versión de PDF', pr.version), fila('Hecho con', [pr.programa, pr.productor].filter(Boolean).join(' / ') || '-'),
      fila('Creado', fecha(pr.creado)), fila('Modificado', fecha(pr.modificado)), fila('Seguridad', seguridad),
      fila('Firmas digitales', firmasDig ? String(firmasDig) : 'No tiene'),
      fila('Fuentes', fuentes.length ? fuentes.map(f => f.nombre + (f.copiable === false ? '' : '')).join(', ') : '-')));
  const r = await dialogo({ titulo: 'Propiedades del documento', contenido, clase: 'dialogo-ancho', botones: [{ t: 'Cerrar', v: null }, { t: 'Guardar cambios', v: 'si', primario: true }] });
  if (!r) return;
  const nuevos = { titulo: cT.value.trim(), autor: cA.value.trim(), asunto: cS.value.trim(), claves: cK.value.trim() };
  if (nuevos.titulo === pr.titulo && nuevos.autor === pr.autor && nuevos.asunto === pr.asunto && nuevos.claves === pr.claves) return;
  await aplicar(b => ops.ponerPropiedades(b, nuevos), { mensaje: 'Propiedades cambiadas (Ctrl+Z para deshacer)' });
}
// Censurar: borra del archivo lo que hay en el recuadro (no es tapar: lo de abajo no queda). r en píxeles de la vista
async function censurar(pg, r) {
  const ok = await dialogo({ titulo: 'Censurar', texto: 'Lo que está en el recuadro se borra del archivo para siempre (texto, imágenes y dibujos) y queda un recuadro negro. No es como tapar con Rellenar: acá lo de abajo desaparece y nadie lo puede recuperar. (Hasta que guardes, Ctrl+Z lo deshace.)',
    botones: [{ t: 'Cancelar', v: null }, { t: 'Borrar de verdad', v: 'si', primario: true }] });
  if (!ok) return;
  const [a, b] = pg.vista.convertToPdfPoint(r.x, r.y), [c, d] = pg.vista.convertToPdfPoint(r.x + r.w, r.y + r.h);
  const zona = [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)], p = estado.activa;
  if (!(await aplicar(bytes => api.censurar(bytes, pg.n, [zona]), { mensaje: 'Censurado: se borró del archivo (Ctrl+Z para deshacer)' }))) return;
  // lo escrito encima con Rellenar o los comentarios que tocan la zona también se van (el Ctrl+Z los devuelve junto con lo censurado)
  const toca = r => r && r[0] < zona[2] && r[2] > zona[0] && r[1] < zona[3] && r[3] > zona[1];
  const quedan = p.comentarios.filter(x => x.n !== pg.n || !toca(x.rect || x.quads?.flat().reduce((m, q) => [Math.min(m[0], q[0]), Math.min(m[1], q[1]), Math.max(m[2], q[0]), Math.max(m[3], q[1])], [1e9, 1e9, -1e9, -1e9])));
  if (quedan.length !== p.comentarios.length) { p.comentarios = quedan; comentarios.redibujar(p); }
}
// Copia editable de un PDF con firma digital: en una pestaña nueva (el original queda igual)
async function copiaEditable() {
  const p = estado.activa; if (!p) return;
  const r = await api.copiaEditable(await completo(p)).catch(e => { mostrarError(e); return null; });
  if (!r) return;
  if (!r.firmas) return aviso('Este PDF no tiene firmas digitales: ya se puede editar.');
  await nuevaPestana(r.datos, { nombre: p.nombre.replace(/\.pdf$/i, '') + ' (editable).pdf', guardada: false });
  aviso(`Listo: copia editable. ${r.firmas === 1 ? 'La firma quedó' : `Las ${r.firmas} firmas quedaron`} dibujada${r.firmas === 1 ? '' : 's'} en la hoja, sin el bloqueo. El original no se tocó.`);
}
function verRecorrido() {
  if (!estado.activa) return aviso('Abrí un PDF y te muestro dónde está cada cosa.');
  recorrido({ el, nombreMascota: mascota.nombre, alTerminar: () => { estado.prefs.recorridoVisto = true; api.guardarPref('recorridoVisto', true); } });
}
// Reabrir la última pestaña cerrada (Ctrl+Shift+T): la del archivo guardado, o la copia en memoria si nunca se guardó
const cerradas = [];
async function reabrirCerrada() {
  const c = cerradas.pop();
  if (!c) return aviso('No hay pestañas cerradas para volver a abrir.');
  if (c.ruta) return abrirRutas([c.ruta]);
  await nuevaPestana(c.datos, { nombre: c.nombre, guardada: false });
}
// Ctrl+K: buscar cualquier comando escribiendo ("rotar", "firmar", "comprimir")
function buscarComando() {
  if (document.querySelector('.comandos')) return;
  const sinTildes = t => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const todos = Object.entries(definirMenus()).flatMap(([menu, items]) => items.filter(x => x && x.t && x.f && !x.off).map(x => ({ ...x, menu })));
  const entrada = el('input', { class: 'campo comandos-entrada', placeholder: 'Escribí qué querés hacer… (por ejemplo: rotar, firmar, comprimir)' });
  const lista = el('div', { class: 'comandos-lista' });
  const caja = el('dialog', { class: 'dialogo comandos' }, entrada, lista);
  let vistos = [], sel = 0;
  const dibujar = () => {
    const q = sinTildes(entrada.value).split(/\s+/).filter(Boolean);
    vistos = todos.filter(x => q.every(w => sinTildes(x.t + ' ' + x.menu).includes(w))).slice(0, 12);
    sel = Math.min(sel, Math.max(0, vistos.length - 1));
    lista.replaceChildren(...(vistos.length ? vistos.map((x, i) => el('button', { class: 'comandos-item' + (i === sel ? ' elegido' : ''), onclick: () => ir(x) },
      el('span', {}, x.t), el('small', { class: 'sutil' }, x.menu + (x.a ? ' · ' + x.a : '')))) : [el('p', { class: 'sutil' }, 'No encontré nada con eso.')]));
  };
  const ir = x => { caja.close(); api.miga?.('Ctrl+K: ' + x.t); setTimeout(() => x.f(), 0); };
  entrada.addEventListener('input', () => { sel = 0; dibujar(); });
  entrada.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(vistos.length - 1, sel + 1); dibujar(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); dibujar(); }
    else if (e.key === 'Enter' && vistos[sel]) { e.preventDefault(); ir(vistos[sel]); }
  });
  caja.addEventListener('close', () => setTimeout(() => caja.remove(), 0));
  caja.addEventListener('click', e => { if (e.target === caja) caja.close(); });
  document.body.append(caja); caja.showModal(); dibujar(); entrada.focus();
}
async function compararOriginal() {
  const p = estado.activa;
  if (!p?.abierto) return;
  aviso('Comparando…');
  const comp = d => ops.componerTodo(d.datos, d.firmas, d.comentarios, false, d.campos || {});
  let r;
  try { r = await api.compararDocumentos(await comp(p.abierto), await completo(p)); } catch (e) { return mostrarError(e); }
  const corto = t => t.length > 90 ? t.slice(0, 90) + '…' : t;
  const items = r.hojas.map(h => el('li', {},
    el('button', { class: 'btn-texto enlace', onclick: () => { d.close(); visor()?.irAPagina(h.n); } }, `Hoja ${h.n}`),
    el('span', { class: 'sutil' }, h.tamano ? ' (cambió el tamaño)' : h.cajas.length ? ` · ${h.cajas.length} zona${h.cajas.length > 1 ? 's' : ''}` : ''),
    ...h.quitado.slice(0, 6).map(t => el('div', { class: 'comp-quitado' }, '− ' + corto(t))),
    ...h.agregado.slice(0, 6).map(t => el('div', { class: 'comp-agregado' }, '+ ' + corto(t)))));
  const extra = r.despues !== r.antes ? el('p', {}, r.despues > r.antes ? `Se agregaron ${r.despues - r.antes} hoja(s) al final o en el medio.` : `Se sacaron ${r.antes - r.despues} hoja(s).`) : null;
  const lista = el('div', { class: 'comparar' }, extra, r.hojas.length ? el('ul', {}, ...items) : el('p', {}, 'No hay diferencias con cómo estaba al abrirlo.'));
  p.marcasCambio = r.hojas;
  for (const pg of visor()?.paginas || []) dibujarMarcasCambio(p, pg);
  const dlg = dialogo({ titulo: 'Cambios desde que lo abriste', texto: r.hojas.length ? 'Las zonas que cambiaron quedan marcadas en el documento hasta el próximo cambio.' : null, contenido: lista,
    botones: [{ t: 'Cerrar', v: null, primario: true }] });
  const d = lista.closest('dialog');
  await dlg;
}
function dibujarMarcasCambio(p, pg) {
  pg.div?.querySelectorAll('.marca-cambio').forEach(x => x.remove());
  const h = p.marcasCambio?.find(x => x.n === pg.n), v = pg.vista;
  if (!h || !v) return;
  for (const r of h.cajas) {
    const [a, b, c, d] = v.convertToViewportRectangle(r);
    pg.div.append(el('div', { class: 'marca-cambio', style: `left:${Math.min(a, c) / v.width * 100}%;top:${Math.min(b, d) / v.height * 100}%;width:${Math.abs(c - a) / v.width * 100}%;height:${Math.abs(d - b) / v.height * 100}%` }));
  }
}
function acercaDe() {
  dialogo({ titulo: '', clase: 'acerca', botones: [{ t: 'Cerrar', v: null, primario: true }], contenido: el('div', { class: 'acerca-caja' },
    el('img', { src: 'marca/simbolo.svg', alt: '' }),
    el('div', { class: 'logotipo grande' }, 'pdf', el('b', {}, '.pro')),
    el('p', {}, 'Tu universo documental, más simple.'),
    el('p', { class: 'acerca-autor' }, 'Hecho por Matías Russo, para amigos y familia'),
    el('small', { class: 'sutil' }, `Versión ${estado.version}`)) });
}

// ---------- Pantalla de inicio ----------
// "C:\Users\Matías\Documents\Cosas de Tizi\x.pdf" → "Documents › Cosas de Tizi"
const carpetaCorta = ruta => ruta.split(/[\\/]/).slice(0, -1).filter(Boolean).slice(-2).join(' › ');
function saludar() {
  const n = (estado.prefs.nombre || '').trim();
  $('#saludo').replaceChildren(n ? `Hola, ${n}. ` : 'Hola. ', el('span', { class: 'destacado' }, '¿Qué abrimos hoy?'));
}
async function dibujarInicio() {
  if (estado.activa) return;
  const lista = await api.recientes();
  const ul = $('#lista-recientes');
  ul.replaceChildren(...(lista.length ? lista.map(r => el('li', {},
    el('button', { class: 'reciente', onclick: () => abrirRutas([r.ruta]), title: r.ruta },
      el('span', { class: 'icono-doc', html: icono.documento }),
      el('span', { class: 'datos' }, el('b', {}, r.nombre), el('small', {}, carpetaCorta(r.ruta))),
      el('span', { class: 'cuando' }, hace(r.fecha))))) : [el('li', { class: 'vacio' }, 'Todavía no abriste ningún PDF.')]));
}

// ---------- Barra de comandos ----------
const cmd = {};
function boton(id, ic, titulo, accion, clase = 'btn-icono') {
  cmd[id] = el('button', { class: clase, title: titulo, 'aria-label': titulo, html: ic, onclick: accion, 'data-cmd': id });
  return cmd[id];
}
function armarComandos() {
  cmd.pagina = el('input', { class: 'campo campo-pagina', 'aria-label': 'Página actual',
    onkeydown: e => { if (e.key === 'Enter') { visor()?.irAPagina(+e.target.value); e.target.blur(); } } });
  cmd.total = el('span', { class: 'total-paginas' });
  cmd.zoom = el('input', { class: 'campo campo-zoom', 'aria-label': 'Zoom',
    onkeydown: e => { if (e.key === 'Enter') { const n = parseFloat(e.target.value); if (n > 0) visor()?.setZoom(n / 100); e.target.blur(); } } });
  const barra = $('#barra-comandos');
  barra.append(
    boton('abrir', icono.abrir + '<span>Abrir</span>', 'Abrir (Ctrl+O)', abrirDialogo, 'btn-texto'),
    boton('guardar', icono.guardar, 'Guardar (Ctrl+S)', () => guardar()),
    boton('imprimir', icono.imprimir, 'Imprimir (Ctrl+P)', imprimir),
    boton('deshacer', icono.deshacer, 'Deshacer (Ctrl+Z)', () => deshacer(1)),
    boton('rehacer', icono.rehacer, 'Rehacer (Ctrl+Y)', () => deshacer(-1)),
    el('span', { class: 'separador' }),
    boton('organizar', icono.organizar + '<span>Organizar</span>', 'Organizar páginas (Ctrl+Mayús+O)', alternarOrganizador, 'btn-texto'),
    boton('editar', icono.editar + '<span>Editar</span>', 'Editar el texto y las imágenes del PDF', editar, 'btn-texto'),
    boton('rellenar', icono.texto + '<span>Rellenar</span>', 'Rellenar un formulario: hacé clic en el renglón y escribí', () => comentarios.usar('rellenar'), 'btn-texto'),
    boton('comentar', icono.comentar + '<span>Comentar</span>', 'Resaltar, notas, texto y dibujo', null, 'btn-texto'),
    boton('firmar', icono.firmar + '<span>Firmar</span>', 'Poner firma o sello', null, 'btn-texto'),
    el('span', { class: 'separador' }),
    boton('panel', icono.panel, 'Panel lateral (F4)', alternarPanel),
    el('span', { class: 'separador' }),
    boton('anterior', icono.arriba, 'Página anterior', () => visor()?.anterior()),
    boton('siguiente', icono.abajo, 'Página siguiente', () => visor()?.siguiente()),
    cmd.pagina, cmd.total,
    el('span', { class: 'separador' }),
    boton('alejar', icono.menos, 'Alejar (Ctrl+-)', () => visor()?.acercar(-1)),
    cmd.zoom,
    boton('acercar', icono.mas, 'Acercar (Ctrl++)', () => visor()?.acercar(1)),
    boton('ancho', icono.ancho, 'Ajustar al ancho (Ctrl+2)', () => visor()?.setZoom('ancho')),
    boton('completa', icono.pagina, 'Página completa (Ctrl+1)', () => visor()?.setZoom('pagina')),
    el('span', { class: 'separador' }),
    boton('continuo', icono.continuo, 'Desplazamiento continuo', () => cambiarModo('continuo')),
    boton('doble', icono.doble, 'Dos páginas', () => cambiarModo('doble')),
    boton('unica', icono.unica, 'Una página', () => cambiarModo('unica')),
    boton('rotar', icono.rotar, 'Rotar vista (Ctrl+R)', () => visor()?.rotar()),
    el('span', { class: 'espacio' }),
    boton('buscar', icono.buscar, 'Buscar (Ctrl+F)', abrirBusqueda),
    boton('voz', icono.voz, 'Leer en voz alta (Ctrl+Mayús+L)', alternarLectura),
    boton('pantalla', icono.pantalla, 'Pantalla completa (F11)', () => api.pantallaCompleta())
  );
  for (const [k, nombre] of [['firmar', 'Firmar'], ['comentar', 'Comentar']]) {
    cmd[k].dataset.menu = '1';
    cmd[k].addEventListener('mousedown', e => { e.preventDefault(); menuAbierto?.nombre === nombre ? cerrarMenu() : abrirMenu(nombre, cmd[k]); });
  }
}
function actualizarComandos() {
  herramientas.actualizar();
  const v = visor();
  if (!v?.doc) return;
  const p = estado.activa, org = !!estado.organizador;
  cmd.guardar.disabled = !modificada(p) && !!p.ruta;
  cmd.deshacer.disabled = !p.historial.length; cmd.rehacer.disabled = !p.rehacer.length;
  cmd.organizar.setAttribute('aria-pressed', org);
  cmd.rellenar.setAttribute('aria-pressed', comentarios.herramienta === 'rellenar');
  cmd.editar.setAttribute('aria-pressed', edicion.activo);
  for (const k of ['editar', 'rellenar', 'comentar', 'firmar', 'panel', 'anterior', 'siguiente', 'alejar', 'acercar', 'ancho', 'completa', 'continuo', 'doble', 'unica', 'rotar', 'buscar', 'voz']) cmd[k].disabled = org;
  cmd.pagina.disabled = org; cmd.zoom.disabled = org;
  if (org) return;
  if (document.activeElement !== cmd.pagina) cmd.pagina.value = v.actual;
  cmd.total.textContent = 'de ' + v.total;
  if (document.activeElement !== cmd.zoom) cmd.zoom.value = Math.round(v.escala * 100) + '%';
  cmd.anterior.disabled = v.actual <= 1; cmd.siguiente.disabled = v.actual >= v.total;
  cmd.ancho.setAttribute('aria-pressed', v.zoom === 'ancho'); cmd.completa.setAttribute('aria-pressed', v.zoom === 'pagina');
  for (const m of ['continuo', 'doble', 'unica']) cmd[m].setAttribute('aria-pressed', v.modo === m);
  cmd.panel.setAttribute('aria-pressed', !!estado.prefs.panel);
  cmd.voz.setAttribute('aria-pressed', estado.leyendo);
  cmd.voz.innerHTML = estado.leyendo ? icono.parar : icono.voz;
  marcarMiniatura(v.actual);
}
function cambiarModo(m) { visor()?.setModo(m); estado.prefs.modo = m; api.guardarPref('modo', m); }

// ---------- Panel lateral ----------
function alternarPanel() {
  if (herramientas.abierto) { herramientas.abierto = false; if (estado.prefs.panel) return herramientas.alternar(false); }
  estado.prefs.panel = !estado.prefs.panel; api.guardarPref('panel', estado.prefs.panel);
  $('#panel').hidden = !panelVisible();
  if (estado.prefs.panel) llenarPanel();
  actualizarComandos();
}
// Contraer el panel: queda una tira con las pestañas; tocar una (o ») lo vuelve a abrir
function contraerPanel(si, guardarlo = true) {
  estado.prefs.panelContraido = si; if (guardarlo) api.guardarPref('panelContraido', si);
  $('#panel').classList.toggle('contraido', si);
  const b = $('.panel-contraer'); b.textContent = si ? '»' : '«'; b.title = si ? 'Abrir el panel' : 'Contraer el panel (queda una tira al costado)';
  if (!si) llenarPanel();
}
// Ancho del panel: se arrastra su borde; queda guardado (entre 160 y 480 px)
function anchoPanel() {
  const panel = $('#panel'), borde = $('.panel-borde');
  if (estado.prefs.panelAncho) panel.style.width = estado.prefs.panelAncho + 'px';
  borde.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault(); borde.setPointerCapture(e.pointerId); borde.classList.add('arrastrando');
    const x0 = e.clientX, w0 = panel.getBoundingClientRect().width, signo = raiz.dataset.panelLado === 'derecha' ? -1 : 1;
    const mover = m => { panel.style.width = Math.round(Math.min(480, Math.max(160, w0 + (m.clientX - x0) * signo))) + 'px'; };
    const soltar = () => { borde.removeEventListener('pointermove', mover); borde.classList.remove('arrastrando');
      estado.prefs.panelAncho = parseInt(panel.style.width); api.guardarPref('panelAncho', estado.prefs.panelAncho); llenarPanel(); };
    borde.addEventListener('pointermove', mover); borde.addEventListener('pointerup', soltar, { once: true });
  });
}
function verPanel(vista) {
  herramientas.abierto = false;
  estado.prefs.panelVista = vista; api.guardarPref('panelVista', vista);
  if (!estado.prefs.panel) alternarPanel(); else llenarPanel();
}
let observadorMinis;
async function llenarPanel() {
  const v = visor();
  const cont = $('#panel-contenido');
  document.querySelectorAll('.panel-pestanas button').forEach(b => b.setAttribute('aria-selected', b.dataset.vista === estado.prefs.panelVista));
  $('.panel-pestanas').hidden = herramientas.abierto;
  $('#panel').classList.toggle('con-herramientas', herramientas.abierto);
  if (!v?.doc || $('#panel').hidden || $('#panel').classList.contains('contraido')) return;
  if (herramientas.abierto) { observadorMinis?.disconnect(); return herramientas.dibujarPanel(cont); }
  observadorMinis?.disconnect();
  if (estado.prefs.panelVista === 'marcadores') {
    const lista = await v.marcadores();
    const arbol = items => el('ul', {}, ...items.map(it => el('li', {},
      el('button', { onclick: () => it.n && v.irAPagina(it.n), title: it.n ? 'Página ' + it.n : '' }, it.titulo),
      it.hijos.length ? arbol(it.hijos) : null)));
    cont.replaceChildren(lista.length ? Object.assign(arbol(lista), { className: 'marcadores' }) : el('div', { class: 'vacio' }, 'Este documento no tiene marcadores.'));
    return;
  }
  if (estado.prefs.panelVista === 'comentarios') {
    const p = estado.activa, lista = [...p.comentarios].sort((a, b) => a.n - b.n);
    cont.replaceChildren(lista.length ? el('div', { class: 'lista-com' }, ...lista.map(c => el('button', { class: 'com-item' + (c.id === comentarios.sel ? ' sel' : ''),
      onclick: () => { v.irAPagina(c.n); setTimeout(() => comentarios.seleccionar(c.id), 150); } },
      el('span', { class: 'com-color', style: `--c:${c.color}` }),
      el('span', { class: 'com-datos' }, el('b', {}, TIPOS[c.tipo]), el('small', {}, 'Página ' + c.n), (c.nota || c.texto) ? el('span', { class: 'com-resumen' }, c.nota || '“' + c.texto + '”') : null))))
      : el('div', { class: 'vacio' }, 'Este documento no tiene comentarios. Pintá un texto y hacé clic derecho para resaltarlo.'));
    return;
  }
  const ancho = 150;
  observadorMinis = new IntersectionObserver(ents => {
    for (const e of ents) if (e.isIntersecting && !e.target.dataset.lista) {
      e.target.dataset.lista = '1';
      v.miniatura(+e.target.dataset.n, ancho).then(c => { e.target.style.height = Math.round(e.target.offsetWidth * c.height / c.width) + 'px'; e.target.replaceChildren(c); }).catch(() => {});
    }
  }, { root: cont, rootMargin: '400px 0px' });
  const items = [];
  for (let n = 1; n <= v.total; n++) {
    const marco = el('div', { class: 'marco', 'data-n': n, style: `width:${ancho}px;height:${Math.round(ancho * v.proporcion(n))}px` });
    items.push(el('button', { class: 'miniatura', 'data-n': n, onclick: () => v.irAPagina(n), 'aria-label': 'Página ' + n }, marco, el('span', { class: 'num' }, n)));
    observadorMinis.observe(marco);
  }
  cont.replaceChildren(...items);
  marcarMiniatura(v.actual, true);
}
// Vuelve a dibujar las miniaturas (panel y organizador) de las páginas cuyas firmas cambiaron
let minisPendientes = new Set(), temporizadorMinis;
function refrescarMiniaturas(p, antes, ahora) {
  if (estado.activa !== p) return;
  const previas = new Map(antes.map(f => [f.id, f]));
  for (const f of ahora) {
    const a = previas.get(f.id);
    if (a !== f) { minisPendientes.add(f.n); if (a) minisPendientes.add(a.n); }
    previas.delete(f.id);
  }
  for (const f of previas.values()) minisPendientes.add(f.n);
  clearTimeout(temporizadorMinis);
  temporizadorMinis = setTimeout(() => {
    const v = visor(), paginas = minisPendientes; minisPendientes = new Set();
    if (!v?.doc) return;
    document.querySelectorAll('.marco[data-lista]').forEach(m => {
      if (paginas.has(+m.dataset.n)) v.miniatura(+m.dataset.n, parseInt(m.style.width)).then(c => m.replaceChildren(c)).catch(() => {});
    });
  }, 300);
}
function marcarMiniatura(n, desplazar = false) {
  const cont = $('#panel-contenido');
  let actual = null;
  cont.querySelectorAll('.miniatura').forEach(b => { const si = +b.dataset.n === n; b.setAttribute('aria-current', si); if (si) actual = b; });
  if (actual && (desplazar || !estado.arrastrandoPanel)) {
    const r = actual.getBoundingClientRect(), c = cont.getBoundingClientRect();
    if (r.top < c.top || r.bottom > c.bottom) actual.scrollIntoView({ block: 'nearest' });
  }
}

// ---------- Búsqueda ----------
function abrirBusqueda() {
  if (!visor()) return;
  $('#barra-buscar').hidden = false;
  const c = $('#buscar-texto'); c.focus(); c.select();
}
function cerrarBusqueda() {
  $('#barra-buscar').hidden = true; $('#buscar-texto').value = '';
  visor()?.buscar(''); $('#buscar-estado').textContent = '';
  visor()?.el.focus();
}
let temporizadorBusqueda;
function mostrarEstadoBusqueda(b) {
  $('#buscar-estado').textContent = !b.texto ? '' : !b.resultados.length ? 'Sin resultados' : `${b.indice + 1 || '–'} de ${b.resultados.length}`;
}
function armarBusqueda() {
  $('#buscar-ant').innerHTML = icono.arriba; $('#buscar-sig').innerHTML = icono.abajo; $('#buscar-cerrar').innerHTML = icono.cerrar;
  $('#buscar-texto').addEventListener('input', e => {
    clearTimeout(temporizadorBusqueda);
    temporizadorBusqueda = setTimeout(async () => mostrarEstadoBusqueda(await visor().buscar(e.target.value)), 250);
  });
  $('#buscar-texto').addEventListener('keydown', async e => {
    if (e.key === 'Enter') {
      const v = visor();
      if (normalizarSimple(e.target.value) !== v.busqueda.texto) await v.buscar(e.target.value);
      mostrarEstadoBusqueda(v.moverBusqueda(e.shiftKey ? -1 : 1));
    }
    if (e.key === 'Escape') cerrarBusqueda();
  });
  $('#buscar-sig').onclick = () => mostrarEstadoBusqueda(visor().moverBusqueda(1));
  $('#buscar-ant').onclick = () => mostrarEstadoBusqueda(visor().moverBusqueda(-1));
  $('#buscar-cerrar').onclick = cerrarBusqueda;
}
const normalizarSimple = s => s.trim().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ');

// ---------- Leer en voz alta (voces de Windows, sin internet) ----------
function vozEspanol() {
  const voces = speechSynthesis.getVoices();
  return voces.find(v => /es[-_]AR/i.test(v.lang)) || voces.find(v => /^es/i.test(v.lang) && v.localService) || voces.find(v => /^es/i.test(v.lang));
}
async function leerDesde(n) {
  const v = visor();
  if (!estado.leyendo || !v || n > v.total) { pararLectura(); return; }
  v.irAPagina(n);
  const texto = (await v.texto(n)).replace(/\s+/g, ' ').trim();
  if (!estado.leyendo) return;
  if (!texto) { leerDesde(n + 1); return; }
  // Se lee en partes cortas para que Windows no corte frases largas
  const partes = texto.match(/[^.!?;:]+[.!?;:]*/g) || [texto];
  let i = 0;
  const hablar = () => {
    if (!estado.leyendo) return;
    if (i >= partes.length) { leerDesde(n + 1); return; }
    const u = new SpeechSynthesisUtterance(partes[i++]);
    const voz = vozEspanol(); if (voz) u.voice = voz;
    u.lang = voz?.lang || 'es-AR';
    u.onend = hablar; u.onerror = hablar;
    speechSynthesis.speak(u);
  };
  hablar();
}
function alternarLectura() {
  if (!visor()) return;
  if (estado.leyendo) { pararLectura(); return; }
  estado.leyendo = true; actualizarComandos();
  aviso('Leyendo en voz alta. Volvé a tocar el botón para parar.');
  leerDesde(visor().actual);
}
function pararLectura() { estado.leyendo = false; speechSynthesis.cancel(); actualizarComandos(); }

// ---------- Menús ----------
function definirMenus() {
  const v = visor(), hay = !!v;
  const tema = estado.prefs.tema;
  return {
    Archivo: [
      { t: 'Abrir…', a: 'Ctrl+O', f: abrirDialogo },
      { t: 'Crear PDF desde imágenes…', f: crearDesdeImagenes },
      { t: 'Unir varios PDF en uno…', f: unirVarios },
      { titulo: 'Recientes', recientes: true },
      '-',
      { t: 'Guardar', a: 'Ctrl+S', f: () => guardar(), off: !hay },
      { t: 'Guardar como…', a: 'Ctrl+Mayús+S', f: () => guardar(estado.activa, true), off: !hay },
      { t: 'Cerrar pestaña', a: 'Ctrl+W', f: () => cerrar(), off: !hay },
      { t: 'Volver a abrir la pestaña cerrada', a: 'Ctrl+Shift+T', f: reabrirCerrada, off: !cerradas.length },
      { t: 'Propiedades del documento…', f: propiedadesDoc, off: !hay },
      { t: 'Mostrar en la carpeta', f: () => api.mostrarEnCarpeta(estado.activa.ruta), off: !estado.activa?.ruta },
      { t: 'Versiones anteriores (respaldos)…', tip: 'Cada vez que guardás encima de un archivo, la versión anterior queda acá', f: () => api.abrirRespaldos() },
      '-',
      { t: 'Imprimir…', a: 'Ctrl+P', f: imprimir, off: !hay },
      { t: 'Guardar como Word (.docx)…', f: () => exportar('docx'), off: !hay },
      { t: 'Guardar como Excel (.xlsx)…', f: () => exportar('xlsx'), off: !hay },
      '-',
      { t: 'Proteger con contraseña…', f: protegerDialogo, off: !hay },
      { t: 'Quitar la contraseña', f: () => cambiarProteccion(estado.activa, null, 'Listo. Al guardar (Ctrl+S) queda sin contraseña ni restricciones.'), off: !estado.activa?.proteccion },
      '-',
      { t: 'Salir', f: () => api.cerrar() }
    ],
    Edición: [
      { t: 'Deshacer' + (estado.activa?.historial.at(-1)?.que ? ': ' + estado.activa.historial.at(-1).que : ''), a: 'Ctrl+Z', f: () => deshacer(1), off: !estado.activa?.historial.length },
      { t: 'Rehacer' + (estado.activa?.rehacer.at(-1)?.que ? ': ' + estado.activa.rehacer.at(-1).que : ''), a: 'Ctrl+Y', f: () => deshacer(-1), off: !estado.activa?.rehacer.length },
      '-',
      { t: 'Cortar', a: 'Ctrl+X', f: () => copiarObjeto(true), off: !hay || !(firmas.sel || comentarios.sel) },
      { t: 'Copiar', a: 'Ctrl+C', f: async () => { if (!(await copiarObjeto())) document.execCommand('copy'); }, off: !hay },
      { t: 'Pegar', a: 'Ctrl+V', f: () => pegar(), off: !hay || !!estado.organizador },
      { t: 'Copiar área como imagen', f: () => comentarios.usar('captura'), off: !hay || !!estado.organizador },
      { t: 'Seleccionar todo el texto de la página', a: 'Ctrl+A', f: seleccionarPagina, off: !hay },
      '-',
      { t: 'Buscar…', a: 'Ctrl+F', f: abrirBusqueda, off: !hay },
      '-',
      { t: 'Preferencias…', a: 'Ctrl+,', f: preferencias }
    ],
    Ver: [
      { t: 'Panel lateral', a: 'F4', f: alternarPanel, check: estado.prefs.panel, off: !hay },
      { t: 'Miniaturas de páginas', f: () => verPanel('miniaturas'), off: !hay },
      { t: 'Marcadores', f: () => verPanel('marcadores'), off: !hay },
      { t: 'Seleccionar texto (cursor)', a: 'V', f: () => herramientas.usarMano(false), check: !herramientas.mano, off: !hay },
      { t: 'Mano para mover la hoja', a: 'H', f: () => herramientas.usarMano(true), check: herramientas.mano, off: !hay },
      '-',
      { t: 'Todas las herramientas', f: () => herramientas.alternar(true), check: herramientas.abierto, off: !hay || !!estado.organizador },
      { t: 'Barra de herramientas rápidas', f: () => { estado.prefs.rapidas = estado.prefs.rapidas === false; api.guardarPref('rapidas', estado.prefs.rapidas); herramientas.actualizar(); }, check: estado.prefs.rapidas !== false },
      '-',
      { t: 'Acercar', a: 'Ctrl++', f: () => v.acercar(1), off: !hay },
      { t: 'Alejar', a: 'Ctrl+-', f: () => v.acercar(-1), off: !hay },
      { t: 'Tamaño real', a: 'Ctrl+0', f: () => v.setZoom(1), off: !hay },
      { t: 'Página completa', a: 'Ctrl+1', f: () => v.setZoom('pagina'), off: !hay, check: v?.zoom === 'pagina' },
      { t: 'Ajustar al ancho', a: 'Ctrl+2', f: () => v.setZoom('ancho'), off: !hay, check: v?.zoom === 'ancho' },
      '-',
      { t: 'Desplazamiento continuo', f: () => cambiarModo('continuo'), off: !hay, check: v?.modo === 'continuo' },
      { t: 'Dos páginas', f: () => cambiarModo('doble'), off: !hay, check: v?.modo === 'doble' },
      { t: 'Una página', f: () => cambiarModo('unica'), off: !hay, check: v?.modo === 'unica' },
      { t: 'Rotar vista', a: 'Ctrl+R', f: () => v.rotar(), off: !hay },
      '-',
      { t: estado.leyendo ? 'Parar lectura en voz alta' : 'Leer en voz alta', a: 'Ctrl+Mayús+L', f: alternarLectura, off: !hay },
      { t: 'Pantalla completa', a: 'F11', f: () => api.pantallaCompleta() },
      '-',
      { titulo: 'Tema' },
      { t: 'Igual que Windows', f: () => cambiarTema('sistema'), check: tema === 'sistema' },
      { t: 'Claro', f: () => cambiarTema('claro'), check: tema === 'claro' },
      { t: 'Oscuro', f: () => cambiarTema('oscuro'), check: tema === 'oscuro' }
    ],
    Páginas: [
      { t: estado.organizador ? 'Volver al documento' : 'Organizar páginas', a: 'Ctrl+Mayús+O', f: alternarOrganizador, off: !hay },
      '-',
      { t: 'Rotar página actual a la derecha', f: () => aplicar(b => ops.rotar(b, [actual0()], 90), { mensaje: 'Página rotada' }), off: !hay },
      { t: 'Rotar página actual a la izquierda', f: () => aplicar(b => ops.rotar(b, [actual0()], -90), { mensaje: 'Página rotada' }), off: !hay },
      { t: 'Rotar todas las páginas a la derecha', f: () => aplicar(b => ops.rotar(b, [...Array(visor().total).keys()], 90), { mensaje: 'Todas las páginas rotadas' }), off: !hay },
      { t: 'Eliminar página actual', f: () => visor().total > 1 ? aplicar(b => ops.eliminar(b, [actual0()]), { mensaje: 'Página eliminada (Ctrl+Z para deshacer)' }) : aviso('No se puede eliminar la única página.', true), off: !hay },
      '-',
      { t: 'Insertar páginas de otro PDF…', f: async () => { const r = await api.elegirPdf(); if (r.length) { const otros = await Promise.all(r.map(x => api.leerBytes(x))); const pos = actual0(); aplicar(b => ops.insertarDesde(b, otros, pos), { mensaje: 'Páginas insertadas después de la página ' + (pos + 1), pagina: pos + 2 }); } }, off: !hay },
      { t: 'Insertar página en blanco', f: () => { const pos = actual0(); aplicar(b => ops.insertarBlanco(b, pos), { mensaje: 'Página en blanco insertada', pagina: pos + 2 }); }, off: !hay },
      { t: 'Extraer páginas…', f: extraerDialogo, off: !hay },
      '-',
      { t: 'Unir con otros PDF…', f: async () => { const r = await api.elegirPdf(); if (r.length) { const otros = await Promise.all(r.map(x => api.leerBytes(x))); const n = visor().total; aplicar(b => ops.insertarDesde(b, otros, n - 1), { mensaje: 'Documentos agregados al final', pagina: n + 1 }); } }, off: !hay },
      { t: 'Separar documento…', f: () => separarDocumento(ctxOrganizador, estado.activa), off: !hay }
    ],
    Comentar: [
      ...[['resaltar', 'Resaltar texto'], ['subrayar', 'Subrayar texto'], ['tachar', 'Tachar texto'], '-', ['nota', 'Nota'], ['texto', 'Cuadro de texto'], ['dibujo', 'Dibujar a mano']]
        .map(x => x === '-' ? x : { t: x[1], f: () => comentarios.usar(x[0]), check: comentarios.herramienta === x[0], off: !hay || !!estado.organizador }),
      '-',
      { t: 'Lista de comentarios', f: () => verPanel('comentarios'), off: !hay },
      { t: 'Borrar todos los comentarios…', f: borrarComentarios, off: !estado.activa?.comentarios.length || !!estado.organizador }
    ],
    Herramientas: [
      { t: 'Editar texto e imágenes', f: editar, check: edicion.activo, off: !hay || !!estado.organizador },
      '-',
      { t: 'Comparar con como estaba al abrir', f: compararOriginal, off: !hay || !!estado.organizador },
      '-',
      { t: 'Comprimir (achicar el archivo)…', f: comprimirDoc, off: !hay },
      { t: 'Reparar un PDF dañado', f: repararDoc, off: !hay },
      { t: 'Quitar hojas en blanco…', f: quitarBlancas, off: !hay },
      { t: 'Numerar páginas…', f: numerarDoc, off: !hay },
      { t: 'Censurar (borrar de verdad)', f: () => comentarios.usar('censurar'), off: !hay || !!estado.organizador },
      { t: 'Copia editable (PDF con firma digital)', f: copiaEditable, off: !hay },
      '-',
      { t: 'Buscar un comando…', a: 'Ctrl+K', f: buscarComando },
      '-',
      { t: 'Reconocer texto (OCR) en todo el documento', f: () => ocr(), off: !hay },
      { t: 'Reconocer texto de esta página', f: () => ocr({ soloActual: true }), off: !hay },
      { t: 'Reconocer texto de un área…', f: () => comentarios.usar('leer'), off: !hay || !!estado.organizador },
      '-',
      { t: 'Guardar como Word (.docx)…', f: () => exportar('docx'), off: !hay },
      { t: 'Guardar como Excel (.xlsx)…', f: () => exportar('xlsx'), off: !hay },
      { t: 'Crear PDF desde Word, Excel o PowerPoint…', f: async () => { for (const r of (await api.elegirPdf(true)).filter(esOffice)) await abrirOffice(r); } }
    ],
    Asistente: [
      { t: `Hablar con ${mascota.nombre}`, f: () => mascota.alternar(true) },
      { t: 'Completar este documento', f: () => mascota.completar(), off: !hay },
      { t: 'Perfiles de datos…', f: () => mascota.perfiles() },
      '-',
      { t: 'Resumir', f: () => iaLocal(), off: !hay },
      { t: 'Preguntar…', f: () => iaLocal({ resumir: false }), off: !hay },
      '-',
      { t: 'Ajustes de la IA (Claude o Gemini)…', f: ajustesIA }
    ],
    Firmar: [
      { t: 'Rellenar formulario (escribir encima)', f: () => comentarios.usar('rellenar'), check: comentarios.herramienta === 'rellenar', off: !hay || !!estado.organizador },
      { t: `Completar con ${mascota.nombre}`, f: () => mascota.completar(), off: !hay },
      { t: 'Olvidar los datos que recuerda Rellenar…', f: olvidarRellenos, off: !Object.keys(estado.prefs.rellenos?.valores || {}).length },
      '-',
      { titulo: 'Poner en la página actual' },
      ...(firmas.lista.length ? firmas.lista.map(f => ({ t: f.nombre, img: f.url, a: f.tipo === 'sello' ? 'Sello' : 'Firma', f: () => firmas.nueva(f), off: !hay || !!estado.organizador }))
        : [{ t: 'Todavía no guardaste firmas ni sellos', off: true }]),
      '-',
      { t: 'Agregar firma o sello desde imagen…', f: agregarYColocar },
      { t: 'Administrar firmas y sellos…', f: () => firmas.administrar() },
      '-',
      { t: 'Fijar firmas en el documento', f: fijarFirmas, off: !estado.activa?.firmas.length || !!estado.organizador }
    ],
    Ayuda: [
      { t: 'Buscar actualizaciones…', f: () => buscarActualizacion(true) },
      '-',
      { t: 'Recorrido de bienvenida', f: verRecorrido },
      { t: 'Atajos de teclado', a: 'F1', f: mostrarAtajos },
      { t: 'Enviar informe de errores…', f: enviarInforme },
      { t: 'Acerca de pdf.pro', f: acercaDe }
    ],
    Compartir: [
      { titulo: 'Pasale pdf.pro a alguien' },
      { t: 'Enviar por WhatsApp', f: () => api.compartir('whatsapp') },
      { t: 'Enviar por mail', f: () => api.compartir('mail') },
      { t: 'Copiar el link de descarga', f: async () => { await api.compartir('copiar'); aviso('Link copiado. Pegalo donde quieras.'); } }
    ]
  };
}
let menuAbierto = null;
function cerrarMenu() { menuAbierto?.lista.remove(); menuAbierto?.boton?.setAttribute('aria-expanded', 'false'); menuAbierto = null; }
async function abrirMenu(nombre, boton) {
  const items = [];
  for (const it of definirMenus()[nombre]) {
    if (!it.recientes) { items.push(it); continue; }
    const rec = (await api.recientes()).slice(0, 5);
    if (rec.length) items.push({ titulo: it.titulo }, ...rec.map(r => ({ t: r.nombre, tip: r.ruta, f: () => abrirRutas([r.ruta]) })));
  }
  const r = boton.getBoundingClientRect();
  mostrarMenu(nombre, items, r.left, r.bottom + 4, boton);
}
// Dibuja una lista de opciones en (x, y). Ítems: '-' | { titulo } | { t, a (atajo), f, off, check, img, tip } | { colores, actual, f(color) }
function mostrarMenu(nombre, items, x, y, boton = null) {
  cerrarMenu();
  const lista = el('div', { class: 'menu-lista', role: 'menu' });
  items.forEach((it, i) => {
    if (it === '-') { if (i && items[i - 1] !== '-' && i < items.length - 1) lista.append(el('div', { class: 'menu-separador' })); return; }
    if (it.titulo) return lista.append(el('div', { class: 'menu-titulo' }, it.titulo));
    if (it.colores) return lista.append(el('div', { class: 'menu-colores paleta' }, ...COLORES.map(([c, n]) =>
      el('button', { class: 'color' + (c === it.actual ? ' elegido' : ''), title: n, 'aria-label': n, style: `--c:${c}`, onclick: () => { cerrarMenu(); it.f(c); } }))));
    lista.append(el('button', { class: 'menu-item', role: 'menuitem', disabled: !!it.off, title: it.tip || false, onclick: () => { cerrarMenu(); api.miga?.('menú: ' + it.t); it.f?.(); } },
      el('span', { class: 'marca-check' }, it.check ? '✓' : ''), it.img ? el('span', { class: 'menu-img damero' }, el('img', { src: it.img, alt: '' })) : null, el('span', { class: 'etiqueta' }, it.t), it.a ? el('span', { class: 'atajo' }, it.a) : null));
  });
  document.body.append(lista);
  const w = lista.offsetWidth, h = lista.offsetHeight;
  lista.style.left = Math.max(4, Math.min(x, innerWidth - w - 4)) + 'px';
  lista.style.top = (y + h > innerHeight - 4 ? Math.max(4, y - h) : y) + 'px';
  boton?.setAttribute('aria-expanded', 'true');
  menuAbierto = { nombre, lista, boton };
  if (estado.menuTeclado) { estado.menuTeclado = false; lista.querySelector('.menu-item:not([disabled])')?.focus(); }
}
// Menús con el teclado: flechas para moverse, Enter elige, izquierda/derecha cambian de menú, Esc cierra.
// Alt+letra abre el menú que empieza con esa letra (si hay dos, la segunda vez el otro); F10 abre Archivo.
function teclaMenu(e) {
  if (!menuAbierto) return false;
  const items = [...menuAbierto.lista.querySelectorAll('.menu-item:not([disabled])')], i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = items.length; if (!n) return true;
    items[i < 0 ? (e.key === 'ArrowDown' ? 0 : n - 1) : (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n].focus();
    return true;
  }
  if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && menuAbierto.boton?.closest('#menus')) {
    e.preventDefault();
    const bs = [...document.querySelectorAll('#menus .menu-boton')], j = bs.indexOf(menuAbierto.boton), b = bs[(j + (e.key === 'ArrowRight' ? 1 : bs.length - 1)) % bs.length];
    estado.menuTeclado = true; b.dispatchEvent(new MouseEvent('mousedown'));
    return true;
  }
  if (e.key === 'Enter' && i < 0 && items[0]) { e.preventDefault(); items[0].click(); return true; }
  return false;
}
function abrirMenuConLetra(letra) {
  const bs = [...document.querySelectorAll('#menus .menu-boton')].filter(b => b.textContent.trim().toLowerCase().startsWith(letra));
  if (!bs.length) return false;
  const j = bs.indexOf(menuAbierto?.boton), b = bs[(j + 1) % bs.length];
  estado.menuTeclado = true;
  if (menuAbierto?.boton === b) cerrarMenu();
  b.dispatchEvent(new MouseEvent('mousedown'));
  return true;
}

// ---------- Clic derecho ----------
const normalAng = a => ((a % 360) + 540) % 360 - 180;
function menuContextual(e) {
  e.preventDefault();
  const campo = e.target.closest('input:not([type=checkbox]):not([type=radio]):not([type=range]), textarea');
  if (campo) return mostrarMenu('contexto', menuCampo(campo), e.clientX, e.clientY);
  const v = visor(), p = estado.activa;
  if (!v?.doc || estado.organizador || !e.target.closest('.documento') || comentarios.herramienta || edicion.activo) return;
  const q = comentarios.puntoEn(e, v), sel = getSelection();
  const idFirma = e.target.closest('.estampa')?.dataset.id, f = idFirma && p.firmas.find(x => x.id === idFirma);
  const idCom = e.target.closest('.com')?.dataset.id;
  const c = (idCom && p.comentarios.find(x => x.id === idCom)) || (!f && sel.isCollapsed && comentarios.marcaEn(e, v, p));
  let items;
  if (f) {
    if (firmas.sel !== f.id) { firmas.sel = f.id; comentarios.deseleccionar(); firmas.redibujar(p); }
    const girar = d => cambiarFirmas(p, p.firmas.map(x => x.id === f.id ? { ...x, angulo: normalAng(x.angulo + d) } : x));
    items = [
      { t: 'Cortar', a: 'Ctrl+X', f: () => copiarObjeto(true) }, { t: 'Copiar', a: 'Ctrl+C', f: () => copiarObjeto() }, { t: 'Pegar', a: 'Ctrl+V', f: () => pegar(q) }, '-',
      { t: 'Duplicar', f: () => { const d = firmas.copiaPara(f); firmas.sel = d.id; cambiarFirmas(p, [...p.firmas, d], 'Duplicada'); } },
      { t: 'Poner en otras páginas…', f: () => firmas.copiarAPaginas(p, f) },
      { t: 'Girar a la derecha', f: () => girar(-90) }, { t: 'Girar a la izquierda', f: () => girar(90) }, '-',
      { t: 'Borrar', a: 'Supr', f: () => firmas.borrar(p) }, '-',
      { t: 'Fijar firmas en el documento', f: fijarFirmas }];
  } else if (c) {
    if (comentarios.sel !== c.id) comentarios.seleccionar(c.id);
    const marca = esMarca(c);
    items = [
      c.tipo === 'texto' ? { t: 'Escribir', a: 'Enter', f: () => comentarios.abrir(c) } : { t: c.nota ? 'Ver o cambiar la nota' : 'Agregar una nota', a: 'Enter', f: () => comentarios.abrir(c) },
      { titulo: 'Color' }, { colores: true, actual: c.color, f: color => comentarios.cambiar(c, { color }) }, '-',
      ...(marca ? [
        ...['resaltar', 'subrayar', 'tachar'].filter(t => t !== c.tipo).map(t => ({ t: 'Cambiar a ' + TIPOS[t].toLowerCase(), f: () => comentarios.cambiar(c, { tipo: t, color: comentarios.color[t] }) })),
        { t: 'Copiar el texto marcado', a: 'Ctrl+C', f: () => copiarObjeto() }]
      : [{ t: 'Cortar', a: 'Ctrl+X', f: () => copiarObjeto(true) }, { t: 'Copiar', a: 'Ctrl+C', f: () => copiarObjeto() }, { t: 'Pegar', a: 'Ctrl+V', f: () => pegar(q) },
        { t: 'Duplicar', f: () => { const d = comentarios.copiaPara(c); comentarios.sel = d.id; cambiarComentarios(p, [...p.comentarios, d], 'Duplicado'); } },
        ...(c.tipo === 'texto' ? [{ t: 'Repetir hacia abajo (tabla)…', f: () => repetirHaciaAbajo({ el, dialogo, api, aviso, cambiarComentarios }, p, c).catch(mostrarError) }] : [])]),
      '-', { t: 'Borrar', a: 'Supr', f: () => comentarios.borrar(c.id) }];
  } else if (!sel.isCollapsed && v.el.contains(sel.anchorNode)) {
    const texto = sel.toString().replace(/\s+/g, ' ').trim(), rango = sel.getRangeAt(0).cloneRange();
    const conRango = fn => () => { const s = getSelection(); s.removeAllRanges(); s.addRange(rango); fn(); };
    const corto = texto.length > 28 ? texto.slice(0, 26) + '…' : texto;
    items = [
      { t: 'Copiar', a: 'Ctrl+C', f: conRango(() => document.execCommand('copy')) }, '-',
      { t: 'Resaltar', f: conRango(() => comentarios.marcarSeleccion('resaltar')) },
      { t: 'Subrayar', f: conRango(() => comentarios.marcarSeleccion('subrayar')) },
      { t: 'Tachar', f: conRango(() => comentarios.marcarSeleccion('tachar')) },
      { t: 'Resaltar y escribir una nota', f: conRango(() => comentarios.marcarSeleccion('resaltar', { conNota: true })) }, '-',
      { t: `Buscar “${corto}”`, f: () => buscarTexto(texto) },
      { t: 'Leer en voz alta', f: () => leerTexto(texto) }, '-',
      { t: 'Seleccionar todo el texto de la página', a: 'Ctrl+A', f: seleccionarPagina }];
  } else if (q) {
    items = [
      { t: 'Pegar', a: 'Ctrl+V', f: () => pegar(q) }, '-',
      { t: 'Escribir acá', f: () => comentarios.rellenar(q, 'texto') },
      { t: 'Poner ✓ acá', f: () => comentarios.rellenar(q, 'tilde') },
      { t: 'Poner ✗ acá', f: () => comentarios.rellenar(q, 'cruz') },
      { t: `Poner la fecha de hoy acá (${hoy()})`, f: () => comentarios.rellenar(q, 'fecha') },
      { t: 'Agregar una nota acá', f: () => comentarios.nuevaNota(q) },
      ...(firmas.lista.length ? [{ titulo: 'Poner firma o sello acá' }, ...firmas.lista.slice(0, 6).map(x => ({ t: x.nombre, img: x.url, f: () => firmas.nueva(x, q) }))] : []), '-',
      { t: 'Copiar área como imagen', f: () => comentarios.usar('captura') },
      { t: 'Editar texto e imágenes', f: editar },
      { t: 'Seleccionar todo el texto de la página', a: 'Ctrl+A', f: () => { v.actual = q.pg.n; seleccionarPagina(); } }, '-',
      { t: 'Rotar esta página a la derecha', f: () => aplicar(b => ops.rotar(b, [q.pg.n - 1], 90), { mensaje: 'Página rotada' }) },
      { t: 'Imprimir…', a: 'Ctrl+P', f: imprimir }];
  } else return;
  mostrarMenu('contexto', items, e.clientX, e.clientY);
}
// Clic derecho en un campo para escribir (buscar, nombres, notas…)
function menuCampo(campo) {
  const hay = campo.selectionStart !== campo.selectionEnd, editable = !campo.readOnly && !campo.disabled;
  const hacer = fn => () => { campo.focus(); fn(); };
  return [
    { t: 'Deshacer', a: 'Ctrl+Z', f: hacer(() => document.execCommand('undo')), off: !editable }, '-',
    { t: 'Cortar', a: 'Ctrl+X', f: hacer(() => document.execCommand('cut')), off: !hay || !editable },
    { t: 'Copiar', a: 'Ctrl+C', f: hacer(() => document.execCommand('copy')), off: !hay },
    { t: 'Pegar', a: 'Ctrl+V', f: hacer(async () => { const { texto } = await api.portapapelesLeer(); campo.focus(); if (texto) document.execCommand('insertText', false, texto); }), off: !editable },
    { t: 'Borrar', a: 'Supr', f: hacer(() => document.execCommand('delete')), off: !hay || !editable }, '-',
    { t: 'Seleccionar todo', a: 'Ctrl+A', f: hacer(() => campo.select()) }];
}
function buscarTexto(texto) {
  abrirBusqueda();
  const c = $('#buscar-texto'); c.value = texto;
  visor().buscar(texto).then(() => mostrarEstadoBusqueda(visor().moverBusqueda(1)));
}
function leerTexto(texto) {
  if (estado.leyendo) pararLectura();
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(texto), voz = vozEspanol();
  if (voz) u.voice = voz;
  u.lang = voz?.lang || 'es-AR';
  speechSynthesis.speak(u);
}
function armarMenus() {
  const nav = $('#menus');
  const ROTULO = { Firmar: 'Rellenar y firmar' };
  for (const nombre of ['Archivo', 'Edición', 'Ver', 'Páginas', 'Firmar', 'Comentar', 'Herramientas', 'Asistente', 'Ayuda', 'Compartir']) {
    const b = el('button', { class: 'menu-boton', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, ROTULO[nombre] || nombre);
    b.addEventListener('mousedown', e => { e.preventDefault(); menuAbierto?.nombre === nombre ? cerrarMenu() : abrirMenu(nombre, b); });
    b.addEventListener('mouseenter', () => { if (menuAbierto && menuAbierto.nombre !== nombre) abrirMenu(nombre, b); });
    nav.append(b);
  }
  const todas = $('#todas-pestanas');
  todas.addEventListener('mousedown', e => { e.preventDefault(); menuAbierto?.nombre === 'pestanas' ? cerrarMenu() : listaDePestanas(todas); });
  $('#pestanas').addEventListener('wheel', e => { const c = e.currentTarget; if (c.scrollWidth > c.clientWidth) { c.scrollLeft += e.deltaY || e.deltaX; e.preventDefault(); } }, { passive: false });
  window.addEventListener('resize', () => dibujarPestanas());
  document.addEventListener('mousedown', e => { if (menuAbierto && !menuAbierto.lista.contains(e.target) && !e.target.closest('.menu-boton, [data-menu], .todas-pestanas')) cerrarMenu(); });
  document.addEventListener('contextmenu', menuContextual);
  window.addEventListener('blur', cerrarMenu);
  vigilarFlotantes();
}

// ---------- Cuadros sobre la página ----------
// Las barras de editar, comentar y firmas, las notas y las sugerencias se acomodan solas para verse enteras:
// de costado se corre el cuadro; de alto se corre la hoja (así no tapa lo que se edita) y, si no alcanza, el cuadro.
const FLOTANTES = '.ed-barra, .com-barra, .com-popup, .com-sugerencias, .estampa-barra';
let ultimaAccion = 0;
function encuadrar(e) {
  const doc = e.closest('.documento');
  if (!doc || !e.isConnected || e.hidden) return;
  Object.assign(e.style, { translate: '', maxWidth: '', whiteSpace: '', flexWrap: '' });
  const m = 8, V = doc.getBoundingClientRect(), izq = V.left + m, der = V.left + doc.clientWidth - m, arriba = V.top + m, abajo = V.top + doc.clientHeight - m;
  let r = e.getBoundingClientRect();
  if (r.bottom < V.top || r.top > abajo + m) return; // está fuera de la vista (por ejemplo, el usuario se fue a otra página)
  if (r.width > der - izq) { Object.assign(e.style, { maxWidth: der - izq + 'px', whiteSpace: 'normal', flexWrap: 'wrap' }); r = e.getBoundingClientRect(); }
  const dx = r.left < izq ? izq - r.left : r.right > der ? der - r.right : 0;
  let dy = r.bottom > abajo ? Math.min(r.bottom - abajo, r.top - arriba) : r.top < arriba ? r.top - arriba : 0;
  // correr la hoja solo justo después de un clic o una tecla, no cuando la página se vuelve a dibujar mientras se navega
  if (dy && Date.now() - ultimaAccion < 1500) { const antes = doc.scrollTop; doc.scrollTop += dy; dy -= doc.scrollTop - antes; }
  if (dx || dy) e.style.translate = `${dx}px ${-dy}px`;
  // que no quede debajo del botón de la mascota (se corre primero a la izquierda) ni la nota o las sugerencias
  // tapando otra barra (se corre para donde haya que moverse menos)
  const evitar = (M, izqPrimero) => {
    const k = e.getBoundingClientRect();
    if (!M?.width || k.right <= M.left - m || k.left >= M.right + m || k.bottom <= M.top - m || k.top >= M.bottom + m) return;
    let [tx, ty] = e.style.translate.split(' ').map(x => parseFloat(x) || 0); ty ||= 0;
    const mx = M.left - m - k.right, my = M.top - m - k.bottom, puedeIzq = k.left + mx >= izq, puedeArriba = k.top + my >= arriba;
    if (puedeIzq && (izqPrimero || !puedeArriba || mx >= my)) tx += mx; else if (puedeArriba) ty += my; else tx += mx;
    e.style.translate = `${tx}px ${ty}px`;
  };
  evitar($('.mascota:not([hidden])')?.getBoundingClientRect(), true);
  const pagina = e.closest('.pagina');
  if (e.matches('.com-popup, .com-sugerencias')) pagina?.querySelectorAll(FLOTANTES).forEach(o => o !== e && !o.hidden && !o.matches('.com-popup, .com-sugerencias') && evitar(o.getBoundingClientRect()));
  else pagina?.querySelectorAll('.com-popup, .com-sugerencias').forEach(o => o !== e && encuadrar(o));
}
function vigilarFlotantes() {
  for (const t of ['pointerdown', 'keydown']) document.addEventListener(t, () => { ultimaAccion = Date.now(); }, true);
  const tam = new ResizeObserver(l => l.forEach(x => encuadrar(x.target)));
  const vistos = new WeakSet();
  const revisar = e => { if (!vistos.has(e)) { vistos.add(e); tam.observe(e); } requestAnimationFrame(() => encuadrar(e)); };
  new MutationObserver(cambios => {
    for (const c of cambios) {
      if (c.type === 'attributes') { if (c.target.matches(FLOTANTES)) revisar(c.target); continue; }
      for (const n of c.addedNodes) if (n.nodeType === 1) { if (n.matches(FLOTANTES)) revisar(n); n.querySelectorAll(FLOTANTES).forEach(revisar); }
    }
  }).observe($('#area'), { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
}
function seleccionarPagina() {
  const capa = visor()?.paginas[visor().actual - 1]?.div.querySelector('.textLayer');
  if (!capa) return;
  const r = document.createRange(); r.selectNodeContents(capa);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}
function mostrarAtajos() {
  const grupos = [
    ['Archivo', [['Ctrl+O', 'Abrir'], ['Ctrl+S', 'Guardar'], ['Ctrl+P', 'Imprimir'], ['Ctrl+W', 'Cerrar el documento'], ['Ctrl+Mayús+T', 'Volver a abrir la que cerraste'], ['Ctrl+Tab', 'Pasar a la otra pestaña']]],
    ['Edición', [['Ctrl+Z', 'Deshacer'], ['Ctrl+Y', 'Rehacer'], ['Ctrl+C', 'Copiar'], ['Ctrl+X', 'Cortar'], ['Ctrl+V', 'Pegar'], ['Supr', 'Borrar lo elegido'], ['Ctrl+F', 'Buscar']]],
    ['Ver', [['Ctrl + / −', 'Acercar / alejar'], ['Ctrl+1', 'Página completa'], ['Ctrl+2', 'Ajustar al ancho'], ['Ctrl+R', 'Girar la vista'], ['F4', 'Panel lateral'], ['F11', 'Pantalla completa']]],
    ['Herramientas', [['V', 'Flecha (elegir texto)'], ['H', 'Mano (mover la hoja)'], ['Espacio', 'Mano mientras la apretás'], ['Esc', 'Terminar la herramienta'], ['Ctrl+K', 'Buscar un comando escribiendo'], ['F1', 'Esta ayuda']]],
    ['Menús', [['Alt + letra', 'Abrir ese menú (Alt+A: Archivo)'], ['F10', 'Abrir el primer menú'], ['Flechas', 'Moverse por el menú'], ['Enter', 'Elegir'], ['Esc', 'Cerrar']]]];
  dialogo({ titulo: 'Atajos de teclado', clase: 'dialogo-ancho', botones: [{ t: 'Cerrar', v: null, primario: true }],
    contenido: el('div', { class: 'atajos' }, ...grupos.map(([g, filas]) => el('section', {}, el('h4', {}, g),
      ...filas.map(([k, t]) => el('div', { class: 'atajo-fila' }, el('kbd', {}, k), el('span', {}, t)))))) });
}
async function cambiarTema(t) {
  estado.prefs.tema = t;
  raiz.dataset.oscuro = (await api.guardarPref('tema', t)) ? '1' : '0';
}

// ---------- Teclado ----------
function atajos(e) {
  if (e.key.startsWith('Arrow')) estado.flecha = Date.now();
  const v = visor(), ctrl = e.ctrlKey || e.metaKey;
  const enCampo = !!e.target.matches?.('input, textarea');
  const k = e.key.toLowerCase();
  const libre = estado.activa && !estado.organizador && !menuAbierto && !document.querySelector('dialog[open]');
  if (libre && (edicion.tecla(e) || firmas.tecla(e, estado.activa) || comentarios.tecla(e))) { e.preventDefault(); return; }
  if (libre && ctrl && !enCampo && (k === 'c' || k === 'x') && (firmas.sel || comentarios.sel)) { e.preventDefault(); return copiarObjeto(k === 'x'); }
  if (libre && ctrl && !enCampo && k === 'v') { e.preventDefault(); return pegar(); }
  if (teclaMenu(e)) return;
  if (e.altKey && !ctrl && /^[a-zñ]$/i.test(e.key) && !enCampo && abrirMenuConLetra(e.key.toLowerCase())) { e.preventDefault(); return; }
  if (e.key === 'F10' && !e.shiftKey) { e.preventDefault(); if (menuAbierto) return cerrarMenu(); estado.menuTeclado = true; return document.querySelector('#menus .menu-boton')?.dispatchEvent(new MouseEvent('mousedown')); }
  if (e.key === 'F1') { e.preventDefault(); return mostrarAtajos(); }
  if (e.key === 'Escape') { if (menuAbierto) return cerrarMenu(); if (estado.organizador) return cerrarOrganizador(); if (!$('#barra-buscar').hidden) return cerrarBusqueda(); if (raiz.dataset.completa === '1') return api.pantallaCompleta(); }
  if (e.key === 'F11') { e.preventDefault(); return api.pantallaCompleta(); }
  if (e.key === 'F4') { e.preventDefault(); return alternarPanel(); }
  if (ctrl && k === 'o' && e.shiftKey) { e.preventDefault(); return alternarOrganizador(); }
  if (ctrl && k === 'o') { e.preventDefault(); return abrirDialogo(); }
  if (ctrl && e.key === ',') { e.preventDefault(); return preferencias(); }
  if (ctrl && k === 'k' && !enCampo && !document.querySelector('dialog[open]')) { e.preventDefault(); return buscarComando(); }
  if (ctrl && e.shiftKey && k === 't') { e.preventDefault(); return reabrirCerrada(); }
  if (!v) return;
  if (ctrl && k === 'w') { e.preventDefault(); return cerrar(); }
  if (ctrl && k === 's') { e.preventDefault(); return guardar(estado.activa, e.shiftKey); }
  if (ctrl && k === 'p') { e.preventDefault(); return imprimir(); }
  if (ctrl && !enCampo && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); return deshacer(-1); }
  if (ctrl && !enCampo && k === 'z') { e.preventDefault(); return deshacer(1); }
  if (ctrl && e.key === 'Tab') {
    e.preventDefault();
    const i = estado.pestanas.indexOf(estado.activa), n = estado.pestanas.length;
    return activar(estado.pestanas[(i + (e.shiftKey ? -1 : 1) + n) % n]);
  }
  if (estado.organizador) return;
  if (ctrl && k === 'f') { e.preventDefault(); return abrirBusqueda(); }
  if (ctrl && e.shiftKey && k === 'l') { e.preventDefault(); return alternarLectura(); }
  if (ctrl && (e.key === '+' || e.key === '=')) { e.preventDefault(); return v.acercar(1); }
  if (ctrl && e.key === '-') { e.preventDefault(); return v.acercar(-1); }
  if (ctrl && e.key === '0') { e.preventDefault(); return v.setZoom(1); }
  if (ctrl && e.key === '1') { e.preventDefault(); return v.setZoom('pagina'); }
  if (ctrl && e.key === '2') { e.preventDefault(); return v.setZoom('ancho'); }
  if (ctrl && k === 'r') { e.preventDefault(); return v.rotar(); }
  if (ctrl && k === 'a' && !enCampo) { e.preventDefault(); return seleccionarPagina(); }
  if (enCampo) return;
  if (v.modo === 'unica' || ctrl) {
    if (['PageDown', 'ArrowRight', 'ArrowDown', ' '].includes(e.key)) { e.preventDefault(); return v.siguiente(); }
    if (['PageUp', 'ArrowLeft', 'ArrowUp'].includes(e.key)) { e.preventDefault(); return v.anterior(); }
  }
  if (e.key === 'Home' && ctrl) { e.preventDefault(); return v.irAPagina(1); }
  if (e.key === 'End' && ctrl) { e.preventDefault(); return v.irAPagina(v.total); }
}

// ---------- Arrastrar y soltar ----------
function armarSoltar() {
  let n = 0;
  const hayArchivos = e => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', e => { if (hayArchivos(e)) { n++; $('#soltar').hidden = false; } });
  window.addEventListener('dragleave', () => { if (--n <= 0) { n = 0; $('#soltar').hidden = true; } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault(); n = 0; $('#soltar').hidden = true;
    const rutas = [...e.dataTransfer.files].map(f => api.rutaDeArchivo(f)).filter(r => /\.pdf$/i.test(r) || esOffice(r));
    if (rutas.length) abrirRutas(rutas); else aviso('Solo se pueden abrir PDF y documentos de Word, Excel o PowerPoint.', true);
  });
}

// ---------- Inicio ----------
(async function iniciar() {
  const info = await api.info();
  estado.prefs = info.prefs; estado.version = info.version;
  raiz.dataset.oscuro = info.oscuro ? '1' : '0';
  raiz.dataset.mica = new URLSearchParams(location.search).get('mica') || '0';
  raiz.dataset.panelLado = info.prefs.panelLado || 'izquierda';
  comentarios.letra = info.prefs.letraTexto || 'sans';
  saludar();
  api.alCambiarTema(o => { raiz.dataset.oscuro = o ? '1' : '0'; });
  api.alPantallaCompleta(v => { raiz.dataset.completa = v ? '1' : '0'; setTimeout(() => visor()?.aplicarZoom(), 50); });
  api.alAbrirArchivos(abrirRutas);
  api.alAccion(n => ({ abrir: abrirDialogo, crear: crearDesdeImagenes, unir: unirVarios, preferencias, imprimir })[n]?.());
  api.alCrearDesdeImagenes(imgs => crearDesdeImagenes(imgs.map(i => ({ ...i, datos: new Uint8Array(i.datos) }))));
  $('#inicio-abrir').innerHTML = icono.abrir + '<span>Abrir PDF</span>';
  $('#inicio-abrir').onclick = abrirDialogo;
  document.querySelectorAll('.panel-pestanas button[data-vista]').forEach(b => b.onclick = () => { if (estado.prefs.panelContraido) contraerPanel(false); verPanel(b.dataset.vista); });
  $('.panel-contraer').onclick = () => contraerPanel(!estado.prefs.panelContraido);
  contraerPanel(!!estado.prefs.panelContraido, false); anchoPanel();
  armarMenus(); armarComandos(); armarBusqueda(); armarSoltar(); mascota.armar(); herramientas.armarBarra(); herramientas.vigilarSeleccion(); armarAccesos(); vigilarActualizaciones();
  document.addEventListener('keydown', atajos);
  document.addEventListener('pointerdown', e => {
    if (e.button === 2) return; // el clic derecho elige lo que está abajo él mismo
    if (!e.target.closest('.estampa, .estampa-barra, .menu-lista, [data-menu], dialog')) firmas.deseleccionar();
    if (!e.target.closest('.com, .com-barra, .com-popup, .com-editor, .menu-lista, [data-menu], dialog, .barra-herramienta')) comentarios.deseleccionar();
  });
  speechSynthesis.getVoices();
  mostrarVistas();
  firmas.cargar().catch(e => console.error(e));
  if (api.prueba) window.pdfproPrueba = { iaLocal, leerArea, verRecorrido, estado, firmas, comentarios, mascota, edicion, ocr, aplicar, abrirMenu, imprimir, preferencias, ajustesIA, censurar, repetir: c => repetirHaciaAbajo({ el, dialogo, api, aviso, cambiarComentarios }, estado.activa, c), copiaEditable, comprimirDoc, repararDoc, quitarBlancas, numerarDoc, propiedadesDoc, reabrirCerrada, buscarComando, cerrar, guardar, pegar, menuContextual, enviarInforme, compararOriginal };
  api.interfazLista(); // cierra la pantalla de carga
  vigilarRecuperacion();
})();

// ---------- Recuperación ----------
// Cada minuto y medio se deja una copia de los documentos con cambios; si el programa se cierra mal, al volver se ofrecen.
function vigilarRecuperacion() {
  // antes de cerrar la ventana: lo que se está escribiendo en un casillero o cuadro de texto cuenta como cambio
  api.alAntesDeCerrar(() => { document.activeElement?.blur?.(); setTimeout(() => { actualizarSinGuardar(); setTimeout(() => api.listoParaCerrar(), 40); }, 40); });
  const igual = (a, b) => a && ['datos', 'firmas', 'comentarios', 'campos'].every(k => a[k] === b[k]);
  setInterval(async () => {
    for (const p of estado.pestanas) {
      if (!modificada(p) || igual(p.copia, p) || estado.ocupado) continue;
      try { const foto = instantanea(p); await api.recuperarGuardar(p.id, { nombre: p.nombre, ruta: p.ruta }, await completo(p)); p.copia = foto; } catch (e) { console.warn('Copia de recuperación', e); }
    }
  }, 90000);
  setTimeout(ofrecerRecuperacion, 1500);
}
async function ofrecerRecuperacion() {
  const lista = await api.recuperarLista().catch(() => []);
  if (!lista.length) return;
  const r = await dialogo({ titulo: 'Recuperar documentos', texto: lista.length === 1
      ? `La última vez el programa se cerró sin guardar “${lista[0].nombre}”. ¿Lo abro como estaba?`
      : `La última vez el programa se cerró sin guardar ${lista.length} documentos (${lista.map(x => x.nombre).join(', ')}). ¿Los abro como estaban?`,
    botones: [{ t: 'Descartar', v: 'no' }, { t: 'Recuperar', v: 'si', primario: true }] });
  await api.recuperarLimpiar();
  if (r?.boton !== 'si') return;
  for (const x of lista) {
    try { const p = await nuevaPestana(new Uint8Array(x.datos), { ruta: x.ruta, nombre: x.nombre, guardada: false }); p.carpeta = carpetaDe(x.ruta); }
    catch (e) { mostrarError(e); }
  }
  aviso('Listo, recuperado. Revisalo y guardalo (Ctrl+S).');
}
