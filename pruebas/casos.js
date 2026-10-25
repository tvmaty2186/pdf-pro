// Casos de prueba. Cada uno: el PDF (de pruebas/pdfs), el código que corre dentro del programa (devuelve un resultado)
// y revisar(resultado) → null si está bien o el texto del error.

// Ayudas que tiene cada caso adentro del programa
const AYUDA = `
const w = ms => new Promise(r => setTimeout(r, ms));
const P = () => pdfproPrueba.estado.pestanas[0];
const errores = []; const _err = console.error; console.error = (...a) => { errores.push(a.map(String).join(' ')); _err(...a); };
async function editar() { pdfproPrueba.edicion.activar(); for (let i = 0; i < 60 && !document.querySelector('.ed-bloque'); i++) await w(250); await w(1200); }
function buscar(texto) {
  for (const r of document.querySelectorAll('.ed-texto')) {
    const tw = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) { const i = n.textContent.indexOf(texto); if (i >= 0) return { n, i }; }
  }
  return null;
}
function seleccionar(n, a, z) { (n.parentElement.closest('.ed-texto') || document.querySelector('.ed-texto')).focus(); const g = document.createRange(); g.setStart(n, a); g.setEnd(n, z); const s = getSelection(); s.removeAllRanges(); s.addRange(g); }
function reemplazar(viejo, nuevo) { const x = buscar(viejo); if (!x) throw new Error('No encontré "' + viejo + '"'); seleccionar(x.n, x.i, x.i + viejo.length); document.execCommand('insertText', false, nuevo); }
async function terminar() { await pdfproPrueba.edicion.terminar(); await w(1500); }
async function parrafos(n = 1, datos = P().datos) { return (await window.pdfpro.paginaParrafos(datos, n)).parrafos; }
async function palabras(n = 1, datos = P().datos) { return (await parrafos(n, datos)).flatMap(x => x.lineas.flatMap(l => l.palabras.map(p => p.t))); }
// rect en "hoja derecha" → puntos del PDF (como src/lugar.js)
function rectAPdf(m, [x0, y0, x1, y1]) { const p = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]); const xs = p.map(q => q[0]), ys = p.map(q => q[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; }
// todos los textos de la hoja (también los que no son párrafos editables)
// los renglones de la hoja, de arriba hacia abajo, con su altura (y) en puntos del PDF
async function renglones(n = 1, datos = P().datos) { return (await window.pdfpro.paginaContenido(datos, n)).lineas.sort((a, b) => b.base[1] - a.base[1] || a.base[0] - b.base[0]).map(l => ({ t: l.texto, y: Math.round(l.base[1]) })); }
async function textos(n = 1, datos = P().datos) { return (await parrafos(n, datos)).map(x => x.lineas.map(l => l.texto).join(' ')); }
`;

// Cambiar una palabra por otra del mismo largo: lo demás de la hoja tiene que quedar igual (mismas palabras y el
// dibujo solo cambia en ese párrafo)
const cambiarPalabra = (nombre, pdf, viejo, nuevo) => ({
  nombre, pdf,
  js: `await editar();
    const antes = await palabras();
    reemplazar(${JSON.stringify(viejo)}, ${JSON.stringify(nuevo)}); await w(500);
    await terminar();
    const despues = await palabras(), rp = await window.pdfpro.paginaParrafos(P().datos, 1);
    const par = rp.parrafos.find(x => x.lineas.some(l => l.texto.includes(${JSON.stringify(nuevo)})));
    const comp = await window.pdfpro.compararDocumentos(P().abierto.datos, P().datos);
    return { antes, despues, rect: par && rectAPdf(rp.lugar.m, par.rect), zonas: comp.hojas.flatMap(h => h.cajas), hojas: comp.hojas.map(h => h.n), errores };`,
  revisar(r) {
    const norm = a => [...a].sort().join('|');
    const esperado = [...r.antes];
    const i = esperado.findIndex(p => p.includes(viejo));
    if (i < 0) return 'la palabra no estaba al principio';
    esperado[i] = esperado[i].replace(viejo, nuevo);
    if (norm(esperado) !== norm(r.despues)) {
      const falta = esperado.filter(p => !r.despues.includes(p)), sobra = r.despues.filter(p => !esperado.includes(p));
      return `las palabras no coinciden. Faltan: ${falta.join(' ')} · Sobran: ${sobra.join(' ')}`;
    }
    if (r.errores.some(e => /CONTROL/.test(e))) return 'el control interno avisó: ' + r.errores.find(e => /CONTROL/.test(e));
    if (!r.rect) return 'no encontré el párrafo editado';
    if (r.hojas.some(n => n !== 1)) return 'cambiaron otras hojas';
    const [x0, y0, x1, y1] = r.rect, m = 4;
    const fuera = r.zonas.filter(z => z[2] < x0 - m || z[0] > x1 + m || z[3] < y0 - m || z[1] > y1 + m);
    if (fuera.length) return 'cambió algo fuera del párrafo: ' + JSON.stringify(fuera);
    return null;
  }
});

const casos = [
  cambiarPalabra('simple', '1-simple.pdf', 'jueves', 'martes'),
  cambiarPalabra('fuentes-incrustadas', '2-fuentes.pdf', 'lunes', 'nunca'),
  cambiarPalabra('tablas', '3-tablas.pdf', 'proveedor', 'vendedora'),
  cambiarPalabra('columnas', '4-columnas.pdf', 'derecha', 'derecho'),
  cambiarPalabra('texto-partido', '5-partido.pdf', 'revisó', 'mostró'),
  cambiarPalabra('hoja-girada', '9-girada.pdf', 'jueves', 'martes'),
  cambiarPalabra('hoja-recortada', '10-recortada.pdf', 'jueves', 'martes'),
  {
    nombre: 'tapado-y-codigo-de-barras', pdf: '6-tapado.pdf',
    js: `const pars = await parrafos(); return pars.map(x => [x.reflow, x.lineas.map(l => l.texto).join(' ')]);`,
    revisar(r) {
      const editables = r.filter(x => x[0]).map(x => x[1]).join(' / ');
      if (/888568/.test(editables)) return 'muestra el número viejo que está tapado';
      if (/INVISIBLE/.test(editables)) return 'muestra texto invisible';
      if (/274185/.test(editables)) return 'el código de barras quedó editable';
      if (!/211545/.test(editables)) return 'no muestra el número que se ve';
      return null;
    }
  },
  {
    // lo que no entra sigue arriba de la hoja de abajo (como en Word) y lo que había ahí baja
    nombre: 'desborde-sigue-en-la-hoja-siguiente', pdf: '7-desborde.pdf', tiempo: 120000,
    js: `await editar();
      const x = buscar('Renglón 49'); const n = x.n; const fin = n.textContent.length;
      seleccionar(n, fin, fin); document.execCommand('insertText', false, ' y una frase bastante larga que agrega texto, y sigue agregando más texto todavía, renglón tras renglón, para que no entre y pase al otro lado de la hoja sin lugar');
      await w(800); await terminar();
      return { total: P().visor.total, hoja2: await renglones(2), errores };`,
    revisar(r) {
      if (r.total !== 2) return 'esperaba 2 hojas (sin hoja nueva) y hay ' + r.total;
      const t = r.hoja2.map(l => l.t).join(' / ');
      if (!t.includes('sin lugar')) return 'lo que sobró no está en la hoja de abajo: ' + t;
      if (!t.includes('Segunda hoja')) return 'lo que había en la hoja de abajo se perdió: ' + t;
      if (t.indexOf('sin lugar') > t.indexOf('Segunda hoja')) return 'lo nuevo tiene que ir arriba de lo que había: ' + t;
      if (r.errores.some(e => /CONTROL/.test(e))) return 'el control encontró diferencias: ' + r.errores.join(' | ');
      return null;
    }
  },
  {
    // la segunda vez que algo no entra, también sigue en la hoja de abajo, arriba de lo que llegó antes
    nombre: 'desborde-dos-veces', pdf: '7-desborde.pdf', tiempo: 180000,
    js: `const largo = ' y una frase bastante larga que agrega texto, y sigue agregando más texto todavía, renglón tras renglón, para que no entre y pase al otro lado de la hoja';
      await editar();
      let x = buscar('Renglón 49'); seleccionar(x.n, x.n.textContent.length, x.n.textContent.length); document.execCommand('insertText', false, largo + ' sin lugar');
      await w(800); await terminar(); await w(1500);
      await editar();
      x = buscar('Renglón 49'); seleccionar(x.n, x.n.textContent.length, x.n.textContent.length); document.execCommand('insertText', false, largo + ' otra vez');
      await w(800); await terminar();
      return { total: P().visor.total, hoja2: await renglones(2), errores };`,
    revisar(r) {
      if (r.total !== 2) return 'esperaba 2 hojas y hay ' + r.total;
      const t = r.hoja2.map(l => l.t).join(' / ');
      const a = t.indexOf('otra vez'), b = t.indexOf('sin lugar'), c = t.indexOf('Segunda hoja');
      if (a < 0 || b < 0 || c < 0) return 'falta algo en la hoja de abajo: ' + t;
      if (!(a < b && b < c)) return 'quedó en otro orden: ' + t;
      return null;
    }
  },
  {
    // en la última hoja no hay hoja de abajo: se agrega una; la vez siguiente sigue en esa
    nombre: 'desborde-en-la-ultima-hoja', pdf: '7-desborde.pdf', tiempo: 180000,
    js: `const largo = ' Una frase que se repite para llenar la hoja entera de texto corrido sin parar.'.repeat(80);
      const total = async esperado => { for (let i = 0; i < 40 && P().visor.total !== esperado; i++) await w(250); return P().visor.total; };
      P().visor.irAPagina(2); await w(1500); await editar();
      let x = buscar('Segunda hoja.'); seleccionar(x.n, x.n.textContent.length, x.n.textContent.length); document.execCommand('insertText', false, largo + ' FIN1');
      await w(800); await terminar();
      const total1 = await total(3);
      P().visor.irAPagina(2); await w(1500); await editar();
      x = buscar('Segunda hoja.'); seleccionar(x.n, x.i + 13, x.i + 13); document.execCommand('insertText', false, ' FIN2' + ' Esto se agrega al principio de la hoja dos y empuja todo.'.repeat(5));
      await w(800); await terminar(); await w(1500);
      const hojas = []; for (let n = 1; n <= P().visor.total; n++) hojas.push(await renglones(n));
      return { total1, total: P().visor.total, hojas, errores };`,
    revisar(r) {
      if (r.total1 !== 3) return 'la primera vez esperaba 3 hojas y hay ' + r.total1;
      if (r.total !== 3) return 'la segunda vez tenía que seguir en la hoja 3 (sin hoja nueva) y hay ' + r.total;
      const t = r.hojas.flat().map(l => l.t).join(' ');
      if (t.indexOf('FIN2') < 0 || t.indexOf('FIN1') < 0 || t.indexOf('FIN2') > t.indexOf('FIN1')) return 'falta texto o quedó desordenado';
      if (r.hojas.some(h => h.some(l => l.y < 50))) return 'quedó texto debajo del margen';
      return null;
    }
  },
  {
    // de hoja en hoja: lo que baja en la hoja 2 y no entra sigue en la 3. Encabezado y pie quedan donde están.
    nombre: 'desborde-en-cascada', pdf: '11-cascada.pdf', tiempo: 180000,
    js: `const antes = []; for (let n = 1; n <= 3; n++) antes.push(...(await renglones(n)).map(l => l.t));
      await editar();
      const p1 = (await renglones(1)).filter(l => /^Párrafo \\d+\\./.test(l.t)).at(-1).t.match(/^Párrafo \\d+\\./)[0];
      const x = buscar(p1); seleccionar(x.n, x.i + p1.length, x.i + p1.length);
      document.execCommand('insertText', false, ' Texto agregado que ocupa varios renglones para empujar todo hacia abajo, '.repeat(6));
      await w(800); await terminar();
      const hojas = []; for (let n = 1; n <= P().visor.total; n++) hojas.push(await renglones(n));
      return { total: P().visor.total, antes, hojas, errores };`,
    revisar(r) {
      if (r.total !== 3) return 'esperaba 3 hojas y hay ' + r.total;
      for (let i = 0; i < 3; i++) {
        const h = r.hojas[i];
        if (!h.some(l => l.t === 'Encabezado de prueba' && l.y > 800)) return 'el encabezado de la hoja ' + (i + 1) + ' se movió o se perdió';
        if (!h.some(l => l.t === 'Página ' + (i + 1) && l.y < 40)) return 'el pie de la hoja ' + (i + 1) + ' se movió o se perdió';
        if (h.some(l => l.y < 70 && !/^Página/.test(l.t))) return 'en la hoja ' + (i + 1) + ' hay texto debajo del margen';
      }
      const nums = r.hojas.flat().map(l => l.t.match(/Párrafo (\d+)\./)?.[1]).filter(Boolean).map(Number);
      const esperados = r.antes.map(t => t.match(/Párrafo (\d+)\./)?.[1]).filter(Boolean).map(Number);
      if (nums.join(',') !== esperados.join(',')) return 'los párrafos no quedaron todos y en orden: ' + nums.join(',') + ' (antes ' + esperados.join(',') + ')';
      if (r.hojas[2].filter(l => /Párrafo \d+\./.test(l.t)).length < 2) return 'no pasó nada a la hoja 3';
      return null;
    }
  },
  {
    nombre: 'mover-imagen-sin-cuadro-gris', pdf: '8-imagen.pdf',
    js: `await editar();
      const c = [...document.querySelectorAll('.ed-caja')].find(x => /Imagen/.test(x.title));
      c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); await w(500);
      [...document.querySelectorAll('.ed-barra button')].find(x => /Mover/.test(x.textContent)).click(); await w(4000);
      const f = P().firmas[0]; f.cx += 200; pdfproPrueba.firmas.redibujar(P()); await w(300);
      await editar(); await w(1000);
      const est = document.querySelector('.estampa'), hoja = document.querySelector('.ed-hoja');
      const visible = est && hoja && +getComputedStyle(est).zIndex > +getComputedStyle(hoja).zIndex;
      // ¿quedó algo dibujado donde estaba la imagen? (se dibuja la hoja sin la imagen movida)
      const comp = await window.pdfpro.compararDocumentos(P().abierto.datos, P().datos);
      return { firmas: P().firmas.length, visible, zonas: comp.hojas.flatMap(h => h.cajas) };`,
    revisar(r) {
      if (r.firmas !== 1) return 'la imagen no quedó para mover';
      if (!r.visible) return 'la imagen movida queda escondida debajo del modo documento';
      // donde estaba la imagen tiene que haber cambiado TODO el recuadro (imagen y marco gris se fueron)
      const z = r.zonas.find(z => z[0] <= 60 && z[2] >= 260 && z[1] <= 600 && z[3] >= 720);
      if (!z) return 'quedó algo del marco o de la imagen: ' + JSON.stringify(r.zonas);
      return null;
    }
  },
  {
    nombre: 'motor-se-cae-y-vuelve', pdf: '1-simple.pdf',
    js: `let error = null;
      try { await window.pdfpro.motorCaer(); } catch (e) { error = String(e.message); }
      const pars = await parrafos();
      return { error, pars: pars.length, ventana: !!document.querySelector('#area') };`,
    revisar(r) {
      if (!r.error || !/motor de PDF se cerró/.test(r.error)) return 'no avisó que el motor se cayó: ' + r.error;
      if (!r.pars) return 'después de caerse, el motor no volvió a andar';
      if (!r.ventana) return 'el programa no siguió';
      return null;
    }
  },
  {
    // cuentagotas: tocar un renglón copia su tamaño y color al cuadro de texto, y dice qué letra eligió
    nombre: 'cuentagotas-de-letra', pdf: '2-fuentes.pdf',
    js: `await w(1500);
      const p = P(), com = pdfproPrueba.comentarios;
      const { lineas } = await window.pdfpro.paginaContenido(p.datos, 1);
      const l = lineas.find(x => x.texto.length > 15);
      const c = { id: 'prueba', n: 1, tipo: 'texto', color: '#e53935', rect: [100, 100, 260, 120], tam: 30, nota: 'Hola', letra: 'mono' };
      com.ctx.cambiarComentarios(p, [c]);
      com.cuentagotas(c); await w(100);
      const pg = p.visor.paginas[0], v = pg.vista, [vx, vy] = v.convertToViewportPoint((l.rect[0] + l.rect[2]) / 2, (l.rect[1] + l.rect[3]) / 2);
      pg.div.scrollIntoView({ block: 'center' }); await w(300);
      const R2 = pg.div.getBoundingClientRect(), x2 = R2.left + vx * R2.width / v.width, y2 = R2.top + vy * R2.height / v.height;
      pg.div.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: x2, clientY: y2 }));
      for (let i = 0; i < 40 && P().comentarios[0].tam === 30; i++) await w(250);
      const r = P().comentarios[0];
      return { tam: r.tam, color: r.color, letra: r.letra, original: l.fuente, colorOriginal: l.color, aviso: document.querySelector('#aviso').textContent };`,
    revisar(r) {
      if (r.tam === 30) return 'no copió nada: ' + r.aviso;
      if (Math.abs(r.tam - r.original.size) > 1.5) return 'tamaño ' + r.tam + ' y el del PDF es ' + r.original.size;
      if (r.letra === 'mono' && r.original.family !== 'monospace') return 'la letra no cambió';
      if (!/Letra copiada|más parecida/.test(r.aviso)) return 'no avisó qué letra eligió: ' + r.aviso;
      return null;
    }
  },
  {
    // herramientas: copia editable de un PDF firmado, quitar la hoja en blanco, numerar y censurar (borra del archivo)
    nombre: 'herramientas-del-documento', pdf: '12-firmado.pdf', tiempo: 120000,
    js: `await w(2000);
      const boton = async t => { for (let i = 0; i < 40; i++) { const b = [...document.querySelectorAll('dialog[open] button')].find(x => x.textContent.startsWith(t)); if (b) { b.click(); return true; } await w(150); } return false; };
      const T = pdfproPrueba, A = () => T.estado.activa, firmasAntes = await window.pdfpro.firmasDigitales(A().datos);
      await T.copiaEditable(); await w(2500);
      const copia = { nombre: A().nombre, firmas: await window.pdfpro.firmasDigitales(A().datos), textos: await textos(1, A().datos) };
      T.quitarBlancas(); await boton('Sacarla'); await w(2500);
      const hojas = A().visor.total;
      T.numerarDoc(); await boton('Aplicar'); await w(2500);
      const num2 = (await renglones(2, A().datos)).map(l => l.t);
      const pg = A().visor.paginas[0], v = pg.vista, [x0, y0] = v.convertToViewportPoint(55, 800), [x1, y1] = v.convertToViewportPoint(320, 770);
      T.censurar(pg, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }); await boton('Borrar de verdad'); await w(2500);
      const tras = (await renglones(1, A().datos)).map(l => l.t);
      return { firmasAntes, copia, hojas, num2, tras, errores };`,
    revisar(r) {
      if (r.firmasAntes !== 1) return 'el PDF de prueba no se ve firmado';
      if (!/editable/.test(r.copia.nombre) || r.copia.firmas !== 0) return 'la copia editable sigue firmada: ' + JSON.stringify(r.copia);
      if (!r.copia.textos.join(' ').includes('FIRMADO')) return 'la firma no quedó dibujada en la copia';
      if (r.hojas !== 2) return 'esperaba 2 hojas sin la blanca y hay ' + r.hojas;
      if (!r.num2.includes('2')) return 'la hoja 2 no tiene su número: ' + r.num2.join(' / ');
      if (r.tras.some(t => t.includes('Contrato'))) return 'lo censurado sigue en el archivo';
      if (!r.tras.some(t => t.includes('Segundo renglón'))) return 'se borró de más: ' + r.tras.join(' / ');
      return null;
    }
  },
  {
    // Repetir hacia abajo: la fila 1 de la planilla se copia en las 9 de abajo, con las fechas en los días de sesión (mar y jue)
    nombre: 'repetir-hacia-abajo', pdf: '13-asistencia.pdf',
    js: `await w(1500);
      const p = P(), base = { n: 1, tipo: 'texto', auto: true, color: '#1a1a1a', tam: 9, letra: 'sans' };
      const fila = [{ ...base, id: 'f', rect: [112, 698, 160, 710], nota: '06/10/26' }, { ...base, id: 'd', rect: [228, 698, 254, 710], nota: '13:00' }, { ...base, id: 'h', rect: [348, 698, 374, 710], nota: '17:00' }];
      pdfproPrueba.comentarios.ctx.cambiarComentarios(p, fila);
      const listo = pdfproPrueba.repetir(fila[0]); await w(1200);
      const dlg = document.querySelector('dialog[open]'); const textoDlg = dlg.textContent;
      dlg.querySelector('input[value="4"]').checked = true; // jueves también
      [...dlg.querySelectorAll('button')].find(b => b.textContent === 'Repetir').click(); await listo; await w(500);
      const fechas = P().comentarios.filter(c => /\\//.test(c.nota)).sort((a, b) => b.rect[1] - a.rect[1]);
      return { textoDlg, total: P().comentarios.length, fechas: fechas.map(c => c.nota), ys: fechas.map(c => Math.round(c.rect[1])) };`,
    revisar(r) {
      if (!/Encontré 9 filas/.test(r.textoDlg)) return 'no detectó las 9 filas: ' + r.textoDlg;
      if (r.total !== 30) return 'esperaba 30 datos (10 filas × 3) y hay ' + r.total;
      if (r.fechas.slice(0, 5).join(' ') !== '06/10/26 08/10/26 13/10/26 15/10/26 20/10/26') return 'fechas mal: ' + r.fechas.join(' ');
      if (Math.abs((r.ys[0] - r.ys[1]) - 25.5) > 0.6) return 'la distancia entre filas no es la de la tabla: ' + r.ys.join(',');
      return null;
    }
  },
  {
    // Párrafo vivo: en una celda de tabla lo escrito no entra; se ofrece achicar la letra (nunca a escondidas) y queda en el PDF
    nombre: 'parrafo-vivo-achicar', pdf: '3-tablas.pdf',
    js: `const antes = (await window.pdfpro.paginaContenido(P().datos, 1)).lineas.find(l => l.texto.includes('Cuaderno')).fuente.size;
      await editar();
      const x = buscar('Cuaderno rayado'); seleccionar(x.n, x.i + 15, x.i + 15); document.execCommand('insertText', false, ' A4');
      await w(600); const aj = document.querySelector('.ed-ajuste');
      if (aj) [...aj.querySelectorAll('button')].find(b => b.textContent.startsWith('Achicar')).click();
      await w(500); await terminar();
      const l = (await window.pdfpro.paginaContenido(P().datos, 1)).lineas.find(l => l.texto.includes('Cuaderno'));
      return { ofrecio: !!aj, texto: l?.texto, antes, tam: l?.fuente.size, errores };`,
    revisar(r) {
      if (!r.ofrecio) return 'no ofreció achicar cuando no entraba';
      if (!/Cuaderno rayado A4/.test(r.texto || '')) return 'no quedó el texto: ' + r.texto;
      if (!(r.tam < r.antes * 0.97)) return `la letra no se achicó en el PDF: ${r.antes} → ${r.tam}`;
      return null;
    }
  },
  {
    // Menús con teclado (Alt+letra, flechas) y el recorrido de bienvenida (todos sus pasos encuentran su lugar)
    nombre: 'menus-teclado-y-recorrido', pdf: '1-simple.pdf',
    js: `await w(1500);
      const k = (key, o = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...o }));
      k('a', { altKey: true }); await w(400); const abierto = !!document.querySelector('.menu-lista'), primero = document.activeElement.textContent;
      k('ArrowDown'); const segundo = document.activeElement.textContent; k('Escape'); await w(200);
      pdfproPrueba.verRecorrido(); await w(400); const pasos = [];
      for (let i = 0; i < 8 && document.querySelector('.recorrido'); i++) { pasos.push(document.querySelector('.recorrido-globo h4').textContent); document.querySelector('.recorrido-globo .btn-primario').click(); await w(300); }
      return { abierto, primero, segundo, pasos, quedo: !!document.querySelector('.recorrido') };`,
    revisar(r) {
      if (!r.abierto || !/Abrir/.test(r.primero)) return 'Alt+A no abrió Archivo con el foco en el primer ítem: ' + r.primero;
      if (r.segundo === r.primero) return 'la flecha no movió el foco';
      if (r.pasos.length !== 6) return 'el recorrido tenía que tener 6 pasos: ' + r.pasos.join(' / ');
      if (r.quedo) return 'el recorrido no se cerró al final';
      return null;
    }
  },
  {
    // Después de una acción (numerar, censurar, imágenes…) se queda en la hoja donde estaba (antes volvía a la 1)
    nombre: 'se-queda-en-la-hoja', pdf: '11-cascada.pdf',
    js: `await w(1500);
      P().visor.irAPagina(3); await w(800);
      await pdfproPrueba.aplicar(b => b, { mensaje: 'Prueba' }); await w(1500);
      const v = P().visor, d = v.paginas[2].div;
      return { actual: v.actual, ve3: v.el.scrollTop >= d.offsetTop - 50 && v.el.scrollTop < d.offsetTop + d.offsetHeight };`,
    revisar(r) { return r.actual === 3 && r.ve3 ? null : 'volvió a otra hoja: ' + JSON.stringify(r); }
  },
  {
    // Numerar: abajo al centro de la hoja como se ve (también girada); numerar dos veces deja un solo número; se puede sacar
    nombre: 'numerar-normal', pdf: '1-simple.pdf',
    js: `await w(1500);
      const num = async (o) => { await pdfproPrueba.aplicar(b => window.pdfproNumerar(b, o)); await w(1200); };
      const ops = await import('./paginas.js'); window.pdfproNumerar = ops.numerar;
      await num({ formato: 'n' }); await num({ formato: 'n', primero: 5 });
      const r = await window.pdfpro.paginaParrafos(P().datos, 1), L = r.lugar;
      const numeros = r.parrafos.flatMap(x => x.lineas).filter(l => /^\\d+$/.test(l.texto.trim()));
      const conf = await ops.leerNumeracion(P().datos);
      await num({ activo: false });
      const despues = (await window.pdfpro.paginaParrafos(P().datos, 1)).parrafos.flatMap(x => x.lineas).filter(l => /^\\d+$/.test(l.texto.trim())).length;
      return { numeros: numeros.map(l => ({ t: l.texto, x: Math.round((l.rect[0] + l.rect[2]) / 2), y: Math.round(l.rect[1]) })), ancho: L?.ancho, conf, despues, sinConf: !(await ops.leerNumeracion(P().datos)) };`,
    revisar(r) {
      if (r.numeros.length !== 1) return 'tenía que haber un solo número: ' + JSON.stringify(r.numeros);
      const n = r.numeros[0];
      if (n.t.trim() !== '5') return 'el número tenía que empezar en 5: ' + n.t;
      if (r.ancho && Math.abs(n.x - r.ancho / 2) > 20) return 'no quedó al centro: ' + JSON.stringify(n) + ' ancho ' + r.ancho;
      if (n.y > 60) return 'no quedó abajo: ' + JSON.stringify(n);
      if (r.despues !== 0 || !r.sinConf) return 'no se pudo sacar la numeración';
      return null;
    }
  },
  {
    // Numerar: abajo al centro de la hoja como se ve (también girada); numerar dos veces deja un solo número; se puede sacar
    nombre: 'numerar-girada', pdf: '9-girada.pdf',
    js: `await w(1500);
      const num = async (o) => { await pdfproPrueba.aplicar(b => window.pdfproNumerar(b, o)); await w(1200); };
      const ops = await import('./paginas.js'); window.pdfproNumerar = ops.numerar;
      await num({ formato: 'n' }); await num({ formato: 'n', primero: 5 });
      const r = await window.pdfpro.paginaParrafos(P().datos, 1), L = r.lugar;
      const numeros = r.parrafos.flatMap(x => x.lineas).filter(l => /^\\d+$/.test(l.texto.trim()));
      const conf = await ops.leerNumeracion(P().datos);
      await num({ activo: false });
      const despues = (await window.pdfpro.paginaParrafos(P().datos, 1)).parrafos.flatMap(x => x.lineas).filter(l => /^\\d+$/.test(l.texto.trim())).length;
      return { numeros: numeros.map(l => ({ t: l.texto, x: Math.round((l.rect[0] + l.rect[2]) / 2), y: Math.round(l.rect[1]) })), ancho: L?.ancho, conf, despues, sinConf: !(await ops.leerNumeracion(P().datos)) };`,
    revisar(r) {
      if (r.numeros.length !== 1) return 'tenía que haber un solo número: ' + JSON.stringify(r.numeros);
      const n = r.numeros[0];
      if (n.t.trim() !== '5') return 'el número tenía que empezar en 5: ' + n.t;
      if (r.ancho && Math.abs(n.x - r.ancho / 2) > 20) return 'no quedó al centro: ' + JSON.stringify(n) + ' ancho ' + r.ancho;
      if (n.y > 60) return 'no quedó abajo: ' + JSON.stringify(n);
      if (r.despues !== 0 || !r.sinConf) return 'no se pudo sacar la numeración';
      return null;
    }
  },
  {
    // IA sin internet sin el modelo bajado: ofrece ir a Ajustes de la IA, ahí se baja (con un modelo chiquito en lugar
    // del de 2,7 GB), se ve el avance, queda listo y se puede borrar
    nombre: 'ia-local-bajar', pdf: '1-simple.pdf',
    antes: () => ({ PDFPRO_MODELO_LOCAL: '', PDFPRO_MODELO_URL: 'https://huggingface.co/ggml-org/models/resolve/main/tinyllamas/stories15M-q4_0.gguf 66967fbece6dbe97886593fdbb73589584927e29119ec31f08090732d1861739 19077344' }),
    js: `await w(1500); const sinModelo = pdfproPrueba.iaLocal(); await w(500);
      const texto = document.querySelector('dialog[open]')?.textContent || '';
      [...document.querySelectorAll('dialog[open] button')].find(b => /Ajustes/.test(b.textContent)).click(); await sinModelo;
      for (let i = 0; i < 20 && ![...document.querySelectorAll('dialog[open] button')].some(b => /^Bajar/.test(b.textContent)); i++) await w(250);
      const bajar = [...document.querySelectorAll('dialog[open] button')].find(b => /^Bajar/.test(b.textContent));
      const boton = bajar?.textContent; bajar.click();
      let vioBarra = false; const fin = () => /Listo:|dialogo-error/.test(document.querySelector('dialog[open] .pref')?.innerHTML || '');
      let error = '';
      for (let i = 0, otra = 2; i < 240; i++) {
        vioBarra ||= !!document.querySelector('.ia-local-barra');
        const e = document.querySelector('dialog[open] .pref .dialogo-error');
        if (e && otra-- > 0) { error += e.textContent + ' | '; [...document.querySelectorAll('dialog[open] button')].find(b => /^(Bajar|Seguir bajando)/.test(b.textContent))?.click(); } // como el usuario: otra vez
        else if (fin()) break;
        await w(250);
      }
      const final = document.querySelector('dialog[open] .pref section:nth-of-type(2)')?.textContent;
      [...document.querySelectorAll('dialog[open] button')].find(b => /Borrar el modelo/.test(b.textContent))?.click();
      for (let i = 0; i < 40 && !/Bajar \\(/.test(document.querySelector('dialog[open] .pref section:nth-of-type(2)')?.textContent); i++) await w(250);
      return { texto, boton, vioBarra, error, final, despues: document.querySelector('dialog[open] .pref section:nth-of-type(2)')?.textContent };`,
    revisar(r) {
      if (!/bajar el modelo/.test(r.texto)) return 'no ofreció bajar el modelo: ' + r.texto;
      if (!/^Bajar \(/.test(r.boton || '')) return 'no estaba el botón Bajar: ' + r.boton;
      if (!/Listo:/.test(r.final || '')) return 'no quedó bajado: ' + r.final;
      if (!/Bajar \(/.test(r.despues || '')) return 'no se borró: ' + r.despues;
      return null;
    }
  },
  {
    // IA sin internet con un modelo chiquito (19 MB, en inglés): arranca el proceso con Node común, escribe a medida
    // que llega, responde una pregunta y al cerrar no queda nada colgado
    nombre: 'ia-local-chico', pdf: '1-simple.pdf',
    antes(datos) {
      const fs = require('fs'), path = require('path'), os = require('os');
      const modelo = path.join(os.tmpdir(), 'pdfpro-stories15M-q4_0.gguf');
      if (!fs.existsSync(modelo)) require('child_process').execSync(`curl -fsSL -o "${modelo}" https://huggingface.co/ggml-org/models/resolve/main/tinyllamas/stories15M-q4_0.gguf`);
      return { PDFPRO_MODELO_LOCAL: modelo, PDFPRO_GUARDAR_COMO: path.join(datos, 'resumen.docx') };
    },
    js: `await w(1500); const abierta = pdfproPrueba.iaLocal(); const listo = () => /^Listo/.test(document.querySelector('.ia-local-estado')?.textContent || '');
      for (let i = 0; i < 120 && !listo(); i++) await w(250);
      const resumen = document.querySelector('.ia-local-texto')?.textContent || '';
      // Guardar como (Word): el archivo es un .docx (zip) con el texto del resumen
      [...document.querySelectorAll('.ia-local-acciones button')].find(b => /Guardar como/.test(b.textContent)).click();
      let guardado = ''; for (let i = 0; i < 20 && !/Guardado/.test(guardado); i++) { await w(250); guardado = document.querySelector('#aviso').textContent; }
      const caja = document.querySelector('.ia-local-preguntar input'); caja.value = 'Once upon a time?'; document.querySelector('.ia-local-preguntar button').click();
      await w(300); for (let i = 0; i < 120 && !listo(); i++) await w(250);
      const textos = [...document.querySelectorAll('.ia-local-texto')].map(x => x.textContent);
      // segundo plano: se achica, se puede usar el programa y al terminar avisa con "Ver"
      document.querySelector('.ia-panel .ia-achicar').click(); await w(200);
      const caja2 = document.querySelector('.ia-local-preguntar input'); caja2.value = 'Who?';
      document.querySelector('.ia-panel').hidden = false; document.querySelector('.ia-local-preguntar button').click(); document.querySelector('.ia-panel .ia-achicar').click();
      const chip = document.querySelector('.ia-chip').textContent;
      await pdfproPrueba.aplicar(b => b, { mensaje: 'prueba' }).catch(() => {}); // el programa sigue respondiendo
      let aviso = ''; for (let i = 0; i < 120 && !/Respuesta lista/.test(aviso); i++) { await w(250); aviso = document.querySelector('#aviso').textContent; }
      [...document.querySelectorAll('#aviso button')].find(b => /Ver/.test(b.textContent))?.click(); await w(200);
      const visible = !document.querySelector('.ia-panel').hidden;
      document.querySelector('.ia-panel .ia-cerrar').click(); await abierta;
      return { resumen, guardado, textos, chip, aviso, visible, cerrada: !document.querySelector('.ia-panel') };`,
    revisar(r) {
      if (!r.resumen.trim()) return 'no escribió el resumen: ' + JSON.stringify(r);
      if (!/Guardado: resumen\.docx/.test(r.guardado)) return 'no guardó el resumen como Word: ' + r.guardado;
      if (r.textos.length !== 2 || !r.textos[1].trim()) return 'no respondió la pregunta: ' + JSON.stringify(r.textos);
      if (!/Pensando/.test(r.chip)) return 'achicado no mostró que sigue trabajando: ' + r.chip;
      if (!/Respuesta lista/.test(r.aviso) || !r.visible) return 'no avisó al terminar en segundo plano: ' + JSON.stringify([r.aviso, r.visible]);
      if (!r.cerrada) return 'el panel no se cerró';
      return null;
    }
  },
  {
    // Resumen guardado como PDF: "Abrir" lo abre en una pestaña nueva del programa (por Windows abría otra copia del
    // programa y la ventana quedaba rota, con un recuadro negro abajo; informe #26)
    nombre: 'ia-local-abrir-resumen', pdf: '1-simple.pdf',
    antes(datos) {
      const path = require('path'), os = require('os');
      return { PDFPRO_MODELO_LOCAL: path.join(os.tmpdir(), 'pdfpro-stories15M-q4_0.gguf'), PDFPRO_GUARDAR_COMO: path.join(datos, 'resumen.pdf') };
    },
    js: `await w(1000); pdfproPrueba.iaLocal();
      for (let i = 0; i < 120 && !document.querySelector('.ia-local-acciones button'); i++) await w(250);
      document.querySelector('.ia-local-acciones button').click();
      for (let i = 0; i < 20 && !/Guardado/.test(document.querySelector('#aviso').textContent); i++) await w(250);
      [...document.querySelectorAll('#aviso button')].find(b => /Abrir/.test(b.textContent)).click();
      for (let i = 0; i < 20 && pdfproPrueba.estado.pestanas.length < 2; i++) await w(250);
      return { pestanas: pdfproPrueba.estado.pestanas.map(p => p.nombre) };`,
    revisar: r => r.pestanas.length === 2 && r.pestanas[1] === 'resumen.pdf' ? null : 'no abrió el resumen en una pestaña: ' + JSON.stringify(r.pestanas)
  },
  {
    // OCR de un área con PaddleOCR (ONNX en main.js, sin Python): marca la mitad de arriba de la hoja, la lee y muestra
    // el texto con tildes para revisar y copiar
    nombre: 'ocr-area-paddle', pdf: '1-simple.pdf',
    js: `await w(800); const pg = P().visor.paginas[0];
      const leer = pdfproPrueba.leerArea(pg, { x: 0, y: 0, w: pg.vista.width, h: pg.vista.height * 0.5 });
      for (let i = 0; i < 80 && !document.querySelector('.ocr-area-texto'); i++) await w(250);
      const texto = document.querySelector('.ocr-area-texto')?.value || document.querySelector('#aviso').textContent;
      document.querySelector('dialog[open] .boton-secundario')?.click(); await leer;
      // también directo por IPC con una imagen chica sin texto: no falla y devuelve vacío
      const c = Object.assign(document.createElement('canvas'), { width: 64, height: 64 }), g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 64, 64);
      const vacio = await window.pdfpro.ejecutarOcr(new Uint8Array(await (await new Promise(r => c.toBlob(r, 'image/png'))).arrayBuffer()));
      return { texto, vacio: vacio.texto, bloques: vacio.bloques.length };`,
    revisar(r) {
      if (!/Informe mensual/.test(r.texto) || !/revisó el proyecto/.test(r.texto) || !/párrafo/.test(r.texto)) return 'no leyó bien el texto: ' + r.texto;
      if (r.vacio !== '' || r.bloques) return 'una imagen en blanco dio texto: ' + r.vacio;
      return null;
    }
  }
];
module.exports = casos;
module.exports.AYUDA = AYUDA;
