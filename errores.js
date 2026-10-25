// Registro de errores: el programa anota las fallas (sin contenido ni datos personales) y desde Ayuda → Enviar informe
// el usuario manda lo anotado, su descripción y, si quiere, una captura. Va directo a GitHub, como un "issue" en el
// repositorio privado de errores. La clave que viene en el programa solo sirve para ESE repositorio (crear issues y subir
// capturas): si alguien la saca, solo puede mandar informes falsos y se cambia en la versión siguiente.
// Si no hay clave o no hay internet, el informe queda guardado y se manda solo la próxima vez que se pueda.
const { app, ipcMain, net } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const REPO = 'tvmaty2186/pdf-pro-errores';
const MAX_LINEAS = 300;
const carpeta = () => app.getPath('userData');
const archivo = () => path.join(carpeta(), 'errores.jsonl');
const pendientes = () => path.join(carpeta(), 'informes-pendientes');

// Saca lo que puede ser personal: rutas y nombres de archivo, mails, números largos (CUIT, DNI, teléfonos)
function limpiar(t) {
  return String(t ?? '')
    .replace(/(?:file:\/\/\/?)?[^\s(]*?(?:app\.asar|pdf-pro)[\\/]/g, '') // el código del programa sí se deja (src/app.js:123)
    .replace(/[A-Za-z]:\\[^\s"'<>|]*/g, '<ruta>')
    .replace(/(?:file:\/\/)?\/(?:home|Users|tmp|mnt|media)\/[^\s"'<>]*/g, '<ruta>')
    .replace(/[^\s"'<>\\/]+\.(pdf|docx?|xlsx?|png|jpe?g|txt)\b/gi, '<archivo>.$1')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<mail>')
    .replace(/\d{2}-?\d{8}-?\d/g, '<cuit>')
    .replace(/\d[\d.\s-]{5,}\d/g, '#')
    .slice(0, 1500);
}
function anotar(tipo, mensaje, extra = {}) {
  try {
    const linea = JSON.stringify({ fecha: new Date().toISOString(), version: app.getVersion(), tipo, mensaje: limpiar(mensaje),
      ...(extra.pila ? { pila: limpiar(extra.pila).split('\n').slice(0, 8).join('\n') } : {}), ...(extra.ms ? { ms: extra.ms } : {}) });
    fs.appendFileSync(archivo(), linea + '\n');
    const todo = fs.readFileSync(archivo(), 'utf8').split('\n').filter(Boolean);
    if (todo.length > MAX_LINEAS * 1.5) fs.writeFileSync(archivo(), todo.slice(-MAX_LINEAS).join('\n') + '\n');
  } catch {}
}
function leer(n = 60) {
  try { return fs.readFileSync(archivo(), 'utf8').split('\n').filter(Boolean).slice(-n).map(l => JSON.parse(l)); } catch { return []; }
}
// La clave viene en clave-errores.json (lo arma el instalador desde una variable del entorno; no está en el código)
function clave() {
  try {
    const { c } = JSON.parse(fs.readFileSync(path.join(__dirname, 'clave-errores.json'), 'utf8'));
    return Buffer.from(c, 'base64').map((b, i) => b ^ (0x5a + i) & 0xff).toString();
  } catch { return null; }
}
async function github(metodo, ruta, cuerpo) {
  const r = await net.fetch('https://api.github.com/repos/' + REPO + ruta, { method: metodo,
    headers: { Authorization: 'Bearer ' + clave(), Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'pdf.pro' },
    body: JSON.stringify(cuerpo) });
  if (!r.ok) throw new Error('GitHub respondió ' + r.status);
  return r.json();
}
function sistema() {
  return `pdf.pro ${app.getVersion()} · ${os.platform() === 'win32' ? 'Windows' : os.platform()} ${os.release()} · ${os.arch()} · ${Math.round(os.totalmem() / 2 ** 30)} GB`;
}
async function mandar(inf) {
  let enlace = '';
  if (inf.captura) {
    const r = await github('PUT', `/contents/capturas/${inf.id}.png`, { message: 'Captura ' + inf.id, content: inf.captura });
    enlace = `\n\n**Captura:** ${r.content?.html_url || ''}`;
  }
  const errores = inf.errores.map(e => `- ${e.fecha} [${e.tipo}] ${e.mensaje}${e.ms ? ` (${Math.round(e.ms / 1000)} s)` : ''}${e.pila ? '\n  ```\n  ' + e.pila.replace(/\n/g, '\n  ') + '\n  ```' : ''}`).join('\n');
  const titulo = (inf.titulo || inf.descripcion || inf.errores.at(-1)?.mensaje || 'Informe').replace(/\s+/g, ' ').slice(0, 70);
  await github('POST', '/issues', { title: `[${inf.version}]${inf.auto ? ' [IA]' : ''} ${titulo}`, labels: inf.auto ? ['informe', 'ia'] : ['informe'],
    body: `**${inf.auto ? 'Informe automático del asistente' : 'Qué pasó (lo cuenta el usuario)'}:**\n${inf.descripcion || '(sin descripción)'}\n\n**Equipo:** ${inf.sistema}${enlace}\n\n**Errores anotados (últimos ${inf.errores.length}):**\n${errores || '(ninguno)'}` });
}
// Lo que quedó sin mandar (sin internet o sin clave) se manda cuando se pueda
async function mandarPendientes() {
  if (!clave()) return;
  let lista = [];
  try { lista = fs.readdirSync(pendientes()).filter(f => f.endsWith('.json')); } catch { return; }
  for (const f of lista) {
    try { await mandar(JSON.parse(fs.readFileSync(path.join(pendientes(), f), 'utf8'))); fs.unlinkSync(path.join(pendientes(), f)); } catch { return; }
  }
}

// Informe automático (fallas del asistente): sin que el usuario haga nada. El mismo problema (firma) no se repite antes de
// 10 minutos, y no más de 15 por día. Si no se puede mandar, queda guardado como los demás.
const yaMandados = new Map(), hoy = { dia: '', n: 0 };
async function informeAutomatico({ titulo, cuerpo, firma }) {
  const ahora = Date.now(), dia = new Date().toISOString().slice(0, 10);
  if (hoy.dia !== dia) { hoy.dia = dia; hoy.n = 0; }
  if (hoy.n >= 15 || ahora - (yaMandados.get(firma) || 0) < 10 * 60000) return;
  yaMandados.set(firma, ahora); hoy.n++;
  anotar('asistente', titulo);
  const inf = { id: new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex'), version: app.getVersion(), sistema: sistema(),
    titulo, descripcion: String(cuerpo).slice(0, 60000), errores: leer(15), captura: null, auto: true };
  if (clave()) { try { await mandar(inf); return; } catch (e) { anotar('informe', 'No se pudo mandar el informe automático: ' + e.message); } }
  try { fs.mkdirSync(pendientes(), { recursive: true }); fs.writeFileSync(path.join(pendientes(), inf.id + '.json'), JSON.stringify(inf)); } catch {}
}

function iniciar(ventana) {
  process.on('uncaughtException', e => anotar('falla', e?.message || e, { pila: e?.stack }));
  process.on('unhandledRejection', e => anotar('falla', e?.message || e, { pila: e?.stack }));
  // lo último que hizo el usuario (menús, Ctrl+K, herramientas), solo en memoria: va en el informe si se cae la ventana
  const migas = [];
  ipcMain.on('miga', (_e, que) => { migas.push(new Date().toISOString().slice(11, 19) + ' ' + String(que).slice(0, 120)); if (migas.length > 12) migas.shift(); });
  app.on('render-process-gone', (_e, _w, d) => {
    if (d?.reason === 'clean-exit') return;
    anotar('ventana caída', d?.reason + ' ' + (d?.exitCode ?? ''));
    const mem = process.getSystemMemoryInfo?.() || {};
    informeAutomatico({ titulo: `La ventana se cerró (${d?.reason})`, firma: 'ventana-' + d?.reason,
      cuerpo: `**Motivo:** ${d?.reason} · código ${d?.exitCode ?? '—'}\n**Memoria libre de la PC:** ${mem.free ? (mem.free / 1048576).toFixed(1) + ' GB de ' + (mem.total / 1048576).toFixed(1) + ' GB' : '—'}\n\n**Lo último que hizo:**\n${migas.map(m => '- ' + m).join('\n') || '- (nada anotado)'}` }).catch(() => {});
  });
  app.on('child-process-gone', (_e, d) => { if (d?.reason !== 'clean-exit') anotar('proceso caído', `${d?.type} ${d?.reason}`); });
  ipcMain.handle('error-anotar', (_e, tipo, mensaje, extra) => anotar(String(tipo).slice(0, 30), mensaje, extra || {}));
  ipcMain.handle('errores-leer', () => leer());
  ipcMain.handle('captura-ventana', async () => { const w = ventana(); return w && !w.isDestroyed() ? (await w.webContents.capturePage()).toPNG() : null; });
  ipcMain.handle('errores-informe', async (_e, { descripcion, captura }) => {
    const inf = { id: new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex'), version: app.getVersion(), sistema: sistema(),
      descripcion: String(descripcion || '').slice(0, 4000), errores: leer(40), captura: captura ? Buffer.from(captura).toString('base64') : null };
    if (clave()) {
      try { await mandar(inf); return { enviado: true }; } catch (e) { anotar('informe', 'No se pudo mandar el informe: ' + e.message); }
    }
    fs.mkdirSync(pendientes(), { recursive: true });
    fs.writeFileSync(path.join(pendientes(), inf.id + '.json'), JSON.stringify(inf));
    return { enviado: false };
  });
  setTimeout(() => mandarPendientes().catch(() => {}), 20000);
}
module.exports = { iniciar, anotar, limpiar, informeAutomatico };
