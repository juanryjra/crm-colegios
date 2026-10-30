/* Service worker del CRM Colegios
 *
 * REGLA DE ORO: los datos de los colegios (usuarios, contraseñas, censo) NUNCA se guardan en el
 * celular. Solo se guarda la "carcasa" de la página (diseño, imágenes, librerías) para que abra
 * rápido. Toda petición a Google Apps Script o Power Automate va directo a internet.
 *
 * Para forzar que todos los celulares descarguen una versión nueva de los archivos de apoyo
 * (imágenes, íconos), cambia el número de VERSION.
 */
const VERSION = "v5";
const CACHE = "crm-colegios-" + VERSION;

const PRECARGA = [
  "./",
  "manifest.webmanifest",
  "img/fondo.webp",
  "img/fondo-movil.webp",
  "img/icon-192.png",
  "img/icon-512.png",
  "img/apple-touch-icon.png",
  "img/logo.webp"
];

// Servicios cuyas respuestas jamás se guardan
const SIN_CACHE = ["script.google.com", "script.googleusercontent.com", "googleapis.com/", "powerplatform.com", "powerautomate", "logic.azure.com"];
// Librerías y fuentes públicas que sí conviene guardar
const ESTATICOS = ["cdnjs.cloudflare.com", "cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com", "www.gstatic.com"];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(PRECARGA); })
      .then(function () { return self.skipWaiting(); })
      .catch(function () { /* si algo falla, igual se instala y sigue funcionando en línea */ })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (ks) { return Promise.all(ks.filter(function (k) { return k.indexOf("crm-colegios-") === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;                       // los guardados (POST) van siempre a internet
  var url = new URL(req.url);
  var href = url.hostname + url.pathname;

  if (SIN_CACHE.some(function (d) { return href.indexOf(d) !== -1 || url.hostname.indexOf(d) !== -1; })) return;

  // La página (HTML): primero internet, así siempre ves la última versión; sin internet, la copia guardada
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).then(function (res) {
        var copia = res.clone();
        caches.open(CACHE).then(function (c) { c.put("./", copia); });
        return res;
      }).catch(function () { return caches.match("./"); })
    );
    return;
  }

  // Librerías y fuentes: se sirven de la copia guardada y se actualizan por detrás
  var externo = ESTATICOS.some(function (d) { return url.hostname === d; });
  if (externo || url.origin === location.origin) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        var red = fetch(req).then(function (res) {
          if (res && (res.ok || res.type === "opaque")) { var copia = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copia); }); }
          return res;
        }).catch(function () { return hit; });
        return hit || red;
      })
    );
  }
});

// ── AVISOS CON LA APP CERRADA (Firebase Cloud Messaging) ──
// El Apps Script envía un mensaje de "solo datos"; aquí se convierte en la notificación que ves.
self.addEventListener("push", function (e) {
  var p = {};
  try { p = e.data ? e.data.json() : {}; } catch (err) { p = {}; }
  var d = (p && p.data) || {};
  var n = (p && p.notification) || {};
  var titulo = d.titulo || n.title || "⏰ Tarea pendiente";
  var opciones = {
    body: d.cuerpo || n.body || "Abre el CRM para ver tus tareas",
    icon: "img/icon-192.png",
    badge: "img/icon-192.png",
    tag: d.tag || "tarea",          // misma etiqueta = reemplaza en vez de duplicar
    requireInteraction: true,
    vibrate: [300, 120, 300, 120, 300],
    data: { url: d.url || "./?ir=tareas", id: d.tareaId || "" }
  };
  e.waitUntil(self.registration.showNotification(titulo, opciones));
});

// Al tocar la notificación: se trae la app al frente (o se abre) y se va a Tareas
self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || "./?ir=tareas";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (lista) {
      for (var i = 0; i < lista.length; i++) {
        if ("focus" in lista[i]) { lista[i].postMessage({ tipo: "ir", p: "tareas" }); return lista[i].focus(); }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
