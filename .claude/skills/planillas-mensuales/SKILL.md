---
name: planillas-mensuales
description: Armar, revisar y corregir las planillas mensuales de asistencia (transporte, terapias, escuela) en PDF a partir de la del mes anterior. Usar cuando Matías pida pasar una planilla a otro mes, completar días, cambiar horarios, kilómetros o firmas, o revisar si una planilla está bien.
---

# Planillas mensuales de asistencia

Las planillas son PDF con filas "Nro 1", "Nro 2"… y columnas Fecha / Hora de Inicio / Hora de Finalización /
Kilómetros / Firma. Cada servicio (terapias, escuela…) ocupa una o más hojas seguidas con el mismo "Transporte a".
La herramienta es `herramientas/planillas/planilla.cjs` (usa el mismo motor que pdf.pro). Respuestas para Matías:
cortas, claras, en español rioplatense, sin listas largas.

## Antes de empezar

- Es una **declaración jurada**. Las fechas tienen que ser días en que el servicio se hizo de verdad: si el mes no
  terminó, preguntá si hubo faltas o armala a fin de mes.
- La firma de cada fila es la de Matías (o su familia). Se copia de la planilla anterior solo si él lo pide.
- **Nunca copies firmas o sellos de otras personas** (terapeutas, escuela, transportista) a un mes que no firmaron.
  Los de abajo de la hoja quedan como vienen en el PDF que te da; si son del mes anterior, avisale que los tienen que
  firmar de nuevo.
- Los PDF de Matías tienen datos personales: trabajalos en el scratchpad, nunca los subas al repositorio ni a un
  artefacto, y no los uses como pruebas automáticas.
- `git pull` del repo antes de usar la herramienta (otra sesión puede haberla mejorado).

## Paso a paso

1. Copiá el PDF a una carpeta nueva del scratchpad y revisalo:
   `node herramientas/planillas/planilla.cjs revisar ENTRADA.pdf`
   Muestra, por grupo de hojas, el horario que aprendió para cada día y los km, y avisa lo que no cierra (fin de
   semana, feriado, horario distinto al del resto de ese día, falta km o firma, fechas repetidas).
2. Confirmá con Matías lo que la planilla no dice:
   - **Feriados del mes** para la jurisdicción de las direcciones (por ejemplo, Provincia de Buenos Aires). Buscalos
     en internet en fuentes oficiales o diarios y citá la fuente; ojo con los trasladables y los que rigen solo en
     algunas provincias.
   - **Días sin servicio** (faltas, vacaciones).
   - **Horarios por día** si cambian (hoy: terapias lunes a jueves 8:30 a 10:50 y viernes 8:30 a 9:50; escuela 12:40 a
     17:40). Si lo aprendido de la planilla anterior está bien, no hace falta pasarlo.
3. Armá el mes:
   ```
   node herramientas/planillas/planilla.cjs armar ENTRADA.pdf --mes AAAA-MM --feriados 9,11,23 [--sin 17] \
     [--horario "1-2:lun-jue=8:30-10:50;vie=8:30-9:50|3-4:lun-vie=12:40-17:40"] [--km "1-2=19.2KM;3-4=12km"] \
     --salida SALIDA.pdf
   ```
   (`--sin-firma` deja las filas sin firma.) Cambia el período del encabezado, pone los días hábiles en orden,
   horarios y km, una firma por fila con fecha y deja vacías las filas que sobran. Al final corre el control: tiene
   que decir "todo en orden".
4. Mirala de verdad antes de mandarla: dibujá cada hoja y revisá encabezado, fechas, horarios, km, firmas y que lo
   impreso ("Desde……hs", "--/--/----") esté entero:
   ```
   node --input-type=module -e "import fs from 'fs'; const m = await import('./node_modules/mupdf/dist/mupdf.js'); const d = m.Document.openDocument(fs.readFileSync('SALIDA.pdf'), 'application/pdf'); for (let i = 0; i < d.countPages(); i++) fs.writeFileSync('hoja' + (i + 1) + '.png', d.loadPage(i).toPixmap(m.Matrix.scale(1.5, 1.5), m.ColorSpace.DeviceRGB, false, true).asPNG());"
   ```
5. Mandá el PDF con SendUserFile (display attach) y contá en 3 o 4 líneas: días hábiles, feriados que sacaste, qué
   firmas faltan (las de terceros) y cualquier aviso de la herramienta.

## Corregir una planilla ya hecha

- Si `revisar` marca un horario o km mal, volvé a armar el mismo mes desde esa planilla con `--horario`/`--km`
  correctos (`--mes` del mismo mes): rehace todas las filas con los datos buenos.
- Un cambio suelto (un texto, una fecha puntual) se puede hacer también en pdf.pro (Editar), que escribe con la letra
  del documento.

## Si algo sale mal

- "No encontré ninguna hoja con forma de planilla": el formulario es distinto; hacelo con el editor de pdf.pro y
  avisá a Matías.
- Algún dato "con Helvetica": la letra del PDF no traía esas letras; Helvetica es casi igual a Arial, está bien.
- "dato(s) viejo(s) … se taparon con blanco": había un dato escrito justo encima de lo impreso; mirá esa fila en el
  dibujo por si se comió parte de "Desde……hs".
- Si encontrás un error de la herramienta, arreglalo en `herramientas/planillas/planilla.cjs` (o en el motor) y
  sumá el caso a `pruebas/planilla.cjs` con una planilla inventada.
