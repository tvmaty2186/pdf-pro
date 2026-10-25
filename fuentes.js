// pdf.pro — fuentes para editar texto (proceso principal).
// Lista las fuentes instaladas en Windows (las mismas que usa Word) y las de "Mis fuentes" (carpeta del usuario),
// y saca las fuentes que vienen dentro de un PDF para guardarlas en "Mis fuentes".
const { app, dialog, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const fontkit = require('@pdf-lib/fontkit');

const EXT = /\.(ttf|otf|ttc)$/i;
const biblioteca = () => path.join(app.getPath('userData'), 'fuentes');
const archivoCache = () => path.join(app.getPath('userData'), 'fuentes-cache.json');

function carpetasSistema() {
  if (process.platform === 'win32') return [path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'), path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Fonts')];
  return ['/usr/share/fonts', path.join(app.getPath('home'), '.fonts'), path.join(app.getPath('home'), '.local', 'share', 'fonts')];
}
function archivos(dir, lista = []) {
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return lista; }
  for (const i of items) {
    const r = path.join(dir, i.name);
    if (i.isDirectory()) archivos(r, lista); else if (EXT.test(i.name)) lista.push(r);
  }
  return lista;
}
// Datos de cada fuente de un archivo (un .ttc trae varias)
function describir(ruta) {
  let f;
  try { f = fontkit.create(fs.readFileSync(ruta)); } catch { return []; }
  const lista = f.fonts ? f.fonts.map((x, i) => [x, i]) : [[f, -1]];
  return lista.map(([x, indice]) => {
    try {
      const sub = String(x.subfamilyName || ''), peso = x['OS/2']?.usWeightClass || 400;
      return { familia: x.familyName, estilo: sub, ps: x.postscriptName, ruta, indice,
        negrita: peso >= 600 || /bold|black|heavy/i.test(sub), cursiva: !!x.italicAngle || /italic|oblique/i.test(sub) };
    } catch { return null; }
  }).filter(x => x?.familia && !x.familia.startsWith('.'));
}
// Se guarda lo leído (leer cientos de fuentes tarda); se vuelve a leer solo lo que cambió
// La primera vez se leen de a una, dejando respirar al programa entre fuente y fuente (si no, la ventana se congela).
let memoria = null, enCurso = null;
const respirar = () => new Promise(r => setImmediate(r));
function listar() { return (enCurso ||= listarDeAPoco().finally(() => { enCurso = null; })); }
async function listarDeAPoco() {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(archivoCache(), 'utf8')); } catch {}
  const nuevo = {}, salida = { sistema: [], biblioteca: [] };
  fs.mkdirSync(biblioteca(), { recursive: true });
  for (const [donde, dirs] of [['sistema', carpetasSistema()], ['biblioteca', [biblioteca()]]]) {
    for (const ruta of dirs.flatMap(d => archivos(d))) {
      let st; try { st = fs.statSync(ruta); } catch { continue; }
      const clave = `${ruta}|${st.size}|${st.mtimeMs}`;
      if (!cache[clave]) await respirar();
      nuevo[clave] = cache[clave] || describir(ruta);
      salida[donde].push(...nuevo[clave]);
    }
  }
  try { fs.writeFileSync(archivoCache(), JSON.stringify(nuevo)); } catch {}
  return (memoria = salida);
}

// Un .ttc (varias fuentes en un archivo, como Cambria) se pasa a un .ttf suelto para poder incrustarlo
function sacarDeColeccion(buf, indice) {
  const off = buf.readUInt32BE(12 + 4 * indice), n = buf.readUInt16BE(off + 4);
  const tablas = [];
  for (let i = 0; i < n; i++) {
    const p = off + 12 + 16 * i;
    tablas.push({ tag: buf.subarray(p, p + 4), suma: buf.readUInt32BE(p + 4), desde: buf.readUInt32BE(p + 8), largo: buf.readUInt32BE(p + 12) });
  }
  let pos = 12 + 16 * n;
  const partes = [], cabeza = Buffer.alloc(pos);
  buf.copy(cabeza, 0, off, off + 12);
  tablas.forEach((t, i) => {
    const p = 12 + 16 * i;
    t.tag.copy(cabeza, p); cabeza.writeUInt32BE(t.suma, p + 4); cabeza.writeUInt32BE(pos, p + 8); cabeza.writeUInt32BE(t.largo, p + 12);
    const relleno = (4 - (t.largo % 4)) % 4;
    partes.push(buf.subarray(t.desde, t.desde + t.largo), Buffer.alloc(relleno));
    pos += t.largo + relleno;
  });
  return Buffer.concat([cabeza, ...partes]);
}
function bytesDe({ ruta, indice }) {
  const buf = fs.readFileSync(ruta);
  return indice >= 0 ? sacarDeColeccion(buf, indice) : buf;
}

// ---------- Fuentes que vienen dentro del PDF ----------
let mupdf = null;
const mu = async () => (mupdf ||= await import('mupdf'));
const sinPrefijo = n => String(n || '').replace(/^[A-Z]{6}\+/, '').replace(/-\d{3,}$/, '');
async function fuentesDelPdf(datos, conBytes = null) {
  const m = await mu(), d = m.Document.openDocument(Buffer.from(datos), 'application/pdf');
  try {
    const pdf = d.asPDF(), vistas = new Set(), lista = new Map();
    const revisarRecursos = (rec, prof = 0) => {
      if (!rec || rec.isNull()) return;
      rec = rec.resolve();
      const fonts = rec.get('Font');
      if (fonts && !fonts.isNull()) fonts.resolve().forEach(f => {
        f = f.resolve();
        const base = f.get('BaseFont'), original = base && !base.isNull() ? base.asName() : '';
        if (!original) return;
        const nombre = sinPrefijo(original);
        if (lista.has(nombre) && lista.get(nombre).copiable) return;
        let desc = f.get('FontDescriptor');
        if ((!desc || desc.isNull()) && f.get('Subtype').asName?.() === 'Type0') desc = f.get('DescendantFonts').resolve().get(0).resolve().get('FontDescriptor');
        let archivo = null, formato = 'sin archivo';
        if (desc && !desc.isNull()) {
          desc = desc.resolve();
          const f2 = desc.get('FontFile2'), f3 = desc.get('FontFile3'), f1 = desc.get('FontFile');
          if (f2 && !f2.isNull()) { archivo = f2; formato = 'TrueType'; }
          else if (f3 && !f3.isNull()) { const st = f3.resolve().get('Subtype').asName?.(); formato = st === 'OpenType' ? 'OpenType' : 'CFF'; if (st === 'OpenType') archivo = f3; }
          else if (f1 && !f1.isNull()) formato = 'Type1';
        }
        const info = { nombre, original, formato, copiable: !!archivo, recortada: /^[A-Z]{6}\+/.test(original) };
        if (conBytes === nombre && archivo) info.bytes = Buffer.from(archivo.readStream().asUint8Array()); // ojo: resolve() en un flujo no deja leerlo
        lista.set(nombre, info);
      });
      if (prof < 2) { const xo = rec.get('XObject'); if (xo && !xo.isNull()) xo.resolve().forEach(x => { x = x.resolve(); if (x.isStream?.() || x.isDictionary()) { const r = x.get('Resources'); if (r && !r.isNull() && !vistas.has(r.toString())) { vistas.add(r.toString()); revisarRecursos(r, prof + 1); } } }); }
    };
    for (let i = 0; i < pdf.countPages(); i++) { try { revisarRecursos(pdf.findPage(i).getInheritable('Resources')); } catch {} }
    return [...lista.values()];
  } finally { d.destroy(); }
}

function registrar(ipcMain) {
  ipcMain.handle('fuentes-lista', () => memoria || listar());
  // solo archivos de fuentes, y de las carpetas de fuentes conocidas
  ipcMain.handle('fuente-bytes', (_e, f) => {
    const r = path.resolve(String(f?.ruta || ''));
    if (!EXT.test(r) || ![...carpetasSistema(), biblioteca()].some(c => r.toLowerCase().startsWith(path.resolve(c).toLowerCase() + path.sep))) throw new Error('Fuente no permitida.');
    return bytesDe({ ruta: r, indice: f.indice });
  });
  ipcMain.handle('fuentes-del-pdf', async (_e, datos) => (await fuentesDelPdf(datos)).map(({ bytes, ...x }) => x));
  // Los bytes de una fuente que viene dentro del PDF (para editar con la letra original cuando no está instalada).
  // Devuelve también qué letras trae (suele venir recortada: solo las que usa el documento).
  ipcMain.handle('fuente-del-pdf-bytes', async (_e, datos, nombre) => {
    const f = (await fuentesDelPdf(datos, nombre)).find(x => x.nombre === nombre);
    if (!f?.bytes) return null;
    try { const fk = fontkit.create(f.bytes); const letras = fk.characterSet || []; return letras.length >= 2 ? { bytes: f.bytes, letras: String.fromCodePoint(...letras.slice(0, 5000)) } : null; }
    catch { return null; }
  });
  // Guarda en "Mis fuentes" una fuente que viene dentro del PDF
  ipcMain.handle('fuente-copiar-del-pdf', async (_e, datos, nombre) => {
    const f = (await fuentesDelPdf(datos, nombre)).find(x => x.nombre === nombre);
    if (!f?.bytes) return { error: 'Esta fuente viene en un formato que no se puede copiar (' + (f?.formato || '?') + ').' };
    let letras = 0;
    try { const fk = fontkit.create(f.bytes); letras = fk.characterSet?.length || 0; } catch { return { error: 'La fuente del documento está incompleta y no se puede usar para escribir.' }; }
    if (letras < 2) return { error: 'La fuente del documento no trae las letras en un formato que se pueda reutilizar.' };
    const destino = path.join(biblioteca(), nombre.replace(/[^\w.-]+/g, '_') + (f.formato === 'OpenType' ? '.otf' : '.ttf'));
    fs.mkdirSync(biblioteca(), { recursive: true });
    fs.writeFileSync(destino, f.bytes);
    await listar();
    return { ok: true, letras, recortada: f.recortada };
  });
  ipcMain.handle('fuente-agregar-archivo', async e => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { title: 'Agregar fuentes', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Fuentes', extensions: ['ttf', 'otf', 'ttc'] }] });
    if (r.canceled || !r.filePaths.length) return { n: 0 };
    fs.mkdirSync(biblioteca(), { recursive: true });
    for (const p of r.filePaths) fs.copyFileSync(p, path.join(biblioteca(), path.basename(p)));
    await listar();
    return { n: r.filePaths.length };
  });
}
module.exports = { registrar, precalentar: () => listar().catch(() => {}) };
