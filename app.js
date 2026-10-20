const VERSION = '1.1';
const DPI = 200; // calidad de cada hoja en el PDF (como un escáner de oficina)

// Cada página: { baseBlob, esquinas, recBlob, finalBlob, finalURL, ancho, alto, formato, lectura }
// Se guardan comprimidas (Blob) para no llenar la memoria del celular
const paginas = [];
let modo = 'color';
let tipoDoc = localStorage.getItem('tipoDoc') || 'normal'; // 'normal' o 'paciente'
const estado = document.getElementById('estado');
const camara = document.getElementById('camara');
document.getElementById('version').textContent = `Versión ${VERSION}`;

// ---------- 1. Esperar a que OpenCV cargue (sin bloquear la app) ----------
let opencvListo = false;
estado.textContent = '⏳ Cargando recorte automático... (ya puedes escanear)';

function revisarOpenCV() {
  const c = window.cv;
  if (c && c.Mat) {
    opencvListo = true;
    estado.textContent = '✅ Listo para escanear';
    return;
  }
  if (c && !c._esperando && typeof c.then === 'function') {
    c._esperando = true;
    c.then(m => { if (m && m.Mat) window.cv = m; });
  }
  setTimeout(revisarOpenCV, 300);
}
revisarOpenCV();

setTimeout(() => {
  if (!opencvListo) estado.textContent =
    '⚠️ El recorte automático no cargó. Puedes escanear igual, pero sin recortar la hoja.';
}, 30000);

// ---------- Ayudantes para ahorrar memoria ----------
function aBlob(canvas, calidad = 0.95) {
  return new Promise(r => canvas.toBlob(r, 'image/jpeg', calidad));
}
async function aCanvas(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  return c;
}
function liberar(c) { if (c) { c.width = 0; c.height = 0; } }

// ---------- 2. Tipo de documento: normal o paciente ----------
function marcarTipo() {
  document.querySelectorAll('.tipo').forEach(b =>
    b.classList.toggle('activo', b.dataset.tipo === tipoDoc));
}
document.querySelectorAll('.tipo').forEach(boton => {
  boton.addEventListener('click', () => {
    tipoDoc = boton.dataset.tipo;
    localStorage.setItem('tipoDoc', tipoDoc);
    marcarTipo();
    if (tipoDoc === 'paciente' && paginas.length) leerPagina(paginas[0]);
  });
});
marcarTipo();

// ---------- 3. Agregar páginas (desde la galería o la cámara en vivo) ----------
// Las tareas pesadas van en fila, una después de otra
let cola = Promise.resolve();
function enCola(tarea) {
  cola = cola.then(tarea).catch(err => console.error(err));
  return cola;
}

camara.addEventListener('change', (e) => {
  const archivo = e.target.files[0];
  e.target.value = '';
  if (!archivo) return;
  enCola(() => manejarFoto(archivo));
});

// Foto de la galería: detecta la hoja y abre el editor para revisar
async function manejarFoto(archivo) {
  await mostrarCargando(true);
  let base = null;
  try {
    const img = await cargarImagen(archivo);
    base = reducirImagen(img);
    URL.revokeObjectURL(img.src);
    let esquinas = null;

    if (opencvListo) {
      const detectadas = detectarEsquinas(base);
      mostrarCargando(false);
      esquinas = await abrirEditor(base, detectadas || esquinasPorDefecto(base),
        detectadas ? '✅ Hoja detectada: revisa el recuadro'
                   : '✋ No encontré la hoja: ajusta el recuadro',
        true);
      if (!esquinas) { estado.textContent = 'Foto descartada'; return; }
      await mostrarCargando(true);
    }

    await agregarPagina(base, esquinas);
  } catch (err) {
    console.error(err);
    estado.textContent = '❌ Hubo un error procesando la foto. Intenta de nuevo.';
  } finally {
    liberar(base);
    mostrarCargando(false);
  }
}

// Agrega una página con su recorte (la usan la galería y la cámara en vivo)
async function agregarPagina(base, esquinas) {
  const pagina = { baseBlob: await aBlob(base), esquinas };
  await procesarPagina(pagina, base);
  paginas.push(pagina);
  estado.textContent = esquinas
    ? `✅ Página ${paginas.length} agregada (${pagina.formato})`
    : `📄 Página ${paginas.length} agregada (sin recorte)`;
  mostrarPaginas();
  if (paginas.length === 1 && tipoDoc === 'paciente') leerPagina(paginas[0]); // lee la cédula en segundo plano
  return pagina;
}

function cargarImagen(archivo) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.src = URL.createObjectURL(archivo);
  });
}

// Reduce solo si la foto es gigante (celulares con más memoria trabajan con más resolución)
function reducirImagen(img) {
  const max = (navigator.deviceMemory || 4) >= 4 ? 4000 : 3000;
  const esc = Math.min(1, max / Math.max(img.width, img.height));
  const base = document.createElement('canvas');
  base.width = Math.round(img.width * esc);
  base.height = Math.round(img.height * esc);
  const ctx = base.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, base.width, base.height);
  return base;
}

// Recorta, endereza y aplica el filtro a una página
async function procesarPagina(pag, base) {
  const rec = pag.esquinas ? enderezar(base, pag.esquinas) : base;
  pag.recBlob = await aBlob(rec);
  pag.lectura = null; // si cambió el recorte, hay que volver a leer la cédula
  await aplicarModo(pag, rec);
  if (rec !== base) liberar(rec);
}

// ---------- 4. Detectar la hoja automáticamente ----------
// tamano: resolución de trabajo (800 para fotos, menos para la cámara en vivo)
function detectarEsquinas(base, tamano = 800) {
  const src = cv.imread(base);
  const escala = tamano / Math.max(src.cols, src.rows);
  const peque = new cv.Mat(), rgb = new cv.Mat(), gris = new cv.Mat(), hsv = new cv.Mat();
  cv.resize(src, peque, new cv.Size(Math.round(src.cols * escala), Math.round(src.rows * escala)),
    0, 0, cv.INTER_AREA);
  cv.cvtColor(peque, rgb, cv.COLOR_RGBA2RGB);
  cv.cvtColor(rgb, gris, cv.COLOR_RGB2GRAY);
  cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
  cv.GaussianBlur(gris, gris, new cv.Size(5, 5), 0);
  const areaTotal = gris.rows * gris.cols;

  // Realzar contraste local: hace visibles los bordes de hoja blanca sobre fondo claro
  const realzado = new cv.Mat();
  const clahe = new cv.CLAHE(3.0, new cv.Size(8, 8));
  clahe.apply(gris, realzado);
  clahe.delete();

  // Mapa de bordes para calificar a los candidatos
  const mapaBordes = new cv.Mat();
  const k5 = cv.Mat.ones(5, 5, cv.CV_8U);
  cv.Canny(realzado, mapaBordes, 30, 90);
  cv.dilate(mapaBordes, mapaBordes, k5);

  const candidatos = [];
  const tamCierre = Math.max(9, Math.round(21 * tamano / 800)) | 1; // siempre impar
  const kCierre = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(tamCierre, tamCierre));
  const k3 = cv.Mat.ones(3, 3, cv.CV_8U);

  // Forma A: la hoja es una zona clara
  const claro = new cv.Mat();
  const umbral = cv.threshold(gris, claro, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  cv.morphologyEx(claro, claro, cv.MORPH_CLOSE, kCierre);
  candidatos.push(...cuadrilateros(claro, areaTotal));

  // Forma B: la hoja es clara y sin color (blanca)
  const blanco = new cv.Mat();
  const bajo = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, 0, Math.max(90, umbral - 30), 0]);
  const alto = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [180, 80, 255, 0]);
  cv.inRange(hsv, bajo, alto, blanco);
  cv.morphologyEx(blanco, blanco, cv.MORPH_CLOSE, kCierre);
  candidatos.push(...cuadrilateros(blanco, areaTotal));

  // Formas C a F: líneas de borde, en la foto normal y en la realzada
  const pruebas = [[gris, 40, 120], [gris, 75, 200], [realzado, 20, 60], [realzado, 40, 120]];
  for (const [imagen, t1, t2] of pruebas) {
    const bordes = new cv.Mat();
    cv.Canny(imagen, bordes, t1, t2);
    cv.dilate(bordes, bordes, k3);
    cv.morphologyEx(bordes, bordes, cv.MORPH_CLOSE, kCierre);
    candidatos.push(...cuadrilateros(bordes, areaTotal));
    bordes.delete();
  }

  // Elegir el candidato con mejor puntaje
  let mejor = null, mejorPuntaje = 0;
  for (const q of candidatos) {
    const p = puntaje(q, gris, mapaBordes, areaTotal);
    if (p > mejorPuntaje) { mejorPuntaje = p; mejor = q; }
  }

  [src, peque, rgb, gris, hsv, realzado, mapaBordes, k5, claro, blanco, bajo, alto, kCierre, k3]
    .forEach(m => m.delete());
  if (!mejor) return null;

  const lim = (v, max) => Math.min(max, Math.max(0, v));
  return ordenarEsquinas(mejor.map(p => ({
    x: lim(p.x / escala, base.width),
    y: lim(p.y / escala, base.height)
  })));
}

// Saca figuras de 4 lados de las manchas más grandes
function cuadrilateros(binaria, areaTotal) {
  const conMarco = new cv.Mat();
  cv.copyMakeBorder(binaria, conMarco, 2, 2, 2, 2, cv.BORDER_CONSTANT, new cv.Scalar(0));
  const contornos = new cv.MatVector(), jerarquia = new cv.Mat();
  cv.findContours(conMarco, contornos, jerarquia, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  const lista = [];
  for (let i = 0; i < contornos.size(); i++) {
    const c = contornos.get(i);
    const area = cv.contourArea(c);
    if (area > areaTotal * 0.15) lista.push({ i, area });
    c.delete();
  }
  lista.sort((a, b) => b.area - a.area);

  const resultado = [];
  for (const { i } of lista.slice(0, 3)) {
    const c = contornos.get(i);
    const casco = new cv.Mat();
    cv.convexHull(c, casco, false, true);
    const peri = cv.arcLength(casco, true);
    let q = null;
    for (let eps = 0.01; eps <= 0.1 && !q; eps += 0.01) {
      const aprox = new cv.Mat();
      cv.approxPolyDP(casco, aprox, eps * peri, true);
      if (aprox.rows === 4) {
        q = [];
        for (let j = 0; j < 4; j++) {
          q.push({ x: aprox.data32S[j * 2] - 2, y: aprox.data32S[j * 2 + 1] - 2 });
        }
      }
      aprox.delete();
    }
    if (q) resultado.push(q);
    const rect = cv.minAreaRect(casco);
    resultado.push(cv.RotatedRect.points(rect).map(p => ({ x: p.x - 2, y: p.y - 2 })));
    c.delete(); casco.delete();
  }
  [conMarco, contornos, jerarquia].forEach(m => m.delete());
  return resultado;
}

// Califica qué tanto parece una hoja
function puntaje(q, gris, mapaBordes, areaTotal) {
  const o = ordenarEsquinas(q);

  // 1. Ángulos cercanos a 90°
  let factorAngulos = 1;
  for (let i = 0; i < 4; i++) {
    const a = o[(i + 3) % 4], b = o[i], c = o[(i + 1) % 4];
    const v1 = { x: a.x - b.x, y: a.y - b.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
    const cos = (v1.x * v2.x + v1.y * v2.y) /
                (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) + 1e-6);
    const desvio = Math.abs(Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI - 90);
    if (desvio > 40) return 0;
    factorAngulos *= 1 - desvio / 60;
  }

  // 2. Tamaño
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const p1 = o[i], p2 = o[(i + 1) % 4];
    area += p1.x * p2.y - p2.x * p1.y;
  }
  const fraccion = Math.abs(area) / 2 / areaTotal;
  if (fraccion < 0.15 || fraccion > 0.99) return 0;

  // 3. ¿Los 4 lados caen sobre líneas reales de la foto?
  const W = mapaBordes.cols, H = mapaBordes.rows;
  let total = 0, aciertos = 0;
  for (let i = 0; i < 4; i++) {
    const a = o[i], b = o[(i + 1) % 4];
    for (let t = 0; t <= 1; t += 0.02) {
      const x = Math.round(a.x + (b.x - a.x) * t);
      const y = Math.round(a.y + (b.y - a.y) * t);
      total++;
      if (x <= 3 || y <= 3 || x >= W - 4 || y >= H - 4) aciertos += 0.6; // hoja cortada por la foto
      else if (mapaBordes.data[y * W + x] > 0) aciertos++;
    }
  }
  const soporte = aciertos / total;
  if (soporte < 0.45) return 0;

  // 4. Contraste: lo de adentro (papel) suele ser más claro que lo de afuera
  const mascara = cv.Mat.zeros(gris.rows, gris.cols, cv.CV_8U);
  const poli = cv.matFromArray(4, 1, cv.CV_32SC2,
    o.flatMap(p => [Math.round(p.x), Math.round(p.y)]));
  const mv = new cv.MatVector();
  mv.push_back(poli);
  cv.fillPoly(mascara, mv, new cv.Scalar(255));
  const k = cv.Mat.ones(11, 11, cv.CV_8U);
  const dentro = new cv.Mat(), fuera = new cv.Mat(), tmp = new cv.Mat();
  cv.erode(mascara, tmp, k);
  cv.subtract(mascara, tmp, dentro);
  cv.dilate(mascara, tmp, k);
  cv.subtract(tmp, mascara, fuera);
  const mDentro = cv.mean(gris, dentro)[0];
  const mFuera = cv.countNonZero(fuera) > 50 ? cv.mean(gris, fuera)[0] : mDentro;
  [mascara, poli, mv, k, dentro, fuera, tmp].forEach(m => m.delete());

  const contraste = mDentro - mFuera;
  if (contraste < -15) return 0;
  const factorContraste = 1 + Math.max(0, contraste) / 40;

  return soporte * soporte * Math.sqrt(fraccion) * factorAngulos * factorContraste;
}

function ordenarEsquinas(p) {
  const suma = p.map(q => q.x + q.y);
  const resta = p.map(q => q.y - q.x);
  return [
    p[suma.indexOf(Math.min(...suma))],   // arriba-izquierda
    p[resta.indexOf(Math.min(...resta))], // arriba-derecha
    p[suma.indexOf(Math.max(...suma))],   // abajo-derecha
    p[resta.indexOf(Math.max(...resta))]  // abajo-izquierda
  ];
}

function esquinasPorDefecto(base) {
  const mx = base.width * 0.08, my = base.height * 0.08;
  return [
    { x: mx, y: my }, { x: base.width - mx, y: my },
    { x: base.width - mx, y: base.height - my }, { x: mx, y: base.height - my }
  ];
}

function esquinasCompletas(base) {
  return [
    { x: 0, y: 0 }, { x: base.width, y: 0 },
    { x: base.width, y: base.height }, { x: 0, y: base.height }
  ];
}

// ---------- 5. Editor: mover esquinas y lados (con lupa) ----------
function abrirEditor(base, esquinasIniciales, mensaje, permitirOtra = false) {
  return new Promise(resolve => {
    const editor = document.getElementById('editor');
    const lienzo = document.getElementById('lienzo');
    const ctx = lienzo.getContext('2d');
    document.getElementById('edMensaje').textContent = mensaje;
    document.getElementById('edOtra').style.display = permitirOtra ? '' : 'none';
    editor.classList.add('visible');

    // Tamaño en pantalla
    const dpr = window.devicePixelRatio || 1;
    const proporcion = base.width / base.height;
    const maxW = window.innerWidth - 20, maxH = window.innerHeight * 0.6;
    const w = Math.min(maxW, maxH * proporcion), h = w / proporcion;
    lienzo.style.width = w + 'px';
    lienzo.style.height = h + 'px';
    lienzo.width = Math.round(w * dpr);
    lienzo.height = Math.round(h * dpr);
    const s = lienzo.width / base.width; // de la foto al lienzo

    // Copia reducida para dibujar rápido
    const vista = document.createElement('canvas');
    vista.width = lienzo.width;
    vista.height = lienzo.height;
    const vctx = vista.getContext('2d');
    vctx.imageSmoothingQuality = 'high';
    vctx.drawImage(base, 0, 0, vista.width, vista.height);

    let pts = esquinasIniciales.map(p => ({ ...p }));
    let arrastre = null; // lo que se está arrastrando: una esquina o un lado

    const lim = (v, max) => Math.min(max, Math.max(0, v));
    const medio = i => {
      const a = pts[i], b = pts[(i + 1) % 4];
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    };

    function rectRedondo(x, y, ancho, alto, radio) {
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, ancho, alto, radio);
      else ctx.rect(x, y, ancho, alto);
    }

    function dibujar() {
      ctx.drawImage(vista, 0, 0);

      // Recuadro azul
      ctx.beginPath();
      pts.forEach((p, i) => i ? ctx.lineTo(p.x * s, p.y * s) : ctx.moveTo(p.x * s, p.y * s));
      ctx.closePath();
      ctx.fillStyle = 'rgba(26,115,232,0.15)';
      ctx.fill();
      ctx.strokeStyle = '#1a73e8';
      ctx.lineWidth = 3 * dpr;
      ctx.stroke();

      // Barritas en la mitad de cada lado
      for (let i = 0; i < 4; i++) {
        const a = pts[i], b = pts[(i + 1) % 4], m = medio(i);
        const angulo = Math.atan2(b.y - a.y, b.x - a.x);
        const activo = arrastre && arrastre.tipo === 'lado' && arrastre.i === i;
        ctx.save();
        ctx.translate(m.x * s, m.y * s);
        ctx.rotate(angulo);
        rectRedondo(-20 * dpr, -6 * dpr, 40 * dpr, 12 * dpr, 6 * dpr);
        ctx.fillStyle = activo ? '#1a73e8' : 'white';
        ctx.fill();
        ctx.lineWidth = 2 * dpr;
        ctx.strokeStyle = '#1a73e8';
        ctx.stroke();
        ctx.restore();
      }

      // Círculos en las esquinas
      pts.forEach((p, i) => {
        const activo = arrastre && arrastre.tipo === 'esquina' && arrastre.i === i;
        ctx.beginPath();
        ctx.arc(p.x * s, p.y * s, (activo ? 8 : 14) * dpr, 0, Math.PI * 2);
        ctx.fillStyle = 'white';
        ctx.fill();
        ctx.lineWidth = 4 * dpr;
        ctx.strokeStyle = '#1a73e8';
        ctx.stroke();
      });

      if (arrastre) {
        dibujarLupa(arrastre.tipo === 'esquina' ? pts[arrastre.i] : medio(arrastre.i));
      }
    }

    function dibujarLupa(p) {
      const R = 70 * dpr, zoom = 3;
      const lado = (2 * R) / zoom / s; // zona de la foto que se amplía
      // La lupa va en el lado contrario al punto, para que el dedo no la tape
      const cx = p.x * s < lienzo.width / 2 ? lienzo.width - R - 10 * dpr : R + 10 * dpr;
      const cy = p.y * s < lienzo.height / 2 ? lienzo.height - R - 10 * dpr : R + 10 * dpr;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = '#000';
      ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
      ctx.drawImage(base, p.x - lado / 2, p.y - lado / 2, lado, lado, cx - R, cy - R, 2 * R, 2 * R);
      ctx.restore();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.strokeStyle = 'white';
      ctx.lineWidth = 3 * dpr;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - 14 * dpr, cy); ctx.lineTo(cx + 14 * dpr, cy);
      ctx.moveTo(cx, cy - 14 * dpr); ctx.lineTo(cx, cy + 14 * dpr);
      ctx.strokeStyle = '#d93025';
      ctx.lineWidth = 2 * dpr;
      ctx.stroke();
    }

    function posicion(e) {
      const r = lienzo.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) / r.width * base.width,
        y: (e.clientY - r.top) / r.height * base.height
      };
    }

    // Distancia de un punto a una línea (para saber si tocaste un lado)
    function distanciaALado(p, a, b) {
      const dx = b.x - a.x, dy = b.y - a.y;
      const largo2 = dx * dx + dy * dy || 1;
      let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / largo2;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    }

    lienzo.onpointerdown = e => {
      const p = posicion(e);
      const tolerancia = 40 / lienzo.getBoundingClientRect().width * base.width;
      arrastre = null;

      // 1. ¿Tocaste una esquina?
      let mejor = tolerancia;
      pts.forEach((q, i) => {
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        if (d < mejor) {
          mejor = d;
          arrastre = { tipo: 'esquina', i, desfase: { x: q.x - p.x, y: q.y - p.y } };
        }
      });

      // 2. Si no, ¿tocaste un lado?
      if (!arrastre) {
        mejor = tolerancia;
        for (let i = 0; i < 4; i++) {
          const a = pts[i], b = pts[(i + 1) % 4];
          const d = distanciaALado(p, a, b);
          if (d < mejor) {
            mejor = d;
            const largo = Math.hypot(b.x - a.x, b.y - a.y) || 1;
            arrastre = {
              tipo: 'lado', i, inicio: p,
              a0: { ...a }, b0: { ...b },
              normal: { x: -(b.y - a.y) / largo, y: (b.x - a.x) / largo }
            };
          }
        }
      }

      if (arrastre) {
        lienzo.setPointerCapture(e.pointerId);
        dibujar();
      }
    };

    lienzo.onpointermove = e => {
      if (!arrastre) return;
      const p = posicion(e);
      if (arrastre.tipo === 'esquina') {
        pts[arrastre.i] = {
          x: lim(p.x + arrastre.desfase.x, base.width),
          y: lim(p.y + arrastre.desfase.y, base.height)
        };
      } else {
        // El lado se mueve derecho, sin torcerse
        const { i, inicio, a0, b0, normal } = arrastre;
        const avance = (p.x - inicio.x) * normal.x + (p.y - inicio.y) * normal.y;
        pts[i] = {
          x: lim(a0.x + normal.x * avance, base.width),
          y: lim(a0.y + normal.y * avance, base.height)
        };
        pts[(i + 1) % 4] = {
          x: lim(b0.x + normal.x * avance, base.width),
          y: lim(b0.y + normal.y * avance, base.height)
        };
      }
      dibujar();
    };

    lienzo.onpointerup = lienzo.onpointercancel = () => { arrastre = null; dibujar(); };

    document.getElementById('edTodo').onclick = () => { pts = esquinasCompletas(base); dibujar(); };
    document.getElementById('edCancelar').onclick = () => cerrar(null);
    document.getElementById('edListo').onclick = () => cerrar(ordenarEsquinas(pts));
    document.getElementById('edOtra').onclick = () => {
      camara.click(); // abre la galería/cámara de una vez para la siguiente página
      cerrar(ordenarEsquinas(pts));
    };

    function cerrar(resultado) {
      editor.classList.remove('visible');
      liberar(vista);
      resolve(resultado);
    }

    dibujar();
  });
}

// ---------- 6. Enderezar la hoja ----------
function enderezar(base, esquinas) {
  const [ai, ad, bd, bi] = esquinas;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const ancho = Math.round(Math.max(dist(ai, ad), dist(bi, bd)));
  const alto = Math.round(Math.max(dist(ai, bi), dist(ad, bd)));
  if (ancho < 20 || alto < 20) return base;

  const src = cv.imread(base);
  const origen = cv.matFromArray(4, 1, cv.CV_32FC2,
    [ai.x, ai.y, ad.x, ad.y, bd.x, bd.y, bi.x, bi.y]);
  const destino = cv.matFromArray(4, 1, cv.CV_32FC2,
    [0, 0, ancho, 0, ancho, alto, 0, alto]);
  const M = cv.getPerspectiveTransform(origen, destino);
  const plana = new cv.Mat();
  cv.warpPerspective(src, plana, M, new cv.Size(ancho, alto),
    cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());

  const salida = document.createElement('canvas');
  cv.imshow(salida, plana);
  [src, origen, destino, M, plana].forEach(m => m.delete());
  return salida;
}

// ---------- 7. Tamaño de hoja: Carta, Oficio, A4 o proporcional ----------
const FORMATOS = [
  { nombre: 'Carta', w: 216, h: 279 },
  { nombre: 'A4', w: 210, h: 297 },
  { nombre: 'Oficio', w: 216, h: 330 }
];

// Reconoce el tamaño por la proporción (alto / ancho) de la hoja recortada
function formatoDePagina(ancho, alto) {
  const proporcion = Math.max(ancho, alto) / Math.min(ancho, alto);
  let mejor = null, diferencia = 0.035; // tolerancia de 3,5 %
  for (const f of FORMATOS) {
    const d = Math.abs(proporcion - f.h / f.w) / (f.h / f.w);
    if (d < diferencia) { diferencia = d; mejor = f; }
  }
  if (!mejor) return { nombre: 'Proporcional', w: 210, h: 210 * alto / ancho };
  return alto >= ancho
    ? { nombre: mejor.nombre, w: mejor.w, h: mejor.h }
    : { nombre: mejor.nombre, w: mejor.h, h: mejor.w }; // hoja acostada
}

// ---------- 8. Filtros: Color, B/N, Original (a 200 DPI) ----------
async function aplicarModo(pag, rec) {
  // Tamaño final: 200 DPI según el formato (tiquetes y otros: máximo 2400 px de largo)
  const f = formatoDePagina(rec.width, rec.height);
  const maxLado = f.nombre === 'Proporcional' ? 2400 : Math.round(Math.max(f.w, f.h) / 25.4 * DPI);
  const esc = Math.min(1, maxLado / Math.max(rec.width, rec.height));

  const c = document.createElement('canvas');
  c.width = Math.round(rec.width * esc);
  c.height = Math.round(rec.height * esc);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(rec, 0, 0, c.width, c.height);

  if (modo === 'color') { blanquearColor(ctx, c); afilar(c); }
  if (modo === 'bn') { afilar(c); blancoNegro(c); }
  const blob = await aBlob(c, 0.88);
  if (pag.finalURL) URL.revokeObjectURL(pag.finalURL);
  pag.finalBlob = blob;
  pag.finalURL = URL.createObjectURL(blob);
  pag.ancho = c.width;
  pag.alto = c.height;
  pag.formato = f.nombre;
  liberar(c);
}

// Afilar: hace el texto más nítido
function afilar(canvas) {
  if (!opencvListo) return;
  const src = cv.imread(canvas), borroso = new cv.Mat();
  cv.GaussianBlur(src, borroso, new cv.Size(0, 0), 2);
  cv.addWeighted(src, 1.6, borroso, -0.6, 0, src);
  cv.imshow(canvas, src);
  src.delete(); borroso.delete();
}

// Color: vuelve blanco el papel y aviva los colores
function blanquearColor(ctx, c) {
  const datos = ctx.getImageData(0, 0, c.width, c.height);
  const p = datos.data;
  const blancos = [0, 1, 2].map(canal => {
    const hist = new Array(256).fill(0);
    for (let i = canal; i < p.length; i += 16) hist[p[i]]++;
    const total = hist.reduce((a, b) => a + b, 0);
    let acum = 0;
    for (let v = 0; v < 256; v++) {
      acum += hist[v];
      if (acum >= total * 0.9) return Math.max(v, 1);
    }
    return 255;
  });
  for (let i = 0; i < p.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      const v = p[i + k] * 255 / blancos[k];
      p[i + k] = (v - 128) * 1.15 + 128;
    }
  }
  ctx.putImageData(datos, 0, 0);
}

// B/N: quita sombras y deja fondo blanco con texto negro
function blancoNegro(canvas) {
  if (!opencvListo) { // versión simple si OpenCV no cargó
    const ctx = canvas.getContext('2d');
    const datos = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const p = datos.data;
    for (let i = 0; i < p.length; i += 4) {
      const g = (0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2] - 128) * 1.5 + 148;
      p[i] = p[i + 1] = p[i + 2] = g;
    }
    ctx.putImageData(datos, 0, 0);
    return;
  }
  const src = cv.imread(canvas);
  const gris = new cv.Mat(), fondo = new cv.Mat(), dif = new cv.Mat();
  cv.cvtColor(src, gris, cv.COLOR_RGBA2GRAY);
  const k = cv.Mat.ones(11, 11, cv.CV_8U);
  cv.dilate(gris, fondo, k);        // borra el texto y deja solo el fondo
  cv.medianBlur(fondo, fondo, 31);  // suaviza las sombras
  cv.absdiff(gris, fondo, dif);     // el texto es la diferencia con el fondo
  cv.bitwise_not(dif, dif);         // fondo blanco, texto oscuro
  cv.normalize(dif, dif, 0, 255, cv.NORM_MINMAX);
  dif.convertTo(dif, -1, 1.4, -102); // más contraste
  cv.imshow(canvas, dif);
  [src, gris, fondo, dif, k].forEach(m => m.delete());
}

document.querySelectorAll('.modo').forEach(boton => {
  boton.addEventListener('click', async () => {
    document.querySelectorAll('.modo').forEach(b => b.classList.remove('activo'));
    boton.classList.add('activo');
    modo = boton.dataset.modo;
    if (!paginas.length) return;
    await mostrarCargando(true);
    try {
      for (const pag of paginas) {
        const rec = await aCanvas(pag.recBlob);
        await aplicarModo(pag, rec);
        liberar(rec);
      }
      mostrarPaginas();
    } finally {
      mostrarCargando(false);
    }
  });
});

// ---------- 9. Mostrar, ordenar y borrar páginas ----------
function mostrarPaginas() {
  const contenedor = document.getElementById('paginas');
  contenedor.innerHTML = '';
  paginas.forEach((pag, i) => {
    contenedor.innerHTML += `
      <div class="pagina">
        <img src="${pag.finalURL}" onclick="editarPagina(${i})">
        <span>${i + 1} · ${pag.formato || ''}</span>
        <button class="borrar" onclick="borrarPagina(${i})">✕</button>
        <div class="mover">
          <button onclick="moverPagina(${i}, -1)" ${i === 0 ? 'disabled' : ''}>◀</button>
          <small>✏️ Toca para ajustar</small>
          <button onclick="moverPagina(${i}, 1)" ${i === paginas.length - 1 ? 'disabled' : ''}>▶</button>
        </div>
      </div>`;
  });
  const btnPdf = document.getElementById('pdf');
  btnPdf.disabled = paginas.length === 0;
  btnPdf.textContent = paginas.length
    ? `💾 Guardar PDF (${paginas.length} ${paginas.length === 1 ? 'página' : 'páginas'})`
    : '💾 Guardar PDF';
  document.getElementById('nuevo').style.display = paginas.length ? 'block' : 'none';
}

function moverPagina(i, direccion) {
  const j = i + direccion;
  if (j < 0 || j >= paginas.length) return;
  [paginas[i], paginas[j]] = [paginas[j], paginas[i]];
  mostrarPaginas();
}

async function editarPagina(i) {
  if (!opencvListo) return;
  const pag = paginas[i];
  await mostrarCargando(true);
  const base = await aCanvas(pag.baseBlob);
  mostrarCargando(false);
  try {
    const esquinas = await abrirEditor(base, pag.esquinas || esquinasCompletas(base),
      '✏️ Ajusta el recuadro de la hoja');
    if (esquinas) {
      await mostrarCargando(true);
      pag.esquinas = esquinas;
      await procesarPagina(pag, base);
      mostrarPaginas();
    }
  } finally {
    liberar(base);
    mostrarCargando(false);
  }
}

function borrarPagina(i) {
  URL.revokeObjectURL(paginas[i].finalURL);
  paginas.splice(i, 1);
  mostrarPaginas();
}

function empezarDeNuevo() {
  paginas.forEach(p => URL.revokeObjectURL(p.finalURL));
  paginas.length = 0;
  mostrarPaginas();
  estado.textContent = '✅ Listo para escanear';
}

document.getElementById('nuevo').addEventListener('click', () => {
  if (confirm('¿Borrar todas las páginas y empezar un documento nuevo?')) empezarDeNuevo();
});

async function mostrarCargando(visible) {
  document.getElementById('cargando').classList.toggle('visible', visible);
  if (visible) await new Promise(r => setTimeout(r, 50)); // deja que se vea el aviso
}

// ---------- 10. Crear el PDF con el tamaño de cada hoja ----------
async function crearPDF() {
  const { jsPDF } = window.jspdf;
  let doc;
  for (let i = 0; i < paginas.length; i++) {
    const pag = paginas[i];
    const f = formatoDePagina(pag.ancho, pag.alto);
    const orientacion = f.w > f.h ? 'l' : 'p';
    if (i === 0) doc = new jsPDF({ unit: 'mm', format: [f.w, f.h], orientation: orientacion });
    else doc.addPage([f.w, f.h], orientacion);
    const datos = new Uint8Array(await pag.finalBlob.arrayBuffer());
    doc.addImage(datos, 'JPEG', 0, 0, f.w, f.h);
  }
  return doc.output('blob');
}

// ---------- 11. Leer la cédula con OCR (todo dentro del celular) ----------
let trabajadorOCR = null;
const rutaCompleta = r => new URL(r, location.href).href;

function obtenerOCR() {
  if (!trabajadorOCR) {
    if (typeof Tesseract === 'undefined') return Promise.reject(new Error('Tesseract no cargó'));
    trabajadorOCR = Tesseract.createWorker('spa', 1, {
      workerPath: rutaCompleta('libs/tesseract/worker.min.js'),
      corePath: rutaCompleta('libs/tesseract/'),
      langPath: rutaCompleta('libs/tesseract/'),
      workerBlobURL: false,
      gzip: true
    }).catch(err => { trabajadorOCR = null; throw err; });
  }
  return trabajadorOCR;
}

// Lee una página una sola vez y guarda el resultado
function leerPagina(pag) {
  if (!pag.lectura) {
    pag.lectura = (async () => {
      const rec = await aCanvas(pag.recBlob);
      const c = prepararParaOCR(rec);
      liberar(rec);
      const trabajador = await obtenerOCR();
      const { data } = await trabajador.recognize(c);
      liberar(c);
      console.log('Texto leído:', data.text);
      return extraerDatos(data.text);
    })().catch(err => {
      console.error(err);
      pag.lectura = null;
      return { cedula: '', nombre: '' };
    });
  }
  return pag.lectura;
}

// Tamaño adecuado y blanco/negro: el OCR lee mejor así
function prepararParaOCR(rec) {
  const esc = Math.min(1, 2000 / Math.max(rec.width, rec.height));
  const c = document.createElement('canvas');
  c.width = Math.round(rec.width * esc);
  c.height = Math.round(rec.height * esc);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(rec, 0, 0, c.width, c.height);
  blancoNegro(c);
  return c;
}

function limpiarNombre(texto) {
  return texto.toUpperCase()
    .replace(/[^A-ZÁÉÍÓÚÜÑ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Busca la cédula ("Pc:" del i-STAT, o "C.C." / "Cédula") y el nombre si viene impreso
function extraerDatos(texto) {
  const lineas = texto.split('\n').map(l => l.trim()).filter(Boolean);
  const ignorar = /operador|serie|lote|versi|persn|clew|m[eé]dico/i; // números que NO son la cédula
  // Corrige letras que el OCR confunde con números
  const aDigitos = s => s.replace(/[Oo]/g, '0').replace(/[IlL|]/g, '1')
                         .replace(/[Ss]/g, '5').replace(/B/g, '8').replace(/[^0-9]/g, '');
  let cedula = '', nombre = '';

  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i];
    if (ignorar.test(l)) continue;

    if (!cedula) {
      const m = l.match(/^[Pp]\s?[cCeEoO0]\s*[:;.,]\s*([0-9OoIlLSsB|\s.]{5,16})/) ||
                l.match(/(?:C\.?\s?C\.?|C[eé]dula|Identificaci[oó]n)\s*[:;.,]?\s*([0-9OoIlLSsB|\s.]{5,16})/i);
      if (m) {
        const d = aDigitos(m[1]);
        if (d.length >= 5 && d.length <= 12) cedula = d;
      }
    }

    if (!nombre) {
      const m = l.match(/nombre\s*(?:del\s*)?paciente\s*[:;.,]?\s*(.*)$/i);
      if (m) {
        let posible = m[1].trim();
        const sig = lineas[i + 1] || '';
        if (!posible && /^[A-ZÁÉÍÓÚÑ ]{6,}$/.test(sig) && sig.includes(' ')) posible = sig;
        if (/[A-Za-zÁÉÍÓÚÑáéíóúñ]{3,}/.test(posible)) nombre = limpiarNombre(posible);
      }
    }
  }
  return { cedula, nombre };
}

// ---------- 12. Ventana de guardar ----------
const dlg = document.getElementById('dialogo');
const dlgTitulo = document.getElementById('dlgTitulo');
const dlgCedula = document.getElementById('dlgCedula');
const dlgNombre = document.getElementById('dlgNombre');
const dlgLectura = document.getElementById('dlgLectura');
const dlgArchivo = document.getElementById('dlgArchivo');
const dlgGuardar = document.getElementById('dlgGuardar');
const dlgCompartir = document.getElementById('dlgCompartir');
let pdfPreparado = null; // el PDF se arma mientras revisan los datos

// Quita los caracteres que Windows no permite en nombres de archivo
function limpiarTitulo(texto) {
  return texto.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
}

function fechaHora() {
  const d = new Date(), dos = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())} ${dos(d.getHours())}.${dos(d.getMinutes())}`;
}

function nombreArchivo() {
  if (tipoDoc === 'normal') return `${limpiarTitulo(dlgTitulo.value)}.pdf`;
  const cedula = dlgCedula.value.replace(/\D/g, '');
  const nombre = limpiarNombre(dlgNombre.value);
  return `${nombre} - CC ${cedula}.pdf`;
}

function datosCompletos() {
  if (tipoDoc === 'normal') return limpiarTitulo(dlgTitulo.value).length > 0;
  return dlgCedula.value.replace(/\D/g, '').length >= 5 &&
         limpiarNombre(dlgNombre.value).length >= 3;
}

function actualizarDialogo() {
  const listo = datosCompletos();
  dlgGuardar.disabled = !listo;
  dlgCompartir.disabled = !listo;
  dlgArchivo.textContent = listo ? `📄 ${nombreArchivo()}`
    : (tipoDoc === 'normal' ? 'Escribe un nombre para el archivo' : 'Completa la cédula y el nombre');
}
[dlgTitulo, dlgCedula, dlgNombre].forEach(c => c.addEventListener('input', actualizarDialogo));

function puedeCompartir() {
  try {
    return !!(navigator.canShare &&
      navigator.canShare({ files: [new File(['x'], 'x.pdf', { type: 'application/pdf' })] }));
  } catch { return false; }
}

document.getElementById('pdf').addEventListener('click', async () => {
  const esPaciente = tipoDoc === 'paciente';
  document.getElementById('camposNormal').style.display = esPaciente ? 'none' : 'block';
  document.getElementById('camposPaciente').style.display = esPaciente ? 'block' : 'none';
  dlgCompartir.style.display = puedeCompartir() ? 'block' : 'none';
  dlg.classList.add('visible');

  pdfPreparado = crearPDF().catch(err => { console.error(err); return null; });

  // Documento normal: solo el nombre del archivo
  if (!esPaciente) {
    dlgTitulo.value = `Documento ${fechaHora()}`;
    actualizarDialogo();
    dlgTitulo.focus();
    dlgTitulo.select();
    return;
  }

  // Paciente: leer la cédula con OCR
  dlgCedula.value = '';
  dlgNombre.value = '';
  actualizarDialogo();
  dlgLectura.textContent = '🔍 Leyendo la cédula del documento...';
  let datos = { cedula: '', nombre: '' };
  for (const pag of paginas.slice(0, 2)) { // busca en las 2 primeras páginas
    const d = await leerPagina(pag);
    if (!datos.cedula) datos.cedula = d.cedula;
    if (!datos.nombre) datos.nombre = d.nombre;
    if (datos.cedula) break;
  }
  if (!dlg.classList.contains('visible')) return;
  if (!dlgCedula.value && datos.cedula) dlgCedula.value = datos.cedula;
  if (!dlgNombre.value && datos.nombre) dlgNombre.value = datos.nombre;
  dlgLectura.textContent = datos.cedula
    ? '✅ Cédula encontrada: revísala y escribe el nombre'
    : '✋ No pude leer la cédula: escríbela por favor';
  actualizarDialogo();
  if (!dlgNombre.value) dlgNombre.focus();
});

function cerrarDialogo() {
  dlg.classList.remove('visible');
  pdfPreparado = null;
}
document.getElementById('dlgCancelar').addEventListener('click', cerrarDialogo);

function descargar(blob, nombre) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function terminar(mensaje) {
  cerrarDialogo();
  estado.textContent = mensaje;
  setTimeout(() => {
    if (confirm('Documento listo ✅\n¿Empezar un documento nuevo?')) empezarDeNuevo();
  }, 300);
}

dlgGuardar.addEventListener('click', async () => {
  const nombre = nombreArchivo();
  await mostrarCargando(true);
  try {
    const blob = (await pdfPreparado) || (await crearPDF());
    descargar(blob, nombre);
    mostrarCargando(false);
    terminar(`✅ Guardado: ${nombre}`);
  } catch (err) {
    console.error(err);
    estado.textContent = '❌ Hubo un error creando el PDF.';
  } finally {
    mostrarCargando(false);
  }
});

dlgCompartir.addEventListener('click', async () => {
  const nombre = nombreArchivo();
  try {
    const blob = (await pdfPreparado) || (await crearPDF());
    const archivo = new File([blob], nombre, { type: 'application/pdf' });
    await navigator.share({ files: [archivo], title: nombre });
    terminar(`📤 Compartido: ${nombre}`);
  } catch (err) {
    if (err.name === 'AbortError') return; // cerró el menú de compartir
    console.error(err);
    const aviso = err.name === 'NotAllowedError'
      ? '👆 Toca "Compartir" otra vez, por favor'
      : '❌ No se pudo compartir. Usa "Guardar".';
    if (tipoDoc === 'paciente') dlgLectura.textContent = aviso;
    else dlgArchivo.textContent = aviso;
  }
});