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
 *     Desde la app (ficha del colegio → lápiz de edición → "Agregar contacto") se agregan filas nuevas
 *     al final de "contactos": A Colegio · B Cargo · C Nombre · D Correo · E Teléfono.
 *   • "Tareas": la crea este script solo, la primera vez que guardes una tarea. No tienes que crearla.
 *
 * NOTIFICACIONES CON LA APP CERRADA (Firebase Cloud Messaging, gratis):
 *   Propiedades de la secuencia de comandos (⚙ Configuración del proyecto):
 *     FIREBASE_WEB_CONFIG = el objeto { apiKey: "...", projectId: "...", ... } de tu app web en Firebase
 *     FIREBASE_VAPID_KEY  = la clave pública "Web Push certificates" de Firebase → Cloud Messaging
 *     FCM_SA_JSON         = el contenido COMPLETO del archivo .json de la cuenta de servicio (clave privada)
 *   Luego ejecuta, en este orden:  revisarPush  →  activarAvisos
 *   (FCM_SA_JSON es secreto: solo vive aquí. Nunca lo pegues en el chat, en el HTML ni en GitHub.)
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

// Cambia este texto cada vez que modifiques el script: sirve para comprobar que la publicación se actualizó
const VERSION_SCRIPT = "avisos-v3 + firma + contactos · 2026-11-11";

const SHEET_ID = "1RCNyiHto-QRJjrdiDO3trl-MajouzlcCLnc1hMW0EIU";

const HOJA_CONTACTOS = "contactos";
const HOJA_CENSO     = "CENSO";
const HOJA_TAREAS    = "Tareas";
// Columna "Firma de componentes …" de la pestaña del año: se busca por su encabezado, esté donde esté
const RE_FIRMA       = /firma\s+de\s+componentes/i;
const OPCIONES_FIRMA = ["No firmado", "Firmado", "Migración", "No Continua"];
const COLS_TAREAS    = ["ID", "Año", "ColegioID", "Colegio", "Tarea", "Fecha", "Hora", "Hecha", "Creada", "Calendario", "Aviso", "PushPrevio", "PushHora"];
const HOJA_DISPOSITIVOS = "Dispositivos";
const COLS_DISP         = ["Token", "Dispositivo", "Registrado"];
const MAX_DISPOSITIVOS  = 10;      // celulares/tablets/PC que pueden recibir avisos
const GRACIA_MIN        = 60;      // si un aviso se atrasó más de esto (por ejemplo, un fallo), ya no se envía
const REVISION_COMPLETA_MIN = 10;  // cada cuánto se relee la hoja aunque no haya nada próximo
const SIN_PENDIENTES    = 8640000000000000; // "no hay avisos próximos"
const ANTICIPO_MS       = 75000;   // el activador corre cada minuto: si un aviso vence en menos de esto, se espera y se envía justo a la hora
const CLAIMS_KEY        = "ESPERANDO";
const MAX_AVISO      = 40320; // minutos (4 semanas, el máximo que permite Calendar)

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
      case "firma":            return json(conBloqueo(() => guardarFirma(body)));
      case "senso":
      case "censo":            return json(conBloqueo(() => guardarCenso(body)));
      case "contacto_crear":   return json(conBloqueo(() => crearContacto(body)));
      case "tareas_listar":    return json(listarTareas());
      case "tarea_crear":      return json(conBloqueo(() => crearTarea(body)));
      case "tarea_actualizar": return json(conBloqueo(() => actualizarTarea(body)));
      case "tarea_borrar":     return json(conBloqueo(() => borrarTarea(body)));
      case "push_config":      return json(pushConfig());
      case "push_registrar":   return json(conBloqueo(() => pushRegistrar(body)));
      case "push_baja":        return json(conBloqueo(() => pushBaja(body)));
      case "push_probar":      return json(pushProbar());
    }
    return json({ ok: false, success: false, error: "Acción desconocida" });
  } catch (err) {
    return json({ ok: false, success: false, error: String(err.message || err) });
  }
}

function doGet() {
  // Abre la dirección /exec en el navegador: esta "version" debe coincidir con la del editor
  return json({ ok: false, error: "Este servicio solo acepta POST", version: VERSION_SCRIPT });
}

// Ejecútala UNA vez desde el editor para dar permiso de Calendar y Sheets
function autorizar() {
  libro().getName();
  CalendarApp.getDefaultCalendar().getName();
  ScriptApp.getProjectTriggers();                 // permiso para programar la revisión de avisos
  try { UrlFetchApp.fetch("https://fcm.googleapis.com/", { muteHttpExceptions: true }); } catch (e) {} // permiso de conexión externa
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
  const d = leerDatosAnio(anio);
  return {
    ok: true,
    anio: anio,
    anios: anios(),
    datos:     d.datos,
    firma:     d.firma,
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
  const sh = hoja(anio), fc = columnaFirma(sh), valores = normalizar(b.valores, 28);
  if (fc && fc.col <= 28) {
    // La columna Firma quedó en medio de los datos: se escribe A:AC respetando su posición y su valor actual
    const rng = sh.getRange(fila + 2, 1, 1, 29);
    const actual = rng.getValues()[0][fc.col - 1];
    escribirConservandoFormulas(rng, valores.slice(0, fc.col - 1).concat([actual], valores.slice(fc.col - 1)), 29);
  } else {
    escribirConservandoFormulas(sh.getRange(fila + 2, 1, 1, 28), valores, 28); // A:AB (la columna Firma no se toca)
  }
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


// ══════ CONTACTOS ══════
// Agrega un contacto al final de la hoja "contactos" (o "contactos 2027" si existe para ese año).
// Columnas: A Colegio · B Cargo · C Nombre · D Correo · E Teléfono
function crearContacto(b) {
  const anio = anioValido(b.anio);
  const c = b.contacto || {};
  const limpio = (v, max) => String(v === null || v === undefined ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);

  const colegio = limpio(c.colegio, 300);
  const nombre  = limpio(c.nombre, 150);
  if (!colegio) throw new Error("Falta el colegio del contacto");
  if (!nombre)  throw new Error("Escribe el nombre del contacto");
  const fila = [colegio, limpio(c.cargo, 150), nombre, limpio(c.correo, 200), limpio(c.telefono, 60)];

  const nombreHoja = hojaDelAnio(HOJA_CONTACTOS, anio);
  const sh = hoja(nombreHoja);

  // Primera fila libre mirando solo A:E (getLastRow se confunde si hay algo escrito en otras columnas)
  let usadas = 0;
  const ultima = sh.getLastRow();
  if (ultima >= 2) {
    const vals = sh.getRange(2, 1, ultima - 1, 5).getDisplayValues();
    usadas = vals.length;
    while (usadas > 0 && vals[usadas - 1].every(v => v === "")) usadas--;

    // Evita duplicados (por ejemplo, si se toca "Guardar" dos veces con mala señal)
    const igual = (x, y) => String(x).trim().toUpperCase() === String(y).trim().toUpperCase();
    for (let i = 0; i < usadas; i++) {
      if (igual(vals[i][0], fila[0]) && igual(vals[i][2], fila[2]) && igual(vals[i][1], fila[1])) {
        throw new Error("Ese contacto ya existe en este colegio");
      }
    }
  }
  // La app lee hasta la fila MAX_FILAS * 3: más allá el contacto se guardaría pero no se vería
  if (usadas >= MAX_FILAS * 3 - 1) throw new Error("La hoja " + nombreHoja + " está llena");

  const destino = usadas + 2;
  // Si la hoja ya no tiene filas en blanco al final, se agregan
  if (destino > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 20);

  const rng = sh.getRange(destino, 1, 1, 5);
  rng.setNumberFormat("@"); // texto: el teléfono se guarda tal cual (con +57, ceros, espacios…)
  rng.setValues([fila.map(texto)]);
  return { ok: true, success: true, hoja: nombreHoja, contacto: fila };
}


// ══════ FIRMA DE COMPONENTES ══════
function columnaFirma(sh) {
  const ultima = sh.getLastColumn();
  if (ultima < 1) return null;
  const enc = sh.getRange(1, 1, 1, ultima).getDisplayValues()[0];
  for (let j = 0; j < enc.length; j++) if (RE_FIRMA.test(String(enc[j]))) return { col: j + 1, titulo: String(enc[j]).trim() };
  return null;
}

// Columna de la hoja donde está el dato número i (0 = ID … 27 = Línea), saltando la de Firma si quedó en medio
function colDato(i, fc) { const c = i + 1; return (fc && fc.col <= c) ? c + 1 : c; }

// Lee los colegios del año: siempre devuelve los 28 datos en el mismo orden + la firma en la posición 28
function leerDatosAnio(anio) {
  const sh = hoja(anio), fc = columnaFirma(sh);
  const ancho = fc ? Math.max(29, fc.col) : 28;
  const vals = sh.getRange(2, 1, MAX_FILAS, ancho).getDisplayValues();
  const filas = vals.map(r => {
    const f = [];
    for (let i = 0; i < 28; i++) f.push(r[colDato(i, fc) - 1]);
    f.push(fc ? r[fc.col - 1] : "");
    return f;
  });
  let n = filas.length;
  while (n > 0 && filas[n - 1].slice(0, 28).every(v => v === "")) n--;   // quita filas vacías al final
  return { datos: filas.slice(0, n), firma: fc ? { titulo: fc.titulo, opciones: OPCIONES_FIRMA } : null };
}

// Guarda solo la celda de la firma (se usa sin activar el modo edición)
function guardarFirma(b) {
  const anio = anioValido(b.anio), sh = hoja(anio), fc = columnaFirma(sh);
  if (!fc) throw new Error('No encontré la columna "Firma de componentes" en la pestaña ' + anio);
  const valor = String(b.valor || "").trim();
  if (OPCIONES_FIRMA.indexOf(valor) < 0) throw new Error("Opción no válida: " + valor);
  const filaHoja = ubicarColegio(sh, fc, Number(b.fila), String(b.id || "").trim(), String(b.nombre || "").trim());
  try { sh.getRange(filaHoja, fc.col).setValue(valor); }
  catch (e) {
    throw new Error('La hoja no aceptó "' + valor + '". Si la columna tiene una lista desplegable, debe incluir exactamente: ' + OPCIONES_FIRMA.join(", "));
  }
  return { ok: true, success: true, valor: valor, hoja: anio };
}

// Confirma que la fila es la del colegio; si las filas se movieron, lo busca por ID (o por nombre si no tiene ID)
function ubicarColegio(sh, fc, fila, id, nombre) {
  const colId = colDato(0, fc), colNom = colDato(2, fc);
  const coincide = f => id
    ? String(sh.getRange(f, colId).getDisplayValue()).trim() === id
    : (!!nombre && String(sh.getRange(f, colNom).getDisplayValue()).trim().toUpperCase() === nombre.toUpperCase());
  if (Number.isInteger(fila) && fila >= 0 && fila < MAX_FILAS && coincide(fila + 2)) return fila + 2;
  const buscado = (id || nombre).toUpperCase(), n = Math.min(sh.getLastRow() - 1, MAX_FILAS);
  if (buscado && n >= 1) {
    const vals = sh.getRange(2, id ? colId : colNom, n, 1).getDisplayValues();
    for (let i = 0; i < vals.length; i++) if (String(vals[i][0]).trim().toUpperCase() === buscado) return i + 2;
  }
  throw new Error("No encontré el colegio en la hoja. Recarga la app e inténtalo de nuevo");
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
  // Hojas creadas con versiones anteriores: se agregan las columnas nuevas sin tocar los datos
  for (let c = 1; c <= COLS_TAREAS.length; c++) {
    const celda = sh.getRange(1, c);
    if (String(celda.getValue()).trim() === "") {
      celda.setValue(COLS_TAREAS[c - 1]).setFontWeight("bold").setBackground("#0D47A1").setFontColor("#ffffff");
    }
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
      calendario: String(r[9]).trim() !== "",
      aviso: Math.max(0, parseInt(r[10], 10) || 0)
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
  const aviso = (fecha && hora) ? Math.max(0, Math.min(MAX_AVISO, parseInt(t.aviso, 10) || 0)) : 0;

  let evento = "";
  if (t.calendario && fecha && hora) evento = crearEvento(textoTarea, colegio, fecha, hora, aviso);

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
    calendario: !!evento,
    aviso: aviso
  };

  const sh = hojaTareas();
  const fila = sh.getLastRow() + 1;
  // Fecha y hora se guardan como texto para que la hoja no las cambie de formato
  sh.getRange(fila, 1, 1, 7).setNumberFormat("@");
  sh.getRange(fila, 9, 1, 2).setNumberFormat("@");
  sh.getRange(fila, 12, 1, 2).setNumberFormat("@");
  sh.getRange(fila, 1, 1, COLS_TAREAS.length).setValues([[
    nueva.id, nueva.anio, texto(nueva.colegioId), texto(nueva.colegio), texto(nueva.tarea),
    nueva.fecha, nueva.hora, false, nueva.creada, evento, aviso, "", ""
  ]]);
  sh.getRange(fila, 8).insertCheckboxes(); // casilla "Hecha" también visible en la hoja
  invalidarProximo();                      // el revisor de avisos vuelve a leer la hoja
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
  invalidarProximo();
  return { ok: true, id: String(b.id), hecha: hecha, calendario: calendario };
}

function borrarTarea(b) {
  const sh = hojaTareas();
  const fila = filaDeTarea(sh, b.id);
  borrarEvento(sh.getRange(fila, 10).getValue());
  sh.deleteRow(fila);
  invalidarProximo();
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
function crearEvento(textoTarea, colegio, fecha, hora, aviso) {
  const tz = Session.getScriptTimeZone();
  const inicio = Utilities.parseDate(fecha + " " + hora, tz, "yyyy-MM-dd HH:mm");
  const fin = new Date(inicio.getTime() + 15 * 60 * 1000);
  const titulo = "📌 " + textoTarea.slice(0, 80) + (colegio ? " · " + colegio.slice(0, 40) : "");
  const ev = CalendarApp.getDefaultCalendar().createEvent(titulo, inicio, fin, {
    description: (colegio ? "Colegio: " + colegio + "\n\n" : "") + textoTarea + "\n\nCreado desde CRM Colegios"
  });
  ev.removeAllReminders();
  if (aviso > 0) ev.addPopupReminder(aviso);  // el aviso previo que elegiste (5 min, 1 hora, 1 día…)
  ev.addPopupReminder(0);                     // y otro a la hora exacta
  return ev.getId();
}

function borrarEvento(id) {
  if (!id) return;
  try {
    const ev = CalendarApp.getEventById(String(id));
    if (ev) ev.deleteEvent();
  } catch (e) { /* si ya no existe, no pasa nada */ }
}


// ══════════════════════════════════════════════════════════════════
//  NOTIFICACIONES PUSH (Firebase Cloud Messaging)
//  La app se registra aquí con un "token" por dispositivo. Un activador revisa cada minuto
//  las tareas y, a la hora del aviso, envía la notificación aunque la app esté cerrada.
// ══════════════════════════════════════════════════════════════════
function ahora() { return Date.now(); }
function prop(k) { return PropertiesService.getScriptProperties().getProperty(k) || ""; }

// Acepta el objeto de Firebase tal cual se copia de la consola (con o sin comillas en las claves)
function leerJsonFlexible(txt) {
  txt = String(txt || "").trim();
  if (!txt) return null;
  txt = txt.replace(/^[^{]*\{/, "{").replace(/\}[^}]*$/, "}");
  try { return JSON.parse(txt); } catch (e) {}
  try { return JSON.parse(txt.replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":').replace(/,\s*\}/g, "}")); } catch (e) { return null; }
}

function configFirebase() {
  let sa = null;
  try { sa = JSON.parse(prop("FCM_SA_JSON")); } catch (e) {}
  return { web: leerJsonFlexible(prop("FIREBASE_WEB_CONFIG")), vapid: prop("FIREBASE_VAPID_KEY").trim(), sa: sa };
}

function pushListo() {
  const c = configFirebase();
  return !!(c.web && c.web.apiKey && c.web.messagingSenderId && c.web.appId && c.vapid &&
            c.sa && c.sa.client_email && c.sa.private_key && c.sa.project_id);
}

// La configuración web de Firebase NO es secreta (viaja en cualquier app web), pero solo se entrega con sesión válida
function pushConfig() {
  const listo = pushListo(), c = configFirebase();
  return { ok: true, configurado: listo, web: listo ? c.web : null, vapid: listo ? c.vapid : null };
}

// Token de acceso de Google para enviar mensajes (firma con la clave de la cuenta de servicio)
function fcmAccessToken(forzar) {
  const cache = CacheService.getScriptCache();
  if (!forzar) { const c = cache.get("fcm_at"); if (c) return c; }
  const sa = configFirebase().sa;
  if (!sa) throw new Error("Falta FCM_SA_JSON en las propiedades del script");
  const b64 = x => Utilities.base64EncodeWebSafe(x).replace(/=+$/, "");
  const t = Math.floor(ahora() / 1000);
  const sinFirma = b64(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." +
    b64(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging",
                         aud: "https://oauth2.googleapis.com/token", iat: t, exp: t + 3600 }));
  const jwt = sinFirma + "." + b64(Utilities.computeRsaSha256Signature(sinFirma, sa.private_key));
  const r = UrlFetchApp.fetch("https://oauth2.googleapis.com/token", {
    method: "post", muteHttpExceptions: true,
    payload: { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }
  });
  let cuerpo = {}; try { cuerpo = JSON.parse(r.getContentText()); } catch (e) {}
  if (r.getResponseCode() !== 200 || !cuerpo.access_token) {
    throw new Error("Google rechazó la clave de servicio: " + (cuerpo.error_description || cuerpo.error || r.getResponseCode()));
  }
  cache.put("fcm_at", cuerpo.access_token, 3300);
  return cuerpo.access_token;
}

// Devuelve "ok", "baja" (el dispositivo ya no existe) o "error: …"
function enviarFcm(token, datos, reintento) {
  const c = configFirebase();
  const d = {}; Object.keys(datos).forEach(k => { d[k] = String(datos[k]); });   // FCM solo acepta texto
  const r = UrlFetchApp.fetch("https://fcm.googleapis.com/v1/projects/" + encodeURIComponent(c.sa.project_id) + "/messages:send", {
    method: "post", contentType: "application/json", muteHttpExceptions: true,
    headers: { Authorization: "Bearer " + fcmAccessToken() },
    payload: JSON.stringify({ message: { token: token, data: d, webpush: { headers: { Urgency: "high", TTL: "3600" } } } })
  });
  const codigo = r.getResponseCode();
  if (codigo >= 200 && codigo < 300) return "ok";
  if (codigo === 401 && !reintento) { CacheService.getScriptCache().remove("fcm_at"); fcmAccessToken(true); return enviarFcm(token, datos, true); }
  let cuerpo = {}; try { cuerpo = JSON.parse(r.getContentText()); } catch (e) {}
  const e = cuerpo.error || {}, det = JSON.stringify(e.details || "");
  if (codigo === 404 || e.status === "NOT_FOUND" || /UNREGISTERED/.test(det) || /registration token is not a valid/i.test(e.message || "")) return "baja";
  return "error: " + codigo + " " + (e.message || "");
}

function hojaDispositivos() {
  const ss = libro();
  let sh = ss.getSheetByName(HOJA_DISPOSITIVOS);
  if (!sh) {
    sh = ss.insertSheet(HOJA_DISPOSITIVOS);
    sh.getRange(1, 1, 1, COLS_DISP.length).setValues([COLS_DISP]).setFontWeight("bold").setBackground("#0D47A1").setFontColor("#ffffff");
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 420);
    sh.setColumnWidth(2, 220);
  }
  return sh;
}

// Envía el mismo aviso a todos los dispositivos registrados y quita los que ya no existen
function enviarATodos(datos) {
  const sh = hojaDispositivos(), n = sh.getLastRow() - 1;
  if (n < 1) return { enviados: 0, dispositivos: 0, errores: [], eliminados: 0 };
  const filas = sh.getRange(2, 1, n, COLS_DISP.length).getValues();
  let enviados = 0, dispositivos = 0; const errores = [], borrar = [];
  filas.forEach((f, i) => {
    const tok = String(f[0]).trim(); if (!tok) return;
    dispositivos++;
    const r = enviarFcm(tok, datos);
    if (r === "ok") enviados++; else if (r === "baja") borrar.push(i + 2); else errores.push(r);
  });
  borrar.reverse().forEach(f => sh.deleteRow(f));
  return { enviados: enviados, dispositivos: dispositivos, errores: errores, eliminados: borrar.length };
}

function pushRegistrar(b) {
  const tok = String(b.fcm || "").trim();
  if (!/^[A-Za-z0-9_\-:.]{50,4096}$/.test(tok)) throw new Error("Token de notificaciones inválido");
  const nombre = texto(String(b.dispositivo || "Dispositivo").slice(0, 60));
  const sh = hojaDispositivos(), n = sh.getLastRow() - 1;
  if (n >= 1) {
    const toks = sh.getRange(2, 1, n, 1).getValues();
    for (let i = 0; i < toks.length; i++) {
      if (String(toks[i][0]) === tok) { sh.getRange(i + 2, 2).setValue(nombre); return { ok: true, nuevo: false }; }
    }
  }
  if (n >= MAX_DISPOSITIVOS) sh.deleteRow(2);              // el más antiguo cede su lugar
  const fila = sh.getLastRow() + 1;
  sh.getRange(fila, 1, 1, COLS_DISP.length).setNumberFormat("@");
  sh.getRange(fila, 1, 1, COLS_DISP.length).setValues([[tok, nombre, Utilities.formatDate(new Date(ahora()), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm")]]);
  return { ok: true, nuevo: true };
}

function pushBaja(b) {
  const tok = String(b.fcm || "").trim();
  const sh = hojaDispositivos(), n = sh.getLastRow() - 1;
  if (n >= 1 && tok) {
    const toks = sh.getRange(2, 1, n, 1).getValues();
    for (let i = toks.length - 1; i >= 0; i--) if (String(toks[i][0]) === tok) sh.deleteRow(i + 2);
  }
  return { ok: true };
}

function pushProbar() {
  if (!pushListo()) return { ok: false, error: "Falta configurar Firebase en las propiedades del Apps Script" };
  const r = enviarATodos({ titulo: "✅ Notificaciones activas", cuerpo: "Así te avisará tu CRM de las tareas pendientes.", tag: "prueba", url: "./?ir=tareas" });
  if (r.dispositivos === 0) return { ok: false, error: "No hay ningún dispositivo registrado todavía" };
  if (r.enviados === 0) return { ok: false, error: "Google no pudo entregar la prueba: " + (r.errores[0] || "sin respuesta") };
  return { ok: true, enviados: r.enviados };
}

// ── Revisión de avisos (la ejecuta el activador cada minuto) ──
function invalidarProximo() { PropertiesService.getScriptProperties().deleteProperty("PROXIMO_AVISO"); }

function textoAviso(min) {
  if (min < 60) return min + (min === 1 ? " minuto" : " minutos");
  if (min < 1440) { const h = Math.round(min / 60); return h + (h === 1 ? " hora" : " horas"); }
  const d = Math.round(min / 1440); return d + (d === 1 ? " día" : " días");
}

function leerClaims(props) { try { return JSON.parse(props.getProperty(CLAIMS_KEY) || "{}") || {}; } catch (e) { return {}; } }

function revisarAvisos() {
  const props = PropertiesService.getScriptProperties();
  const t = ahora();
  const prox = Number(props.getProperty("PROXIMO_AVISO") || 0);
  const ult = Number(props.getProperty("ULTIMO_ESCANEO") || 0);
  // Salida rápida: si no hay nada próximo y se revisó hace poco, no se toca la hoja
  if (prox && t < prox - ANTICIPO_MS && t - ult < REVISION_COMPLETA_MIN * 60000) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  let esperas = [];
  try { esperas = escanearAvisos(props, t); } finally { lock.releaseLock(); }
  // La espera se hace SIN el candado, para no bloquear tus guardados mientras tanto
  if (esperas.length) esperarYEnviar(esperas);
}

// Lee la hoja, envía lo que ya venció y devuelve los avisos que vencen en los próximos segundos
function escanearAvisos(props, t) {
  props.setProperty("ULTIMO_ESCANEO", String(t));
  const sh = libro().getSheetByName(HOJA_TAREAS);
  if (!sh || sh.getLastRow() < 2) { props.setProperty("PROXIMO_AVISO", String(SIN_PENDIENTES)); return []; }
  const tz = Session.getScriptTimeZone(), listo = pushListo();
  const filas = sh.getRange(2, 1, sh.getLastRow() - 1, COLS_TAREAS.length).getValues();
  const marca = Utilities.formatDate(new Date(t), tz, "yyyy-MM-dd HH:mm");
  const claims = leerClaims(props), esperas = [];
  Object.keys(claims).forEach(k => { if (claims[k] < t - 300000) delete claims[k]; });   // reservas viejas
  let proximo = SIN_PENDIENTES;

  filas.forEach((r, i) => {
    const id = String(r[0]).trim();
    if (!id || r[7] === true || String(r[7]).toUpperCase() === "TRUE") return;      // sin ID o ya hecha
    const fecha = comoFecha(r[5], tz), hora = comoHora(r[6], tz);
    if (!fecha || !hora) return;
    let ts; try { ts = Utilities.parseDate(fecha + " " + hora, tz, "yyyy-MM-dd HH:mm").getTime(); } catch (e) { return; }
    const aviso = Math.max(0, parseInt(r[10], 10) || 0), fila = i + 2;
    const tarea = { id: id, tarea: String(r[4]), colegio: String(r[3]) };

    const decidir = (target, col, previo) => {
      if (t >= target) {                                       // ya es la hora (o pasó)
        const aTiempo = previo ? t < ts : (t - ts <= GRACIA_MIN * 60000);
        if (aTiempo && listo) { if (despachar(sh, fila, col, tarea, previo, Math.max(1, Math.round((ts - t) / 60000)), marca)) proximo = Math.min(proximo, t + 60000); }
        else marcarFila(sh, fila, col, "omitido");
      } else if (listo && target - t <= ANTICIPO_MS) {         // falta poco: se espera y se envía justo a la hora
        const clave = id + "|" + (previo ? "p" : "x");
        if (!claims[clave]) {                                  // si otra ejecución ya lo espera, no se duplica la espera
          claims[clave] = target;
          esperas.push({ id: id, clave: clave, previo: previo, target: target, ts: ts, fecha: fecha, hora: hora });
        }
        proximo = Math.min(proximo, target);
      } else proximo = Math.min(proximo, target);
    };
    if (aviso > 0 && String(r[11]).trim() === "") decidir(ts - aviso * 60000, 12, true);   // aviso previo
    if (String(r[12]).trim() === "") decidir(ts, 13, false);                              // hora exacta
  });
  props.setProperty(CLAIMS_KEY, JSON.stringify(claims));
  props.setProperty("PROXIMO_AVISO", String(proximo));
  return esperas;
}

function esperarYEnviar(esperas) {
  esperas.sort((a, b) => a.target - b.target);
  esperas.forEach(e => {
    const falta = e.target - ahora();
    if (falta > 0) Utilities.sleep(Math.min(falta, ANTICIPO_MS));
    enviarSiSigue(e);
  });
  invalidarProximo();      // la próxima ejecución relee la hoja y recalcula lo siguiente
}

// Después de esperar, se vuelve a mirar la hoja: la tarea pudo borrarse, completarse o enviarse ya
function enviarSiSigue(e) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;                  // si no se pudo, el minuto siguiente lo envía (un poco tarde)
  const props = PropertiesService.getScriptProperties();
  try {
    const sh = libro().getSheetByName(HOJA_TAREAS);
    const n = sh ? sh.getLastRow() - 1 : 0;
    if (n >= 1) {
      const tz = Session.getScriptTimeZone();
      const filas = sh.getRange(2, 1, n, COLS_TAREAS.length).getValues();
      const i = filas.findIndex(r => String(r[0]).trim() === e.id);
      if (i >= 0) {
        const r = filas[i], col = e.previo ? 12 : 13;
        const hecha = r[7] === true || String(r[7]).toUpperCase() === "TRUE";
        const igual = comoFecha(r[5], tz) === e.fecha && comoHora(r[6], tz) === e.hora;
        if (!hecha && igual && String(r[col - 1]).trim() === "") {
          const t = ahora();
          despachar(sh, i + 2, col, { id: e.id, tarea: String(r[4]), colegio: String(r[3]) }, e.previo,
                    Math.max(1, Math.round((e.ts - t) / 60000)), Utilities.formatDate(new Date(t), tz, "yyyy-MM-dd HH:mm"));
        }
      }
    }
  } finally {
    const claims = leerClaims(props); delete claims[e.clave]; props.setProperty(CLAIMS_KEY, JSON.stringify(claims));
    lock.releaseLock();
  }
}

function marcarFila(sh, fila, col, valor) { sh.getRange(fila, col).setNumberFormat("@").setValue(valor); }

// Envía y marca como enviado. Devuelve true si hay que reintentar en el próximo minuto
function despachar(sh, fila, col, tarea, previo, minutos, marca) {
  const datos = {
    titulo: previo ? "⏳ En " + textoAviso(minutos) : "⏰ Tarea pendiente",
    cuerpo: tarea.tarea.slice(0, 200) + (tarea.colegio ? "\n" + tarea.colegio.slice(0, 80) : ""),
    tag: "tarea-" + tarea.id + (previo ? "-pre" : ""),
    tareaId: tarea.id,
    url: "./?ir=tareas"
  };
  let r;
  try { r = enviarATodos(datos); } catch (e) { Logger.log("No se pudo enviar: " + e.message); return true; }
  if (r.enviados > 0) { marcarFila(sh, fila, col, marca); return false; }
  if (r.dispositivos === 0) { marcarFila(sh, fila, col, "sin dispositivos"); return false; }
  Logger.log("Aviso no entregado, se reintenta: " + (r.errores[0] || ""));
  return true;                                       // fallo temporal: no se marca, se reintenta
}

// ── Activar / desactivar la revisión cada minuto (se ejecuta UNA vez desde el editor) ──
function activarAvisos() {
  desactivarAvisos(true);
  ScriptApp.newTrigger("revisarAvisos").timeBased().everyMinutes(1).create();
  invalidarProximo();
  Logger.log("✔ Avisos activados: el script revisa tus tareas cada minuto.");
}
function desactivarAvisos(silencioso) {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === "revisarAvisos").forEach(t => ScriptApp.deleteTrigger(t));
  if (!silencioso) Logger.log("✔ Avisos desactivados.");
}

// Revisa la configuración de Firebase. NO muestra ninguna clave.
function revisarPush() {
  Logger.log("Versión del código en el editor: " + VERSION_SCRIPT);
  const c = configFirebase(), w = c.web;
  Logger.log(w && w.apiKey && w.messagingSenderId && w.appId
    ? "✔ FIREBASE_WEB_CONFIG correcto (proyecto: " + w.projectId + ")"
    : "✘ FIREBASE_WEB_CONFIG falta o está mal copiado (debe incluir apiKey, messagingSenderId y appId)");
  Logger.log(c.vapid ? "✔ FIREBASE_VAPID_KEY presente (" + c.vapid.length + " caracteres)" : "✘ Falta FIREBASE_VAPID_KEY");
  if (!c.sa) Logger.log("✘ FCM_SA_JSON falta o no es un JSON válido: pega el contenido COMPLETO del archivo .json");
  else if (!c.sa.client_email || !c.sa.private_key || !c.sa.project_id) Logger.log("✘ FCM_SA_JSON está incompleto (faltan client_email, private_key o project_id)");
  else {
    Logger.log("✔ Clave de servicio presente (proyecto: " + c.sa.project_id + ")");
    if (w && w.projectId && w.projectId !== c.sa.project_id) Logger.log("✘ FIREBASE_WEB_CONFIG y FCM_SA_JSON son de proyectos distintos (" + w.projectId + " ≠ " + c.sa.project_id + ")");
    try { fcmAccessToken(true); Logger.log("✔ Google aceptó la clave de servicio: ya se pueden enviar notificaciones"); }
    catch (e) { Logger.log("✘ " + e.message); }
  }
  const act = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === "revisarAvisos").length;
  Logger.log(act ? "✔ Revisión automática de avisos: ACTIVA" : "✘ Revisión automática de avisos: INACTIVA → ejecuta activarAvisos");
  const sh = libro().getSheetByName(HOJA_DISPOSITIVOS);
  Logger.log("Dispositivos registrados: " + (sh ? Math.max(0, sh.getLastRow() - 1) : 0) + " (se registran al tocar \"Activar\" en la app)");
}

// Envía una notificación de prueba a todos los dispositivos registrados
function probarPush() { Logger.log(JSON.stringify(pushProbar())); }

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

// ══════ HERRAMIENTAS DE REVISIÓN (ejecútalas desde el editor con ▷ Ejecutar) ══════

// Revisa que todo esté bien configurado. NO muestra tu PIN, solo si existe y cómo es.
function revisarConfiguracion() {
  const pin = PropertiesService.getScriptProperties().getProperty("CRM_PIN");
  if (!pin) {
    Logger.log("✘ Falta el PIN: en ⚙ Configuración del proyecto agrega la propiedad CRM_PIN");
  } else {
    Logger.log("✔ PIN configurado: " + pin.length + " caracteres" +
      (pin !== pin.trim() ? "  ✘ TIENE ESPACIOS al inicio o al final: bórralos" : "") +
      (/^\d+$/.test(pin.trim()) ? "" : "  ✘ tiene caracteres que no son números") +
      (pin.trim().length !== 4 ? "  ✘ la app pide exactamente 4 dígitos" : ""));
  }
  const bloqueo = Number(CacheService.getScriptCache().get("intentos") || 0);
  Logger.log(bloqueo >= MAX_INTENTOS ? "✘ PIN bloqueado por intentos fallidos: ejecuta desbloquearPin" : "✔ Intentos fallidos recientes: " + bloqueo);
  try {
    const ss = libro();
    Logger.log("✔ Hoja abierta: " + ss.getName());
    Logger.log("✔ Años encontrados: " + (anios().join(", ") || "ninguno ✘ (crea una pestaña llamada 2026)"));
    [HOJA_CONTACTOS, HOJA_CENSO].forEach(n => Logger.log((ss.getSheetByName(n) ? "✔ " : "✘ Falta la pestaña ") + n));
  } catch (e) {
    Logger.log("✘ No pude abrir la hoja: revisa SHEET_ID. Error: " + e.message);
  }
  Logger.log("Zona horaria del proyecto: " + Session.getScriptTimeZone());
}

// Quita el bloqueo de 15 minutos después de varios intentos fallidos
function desbloquearPin() {
  CacheService.getScriptCache().remove("intentos");
  Logger.log("✔ PIN desbloqueado. Ya puedes volver a intentar.");
}
