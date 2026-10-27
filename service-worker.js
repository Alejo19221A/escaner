// =====================================================================
// service-worker.js – Escáner sin internet (PWA)
// IMPORTANTE: en cada versión nueva, cambia VERSION (el mismo número de app.js).
// Si no se cambia, los celulares NO reciben la versión nueva.
// LIBRERIAS solo se cambia si se reemplaza o se agrega una librería en libs/.
// =====================================================================
const VERSION = '2.4.1';
const LIBRERIAS = '1';
const CACHE_APP = `escaner-app-${VERSION}`;
const CACHE_LIBS = `escaner-libs-${LIBRERIAS}`;

// Archivos de la app (se descargan de nuevo en cada versión)
const ARCHIVOS_APP = [
  'index.html',
  'estilos.css',
  'app.js',
  'historial.js',
  'manifest.json',
  'iconos/icono-192.png',
  'iconos/icono-512.png',
  'iconos/icono-maskable-512.png',
  'iconos/favicon-32.png'
];

// Librerías (se descargan una sola vez: pesan unos 15 MB)
const ARCHIVOS_LIBS = [
  'libs/jspdf.umd.min.js',
  'libs/jszip.min.js',
  'libs/opencv.js',
  'libs/pdfjs/pdf.min.js',
  'libs/pdfjs/pdf.worker.min.js',
  'libs/tesseract/tesseract.min.js',
  'libs/tesseract/worker.min.js',
  'libs/tesseract/tesseract-core-lstm.wasm.js',
  'libs/tesseract/tesseract-core-simd-lstm.wasm.js',
  'libs/tesseract/spa.traineddata.gz'
];

// Instalar: guardar todo en el celular
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const libs = await caches.open(CACHE_LIBS);
    for (const ruta of ARCHIVOS_LIBS) {
      if (await libs.match(ruta)) continue; // ya estaba guardada
      const respuesta = await fetch(new Request(ruta, { cache: 'reload' }));
      if (!respuesta.ok) throw new Error(`No se pudo guardar ${ruta}`);
      await libs.put(ruta, respuesta);
    }
    const app = await caches.open(CACHE_APP);
    await app.addAll(ARCHIVOS_APP.map(ruta => new Request(ruta, { cache: 'reload' })));
  })());
});

// Activar: borrar las copias de versiones anteriores
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const nombres = await caches.keys();
    await Promise.all(nombres
      .filter(n => n.startsWith('escaner-') && n !== CACHE_APP && n !== CACHE_LIBS)
      .map(n => caches.delete(n)));
  })());
});

// La app pide actualizarse cuando la persona toca "Actualizar"
self.addEventListener('message', e => {
  if (e.data === 'actualizar') self.skipWaiting();
});

// Cada archivo que pide la app: primero la copia del celular; si no está, internet
self.addEventListener('fetch', e => {
  const pedido = e.request;
  if (pedido.method !== 'GET' || !pedido.url.startsWith(self.registration.scope)) return;
  e.respondWith((async () => {
    const app = await caches.open(CACHE_APP);
    if (pedido.mode === 'navigate') { // abrir la app (con o sin ?r=1)
      return (await app.match('index.html')) || fetch(pedido);
    }
    const opciones = { ignoreSearch: true }; // estilos.css?v=2.4 = estilos.css
    const guardado = (await app.match(pedido, opciones)) ||
      (await (await caches.open(CACHE_LIBS)).match(pedido, opciones));
    return guardado || fetch(pedido);
  })());
});