// pdf.pro — fuentes para editar texto (interfaz). Junta las de Windows, "Mis fuentes" y las que trae el PDF,
// elige la que más se parece a la original y da los bytes para incrustarla al escribir (`escribirTexto`).
const BASICAS = [['sans', 'Sans (Helvetica)'], ['serif', 'Serif (Times)'], ['mono', 'Mono (Courier)']];
export const CSS_BASICA = { sans: 'Helvetica, Arial, sans-serif', serif: '"Times New Roman", Times, serif', mono: '"Courier New", Courier, monospace' };
// "ABCDEF+TimesNewRomanPS-BoldMT" → "timesnewroman"
export const normalizar = n => String(n || '').replace(/^[A-Z]{6}\+/, '').replace(/[,-].*$/, '').replace(/(PSMT|PS|MT)$/, '').replace(/[\s_]/g, '').toLowerCase();

export class Fuentes {
  constructor(api) { this.api = api; this.lista = null; this.delPdf = new Map(); this.cargadas = new Set(); }
  async cargar(recargar = false) {
    if (!this.lista || recargar) {
      const r = await this.api.fuentesLista();
      const familias = (arr, origen) => { const m = new Map(); for (const f of arr) { if (!m.has(f.familia)) m.set(f.familia, { familia: f.familia, origen, variantes: [] }); m.get(f.familia).variantes.push(f); } return m; };
      this.biblioteca = familias(r.biblioteca, 'biblioteca');
      this.sistema = familias(r.sistema.filter(f => !this.biblioteca?.has(f.familia)), 'sistema');
      this.lista = [...this.biblioteca.values(), ...this.sistema.values()];
    }
    return this.lista;
  }
  // Fuentes que vienen dentro del PDF (se pregunta una vez por documento)
  async delDocumento(p) {
    if (!this.delPdf.has(p.datos)) this.delPdf.set(p.datos, this.api.fuentesDelPdf(p.datos).catch(() => []));
    return this.delPdf.get(p.datos);
  }
  familia(nombre) { return this.lista?.find(f => f.familia === nombre); }
  // La familia instalada que corresponde a la fuente original del renglón, o null
  parecida(nombreOriginal) {
    const n = normalizar(nombreOriginal);
    if (!n || !this.lista) return null;
    return this.lista.find(f => normalizar(f.familia) === n) || this.lista.find(f => f.variantes.some(v => normalizar(v.ps) === n)) || null;
  }
  // La variante (normal, negrita, cursiva) que mejor encaja
  variante(fam, negrita, cursiva) {
    const pts = v => (v.negrita === !!negrita ? 2 : 0) + (v.cursiva === !!cursiva ? 1 : 0) - (/light|thin|black|condensed|narrow|semi|demi/i.test(v.estilo) ? 0.5 : 0);
    return [...fam.variantes].sort((a, b) => pts(b) - pts(a))[0];
  }
  // Lo que necesita escribirTexto: 'sans'|'serif'|'mono', o { clave, bytes } de la fuente elegida
  async paraEscribir(clave, negrita, cursiva) {
    if (!clave?.startsWith('f:')) return clave || 'sans';
    await this.cargar();
    const fam = this.familia(clave.slice(2));
    if (!fam) return 'sans';
    const v = this.variante(fam, negrita, cursiva);
    return { clave: v.ruta + '#' + v.indice, bytes: new Uint8Array(await this.api.fuenteBytes(v)), sintetica: v.negrita !== !!negrita || v.cursiva !== !!cursiva };
  }
  // Para ver la letra en el cuadro de edición: las de Windows ya las conoce el navegador; las de "Mis fuentes" se cargan
  async css(clave, negrita, cursiva) {
    if (!clave?.startsWith('f:')) return CSS_BASICA[clave] || CSS_BASICA.sans;
    await this.cargar();
    const fam = this.familia(clave.slice(2));
    if (fam?.origen === 'biblioteca') {
      // se registra con el nombre de la familia, así sirve tanto en el editor como en los cuadros de texto
      const v = this.variante(fam, negrita, cursiva), clave = v.ruta + '#' + v.indice;
      if (!this.cargadas.has(clave)) {
        try { const ff = new FontFace(fam.familia, await this.api.fuenteBytes(v), { weight: v.negrita ? '700' : '400', style: v.cursiva ? 'italic' : 'normal' }); await ff.load(); document.fonts.add(ff); this.cargadas.add(clave); } catch {}
      }
      return `"${fam.familia}", sans-serif`;
    }
    return `"${clave.slice(2)}", sans-serif`;
  }
  // Lista para el desplegable del editor
  async opciones(el, p, actual) {
    await this.cargar();
    const doc = await this.delDocumento(p);
    const op = (v, t, extra = {}) => el('option', { value: v, selected: v === actual, ...extra }, t);
    const grupo = (t, items) => items.length ? el('optgroup', { label: t }, ...items) : null;
    const faltan = doc.filter(d => !this.parecida(d.nombre));
    return [
      grupo('Del documento (todavía no las tenés)', faltan.map(d => op('doc:' + d.nombre, d.nombre + (d.copiable ? ' — copiar a Mis fuentes' : ' — no se puede copiar'), { disabled: !d.copiable }))),
      grupo('Mis fuentes', [...this.biblioteca.values()].map(f => op('f:' + f.familia, f.familia))),
      grupo('Básicas', BASICAS.map(([v, t]) => op(v, t))),
      grupo('Instaladas en Windows', [...this.sistema.values()].sort((a, b) => a.familia.localeCompare(b.familia)).map(f => op('f:' + f.familia, f.familia))),
      el('option', { value: 'agregar' }, 'Agregar fuente desde archivo…')
    ].filter(Boolean);
  }
}
