// PDF.Pro — formularios con casilleros (AcroForm): se completan escribiendo directo sobre la página.
// Los valores nuevos viven en p.campos ({ nombre: texto | true/false }) hasta guardar (`ponerCampos` en paginas.js),
// igual que las firmas y comentarios: así se deshace con Ctrl+Z y se puede seguir con Tab de casillero en casillero.
export class Campos {
  // ctx: { el, pestana(), cambiarCampos(p, campos) }
  constructor(ctx) { this.ctx = ctx; this.cache = new Map(); }

  async widgets(p, pg) {
    if (this.cache.datos !== p.datos) { this.cache = new Map(); this.cache.datos = p.datos; }
    if (!this.cache.has(pg.n)) this.cache.set(pg.n, p.visor.doc.getPage(pg.n).then(x => x.getAnnotations({ intent: 'display' }))
      .then(l => l.filter(a => a.subtype === 'Widget' && a.fieldName && ['Tx', 'Btn', 'Ch'].includes(a.fieldType) && !a.pushButton && !a.hidden)));
    return this.cache.get(pg.n);
  }
  // Todos los casilleros del documento (para la mascota)
  async todos(p) {
    const lista = [];
    for (const pg of p.visor.paginas) for (const a of await this.widgets(p, pg)) lista.push({ ...a, n: pg.n });
    return lista;
  }
  valor(p, a) {
    if (a.fieldName in (p.campos || {})) { const v = p.campos[a.fieldName]; return a.radioButton ? v === a.buttonValue : a.checkBox ? v === true || (typeof v === 'string' && v !== 'Off' && v !== '') : v; }
    if (a.checkBox) return a.fieldValue && a.fieldValue !== 'Off';
    if (a.radioButton) return a.fieldValue === a.buttonValue;
    return a.fieldValue ?? '';
  }
  async dibujarPagina(p, pg) {
    let lista;
    try { lista = await this.widgets(p, pg); } catch { return; }
    pg.div.querySelectorAll('.campo-pdf').forEach(x => x.remove());
    if (!pg.vista || !lista.length) return;
    const { el } = this.ctx, v = pg.vista;
    // en orden de lectura, para que Tab vaya de uno al siguiente
    const orden = [...lista].sort((a, b) => (b.rect[3] - a.rect[3]) || (a.rect[0] - b.rect[0]));
    for (const a of orden) {
      const [x0, y0, x1, y1] = v.convertToViewportRectangle(a.rect);
      const pos = `left:${Math.min(x0, x1) / v.width * 100}%;top:${Math.min(y0, y1) / v.height * 100}%;width:${Math.abs(x1 - x0) / v.width * 100}%;height:${Math.abs(y1 - y0) / v.height * 100}%`;
      const val = this.valor(p, a), cambiado = a.fieldName in (p.campos || {});
      let e;
      if (a.checkBox || a.radioButton) {
        e = el('input', { type: 'checkbox', class: 'campo-pdf caja' + (cambiado ? ' cambiado' : ''), style: pos, title: a.alternativeText || a.fieldName, checked: !!val, disabled: !!a.readOnly });
        e.addEventListener('change', () => {
          // las opciones de un grupo (radio) comparten nombre: se guarda cuál quedó elegida
          this.ctx.cambiarCampos(p, { ...p.campos, [a.fieldName]: a.radioButton ? (e.checked ? a.buttonValue : 'Off') : e.checked });
          if (a.radioButton) this.redibujar(p); else e.classList.add('cambiado');
        });
      } else if (a.fieldType === 'Ch' && a.options?.length) {
        e = el('select', { class: 'campo-pdf' + (cambiado || val ? ' lleno' : ''), style: pos, title: a.alternativeText || a.fieldName, disabled: !!a.readOnly },
          el('option', { value: '' }, ''), ...a.options.map(o => el('option', { value: o.exportValue, selected: String(val) === o.exportValue }, o.displayValue)));
        e.addEventListener('change', () => { e.classList.add('lleno'); this.ctx.cambiarCampos(p, { ...p.campos, [a.fieldName]: e.value }); });
      } else {
        e = el(a.multiLine ? 'textarea' : 'input', { class: 'campo-pdf' + (val ? ' lleno' : ''), style: pos + `;font-size:${Math.min(14, Math.abs(y1 - y0) * 0.62)}px`,
          title: a.alternativeText || a.fieldName, disabled: !!a.readOnly, spellcheck: 'true', ...(a.maxLen ? { maxlength: a.maxLen } : {}) });
        e.value = val ?? '';
        e.addEventListener('change', () => this.ctx.cambiarCampos(p, { ...p.campos, [a.fieldName]: e.value }));
        e.addEventListener('input', () => e.classList.toggle('lleno', !!e.value));
        e.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter' && !a.multiLine) { ev.preventDefault(); e.blur(); } });
      }
      e.dataset.campo = a.fieldName;
      e.addEventListener('pointerdown', ev => ev.stopPropagation());
      pg.div.append(e);
    }
  }
  redibujar(p) { p.visor?.paginas.forEach(pg => pg.dibujada && this.dibujarPagina(p, pg)); }
}
