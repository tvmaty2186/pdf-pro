// PDF.Pro — asistente (la mascota): clave de Claude, datos guardados (perfiles, recetas, consumo) y consultas a la API.
// Corre en el proceso principal. La clave y los datos se guardan cifrados con el almacén seguro de Windows (safeStorage).
const { app, safeStorage, nativeImage, dialog, BrowserWindow } = require('electron');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const MODELO = 'claude-sonnet-5-5';        // completar y razonar (como dice el plan)
const MODELO_SIMPLE = 'claude-haiku-5-5';  // tareas simples: reconocer el tipo de documento, resumir corto
const PRECIOS = { // dólares por millón de tokens: entrada, salida, lectura de caché
  [MODELO]: [2, 10, 0.2], [MODELO_SIMPLE]: [0.1, 0.5, 0.01], 'claude-opus-5-5': [4, 20, 0.2], 'claude-fable-5-1': [10, 50, 0.25]
};
const archivo = nombre => path.join(app.getPath('userData'), nombre);

// ---------- Guardar cifrado ----------
function escribirCifrado(nombre, texto) {
  const datos = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(texto) : Buffer.from('PLANO:' + texto);
  fs.mkdirSync(path.dirname(archivo(nombre)), { recursive: true });
  fs.writeFileSync(archivo(nombre) + '.tmp', datos); // se escribe aparte y se reemplaza: un corte de luz no deja el archivo a medias
  fs.renameSync(archivo(nombre) + '.tmp', archivo(nombre));
}
// null si no existe. Si existe pero no se puede descifrar (por ejemplo, se copió la carpeta a otra PC), se aparta con otro
// nombre en vez de pisarlo con datos vacíos, para no perder los perfiles.
function leerCifrado(nombre) {
  let b;
  try { b = fs.readFileSync(archivo(nombre)); } catch { return null; }
  try {
    if (b.slice(0, 6).toString() === 'PLANO:') return b.slice(6).toString();
    return safeStorage.decryptString(b);
  } catch {
    try { fs.renameSync(archivo(nombre), archivo(nombre) + '.ilegible-' + new Date().toISOString().slice(0, 10)); } catch {}
    return null;
  }
}

// ---------- Clave de la API ----------
let clave = null;
const leerClave = () => (clave ??= leerCifrado('clave-claude.bin'));
let claveGemini;
const leerClaveGemini = () => (claveGemini ??= leerCifrado('clave-gemini.bin'));
function guardarClaveGemini(nueva) {
  nueva = String(nueva || '').trim();
  claveGemini = nueva || null;
  if (!nueva) { try { fs.unlinkSync(archivo('clave-gemini.bin')); } catch {} return; }
  escribirCifrado('clave-gemini.bin', nueva);
}
function guardarClave(nueva) {
  nueva = String(nueva || '').trim();
  if (!nueva) { clave = null; try { fs.unlinkSync(archivo('clave-claude.bin')); } catch {} return; }
  clave = nueva; cliente = null;
  escribirCifrado('clave-claude.bin', nueva);
}

// Modelos de Claude que se pueden elegir en Ajustes de la IA ('auto': Sonnet para completar y razonar, Haiku para lo simple)
const MODELOS = [
  { id: 'auto', nombre: 'Automático (el más eficiente)' },
  { id: 'claude-haiku-5-5', nombre: 'Haiku 5.5 (el más barato)' },
  { id: 'claude-sonnet-5-5', nombre: 'Sonnet 5.5 (equilibrado)' },
  { id: 'claude-opus-5-5', nombre: 'Opus 5.5 (más inteligente)' },
  { id: 'claude-fable-5-1', nombre: 'Fable 5.1 (el más capaz)' }
].map(m => ({ ...m, precio: PRECIOS[m.id] ? `US$ ${PRECIOS[m.id][0]} / ${PRECIOS[m.id][1]} por millón de tokens` : '' }));
const CON_RESPALDO = new Set(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1']); // si un filtro rechaza, la API reintenta sola
// los de Gemini salen de la lista que da Google con la clave (se guarda al probar la clave)
// también los guardados por una versión vieja; sin los que Google dijo que no existen para esta clave (404)
const listaGemini = () => require('./gemini').vigentes((leerDatos().modelosGemini || []).filter(m => !(leerDatos().geminiMalos || []).includes(m.id)));
const modelosGemini = () => listaGemini().length ? [{ id: 'auto', nombre: 'Automático (Flash para lo simple, Pro para razonar)', precio: 'Con tu clave gratis: no suma al gasto' },
  ...listaGemini().map(m => ({ id: m.id, nombre: m.nombre, precio: 'Con tu clave gratis: no suma al gasto' }))] : [];
const todosLosModelos = () => [...MODELOS, ...modelosGemini()];
// Con qué IA trabaja el asistente: 'claude' o 'gemini' (cada una con su clave y su modelo)
const proveedor = () => leerDatos().proveedor === 'gemini' ? 'gemini' : 'claude';
// Gemini en automático: el Pro más nuevo para completar y razonar, el Flash más nuevo para lo simple (estables antes que "preview")
const versionDe = id => +(String(id).match(/gemini-(\d+(?:\.\d+)?)/)?.[1] || 0);
function mejorGemini(filtro) {
  const lista = listaGemini().filter(x => filtro(x.id));
  const orden = (a, b) => (/preview|exp/.test(a.id) - /preview|exp/.test(b.id)) || versionDe(b.id) - versionDe(a.id);
  return lista.sort(orden)[0]?.id || null;
}
// lo elegido para Gemini: un modelo de la lista, o 'auto'
const modeloGemini = () => { const m = leerDatos().modeloGemini; return listaGemini().some(x => x.id === m) ? m : 'auto'; };
// El modelo para una tarea: simple (reconocer, resumir corto) o no (completar, razonar, charlar)
function modeloPara(simple = false) {
  if (proveedor() === 'gemini') {
    const m = modeloGemini();
    if (m !== 'auto') return m;
    const pro = mejorGemini(id => /pro/.test(id)), rapido = mejorGemini(id => /flash/.test(id) && !/lite/.test(id)) || mejorGemini(id => /flash/.test(id));
    return (simple ? rapido || pro : pro || rapido) || 'gemini-sin-modelo';
  }
  const m = leerDatos().modelo;
  return m && m !== 'auto' && MODELOS.some(x => x.id === m) ? m : simple ? MODELO_SIMPLE : MODELO;
}
const esGemini = modelo => /^gemini-/.test(modelo || '');
const gemini = require('./gemini');

// ---------- Datos del asistente: perfiles, recetas, consumo ----------
const DATOS_BASE = { perfiles: [], recetas: [], historial: [], consumo: {}, tope: 5 };
let datos = null;
function leerDatos() {
  if (!datos) { try { datos = { ...DATOS_BASE, ...JSON.parse(leerCifrado('asistente.bin') || '{}') }; } catch { datos = { ...DATOS_BASE }; } }
  return datos;
}
function guardarDatos(nuevos) { datos = { ...leerDatos(), ...nuevos }; escribirCifrado('asistente.bin', JSON.stringify(datos)); return datos; }
const mes = () => new Date().toISOString().slice(0, 7);
function gastoDelMes() { return leerDatos().consumo[mes()] || 0; }
function anotarGasto(modelo, u) {
  const [e, s, c] = PRECIOS[modelo] || PRECIOS[MODELO];
  const costo = ((u.input_tokens || 0) * e + (u.cache_creation_input_tokens || 0) * e * 1.25 + (u.cache_read_input_tokens || 0) * c + (u.output_tokens || 0) * s) / 1e6;
  const d = leerDatos(); d.consumo[mes()] = (d.consumo[mes()] || 0) + costo; guardarDatos({ consumo: d.consumo });
  return costo;
}

// ---------- Cliente de Claude ----------
let cliente = null;
function obtenerCliente() {
  const k = leerClave();
  if (!k) throw new Error('SIN_CLAVE');
  if (!cliente) { const Anthropic = require('@anthropic-ai/sdk').default; cliente = new Anthropic({ apiKey: k, maxRetries: 2, timeout: 120000 }); }
  return cliente;
}
// Errores en palabras simples
function explicar(e) {
  if (e?.gemini) return gemini.explicar(e);
  if (e?.message === 'SIN_VOZ') return 'Para hablarme hace falta la clave de Gemini (Claude no entiende audio). Ponela en Asistente → Ajustes de la IA.';
  if (e?.message === 'SIN_MODELOS_GEMINI') return 'Tu clave de Gemini no tiene modelos que anden ahora. En Asistente → Ajustes de la IA tocá "Guardar y probar" de nuevo, o elegí Claude.';
  if (e?.message === 'SIN_CLAVE_GEMINI') return 'Elegiste trabajar con Gemini pero falta su clave. Ponela en Asistente → Ajustes de la IA.';
  if (e?.message === 'SIN_CARPETA') return 'Este perfil no tiene carpeta de ejemplos. Elegila en Asistente → Perfiles de datos, o pasame la ruta en el chat.';
  if (e?.message === 'SIN_CLAVE') return 'Todavía no pusiste la clave de Claude. Está en Asistente → Ajustes de la IA.';
  if (e?.message === 'TOPE') return 'Se llegó al tope de gasto del mes que pusiste en Asistente → Ajustes de la IA. Podés subirlo ahí.';
  const A = require('@anthropic-ai/sdk').default;
  if (e instanceof A.AuthenticationError) return 'La clave de Claude no es válida. Revisala en Asistente → Ajustes de la IA.';
  if (e instanceof A.PermissionDeniedError) return 'Esa clave no tiene permiso para usar Claude. Revisá tu cuenta en console.anthropic.com.';
  if (e instanceof A.RateLimitError) return 'Claude está con mucho uso en este momento. Probá de nuevo en un rato.';
  if (e instanceof A.BadRequestError && /credit|balance/i.test(e.message)) return 'La cuenta de Claude se quedó sin saldo. Tocá "Cargar saldo" para cargar más.';
  if (e instanceof A.APIConnectionError) return 'No hay conexión con Claude. Revisá internet.';
  if (e instanceof A.APIError) return 'Claude respondió con un error (' + (e.status || '?') + '). Probá de nuevo.';
  return 'No se pudo hablar con Claude.';
}
// Una llamada a la API (con o sin herramientas). Anota el gasto en r.costo.
// Una llamada a la IA, vigilada: si falla, tarda más de 90 s, se niega, responde vacío o se corta, se manda solo un
// informe de errores con todo lo necesario para entender qué pasó (tarea: charla, completar, estudiar, prueba…)
async function llamar(pedido, tarea = 'consulta') {
  const t0 = Date.now();
  const reloj = setTimeout(() => informarIA('tarda', pedido, tarea, { ms: Date.now() - t0 }), +process.env.PDFPRO_IA_TARDA || 90000); // (las pruebas lo acortan)
  let r;
  try { r = await llamarIA(pedido, tarea); }
  catch (e) { if (!['TOPE', 'SIN_CLAVE', 'SIN_CLAVE_GEMINI'].includes(e?.message)) informarIA('error', pedido, tarea, { e, ms: Date.now() - t0 }); throw e; }
  finally { clearTimeout(reloj); }
  if (r.intentos?.length) informarIA('respaldo', pedido, tarea, { r, ms: Date.now() - t0 });
  const que = r.stop_reason === 'refusal' ? 'rechazo' : r.stop_reason === 'max_tokens' ? 'cortada' : !r.content?.length ? 'vacía' : null;
  if (que) informarIA(que, pedido, tarea, { r, ms: Date.now() - t0 });
  return r;
}
const sinCupo = new Map(); // modelo de Gemini → hasta cuándo no se prueba (se quedó sin cupo)
async function llamarIA(pedido, tarea) {
  if (esGemini(pedido.model)) { // Gemini (clave gratis de AI Studio): no suma al gasto ni lo frena el tope
    if (!leerClaveGemini()) throw new Error('SIN_CLAVE_GEMINI');
    if (pedido.model === 'gemini-sin-modelo') throw new Error('SIN_MODELOS_GEMINI');
    // plan B: si el modelo no está (404), no tiene cupo (429), falla (5xx) o no responde a tiempo, se prueba con el que sigue
    // charla: primero los rápidos (Flash, Flash-Lite, Pro); dictado: Flash-Lite (sobra y es el más rápido);
    // lo demás: primero el más capaz (Pro, Flash, Flash-Lite). Los que se quedaron sin cupo (429) esperan su turno.
    const dictado = tarea === 'dictado', rapido = dictado || /^charla|probar/.test(tarea);
    const orden = dictado ? ['flash-lite', 'flash', 'pro'] : rapido ? ['flash', 'flash-lite', 'pro'] : ['pro', 'flash', 'flash-lite'];
    const familia = id => /flash-lite/.test(id) ? 'flash-lite' : /flash/.test(id) ? 'flash' : 'pro';
    const libre = id => !(sinCupo.get(id) > Date.now());
    const otros = listaGemini().map(m => m.id).filter(id => id !== pedido.model).sort((a, b) => orden.indexOf(familia(a)) - orden.indexOf(familia(b)));
    let lista = dictado ? otros.concat(pedido.model).sort((a, b) => orden.indexOf(familia(a)) - orden.indexOf(familia(b))) : [pedido.model, ...otros];
    lista = [...lista.filter(libre), ...lista.filter(id => !libre(id))]; // los pausados, al final (por si no queda otro)
    const candidatos = lista.slice(0, 3), intentos = [];
    for (const modelo of candidatos) {
      try {
        const r = await gemini.llamar(leerClaveGemini(), { ...pedido, model: modelo }, +process.env.PDFPRO_GEMINI_TIEMPO || (dictado ? 30000 : rapido ? 60000 : 150000)); // (las pruebas lo acortan)
        r.costo = 0; r.intentos = intentos;
        return r;
      } catch (e) {
        intentos.push({ modelo, estado: e.estado, mensaje: String(e.message).slice(0, 300) });
        if (e.estado === 404) guardarDatos({ geminiMalos: [...new Set([...(leerDatos().geminiMalos || []), modelo])] });
        // sin cupo: si la clave gratis no lo incluye ("limit: 0") se pausa 6 horas; si se gastó el del minuto, 2 minutos
        if (e.estado === 429) sinCupo.set(modelo, Date.now() + (/limit:\s*0\b|per\s*day|PerDay/i.test(e.message + JSON.stringify(e.cuerpo || '')) ? 6 * 3600e3 : 120e3));
        if (!e.gemini || ![0, 404, 429, 500, 502, 503, 504].includes(e.estado) || modelo === candidatos.at(-1)) { e.intentos = intentos; throw e; }
      }
    }
  }
  if (gastoDelMes() >= (leerDatos().tope ?? 5)) throw new Error('TOPE');
  // si un filtro de seguridad rechaza el pedido, la API lo reintenta sola con el modelo recomendado (Haiku no lo tiene)
  const r = CON_RESPALDO.has(pedido.model)
    ? await obtenerCliente().beta.messages.create({ ...pedido, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
    : await obtenerCliente().messages.create(pedido);
  r.costo = anotarGasto(r.model || pedido.model, r.usage || {});
  return r;
}
// El informe: qué IA y modelo, qué tarea, qué se pidió (sin números largos ni mails), qué había en el pedido y qué devolvió
const QUE_PASO = { error: 'La IA devolvió un error', tarda: 'La IA tarda más de 90 segundos (sigue esperando)', rechazo: 'La IA se negó a responder',
  cortada: 'La respuesta se cortó (llegó al máximo de largo)', 'vacía': 'La IA respondió vacío', respaldo: 'El modelo pedido falló y respondió otro (plan B)' };
function informarIA(que, pedido, tarea, { e = null, r = null, ms = 0 } = {}) {
  try {
    const { limpiar, informeAutomatico } = require('./errores');
    const msgs = pedido.messages || [], bloques = msgs.flatMap(m => typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || []);
    const delUsuario = [...msgs].reverse().find(m => m.role === 'user' && (typeof m.content === 'string' || m.content?.some(b => b.type === 'text')));
    // lo que escribió el usuario: sin el texto del documento ni los avisos de adjuntos (eso puede tener datos personales)
    const textos = !delUsuario ? [] : typeof delUsuario.content === 'string' ? [delUsuario.content] : delUsuario.content.filter(b => b.type === 'text').map(b => b.text);
    const pedido_ = textos.filter(t => !/^Documento abierto|^\[Antes adjuntó/.test(t)).join('\n');
    const docTexto = textos.find(t => /^Documento abierto/.test(t));
    const adjuntos = bloques.filter(b => b.type === 'image' || b.type === 'document').map(b => `${b.type === 'image' ? 'imagen' : /audio/.test(b.source?.media_type) ? 'audio' : 'PDF'} ${Math.round((b.source?.data?.length || 0) * 0.75 / 1024)} KB`);
    const usadas = bloques.filter(b => b.type === 'tool_use').map(b => b.name), resultados = bloques.filter(b => b.type === 'tool_result').map(b => limpiar(typeof b.content === 'string' ? b.content : '').slice(0, 120));
    const sistema = Array.isArray(pedido.system) ? pedido.system.map(x => x.text).join('') : String(pedido.system || '');
    const json = x => { try { return JSON.stringify(x, null, 1); } catch { return String(x); } };
    const ia = esGemini(pedido.model) ? 'Gemini' : 'Claude';
    const cuerpo = [
      `### ${QUE_PASO[que]}`,
      `- **IA:** ${ia} · **modelo pedido:** \`${pedido.model}\`${r?.model && r.model !== pedido.model ? ` · **respondió:** \`${r.model}\`` : ''} · **elegido en ajustes:** ${proveedor()} / ${proveedor() === 'gemini' ? modeloGemini() : leerDatos().modelo || 'auto'}`,
      `- **Tarea:** ${tarea} · **tiempo:** ${(ms / 1000).toFixed(1)} s`,
      `- **Pedido:** ${msgs.length} ${msgs.length === 1 ? 'mensaje' : 'mensajes'} · ${(pedido.tools || []).length} herramientas ofrecidas${(pedido.tools || []).length ? ` (${pedido.tools.map(t => t.name).join(', ')})` : ''} · máx. ${pedido.max_tokens} tokens · esfuerzo ${pedido.output_config?.effort || '-'} · respuesta JSON ${pedido.output_config?.format ? 'sí' : 'no'} · instrucciones de ${sistema.length} caracteres`,
      adjuntos.length ? `- **Adjuntos:** ${adjuntos.join(', ')}` : null,
      docTexto ? `- **Texto del documento abierto:** ${docTexto.length} caracteres (no se manda)` : null,
      esGemini(pedido.model) ? `- **Modelos de Gemini de la clave:** ${listaGemini().map(m => m.id).join(', ') || '(ninguno)'}${(leerDatos().geminiMalos || []).length ? ` · descartados por 404: ${leerDatos().geminiMalos.join(', ')}` : ''}` : null,
      (e?.intentos || r?.intentos)?.length ? `- **Intentos:** ${(e?.intentos || r.intentos).map(x => `\`${x.modelo}\` → ${x.estado ?? '-'} ${x.mensaje}`).join(' | ')}${r ? ` · respondió \`${r.model}\`` : ''}` : null,
      usadas.length ? `- **Herramientas que ya usó en esta charla:** ${usadas.join(', ')}${resultados.length ? `\n- **Resultados que se le devolvieron:** ${resultados.join(' | ')}` : ''}` : null,
      `\n**Lo último que se le pidió (sin números largos ni mails):**\n> ${limpiar(pedido_).slice(0, 1500).replace(/\n/g, '\n> ') || '(sin texto)'}`,
      e ? `\n**Error:** \`${e.constructor?.name || 'Error'}\` · estado ${e.status ?? e.estado ?? '-'}${e.requestID || e.request_id ? ` · request id \`${e.requestID || e.request_id}\`` : ''}\n\`\`\`\n${String(e.message || e).slice(0, 2000)}\n\`\`\`` : null,
      e?.error || e?.cuerpo ? `**Cuerpo del error:**\n\`\`\`json\n${json(e.error || e.cuerpo).slice(0, 3000)}\n\`\`\`` : null,
      e ? `**Lo que vio el usuario:** ${explicar(e)}` : null,
      e?.stack ? `**Pila:**\n\`\`\`\n${limpiar(e.stack).split('\n').slice(0, 8).join('\n')}\n\`\`\`` : null,
      r ? `\n**Respuesta:** stop_reason \`${r.stop_reason}\`${r.stop_details ? ` · detalles ${json(r.stop_details)}` : ''} · uso ${json(r.usage)}` : null,
      r?.content?.length ? `**Contenido (primeros 600 caracteres):**\n\`\`\`\n${limpiar(json(r.content)).slice(0, 600)}\n\`\`\`` : null
    ].filter(Boolean).join('\n');
    const firma = [que, pedido.model, tarea, e?.status ?? e?.estado ?? '', String(e?.message || '').slice(0, 60)].join('|');
    informeAutomatico({ titulo: `${QUE_PASO[que]} · ${ia} ${pedido.model} · ${tarea}`, cuerpo, firma }).catch(() => {});
  } catch (x) { console.error('Informe de la IA', x?.message); }
}
// Una consulta. sistema: texto fijo (va en caché); mensajes: la conversación; formato: esquema JSON si se quiere una respuesta estructurada
async function consultar({ sistema, mensajes, formato = null, simple = false, maxTokens = 8000, esfuerzo = 'medium', modelo: forzado = null, tarea = 'consulta' }) {
  const modelo = forzado || modeloPara(simple);
  const pedido = {
    model: modelo, max_tokens: maxTokens,
    system: [{ type: 'text', text: sistema, cache_control: { type: 'ephemeral' } }],
    messages: mensajes,
    output_config: { effort: esfuerzo, ...(formato ? { format: { type: 'json_schema', schema: formato } } : {}) }
  };
  const r = await llamar(pedido, tarea);
  const costo = r.costo;
  if (r.stop_reason === 'refusal') return { rechazo: true, costo };
  const texto = r.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return { texto, costo, cortado: r.stop_reason === 'max_tokens' };
}

// ---------- Lo que sabe hacer la mascota ----------
const PERSONALIDAD = `Sos la mascota asistente de PDF.Pro, un programa para completar, firmar e imprimir PDF. Hablás en español rioplatense, con frases cortas y claras (nada de listas largas ni palabras difíciles: tiene que ser fácil de leer para cualquiera). Ayudás con los documentos que el usuario tiene abiertos; nunca inventás datos personales: si no sabés algo, lo decís.`;
function textoPerfiles() {
  const p = leerDatos().perfiles;
  if (!p.length) return 'No hay perfiles guardados todavía.';
  return p.map(x => `Perfil "${x.nombre}":\n` + x.campos.filter(c => c.etiqueta && c.valor).map(c => `- ${c.etiqueta}: ${c.valor}`).join('\n')).join('\n\n');
}


// ======================================================================
// APRENDER: ejemplos de la carpeta de cada perfil, lo que el usuario enseña y sus correcciones
// ======================================================================
// Por qué así: lo que se escribe con Rellenar, las firmas y los escaneos NO son texto del PDF, así que leer el texto
// no alcanza. Cada ejemplo se le muestra a Claude como IMAGEN de sus páginas (con lo rellenado y las firmas encima)
// y Claude arma una "ficha" (qué documento es, qué va en cada lugar, de dónde sale cada dato, dónde va la firma y de
// qué tamaño). Las fichas se guardan cifradas y solo se estudia de nuevo lo que cambió. Al completar, se mandan las
// fichas, lo aprendido y las imágenes de los ejemplos más parecidos al documento abierto.

const b64 = buf => Buffer.from(buf).toString('base64');
// Imagen lista para Claude (se achica a 1568 px de lado, que es lo que Claude aprovecha)
function bloqueImagen(bytes, max = 1568) {
  let img = nativeImage.createFromBuffer(Buffer.from(bytes));
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  if (Math.max(width, height) > max) img = img.resize(width >= height ? { width: max, quality: 'good' } : { height: max, quality: 'good' });
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64(img.toJPEG(85)) } };
}
const bloquePdf = (bytes, titulo) => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64(bytes) }, ...(titulo ? { title: String(titulo).slice(0, 200) } : {}) });
// Páginas de un PDF como PNG, CON las anotaciones (lo escrito con Rellenar, firmas, sellos), más su texto
async function mirarPdf(bytes, maxPaginas = 3, dpi = 100) {
  const m = await import('mupdf'), d = m.Document.openDocument(Buffer.from(bytes), 'application/pdf');
  try {
    const imagenes = [], textos = [];
    const total = d.countPages();
    for (let i = 0; i < total; i++) {
      const pg = d.loadPage(i);
      if (i < maxPaginas) {
        const pix = pg.toPixmap(m.Matrix.scale(dpi / 72, dpi / 72), m.ColorSpace.DeviceRGB, false, true);
        imagenes.push(Buffer.from(pix.asPNG().slice())); pix.destroy?.();
      }
      if (textos.join('').length < 5000) {
        let t = pg.toStructuredText().asText();
        try { const escrito = pg.getAnnotations?.().map(a => a.getContents?.()).filter(Boolean); if (escrito?.length) t += '\n[Escrito encima: ' + escrito.join(' | ') + ']'; } catch {}
        textos.push(`--- Página ${i + 1} ---\n` + t.replace(/[ \t]+/g, ' ').trim());
      }
      pg.destroy?.();
    }
    return { imagenes, texto: textos.join('\n').slice(0, 5000), paginas: total };
  } finally { d.destroy(); }
}

// ---------- Fichas de los ejemplos ----------
const EXT_EJEMPLO = /\.(pdf|png|jpe?g|webp|txt|md)$/i;
function archivosDe(carpeta, max = 80) {
  const lista = [], recorrer = (dir, prof) => {
    let items = []; try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const i of items) {
      if (lista.length >= max) return;
      const r = path.join(dir, i.name);
      if (i.isDirectory() && prof < 3) recorrer(r, prof + 1); else if (i.isFile() && EXT_EJEMPLO.test(i.name) && !i.name.startsWith('~')) lista.push(r);
    }
  };
  recorrer(carpeta, 0);
  return lista;
}
// La carpeta del perfil y las carpetas o archivos que el usuario pasó en el chat ("acá tenés ejemplos: C:\…")
function archivosDeLugares(lugares) {
  const vistos = new Set(), lista = [];
  for (const l of lugares) for (const r of (fs.statSync(l).isDirectory() ? archivosDe(l) : EXT_EJEMPLO.test(l) ? [l] : [])) if (!vistos.has(r)) { vistos.add(r); lista.push(r); }
  return lista.slice(0, 150);
}
const nombreCorto = (r, lugares) => { const base = lugares.find(l => r.startsWith(l + path.sep)); return base ? path.relative(base, r) : path.basename(r); };
const claveArchivo = r => { const st = fs.statSync(r); return crypto.createHash('sha1').update(r + '|' + st.size + '|' + st.mtimeMs).digest('hex').slice(0, 20); };
const ESQUEMA_FICHA = {
  type: 'object', additionalProperties: false,
  required: ['tipo_documento', 'descripcion', 'palabras_clave', 'campos', 'firmas', 'reglas'],
  properties: {
    tipo_documento: { type: 'string', description: 'Qué documento es, corto (ej. "Planilla de asistencia mensual de la obra social", "Autorización de prestación").' },
    descripcion: { type: 'string', description: 'Para qué sirve y quién lo pide, en una o dos frases.' },
    palabras_clave: { type: 'array', items: { type: 'string' }, description: 'Palabras que aparecen impresas y sirven para reconocer otro documento del mismo tipo.' },
    campos: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['etiqueta', 'valor_ejemplo', 'de_donde_sale', 'regla'], properties: {
      etiqueta: { type: 'string', description: 'El texto impreso del lugar a completar' },
      valor_ejemplo: { type: 'string', description: 'Lo que está escrito en este ejemplo' },
      de_donde_sale: { type: 'string', description: 'perfil (dato fijo de la persona) | fecha | calculado | fijo (siempre igual) | otro documento | no se sabe' },
      regla: { type: 'string', description: 'Cómo se completa (formato, mayúsculas, cálculo, qué se tilda). Vacío si no hace falta.' } } } },
    firmas: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['donde', 'quien', 'ancho_cm', 'pagina'], properties: {
      donde: { type: 'string', description: 'Al lado o encima de qué texto impreso va (ej. "sobre la línea Firma del profesional")' },
      quien: { type: 'string', description: 'De quién es la firma o sello (ej. "firma del terapeuta", "sello del consultorio")' },
      ancho_cm: { type: 'number', description: 'Ancho aproximado de la firma o sello en el papel, en cm' },
      pagina: { type: 'integer' } } } },
    reglas: { type: 'array', items: { type: 'string' }, description: 'Otras cosas que se ven en el ejemplo y conviene repetir (fechas según días de sesión, totales, qué no se completa, etc.).' }
  }
};
const SISTEMA_FICHA = `Estudiás documentos ya completados para aprender a completar otros iguales. Te muestro un ejemplo (imágenes de sus páginas con lo que se escribió encima, firmas y sellos, más su texto). Devolvé la ficha pedida: qué documento es, cada lugar que se completó con su valor de ejemplo, de dónde sale ese dato y cómo se completa, dónde van firmas o sellos y de qué ancho aproximado (una hoja A4 mide 21 cm de ancho), y las reglas que se deducen. Sé concreto. Si algo no se ve, no lo inventes.`;

function fichasDe(perfil) { return leerDatos().fichas?.[perfil] || {}; }
async function estudiarCarpeta(perfil, emitir = () => {}) {
  const p = leerDatos().perfiles.find(x => x.nombre === perfil);
  const lugares = [p?.carpeta, ...(p?.ejemplosExtra || [])].filter(r => r && fs.existsSync(r));
  if (!lugares.length) throw new Error('SIN_CARPETA');
  const archivos = archivosDeLugares(lugares), todas = { ...(leerDatos().fichas || {}) };
  const viejas = todas[perfil] || {}, nuevas = {};
  const pendientes = [];
  for (const r of archivos) { const k = claveArchivo(r); if (viejas[k]) nuevas[k] = viejas[k]; else pendientes.push([k, r]); }
  let hechas = 0, errores = 0, costo = 0;
  emitir({ hechas, total: pendientes.length, archivo: '' });
  for (const [k, r] of pendientes) {
    emitir({ hechas, total: pendientes.length, archivo: path.basename(r) });
    try {
      const datos = fs.readFileSync(r), bloques = [{ type: 'text', text: `Archivo de ejemplo: "${nombreCorto(r, lugares)}"` }];
      if (/\.pdf$/i.test(r)) {
        const v = await mirarPdf(datos, 3, 100);
        v.imagenes.forEach(png => { const b = bloqueImagen(png); if (b) bloques.push(b); });
        bloques.push({ type: 'text', text: `Texto del documento (${v.paginas} páginas):\n${v.texto}` });
      } else if (/\.(txt|md)$/i.test(r)) bloques.push({ type: 'text', text: datos.toString('utf8').slice(0, 8000) });
      else { const b = bloqueImagen(datos); if (!b) throw new Error('imagen'); bloques.push(b); }
      const res = await consultar({ tarea: 'estudiar ejemplos', sistema: SISTEMA_FICHA, mensajes: [{ role: 'user', content: bloques }], formato: ESQUEMA_FICHA, maxTokens: 4000, esfuerzo: 'low' });
      costo += res.costo || 0;
      nuevas[k] = { ruta: r, nombre: nombreCorto(r, lugares), ficha: JSON.parse(res.texto), fecha: Date.now() };
    } catch (e) {
      if (['TOPE', 'SIN_CLAVE'].includes(e?.message) || e?.status === 401) throw e;
      errores++; console.warn('Ficha', r, e?.message);
    }
    hechas++;
    todas[perfil] = nuevas; guardarDatos({ fichas: todas }); // se va guardando, por si se corta
  }
  todas[perfil] = nuevas; guardarDatos({ fichas: todas });
  emitir({ hechas, total: pendientes.length, archivo: '', fin: true });
  return { estudiados: Object.keys(nuevas).length, nuevos: hechas - errores, errores, archivos: archivos.length, costo };
}
function textoFichas(perfil, tope = 40000) {
  let t = '';
  for (const f of Object.values(fichasDe(perfil))) {
    const x = f.ficha; if (!x) continue;
    const bloque = `\n### Ejemplo "${f.nombre}" — ${x.tipo_documento}\n${x.descripcion}\n` +
      x.campos.map(c => `- ${c.etiqueta}: «${c.valor_ejemplo}» (sale de: ${c.de_donde_sale})${c.regla ? ' — ' + c.regla : ''}`).join('\n') +
      (x.firmas.length ? '\nFirmas/sellos: ' + x.firmas.map(g => `${g.quien}, ${g.donde}, ~${g.ancho_cm} cm (pág. ${g.pagina})`).join('; ') : '') +
      (x.reglas.length ? '\nReglas: ' + x.reglas.join(' / ') : '') + '\n';
    if (t.length + bloque.length > tope) break;
    t += bloque;
  }
  return t;
}
// Los ejemplos que más se parecen al documento abierto (por las palabras impresas)
const palabras = t => new Set(String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]{4,}/g) || []);
function ejemplosParecidos(perfil, textoDoc, n = 2) {
  const doc = palabras(textoDoc);
  return Object.values(fichasDe(perfil)).map(f => {
    const ref = palabras([f.ficha?.tipo_documento, ...(f.ficha?.palabras_clave || []), f.nombre].join(' '));
    let puntos = 0; for (const w of ref) if (doc.has(w)) puntos++;
    return { f, puntos };
  }).filter(x => x.puntos >= 2).sort((a, b) => b.puntos - a.puntos).slice(0, n).map(x => x.f);
}

// ---------- Lo aprendido (va en cada perfil) ----------
function aprender(perfil, texto, origen = 'chat') {
  texto = String(texto || '').trim(); if (!texto) return;
  const d = leerDatos(), p = d.perfiles.find(x => x.nombre === perfil);
  if (!p) return;
  p.aprendizajes = [...(p.aprendizajes || []).filter(a => a.texto !== texto), { texto, origen, fecha: Date.now() }].slice(-200);
  guardarDatos({ perfiles: d.perfiles });
}
// Todo lo que se sabe de un perfil: sus datos, lo aprendido y las fichas de sus ejemplos
function contextoPerfil(perfil) {
  const p = leerDatos().perfiles.find(x => x.nombre === perfil);
  if (!p) return `\n\nPerfiles guardados:\n${textoPerfiles()}`;
  const datosP = p.campos.filter(c => c.etiqueta && c.valor).map(c => `- ${c.etiqueta}: ${c.valor}`).join('\n') || '(sin datos)';
  const apr = (p.aprendizajes || []).map(a => `- ${a.texto}`).join('\n');
  const fichas = textoFichas(perfil);
  return `\n\n## Perfil con el que se trabaja: "${p.nombre}"\n${datosP}` +
    (apr ? `\n\n## Lo que aprendiste para este perfil (tiene prioridad sobre todo lo demás)\n${apr}` : '') +
    (fichas ? `\n\n## Ejemplos estudiados de la carpeta de este perfil (documentos que el usuario ya completó)\n${fichas}` : (p.carpeta ? '\n\n(La carpeta de ejemplos todavía no se estudió.)' : ''));
}

// ---------- Charla con archivos y herramientas ----------
const HERRAMIENTAS = [
  { name: 'guardar_aprendizaje', description: 'Guarda para siempre, en el perfil actual, algo que el usuario te enseñó o que aprendiste de un ejemplo que te pasó (una regla, un dato, cómo se completa un documento, dónde va la firma). Usala cuando diga "acordate", "siempre", "de ahora en más", cuando te corrija, o cuando te pase un ejemplo para que aprendas. Una regla por llamada, en una frase clara y completa.',
    input_schema: { type: 'object', properties: { texto: { type: 'string' } }, required: ['texto'] } },
  { name: 'completar_documento', description: 'Completa la página del documento abierto con Rellenar (y firmas o sellos si corresponde), mostrando una vista previa para que el usuario acepte. Usala cuando pida completar, llenar o firmar el documento abierto.',
    input_schema: { type: 'object', properties: { indicaciones: { type: 'string', description: 'Lo que pidió el usuario para esta vez (fechas, montos, qué firmar).' } } } },
  { name: 'agregar_ejemplos', description: 'Agrega a los ejemplos del perfil una carpeta o un archivo de la computadora que el usuario te indica con su ruta (por ejemplo C:\\Users\\...\\Asistencias) y la estudia. Usala cuando el usuario te pase una ruta y diga que ahí hay ejemplos o información.',
    input_schema: { type: 'object', properties: { ruta: { type: 'string', description: 'La ruta tal como la escribió el usuario' } }, required: ['ruta'] } },
  { name: 'estudiar_ejemplos', description: 'Estudia (o actualiza) la carpeta de ejemplos del perfil para aprender de los documentos ya completados. Usala si el usuario lo pide o si dice que agregó ejemplos.',
    input_schema: { type: 'object', properties: {} } }
];
const SISTEMA_CHARLA = `${PERSONALIDAD}

Podés ver imágenes y PDF que el usuario te pasa. Cuando te pase algo para que aprendas (un ejemplo completo, una autorización, una regla), miralo con atención y guardá lo importante con guardar_aprendizaje (puede ser varias reglas). Cuando pida completar o firmar el documento abierto, usá completar_documento. Si pide corregir la vista previa (tamaño, lugar, valores), volvé a usar completar_documento con la corrección exacta en indicaciones: el programa le pasa la propuesta anterior y las medidas reales, y la corrección se aplica. Usá lo aprendido y los ejemplos del perfil para responder. Respondé corto.`;
function aBloques(m, conAdjuntos) {
  const bloques = [];
  for (const a of m.adjuntos || []) {
    if (!conAdjuntos) { bloques.push({ type: 'text', text: `[Antes adjuntó: ${a.nombre}]` }); continue; }
    if (a.tipo === 'application/pdf') bloques.push(bloquePdf(a.datos, a.nombre));
    else { const b = bloqueImagen(a.datos); if (b) bloques.push(b); }
  }
  bloques.push({ type: 'text', text: m.texto || '(sin texto)' });
  return bloques;
}
async function charlar({ historial, documento, perfil }) {
  const sistema = SISTEMA_CHARLA + reglasUsuario() + contextoPerfil(perfil);
  // los archivos se mandan solo en los últimos 3 mensajes del usuario (si no, cada pregunta cuesta mucho)
  const delUsuario = historial.map((m, i) => m.rol === 'yo' ? i : -1).filter(i => i >= 0).slice(-3);
  const mensajes = historial.map((m, i) => {
    if (m.rol !== 'yo') return { role: 'assistant', content: m.texto || '…' };
    const bloques = aBloques(m, delUsuario.includes(i));
    if (i === 0 && documento) bloques.unshift({ type: 'text', text: `Documento abierto ("${documento.nombre}"):\n<documento>\n${documento.texto}\n</documento>` });
    return { role: 'user', content: bloques };
  });
  const acciones = [], aprendidos = [];
  let costo = 0, texto = '';
  for (let vuelta = 0; vuelta < 5; vuelta++) {
    const r = await llamar({ model: modeloPara(false), max_tokens: 4000, system: [{ type: 'text', text: sistema, cache_control: { type: 'ephemeral' } }],
      messages: mensajes, tools: HERRAMIENTAS, output_config: { effort: 'low' } }, `charla (vuelta ${vuelta + 1})`);
    costo += r.costo;
    if (r.stop_reason === 'refusal') return { rechazo: true, costo };
    texto = r.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim() || texto;
    if (r.stop_reason !== 'tool_use') break;
    mensajes.push({ role: 'assistant', content: r.content });
    const resultados = [];
    for (const b of r.content.filter(x => x.type === 'tool_use')) {
      let res = 'Hecho.';
      if (b.name === 'guardar_aprendizaje') {
        if (!perfil) res = 'No hay perfil elegido: pedile al usuario que elija uno (arriba del chat) y volvé a guardarlo.';
        else { aprender(perfil, b.input?.texto, 'chat'); aprendidos.push(b.input?.texto); }
      } else if (b.name === 'completar_documento') { acciones.push({ tipo: 'completar', indicaciones: b.input?.indicaciones || '' }); res = 'Se abre la vista previa en la ventana; el usuario la revisa y acepta.'; }
      else if (b.name === 'agregar_ejemplos') {
        const ruta = String(b.input?.ruta || '').trim().replace(/^["']|["']$/g, '');
        const d = leerDatos(), p = d.perfiles.find(x => x.nombre === perfil);
        if (!p) res = 'No hay perfil elegido: pedile al usuario que elija uno arriba del chat.';
        else if (!ruta || !path.isAbsolute(ruta) || !fs.existsSync(ruta)) res = 'Esa ruta no existe en esta computadora. Pedile que la copie de nuevo (en el Explorador: clic derecho → Copiar como ruta de acceso).';
        else { p.ejemplosExtra = [...new Set([...(p.ejemplosExtra || []), ruta])]; guardarDatos({ perfiles: d.perfiles }); acciones.push({ tipo: 'estudiar' }); res = 'Agregada a los ejemplos del perfil; se empieza a estudiar.'; }
      }
      else if (b.name === 'estudiar_ejemplos') { acciones.push({ tipo: 'estudiar' }); res = 'Se empieza a estudiar la carpeta; tarda un rato.'; }
      resultados.push({ type: 'tool_result', tool_use_id: b.id, content: res });
    }
    mensajes.push({ role: 'user', content: resultados });
  }
  return { texto, costo, acciones, aprendidos };
}

// ---------- Completar viendo la página ----------
const ESQUEMA_COMPLETAR = {
  type: 'object', additionalProperties: false, required: ['campos', 'firmas', 'comentario'],
  properties: {
    comentario: { type: 'string', description: 'Una frase corta para el usuario sobre lo que hiciste o lo que falta.' },
    campos: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['etiqueta_id', 'destino_id', 'valor', 'ubicacion', 'como_id', 'tam', 'ajuste_x', 'ajuste_y', 'seguridad', 'motivo'],
      properties: {
        etiqueta_id: { type: 'string', description: 'id del pedazo con la etiqueta impresa' },
        destino_id: { type: 'string', description: 'id de la raya o espacio donde va el valor; si no hay raya, el mismo id de la etiqueta' },
        valor: { type: 'string', description: 'lo que hay que escribir; vacío si no se sabe' },
        ubicacion: { type: 'string', enum: ['automatica', 'despues_de_etiqueta', 'sobre_raya', 'centrado_en_destino', 'tapando_destino', 'como_existente'],
          description: 'dónde va el texto respecto del destino. tapando_destino: escribe encima y tapa en blanco lo impreso (para "--/--/----", "......"). como_existente: igual que un texto ya escrito (como_id), mismo tamaño y misma distancia a su pedazo, pero en la fila del destino' },
        como_id: { type: 'string', description: 'id de un texto ya escrito ("e…") a imitar con ubicacion como_existente; vacío si no' },
        tam: { type: 'number', description: 'tamaño de letra en puntos; 0 = automático (igual a la letra impresa de esa línea)' },
        ajuste_x: { type: 'number', description: 'corrimiento en puntos: positivo a la derecha, negativo a la izquierda; 0 si no hace falta' },
        ajuste_y: { type: 'number', description: 'corrimiento en puntos: positivo para arriba, negativo para abajo; 0 si no hace falta' },
        seguridad: { type: 'string', enum: ['seguro', 'duda', 'no_se'] },
        motivo: { type: 'string', description: 'de dónde salió el dato (perfil, ejemplo X, regla aprendida, cálculo)' } } } },
    firmas: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['firma', 'destino_id', 'ancho_cm', 'motivo'],
      properties: {
        firma: { type: 'string', description: 'nombre EXACTO de la firma o sello de la lista disponible' },
        destino_id: { type: 'string', description: 'id del pedazo (raya o texto "Firma…") donde va' },
        ancho_cm: { type: 'number', description: 'ancho en cm, como en los ejemplos (firma ~4-6 cm, sello ~3-4 cm)' },
        motivo: { type: 'string' } } } }
  }
};
const SISTEMA_COMPLETAR = `${PERSONALIDAD}

Tu tarea: completar la página de un PDF como lo haría el usuario. Te paso:
1) la IMAGEN de la página tal como está ahora,
2) la lista de pedazos de la página con su id, su texto y su caja [x0,y0,x1,y1] en una escala de 0 a 1000 (0,0 arriba a la izquierda), para ubicarlos en la imagen. "[raya]" es una línea para escribir; "[casillero]" es un campo del formulario (el valor va directo, etiqueta_id = destino_id = su id); "[casilla para tildar]" se tilda con valor "sí",
3) los datos del perfil, lo aprendido y las fichas de los ejemplos que el usuario ya completó, más las imágenes de los ejemplos más parecidos.
Completá cada lugar que corresponda copiando cómo se hizo en los ejemplos y siguiendo lo aprendido (tiene prioridad). Si un dato cambia cada vez (fechas, montos, períodos), usá las indicaciones del usuario o lo que se deduce del documento; si no hay forma de saberlo, dejalo con seguridad "no_se".
Seguridad: "seguro" si sale tal cual del perfil, de lo aprendido o es fijo en los ejemplos; "duda" si lo deducís; "no_se" con valor vacío si no se puede saber.
Firmas: proponé firma o sello solo si en los ejemplos o en lo aprendido ese documento se firma/sella, o si el usuario lo pide. Elegí de la lista disponible por su nombre exacto y poné destino_id en la raya o el texto donde va.
No escribas donde ya hay algo escrito (mirá la imagen). No inventes datos personales.

Ubicación y tamaño (medidas en puntos; una hoja A4 mide 595 x 842):
- Cada pedazo trae su tamaño de letra impresa. Para que entre en una celda, usá un tamaño parecido o algo menor.
- Si ya hay textos escritos en la página (lista "Textos ya escritos", ids "e…"), son del usuario: copiá su estilo. En tablas, para cada fila nueva usá ubicacion "como_existente" con como_id del texto de la misma columna ya escrito y destino_id = el pedazo de ESA columna en la fila nueva (por ejemplo el "--/--/----" o el "Desde.....hs" de esa fila). Así queda a la misma altura y tamaño que lo que hizo el usuario.
- Para reemplazar un lugar impreso con guiones o puntos ("--/--/----", "......") usá "tapando_destino".
- Si te paso una "Propuesta anterior" y el usuario pidió correcciones (más chico, más a la izquierda, más abajo), partí de esa propuesta y aplicá exactamente los cambios: tam y ajuste_x / ajuste_y en puntos (un paso = 1 punto de letra o 3 puntos de corrimiento, salvo que diga otra cosa). No vuelvas a empezar de cero.`;
// Calendario del mes anterior, el actual y el siguiente (las IA se equivocan con los días de la semana): así puede elegir
// bien las fechas de asistencia según los días de sesión aprendidos ("martes y jueves")
function calendario(hoy = new Date()) {
  const dias = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'], meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const linea = (a, m) => {
    const n = new Date(a, m + 1, 0).getDate();
    return `${meses[m]} ${a}: ` + Array.from({ length: n }, (_, i) => `${String(i + 1).padStart(2, '0')} ${dias[new Date(a, m, i + 1).getDay()]}`).join(', ');
  };
  const a = hoy.getFullYear(), m = hoy.getMonth();
  return `Hoy es ${dias[hoy.getDay()]} ${hoy.toLocaleDateString('es-AR')}. Calendario (usalo para fechas y días de la semana, no los calcules):\n` +
    [m - 1, m, m + 1].map(k => linea(a + Math.floor(k / 12), ((k % 12) + 12) % 12)).join('\n');
}
async function completar({ pagina, perfil, indicaciones, firmas = [], documento }) {
  const bloques = [];
  const parecidos = ejemplosParecidos(perfil, (documento?.nombre || '') + ' ' + (documento?.texto || '') + ' ' + pagina.pedazos.map(x => x.texto).join(' '));
  for (const f of parecidos) {
    try {
      const v = /\.pdf$/i.test(f.ruta) ? await mirarPdf(fs.readFileSync(f.ruta), 2, 90) : { imagenes: [fs.readFileSync(f.ruta)] };
      bloques.push({ type: 'text', text: `Ejemplo parecido ya completado por el usuario: "${f.nombre}" (${f.ficha?.tipo_documento || ''}). Fijate cómo está completado:` });
      v.imagenes.forEach(png => { const b = bloqueImagen(png, 1200); if (b) bloques.push(b); });
    } catch {}
  }
  const pedazos = pagina.pedazos.map(x => `${x.id}\t${x.caja ? '[' + x.caja.join(',') + '] ' : ''}${x.tam ? `(letra ${x.tam} pt) ` : ''}${x.raya ? '[raya]' : x.casillero === 'tilde' ? `[casilla para tildar] ${JSON.stringify(x.texto)}` : x.casillero ? `[casillero] ${JSON.stringify(x.texto)}` : JSON.stringify(x.texto)}`).join('\n');
  bloques.push({ type: 'text', text: `La página ${pagina.n} del documento "${documento?.nombre || ''}" que hay que completar:` });
  const img = pagina.imagen && bloqueImagen(pagina.imagen); if (img) bloques.push(img);
  bloques.push({ type: 'text', text: calendario() });
  bloques.push({ type: 'text', text: (indicaciones ? `Lo que pide el usuario para esta vez: ${indicaciones}\n\n` : '') +
    `Firmas y sellos disponibles: ${firmas.length ? firmas.map(f => `"${f.nombre}" (${f.tipo})`).join(', ') : 'ninguno'}\n\nPedazos de la página (en orden de lectura):\n${pedazos}` +
    (pagina.escritos?.length ? `\n\nTextos ya escritos en la página (por el usuario, con Rellenar):\n${pagina.escritos.map(e => `${e.id}\t[${e.caja.join(',')}] (letra ${e.tam} pt${e.tapar ? ', tapa lo impreso' : ''}) ${JSON.stringify(e.valor)}`).join('\n')}` : '') +
    (pagina.anterior?.length ? `\n\nPropuesta anterior (la que vio el usuario; aplicá sus correcciones sobre esto):\n${pagina.anterior.map(e => `destino ${e.destino_id}\t[${e.caja.join(',')}] (letra ${e.tam} pt, ${e.ubicacion || 'automatica'}${e.como_id ? ' como ' + e.como_id : ''}, ajuste ${e.ajuste_x || 0},${e.ajuste_y || 0}) ${JSON.stringify(e.valor)}`).join('\n')}` : '') });
  // solo para pruebas de desarrollo: guarda lo que se le pide a Claude y contesta con una respuesta fija
  if (process.env.PDFPRO_COMPLETAR_FALSO) {
    fs.writeFileSync(process.env.PDFPRO_COMPLETAR_FALSO + '.pedido.txt', bloques.filter(b => b.type === 'text').map(b => b.text).join('\n---\n'));
    return { ...JSON.parse(fs.readFileSync(process.env.PDFPRO_COMPLETAR_FALSO, 'utf8')), costo: 0 };
  }
  const r = await consultar({ tarea: 'completar documento', sistema: SISTEMA_COMPLETAR + reglasUsuario() + contextoPerfil(perfil), mensajes: [{ role: 'user', content: bloques }], formato: ESQUEMA_COMPLETAR, maxTokens: 10000, esfuerzo: 'medium' });
  if (r.rechazo || !r.texto) return { ...r, campos: [], firmas: [] };
  try { return { ...JSON.parse(r.texto), costo: r.costo, ejemplos: parecidos.map(f => f.nombre) }; }
  catch { return { campos: [], firmas: [], comentario: 'No entendí la respuesta de Claude. Probá de nuevo.', costo: r.costo }; }
}

async function probarClave() {
  const r = await consultar({ tarea: 'probar la clave', sistema: PERSONALIDAD, mensajes: [{ role: 'user', content: 'Decí "Hola" en una palabra.' }], modelo: MODELO_SIMPLE, simple: true, maxTokens: 50, esfuerzo: 'low' });
  return r.texto;
}

// Reglas del usuario (Preferencias → Protección al editar): lo que no se cambia nunca
let leerPrefs = () => ({});
function reglasUsuario() {
  const p = leerPrefs() || {}, textos = String(p.textosProtegidos || '').split('\n').map(t => t.trim()).filter(Boolean);
  const r = [];
  if (p.protegerCodigos !== false) r.push('No cambies ni inventes códigos, números de trámite, CUIT/CUIL, DNI ni códigos de barras que ya estén en el documento.');
  if (textos.length) r.push('No cambies estos textos: ' + textos.map(t => `"${t}"`).join(', ') + '.');
  return r.length ? '\n\nReglas del usuario (respetalas siempre):\n- ' + r.join('\n- ') : '';
}
function registrar(ipcMain, prefs) {
  if (prefs) leerPrefs = prefs;
  const envolver = fn => async (...args) => { try { return { ok: true, ...(await fn(...args)) }; } catch (e) { console.error('Asistente', e?.message); return { ok: false, error: explicar(e) }; } };
  ipcMain.handle('asistente-estado', () => ({ tieneClave: (proveedor() === 'gemini' ? !!leerClaveGemini() : !!leerClave()) || !!process.env.PDFPRO_COMPLETAR_FALSO, tieneGemini: !!leerClaveGemini(), tieneClaude: !!leerClave(), gasto: gastoDelMes(), tope: leerDatos().tope }));
  // Claude: una clave de Gemini (AIza…) pegada acá no se guarda: se avisa
  ipcMain.handle('asistente-clave', (_e, nueva) => {
    if (/^\s*AIza/.test(nueva || '')) return { ok: false, error: 'Esa es una clave de Gemini (empieza con AIza). Elegí Gemini arriba y pegala ahí.' };
    guardarClave(nueva); return { ok: true, tiene: !!leerClave() };
  });
  // Dictado: el audio del micrófono pasa a texto con Gemini (Claude no entiende audio)
  ipcMain.handle('asistente-transcribir', envolver(async (_e, audio, tipo) => {
    if (!leerClaveGemini()) throw new Error('SIN_VOZ');
    const modelo = mejorGemini(id => /flash/.test(id)) || mejorGemini(() => true);
    if (!modelo) throw new Error('SIN_MODELOS_GEMINI');
    const r = await llamar({ model: modelo, max_tokens: 2000, output_config: { effort: 'low' }, messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: tipo || 'audio/webm', data: Buffer.from(audio).toString('base64') } },
      { type: 'text', text: 'Transcribí exactamente lo que dice este audio (español rioplatense). Devolvé solo el texto, sin comillas ni comentarios. Si no se entiende nada, devolvé vacío.' }] }] }, 'dictado');
    return { texto: r.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim() };
  }));
  // Gemini: guarda la clave y la prueba pidiendo la lista de modelos (no gasta nada)
  ipcMain.handle('asistente-clave-gemini', async (_e, nueva) => {
    nueva = String(nueva || '').trim().replace(/^["']|["']$/g, '');
    if (/^sk-ant/.test(nueva)) return { ok: false, error: 'Esa es una clave de Claude (empieza con sk-ant). Elegí Claude arriba y pegala ahí.' };
    guardarClaveGemini(nueva);
    if (!leerClaveGemini()) { guardarDatos({ modelosGemini: [] }); return { ok: true, modelos: [] }; }
    try { const lista = await gemini.modelos(leerClaveGemini()); guardarDatos({ modelosGemini: lista, geminiMalos: [] }); return { ok: true, modelos: todosLosModelos() }; }
    catch (e) { return { ok: false, error: explicar(e) }; }
  });
  ipcMain.handle('asistente-probar', envolver(async () => ({ texto: await probarClave() })));
  ipcMain.handle('asistente-datos', () => {
    const d = leerDatos();
    // la carpeta general de la 0.13.0 pasa al perfil (si hay uno solo)
    if (d.carpeta && d.perfiles.length === 1 && !d.perfiles[0].carpeta) { d.perfiles[0].carpeta = d.carpeta; guardarDatos({ perfiles: d.perfiles, carpeta: '' }); }
    const estudiados = Object.fromEntries(d.perfiles.map(p => [p.nombre, Object.keys(d.fichas?.[p.nombre] || {}).length]));
    return { perfiles: d.perfiles, recetas: d.recetas, tope: d.tope, estudiados, modelo: d.modelo || 'auto', modelos: todosLosModelos(), proveedor: proveedor(), modeloGemini: modeloGemini(), modelosClaude: MODELOS, modelosGemini: modelosGemini() };
  });
  ipcMain.handle('asistente-guardar', (_e, cambios) => {
    const { perfiles, recetas, tope, modelo, proveedor: prov, modeloGemini: mg } = cambios || {};
    guardarDatos({ ...(perfiles ? { perfiles } : {}), ...(recetas ? { recetas } : {}), ...(tope != null ? { tope: +tope || 0 } : {}),
      ...(MODELOS.some(m => m.id === modelo) ? { modelo } : {}), ...(prov === 'claude' || prov === 'gemini' ? { proveedor: prov } : {}),
      ...(mg && modelosGemini().some(m => m.id === mg) ? { modeloGemini: mg } : {}) });
    return true;
  });
  ipcMain.handle('asistente-charlar', envolver((_e, pedido) => charlar(pedido)));
  ipcMain.handle('asistente-completar', envolver((_e, pedido) => completar(pedido)));
  ipcMain.handle('asistente-aprender', (_e, perfil, texto, origen) => { aprender(perfil, texto, origen); return true; });
  ipcMain.handle('asistente-estudiar', envolver((e, perfil) => estudiarCarpeta(perfil, d => { try { e.sender.send('asistente-progreso', d); } catch {} })));
  // adjuntar al chat: imágenes y PDF (hasta 30 MB cada uno)
  ipcMain.handle('asistente-elegir-adjuntos', async e => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { title: 'Adjuntar al chat', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Imágenes y PDF', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp'] }] });
    if (r.canceled) return [];
    return r.filePaths.filter(f => fs.statSync(f).size < 30e6).map(f => ({ nombre: path.basename(f), tipo: /\.pdf$/i.test(f) ? 'application/pdf' : 'image/' + (path.extname(f).slice(1).toLowerCase().replace('jpg', 'jpeg')), datos: fs.readFileSync(f) }));
  });
  ipcMain.handle('asistente-cuantos-ejemplos', (_e, perfil) => {
    const p = leerDatos().perfiles.find(x => x.nombre === perfil);
    const lugares = [p?.carpeta, ...(p?.ejemplosExtra || [])].filter(r => r && fs.existsSync(r));
    if (!lugares.length) return { archivos: 0, nuevos: 0 };
    const archivos = archivosDeLugares(lugares), viejas = fichasDe(perfil);
    return { archivos: archivos.length, nuevos: archivos.filter(r => !viejas[claveArchivo(r)]).length };
  });
}

module.exports = { registrar, estudiarCarpeta, contextoPerfil, ejemplosParecidos };
