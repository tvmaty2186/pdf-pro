// Prueba de herramientas/planillas/planilla.cjs con una planilla inventada (sin datos de nadie): dos hojas de 11 filas,
// marzo con un horario distinto los viernes, firma en cada fila. Se arma abril (con feriados) y se controla el resultado.
// Uso: node pruebas/planilla.cjs  (lo corre también npm test)
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfpro-planilla-'));
const herramienta = path.join(__dirname, '..', 'herramientas', 'planillas', 'planilla.cjs');

async function inventada() {
  const d = await PDFDocument.create(), h = await d.embedFont(StandardFonts.Helvetica), hb = await d.embedFont(StandardFonts.HelveticaBold);
  // "firma": un garabato en PNG (rojo sobre transparente), igual en todas las filas
  const firma = await d.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7GAAAAG0lEQVR4nGP4z8DwnwEJMDEwMDAwoAswoAoAAG8+Av1N0UkVAAAAAElFTkSuQmCC', 'base64'));
  const dias = []; for (let x = 1; x <= 31; x++) { const w = new Date(2026, 2, x).getDay(); if (w > 0 && w < 6) dias.push(x); }
  for (let hoja = 0; hoja < 2; hoja++) {
    const p = d.addPage([595, 842]);
    p.drawText('PLANILLA DE ASISTENCIA', { x: 180, y: 790, size: 14, font: hb });
    p.drawText('PERIODO (MES Y AÑO)', { x: 80, y: 740, size: 10, font: h });
    p.drawText('MARZO 2026', { x: 300, y: 742, size: 10, font: h });
    p.drawText('Transporte a', { x: 80, y: 700, size: 10, font: h });
    p.drawText('ESCUELA DE PRUEBA', { x: 160, y: 702, size: 8, font: h });
    const xs = { nro: 70, fecha: 130, ini: 215, fin: 295, km: 370, firma: 450 };
    p.drawText('Fecha', { x: xs.fecha + 8, y: 650, size: 10, font: h });
    p.drawText('Hora de Inicio', { x: xs.ini - 10, y: 650, size: 10, font: h });
    p.drawText('Hora de', { x: xs.fin, y: 656, size: 10, font: h }); p.drawText('Finalización', { x: xs.fin - 8, y: 644, size: 10, font: h });
    p.drawText('Kilómetros', { x: xs.km - 4, y: 650, size: 10, font: h });
    p.drawText('Firma', { x: xs.firma + 10, y: 650, size: 10, font: h });
    for (let i = 0; i < 11; i++) {
      const y = 610 - i * 26, n = hoja * 11 + i, dia = dias[n];
      p.drawLine({ start: { x: 60, y: y - 9 }, end: { x: 540, y: y - 9 }, thickness: 0.6, color: rgb(0.9, 0.5, 0.2) });
      p.drawText('Nro ' + (n + 1), { x: xs.nro, y, size: 9, font: h });
      p.drawText('--/--/----', { x: xs.fecha, y: y - 5, size: 10, font: h });
      p.drawText('Desde........hs', { x: xs.ini - 20, y: y - 5, size: 9, font: h });
      p.drawText('Hasta........hs', { x: xs.fin - 20, y: y - 5, size: 9, font: h });
      if (dia == null) continue;
      const vie = new Date(2026, 2, dia).getDay() === 5;
      p.drawText(String(dia).padStart(2, '0'), { x: xs.fecha + 1, y: y + 1, size: 10, font: h });
      p.drawText('03', { x: xs.fecha + 16, y: y + 1, size: 10, font: h });
      p.drawText('2026', { x: xs.fecha + 31, y: y + 1, size: 10, font: h });
      p.drawText('8:30', { x: xs.ini, y: y + 2, size: 9, font: h });
      p.drawText(vie ? '9:50' : '10:50', { x: xs.fin, y: y + 2, size: 9, font: h });
      p.drawText('19.2KM', { x: xs.km, y: y - 2, size: 9, font: h });
      p.drawImage(firma, { x: xs.firma, y: y - 14, width: 48, height: 36 });
    }
  }
  return d.save();
}

(async () => {
  const entrada = path.join(tmp, 'marzo.pdf'), salida = path.join(tmp, 'abril.pdf');
  fs.writeFileSync(entrada, await inventada());
  const correr = (...a) => execFileSync('node', [herramienta, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const errores = [];
  const r1 = correr('revisar', entrada);
  if (!/vie 8:30-9:50/.test(r1)) errores.push('no aprendió el horario de los viernes:\n' + r1);
  // abril 2026: 22 días de semana, menos el jueves 2 y el viernes 3 (feriados) = 20
  const r2 = correr('armar', entrada, '--mes', '2026-04', '--feriados', '2,3', '--salida', salida);
  if (!/\(20 días hábiles\)/.test(r2)) errores.push('no contó 20 días hábiles:\n' + r2);
  if (!/Control de la planilla nueva: todo en orden/.test(r2)) errores.push('el control de la planilla nueva avisó algo:\n' + r2);
  if (!/: 10\/04 vie {2}8:30 a 9:50/.test(r2)) errores.push('el viernes 10 no quedó 8:30 a 9:50:\n' + r2.split('\n').filter(l => /10\/04/.test(l)).join('\n'));
  if (!/Nro 21: vacía/.test(r2) || !/Nro 22: vacía/.test(r2)) errores.push('las filas que sobran no quedaron vacías');
  const r3 = correr('revisar', salida);
  if (!/ABRIL 2026/.test(r3)) errores.push('el encabezado no dice ABRIL 2026');
  if (!/20 con fecha/.test(r3)) errores.push('la planilla nueva no tiene 20 filas con fecha:\n' + r3);
  fs.rmSync(tmp, { recursive: true, force: true });
  if (errores.length) { console.log('✗ planilla-mensual: ' + errores.join('\n')); process.exit(1); }
  console.log('✓ planilla-mensual');
})().catch(e => { console.log('✗ planilla-mensual: ' + e.message); process.exit(1); });
