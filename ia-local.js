// PDF.Pro — IA local en un proceso aparte: carga el modelo .gguf con node-llama-cpp, solo CPU, y contesta los pedidos
// de a uno. Corre con Node común (no con Electron: su reparto de memoria no deja reservar el bloque grande que pide el
// modelo y se cierra). Lo arranca ia-local-cliente.js. Si se cae por memoria, el programa sigue andando.
// Recibe { id, sistema, texto, maxTokens, modelo } y manda { id, trozo } mientras escribe y al final { id, r } o { id, error }.
// { id, cortar: true } corta el pedido en curso (devuelve lo escrito hasta ahí).
let llama = null, modelo = null, contexto = null, secuencia = null, rutaCargada = null, LlamaChatSession = null;
const cortes = new Map(), cortados = new Set();
let cola = Promise.resolve();

async function cargar(ruta) {
  if (rutaCargada === ruta) return;
  await contexto?.dispose(); await modelo?.dispose();
  const nlc = await import('node-llama-cpp');
  LlamaChatSession = nlc.LlamaChatSession;
  llama ||= await nlc.getLlama({ gpu: false, build: 'never', progressLogs: false, logLevel: nlc.LlamaLogLevel.error });
  modelo = await llama.loadModel({ modelPath: ruta });
  const hilos = Math.max(2, Math.min(8, require('os').availableParallelism() - 1));
  contexto = await modelo.createContext({ contextSize: 6144, threads: hilos });
  secuencia = contexto.getSequence(); // una sola, se limpia antes de cada pedido
  rutaCargada = ruta;
}

async function pedir({ id, sistema, texto, maxTokens = 400, modelo: ruta }) {
  if (cortados.delete(id)) return '';
  const control = new AbortController(); cortes.set(id, control);
  try { await cargar(ruta); } catch (e) { cortes.delete(id); throw e; }
  if (control.signal.aborted) { cortes.delete(id); return ''; }
  await secuencia.clearHistory();
  let s = null;
  try {
    s = new LlamaChatSession({ contextSequence: secuencia, systemPrompt: sistema });
    const r = await s.prompt(texto, { maxTokens, temperature: 0.2, budgets: { thoughtTokens: 0 }, signal: control.signal, stopOnAbortSignal: true,
      onTextChunk: trozo => process.send({ id, trozo }) });
    return r.trim();
  } finally { cortes.delete(id); s?.dispose({ disposeSequence: false }); }
}

process.on('message', data => {
  if (data.cortar) { if (cortes.has(data.id)) cortes.get(data.id).abort(); else cortados.add(data.id); return; }
  // de a un pedido por vez (el modelo usa todos los núcleos)
  cola = cola.then(() => pedir(data).then(r => process.send({ id: data.id, r }),
    e => process.send({ id: data.id, error: String(e?.message || e) })));
});
process.on('disconnect', () => process.exit(0)); // si el programa se cierra, este también
