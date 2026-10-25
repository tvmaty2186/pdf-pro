// Arma los PDF difíciles de prueba en pruebas/pdfs/ (sin datos de nadie). Se corre una vez (node pruebas/generar.js);
// los PDF quedan guardados en el repositorio, así las pruebas no dependen de LibreOffice.
// Los 5 documentos: simple, fuentes incrustadas (LibreOffice), tablas, columnas y texto partido. Y casos de errores
// que ya se arreglaron: texto tapado / código de barras, desborde de hoja (también de hoja en hoja) e imagen con marco.
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');
const { PDFDocument, StandardFonts, rgb, degrees, pushGraphicsState, popGraphicsState, setTextRenderingMode } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const dir = path.join(__dirname, 'pdfs');
fs.mkdirSync(dir, { recursive: true });
const guardar = async (nombre, doc) => fs.writeFileSync(path.join(dir, nombre), await doc.save());

const LOREM = 'El equipo revisó el proyecto con cuidado y propuso mejoras para la próxima etapa del trabajo, que empieza el mes que viene con nuevas tareas para todos.';

// texto en renglones de un ancho dado (para dibujar párrafos con pdf-lib)
function renglones(texto, fuente, tam, ancho) {
  const out = []; let l = '';
  for (const p of texto.split(' ')) { const t = l ? l + ' ' + p : p; if (fuente.widthOfTextAtSize(t, tam) > ancho && l) { out.push(l); l = p; } else l = t; }
  if (l) out.push(l);
  return out;
}

async function simple() {
  const d = await PDFDocument.create(), p = d.addPage([595, 842]);
  const h = await d.embedFont(StandardFonts.Helvetica), hb = await d.embedFont(StandardFonts.HelveticaBold);
  p.drawText('Informe mensual', { x: 60, y: 770, size: 18, font: hb });
  let y = 730;
  for (const t of [LOREM, 'Segundo párrafo: la reunión quedó para el jueves a las diez en la sala grande del primer piso.', LOREM]) {
    for (const l of renglones(t, h, 11, 470)) { p.drawText(l, { x: 60, y, size: 11, font: h }); y -= 14; }
    y -= 10;
  }
  await guardar('1-simple.pdf', d);
}

// LibreOffice: fuentes incrustadas y recortadas (con códigos propios), y una tabla de verdad
function libreoffice(nombre, html) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfpro-')), f = path.join(tmp, nombre + '.html');
  fs.writeFileSync(f, '<html><head><meta charset="utf-8"></head><body>' + html + '</body></html>');
  execFileSync('soffice', ['--headless', '--convert-to', 'pdf:writer_web_pdf_Export', '--outdir', tmp, f], { stdio: 'ignore', timeout: 120000 });
  fs.copyFileSync(path.join(tmp, nombre + '.pdf'), path.join(dir, nombre + '.pdf'));
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function columnas() {
  const d = await PDFDocument.create(); d.registerFontkit(fontkit);
  const f = await d.embedFont(fs.readFileSync('/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf'), { subset: true });
  const p = d.addPage([595, 842]);
  p.drawText('Dos columnas', { x: 60, y: 780, size: 16, font: f });
  for (const [x, textos] of [[60, [LOREM, 'La columna izquierda sigue con otro párrafo corto.']], [320, ['La columna derecha tiene su propio texto, que no se mezcla con el de la izquierda.', LOREM]]]) {
    let y = 740;
    for (const t of textos) { for (const l of renglones(t, f, 10.5, 215)) { p.drawText(l, { x, y, size: 10.5, font: f }); y -= 13.5; } y -= 9; }
  }
  await guardar('4-columnas.pdf', d);
}

// Texto partido: cada palabra (y a veces cada letra) en su propia orden, viñetas separadas de su texto
async function partido() {
  const d = await PDFDocument.create(), p = d.addPage([595, 842]), h = await d.embedFont(StandardFonts.Helvetica);
  let y = 760;
  for (const l of renglones(LOREM, h, 11, 470)) {
    let x = 60;
    for (const w of l.split(' ')) {
      if (w.length > 6) for (const c of w) { p.drawText(c, { x, y, size: 11, font: h }); x += h.widthOfTextAtSize(c, 11); }
      else { p.drawText(w, { x, y, size: 11, font: h }); x += h.widthOfTextAtSize(w, 11); }
      x += h.widthOfTextAtSize(' ', 11);
    }
    y -= 14;
  }
  y -= 12;
  for (const t of ['Primera tarea de la lista', 'Segunda tarea de la lista']) { p.drawText('•', { x: 60, y, size: 11, font: h }); p.drawText(t, { x: 75, y, size: 11, font: h }); y -= 15; }
  await guardar('5-partido.pdf', d);
}

async function tapado() {
  const d = await PDFDocument.create(), p = d.addPage([595, 842]);
  const h = await d.embedFont(StandardFonts.Helvetica), hb = await d.embedFont(StandardFonts.HelveticaBold), c = await d.embedFont(StandardFonts.Courier);
  p.drawText('Folio Nº 888568', { x: 60, y: 780, size: 14, font: hb });
  p.drawRectangle({ x: 55, y: 775, width: 300, height: 20, color: rgb(1, 1, 1) });
  p.drawText('Folio Nº 211545', { x: 60, y: 780, size: 14, font: hb });
  p.drawText('#.274185.161853.#', { x: 60, y: 700, size: 20, font: c });
  p.pushOperators(pushGraphicsState(), setTextRenderingMode(3));
  p.drawText('TEXTO INVISIBLE', { x: 300, y: 600, size: 10, font: h });
  p.pushOperators(popGraphicsState());
  p.drawText('Un párrafo normal que se puede editar.', { x: 60, y: 560, size: 11, font: h });
  await guardar('6-tapado.pdf', d);
}

async function desborde() {
  const d = await PDFDocument.create(), p = d.addPage([595, 842]), h = await d.embedFont(StandardFonts.Helvetica);
  p.drawText('Título de la hoja', { x: 60, y: 780, size: 12, font: h });
  for (let i = 0; i < 50; i++) p.drawText('Renglón ' + i + ' de un párrafo largo que sigue hasta el final de la hoja.', { x: 60, y: 740 - i * 13.6, size: 11, font: h });
  d.addPage([595, 842]).drawText('Segunda hoja.', { x: 60, y: 780, size: 12, font: h });
  await guardar('7-desborde.pdf', d);
}

// 3 hojas con encabezado y pie: las dos primeras llenas de párrafos, la tercera con uno solo (texto que pasa de hoja en hoja)
async function cascada() {
  const d = await PDFDocument.create(), h = await d.embedFont(StandardFonts.Helvetica);
  let k = 0;
  for (let n = 1; n <= 3; n++) {
    const p = d.addPage([595, 842]);
    p.drawText('Encabezado de prueba', { x: 60, y: 810, size: 8, font: h });
    p.drawText('Página ' + n, { x: 280, y: 30, size: 8, font: h });
    let y = 760;
    for (let j = 0; j < (n < 3 ? 99 : 1); j++) {
      const ls = renglones(`Párrafo ${++k}. ${LOREM}`, h, 11, 470);
      if (y - (ls.length - 1) * 14 < 75) break;
      for (const l of ls) { p.drawText(l, { x: 60, y, size: 11, font: h }); y -= 14; }
      y -= 10;
    }
  }
  await guardar('11-cascada.pdf', d);
}

// Firmado digitalmente (firma de mentira, visible: "FIRMADO") + una hoja en blanco: copia editable, censurar, numerar, quitar blancas
async function firmado() {
  const { PDFName, PDFHexString, PDFString } = require('pdf-lib');
  const d = await PDFDocument.create(), pg = d.addPage([595, 842]), f = await d.embedFont(StandardFonts.Helvetica), ctx = d.context;
  pg.drawText('Contrato de prueba.', { x: 60, y: 780, size: 14, font: f });
  pg.drawText('Segundo renglón que queda.', { x: 60, y: 740, size: 12, font: f });
  const ap = ctx.register(ctx.stream('0.9 0.9 1 rg 0 0 200 60 re f BT /F1 14 Tf 0 0 0.6 rg 20 25 Td (FIRMADO) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 60], Resources: { Font: { F1: f.ref } } }));
  const sig = ctx.register(ctx.obj({ Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached', Contents: PDFHexString.of('00'), ByteRange: [0, 0, 0, 0] }));
  const w = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of('Firma1'), V: sig, Rect: [100, 600, 300, 660], F: 4, P: pg.ref, AP: { N: ap } }));
  pg.node.set(PDFName.of('Annots'), ctx.obj([w]));
  d.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: [w], SigFlags: 3 }));
  d.catalog.set(PDFName.of('Perms'), ctx.obj({ DocMDP: sig }));
  d.addPage([595, 842]);
  d.addPage([595, 842]).drawText('Tercera hoja.', { x: 60, y: 780, size: 12, font: f });
  await guardar('12-firmado.pdf', d);
}

// Planilla de asistencia (como las de la obra social): 10 filas iguales para probar "Repetir hacia abajo"
async function asistencia() {
  const d = await PDFDocument.create(), p = d.addPage([595, 842]), h = await d.embedFont(StandardFonts.Helvetica);
  p.drawText('PLANILLA DE ASISTENCIA MENSUAL', { x: 150, y: 790, size: 13, font: h });
  for (let i = 0; i < 10; i++) {
    const y = 700 - i * 25.5;
    p.drawText(`Nro ${i + 1}`, { x: 50, y, size: 9, font: h });
    p.drawText('--/--/----', { x: 110, y, size: 9, font: h });
    p.drawText('Desde........hs', { x: 200, y, size: 9, font: h });
    p.drawText('Hasta........hs', { x: 320, y, size: 9, font: h });
  }
  await guardar('13-asistencia.pdf', d);
}

async function imagen() {
  const d = await PDFDocument.create(), p = d.addPage([595, 842]), h = await d.embedFont(StandardFonts.Helvetica);
  // PNG de 1 punto azul (sin depender de otras herramientas)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgaPgPAAKFAYE0Yk7bAAAAAElFTkSuQmCC', 'base64');
  const img = await d.embedPng(png);
  p.drawText('Texto arriba de la imagen.', { x: 60, y: 780, size: 12, font: h });
  p.drawRectangle({ x: 57, y: 597, width: 206, height: 126, color: rgb(0.8, 0.8, 0.8) }); // marco gris
  p.drawImage(img, { x: 60, y: 600, width: 200, height: 120 });
  await guardar('8-imagen.pdf', d);
}

// Hoja girada (/Rotate 90): el texto está dibujado de costado para que se lea derecho en pantalla
async function girada() {
  const d = await PDFDocument.create(), p = d.addPage([595, 842]), h = await d.embedFont(StandardFonts.Helvetica);
  p.setRotation(degrees(90));
  let x = 80; // en pantalla: renglones que bajan = x que crece
  for (const t of ['Hoja apaisada de prueba', LOREM, 'La reunión quedó para el jueves a las diez en la sala grande.']) {
    for (const l of renglones(t, h, 11, 700)) { p.drawText(l, { x, y: 60, size: 11, font: h, rotate: degrees(90) }); x += 14; }
    x += 10;
  }
  await guardar('9-girada.pdf', d);
}
// Hoja recortada: el recuadro visible (CropBox) no empieza en 0,0
async function recortada() {
  const d = await PDFDocument.create(), p = d.addPage([700, 950]), h = await d.embedFont(StandardFonts.Helvetica);
  p.setCropBox(50, 60, 595, 842);
  let y = 840;
  for (const t of ['Hoja recortada de prueba', LOREM, 'La reunión quedó para el jueves a las diez en la sala grande.']) {
    for (const l of renglones(t, h, 11, 470)) { p.drawText(l, { x: 110, y, size: 11, font: h }); y -= 14; }
    y -= 10;
  }
  await guardar('10-recortada.pdf', d);
}

(async () => {
  if (process.argv[2] === 'asistencia') { await asistencia(); return console.log('Listo'); }
  if (process.argv[2] === 'firmado') { await firmado(); return console.log('Listo'); }
  if (process.argv[2] === 'cascada') { await cascada(); return console.log('Listo'); }
  if (process.argv[2] === 'lugar') { await girada(); await recortada(); return console.log('Listo'); }
  await simple();
  libreoffice('2-fuentes', `<h1 style="font-family:'Liberation Serif'">Acta de la reunión</h1>
    <p style="font-family:'Liberation Serif';font-size:12pt">${LOREM}</p>
    <p style="font-family:'Liberation Sans';font-size:11pt"><b>Importante:</b> la próxima reunión es el lunes y hay que llevar la documentación completa.</p>`);
  libreoffice('3-tablas', `<p style="font-family:'Liberation Sans'">Lista de precios del trimestre:</p>
    <table border="1" cellpadding="4" style="font-family:'Liberation Sans';font-size:10pt"><tr><th>Producto</th><th>Cantidad</th><th>Precio</th></tr>
    <tr><td>Cuaderno rayado</td><td>12</td><td>4500</td></tr><tr><td>Lapicera azul</td><td>30</td><td>900</td></tr><tr><td>Carpeta oficio</td><td>8</td><td>2100</td></tr></table>
    <p style="font-family:'Liberation Sans'">Los precios pueden cambiar sin aviso previo según el proveedor.</p>`);
  await columnas(); await partido(); await tapado(); await desborde(); await imagen(); await girada(); await recortada(); await cascada(); await firmado(); await asistencia();
  console.log('Listo:', fs.readdirSync(dir).join(', '));
})();
