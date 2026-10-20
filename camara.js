// ===== Cámara en vivo: marca la hoja mientras apuntas y toma la foto sola =====
const UMBRAL_NITIDEZ = 40; // menor = acepta fotos más borrosas (se puede ajustar)
const FRAMES_QUIETO = 5;   // detecciones seguidas sin moverse para disparar solo (~1 segundo)

const vivo = {
  stream: null, track: null, captura: null, activo: false, ocupado: false,
  auto: localStorage.getItem('autoDisparo') !== 'no',
  linterna: false, ultimaQuad: null, historial: [], ultimaCapturada: null, tomadas: 0
};

const elVivo = document.getElementById('camaraVivo');
const vivoMarco = document.getElementById('vivoMarco');
const video = document.getElementById('video');
const capa = document.getElementById('capa');
const ctxCapa = capa.getContext('2d');
const vivoMensaje = document.getElementById('vivoMensaje');
const btnAuto = document.getElementById('vivoAuto');
const btnLinterna = document.getElementById('vivoLinterna');
const lienzoDeteccion = document.createElement('canvas');
const ctxDeteccion = lienzoDeteccion.getContext('2d', { willReadFrequently: true });

function camaraEnVivoDisponible() {
  return window.isSecureContext && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

// Botón principal: cámara en vivo; si no se puede, la cámara normal del celular
document.getElementById('btnEscanear').addEventListener('click', async () => {
  if (!camaraEnVivoDisponible()) {
    camara.setAttribute('capture', 'environment');
    camara.click();
    camara.removeAttribute('capture');
    return;
  }
  try {
    await abrirVivo();
  } catch (err) {
    console.error(err);
    cerrarVivo();
    estado.textContent = '⚠️ No se pudo abrir la cámara en vivo. Usa "Usar foto de la galería".';
  }
});

async function abrirVivo() {
  vivo.stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } }
  });
  vivo.track = vivo.stream.getVideoTracks()[0];
  video.srcObject = vivo.stream;
  await video.play();

  // Foto en máxima resolución (Android Chrome); en otros, se usa el cuadro del video
  vivo.captura = ('ImageCapture' in window) ? new ImageCapture(vivo.track) : null;

  // Linterna: solo si el celular la permite
  const capacidades = vivo.track.getCapabilities ? vivo.track.getCapabilities() : {};
  btnLinterna.style.display = capacidades.torch ? '' : 'none';
  vivo.linterna = false;
  btnLinterna.classList.remove('activo');

  vivo.activo = true;
  vivo.ocupado = false;
  vivo.historial = [];
  vivo.ultimaQuad = null;
  vivo.ultimaCapturada = null;
  vivo.tomadas = 0;
  actualizarContador();
  actualizarBotonAuto();
  elVivo.classList.add('visible');
  ajustarTamano();
  mensajeVivo(opencvListo ? 'Apunta a la hoja' : '⏳ Cargando detector... puedes tomar la foto con el botón');
  detectarEnVivo();
}

function cerrarVivo() {
  vivo.activo = false;
  if (vivo.stream) vivo.stream.getTracks().forEach(t => t.stop());
  vivo.stream = null;
  vivo.track = null;
  video.srcObject = null;
  elVivo.classList.remove('visible');
  if (vivo.tomadas) estado.textContent = `✅ ${paginas.length} ${paginas.length === 1 ? 'página' : 'páginas'} lista(s)`;
}

function mensajeVivo(texto) { vivoMensaje.textContent = texto; }
function actualizarContador() { document.getElementById('vivoContador').textContent = paginas.length; }
function actualizarBotonAuto() {
  btnAuto.textContent = vivo.auto ? '🤖 Auto: Sí' : '🤖 Auto: No';
  btnAuto.classList.toggle('activo', vivo.auto);
}

// Tamaño del video en pantalla (y la capa donde se dibuja el recuadro)
function ajustarTamano() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw) return;
  const maxW = window.innerWidth - 16, maxH = window.innerHeight * 0.66;
  const w = Math.min(maxW, maxH * vw / vh), h = w * vh / vw;
  [vivoMarco, video, capa].forEach(el => { el.style.width = w + 'px'; el.style.height = h + 'px'; });
  const dpr = window.devicePixelRatio || 1;
  capa.width = Math.round(w * dpr);
  capa.height = Math.round(h * dpr);
}
video.addEventListener('loadedmetadata', ajustarTamano);
window.addEventListener('resize', () => { if (vivo.activo) ajustarTamano(); });

// Bucle: busca la hoja unas 4-5 veces por segundo
function detectarEnVivo() {
  if (!vivo.activo) return;
  if (!vivo.ocupado && opencvListo && video.videoWidth) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const esc = 480 / Math.max(vw, vh);
    lienzoDeteccion.width = Math.round(vw * esc);
    lienzoDeteccion.height = Math.round(vh * esc);
    ctxDeteccion.drawImage(video, 0, 0, lienzoDeteccion.width, lienzoDeteccion.height);
    let quad = null;
    try { quad = detectarEsquinas(lienzoDeteccion, 480); } catch (err) { console.error(err); }
    vivo.ultimaQuad = quad ? quad.map(p => ({ x: p.x / esc, y: p.y / esc })) : null;
    revisarEstabilidad();
    dibujarCapa();
  }
  setTimeout(detectarEnVivo, 200);
}

// Diferencia máxima entre dos recuadros (en proporción al tamaño del video)
function diferencia(a, b) {
  const diag = Math.hypot(video.videoWidth, video.videoHeight);
  return Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y))) / diag;
}

function revisarEstabilidad() {
  const q = vivo.ultimaQuad;
  if (!q) {
    vivo.historial = [];
    vivo.ultimaCapturada = null; // al quitar la hoja, queda listo para la siguiente
    mensajeVivo('🔍 Apunta a la hoja (mejor sobre un fondo oscuro)');
    return;
  }

  // ¿Es la misma hoja que acabamos de tomar? Esperar a que cambie
  if (vivo.ultimaCapturada) {
    if (diferencia(q, vivo.ultimaCapturada) > 0.1) vivo.ultimaCapturada = null;
    else {
      vivo.historial = [];
      mensajeVivo('✅ Guardada. Pon la siguiente hoja o toca Terminar');
      return;
    }
  }

  const anterior = vivo.historial[vivo.historial.length - 1];
  if (anterior && diferencia(q, anterior) < 0.015) vivo.historial.push(q);
  else vivo.historial = [q];

  const quieto = vivo.historial.length >= FRAMES_QUIETO;
  if (vivo.auto && quieto) {
    mensajeVivo('📸 ¡Quieto! Tomando foto...');
    disparar(true);
  } else {
    mensajeVivo(vivo.auto ? '📄 Hoja detectada: quédate quieto...' : '📄 Hoja detectada: toca el botón');
  }
}

function dibujarCapa() {
  ctxCapa.clearRect(0, 0, capa.width, capa.height);
  const q = vivo.ultimaQuad;
  if (!q || !video.videoWidth) return;
  const s = capa.width / video.videoWidth;
  const listo = vivo.historial.length >= FRAMES_QUIETO - 1;
  const dpr = window.devicePixelRatio || 1;
  ctxCapa.beginPath();
  q.forEach((p, i) => i ? ctxCapa.lineTo(p.x * s, p.y * s) : ctxCapa.moveTo(p.x * s, p.y * s));
  ctxCapa.closePath();
  ctxCapa.fillStyle = listo ? 'rgba(52,168,83,0.3)' : 'rgba(26,115,232,0.2)';
  ctxCapa.fill();
  ctxCapa.strokeStyle = listo ? '#34a853' : '#1a73e8';
  ctxCapa.lineWidth = 4 * dpr;
  ctxCapa.stroke();
}

// Toma la foto con la mayor resolución posible
async function tomarFotoAltaCalidad() {
  if (vivo.captura) {
    try {
      const capacidades = await vivo.captura.getPhotoCapabilities();
      const blob = await vivo.captura.takePhoto({ imageWidth: capacidades.imageWidth.max });
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      bmp.close();
      if (vivo.linterna) { // algunos celulares apagan la linterna al tomar la foto
        vivo.track.applyConstraints({ advanced: [{ torch: true }] }).catch(() => {});
      }
      return c;
    } catch (err) {
      console.warn('takePhoto no funcionó, se usa el video', err);
    }
  }
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  return c;
}

// Mide qué tan nítida está la hoja (varianza del Laplaciano)
function medirNitidez(base, esquinas) {
  if (!opencvListo) return 999;
  const xs = esquinas.map(p => p.x), ys = esquinas.map(p => p.y);
  const x0 = Math.max(0, Math.min(...xs)), y0 = Math.max(0, Math.min(...ys));
  const w = Math.min(base.width, Math.max(...xs)) - x0, h = Math.min(base.height, Math.max(...ys)) - y0;
  if (w < 50 || h < 50) return 999;
  const esc = Math.min(1, 1000 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * esc);
  c.height = Math.round(h * esc);
  c.getContext('2d').drawImage(base, x0, y0, w, h, 0, 0, c.width, c.height);
  const src = cv.imread(c), gris = new cv.Mat(), lap = new cv.Mat(), media = new cv.Mat(), desv = new cv.Mat();
  cv.cvtColor(src, gris, cv.COLOR_RGBA2GRAY);
  cv.Laplacian(gris, lap, cv.CV_64F);
  cv.meanStdDev(lap, media, desv);
  const valor = desv.data64F[0] ** 2;
  [src, gris, lap, media, desv].forEach(m => m.delete());
  liberar(c);
  console.log('Nitidez:', Math.round(valor));
  return valor;
}

function destello() {
  const d = document.getElementById('destello');
  d.classList.add('activo');
  setTimeout(() => d.classList.remove('activo'), 120);
  if (navigator.vibrate) navigator.vibrate(60);
}

async function disparar(automatico) {
  if (vivo.ocupado || !vivo.activo) return;
  vivo.ocupado = true;
  const quadVivo = vivo.ultimaQuad;
  destello();
  let foto = null, base = null;
  try {
    foto = await tomarFotoAltaCalidad();
    base = reducirImagen(foto);

    // Esquinas: detectar otra vez en la foto grande (más precisa)
    let esquinas = opencvListo ? detectarEsquinas(base) : null;
    if (!esquinas && quadVivo) {
      // Si la foto tiene la misma forma que el video, usar el recuadro del video
      const mismaForma = Math.abs(base.width / base.height - video.videoWidth / video.videoHeight) < 0.03;
      if (mismaForma) {
        const f = base.width / video.videoWidth;
        esquinas = quadVivo.map(p => ({ x: p.x * f, y: p.y * f }));
      }
    }
    if (!esquinas) esquinas = esquinasCompletas(base);

    // ¿Salió borrosa?
    if (medirNitidez(base, esquinas) < UMBRAL_NITIDEZ) {
      if (automatico) {
        mensajeVivo('⚠️ Salió borrosa. Quédate quieto, la repito...');
        vivo.historial = [];
        return;
      }
      if (!confirm('⚠️ La foto salió borrosa.\n¿Usarla de todas formas?')) return;
    }

    vivo.ultimaCapturada = quadVivo;
    mensajeVivo('⏳ Guardando página...');
    await enCola(() => agregarPagina(base, opencvListo ? esquinas : null));
    vivo.tomadas++;
    actualizarContador();
    mensajeVivo('✅ Guardada. Pon la siguiente hoja o toca Terminar');
  } catch (err) {
    console.error(err);
    mensajeVivo('❌ No se pudo tomar la foto. Intenta de nuevo');
  } finally {
    liberar(foto);
    liberar(base);
    vivo.historial = [];
    vivo.ocupado = false;
  }
}

// Botones de la cámara en vivo
document.getElementById('vivoDisparar').addEventListener('click', () => disparar(false));
document.getElementById('vivoTerminar').addEventListener('click', cerrarVivo);

btnAuto.addEventListener('click', () => {
  vivo.auto = !vivo.auto;
  localStorage.setItem('autoDisparo', vivo.auto ? 'si' : 'no');
  vivo.historial = [];
  actualizarBotonAuto();
});

btnLinterna.addEventListener('click', async () => {
  if (!vivo.track) return;
  vivo.linterna = !vivo.linterna;
  try {
    await vivo.track.applyConstraints({ advanced: [{ torch: vivo.linterna }] });
  } catch {
    vivo.linterna = false;
  }
  btnLinterna.classList.toggle('activo', vivo.linterna);
});

// Si el celular se bloquea o cambian de app, apagar la cámara
document.addEventListener('visibilitychange', () => {
  if (document.hidden && vivo.activo) cerrarVivo();
});