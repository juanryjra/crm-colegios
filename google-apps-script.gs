/**
 * CRM Colegios — Apps Script
 *
 * HOJAS QUE USA (en el libro DatosColegio_2026):
 *   • Una pestaña por AÑO, con el número como nombre: "2026", "2027"…  (datos de los colegios, columnas A:AB)
 *     → Para empezar un año nuevo, duplica la pestaña del año anterior y renómbrala (ej. "2027").
 *       La app la detecta sola en el selector de año.
 *   • "contactos" y "CENSO": compartidas por todos los años.
 *     Si algún año quieres un censo o contactos propios, crea "CENSO 2027" o "contactos 2027"
 *     y ese año los usará automáticamente.
 *   • "Tareas": la crea este script solo, la primera vez que guardes una tarea. No tienes que crearla.
 *
 * ANTES DE PUBLICAR:
 * 1. ⚙ Configuración del proyecto:
 *      - Zona horaria: (GMT-05:00) Bogotá   ← importante para que los recordatorios lleguen a la hora correcta
 *      - Propiedades de la secuencia de comandos: CRM_PIN = tu PIN (si ya la tienes, no la toques)
 * 2. Selecciona la función "autorizar" arriba en el editor y presiona ▶ Ejecutar.
 *    Google te pedirá permiso para usar tu Calendar (para los recordatorios). Acepta.
 * 3. Implementar → Gestionar implementaciones → ✏ Editar → Versión: "Nueva versión" → Implementar.
 *    (Ejecutar como: Yo · Quién tiene acceso: Cualquier usuario). La URL /exec no cambia.
 */

const SHEET_ID = "1RCNyiHto-QRJjrdiDO3trl-MajouzlcCLnc1hMW0EIU";

const HOJA_CONTACTOS = "contactos";
const HOJA_CENSO     = "CENSO";
const HOJA_TAREAS    = "Tareas";
const COLS_TAREAS    = ["ID", "Año", "ColegioID", "Colegio", "Tarea", "Fecha", "Hora", "Hecha", "Creada", "Calendario"];

const MAX_FILAS       = 500; // colegios por año que se leen
const HORAS_SESION    = 6;   // máximo permitido por CacheService: 6 horas
const MAX_INTENTOS    = 5;   // intentos fallidos antes de bloquear
const MINUTOS_BLOQUEO = 15;  // tiempo de bloqueo tras varios fallos

// ══════ ENTRADA ══════
function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, success: false, error: "Petición inválida" });
  }

  const accion = body.accion || body.tipo;

  if (accion === "login") return json(login(body.pin));

  // Todo lo demás exige una sesión válida
  if (!tokenValido(body.token)) {
    return json({ ok: false, success: false, error: "auth" });
  }

  try {
    switch (accion) {
      case "anios":            return json({ ok: true, anios: anios() });
      case "leer":             return json(leer(body));
      case "datos":            return json(conBloqueo(() => guardarDatos(body)));
      case "senso":
      case "censo":            return json(conBloqueo(() => guardarCenso(body)));
      case "tareas_listar":    return json(listarTareas());
      case "tarea_crear":      return json(conBloqueo(() => crearTarea(body)));
      case "tarea_actualizar": return json(conBloqueo(() => actualizarTarea(body)));
      case "tarea_borrar":     return json(conBloqueo(() => borrarTarea(body)));
    }
    return json({ ok: false, success: false, error: "Acción desconocida" });
  } catch (err) {
    return json({ ok: false, success: false, error: String(err.message || err) });
  }
}

function doGet() {
  return json({ ok: false, error: "Este servicio solo acepta POST" });
}

// Ejecútala UNA vez desde el editor para dar permiso de Calendar y Sheets
function autorizar() {
  libro().getName();
  CalendarApp.getDefaultCalendar().getName();
  Logger.log("Permisos listos. Ahora publica una nueva versión.");
}

// ══════ LOGIN Y SESIÓN ══════
function login(pin) {
  const cache = CacheService.getScriptCache();
  const intentos = Number(cache.get("intentos") || 0);

  if (intentos >= MAX_INTENTOS) {
    return { ok: false, error: "Demasiados intentos. Espera " + MINUTOS_BLOQUEO + " minutos." };
  }

  const pinReal = PropertiesService.getScriptProperties().getProperty("CRM_PIN");
  if (!pinReal) return { ok: false, error: "Falta configurar CRM_PIN en el Apps Script" };

  if (String(pin) !== String(pinReal)) {
    cache.put("intentos", String(intentos + 1), MINUTOS_BLOQUEO * 60);
    return { ok: false, error: "PIN incorrecto. Intenta de nuevo." };
  }

  cache.remove("intentos");
  const token = Utilities.getUuid();
  cache.put("t_" + token, "1", HORAS_SESION * 3600);
  return { ok: true, token: token, anios: anios() };
}

function tokenValido(token) {
  if (!token || typeof token !== "string") return false;
  return CacheService.getScriptCache().get("t_" + token) === "1";
}

// ══════ AÑOS ══════
// Cualquier pestaña cuyo nombre sea un año de 4 dígitos (2026, 2027…) aparece en el selector
function anios() {
  return libro().getSheets()
    .map(s => s.getName().trim())
    .filter(n => /^\d{4}$/.test(n))
    .sort()
    .reverse();
}

function anioValido(anio) {
  const lista = anios();
  if (!lista.length) throw new Error("No hay ninguna pestaña con nombre de año (por ejemplo 2026)");
  const a = String(anio || "").trim();
  return lista.indexOf(a) >= 0 ? a : lista[0];
}

// Usa "CENSO 2027" si existe; si no, la hoja compartida "CENSO"
function hojaDelAnio(base, anio) {
  const ss = libro();
  const candidatos = [base + " " + anio, base + "_" + anio, base + anio];
  for (const n of candidatos) if (ss.getSheetByName(n)) return n;
  return base;
}

// ══════ LECTURA ══════
function leer(b) {
  const anio = anioValido(b.anio);
  return {
    ok: true,
    anio: anio,
    anios: anios(),
    datos:     rango(anio, "A2:AB" + (MAX_FILAS + 1)),
    contactos: rango(hojaDelAnio(HOJA_CONTACTOS, anio), "A2:E" + (MAX_FILAS * 3)),
    senso:     rango(hojaDelAnio(HOJA_CENSO, anio), "B2:Q" + (MAX_FILAS + 1))
  };
}

function rango(nombreHoja, a1) {
  const valores = hoja(nombreHoja).getRange(a1).getDisplayValues();
  // Quita filas vacías al final para no enviar datos de más
  let n = valores.length;
  while (n > 0 && valores[n - 1].every(v => v === "")) n--;
  return valores.slice(0, n);
}

// ══════ ESCRITURA DE COLEGIOS Y CENSO ══════
// "fila" es la posición dentro del rango leído (fila 0 = fila 2 de la hoja)

function guardarDatos(b) {
  const anio = anioValido(b.anio);
  const fila = Number(b.fila);
  if (!Number.isInteger(fila) || fila < 0 || fila >= MAX_FILAS || !Array.isArray(b.valores)) {
    throw new Error("Datos inválidos para la hoja " + anio);
  }
  escribirConservandoFormulas(hoja(anio).getRange(fila + 2, 1, 1, 28), b.valores, 28); // A:AB
  return { ok: true, success: true, hoja: anio };
}

function guardarCenso(b) {
  const anio = anioValido(b.anio);
  const nombre = hojaDelAnio(HOJA_CENSO, anio);
  const fila = Number(b.fila);
  if (!Number.isInteger(fila) || fila < 0 || fila >= MAX_FILAS * 2 || !Array.isArray(b.valores)) {
    throw new Error("Datos inválidos para la hoja " + nombre);
  }
  escribirConservandoFormulas(hoja(nombre).getRange(fila + 2, 2, 1, 16), b.valores, 16); // B:Q
  return { ok: true, success: true, hoja: nombre };
}

// Las celdas con fórmula (Estudiantes, Activo pin, Total…) NO se reemplazan por un número fijo
function escribirConservandoFormulas(rng, valores, largo) {
  const formulas = rng.getFormulas()[0];
  const fila = normalizar(valores, largo).map((v, i) => formulas[i] ? formulas[i] : texto(v));
  rng.setValues([fila]);
}

// ══════ TAREAS ══════
function hojaTareas() {
  const ss = libro();
  let sh = ss.getSheetByName(HOJA_TAREAS);
  if (!sh) {
    sh = ss.insertSheet(HOJA_TAREAS);
    sh.getRange(1, 1, 1, COLS_TAREAS.length).setValues([COLS_TAREAS])
      .setFontWeight("bold").setBackground("#0D47A1").setFontColor("#ffffff");
    sh.setFrozenRows(1);
    sh.setColumnWidth(4, 260);
    sh.setColumnWidth(5, 360);
  }
  return sh;
}

function listarTareas() {
  const sh = hojaTareas();
  const n = sh.getLastRow() - 1;
  if (n < 1) return { ok: true, tareas: [] };
  const tz = Session.getScriptTimeZone();
  const tareas = sh.getRange(2, 1, n, COLS_TAREAS.length).getValues()
    .filter(r => String(r[0]).trim() !== "")
    .map(r => ({
      id: String(r[0]),
      anio: String(r[1]),
      colegioId: String(r[2]),
      colegio: String(r[3]),
      tarea: String(r[4]),
      fecha: comoFecha(r[5], tz),
      hora: comoHora(r[6], tz),
      hecha: r[7] === true || String(r[7]).toUpperCase() === "TRUE",
      creada: String(r[8]),
      calendario: String(r[9]).trim() !== ""
    }));
  return { ok: true, tareas: tareas };
}

function crearTarea(b) {
  const t = b.tarea || {};
  const textoTarea = String(t.tarea || "").trim().slice(0, 1000);
  if (!textoTarea) throw new Error("La tarea está vacía");
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(t.fecha || "") ? t.fecha : "";
  const hora  = /^\d{2}:\d{2}$/.test(t.hora || "") ? t.hora : "";
  const colegio = String(t.colegio || "").slice(0, 300);

  let evento = "";
  if (t.calendario && fecha && hora) evento = crearEvento(textoTarea, colegio, fecha, hora);

  const tz = Session.getScriptTimeZone();
  const nueva = {
    id: Utilities.getUuid().slice(0, 8),
    anio: String(t.anio || ""),
    colegioId: String(t.colegioId || ""),
    colegio: colegio,
    tarea: textoTarea,
    fecha: fecha,
    hora: hora,
    hecha: false,
    creada: Utilities.formatDate(new Date(), tz, "yyyy-MM-dd HH:mm"),
    calendario: !!evento
  };

  const sh = hojaTareas();
  const fila = sh.getLastRow() + 1;
  // Fecha y hora se guardan como texto para que la hoja no las cambie de formato
  sh.getRange(fila, 1, 1, 7).setNumberFormat("@");
  sh.getRange(fila, 9, 1, 2).setNumberFormat("@");
  sh.getRange(fila, 1, 1, COLS_TAREAS.length).setValues([[
    nueva.id, nueva.anio, texto(nueva.colegioId), texto(nueva.colegio), texto(nueva.tarea),
    nueva.fecha, nueva.hora, false, nueva.creada, evento
  ]]);
  sh.getRange(fila, 8).insertCheckboxes(); // casilla "Hecha" también visible en la hoja
  return { ok: true, tarea: nueva };
}

function actualizarTarea(b) {
  const sh = hojaTareas();
  const fila = filaDeTarea(sh, b.id);
  const hecha = !!b.hecha;
  sh.getRange(fila, 8).setValue(hecha);
  let calendario = String(sh.getRange(fila, 10).getValue()).trim() !== "";
  if (hecha && calendario) {          // si ya la hiciste, el recordatorio de Calendar ya no hace falta
    borrarEvento(sh.getRange(fila, 10).getValue());
    sh.getRange(fila, 10).setValue("");
    calendario = false;
  }
  return { ok: true, id: String(b.id), hecha: hecha, calendario: calendario };
}

function borrarTarea(b) {
  const sh = hojaTareas();
  const fila = filaDeTarea(sh, b.id);
  borrarEvento(sh.getRange(fila, 10).getValue());
  sh.deleteRow(fila);
  return { ok: true, id: String(b.id) };
}

function filaDeTarea(sh, id) {
  const n = sh.getLastRow() - 1;
  if (n >= 1 && id) {
    const ids = sh.getRange(2, 1, n, 1).getValues();
    for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  }
  throw new Error("No se encontró la tarea (puede que ya se haya borrado)");
}

// ══════ GOOGLE CALENDAR (avisa en el celular aunque la app esté cerrada) ══════
function crearEvento(textoTarea, colegio, fecha, hora) {
  const tz = Session.getScriptTimeZone();
  const inicio = Utilities.parseDate(fecha + " " + hora, tz, "yyyy-MM-dd HH:mm");
  const fin = new Date(inicio.getTime() + 15 * 60 * 1000);
  const titulo = "📌 " + textoTarea.slice(0, 80) + (colegio ? " · " + colegio.slice(0, 40) : "");
  const ev = CalendarApp.getDefaultCalendar().createEvent(titulo, inicio, fin, {
    description: (colegio ? "Colegio: " + colegio + "\n\n" : "") + textoTarea + "\n\nCreado desde CRM Colegios"
  });
  ev.removeAllReminders();
  ev.addPopupReminder(10);
  ev.addPopupReminder(0);
  return ev.getId();
}

function borrarEvento(id) {
  if (!id) return;
  try {
    const ev = CalendarApp.getEventById(String(id));
    if (ev) ev.deleteEvent();
  } catch (e) { /* si ya no existe, no pasa nada */ }
}

// ══════ UTILIDADES ══════
let _libro = null;
function libro() {
  if (!_libro) _libro = SpreadsheetApp.openById(SHEET_ID);
  return _libro;
}

function hoja(nombre) {
  const sh = libro().getSheetByName(nombre);
  if (!sh) throw new Error("No existe la hoja " + nombre);
  return sh;
}

function normalizar(arr, largo) {
  const out = [];
  for (let i = 0; i < largo; i++) {
    const v = arr[i];
    out.push(v === null || v === undefined ? "" : v);
  }
  return out;
}

// Evita que un texto que empiece con "=" o "+" se convierta en fórmula
function texto(v) {
  if (typeof v === "string" && /^[=+]/.test(v)) return "'" + v;
  return v;
}

function comoFecha(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, "yyyy-MM-dd");
  return String(v || "").trim();
}

function comoHora(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, "HH:mm");
  return String(v || "").trim();
}

// Evita que dos personas guardando al mismo tiempo se pisen
function conBloqueo(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
