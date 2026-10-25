// PDF.Pro — convertir PDF a Word y Excel (sin Office) y Word/Excel/PowerPoint a PDF (con Office o LibreOffice instalado)
// Corre en el proceso principal. Lee el PDF con MuPDF y arma los .docx/.xlsx a mano (son XML comprimidos en zip).
const { zipSync, strToU8 } = require('fflate');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const esc = t => String(t).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hex = c => (c || [0, 0, 0]).map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
const COMUNES = ['Arial', 'Calibri', 'Cambria', 'Times New Roman', 'Verdana', 'Tahoma', 'Georgia', 'Garamond', 'Courier New', 'Segoe UI', 'Century Gothic', 'Trebuchet MS'];
function nombreFuente(f) {
  const n = f.getName().replace(/^[A-Z]{6}\+/, '').replace(/[-,](Bold|Italic|Oblique|Regular|Roman|BoldItalic|BoldOblique|MT|PSMT|PS).*$/i, '').replace(/MT$|PSMT$/, '');
  const comun = COMUNES.find(c => c.replace(/\s/g, '').toLowerCase() === n.replace(/\s/g, '').toLowerCase());
  return comun || (f.isMono() ? 'Courier New' : f.isSerif() && !/sans|syntax|arial|helvetica/i.test(n) ? 'Times New Roman' : 'Arial');
}
const colorRGB = c => !c ? [0, 0, 0] : c.length === 1 ? [c[0], c[0], c[0]] : c.length === 4 ? [0, 1, 2].map(i => (1 - c[i]) * (1 - c[3])) : c.slice(0, 3);

// Imagen de MuPDF → PNG (con su transparencia: en el PDF la máscara va aparte)
function aPng(m, img) {
  const px = img.toPixmap().convertToColorSpace(m.ColorSpace.DeviceRGB, false);
  const mascara = img.getMask()?.toPixmap();
  if (!mascara) return { png: px.asPNG(), ancho: px.getWidth(), alto: px.getHeight() };
  // se copian los píxeles antes de crear otra imagen: al pedir memoria nueva, MuPDF invalida las vistas anteriores
  const w = px.getWidth(), h = px.getHeight(), p = px.getPixels().slice(), mw = mascara.getWidth(), mh = mascara.getHeight(), mp = mascara.getPixels().slice(), mn = mp.length / (mw * mh);
  const sal = new m.Pixmap(m.ColorSpace.DeviceRGB, [0, 0, w, h], true), q = sal.getPixels();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3, o = (y * w + x) * 4;
    q[o] = p[i]; q[o + 1] = p[i + 1]; q[o + 2] = p[i + 2]; q[o + 3] = mp[(Math.floor(y * mh / h) * mw + Math.floor(x * mw / w)) * mn];
  }
  return { png: sal.asPNG(), ancho: w, alto: h };
}

// Lee una página: bloques de texto (renglones → pedazos con el mismo estilo, y huecos) e imágenes, en coordenadas de MuPDF (y hacia abajo)
function leerPagina(m, pg) {
  const bloques = [];
  let bloque = null, linea = null, finAnterior = null;
  pg.toStructuredText('preserve-images').walk({
    onImageBlock(bbox, _t, img) { try { bloques.push({ tipo: 'imagen', bbox, ...aPng(m, img) }); } catch { bloques.push({ tipo: 'imagen', bbox, falla: true }); } },
    beginTextBlock(bbox) { bloque = { tipo: 'texto', bbox, lineas: [] }; },
    beginLine(bbox, wmode) { linea = { bbox, partes: [], saltar: !!wmode }; finAnterior = null; },
    onChar(c, origen, f, tam, q, color) {
      if (linea.saltar) return;
      const x0 = Math.min(q[0], q[4]), x1 = Math.max(q[2], q[6]);
      if (finAnterior != null && x0 - finAnterior > tam * 0.6 && c !== ' ') linea.partes.push({ hueco: x0 - finAnterior, tam });
      const estilo = { fuente: nombreFuente(f), tam: Math.round(tam * 2) / 2, negrita: f.isBold(), cursiva: f.isItalic(), color: hex(colorRGB(color)) };
      const ult = linea.partes[linea.partes.length - 1], raya = c === '_';
      // la raya de completar "____" va en un pedazo aparte (así un dato escrito encima puede ir en su lugar)
      const cambiaRaya = ult && !ult.hueco && c !== ' ' && raya !== /_\s*$/.test(ult.texto) && /\S/.test(ult.texto);
      if (ult && !ult.hueco && !cambiaRaya && ult.fuente === estilo.fuente && ult.tam === estilo.tam && ult.negrita === estilo.negrita && ult.cursiva === estilo.cursiva && ult.color === estilo.color) { ult.texto += c; ult.x1 = Math.max(ult.x1, x1); }
      else linea.partes.push({ ...estilo, texto: c, x: x0, x1, base: origen[1], corte: cambiaRaya });
      if (c !== ' ') finAnterior = x1;
    },
    endLine() { if (!linea.saltar && linea.partes.length) bloque.lineas.push(linea); },
    endTextBlock() { if (bloque.lineas.length) bloques.push(bloque); }
  });
  return bloques;
}

// ---------- PDF → Word ----------
// Respeta el diseño: cada pedazo de texto va en un recuadro fijo en su lugar de la hoja y las imágenes (firmas, sellos,
// logos) flotando en su posición. Así un formulario queda igual y se puede editar.
const ANCHO_RAYA = 0.556; // ancho del "_" en Arial, en tamaños de letra
function partesDePagina(bloques) {
  const partes = [];
  for (const b of bloques) if (b.tipo === 'texto') for (const l of b.lineas) {
    let x = null;
    for (const p of l.partes) {
      if (p.hueco) { x = null; continue; }
      const ult = partes[partes.length - 1];
      if (x != null && ult && ult.base === p.base && !p.corte) { ult.runs.push(p); ult.x1 = p.x1; continue; }
      partes.push({ x: p.x, x1: p.x1, base: p.base, tam: p.tam, runs: [p] });
      x = p.x;
    }
  }
  return partes;
}
function pdfAWord(m, doc) {
  const imagenes = [], cuerpo = [], MARGEN = 20;
  const n = doc.countPages();
  let ancho = 595, alto = 842, idDibujo = 1;
  const run = p => `<w:r><w:rPr><w:rFonts w:ascii="${esc(p.fuente)}" w:hAnsi="${esc(p.fuente)}" w:cs="${esc(p.fuente)}"/>${p.negrita ? '<w:b/>' : ''}${p.cursiva ? '<w:i/>' : ''}` +
    `<w:color w:val="${p.color}"/><w:sz w:val="${Math.round(p.tam * 2)}"/></w:rPr><w:t xml:space="preserve">${esc(p.texto)}</w:t></w:r>`;
  const emu = v => Math.round(v * 12700), tw = v => Math.max(0, Math.round(v * 20));
  for (let i = 0; i < n; i++) {
    const pg = doc.loadPage(i), [x0, y0, x1, y1] = pg.getBounds();
    if (i === 0) { ancho = x1 - x0; alto = y1 - y0; }
    const bloques = leerPagina(m, pg), hayTexto = bloques.some(b => b.tipo === 'texto' && b.lineas.some(l => l.partes.some(p => p.texto?.trim())));
    // en un escaneo con texto reconocido va solo el texto (la foto de la hoja no sirve para editar);
    // una hoja sin nada de texto (escaneo sin reconocer) va entera como imagen
    let imgs = bloques.filter(b => b.tipo === 'imagen' && !(hayTexto && (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]) > (x1 - x0) * (y1 - y0) * 0.8));
    if (!hayTexto) imgs = [{ bbox: [x0, y0, x1, y1], falla: true }];
    // imágenes que MuPDF no pudo sacar tal cual (por ejemplo JPEG 2000 raros): se recortan de la hoja dibujada
    if (imgs.some(b => b.falla)) {
      const foto = pg.toPixmap(m.Matrix.scale(2, 2), m.ColorSpace.DeviceRGB, false), fw = foto.getWidth(), fh = foto.getHeight(), fp = foto.getPixels().slice();
      const [fx, fy] = foto.getBounds();
      for (const b of imgs.filter(b => b.falla)) {
        const xa = Math.max(0, Math.floor(b.bbox[0] * 2 - fx)), ya = Math.max(0, Math.floor(b.bbox[1] * 2 - fy));
        const w = Math.max(1, Math.min(fw - xa, Math.ceil((b.bbox[2] - b.bbox[0]) * 2))), h = Math.max(1, Math.min(fh - ya, Math.ceil((b.bbox[3] - b.bbox[1]) * 2)));
        const rec = new m.Pixmap(m.ColorSpace.DeviceRGB, [0, 0, w, h], false), q = rec.getPixels();
        for (let y = 0; y < h; y++) q.set(fp.subarray(((ya + y) * fw + xa) * 3, ((ya + y) * fw + xa + w) * 3), y * w * 3);
        b.png = rec.asPNG();
      }
    }
    // texto tapado (por ejemplo, datos viejos cubiertos con un rectángulo blanco): en la hoja dibujada no se ve, así que no va
    const foto = pg.toPixmap(m.Matrix.identity, m.ColorSpace.DeviceRGB, false), fw = foto.getWidth(), fh = foto.getHeight(), fp = foto.getPixels().slice();
    const [fx, fy] = foto.getBounds();
    const seVe = p => {
      const xa = Math.max(0, Math.floor(p.x - fx)), xb = Math.min(fw - 1, Math.ceil(p.x1 - fx)), ya = Math.max(0, Math.floor(p.base - p.tam * 0.75 - fy)), yb = Math.min(fh - 1, Math.ceil(p.base - fy));
      for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) { const i = (y * fw + x) * 3; if (fp[i] + fp[i + 1] + fp[i + 2] < 700) return true; }
      return false;
    };
    // si dos textos distintos quedan uno encima del otro, se ve el último que se dibujó: el de abajo no va
    const partes = partesDePagina(bloques).filter(seVe).filter((p, k, todas) => !todas.some((q, j) => j > k && !/^[_\s]+$/.test(q.runs.map(r => r.texto).join('')) &&
      !/^[_\s]+$/.test(p.runs.map(r => r.texto).join('')) && Math.min(p.x1, q.x1) - Math.max(p.x, q.x) > Math.min(p.x1 - p.x, q.x1 - q.x) * 0.5 && Math.abs(p.base - q.base) < Math.min(p.tam, q.tam) * 0.6 && p.runs.map(r => r.texto).join('').trim().length > 3 && q.runs.map(r => r.texto).join('').trim().length > 3));
    // las imágenes van ancladas al primer párrafo de la página, en su lugar exacto
    const anclas = imgs.map(b => {
      const k = imagenes.length + 1, w = emu(b.bbox[2] - b.bbox[0]), h = emu(b.bbox[3] - b.bbox[1]), id = idDibujo++;
      imagenes.push(b.png);
      return `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${id}" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">` +
        `<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>${emu(b.bbox[0] - x0)}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>${emu(b.bbox[1] - y0)}</wp:posOffset></wp:positionV>` +
        `<wp:extent cx="${w}" cy="${h}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="${id}" name="Imagen ${k}"/><wp:cNvGraphicFramePr/>` +
        `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="imagen${k}.png"/><pic:cNvPicPr/></pic:nvPicPr>` +
        `<pic:blipFill><a:blip r:embed="rIdImg${k}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`;
    }).join('');
    // cada pedazo de texto va en un recuadro fijo en su lugar de la hoja (se ve igual y se puede editar)
    for (const p of partes) {
      for (const r of p.runs) if (/^_+\s*$/.test(r.texto)) r.texto = '_'.repeat(Math.max(1, Math.floor((r.x1 - r.x) / (r.tam * ANCHO_RAYA) * 0.97)));
      const arriba = p.base - p.tam * 0.95 - y0, ancho = Math.max(8, (p.x1 - p.x) * 1.15 + 4);
      cuerpo.push(`<w:p><w:pPr><w:framePr w:w="${tw(Math.min(ancho, x1 - p.x - 2))}" w:hRule="auto" w:x="${tw(p.x - x0 - 1)}" w:y="${tw(arriba)}" w:hAnchor="page" w:vAnchor="page" w:wrap="notBeside"/>` +
        `<w:spacing w:before="0" w:after="0" w:line="${tw(p.tam * 1.15)}" w:lineRule="exact"/><w:ind w:left="0" w:right="0"/></w:pPr>${p.runs.map(run).join('')}</w:p>`);
    }
    // párrafo común que cierra la hoja: los recuadros de arriba se apoyan en él y lleva las imágenes; el salto va antes de la hoja siguiente
    cuerpo.push(`<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr>${anclas}</w:p>`);
    if (i < n - 1) cuerpo.push('<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr><w:r><w:br w:type="page"/></w:r></w:p>');
  }
  const documento = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${cuerpo.join('')}<w:sectPr><w:pgSz w:w="${tw(ancho)}" w:h="${tw(alto)}"/><w:pgMar w:top="${tw(MARGEN)}" w:right="${tw(MARGEN)}" w:bottom="${tw(MARGEN)}" w:left="${tw(MARGEN)}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const archivos = {
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8(documento),
    'word/_rels/document.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      imagenes.map((_, k) => `<Relationship Id="rIdImg${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/imagen${k + 1}.png"/>`).join('') + '</Relationships>')
  };
  imagenes.forEach((png, k) => { archivos[`word/media/imagen${k + 1}.png`] = png; });
  return zipSync(archivos);
}

// ---------- PDF → Excel ----------
// Cada página es una hoja. Los textos se ordenan en filas (misma altura) y columnas (mismo comienzo a la izquierda).
const letra = k => { let s = ''; for (k++; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + (k - 1) % 26) + s; return s; };
function numero(t) {
  const s = t.replace(/^\$\s*/, '').trim();
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s) || /^-?\d+,\d+$/.test(s)) return +s.replace(/\./g, '').replace(',', '.');
  if (/^-?\d+$/.test(s) && s.length < 12 && !/^0\d/.test(s)) return +s;
  return null;
}
function pdfAExcel(m, doc) {
  const hojas = [];
  for (let i = 0; i < doc.countPages(); i++) {
    const celdas = [];
    for (const b of leerPagina(m, doc.loadPage(i))) {
      if (b.tipo !== 'texto') continue;
      for (const l of b.lineas) {
        let actual = null;
        for (const p of l.partes) {
          if (p.hueco) { actual = null; continue; }
          const texto = p.texto.replace(/_{2,}/g, ' ').trim();
          if (!actual) { actual = { texto: '', x: p.x, base: p.base, tam: p.tam }; celdas.push(actual); }
          actual.texto = (actual.texto + ' ' + texto).trim();
        }
      }
    }
    const llenas = celdas.filter(c => c.texto);
    // filas: textos con la línea de base a la misma altura
    llenas.sort((a, b) => a.base - b.base);
    const filas = [];
    for (const c of llenas) { const f = filas.find(f => Math.abs(f.base - c.base) < Math.max(3, c.tam * 0.5)); if (f) f.celdas.push(c); else filas.push({ base: c.base, celdas: [c] }); }
    // columnas: comienzos a la izquierda parecidos
    const xs = [...llenas.map(c => c.x)].sort((a, b) => a - b), cols = [];
    for (const x of xs) if (!cols.length || x - cols[cols.length - 1] > 8) cols.push(x);
    const col = x => { let k = 0; while (k + 1 < cols.length && cols[k + 1] <= x + 4) k++; return k; };
    const filasXml = filas.map((f, r) => {
      const porCol = new Map();
      for (const c of f.celdas.sort((a, b) => a.x - b.x)) { const k = col(c.x); porCol.set(k, porCol.has(k) ? porCol.get(k) + ' ' + c.texto : c.texto); }
      return `<row r="${r + 1}">` + [...porCol.entries()].sort((a, b) => a[0] - b[0]).map(([k, t]) => {
        const ref = letra(k) + (r + 1), v = numero(t);
        return v != null ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(t)}</t></is></c>`;
      }).join('') + '</row>';
    });
    const anchos = cols.map((x, k) => Math.max(8, Math.min(60, Math.round(((cols[k + 1] ?? x + 120) - x) / 5.5))));
    hojas.push(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      (anchos.length ? `<cols>${anchos.map((w, k) => `<col min="${k + 1}" max="${k + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '') +
      `<sheetData>${filasXml.join('')}</sheetData></worksheet>`);
  }
  const archivos = {
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      hojas.map((_, k) => `<Override PartName="/xl/worksheets/hoja${k + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      hojas.map((_, k) => `<sheet name="Página ${k + 1}" sheetId="${k + 1}" r:id="rId${k + 1}"/>`).join('') + '</sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      hojas.map((_, k) => `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/hoja${k + 1}.xml"/>`).join('') + '</Relationships>')
  };
  hojas.forEach((h, k) => { archivos[`xl/worksheets/hoja${k + 1}.xml`] = strToU8(h); });
  return zipSync(archivos);
}

// ---------- Word, Excel, PowerPoint → PDF ----------
// Usa Microsoft Office si está instalado (Windows); si no, LibreOffice. Devuelve los bytes del PDF.
const correr = (cmd, args, ms = 180000, env = null) => new Promise(res => execFile(cmd, args, { timeout: ms, windowsHide: true, maxBuffer: 1 << 20, ...(env ? { env: { ...process.env, ...env } } : {}) }, e => res(!e)));
async function officeAPdf(entrada) {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pdfpro-conv-'));
  try {
    const salida = path.join(tmp, path.basename(entrada).replace(/\.[^.]+$/, '') + '.pdf');
    // las rutas van en variables de entorno, no dentro del comando: un nombre con comillas raras (D’Angelo) no lo rompe
    const ext = path.extname(entrada).toLowerCase(), env = { PDFPRO_ENTRADA: entrada, PDFPRO_SALIDA: salida };
    if (process.platform === 'win32') {
      let ps = null;
      if (['.doc', '.docx', '.odt', '.rtf', '.txt'].includes(ext))
        ps = `$a=New-Object -ComObject Word.Application; $a.Visible=$false; $a.DisplayAlerts=0; try { $d=$a.Documents.Open($env:PDFPRO_ENTRADA,$false,$true); $d.ExportAsFixedFormat($env:PDFPRO_SALIDA,17); $d.Close(0) } finally { $a.Quit() }`;
      else if (['.xls', '.xlsx', '.ods', '.csv'].includes(ext))
        ps = `$a=New-Object -ComObject Excel.Application; $a.Visible=$false; $a.DisplayAlerts=$false; try { $b=$a.Workbooks.Open($env:PDFPRO_ENTRADA,0,$true); $b.ExportAsFixedFormat(0,$env:PDFPRO_SALIDA); $b.Close($false) } finally { $a.Quit() }`;
      else if (['.ppt', '.pptx', '.odp'].includes(ext))
        ps = `$a=New-Object -ComObject PowerPoint.Application; try { $p=$a.Presentations.Open($env:PDFPRO_ENTRADA,$true,$false,$false); $p.SaveAs($env:PDFPRO_SALIDA,32); $p.Close() } finally { $a.Quit() }`;
      if (ps && await correr('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 180000, env) && fs.existsSync(salida)) return fs.promises.readFile(salida);
    }
    const libre = process.platform === 'win32'
      ? ['C:\\Program Files\\LibreOffice\\program\\soffice.exe', 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'].find(f => fs.existsSync(f))
      : 'soffice';
    if (libre && await correr(libre, ['--headless', '--convert-to', 'pdf', '--outdir', tmp, entrada]) && fs.existsSync(salida)) return fs.promises.readFile(salida);
    throw new Error('Para pasar este archivo a PDF hace falta tener instalado Microsoft Office o LibreOffice (es gratis).');
  } finally { fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
}

module.exports = { pdfAWord, pdfAExcel, officeAPdf };
