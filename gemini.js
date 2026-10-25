// pdf.pro — Gemini para el asistente (proceso principal). Traduce los pedidos con el formato de Claude (system, messages,
// tools, output_config) al de la API de Gemini y la respuesta de vuelta al de Claude (content con text / tool_use,
// stop_reason, usage). Así el resto del asistente no cambia. API REST de Google AI Studio (v1beta, generateContent).
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const URL_BASE = process.env.PDFPRO_GEMINI_URL || BASE; // las pruebas usan un Gemini simulado

class ErrorGemini extends Error { constructor(estado, mensaje) { super(mensaje); this.gemini = true; this.estado = estado; } }

async function pedir(clave, ruta, cuerpo, tiempo = 180000) {
  let r;
  try {
    r = await fetch(URL_BASE + ruta, { method: cuerpo ? 'POST' : 'GET', headers: { 'x-goog-api-key': clave, 'Content-Type': 'application/json' },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined, signal: AbortSignal.timeout(tiempo) });
  } catch (e) { throw new ErrorGemini(0, (e.name === 'TimeoutError' ? `no respondió en ${Math.round(tiempo / 1000)} s` : 'sin conexión') + ': ' + e.message); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new ErrorGemini(r.status, j.error?.message || r.statusText), { cuerpo: j }); // el cuerpo va al informe de errores
  return j;
}

// Los modelos de texto que esta clave puede usar (así la lista siempre es la de hoy)
async function modelos(clave) {
  const lista = [];
  let pagina = '';
  do {
    const j = await pedir(clave, '/models?pageSize=200' + (pagina ? '&pageToken=' + encodeURIComponent(pagina) : ''));
    for (const m of j.models || []) {
      const id = String(m.name || '').replace(/^models\//, '');
      if (!/^gemini-/.test(id) || !(m.supportedGenerationMethods || []).includes('generateContent')) continue;
      if (/tts|image|embedding|live|audio|robotics|computer|native/i.test(id)) continue;
      lista.push({ id, nombre: m.displayName || id });
    }
    pagina = j.nextPageToken;
  } while (pagina);
  return vigentes(lista);
}
// Solo los vigentes: de cada familia (Pro, Flash, Flash-Lite) el más nuevo estable, y su preview solo si es más nueva.
// Afuera: los viejos, los alias "-latest", las versiones fijas "-001" y los experimentales.
const version = id => +(id.match(/^gemini-(\d+(?:\.\d+)?)/)?.[1] || 0);
const familia = id => /flash-lite/.test(id) ? 'flash-lite' : /flash/.test(id) ? 'flash' : /pro/.test(id) ? 'pro' : null;
function vigentes(lista) {
  const out = [];
  for (const fam of ['pro', 'flash', 'flash-lite']) {
    const de = lista.filter(m => familia(m.id) === fam && version(m.id) && !/latest|-\d{3}$|exp|thinking|customtools/.test(m.id));
    const nuevo = arr => arr.sort((a, b) => version(b.id) - version(a.id) || a.id.length - b.id.length)[0];
    const estable = nuevo(de.filter(m => !/preview/.test(m.id))), preview = nuevo(de.filter(m => /preview/.test(m.id)));
    if (estable) out.push(estable);
    if (preview && (!estable || version(preview.id) > version(estable.id))) out.push(preview);
  }
  return out;
}

// ---------- Claude → Gemini ----------
function partes(content, nombres) {
  if (typeof content === 'string') return [{ text: content }];
  const out = [];
  for (const b of content || []) {
    if (b.type === 'text') out.push({ text: b.text });
    else if (b.type === 'image' || b.type === 'document') {
      if (b.title) out.push({ text: `[Archivo: ${b.title}]` });
      out.push({ inlineData: { mimeType: b.source.media_type, data: b.source.data } });
    } else if (b.type === 'tool_use') {
      nombres.set(b.id, b.name);
      // Gemini 3 exige devolver la firma de su razonamiento junto con cada llamada a herramienta
      out.push({ functionCall: { name: b.name, args: b.input || {} }, ...(b.firma ? { thoughtSignature: b.firma } : {}) });
    } else if (b.type === 'tool_result') {
      const texto = typeof b.content === 'string' ? b.content : (b.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n');
      out.push({ functionResponse: { name: nombres.get(b.tool_use_id) || 'herramienta', response: { resultado: texto } } });
    }
  }
  return out.length ? out : [{ text: '…' }];
}
function aGemini(pedido) {
  const nombres = new Map();
  const sistema = (Array.isArray(pedido.system) ? pedido.system.map(s => s.text).join('\n\n') : pedido.system) || '';
  const contents = [];
  for (const m of pedido.messages || []) {
    const role = m.role === 'assistant' ? 'model' : 'user', p = partes(m.content, nombres);
    if (contents.at(-1)?.role === role) contents.at(-1).parts.push(...p); else contents.push({ role, parts: p });
  }
  // en Gemini lo que "piensa" también cuenta como respuesta: se le da más lugar para que no se corte
  const cuerpo = { contents, generationConfig: { maxOutputTokens: Math.max(pedido.max_tokens || 8000, pedido.max_tokens >= 8000 ? 32768 : 4096) } };
  if (sistema) cuerpo.systemInstruction = { parts: [{ text: sistema }] };
  if (pedido.tools?.length) cuerpo.tools = [{ functionDeclarations: pedido.tools.map(t => ({ name: t.name, description: t.description,
    ...(Object.keys(t.input_schema?.properties || {}).length ? { parametersJsonSchema: t.input_schema } : {}) })) }];
  const formato = pedido.output_config?.format;
  if (formato?.type === 'json_schema') Object.assign(cuerpo.generationConfig, { responseMimeType: 'application/json', responseJsonSchema: formato.schema });
  // esfuerzo: en Gemini 3 se piensa poco ('low') o mucho ('high')
  if (/^gemini-3/.test(pedido.model)) cuerpo.generationConfig.thinkingConfig = { thinkingLevel: pedido.output_config?.effort === 'low' ? 'low' : 'high' };
  return cuerpo;
}

// ---------- Gemini → Claude ----------
const RECHAZOS = /SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION|IMAGE_SAFETY/;
function deGemini(j, modelo) {
  const c = j.candidates?.[0], content = [];
  let n = 0;
  for (const p of c?.content?.parts || []) {
    if (p.thought) continue; // resumen de lo que pensó: no es respuesta
    if (p.functionCall) content.push({ type: 'tool_use', id: `g${Date.now()}_${n++}`, name: p.functionCall.name, input: p.functionCall.args || {}, ...(p.thoughtSignature ? { firma: p.thoughtSignature } : {}) });
    else if (p.text) content.push({ type: 'text', text: p.text });
  }
  const fin = c?.finishReason || '';
  const stop_reason = j.promptFeedback?.blockReason || RECHAZOS.test(fin) ? 'refusal'
    : content.some(b => b.type === 'tool_use') ? 'tool_use' : fin === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn';
  const u = j.usageMetadata || {}, cache = u.cachedContentTokenCount || 0;
  return { model: modelo, content, stop_reason, usage: { input_tokens: (u.promptTokenCount || 0) - cache, cache_read_input_tokens: cache, output_tokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) } };
}

async function llamar(clave, pedido, tiempo) {
  const j = await pedir(clave, `/models/${encodeURIComponent(pedido.model)}:generateContent`, aGemini(pedido), tiempo);
  return deGemini(j, pedido.model);
}

// Errores en palabras simples
function explicar(e) {
  const m = String(e.message || '');
  if (e.estado === 0) return 'No hay conexión con Gemini. Revisá internet.';
  if (/API_KEY_INVALID|API key not valid/i.test(m) || e.estado === 401) return 'Google dice que la clave no es válida. Copiala de nuevo entera desde aistudio.google.com (empieza con AIza).';
  if (e.estado === 429) return 'Gemini: se llegó al límite de uso de tu clave (por minuto o por día). Probá en un rato o elegí otro modelo en Ajustes de la IA.';
  if (e.estado === 403) return 'Google no deja usar Gemini con esa clave: ' + m.slice(0, 200);
  if (e.estado === 404) return 'Ese modelo de Gemini ya no está. Elegí otro en Asistente → Ajustes de la IA.';
  return 'Gemini respondió con un error (' + (e.estado || '?') + '): ' + m.slice(0, 200);
}

module.exports = { llamar, modelos, explicar, aGemini, deGemini, vigentes };
