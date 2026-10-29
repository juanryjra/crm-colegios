/* Service worker del CRM Colegios
 *
 * REGLA DE ORO: los datos de los colegios (usuarios, contraseñas, censo) NUNCA se guardan en el
 * celular. Solo se guarda la "carcasa" de la página (diseño, imágenes, librerías) para que abra
 * rápido. Toda petición a Google Apps Script o Power Automate va directo a internet.
 *
 * Para forzar que todos los celulares descarguen una versión nueva de los archivos de apoyo
 * (imágenes, íconos), cambia el número de VERSION.
 */
const VERSION = "v4";
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
const ESTATICOS = ["cdnjs.cloudflare.com", "cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"];

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

// Al tocar una notificación de tarea, se abre (o se trae al frente) la app
self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (lista) {
      for (var i = 0; i < lista.length; i++) { if ("focus" in lista[i]) return lista[i].focus(); }
      if (self.clients.openWindow) return self.clients.openWindow("./");
    })
  );
});
