// PDF.Pro — del lado del programa: la IA local (sin internet). Elige el modelo bajado según la memoria de la PC,
// manda los pedidos al proceso aparte (ia-local.js) y lo cierra a los 5 minutos sin uso para devolver la memoria.
// Resumir: los documentos largos se resumen por partes y después se juntan. Preguntar: se mandan las partes que más
// se parecen a la pregunta. Nada sale de la PC.
const { app, net } = require('electron');
const crypto = require('crypto');
const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// El primero que esté bajado y entre en la memoria. Se bajan de Hugging Face en una versión fija y se controla
// el archivo entero (tamaño y huella sha256) antes de usarlo.
const MODELOS = [
  { archivo: 'Qwen3.5-4B-Q4_K_M.gguf', nombre: 'Qwen3.5 4B', memoriaMin: 11.5e9, tam: 2740937888,
    sha256: '00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4',
    url: 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/e87f176479d0855a907a41277aca2f8ee7a09523/Qwen3.5-4B-Q4_K_M.gguf' },
  { archivo: 'Qwen3.5-2B-Q4_K_M.gguf', nombre: 'Qwen3.5 2B', memoriaMin: 0, tam: 1280835840,
    sha256: 'aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223',
    url: 'https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/f6d5376be1edb4d416d56da11e5397a961aca8ae/Qwen3.5-2B-Q4_K_M.gguf' }
];
// el que conviene bajar para esta PC (en las pruebas, PDFPRO_MODELO_URL cambia la descarga por uno chiquito)
function recomendado() {
  const m = MODELOS.find(m => os.totalmem() >= m.memoriaMin);
  if (!process.env.PDFPRO_MODELO_URL) return m;
  const [url, sha256, tam] = process.env.PDFPRO_MODELO_URL.split(' ');
  return { ...m, url, sha256, tam: +tam };
}
const SISTEMA = 'Sos el asistente de un programa para leer PDF. Respondés siempre en español rioplatense, claro y corto, sin inventar nada que no esté en el documento.';
const PARTE = 1500, LIMITE_PARTES = 12; // palabras por parte (entra cómodo en el contexto de 6.144) y hasta cuántas
const carpeta = () => path.join(app.getPath('userData'), 'modelos');

function modeloElegido() {
  if (process.env.PDFPRO_MODELO_LOCAL) return { ruta: process.env.PDFPRO_MODELO_LOCAL, nombre: path.basename(process.env.PDFPRO_MODELO_LOCAL, '.gguf') };
  const bajados = MODELOS.filter(m => fs.existsSync(path.join(carpeta(), m.archivo)));
  const m = bajados.find(m => os.totalmem() >= m.memoriaMin) || bajados.at(-1);
  return m ? { ruta: path.join(carpeta(), m.archivo), nombre: m.nombre } : null;
}

module.exports = function (errores) {
  let hijo = null, sig = 1, reloj = null;
  const pendientes = new Map();
  function arrancar() {
    // Node común: el que viene con el programa (resources/node) o, armando, el de la PC
    const nodo = process.env.PDFPRO_NODE || (app.isPackaged ? path.join(process.resourcesPath, 'node', process.platform === 'win32' ? 'node.exe' : 'node') : 'node');
    const script = path.join(__dirname.replace(/app\.asar$/, 'app.asar.unpacked'), 'ia-local.js');
    hijo = fork(script, [], { execPath: nodo, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    const h = hijo;
    // se cayó o no arrancó: los pedidos en curso terminan con un error claro y el próximo lo vuelve a arrancar
    const caido = (texto, nota) => {
      if (hijo === h) hijo = null;
      const lista = [...pendientes.values()];
      pendientes.clear();
      if (nota && lista.length) errores.anotar('ia local caída', nota);
      for (const p of lista) p.rechazar(new Error(texto));
    };
    h.on('error', e => caido('No pude arrancar la IA sin internet. Probá reinstalar el programa.', 'No arrancó el proceso de la IA local: ' + e.message));
    h.on('message', m => {
      const p = pendientes.get(m.id);
      if (!p) return;
      if (m.trozo != null) return p.alTrozo?.(m.trozo);
      pendientes.delete(m.id);
      if (m.error != null) p.rechazar(new Error(m.error)); else p.resolver(m.r);
      dormir();
    });
    h.on('exit', (codigo, senal) => caido('La IA sin internet se cerró (puede faltar memoria). Cerrá otros programas y probá de nuevo.',
      `El proceso de la IA local se cerró (código ${codigo}, señal ${senal}) · memoria de la PC ${(os.totalmem() / 1e9).toFixed(1)} GB`));
  }
  // sin pedidos por 5 minutos se cierra y libera la memoria del modelo
  function dormir() { clearTimeout(reloj); if (!pendientes.size) reloj = setTimeout(() => hijo?.kill(), 5 * 60000); }
  function pedir(texto, { maxTokens = 400, alTrozo, id = sig++ } = {}) {
    const m = modeloElegido();
    if (!m) return Promise.reject(new Error('Todavía no está bajado el modelo para usar la IA sin internet.'));
    clearTimeout(reloj);
    if (!hijo) arrancar();
    return new Promise((resolver, rechazar) => {
      pendientes.set(id, { resolver, rechazar, alTrozo });
      hijo.send({ id, sistema: SISTEMA, texto, maxTokens, modelo: m.ruta });
    });
  }
  const palabras = t => t.split(/\s+/).filter(Boolean);
  function partes(texto) {
    const p = palabras(texto), r = [];
    for (let i = 0; i < p.length; i += PARTE) r.push(p.slice(i, i + PARTE).join(' '));
    return r;
  }

  // Un pedido del programa: puede tener varios pasos (las partes); cortar los corta todos
  const trabajos = new Map();
  function trabajo(clave) {
    const t = { cortado: false, ids: [] };
    trabajos.set(clave, t);
    t.pedir = (texto, op = {}) => {
      if (t.cortado) return Promise.resolve('');
      const id = sig++; t.ids.push(id);
      return pedir(texto, { ...op, id });
    };
    return t;
  }
  function cortar(clave) {
    const t = trabajos.get(clave);
    if (!t) return;
    t.cortado = true;
    for (const id of t.ids) hijo?.send({ id, cortar: true });
  }

  async function resumir(clave, texto, emitir) {
    const t = trabajo(clave);
    try {
      let lista = partes(texto), aviso = '';
      if (!lista.length) return { texto: '', aviso: 'Este documento no tiene texto para leer. Si es escaneado, pasale primero el reconocimiento de texto (OCR).' };
      if (lista.length > LIMITE_PARTES) { lista = lista.slice(0, LIMITE_PARTES); aviso = `Es muy largo: resumí las primeras ${(PARTE * LIMITE_PARTES).toLocaleString('es-AR')} palabras.`; }
      const pedido = d => `Resumí este documento en 3 a 5 viñetas cortas, con los datos importantes (montos, fechas, plazos).\n\n<documento>\n${d}\n</documento>`;
      if (lista.length === 1) return { texto: await t.pedir(pedido(lista[0]), { alTrozo: trozo => emitir({ trozo }) }), aviso };
      const resumenes = [];
      for (let i = 0; i < lista.length && !t.cortado; i++) {
        emitir({ paso: `Leyendo la parte ${i + 1} de ${lista.length}…` });
        resumenes.push(await t.pedir(pedido(lista[i])));
      }
      emitir({ paso: 'Juntando todo…' });
      const final = await t.pedir(`Estos son resúmenes de las partes de un mismo documento, en orden. Juntalos en un solo resumen de 5 a 7 viñetas cortas, sin repetir y sin perder montos, fechas ni plazos.\n\n${resumenes.map((r, i) => `Parte ${i + 1}:\n${r}`).join('\n\n')}`,
        { maxTokens: 500, alTrozo: trozo => emitir({ trozo }) });
      return { texto: final, aviso };
    } finally { trabajos.delete(clave); }
  }

  async function preguntar(clave, texto, pregunta, emitir) {
    const t = trabajo(clave);
    try {
      let lista = partes(texto);
      if (!lista.length) return { texto: 'Este documento no tiene texto para leer. Si es escaneado, pasale primero el reconocimiento de texto (OCR).' };
      // si no entra entero, las partes que más palabras comparten con la pregunta (en el orden del documento)
      if (lista.length > 2) {
        const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
        const claves = new Set(palabras(norm(pregunta)).map(p => p.replace(/[^a-z0-9ñ]/g, '')).filter(p => p.length > 3));
        const puntaje = parte => palabras(norm(parte)).reduce((a, p) => a + (claves.has(p.replace(/[^a-z0-9ñ]/g, '')) ? 1 : 0), 0);
        const mejores = lista.map((p, i) => ({ i, n: puntaje(p) })).sort((a, b) => b.n - a.n).slice(0, 2).map(x => x.i).sort((a, b) => a - b);
        lista = mejores.map(i => lista[i]);
      }
      const r = await t.pedir(`Documento:\n<documento>\n${lista.join('\n[…]\n')}\n</documento>\n\nPregunta: ${pregunta}\nRespondé corto. Si no está en el documento, decilo.`,
        { maxTokens: 300, alTrozo: trozo => emitir({ trozo }) });
      return { texto: r };
    } finally { trabajos.delete(clave); }
  }

  // ---- Bajar el modelo: sigue aunque se cierre la ventana de ajustes; si se corta, la próxima sigue desde ahí ----
  let bajada = null; // { nombre, bajado, total, control, error }
  const avisar = () => { for (const w of require('electron').BrowserWindow.getAllWindows()) w.webContents.send('ia-local-bajada', estadoBajada()); };
  const estadoBajada = () => bajada && { nombre: bajada.nombre, bajado: bajada.bajado, total: bajada.total, error: bajada.error || null, listo: !!bajada.listo };
  async function bajar() {
    if (bajada && !bajada.error && !bajada.listo) return;
    const m = recomendado(), destino = path.join(carpeta(), m.archivo), parcial = destino + '.parcial';
    bajada = { nombre: m.nombre, bajado: 0, total: m.tam, control: new AbortController() };
    try {
      fs.mkdirSync(carpeta(), { recursive: true });
      const libre = fs.statfsSync(carpeta()), hay = libre.bavail * libre.bsize;
      let ya = fs.existsSync(parcial) ? fs.statSync(parcial).size : 0;
      if (ya > m.tam) { fs.rmSync(parcial); ya = 0; }
      if (hay < m.tam - ya + 3e8) throw new Error(`No hay lugar en el disco: hacen falta ${((m.tam - ya) / 1e9 + 0.3).toFixed(1).replace('.', ',')} GB libres.`);
      // la huella se calcula mientras baja; si sigue de una bajada anterior, primero se lee lo que ya estaba
      const huella = crypto.createHash('sha256');
      if (ya) await new Promise((ok, mal) => fs.createReadStream(parcial).on('data', b => huella.update(b)).on('end', ok).on('error', mal));
      bajada.bajado = ya; avisar();
      const r = await net.fetch(m.url, { headers: ya ? { Range: `bytes=${ya}-` } : {}, signal: bajada.control.signal });
      if (!r.ok) throw new Error(`El sitio del modelo respondió ${r.status}. Probá más tarde.`);
      if (ya && r.status !== 206) { r.body?.cancel(); throw Object.assign(new Error('reintentar'), { reintentar: true }); } // no deja seguir: de cero
      const archivo = fs.createWriteStream(parcial, { flags: ya ? 'a' : 'w' });
      let ultimo = 0;
      try {
        for await (const trozo of r.body) {
          huella.update(trozo);
          if (!archivo.write(trozo)) await new Promise(ok => archivo.once('drain', ok));
          bajada.bajado += trozo.length;
          if (Date.now() - ultimo > 300) { ultimo = Date.now(); avisar(); }
        }
      } finally { await new Promise(ok => archivo.end(ok)); }
      if (bajada.bajado !== m.tam || huella.digest('hex') !== m.sha256) { fs.rmSync(parcial, { force: true }); throw new Error('El archivo bajó con errores. Probá de nuevo.'); }
      fs.renameSync(parcial, destino);
      bajada.listo = true;
    } catch (e) {
      if (e.reintentar) { fs.rmSync(parcial, { force: true }); bajada = null; return bajar(); }
      bajada.error = bajada.control.signal.aborted ? 'cancelada' : (/^(No hay lugar|El sitio|El archivo)/.test(e.message) ? e.message : 'Se cortó la conexión. Tocá Bajar de nuevo y sigue desde donde quedó.');
      if (!bajada.control.signal.aborted && !/^No hay lugar/.test(e.message)) errores.anotar('ia local', 'Bajar el modelo: ' + e.message);
    }
    avisar();
  }
  function borrarModelos() {
    hijo?.kill();
    for (const m of MODELOS) for (const f of [m.archivo, m.archivo + '.parcial']) fs.rmSync(path.join(carpeta(), f), { force: true });
    bajada = null;
  }

  function registrar(ipcMain) {
    ipcMain.handle('ia-local-estado', () => {
      const m = modeloElegido(), r = recomendado();
      return { modelo: m?.nombre || null, carpeta: carpeta(), memoriaGB: os.totalmem() / 1e9, recomendado: { nombre: r.nombre, tam: r.tam }, bajada: estadoBajada() };
    });
    ipcMain.handle('ia-local-bajar', () => { bajar(); });
    ipcMain.handle('ia-local-cancelar-bajada', () => bajada?.control.abort());
    ipcMain.handle('ia-local-borrar', () => borrarModelos());
    const emisor = (e, clave) => d => { if (!e.sender.isDestroyed()) e.sender.send('ia-local-trozo', { clave, ...d }); };
    ipcMain.handle('ia-local-resumir', (e, clave, texto) => resumir(clave, String(texto || ''), emisor(e, clave)));
    ipcMain.handle('ia-local-preguntar', (e, clave, texto, pregunta) => preguntar(clave, String(texto || ''), String(pregunta || ''), emisor(e, clave)));
    ipcMain.handle('ia-local-cortar', (_e, clave) => cortar(clave));
  }
  return { registrar, modeloElegido, pedir, cerrar: () => hijo?.kill() };
};
