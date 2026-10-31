// PDF.Pro — proceso principal (ventana, archivos, preferencias, integración con Windows)
const { app, BrowserWindow, ipcMain, dialog, nativeTheme, shell, systemPreferences, Menu, Tray, nativeImage, clipboard, safeStorage } = require('electron');
// Windows a veces cree que la ventana está tapada y deja de dibujar una parte (queda un recuadro negro abajo
// después de maximizar o volver de otra ventana). Se apaga esa detección.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// ---------- Seguridad ----------
// Solo la ventana del programa (archivos locales) puede pedirle cosas al proceso principal.
{
  const original = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (canal, fn) => original(canal, (e, ...args) => {
    if (!String(e.senderFrame?.url || '').startsWith('file://')) throw new Error('Pedido no permitido.');
    return fn(e, ...args);
  });
}
// Los archivos que la ventana puede leer, escribir o abrir con Windows: solo los tipos que usa el programa
// (así un PDF malicioso no podría leer cualquier archivo ni ejecutar un .exe).
function permitido(ruta, extensiones) {
  if (typeof ruta !== 'string' || !path.isAbsolute(ruta)) throw new Error('Ruta no válida.');
  if (!extensiones.includes(path.extname(ruta).slice(1).toLowerCase())) throw new Error('Ese tipo de archivo no se puede usar desde pdf.pro.');
  return ruta;
}
const os = require('os');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
// Y la causa más común de zonas negras o sin dibujar en Windows es la aceleración de la placa de video:
// se apaga (pdf.js dibuja igual de rápido sin ella). Si alguna vez hace falta: crear el archivo "aceleracion" en la carpeta del programa.
try { if (!fs.existsSync(path.join(app.getPath('userData'), 'aceleracion'))) app.disableHardwareAcceleration(); } catch { app.disableHardwareAcceleration(); }
const crypto = require('crypto');
const errores = require('./errores');
// pruebas automáticas: cada una con su propia carpeta de datos (sin recuperar documentos ni preferencias de otra)
if (process.env.PDFPRO_DATOS) app.setPath('userData', process.env.PDFPRO_DATOS);

const prefsPath = () => path.join(app.getPath('userData'), 'preferencias.json');
const PREFS_BASE = {
  tema: 'sistema', recientes: [], panel: true, panelVista: 'miniaturas', modo: 'continuo', zoomInicial: 'ancho',
  bandeja: true, cerrarABandeja: false, iniciarConWindows: false, menuPdf: true, menuImagenes: true,
  impresoraPredeterminada: '', papelPredeterminado: 'A4', anchoFirmaCm: 5.5, mascota: true, mascotaNombre: 'Pipo', nombre: '', panelLado: 'izquierda', rapidas: true, cursor: 'seleccionar'
};
let tray = null, saliendo = false, salirAlCerrar = false;
let iniciarOculto = process.argv.includes('--oculto');
let prefs = { ...PREFS_BASE };
let win = null, acomodarVentana = () => {}; // acomodarVentana: redibuja y corrige el tamaño de la página (recuadro negro)
let pendientes = []; // archivos pedidos antes de que la ventana esté lista
let sinGuardar = 0;  // documentos con cambios sin guardar

// Lo que recuerda Rellenar (nombres, DNI, domicilios) es dato personal: va cifrado aparte, no en preferencias.json
const rellenosPath = () => path.join(app.getPath('userData'), 'rellenos.bin');
const cifrar = () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } };
function leerPrefs() {
  try { prefs = { ...PREFS_BASE, ...JSON.parse(fs.readFileSync(prefsPath(), 'utf8')) }; } catch { prefs = { ...PREFS_BASE }; }
  if (!prefs.rellenos && cifrar()) { try { prefs.rellenos = JSON.parse(safeStorage.decryptString(fs.readFileSync(rellenosPath()))); } catch {} }
}
function guardarPrefs() {
  try {
    fs.mkdirSync(path.dirname(prefsPath()), { recursive: true });
    const { rellenos, ...resto } = prefs, aparte = cifrar() && rellenos;
    if (aparte) fs.writeFileSync(rellenosPath(), safeStorage.encryptString(JSON.stringify(rellenos)));
    fs.writeFileSync(prefsPath(), JSON.stringify(aparte ? resto : prefs, null, 2));
  } catch {}
}
function pdfsDeArgs(argv) {
  if (argv.includes('--crear-pdf')) return [];
  return argv.slice(1).filter(a => /\.pdf$/i.test(a) && fs.existsSync(a));
}
// Imágenes que se aceptan para crear PDF y firmas. HEIC (fotos de iPhone) se decodifica acá y viaja como píxeles RGBA.
const EXT_IMAGENES = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'bmp', 'gif'];
const esImagen = f => new RegExp(`\\.(${EXT_IMAGENES.join('|')})$`, 'i').test(f);
async function leerImagen(f) {
  const datos = await fs.promises.readFile(f), base = { nombre: path.basename(f), carpeta: path.dirname(f) };
  if (/\.hei[cf]$/i.test(f)) {
    const { width, height, data } = await require('heic-decode')({ buffer: datos });
    return { ...base, tipo: 'rgba', ancho: width, alto: height, datos: data };
  }
  return { ...base, tipo: /\.png$/i.test(f) ? 'png' : /\.jpe?g$/i.test(f) ? 'jpg' : 'otro', datos };
}
// Clic derecho en imágenes → "Crear PDF con PDF.Pro". Windows llama una vez por archivo: se juntan en un solo PDF.
let imagenesPedidas = [], temporizadorImagenes;
function imagenesDeArgs(argv) {
  if (!argv.includes('--crear-pdf')) return;
  const nuevas = argv.slice(1).filter(a => esImagen(a) && fs.existsSync(a));
  if (!nuevas.length) return;
  imagenesPedidas.push(...nuevas);
  clearTimeout(temporizadorImagenes);
  temporizadorImagenes = setTimeout(async () => {
    const lista = [...new Set(imagenesPedidas)].sort((a, b) => a.localeCompare(b, 'es', { numeric: true })); imagenesPedidas = [];
    const imgs = (await Promise.all(lista.map(f => leerImagen(f).catch(() => null)))).filter(Boolean);
    const enviar = () => win.webContents.send('crear-desde-imagenes', imgs);
    if (win && !win.webContents.isLoading()) enviar(); else app.once('ventana-lista', enviar);
    mostrarVentana();
  }, 900);
}
// Los archivos se mandan recién cuando la interfaz avisó que está lista (antes, a veces llegaban a la ventana antes de
// que estuviera escuchando y el PDF no se abría: el programa quedaba en la pantalla de inicio)
let interfazLista = false;
function enviarArchivos(lista) {
  if (!lista.length) return;
  if (win && !win.isDestroyed() && interfazLista) win.webContents.send('abrir-archivos', lista);
  else pendientes.push(...lista);
}
function aplicarTema() {
  nativeTheme.themeSource = prefs.tema === 'sistema' ? 'system' : prefs.tema === 'oscuro' ? 'dark' : 'light';
}
function colorAcento() {
  try { return '#' + systemPreferences.getAccentColor().slice(0, 6); } catch { return ''; }
}

// Botones de ventana de Windows (minimizar, maximizar, cerrar) del mismo color que la barra
function barraVentana() {
  const o = nativeTheme.shouldUseDarkColors;
  return { color: o ? '#8E0A24' : '#E11D3F', symbolColor: '#ffffff', height: 40 }; // el final de --barra-titulo-fondo
}

// ---------- Recuperación ----------
// Cada tanto la ventana deja acá una copia de los documentos con cambios; si el programa se cierra mal, al volver se ofrecen.
let cierrePreparado = false;
ipcMain.on('listo-para-cerrar', () => { if (win && !win.isDestroyed() && cierrePreparado) win.close(); });
const dirRecuperar = () => path.join(app.getPath('userData'), 'recuperar');
const idValido = id => /^[\w-]{8,64}$/.test(String(id)) ? String(id) : (() => { throw new Error('id no válido'); })();
function borrarRecuperacion() { try { fs.rmSync(dirRecuperar(), { recursive: true, force: true }); } catch {} }
ipcMain.handle('recuperar-guardar', async (_e, id, meta, datos) => {
  await fs.promises.mkdir(dirRecuperar(), { recursive: true });
  const base = path.join(dirRecuperar(), idValido(id));
  await fs.promises.writeFile(base + '.pdf.tmp', Buffer.from(datos));
  await fs.promises.rename(base + '.pdf.tmp', base + '.pdf');
  await fs.promises.writeFile(base + '.json', JSON.stringify({ nombre: String(meta?.nombre || 'Documento'), ruta: meta?.ruta || null, fecha: Date.now() }));
});
ipcMain.handle('recuperar-borrar', async (_e, id) => {
  const base = path.join(dirRecuperar(), idValido(id));
  for (const f of [base + '.pdf', base + '.json']) { try { await fs.promises.unlink(f); } catch {} }
});
ipcMain.handle('recuperar-lista', async () => {
  let nombres = []; try { nombres = await fs.promises.readdir(dirRecuperar()); } catch { return []; }
  const lista = [];
  for (const n of nombres.filter(x => x.endsWith('.json'))) {
    const id = n.slice(0, -5);
    try { lista.push({ id, ...JSON.parse(await fs.promises.readFile(path.join(dirRecuperar(), n), 'utf8')), datos: await fs.promises.readFile(path.join(dirRecuperar(), id + '.pdf')) }); } catch {}
  }
  return lista;
});
ipcMain.handle('recuperar-limpiar', () => borrarRecuperacion());

// ---------- Actualizaciones ----------
// Las versiones nuevas se publican en github.com/tvmaty2186/pdf-pro-versiones (público, solo instaladores).
// Se busca al abrir y desde Ayuda; se descarga solo cuando el usuario dice que sí, y se instala al reiniciar.
let actualizador = null;
// la versión de Microsoft Store se actualiza desde la tienda (process.windowsStore)
function updater() {
  if (actualizador || !app.isPackaged || process.windowsStore) return actualizador;
  actualizador = require('electron-updater').autoUpdater;
  actualizador.autoDownload = false;
  actualizador.autoInstallOnAppQuit = true;
  const enviar = (tipo, datos) => { if (win && !win.isDestroyed()) win.webContents.send('actualizacion', { tipo, ...datos }); };
  actualizador.on('download-progress', p => enviar('progreso', { pct: Math.round(p.percent) }));
  actualizador.on('update-downloaded', i => enviar('lista', { version: i.version }));
  actualizador.on('error', e => enviar('error', { mensaje: String(e?.message || e).split('\n')[0] }));
  return actualizador;
}
ipcMain.handle('actualizacion-buscar', async () => {
  const u = updater();
  if (!u) return { error: process.windowsStore ? 'Esta versión se actualiza sola desde Microsoft Store.' : 'Las actualizaciones funcionan en el programa instalado.' };
  try {
    const r = await u.checkForUpdates();
    const nueva = r?.updateInfo?.version;
    return { actual: app.getVersion(), nueva, hay: !!nueva && nueva !== app.getVersion() && r.isUpdateAvailable !== false };
  } catch (e) { return { error: 'No se pudo buscar: ' + String(e?.message || e).split('\n')[0] }; }
});
ipcMain.handle('actualizacion-descargar', async () => { try { await updater()?.downloadUpdate(); return { ok: true }; } catch (e) { return { error: String(e?.message || e).split('\n')[0] }; } });
// nunca con cambios sin guardar: el instalador cierra el programa a la fuerza
ipcMain.handle('actualizacion-instalar', () => {
  if (sinGuardar) return { error: 'sin-guardar' };
  saliendo = true; setImmediate(() => updater()?.quitAndInstall(false, true));
  return { ok: true };
});

// ---------- Pantalla de carga ----------
// Oscura, con el logo y una barra que avanza con los pasos reales del arranque. Se cierra cuando la interfaz avisa que está lista.
let carga = null, ultimoAvance = [5, 'Iniciando…'], cargaDesde = 0;
function crearCarga() {
  cargaDesde = Date.now();
  carga = new BrowserWindow({ width: 720, height: 405, frame: false, resizable: false, movable: true, show: false, skipTaskbar: false,
    backgroundColor: '#1E0A10', title: 'pdf.pro', icon: path.join(__dirname, 'build', 'icon.png'), webPreferences: { sandbox: true } });
  carga.loadFile(path.join(__dirname, 'src', 'carga.html'), { query: { version: app.getVersion() } });
  carga.once('ready-to-show', () => carga?.show());
  carga.webContents.on('did-finish-load', () => avance(...ultimoAvance));
  carga.on('closed', () => { carga = null; });
}
function avance(pct, texto) {
  ultimoAvance = [pct, texto];
  if (carga && !carga.isDestroyed()) carga.webContents.executeJavaScript(`window.avance?.(${pct}, ${JSON.stringify(texto)})`).catch(() => {});
}
function cerrarCarga() {
  if (!carga || carga.isDestroyed()) return;
  avance(100, 'Listo');
  // se ve al menos un segundo y medio, aunque el programa arranque más rápido
  setTimeout(() => { if (win && !win.isDestroyed() && !win.isVisible()) mostrarPrincipal(); carga?.close(); }, Math.max(260, 1500 - (Date.now() - cargaDesde)));
}
ipcMain.on('interfaz-lista', () => {
  interfazLista = true;
  setTimeout(() => require('./fuentes.js').precalentar(), 4000); // la lista de fuentes queda lista antes de editar texto
  if (carga) { if (pendientes.length) avance(90, 'Abriendo tus documentos…'); cerrarCarga(); }
  if (pendientes.length && win && !win.isDestroyed()) { win.webContents.send('abrir-archivos', pendientes); pendientes = []; }
  if (process.env.PDFPRO_CAPTURA_CARGA && carga) carga.webContents.capturePage().then(i => fs.writeFileSync(process.env.PDFPRO_CAPTURA_CARGA, i.toPNG()));
});

// Abre maximizada (como la dejó la última vez; la primera vez, maximizada)
function mostrarPrincipal() {
  if (!win || win.isDestroyed()) return;
  if (prefs.maximizada !== false) win.maximize();
  win.show();
}
function crearVentana() {
  interfazLista = false;
  aplicarTema();
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 760, minHeight: 500, show: false,
    title: 'PDF.Pro',
    icon: path.join(__dirname, 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: barraVentana(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1E0A10' : '#FFF6F6',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'src', 'index.html'), { query: { mica: '0' } });
  const oculto = iniciarOculto && prefs.bandeja;
  avance(40, 'Preparando la ventana…');
  win.once('ready-to-show', () => { if (!oculto && !carga) mostrarPrincipal(); });
  if (!oculto) setTimeout(() => { if (win && !win.isDestroyed() && !win.isVisible()) { mostrarPrincipal(); carga?.close(); } }, 8000); // por si Windows no avisa que está lista
  // con "seguir junto al reloj", cerrar cierra la ventana de verdad y el programa queda abierto; el próximo PDF abre una
  // ventana nueva. (Esconderla o minimizarla y volver a mostrarla dejaba en Windows un recuadro negro abajo.)
  win.on('closed', () => { win = null; iniciarOculto = false; });
  win.on('close', e => {
    if (!win.isMinimized() && !win.isFullScreen()) { prefs.maximizada = win.isMaximized(); guardarPrefs(); }
    // primero la ventana guarda lo que se está escribiendo (un casillero o un cuadro de texto sin terminar)
    if (!cierrePreparado && !win.webContents.isCrashed?.()) {
      e.preventDefault(); cierrePreparado = true;
      win.webContents.send('antes-de-cerrar');
      setTimeout(() => { if (win && !win.isDestroyed() && cierrePreparado) win.close(); }, 1500);
      return;
    }
    cierrePreparado = false;
    salirAlCerrar = saliendo; // "Salir" (del ícono del reloj o al actualizar) cierra el programa; la cruz de la ventana, no
    saliendo = false;
    if (!sinGuardar) { borrarRecuperacion(); return; }
    const r = dialog.showMessageBoxSync(win, {
      type: 'warning', title: 'PDF.Pro', buttons: ['Volver', 'Salir sin guardar'], defaultId: 0, cancelId: 0,
      message: sinGuardar === 1 ? 'Hay un documento con cambios sin guardar.' : `Hay ${sinGuardar} documentos con cambios sin guardar.`,
      detail: 'Si salís ahora, se pierden esos cambios.'
    });
    if (r === 0) e.preventDefault(); else borrarRecuperacion(); // eligió salir sin guardar: no se ofrece recuperar
  });
  // si la ventana se cae (por ejemplo, falta de memoria) se avisa y al volver se ofrecen los documentos con cambios
  win.on('unresponsive', () => errores.anotar('lento', 'La ventana dejó de responder'));
  win.webContents.on('render-process-gone', (_e, d) => {
    if (!win || win.isDestroyed() || d?.reason === 'clean-exit') return;
    dialog.showMessageBoxSync(win, { type: 'warning', title: 'pdf.pro', message: 'La ventana se cerró por un problema.',
      detail: 'Puede ser falta de memoria con un documento muy grande. Se vuelve a abrir y vas a poder recuperar los documentos que tenían cambios.' });
    interfazLista = false; win.reload();
  });
  win.webContents.on('did-finish-load', () => {
    avance(75, 'Cargando el visor…');
    app.emit('ventana-lista');
    // Solo para pruebas de desarrollo: PDFPRO_CAPTURA=archivo.png [PDFPRO_JS=código a ejecutar]
    if (process.env.PDFPRO_CAPTURA) setTimeout(async () => {
      if (process.env.PDFPRO_JS) { await win.webContents.executeJavaScript(process.env.PDFPRO_JS).catch(e => console.log('JS', e)); await new Promise(r => setTimeout(r, +(process.env.PDFPRO_ESPERA || 2500))); }
      fs.writeFileSync(process.env.PDFPRO_CAPTURA, (await win.webContents.capturePage()).toPNG());
      app.exit(0);
    }, 3500);
  });
  win.webContents.on('console-message', e => { // Electron 35+: los datos vienen en el evento
    const n = e.level, m = e.message;
    if (process.env.PDFPRO_CAPTURA && (n >= 2 || n === 'warning' || n === 'error')) console.log('CONSOLA:', m);
  });
  // enlaces: solo páginas web seguras, en el navegador; la ventana nunca navega fuera del programa
  win.webContents.setWindowOpenHandler(({ url }) => { try { if (new URL(url).protocol === 'https:') shell.openExternal(url); } catch {} return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  // y por las dudas, al cambiar de tamaño o volver a mostrarse se pide que se redibuje entera
  // y si la página quedó de otro tamaño que la ventana (Windows a veces no le avisa el tamaño nuevo y queda un recuadro
  // negro abajo), se la obliga a acomodarse. Como mucho una vez cada 5 segundos.
  let acomodada = 0;
  const revisarTamano = async () => {
    if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return;
    const [, alto] = win.getContentSize(), z = win.webContents.getZoomFactor() || 1;
    const ih = await win.webContents.executeJavaScript('innerHeight').catch(() => 0);
    if (!ih || !win || win.isDestroyed() || Math.abs(ih * z - alto) < 12 || Date.now() - acomodada < 5000) return;
    acomodada = Date.now();
    if (win.isMaximized()) { win.unmaximize(); win.maximize(); }
    else { const b = win.getBounds(); win.setBounds({ ...b, height: b.height + 1 }); win.setBounds(b); }
  };
  const redibujar = () => {
    setTimeout(() => { if (win && !win.isDestroyed()) win.webContents.invalidate(); }, 80);
    setTimeout(revisarTamano, 600);
  };
  // al abrir un PDF desde Windows con el programa ya abierto (doble clic, "Abrir" de un archivo guardado) la ventana
  // ya tiene el foco y no llega ningún aviso: se revisa igual, un par de veces mientras Windows termina de acomodarla
  acomodarVentana = () => { for (const ms of [80, 700, 2000]) setTimeout(() => { if (win && !win.isDestroyed()) { win.webContents.invalidate(); acomodada = 0; revisarTamano(); } }, ms); };
  for (const ev of ['maximize', 'unmaximize', 'restore', 'show', 'focus', 'resized']) win.on(ev, redibujar);
  win.on('enter-full-screen', () => win.webContents.send('pantalla-completa', true));
  win.on('leave-full-screen', () => win.webContents.send('pantalla-completa', false));
  nativeTheme.on('updated', () => {
    try { win.setTitleBarOverlay(barraVentana()); win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1E0A10' : '#FFF6F6'); } catch {}
    win.webContents.send('tema-cambiado', nativeTheme.shouldUseDarkColors);
  });
}

// Una sola instancia: si se abre otro PDF con doble clic, va a una pestaña nueva
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_e, argv) => {
    imagenesDeArgs(argv);
    if (!win || win.isDestroyed()) { pendientes.push(...pdfsDeArgs(argv)); crearVentana(); return; }
    enviarArchivos(pdfsDeArgs(argv));
    if (!argv.includes('--crear-pdf')) { mostrarVentana(); acomodarVentana(); }
  });
  app.whenReady().then(() => {
    errores.iniciar(() => win);
    if (!iniciarOculto && !process.argv.includes('--crear-pdf')) { crearCarga(); avance(15, 'Iniciando…'); }
    leerPrefs();
    pendientes.push(...pdfsDeArgs(process.argv));
    crearVentana();
    imagenesDeArgs(process.argv);
    aplicarSistema();
  });
  app.on('window-all-closed', () => { if (salirAlCerrar || !(prefs.cerrarABandeja && tray)) app.quit(); });
  app.on('before-quit', () => { saliendo = true; });
}

// ---- Comunicación con la ventana ----
// Compartir el programa: el link siempre baja el instalador de la última versión publicada
const LINK_INSTALADOR = 'https://github.com/tvmaty2186/pdf-pro-versiones/releases/latest/download/PDF.Pro-Instalar.exe';
const MENSAJE_COMPARTIR = `Te paso pdf.pro, un programa para ver, firmar y completar PDF. Bajalo acá (para Windows): ${LINK_INSTALADOR}\n\nSi Windows avisa que no lo reconoce, tocá "Más información" y después "Ejecutar de todas formas".`;
ipcMain.handle('compartir', (_e, como) => {
  if (como === 'whatsapp') return shell.openExternal('https://wa.me/?text=' + encodeURIComponent(MENSAJE_COMPARTIR));
  if (como === 'mail') return shell.openExternal('mailto:?subject=' + encodeURIComponent('Te paso pdf.pro') + '&body=' + encodeURIComponent(MENSAJE_COMPARTIR));
  if (como === 'copiar') { clipboard.writeText(LINK_INSTALADOR); return true; }
});
ipcMain.handle('info', () => ({
  version: app.getVersion(), oscuro: nativeTheme.shouldUseDarkColors, acento: colorAcento(), prefs
}));
const EXT_OFFICE = ['docx', 'doc', 'odt', 'rtf', 'xlsx', 'xls', 'ods', 'csv', 'pptx', 'ppt', 'odp'];
ipcMain.handle('elegir-pdf', async (_e, conOffice = false) => {
  const r = await dialog.showOpenDialog(win, {
    title: conOffice ? 'Abrir' : 'Abrir PDF', properties: ['openFile', 'multiSelections'],
    filters: conOffice ? [{ name: 'PDF y documentos de Office', extensions: ['pdf', ...EXT_OFFICE] }, { name: 'Documentos PDF', extensions: ['pdf'] }] : [{ name: 'Documentos PDF', extensions: ['pdf'] }]
  });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('leer-archivo', async (_e, ruta) => {
  permitido(ruta, ['pdf']);
  const datos = await fs.promises.readFile(ruta);
  const st = await fs.promises.stat(ruta);
  prefs.recientes = [{ ruta, nombre: path.basename(ruta), fecha: Date.now() }, ...prefs.recientes.filter(r => r.ruta !== ruta)].slice(0, 15);
  guardarPrefs(); actualizarBandeja();
  return { datos, nombre: path.basename(ruta), carpeta: path.dirname(ruta), tamano: st.size, modificado: st.mtimeMs };
});
ipcMain.handle('recientes', () => {
  prefs.recientes = prefs.recientes.filter(r => fs.existsSync(r.ruta));
  guardarPrefs();
  return prefs.recientes;
});
ipcMain.handle('quitar-reciente', (_e, ruta) => { prefs.recientes = prefs.recientes.filter(r => r.ruta !== ruta); guardarPrefs(); return prefs.recientes; });
ipcMain.handle('guardar-pref', (_e, clave, valor) => {
  prefs[clave] = valor; guardarPrefs();
  if (clave === 'tema') aplicarTema();
  if (['bandeja', 'iniciarConWindows', 'menuPdf', 'menuImagenes'].includes(clave)) aplicarSistema(clave);
  return nativeTheme.shouldUseDarkColors;
});
ipcMain.handle('pantalla-completa', () => { win.setFullScreen(!win.isFullScreen()); });
ipcMain.handle('mostrar-en-carpeta', (_e, ruta) => shell.showItemInFolder(ruta));
ipcMain.handle('cerrar', () => win.close());

ipcMain.handle('leer-bytes', (_e, ruta) => fs.promises.readFile(permitido(ruta, ['pdf'])));
// Guardado seguro: 1) si el archivo cambió en otro programa desde que se abrió, se avisa; 2) se escribe al lado en un
// temporal (y se fuerza al disco); 3) se vuelve a abrir y se controla (abre, misma cantidad de páginas); 4) la versión
// anterior va a "respaldos"; 5) recién ahí se reemplaza. Si algo falla, el archivo anterior queda como estaba.
const dirRespaldos = () => path.join(app.getPath('userData'), 'respaldos');
const controlarPdf = (datos, control = {}) => motor.llamar('controlar-pdf', [datos, { paginas: control.paginas, clave: control.clave }]);
async function respaldar(ruta) {
  try {
    await fs.promises.mkdir(dirRespaldos(), { recursive: true });
    const sello = new Date().toISOString().replace(/[:T.]/g, '-').slice(0, 23);
    await fs.promises.copyFile(ruta, path.join(dirRespaldos(), `${sello} ${path.basename(ruta)}`));
    // se guardan los últimos 40 y no más de 1,5 GB
    const lista = (await fs.promises.readdir(dirRespaldos())).sort().reverse();
    let total = 0;
    for (const [i, f] of lista.entries()) {
      const r = path.join(dirRespaldos(), f), t = (await fs.promises.stat(r)).size;
      total += t;
      if (i >= 40 || total > 1.5e9) await fs.promises.unlink(r).catch(() => {});
    }
  } catch (e) { console.error('Respaldo', e?.message); } // sin respaldo igual se guarda (el original solo se reemplaza al final)
}
ipcMain.handle('guardar-archivo', async (_e, ruta, datos, control = {}) => {
  permitido(ruta, ['pdf']);
  const existe = fs.existsSync(ruta);
  if (existe && control.fechaEsperada && !control.forzar) {
    const ahora = (await fs.promises.stat(ruta)).mtimeMs;
    if (Math.abs(ahora - control.fechaEsperada) > 2000) return { cambiado: true };
  }
  const tmp = ruta + '.guardando';
  try {
    const h = await fs.promises.open(tmp, 'w');
    try { await h.writeFile(Buffer.from(datos)); await h.sync(); } finally { await h.close(); }
    try { await controlarPdf(await fs.promises.readFile(tmp), control); }
    catch (e) { const err = new Error('CONTROL: ' + e.message); err.control = true; throw err; }
    if (existe) await respaldar(ruta);
    await fs.promises.rename(tmp, ruta);
  } catch (e) {
    try { await fs.promises.unlink(tmp); } catch {} // que no quede un ".guardando" al lado del PDF
    throw e;
  }
  prefs.recientes = [{ ruta, nombre: path.basename(ruta), fecha: Date.now() }, ...prefs.recientes.filter(r => r.ruta !== ruta)].slice(0, 15);
  guardarPrefs();
  return { ruta, nombre: path.basename(ruta), modificado: (await fs.promises.stat(ruta)).mtimeMs };
});
ipcMain.handle('abrir-respaldos', async () => { await fs.promises.mkdir(dirRespaldos(), { recursive: true }); return shell.openPath(dirRespaldos()); });
const TIPOS_DESTINO = { pdf: 'Documento PDF', docx: 'Documento de Word', xlsx: 'Libro de Excel' };
ipcMain.handle('elegir-destino', async (_e, nombre, carpeta, tipo = 'pdf') => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Guardar como', defaultPath: path.join(carpeta || app.getPath('documents'), nombre),
    filters: [{ name: TIPOS_DESTINO[tipo] || TIPOS_DESTINO.pdf, extensions: [tipo] }]
  });
  if (r.canceled || !r.filePath) return null;
  return new RegExp(`\\.${tipo}$`, 'i').test(r.filePath) ? r.filePath : r.filePath + '.' + tipo;
});
// ---- Guardar un resumen del asistente como Word o PDF (se elige en la ventana de Guardar como) ----
// lineas: [[{ t, b }]] (cada renglón, con sus partes en negrita o no); pdf: los bytes ya armados en la ventana
ipcMain.handle('guardar-resumen', async (_e, nombre, carpeta, { titulo, lineas, pdf }) => {
  const r = process.env.PDFPRO_GUARDAR_COMO ? { filePath: process.env.PDFPRO_GUARDAR_COMO } : await dialog.showSaveDialog(win, { title: 'Guardar el resumen como', defaultPath: path.join(carpeta || app.getPath('documents'), nombre + '.docx'),
    filters: [{ name: 'Documento de Word', extensions: ['docx'] }, { name: 'Documento PDF', extensions: ['pdf'] }] });
  if (r.canceled || !r.filePath) return null;
  const ruta = /\.(docx|pdf)$/i.test(r.filePath) ? r.filePath : r.filePath + '.docx';
  if (/\.pdf$/i.test(ruta)) await fs.promises.writeFile(ruta, Buffer.from(pdf));
  else {
    const { zipSync, strToU8 } = require('fflate');
    const x = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const run = (t, b, tam) => `<w:r><w:rPr>${b ? '<w:b/>' : ''}${tam ? `<w:sz w:val="${tam}"/>` : ''}</w:rPr><w:t xml:space="preserve">${x(t)}</w:t></w:r>`;
    const cuerpo = `<w:p><w:pPr><w:spacing w:after="240"/></w:pPr>${run(titulo, true, 32)}</w:p>` +
      lineas.map(l => `<w:p><w:pPr><w:spacing w:after="80"/></w:pPr>${l.map(p => run(p.t, p.b)).join('')}</w:p>`).join('');
    const w = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    await fs.promises.writeFile(ruta, Buffer.from(zipSync({
      '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
      '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
      'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${w}><w:body>${cuerpo}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1418" w:right="1418" w:bottom="1418" w:left="1418" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`)
    })));
  }
  return { ruta, nombre: path.basename(ruta) };
});
// ---- Convertir: PDF → Word / Excel (propio, sin Office) y Office → PDF (con Office o LibreOffice) ----
ipcMain.handle('exportar', async (_e, tipo, datos, ruta) => {
  permitido(ruta, ['docx', 'xlsx']);
  const bytes = await motor.llamar('pdf-a-office', [tipo, datos], { tiempo: 300000 });
  await fs.promises.writeFile(ruta, Buffer.from(bytes));
  return { ruta, nombre: path.basename(ruta) };
});
ipcMain.handle('office-a-pdf', async (_e, ruta) => require('./convertir.js').officeAPdf(permitido(ruta, EXT_OFFICE)));
ipcMain.handle('abrir-con-sistema', (_e, ruta) => shell.openPath(permitido(ruta, ['pdf', ...EXT_OFFICE])));
ipcMain.handle('elegir-carpeta', async (_e, carpeta) => {
  const r = await dialog.showOpenDialog(win, { title: 'Elegir carpeta', defaultPath: carpeta || app.getPath('documents'), properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('elegir-imagenes', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Elegir imágenes', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Imágenes', extensions: EXT_IMAGENES }] });
  if (r.canceled) return [];
  return Promise.all(r.filePaths.map(f => leerImagen(f).catch(() => { throw new Error('No se pudo leer la imagen ' + path.basename(f)); })));
});
ipcMain.handle('ruta-libre', (_e, carpeta, nombre) => {
  const base = nombre.replace(/\.pdf$/i, '');
  let ruta = path.join(carpeta, base + '.pdf'), n = 2;
  while (fs.existsSync(ruta)) ruta = path.join(carpeta, `${base} (${n++}).pdf`);
  return ruta;
});
ipcMain.handle('abrir-carpeta', async (_e, carpeta) => {
  if (!path.isAbsolute(String(carpeta)) || !(await fs.promises.stat(carpeta)).isDirectory()) throw new Error('Carpeta no válida.');
  return shell.openPath(carpeta);
});
ipcMain.handle('sin-guardar', (_e, n) => { sinGuardar = n; });
// Portapapeles de Windows. "marca" identifica lo copiado desde PDF.Pro (firma o comentario) para pegarlo igual.
ipcMain.handle('portapapeles-escribir', (_e, { texto, png, marca }) => {
  const datos = {};
  if (texto) datos.text = String(texto);
  if (png) datos.image = nativeImage.createFromBuffer(Buffer.from(png));
  if (marca) datos.html = `<!--pdfpro:${String(marca).replace(/[^\w-]/g, '')}-->` + (texto ? String(texto).replace(/[<&]/g, c => c === '<' ? '&lt;' : '&amp;') : '');
  clipboard.write(datos);
});
ipcMain.handle('portapapeles-leer', () => {
  const imagen = clipboard.readImage();
  return { texto: clipboard.readText(), html: clipboard.readHTML(), png: imagen.isEmpty() ? null : imagen.toPNG(), ancho: imagen.getSize().width, alto: imagen.getSize().height };
});

// ---- Contraseñas (MuPDF): para trabajar, el PDF se abre sin cifrar; al guardar se vuelve a cifrar igual ----
// ---- MuPDF en un proceso aparte (motor.js + motor-trabajos.js) ----
const motor = require('./motor-cliente')(errores);
for (const nombre of motor.nombres) if (nombre !== 'controlar-pdf') ipcMain.handle(nombre, (_e, ...args) => motor.llamar(nombre, args));

// ---- Reconocer texto (OCR, español, sin internet) con tesseract.js ----
// En el instalador estos archivos van fuera del .asar (los usa un hilo aparte): se apunta a "app.asar.unpacked".
const desempacado = (...partes) => path.join(__dirname, ...partes).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
let ocrTrabajador = null;
async function trabajadorOcr() {
  if (!ocrTrabajador) {
    const { createWorker } = require('tesseract.js');
    ocrTrabajador = createWorker('spa', 1, { cacheMethod: 'none',
      langPath: desempacado('node_modules', '@tesseract.js-data', 'spa', '4.0.0_best_int'),
      workerPath: desempacado('node_modules', 'tesseract.js', 'src', 'worker-script', 'node', 'index.js'), errorHandler: e => console.error('OCR', e)  }).catch(e => { ocrTrabajador = null; throw e; });
  }
  return ocrTrabajador;
}
// Recibe una página dibujada (PNG) y devuelve los renglones con sus palabras y posiciones (en píxeles de esa imagen)
// ---- OCR con PaddleOCR (ocr-paddle.js: modelos ONNX con onnxruntime-node, sin Python) ----
// Recibe la imagen (PNG o JPG) de una parte de la hoja y devuelve { texto, bloques: [{ texto, confianza, caja }] }, cajas en píxeles de la imagen
ipcMain.handle('ejecutar-ocr', async (_e, imagenBuffer) => {
  const img = nativeImage.createFromBuffer(Buffer.from(imagenBuffer));
  if (img.isEmpty()) throw new Error('No se pudo leer la imagen para reconocer el texto.');
  const { width, height } = img.getSize();
  const t = Date.now(), r = await require('./ocr-paddle').reconocer({ ancho: width, alto: height, bgra: img.toBitmap() });
  if (Date.now() - t > 30000) errores.anotar('lento', `OCR de ${width}×${height} tardó ${((Date.now() - t) / 1000).toFixed(0)} s`);
  return r;
});
ipcMain.handle('ocr', async (_e, png) => {
  const t = await trabajadorOcr();
  const r = await t.recognize(Buffer.from(png), {}, { blocks: true });
  return (r.data.blocks || []).flatMap(b => b.paragraphs.flatMap(par => par.lines)).map(l => ({
    caja: l.bbox, base: l.baseline, palabras: l.words.filter(w => w.text.trim()).map(w => ({ texto: w.text.trim(), caja: w.bbox, confianza: w.confidence }))
  })).filter(l => l.palabras.length);
});

// ---- Asistente (la mascota con Claude): ver asistente.js ----
require('./asistente.js').registrar(ipcMain, () => prefs);
// ---- IA sin internet (modelo local en un proceso aparte: ia-local.js) ----
require('./ia-local-cliente')(errores).registrar(ipcMain);
require('./fuentes.js').registrar(ipcMain);

// ---- Biblioteca de firmas y sellos (PNG con fondo transparente en la carpeta del usuario) ----
const dirFirmas = () => path.join(app.getPath('userData'), 'firmas');
const indiceFirmas = () => path.join(dirFirmas(), 'firmas.json');
function leerFirmas() { try { return JSON.parse(fs.readFileSync(indiceFirmas(), 'utf8')); } catch { return []; } }
function escribirFirmas(lista) { fs.mkdirSync(dirFirmas(), { recursive: true }); fs.writeFileSync(indiceFirmas(), JSON.stringify(lista, null, 2)); }
const tipoValido = t => t === 'sello' ? 'sello' : 'firma';
ipcMain.handle('firmas-lista', async () => {
  const lista = leerFirmas().filter(f => fs.existsSync(path.join(dirFirmas(), f.archivo)));
  return Promise.all(lista.map(async f => ({ ...f, datos: await fs.promises.readFile(path.join(dirFirmas(), f.archivo)) })));
});
ipcMain.handle('firmas-guardar', async (_e, { nombre, tipo, png, ancho, alto }) => {
  const id = crypto.randomUUID(), archivo = id + '.png';
  fs.mkdirSync(dirFirmas(), { recursive: true });
  await fs.promises.writeFile(path.join(dirFirmas(), archivo), Buffer.from(png));
  escribirFirmas([...leerFirmas(), { id, nombre: String(nombre).slice(0, 60), tipo: tipoValido(tipo), archivo, ancho: +ancho, alto: +alto, fecha: Date.now() }]);
  return id;
});
ipcMain.handle('firmas-cambiar', (_e, id, { nombre, tipo }) => {
  escribirFirmas(leerFirmas().map(f => f.id !== id ? f : { ...f, ...(nombre ? { nombre: String(nombre).slice(0, 60) } : {}), ...(tipo ? { tipo: tipoValido(tipo) } : {}) }));
});
ipcMain.handle('firmas-borrar', (_e, id) => {
  const lista = leerFirmas(), f = lista.find(x => x.id === id);
  if (f) { try { fs.unlinkSync(path.join(dirFirmas(), f.archivo)); } catch {} }
  escribirFirmas(lista.filter(x => x.id !== id));
});
ipcMain.handle('elegir-imagen-firma', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Elegir la imagen de la firma o sello', properties: ['openFile'],
    filters: [{ name: 'Imágenes', extensions: EXT_IMAGENES }] });
  if (r.canceled || !r.filePaths[0]) return null;
  return leerImagen(r.filePaths[0]).catch(() => ({ nombre: path.basename(r.filePaths[0]), tipo: 'error' }));
});

// ---- Ventana, bandeja (ícono junto al reloj) e integración con Windows ----
function mostrarVentana() {
  if (!win || win.isDestroyed()) { crearVentana(); return; }
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}
function accion(nombre) { mostrarVentana(); const enviar = () => win.webContents.send('accion', nombre); if (win.webContents.isLoading()) app.once('ventana-lista', enviar); else enviar(); }
function salir() { saliendo = true; if (win && !win.isDestroyed()) { if (sinGuardar) mostrarVentana(); win.close(); } else app.quit(); }
function menuBandeja() {
  const rec = prefs.recientes.slice(0, 8);
  return Menu.buildFromTemplate([
    { label: 'Mostrar PDF.Pro', click: mostrarVentana },
    { type: 'separator' },
    { label: 'Abrir PDF…', click: () => accion('abrir') },
    { label: 'Crear PDF desde imágenes…', click: () => accion('crear') },
    { label: 'Unir varios PDF en uno…', click: () => accion('unir') },
    { label: 'Recientes', enabled: rec.length > 0, submenu: rec.length ? rec.map(r => ({ label: r.nombre, click: () => { mostrarVentana(); enviarArchivos([r.ruta]); } })) : [{ label: '(vacío)', enabled: false }] },
    { type: 'separator' },
    { label: 'Preferencias…', click: () => accion('preferencias') },
    { label: 'Salir de PDF.Pro', click: salir }
  ]);
}
function actualizarBandeja() {
  if (prefs.bandeja && !tray) {
    try {
      tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 16, height: 16 }));
      tray.setToolTip('PDF.Pro');
      tray.on('click', mostrarVentana);
    } catch { tray = null; }
  } else if (!prefs.bandeja && tray) { tray.destroy(); tray = null; }
  tray?.setContextMenu(menuBandeja());
}
const reg = args => new Promise(r => execFile('reg', args, { windowsHide: true }, e => r(!e)));
async function menuContextual() {
  // en la versión de la tienda el registro queda aislado (Explorer no lo ve) y la ruta cambia con cada versión
  if (process.platform !== 'win32' || !app.isPackaged || process.windowsStore) return;
  const exe = process.execPath, base = 'HKCU\\Software\\Classes\\SystemFileAssociations';
  const entradas = [['.pdf', 'PDFPro.Abrir', 'Abrir con PDF.Pro', `"${exe}" "%1"`, prefs.menuPdf],
    ...['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'].map(ext => [ext, 'PDFPro.Crear', 'Crear PDF con PDF.Pro', `"${exe}" --crear-pdf "%1"`, prefs.menuImagenes])];
  for (const [ext, id, texto, comando, activo] of entradas) {
    const k = `${base}\\${ext}\\shell\\${id}`;
    if (activo) {
      await reg(['add', k, '/ve', '/d', texto, '/f']);
      await reg(['add', k, '/v', 'Icon', '/d', `"${exe}",0`, '/f']);
      await reg(['add', k + '\\command', '/ve', '/d', comando, '/f']);
    } else await reg(['delete', k, '/f']);
  }
}
function aplicarSistema(clave) {
  if (!clave || clave === 'bandeja') actualizarBandeja();
  if ((!clave || clave === 'iniciarConWindows') && app.isPackaged && !process.windowsStore)
    try { app.setLoginItemSettings({ openAtLogin: !!prefs.iniciarConWindows, name: 'PDF.Pro', args: ['--oculto'] }); } catch {}
  if (!clave || clave === 'menuPdf' || clave === 'menuImagenes') menuContextual();
}

// ---- Impresión ----
ipcMain.handle('impresoras', async () => {
  const lista = await win.webContents.getPrintersAsync();
  return lista.map(i => ({ name: i.name, displayName: i.displayName, isDefault: i.isDefault }));
});
// Tamaños de hoja que acepta una impresora, en mm: [{ nombre, w, h }]. Windows: el controlador vía .NET; Linux: CUPS.
const papelesCache = new Map();
const correr = (cmd, args, env = null) => new Promise(res => execFile(cmd, args, { timeout: 10000, windowsHide: true, maxBuffer: 1 << 20, ...(env ? { env: { ...process.env, ...env } } : {}) }, (e, out) => res(e ? '' : String(out))));
ipcMain.handle('papelesImpresora', async (_e, nombre) => {
  nombre = String(nombre || '');
  if (!nombre) return [];
  if (papelesCache.has(nombre)) return papelesCache.get(nombre);
  let lista = [];
  if (process.platform === 'win32') {
    const ps = `Add-Type -AssemblyName System.Drawing; $s = New-Object System.Drawing.Printing.PrinterSettings; $s.PrinterName = $env:PDFPRO_IMPRESORA; ` +
      `[Console]::OutputEncoding = [Text.Encoding]::UTF8; foreach ($p in $s.PaperSizes) { if ($p.Kind -ne 0) { "$($p.PaperName)|$($p.Width)|$($p.Height)" } }`;
    const out = await correr('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { PDFPRO_IMPRESORA: nombre });
    lista = out.split(/\r?\n/).map(l => l.split('|')).filter(c => c.length === 3)
      .map(([nom, w, h]) => ({ nombre: nom.trim(), w: +w * 0.254, h: +h * 0.254 })); // centésimas de pulgada → mm
  } else {
    const CUPS = { A3: [297, 420], A4: [210, 297], A5: [148, 210], A6: [105, 148], B5: [176, 250], ISOB5: [176, 250], Letter: [215.9, 279.4], Legal: [215.9, 355.6],
      Executive: [184.2, 266.7], EnvDL: [110, 220], EnvC5: [162, 229], EnvC6: [114, 162], Env10: [104.8, 241.3] };
    const out = await correr('lpoptions', ['-p', nombre, '-l']);
    const linea = out.split('\n').find(l => /^PageSize/.test(l)) || '';
    for (const t of (linea.split(':')[1] || '').trim().split(/\s+/)) {
      const k = t.replace(/^\*/, ''), m = k.match(/^w(\d+(?:\.\d+)?)h(\d+(?:\.\d+)?)$/);
      if (CUPS[k]) lista.push({ nombre: k, w: CUPS[k][0], h: CUPS[k][1] });
      else if (m) lista.push({ nombre: k, w: m[1] * 25.4 / 72, h: m[2] * 25.4 / 72 });
    }
  }
  const vistos = new Set();
  lista = lista.filter(p => p.nombre && p.w > 10 && p.h > 10 && !vistos.has(p.nombre) && vistos.add(p.nombre));
  if (lista.length) papelesCache.set(nombre, lista);
  return lista;
});
// Recibe las hojas ya dibujadas (JPG) y las imprime desde una ventana oculta, una hoja por página del papel elegido
ipcMain.handle('imprimir', async (_e, t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pdfpro-imp-'));
  const mm = v => (+v).toFixed(2) + 'mm';
  try {
    const partes = [];
    for (let i = 0; i < t.hojas.length; i++) {
      await fs.promises.writeFile(path.join(dir, `h${i}.jpg`), Buffer.from(t.hojas[i].datos));
      partes.push(`<div class="hoja"><img src="h${i}.jpg" style="width:${mm(t.hojas[i].ancho)};height:${mm(t.hojas[i].alto)}"></div>`);
    }
    const html = `<!doctype html><meta charset="utf-8"><title>${String(t.nombre || 'PDF.Pro').replace(/[<&]/g, '')}</title><style>
@page { size: ${mm(t.papel.w)} ${mm(t.papel.h)}; margin: 0 }
html, body { margin: 0; padding: 0; background: #fff }
.hoja { width: ${mm(t.papel.w)}; height: ${mm(t.papel.h)}; display: flex; align-items: center; justify-content: center; overflow: hidden; break-after: page }
.hoja:last-child { break-after: auto }
img { display: block }</style>${partes.join('')}`;
    await fs.promises.writeFile(path.join(dir, 'imprimir.html'), html);
    const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
    await w.loadFile(path.join(dir, 'imprimir.html'));
    const micras = { width: Math.round(t.papel.w * 1000), height: Math.round(t.papel.h * 1000) };
    // Solo para pruebas de desarrollo: guarda en PDF en lugar de imprimir
    if (process.env.PDFPRO_IMPRIMIR_PDF) {
      fs.writeFileSync(process.env.PDFPRO_IMPRIMIR_PDF, await w.webContents.printToPDF({ preferCSSPageSize: true, printBackground: true, margins: { marginType: 'none' } }));
      w.destroy(); return { ok: true };
    }
    const r = await new Promise(res => w.webContents.print({
      silent: true, deviceName: t.impresora, copies: Math.max(1, Math.min(99, t.copias | 0)), collate: !!t.intercalar,
      color: !!t.color, duplexMode: ['simplex', 'longEdge', 'shortEdge'].includes(t.dobleFaz) ? t.dobleFaz : 'simplex',
      landscape: false, pageSize: micras, margins: { marginType: 'none' }, printBackground: true
    }, (ok, error) => res({ ok, error })));
    setTimeout(() => w.destroy(), 2000);
    return r;
  } finally { setTimeout(() => fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}), 60000); }
});
