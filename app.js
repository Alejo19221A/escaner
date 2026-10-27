const VERSION = '2.4';
const DPI = 200;               // calidad de cada hoja en el PDF (como un escáner de oficina)
const UMBRAL_NITIDEZ = 40;     // menor = acepta fotos más borrosas (se puede ajustar)
const MINUTOS_INACTIVIDAD = 10; // después de este tiempo sin uso, se borran las páginas
const MAX_ARCHIVOS_COMPARTIR = 10;               // Chrome deja compartir máximo 10 archivos a la vez
const MAX_BYTES_COMPARTIR = 45 * 1024 * 1024;    // y un tamaño total limitado (dejamos margen)
const UMBRAL_DUDOSA = 70;      // confianza del lector (0-100) por debajo de la cual una palabra sale en amarillo
const TIPO_WORD = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_CAPTURAS = 4;        // capturas de pantalla que se pueden adjuntar al reporte

// ---------- 0. Registro de errores (para "Reportar problema") ----------
// Solo guarda mensajes técnicos, nunca fotos, cédulas ni nombres
const erroresRecientes = [];
function anotarError(mensaje) {
    const texto = String(mensaje).slice(0, 200);
    erroresRecientes.push(`${new Date().toLocaleTimeString('es-CO')} – ${texto}`);
    if (erroresRecientes.length > 5) erroresRecientes.shift();
}
const errorOriginal = console.error.bind(console);
console.error = (...args) => {
    anotarError(args.map(a => (a && a.message) ? a.message : a).join(' '));
    errorOriginal(...args);
};
window.addEventListener('error', e => anotarError(e.message));
window.addEventListener('unhandledrejection', e =>
    anotarError(e.reason && e.reason.message ? e.reason.message : e.reason));

// Cada página: { id, baseBlob, esquinas, giro, recBlob, finalBlob, finalURL, ancho, alto, formato,
//                lectura, datosDlg, ocrPromesa, ocrResultado, ocrListo, ocrHTML }
// Se guardan comprimidas (Blob) para no llenar la memoria del celular
const paginas = [];
let modo = 'color';
let tipoDoc = localStorage.getItem('tipoDoc') || 'normal'; // 'normal' o 'paciente'
const estado = document.getElementById('estado');
document.getElementById('version').textContent = `Versión ${VERSION}`;
let avisoInicio = ''; // mensaje de la recuperación, para que "Listo para escanear" no lo tape
// Última vez que se usó la app ANTES de abrirla ahora (para la regla de los 10 minutos)
const actividadAnterior = Number(localStorage.getItem('ultimaActividad')) || 0;

// ---------- 1. Esperar a que OpenCV cargue (sin bloquear la app) ----------
let opencvListo = false;
estado.textContent = '⏳ Cargando recorte automático... (ya puedes escanear)';

function revisarOpenCV() {
    const c = window.cv;
    if (c && c.Mat) {
        opencvListo = true;
        estado.textContent = avisoInicio || '✅ Listo para escanear';
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
    if (!opencvListo) {
        estado.textContent = '⚠️ El recorte automático no cargó. Puedes escanear igual, pero sin recortar la hoja.';
        anotarError('OpenCV no cargó en 30 segundos');
    }
}, 30000);

// ---------- Ayudantes ----------
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
const distancia = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Evita que un texto leído se interprete como código de la página
function escaparHTML(texto) {
    return String(texto).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Área de un polígono (para saber qué tan grande es un recuadro)
function areaPoligono(o) {
    let area = 0;
    for (let i = 0; i < o.length; i++) {
        const p1 = o[i], p2 = o[(i + 1) % o.length];
        area += p1.x * p2.y - p2.x * p1.y;
    }
    return Math.abs(area) / 2;
}

// Copia reducida de una imagen (rápido, lo hace el navegador)
function copiaReducida(origen, maxLado) {
    const esc = Math.min(1, maxLado / Math.max(origen.width, origen.height));
    const c = document.createElement('canvas');
    c.width = Math.round(origen.width * esc);
    c.height = Math.round(origen.height * esc);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(origen, 0, 0, c.width, c.height);
    return { canvas: c, escala: esc };
}

// Gira una imagen 90, 180 o 270 grados (sentido del reloj)
function rotarCanvas(c, grados) {
    const r = document.createElement('canvas');
    const deLado = grados % 180 !== 0;
    r.width = deLado ? c.height : c.width;
    r.height = deLado ? c.width : c.height;
    const ctx = r.getContext('2d');
    ctx.translate(r.width / 2, r.height / 2);
    ctx.rotate(grados * Math.PI / 180);
    ctx.drawImage(c, -c.width / 2, -c.height / 2);
    return r;
}

// Si la página cambió (recorte o giro), hay que volver a leer su texto
function olvidarLectura(pag) {
    pag.lectura = null;
    pag.ocrPromesa = null;
    pag.ocrResultado = null;
    pag.ocrListo = false;
    pag.ocrHTML = null;
}

// ---------- 1b. Respaldo en el celular (IndexedDB) ----------
// Guarda el trabajo DENTRO del navegador del celular (nada sale a internet).
// Si Android cierra Chrome por falta de memoria, al volver se recupera todo.
let respaldoActivo = true;      // se apaga cuando el PDF ya se guardó o se compartió
let colaBD = Promise.resolve(); // las operaciones de guardado van en fila, en orden
let bdAbierta = null;
let contadorId = 0;
let avisoEspacio = false;
const nuevoId = () => `${Date.now()}-${++contadorId}`;

function abrirBD() {
    if (!bdAbierta) {
        bdAbierta = new Promise((resolve, reject) => {
            if (!window.indexedDB) { reject(new Error('Este navegador no permite guardar el trabajo')); return; }
            const pedido = indexedDB.open('escanerTrabajo', 1);
            pedido.onupgradeneeded = () => {
                const bd = pedido.result;
                if (!bd.objectStoreNames.contains('paginas')) bd.createObjectStore('paginas', { keyPath: 'id' });
                if (!bd.objectStoreNames.contains('sesion')) bd.createObjectStore('sesion');
            };
            pedido.onsuccess = () => resolve(pedido.result);
            pedido.onerror = () => reject(pedido.error);
        });
        bdAbierta.catch(() => { bdAbierta = null; }); // si falla, se reintenta la próxima vez
    }
    return bdAbierta;
}

// Hace una operación en el almacenamiento, después de que terminen las anteriores
function enBD(almacenes, accion) {
    const tarea = colaBD.then(() => abrirBD()).then(bd => new Promise((resolve, reject) => {
        const tx = bd.transaction(almacenes, 'readwrite');
        const pedido = accion(tx);
        tx.oncomplete = () => resolve(pedido ? pedido.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Se canceló el guardado'));
    }));
    colaBD = tarea.catch(() => { });
    return tarea;
}

function errorRespaldo(err) {
    console.error(err);
    if (err && err.name === 'QuotaExceededError' && !avisoEspacio) {
        avisoEspacio = true;
        estado.textContent = '⚠️ El celular tiene poco espacio: si sales de la app, el trabajo podría perderse';
    }
}

// Guarda las imágenes y la lectura de una página
function respaldarPagina(pag) {
    if (!respaldoActivo || !pag || !paginas.includes(pag)) return;
    const registro = {
        id: pag.id,
        baseBlob: pag.baseBlob,
        esquinas: pag.esquinas,
        giro: pag.giro || 0,
        recBlob: pag.recBlob,
        finalBlob: pag.finalBlob,
        ancho: pag.ancho,
        alto: pag.alto,
        formato: pag.formato,
        ocrResultado: pag.ocrListo ? pag.ocrResultado : null
    };
    enBD('paginas', tx => tx.objectStore('paginas').put(registro)).catch(errorRespaldo);
}

// Guarda el orden, el filtro, el texto corregido y si se estaba revisando el texto
function respaldarSesion() {
    if (!respaldoActivo) return;
    const revisando = txDlg.classList.contains('visible') &&
        porId('txRevisar').classList.contains('activo') && txPag && txListaRevision.length > 0;
    const textos = {};
    paginas.forEach(p => { if (p.ocrHTML) textos[p.id] = p.ocrHTML; });
    const sesion = {
        orden: paginas.map(p => p.id),
        modo,
        textos,
        revision: revisando ? { ids: txListaRevision.map(p => p.id), actual: txPag.id } : null
    };
    enBD('sesion', tx => tx.objectStore('sesion').put(sesion, 'actual')).catch(errorRespaldo);
}

function respaldarTodo() {
    paginas.forEach(respaldarPagina);
    respaldarSesion();
}

function quitarPaginaRespaldo(id) {
    enBD('paginas', tx => tx.objectStore('paginas').delete(id)).catch(err => console.error(err));
}

// Borra TODO lo guardado en el celular
function borrarRespaldo() {
    return enBD(['paginas', 'sesion'], tx => {
        tx.objectStore('paginas').clear();
        tx.objectStore('sesion').clear();
    }).catch(err => console.error(err));
}

// ---------- 2. Tipo de documento: normal o paciente (etiqueta de la cabecera) ----------
function marcarTipo() {
    document.body.classList.toggle('modoPaciente', tipoDoc === 'paciente');
    const barraCelular = document.querySelector('meta[name="theme-color"]');
    if (barraCelular) barraCelular.setAttribute('content', tipoDoc === 'paciente' ? '#0f6e56' : '#1a3d6d');
    actualizarCabecera();
}
document.getElementById('modoBtn').addEventListener('click', () => {
    tipoDoc = tipoDoc === 'paciente' ? 'normal' : 'paciente';
    localStorage.setItem('tipoDoc', tipoDoc);
    marcarTipo();
    estado.textContent = tipoDoc === 'paciente'
        ? '🧪 Modo Paciente: se leerá la cédula'
        : '📄 Modo Documento normal';
});
marcarTipo();

// ---------- 3. Tomar fotos (cámara del celular o galería) ----------
// Las tareas pesadas van en fila, una después de otra
let cola = Promise.resolve();
function enCola(tarea) {
    cola = cola.then(tarea).catch(err => console.error(err));
    return cola;
}

// Todos los botones de foto (Escanear, Galería, Listo y otra) usan esto
// Varias fotos de la galería: se agregan solas con el recorte automático (máximo 20 por vez);
// después se puede tocar cada una para ajustar el recorte
document.querySelectorAll('.entradaFoto').forEach(entrada => {
    entrada.addEventListener('change', (e) => {
        let archivos = [...e.target.files];
        e.target.value = '';
        if (!archivos.length) return;
        if (archivos.length > 20) {
            alert('Se pueden elegir hasta 20 fotos a la vez. Se tomarán las primeras 20.');
            archivos = archivos.slice(0, 20);
        }
        const deGaleria = !entrada.hasAttribute('capture'); // la galería no tiene "capture"
        if (archivos.length === 1) {
            enCola(() => manejarFoto(archivos[0], deGaleria));
            return;
        }
        const total = archivos.length;
        const resumen = { borrosas: 0 }; // cuántas salieron borrosas (2.3.1)
        archivos.forEach((archivo, i) =>
            enCola(() => manejarFoto(archivo, deGaleria, { numero: i + 1, total, resumen })));
        enCola(async () => {
            const b = resumen.borrosas;
            estado.textContent = b
                ? `⚠️ Se agregaron ${total} fotos. ${b === 1 ? '1 salió borrosa' : b + ' salieron borrosas'}: revisa las marcadas en amarillo`
                : `✅ Se agregaron ${total} fotos. Toca una para ajustar el recorte`;
        });
    });
});

// ¿Es una captura de pantalla? (ya viene derecha: no hay que buscar la hoja ni enderezarla)
function pareceCaptura(archivo, base) {
    const nombre = (archivo.name || '').toLowerCase();
    if (/screenshot|captura|pantallazo|screen/.test(nombre)) return true;
    if (archivo.type === 'image/png') return true;
    const proporcion = Math.max(base.width, base.height) / Math.min(base.width, base.height);
    return proporcion >= 1.9; // pantalla de celular: mucho más alargada que una foto
}

// lote: si vienen varias fotos a la vez ({ numero, total }), se agregan solas, sin abrir el editor
async function manejarFoto(archivo, deGaleria = false, lote = null) {
    const textoCargando = document.querySelector('#cargando div');
    if (lote) textoCargando.textContent = `Procesando foto ${lote.numero} de ${lote.total}...`;
    await mostrarCargando(true);
    let base = null;
    try {
        const img = await cargarImagen(archivo);
        base = copiaReducida(img, 3000).canvas; // 3000 px alcanzan para 200 DPI
        URL.revokeObjectURL(img.src);

        if (!opencvListo) { // plan B: sin recorte
            await agregarPagina(base, null);
            return;
        }

        const esCaptura = deGaleria && pareceCaptura(archivo, base);

        // Varias fotos a la vez: recorte automático, sin abrir el editor
        if (lote) {
            let esquinas = esquinasCompletas(base);
            let borrosa = false;
            if (!esCaptura) {
                let opciones = detectarCandidatos(base);
                if (opciones.length) opciones = refinarVarias(base, opciones);
                if (opciones.length) esquinas = opciones[0];
                borrosa = medirNitidez(base, esquinas) < UMBRAL_NITIDEZ; // 2.3.1: avisar si salió borrosa
            }
            const pagina = await agregarPagina(base, esquinas);
            if (borrosa) {
                pagina.borrosa = true;
                if (lote.resumen) lote.resumen.borrosas++;
                mostrarPaginas();
            }
            return;
        }

        // Captura de pantalla: se propone la imagen completa, sin deformarla
        if (esCaptura) {
            mostrarCargando(false);
            const esquinas = await abrirEditor(base, [esquinasCompletas(base)],
                'Captura de pantalla: se usa completa, sin recortar. Toca Listo', true);
            if (!esquinas) { estado.textContent = 'Foto descartada'; return; }
            await mostrarCargando(true);
            await agregarPagina(base, esquinas);
            return;
        }

        // Hasta 3 propuestas automáticas, afinadas en los bordes
        let opciones = detectarCandidatos(base);
        if (opciones.length) opciones = refinarVarias(base, opciones);
        const detectada = opciones.length > 0;
        const borrosa = detectada && medirNitidez(base, opciones[0]) < UMBRAL_NITIDEZ;

        let mensaje = '✋ No encontré la hoja: ajusta el recuadro';
        if (detectada) {
            mensaje = opciones.length > 1
                ? '✅ Revisa el recorte. ¿No es la hoja? Toca 🔄 Otra opción'
                : '✅ Revisa el recorte y toca Listo';
        }
        if (borrosa) mensaje = '⚠️ La foto salió borrosa: toca Cancelar y tómala otra vez';

        // Siempre se muestra el editor para confirmar
        mostrarCargando(false);
        const esquinas = await abrirEditor(base, detectada ? opciones : [esquinasPorDefecto(base)],
            mensaje, true, borrosa);
        if (!esquinas) { estado.textContent = 'Foto descartada'; return; }

        await mostrarCargando(true);
        await agregarPagina(base, esquinas);
    } catch (err) {
        console.error(err);
        estado.textContent = '❌ Hubo un error procesando la foto. Intenta de nuevo.';
    } finally {
        liberar(base);
        textoCargando.textContent = 'Procesando...';
        mostrarCargando(false);
    }
}

// leerCedula: en modo Paciente, si se lee la cédula de esta página (al abrir un PDF, solo las 2 primeras)
async function agregarPagina(base, esquinas, leerCedula = true) {
    const pagina = { id: nuevoId(), baseBlob: await aBlob(base, 0.92), esquinas, giro: 0 };
    await procesarPagina(pagina, base);
    paginas.push(pagina);
    if (respaldoActivo) {
        respaldarPagina(pagina);
        respaldarSesion();
    } else {
        // Después de guardar un PDF el respaldo estaba apagado: al seguir trabajando se vuelve a activar
        respaldoActivo = true;
        respaldarTodo();
    }
    estado.textContent = esquinas
        ? `✅ Página ${paginas.length} lista (${pagina.formato})`
        : `📄 Página ${paginas.length} lista (sin recorte)`;
    mostrarPaginas();
    if (tipoDoc === 'paciente' && leerCedula) leerPagina(pagina); // lee la cédula en segundo plano
    return pagina;
}

function cargarImagen(archivo) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('No se pudo abrir la imagen'));
        img.src = URL.createObjectURL(archivo);
    });
}

// Recorta, endereza (directo al tamaño final), gira si hace falta y aplica el filtro
async function procesarPagina(pag, base) {
    let rec = pag.esquinas ? enderezar(base, pag.esquinas) : base;
    if (pag.giro) {
        const girada = rotarCanvas(rec, pag.giro);
        if (rec !== base) liberar(rec);
        rec = girada;
    }
    pag.recBlob = await aBlob(rec);
    olvidarLectura(pag);
    await aplicarModo(pag, rec);
    if (rec !== base) liberar(rec);
}

// Mide qué tan nítida está la hoja (si es muy bajo, salió borrosa)
function medirNitidez(base, esquinas) {
    if (!opencvListo) return 999;
    const xs = esquinas.map(p => p.x), ys = esquinas.map(p => p.y);
    const x0 = Math.max(0, Math.min(...xs)), y0 = Math.max(0, Math.min(...ys));
    const w = Math.min(base.width, Math.max(...xs)) - x0;
    const h = Math.min(base.height, Math.max(...ys)) - y0;
    if (w < 50 || h < 50) return 999;
    const esc = Math.min(1, 1000 / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * esc);
    c.height = Math.round(h * esc);
    c.getContext('2d').drawImage(base, x0, y0, w, h, 0, 0, c.width, c.height);
    const src = cv.imread(c), gris = new cv.Mat(), lap = new cv.Mat();
    const media = new cv.Mat(), desv = new cv.Mat();
    cv.cvtColor(src, gris, cv.COLOR_RGBA2GRAY);
    cv.Laplacian(gris, lap, cv.CV_64F);
    cv.meanStdDev(lap, media, desv);
    const valor = desv.data64F[0] ** 2;
    [src, gris, lap, media, desv].forEach(m => m.delete());
    liberar(c);
    console.log('Nitidez:', Math.round(valor));
    return valor;
}

// ---------- 4. Detectar la hoja: hasta 3 propuestas, de la mejor a la peor ----------
function detectarCandidatos(base, tamano = 800) {
    // Primero se achica la foto (rápido) y solo esa copia pequeña pasa a OpenCV
    const { canvas: chico, escala } = copiaReducida(base, tamano);
    const peque = cv.imread(chico);
    liberar(chico);
    const diagonal = Math.hypot(peque.cols, peque.rows);

    const rgb = new cv.Mat(), gris = new cv.Mat(), hsv = new cv.Mat();
    cv.cvtColor(peque, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, gris, cv.COLOR_RGB2GRAY);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    cv.GaussianBlur(gris, gris, new cv.Size(5, 5), 0);
    const areaTotal = gris.rows * gris.cols;

    // Plan B: un recuadro alrededor del texto impreso (sirve cuando la hoja y la mesa son blancas)
    let recuadroTexto = null;
    try { recuadroTexto = rectanguloDelTexto(gris); } catch (err) { console.error(err); }

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
    const kCierre = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(21, 21));
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

    // Vuelta rápida a todos; el cálculo pesado (contraste) solo a los 6 mejores
    const finales = candidatos
        .map(q => ({ q, p: puntaje(q, gris, mapaBordes, areaTotal, false) }))
        .filter(c => c.p > 0)
        .sort((a, b) => b.p - a.p)
        .slice(0, 6)
        .map(c => ({ q: c.q, p: puntaje(c.q, gris, mapaBordes, areaTotal, true) }))
        .filter(c => c.p > 0)
        .sort((a, b) => b.p - a.p);

    [peque, rgb, gris, hsv, realzado, mapaBordes, k5, claro, blanco, bajo, alto, kCierre, k3]
        .forEach(m => m.delete());

    // Quedarse con hasta 3 propuestas que sean distintas entre sí
    let elegidas = [];
    for (const c of finales) {
        const o = ordenarEsquinas(c.q);
        const repetida = elegidas.some(e =>
            Math.max(...e.map((p, i) => distancia(p, o[i]))) < diagonal * 0.04);
        if (repetida) continue;
        elegidas.push(o);
        if (elegidas.length === 3) break;
    }

    // Sumar el recuadro del texto: primero si la detección normal falló o tomó casi toda la foto
    if (recuadroTexto) {
        const t = ordenarEsquinas(recuadroTexto);
        const primeraSospechosa = !elegidas.length || areaPoligono(elegidas[0]) / areaTotal > 0.75;
        if (primeraSospechosa) elegidas = [t, ...elegidas].slice(0, 3);
        else if (elegidas.length < 3) elegidas.push(t);
    }

    const lim = (v, max) => Math.min(max, Math.max(0, v));
    return elegidas.map(o => o.map(p => ({
        x: lim(p.x / escala, base.width),
        y: lim(p.y / escala, base.height)
    })));
}

// Busca dónde está el texto impreso y arma un recuadro inclinado alrededor, con margen
function rectanguloDelTexto(gris) {
    const W = gris.cols, H = gris.rows, areaTotal = W * H;
    const bin = new cv.Mat();
    const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(25, 9));
    cv.adaptiveThreshold(gris, bin, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, 25, 15);
    cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, k); // junta las letras en bloques de texto
    const contornos = new cv.MatVector(), jerarquia = new cv.Mat();
    cv.findContours(bin, contornos, jerarquia, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const puntos = [];
    for (let i = 0; i < contornos.size(); i++) {
        const c = contornos.get(i);
        const r = cv.boundingRect(c);
        const a = r.width * r.height;
        // Ignorar manchitas, objetos grandes y cosas pegadas al borde de la foto
        const adentro = r.x > 3 && r.y > 3 && r.x + r.width < W - 3 && r.y + r.height < H - 3;
        if (adentro && a > areaTotal * 0.0005 && a < areaTotal * 0.3) {
            for (let j = 0; j < c.data32S.length; j += 2) puntos.push(c.data32S[j], c.data32S[j + 1]);
        }
        c.delete();
    }
    [bin, k, contornos, jerarquia].forEach(m => m.delete());
    if (puntos.length < 40) return null;

    const mat = cv.matFromArray(puntos.length / 2, 1, cv.CV_32SC2, puntos);
    const rect = cv.minAreaRect(mat);
    mat.delete();

    // Margen alrededor del texto, como el blanco de la hoja
    const ampliado = {
        center: rect.center,
        size: { width: rect.size.width * 1.12 + W * 0.02, height: rect.size.height * 1.12 + H * 0.02 },
        angle: rect.angle
    };
    if ((ampliado.size.width * ampliado.size.height) / areaTotal < 0.08) return null;
    return cv.RotatedRect.points(ampliado).map(p => ({
        x: Math.min(W, Math.max(0, p.x)),
        y: Math.min(H, Math.max(0, p.y))
    }));
}

// Saca una figura de 4 lados de las 2 manchas más grandes
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
    for (const { i } of lista.slice(0, 2)) {
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
        if (!q) { // si no quedó de 4 lados, el rectángulo que mejor la encierra
            const rect = cv.minAreaRect(casco);
            q = cv.RotatedRect.points(rect).map(p => ({ x: p.x - 2, y: p.y - 2 }));
        }
        resultado.push(q);
        c.delete(); casco.delete();
    }
    [conMarco, contornos, jerarquia].forEach(m => m.delete());
    return resultado;
}

// Califica qué tanto parece una hoja
function puntaje(q, gris, mapaBordes, areaTotal, conContraste) {
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
    const fraccion = areaPoligono(o) / areaTotal;
    if (fraccion < 0.15 || fraccion > 0.99) return 0;

    // 3. ¿Los 4 lados caen sobre líneas reales de la foto? (y cuántos van por el borde de la foto)
    const W = mapaBordes.cols, H = mapaBordes.rows;
    let total = 0, aciertos = 0, ladosEnBorde = 0;
    for (let i = 0; i < 4; i++) {
        const a = o[i], b = o[(i + 1) % 4];
        let muestras = 0, enBorde = 0;
        for (let t = 0; t <= 1; t += 0.02) {
            const x = Math.round(a.x + (b.x - a.x) * t);
            const y = Math.round(a.y + (b.y - a.y) * t);
            total++;
            muestras++;
            if (x <= 3 || y <= 3 || x >= W - 4 || y >= H - 4) { aciertos += 0.15; enBorde++; }
            else if (mapaBordes.data[y * W + x] > 0) aciertos++;
        }
        if (enBorde > muestras * 0.5) ladosEnBorde++;
    }
    const soporte = aciertos / total;
    if (soporte < 0.4) return 0;

    // 4. Castigos y premios
    let ajuste = 1;
    if (ladosEnBorde >= 2) ajuste *= 0.4;       // casi seguro es la mesa, no la hoja
    else if (ladosEnBorde === 1) ajuste *= 0.75;
    if (fraccion > 0.85) ajuste *= 0.5;         // demasiado grande para ser solo la hoja
    const anchoAprox = (distancia(o[0], o[1]) + distancia(o[3], o[2])) / 2;
    const altoAprox = (distancia(o[0], o[3]) + distancia(o[1], o[2])) / 2;
    const prop = Math.max(anchoAprox, altoAprox) / Math.min(anchoAprox, altoAprox);
    if (FORMATOS.some(f => Math.abs(prop - f.h / f.w) / (f.h / f.w) < 0.06)) ajuste *= 1.3; // forma de hoja real

    const base = soporte * soporte * Math.sqrt(fraccion) * factorAngulos * ajuste;
    if (!conContraste) return base;

    // 5. Contraste: lo de adentro (papel) suele ser más claro que lo de afuera
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
    return base * (1 + Math.max(0, contraste) / 40);
}

// Afina las esquinas de varias propuestas a la vez: busca la orilla real de cada lado
// y traza una línea recta exacta
function refinarVarias(base, lista) {
    try {
        const { canvas: c, escala: esc } = copiaReducida(base, 1600);
        const src = cv.imread(c), gris = new cv.Mat(), bordes = new cv.Mat();
        liberar(c);
        cv.cvtColor(src, gris, cv.COLOR_RGBA2GRAY);
        cv.GaussianBlur(gris, gris, new cv.Size(3, 3), 0);
        cv.Canny(gris, bordes, 30, 90);
        const W = bordes.cols, H = bordes.rows;
        const datos = bordes.data.slice(); // copia para poder liberar la memoria de OpenCV
        [src, gris, bordes].forEach(m => m.delete());
        return lista.map(esquinas => refinarUna(esquinas, esc, datos, W, H));
    } catch (err) {
        console.error(err);
        return lista; // si algo falla, se quedan las propuestas originales
    }
}

function refinarUna(esquinas, esc, datos, W, H) {
    const p = esquinas.map(q => ({ x: q.x * esc, y: q.y * esc }));
    const banda = Math.max(6, Math.round(Math.max(W, H) * 0.015)); // cuánto puede corregir
    const muestras = 60;
    const lineas = [];

    for (let i = 0; i < 4; i++) {
        const a = p[i], b = p[(i + 1) % 4];
        const largo = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const nx = -(b.y - a.y) / largo, ny = (b.x - a.x) / largo;
        const puntos = [];
        for (let k = 4; k < muestras - 4; k++) { // sin las puntas, que suelen estar dobladas
            const t = k / muestras;
            const cx = a.x + (b.x - a.x) * t, cy = a.y + (b.y - a.y) * t;
            let encontrado = null;
            for (let d = 0; d <= banda && encontrado === null; d++) {
                for (const s of (d === 0 ? [0] : [d, -d])) {
                    const x = Math.round(cx + nx * s), y = Math.round(cy + ny * s);
                    if (x >= 0 && y >= 0 && x < W && y < H && datos[y * W + x]) { encontrado = s; break; }
                }
            }
            if (encontrado !== null) puntos.push({ x: cx + nx * encontrado, y: cy + ny * encontrado });
        }
        lineas.push(puntos.length >= (muestras - 8) * 0.4 ? ajustarLinea(puntos) : null);
    }

    // Cada esquina queda donde se cruzan sus dos lados
    const nuevas = p.map((q, i) => {
        const l1 = lineas[(i + 3) % 4], l2 = lineas[i];
        if (!l1 || !l2) return q;
        const cruce = interseccion(l1, l2);
        if (!cruce || distancia(cruce, q) > banda * 2) return q;
        return {
            x: Math.min(W, Math.max(0, cruce.x)),
            y: Math.min(H, Math.max(0, cruce.y))
        };
    });
    return nuevas.map(q => ({ x: q.x / esc, y: q.y / esc }));
}

// Línea recta que mejor pasa por varios puntos
function ajustarLinea(puntos) {
    const n = puntos.length;
    const mx = puntos.reduce((s, p) => s + p.x, 0) / n;
    const my = puntos.reduce((s, p) => s + p.y, 0) / n;
    let sxx = 0, syy = 0, sxy = 0;
    for (const p of puntos) {
        sxx += (p.x - mx) ** 2;
        syy += (p.y - my) ** 2;
        sxy += (p.x - mx) * (p.y - my);
    }
    const angulo = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { x: mx, y: my, dx: Math.cos(angulo), dy: Math.sin(angulo) };
}

// Punto donde se cruzan dos líneas
function interseccion(l1, l2) {
    const det = l1.dx * l2.dy - l1.dy * l2.dx;
    if (Math.abs(det) < 1e-6) return null;
    const t = ((l2.x - l1.x) * l2.dy - (l2.y - l1.y) * l2.dx) / det;
    return { x: l1.x + t * l1.dx, y: l1.y + t * l1.dy };
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

// ---------- 5. Editor: mover esquinas y lados (con lupa) y cambiar de propuesta ----------
function abrirEditor(base, opciones, mensaje, permitirOtra = false, alerta = false) {
    return new Promise(resolve => {
        const editor = document.getElementById('editor');
        const lienzo = document.getElementById('lienzo');
        const ctx = lienzo.getContext('2d');
        const edMensaje = document.getElementById('edMensaje');
        edMensaje.textContent = mensaje;
        edMensaje.classList.toggle('alerta', alerta);
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

        let indice = 0;
        let pts = opciones[0].map(p => ({ ...p }));
        let arrastre = null; // lo que se está arrastrando: una esquina o un lado

        // Botón "Otra opción": muestra la siguiente propuesta automática
        const btnOpcion = document.getElementById('edOpcion');
        btnOpcion.style.display = opciones.length > 1 ? '' : 'none';
        btnOpcion.onclick = () => {
            indice = (indice + 1) % opciones.length;
            pts = opciones[indice].map(p => ({ ...p }));
            edMensaje.textContent = `🔄 Opción ${indice + 1} de ${opciones.length}: revisa el recorte`;
            edMensaje.classList.remove('alerta');
            dibujar();
        };

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
        // "Listo y otra": guarda esta página y el mismo toque abre la cámara para la siguiente
        document.getElementById('edOtra').onclick = () => cerrar(ordenarEsquinas(pts));

        let cerrado = false;
        function cerrar(resultado) {
            if (cerrado) return;
            cerrado = true;
            editor.classList.remove('visible');
            liberar(vista);
            resolve(resultado);
        }

        dibujar();
    });
}

// ---------- 6. Enderezar la hoja, directo al tamaño final (200 DPI) ----------
function enderezar(base, esquinas) {
    const [ai, ad, bd, bi] = esquinas;
    let ancho = Math.max(distancia(ai, ad), distancia(bi, bd));
    let alto = Math.max(distancia(ai, bi), distancia(ad, bd));
    if (ancho < 20 || alto < 20) return base;

    // Tamaño final según el formato de la hoja
    const f = formatoDePagina(ancho, alto);
    const maxLado = f.nombre === 'Proporcional' ? 2400 : Math.round(Math.max(f.w, f.h) / 25.4 * DPI);
    const esc = Math.min(1, maxLado / Math.max(ancho, alto));
    ancho = Math.round(ancho * esc);
    alto = Math.round(alto * esc);

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

// ---------- 8. Filtros: Color, B/N, Original (2.3.1: sin sombras y más nítidos) ----------
// Curva de contraste: lo más claro que "blanco" queda blanco puro, lo más oscuro que "negro"
// queda negro, y "gamma" oscurece un poco los tonos medios (letras más marcadas)
function crearCurva(negro, blanco, gamma) {
    const curva = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) {
        const x = Math.min(1, Math.max(0, (v / 255 - negro) / (blanco - negro)));
        curva[v] = Math.round(255 * Math.pow(x, gamma));
    }
    return curva;
}
const CURVA_COLOR = crearCurva(0.05, 0.92, 1.1);
const CURVA_BN = crearCurva(0.30, 0.88, 1.6);

async function aplicarModo(pag, rec) {
    // Si la página no se recortó, se reduce aquí a un tamaño razonable
    const f = formatoDePagina(rec.width, rec.height);
    const maxLado = f.nombre === 'Proporcional' ? 2400 : Math.round(Math.max(f.w, f.h) / 25.4 * DPI);
    const { canvas: c } = copiaReducida(rec, maxLado);
    const ctx = c.getContext('2d');

    if (modo === 'color') { blanquearColor(ctx, c); afilar(c); }
    if (modo === 'bn') blancoNegro(c); // ya afila por dentro
    const blob = await aBlob(c, 0.9);
    if (pag.finalURL) URL.revokeObjectURL(pag.finalURL);
    pag.finalBlob = blob;
    pag.finalURL = URL.createObjectURL(blob);
    pag.ancho = c.width;
    pag.alto = c.height;
    pag.formato = f.nombre;
    liberar(c);
}

// Afilar: hace el texto más nítido (ajustado para letras a 200 DPI)
function afilar(canvas) {
    if (!opencvListo) return;
    const src = cv.imread(canvas), borroso = new cv.Mat();
    cv.GaussianBlur(src, borroso, new cv.Size(0, 0), 1.2);
    cv.addWeighted(src, 1.7, borroso, -0.7, 0, src);
    cv.imshow(canvas, src);
    src.delete(); borroso.delete();
}

// Valor por debajo del cual queda el 90 % de los puntos (sirve para hallar el color del papel)
function percentil(hist, total, q) {
    let acum = 0;
    for (let v = 0; v < 256; v++) {
        acum += hist[v];
        if (acum >= total * q) return v;
    }
    return 255;
}

// Superficie suave que mejor pasa por varios puntos: a0 + a1·x + a2·y + a3·x² + a4·x·y + a5·y²
function ajustarSuperficie(puntos, valorDe) {
    if (puntos.length < 6) return null;
    const M = Array.from({ length: 6 }, () => new Array(7).fill(0));
    for (const pt of puntos) {
        const t = [1, pt.x, pt.y, pt.x * pt.x, pt.x * pt.y, pt.y * pt.y];
        const v = valorDe(pt);
        for (let i = 0; i < 6; i++) {
            for (let j = 0; j < 6; j++) M[i][j] += t[i] * t[j];
            M[i][6] += t[i] * v;
        }
    }
    for (let col = 0; col < 6; col++) {
        let piv = col;
        for (let r = col + 1; r < 6; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
        if (Math.abs(M[piv][col]) < 1e-9) return null;
        [M[col], M[piv]] = [M[piv], M[col]];
        for (let r = 0; r < 6; r++) {
            if (r === col) continue;
            const factor = M[r][col] / M[col][col];
            for (let k = col; k < 7; k++) M[r][k] -= factor * M[col][k];
        }
    }
    return M.map((fila, i) => fila[6] / fila[i]);
}
const evaluarSuperficie = (a, x, y) => a[0] + a[1] * x + a[2] * y + a[3] * x * x + a[4] * x * y + a[5] * y * y;

// Mapa de la luz sobre el papel: divide la hoja en cuadritos, mide el papel en cada uno
// y arma una superficie suave (una por cada color: rojo, verde y azul)
function fondoDelPapel(c) {
    const { canvas: chico } = copiaReducida(c, 400);
    const w = chico.width, h = chico.height;
    const p = chico.getContext('2d').getImageData(0, 0, w, h).data;
    liberar(chico);
    const lado = 16; // cuadritos de 16 px (unos 9 mm de la hoja)
    const celdas = [];
    const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    for (let y0 = 0; y0 < h; y0 += lado) {
        for (let x0 = 0; x0 < w; x0 += lado) {
            const x1 = Math.min(w, x0 + lado), y1 = Math.min(h, y0 + lado);
            hist.forEach(hh => hh.fill(0));
            let n = 0;
            for (let y = y0; y < y1; y++) {
                for (let x = x0; x < x1; x++) {
                    const i = (y * w + x) * 4;
                    hist[0][p[i]]++; hist[1][p[i + 1]]++; hist[2][p[i + 2]]++;
                    n++;
                }
            }
            if (n < 30) continue; // pedacito del borde, muy pequeño
            const color = hist.map(hh => percentil(hh, n, 0.9));
            celdas.push({ x: (x0 + x1) / 2 / w, y: (y0 + y1) / 2 / h, color, luz: (color[0] + color[1] + color[2]) / 3 });
        }
    }

    // Plan B: un solo color de papel para toda la hoja (como antes)
    const constante = k => {
        const v = celdas.map(cel => cel.color[k]).sort((a, b) => a - b);
        return [v.length ? Math.max(1, v[Math.floor(v.length * 0.9)]) : 255, 0, 0, 0, 0, 0];
    };

    // 1. Fuera lo que claramente no es papel (fotos, bloques oscuros, mesa en el borde)
    const luces = celdas.map(cel => cel.luz).sort((a, b) => a - b);
    const tope = luces.length ? luces[Math.floor(luces.length * 0.9)] : 255;
    let papel = celdas.filter(cel => cel.luz > tope * 0.5);

    // 2. Primera superficie; fuera lo que queda muy por debajo de ella
    const sup = ajustarSuperficie(papel, cel => cel.luz);
    if (sup) {
        const filtradas = papel.filter(cel => cel.luz >= evaluarSuperficie(sup, cel.x, cel.y) * 0.75);
        if (filtradas.length >= 12) papel = filtradas;
    }
    if (papel.length < 12) return [0, 1, 2].map(constante);
    return [0, 1, 2].map(k => ajustarSuperficie(papel, cel => cel.color[k]) || constante(k));
}

// Color: empareja la luz de la hoja (quita sombras y el tono amarillo) y deja el papel blanco
function blanquearColor(ctx, c) {
    const fondo = fondoDelPapel(c);
    const W = c.width, H = c.height;
    const datos = ctx.getImageData(0, 0, W, H);
    const p = datos.data;
    const xs = new Float32Array(W), xs2 = new Float32Array(W);
    for (let x = 0; x < W; x++) { xs[x] = (x + 0.5) / W; xs2[x] = xs[x] * xs[x]; }
    const fA = [0, 0, 0], fB = [0, 0, 0], fC = [0, 0, 0];
    for (let y = 0; y < H; y++) {
        const v = (y + 0.5) / H;
        for (let k = 0; k < 3; k++) {
            const a = fondo[k];
            fA[k] = a[0] + a[2] * v + a[5] * v * v;
            fB[k] = a[1] + a[4] * v;
            fC[k] = a[3];
        }
        let i = y * W * 4;
        for (let x = 0; x < W; x++, i += 4) {
            for (let k = 0; k < 3; k++) {
                const papel = Math.min(255, Math.max(60, fA[k] + fB[k] * xs[x] + fC[k] * xs2[x]));
                const valor = p[i + k] * 255 / papel;
                p[i + k] = CURVA_COLOR[valor >= 255 ? 255 : valor | 0];
            }
        }
    }
    ctx.putImageData(datos, 0, 0);
}

// B/N: quita el granito y las sombras, afila y deja fondo blanco con letras bien negras
// (también lo usa el lector de texto y de cédula)
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
    const gris = new cv.Mat(), chico = new cv.Mat(), fondo = new cv.Mat(), borroso = new cv.Mat();
    const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(7, 7));
    cv.cvtColor(src, gris, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gris, gris, new cv.Size(3, 3), 0.8); // quita el granito de la foto

    // Fondo (papel y sombras) en una copia 4 veces más pequeña: más rápido y más suave
    const ancho = Math.max(1, Math.round(gris.cols / 4)), alto = Math.max(1, Math.round(gris.rows / 4));
    cv.resize(gris, chico, new cv.Size(ancho, alto), 0, 0, cv.INTER_AREA);
    cv.dilate(chico, chico, k);      // borra las letras y deja solo el papel
    cv.medianBlur(chico, chico, 9);  // suaviza las sombras
    cv.resize(chico, fondo, new cv.Size(gris.cols, gris.rows), 0, 0, cv.INTER_LINEAR);

    // Dividir por el fondo: el papel queda blanco parejo, con o sin sombra
    const d = gris.data, f = fondo.data;
    for (let i = 0; i < d.length; i++) {
        const v = d[i] * 255 / (f[i] || 1);
        d[i] = v > 255 ? 255 : v;
    }

    // Afilar las letras
    cv.GaussianBlur(gris, borroso, new cv.Size(0, 0), 1.2);
    cv.addWeighted(gris, 1.8, borroso, -0.8, 0, gris);

    // Contraste final: papel blanco puro y letras bien negras
    const g = gris.data;
    for (let i = 0; i < g.length; i++) g[i] = CURVA_BN[g[i]];
    cv.imshow(canvas, gris);
    [src, gris, chico, fondo, borroso, k].forEach(m => m.delete());
}

// Marca en pantalla el filtro elegido
function marcarModo() {
    document.querySelectorAll('.modo').forEach(b =>
        b.classList.toggle('activo', b.dataset.modo === modo));
}

document.querySelectorAll('.modo').forEach(boton => {
    boton.addEventListener('click', async () => {
        modo = boton.dataset.modo;
        marcarModo();
        if (!paginas.length) return;
        await mostrarCargando(true);
        try {
            for (const pag of paginas) {
                const rec = await aCanvas(pag.recBlob);
                await aplicarModo(pag, rec);
                liberar(rec);
            }
            mostrarPaginas();
            respaldarTodo();
        } finally {
            mostrarCargando(false);
        }
    });
});

// ---------- 9. Mostrar, ordenar, girar y borrar páginas ----------
function mostrarPaginas() {
    // Quitar de la selección las páginas que ya no existen
    seleccionadas.forEach(id => { if (!paginas.some(p => p.id === id)) seleccionadas.delete(id); });
    if (modoSeleccion && !paginas.length) modoSeleccion = false;

    const contenedor = document.getElementById('paginas');
    contenedor.innerHTML = '';
    paginas.forEach((pag, i) => {
        const marcada = seleccionadas.has(pag.id);
        const d = document.createElement('div');
        d.className = 'pagina' + (marcada ? ' marcada' : '');
        d.innerHTML = `<img src="${pag.finalURL}" alt="Página ${i + 1}" draggable="false"><span>${i + 1}</span>` +
            (pag.formato ? `<small>${pag.formato}</small>` : '') +
            (pag.borrosa ? '<div class="marcaBorrosa"><svg class="ic"><use href="#i-alerta"/></svg>Borrosa</div>' : '') +
            (modoSeleccion ? `<div class="check">${marcada ? '<svg class="ic"><use href="#i-check"/></svg>' : ''}</div>` : '');
        d.onclick = () => (modoSeleccion ? alternarSeleccion(pag.id) : abrirMenuPagina(i));
        // Mantener presionada: entra en modo selección
        d.oncontextmenu = e => { e.preventDefault(); if (!modoSeleccion) entrarSeleccion(pag.id); };
        contenedor.appendChild(d);
    });
    const n = paginas.length;
    document.getElementById('vacio').style.display = n ? 'none' : 'block';
    document.getElementById('ayudaPaginas').style.display = n && !modoSeleccion ? 'block' : 'none';
    document.getElementById('pdf').disabled = n === 0;
    document.getElementById('pdfCuenta').textContent = n ? `(${n})` : '';
    document.getElementById('textoBtn').disabled = n === 0;
    document.getElementById('nuevo').disabled = n === 0;
    actualizarCabecera();
    actualizarBarraSeleccion();
}

function moverPagina(i, direccion) {
    const j = i + direccion;
    if (j < 0 || j >= paginas.length) return;
    [paginas[i], paginas[j]] = [paginas[j], paginas[i]];
    mostrarPaginas();
    respaldarSesion();
}

// Gira la página 90° (sentido del reloj); el giro se guarda para cuando se reajuste el recorte
async function rotarPagina(i) {
    const pag = paginas[i];
    await mostrarCargando(true);
    try {
        const rec = await aCanvas(pag.recBlob);
        const girada = rotarCanvas(rec, 90);
        liberar(rec);
        pag.giro = ((pag.giro || 0) + 90) % 360;
        pag.recBlob = await aBlob(girada);
        olvidarLectura(pag);
        await aplicarModo(pag, girada);
        liberar(girada);
        mostrarPaginas();
        respaldarPagina(pag);
        respaldarSesion();
        if (tipoDoc === 'paciente' && paginas[0] === pag) leerPagina(pag); // volver a leer, ya derecha
    } catch (err) {
        console.error(err);
        estado.textContent = '❌ No se pudo girar la página.';
    } finally {
        mostrarCargando(false);
    }
}

async function editarPagina(i) {
    if (!opencvListo) return;
    const pag = paginas[i];
    await mostrarCargando(true);
    const base = await aCanvas(pag.baseBlob);
    mostrarCargando(false);
    try {
        const esquinas = await abrirEditor(base, [pag.esquinas || esquinasCompletas(base)],
            '✏️ Ajusta el recuadro de la hoja');
        if (esquinas) {
            await mostrarCargando(true);
            pag.esquinas = esquinas;
            if (pag.borrosa) pag.borrosa = medirNitidez(base, esquinas) < UMBRAL_NITIDEZ; // 2.3.1
            await procesarPagina(pag, base); // mantiene el giro que tenía
            mostrarPaginas();
            respaldarPagina(pag);
            respaldarSesion();
        }
    } finally {
        liberar(base);
        mostrarCargando(false);
    }
}

function borrarPagina(i) {
    const id = paginas[i].id;
    URL.revokeObjectURL(paginas[i].finalURL);
    paginas.splice(i, 1);
    mostrarPaginas();
    quitarPaginaRespaldo(id);
    respaldarSesion();
}

function empezarDeNuevo() {
    paginas.forEach(p => URL.revokeObjectURL(p.finalURL));
    paginas.length = 0;
    mostrarPaginas();
    respaldoActivo = true;
    borrarRespaldo(); // también se borra la copia guardada en el celular
    estado.textContent = '✅ Listo para escanear';
}

document.getElementById('nuevo').addEventListener('click', () => {
    if (confirm('¿Borrar todas las páginas y empezar un documento nuevo?')) empezarDeNuevo();
});

async function mostrarCargando(visible) {
    document.getElementById('cargando').classList.toggle('visible', visible);
    if (visible) await new Promise(r => setTimeout(r, 50)); // deja que se vea el aviso
}

// ---------- 10. Crear un PDF con las páginas indicadas ----------
async function crearPDF(lista = paginas) {
    const { jsPDF } = window.jspdf;
    let doc;
    for (let i = 0; i < lista.length; i++) {
        const pag = lista[i];
        const f = formatoDePagina(pag.ancho, pag.alto);
        const orientacion = f.w > f.h ? 'l' : 'p';
        if (i === 0) doc = new jsPDF({ unit: 'mm', format: [f.w, f.h], orientation: orientacion });
        else doc.addPage([f.w, f.h], orientacion);
        const datos = new Uint8Array(await pag.finalBlob.arrayBuffer());
        doc.addImage(datos, 'JPEG', 0, 0, f.w, f.h);
    }
    return doc.output('blob');
}

// ---------- 11. Lector de texto (OCR), todo dentro del celular ----------
let trabajadorOCR = null;
let progresoActualOCR = 0;      // avance de la página que se está leyendo (0 a 1)
let alAvanzarOCR = null;        // función que actualiza la barra, si la ventana de texto está abierta
const rutaCompleta = r => new URL(r, location.href).href;

function obtenerOCR() {
    if (!trabajadorOCR) {
        if (typeof Tesseract === 'undefined') return Promise.reject(new Error('Tesseract no cargó'));
        trabajadorOCR = Tesseract.createWorker('spa', 1, {
            workerPath: rutaCompleta('libs/tesseract/worker.min.js'),
            corePath: rutaCompleta('libs/tesseract/'),
            langPath: rutaCompleta('libs/tesseract/'),
            workerBlobURL: false,
            gzip: true,
            logger: m => {
                if (m.status === 'recognizing text' && typeof m.progress === 'number') {
                    progresoActualOCR = m.progress;
                    if (alAvanzarOCR) alAvanzarOCR();
                }
            }
        }).catch(err => { trabajadorOCR = null; throw err; });
    }
    return trabajadorOCR;
}

// Organiza lo leído en renglones de palabras, cada una con su confianza y su recuadro
function lineasDe(data) {
    let lineas = Array.isArray(data.lines) ? data.lines : [];
    if (!lineas.length) {
        (data.blocks || []).forEach(b => (b.paragraphs || []).forEach(p =>
            (p.lines || []).forEach(l => lineas.push(l))));
    }
    return lineas
        .map(l => (l.words || []).map(w => ({ t: w.text, c: w.confidence, b: w.bbox })))
        .filter(l => l.length);
}

// Lee una página completa UNA sola vez (lo usan la cédula y "Extraer texto")
function ocrCompleto(pag) {
    if (!pag.ocrPromesa) {
        pag.ocrPromesa = (async () => {
            const rec = await aCanvas(pag.recBlob);
            const { canvas: c } = copiaReducida(rec, 2000);
            liberar(rec);
            blancoNegro(c); // el lector funciona mejor en blanco y negro
            const ancho = c.width;
            const trabajador = await obtenerOCR();
            const { data } = await trabajador.recognize(c, {}, { text: true, blocks: true });
            liberar(c);
            const resultado = { texto: data.text || '', lineas: lineasDe(data), ancho };
            pag.ocrResultado = resultado;
            pag.ocrListo = true;
            respaldarPagina(pag); // la lectura también se guarda, para no repetirla
            console.log('Texto leído:', resultado.texto);
            return resultado;
        })().catch(err => {
            console.error(err);
            pag.ocrPromesa = null;
            throw err;
        });
    }
    return pag.ocrPromesa;
}

// Para la cédula: usa la misma lectura
function leerPagina(pag) {
    if (!pag.lectura) {
        pag.lectura = ocrCompleto(pag)
            .then(r => extraerDatos(r.texto))
            .catch(() => { pag.lectura = null; return { cedula: '', nombre: '' }; });
    }
    return pag.lectura;
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

// ---------- 12. Ventana de guardar: todo en un PDF o un PDF por foto ----------
const dlg = document.getElementById('dialogo');
const dlgCampos = document.getElementById('dlgCampos');
const dlgLectura = document.getElementById('dlgLectura');
const dlgArchivo = document.getElementById('dlgArchivo');
const dlgGuardar = document.getElementById('dlgGuardar');
const dlgCompartir = document.getElementById('dlgCompartir');
let forma = localStorage.getItem('formaPDF') || 'uno'; // 'uno' o 'varios' (recuerda la última)
let datosUno = { titulo: '', cedula: '', nombre: '' };   // datos cuando es "Todo en un PDF"
let pdfsListos = {};    // PDF que se están armando (promesas)
let pdfsHechos = {};    // PDF ya terminados, listos para guardar o compartir al instante
let progresoPDF = '';   // texto de avance mientras se arman
let sesionDlg = 0;      // evita mezclar PDF de una vez anterior que se abrió la ventana
let turnoLectura = 0;   // evita mezclar lecturas si cambian de opción
let loteActual = 0;     // qué tanda de archivos toca compartir (de a 10)

// Quita los caracteres que Windows no permite en nombres de archivo
function limpiarTitulo(texto) {
    return texto.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
}

function fechaHora() {
    const d = new Date(), dos = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())} ${dos(d.getHours())}.${dos(d.getMinutes())}`;
}

// 1023456789 → 1.023.456.789
const formatoCedula = d => d.replace(/\B(?=(\d{3})+(?!\d))/g, '.');

// Si hay una sola foto, siempre es "Todo en un PDF"
const formaEfectiva = () => (paginas.length > 1 ? forma : 'uno');

// Lista de archivos que se van a crear: [{ paginas, datos }]
function archivos() {
    if (formaEfectiva() === 'uno') return [{ paginas: [...paginas], datos: datosUno }];
    return paginas.map(p => ({ paginas: [p], datos: p.datosDlg }));
}

function nombreDe(datos) {
    if (tipoDoc === 'normal') return limpiarTitulo(datos.titulo);
    return `${limpiarNombre(datos.nombre)} - CC ${datos.cedula.replace(/\D/g, '')}`;
}

function completo(datos) {
    if (tipoDoc === 'normal') return limpiarTitulo(datos.titulo).length > 0;
    return datos.cedula.replace(/\D/g, '').length >= 5 && limpiarNombre(datos.nombre).length >= 3;
}

// Nombres finales, sin repetidos: si dos se llaman igual, al segundo se le pone (2)
function nombresFinales() {
    const usados = {};
    return archivos().map(a => {
        let n = nombreDe(a.datos);
        usados[n] = (usados[n] || 0) + 1;
        if (usados[n] > 1) n += ` (${usados[n]})`;
        return `${n}.pdf`;
    });
}

// Divide los PDF en tandas que Chrome sí deje compartir (máx. 10 archivos y un tamaño total límite)
function lotesDe(blobs) {
    const lotes = [];
    let actual = [], bytes = 0;
    blobs.forEach((b, i) => {
        if (actual.length && (actual.length >= MAX_ARCHIVOS_COMPARTIR || bytes + b.size > MAX_BYTES_COMPARTIR)) {
            lotes.push(actual);
            actual = [];
            bytes = 0;
        }
        actual.push(i);
        bytes += b.size;
    });
    if (actual.length) lotes.push(actual);
    return lotes; // cada tanda es una lista de posiciones
}

const rango = lote => (lote.length > 1 ? `${lote[0] + 1}–${lote[lote.length - 1] + 1}` : `${lote[0] + 1}`);

// Avisos importantes: se muestran abajo y en una ventana para que no pasen desapercibidos
function avisar(mensaje) {
    dlgArchivo.textContent = mensaje;
    alert(mensaje);
}

// Crea una casilla (con su etiqueta) conectada a los datos
function crearCampo(etiqueta, datos, clave, atributos = {}) {
    const label = document.createElement('label');
    label.textContent = etiqueta;
    const input = document.createElement('input');
    input.autocomplete = 'off';
    for (const [k, v] of Object.entries(atributos)) input.setAttribute(k, v);
    input.value = datos[clave] || '';
    label.appendChild(input);

    // Cédula en grande, con puntos, para revisarla de un vistazo
    let grande = null;
    if (clave === 'cedula') {
        grande = document.createElement('div');
        grande.className = 'cedulaGrande';
        label.appendChild(grande);
    }
    const refrescar = () => {
        if (!grande) return;
        const d = input.value.replace(/\D/g, '');
        grande.textContent = d ? formatoCedula(d) : '';
    };

    input.addEventListener('input', () => {
        datos[clave] = input.value;
        refrescar();
        actualizarDialogo();
    });

    // Para que el OCR pueda llenar la casilla (solo si está vacía)
    datos._poner = datos._poner || {};
    datos._poner[clave] = valor => {
        if (input.value) return;
        input.value = valor;
        datos[clave] = valor;
        refrescar();
        actualizarDialogo();
    };

    refrescar();
    return label;
}

function dibujarCampos() {
    const lista = archivos();
    const varios = lista.length > 1;
    document.getElementById('formas').style.display = paginas.length > 1 ? 'flex' : 'none';
    document.querySelectorAll('.forma').forEach(b =>
        b.classList.toggle('activo', b.dataset.forma === formaEfectiva()));
    document.getElementById('dlgAviso').style.display = tipoDoc === 'paciente' ? '' : 'none';
    dlgLectura.style.display = tipoDoc === 'paciente' ? '' : 'none';

    dlgCampos.innerHTML = '';
    lista.forEach((a, i) => {
        const fila = document.createElement('div');
        if (varios) {
            fila.className = 'filaArchivo';
            const img = document.createElement('img');
            img.src = a.paginas[0].finalURL;
            fila.appendChild(img);
        }
        const campos = document.createElement('div');
        campos.className = 'camposArchivo';
        if (tipoDoc === 'normal') {
            campos.appendChild(crearCampo(varios ? `Foto ${i + 1}` : 'Nombre del archivo', a.datos, 'titulo'));
        } else {
            campos.appendChild(crearCampo(varios ? `Foto ${i + 1} · Cédula` : 'Cédula del paciente',
                a.datos, 'cedula', { inputmode: 'numeric' }));
            campos.appendChild(crearCampo('Nombre del paciente', a.datos, 'nombre', { autocapitalize: 'characters' }));
        }
        fila.appendChild(campos);
        dlgCampos.appendChild(fila);
    });
    actualizarDialogo();
}

function actualizarDialogo() {
    const lista = archivos();
    const n = lista.length;
    const listo = lista.every(a => completo(a.datos));
    document.getElementById('dlgDuplicado').textContent = textoDuplicados(lista);
    const blobs = pdfsHechos[formaEfectiva()];
    const pdfListo = !!blobs;

    // Los botones solo se activan cuando los datos están completos Y los PDF ya están armados
    dlgGuardar.disabled = !listo || !pdfListo;
    dlgCompartir.disabled = !listo || !pdfListo;
    if (!pdfListo) {
        dlgGuardar.textContent = '⏳ Preparando...';
        dlgCompartir.textContent = `⏳ ${progresoPDF || 'Preparando PDF...'}`;
    } else {
        dlgGuardar.textContent = n > 1 ? `💾 Guardar los ${n}` : '💾 Guardar';
        const lotes = lotesDe(blobs);
        if (lotes.length > 1) {
            const lote = lotes[Math.min(loteActual, lotes.length - 1)];
            dlgCompartir.textContent = `📤 Compartir ${rango(lote)} de ${n}`;
        } else {
            dlgCompartir.textContent = n > 1 ? `📤 Compartir los ${n}` : '📤 Compartir';
        }
    }

    if (!listo) {
        dlgArchivo.textContent = tipoDoc === 'normal'
            ? 'Escribe un nombre para cada archivo'
            : 'Completa la cédula y el nombre';
    } else {
        dlgArchivo.textContent = n > 1 ? `📑 Se crearán ${n} PDF separados` : `📄 ${nombresFinales()[0]}`;
    }
}

// Arma los PDF de la opción elegida apenas se abre la ventana (una sola vez)
function prepararPDFs() {
    const clave = formaEfectiva();
    const sesion = sesionDlg;
    if (!pdfsListos[clave]) {
        const grupos = archivos().map(a => a.paginas);
        pdfsListos[clave] = (async () => {
            const blobs = [];
            for (let i = 0; i < grupos.length; i++) {
                progresoPDF = grupos.length > 1 ? `Preparando PDF ${i + 1} de ${grupos.length}...` : 'Preparando PDF...';
                if (sesion === sesionDlg && clave === formaEfectiva()) actualizarDialogo();
                blobs.push(await crearPDF(grupos[i]));
            }
            return blobs;
        })().then(blobs => {
            if (sesion !== sesionDlg) return null; // la ventana ya se cerró
            pdfsHechos[clave] = blobs;
            progresoPDF = '';
            actualizarDialogo();
            return blobs;
        }).catch(err => {
            console.error(err);
            delete pdfsListos[clave];
            if (sesion === sesionDlg) avisar('❌ No se pudo preparar el PDF. Cierra la ventana e intenta otra vez.');
            return null;
        });
    }
    return pdfsListos[clave];
}

// Modo Paciente: lee la cédula de cada archivo
async function leerCedulas() {
    const turno = ++turnoLectura;
    const lista = archivos();
    for (let i = 0; i < lista.length; i++) {
        const a = lista[i];
        dlgLectura.textContent = lista.length > 1
            ? `🔍 Leyendo cédulas... (${i + 1} de ${lista.length})`
            : '🔍 Leyendo la cédula del documento...';
        const datos = { cedula: '', nombre: '' };
        for (const pag of a.paginas.slice(0, 2)) { // en cada archivo, busca en sus 2 primeras páginas
            const d = await leerPagina(pag);
            if (!datos.cedula) datos.cedula = d.cedula;
            if (!datos.nombre) datos.nombre = d.nombre;
            if (datos.cedula) break;
        }
        if (turno !== turnoLectura || !dlg.classList.contains('visible')) return;
        if (datos.cedula && a.datos._poner) a.datos._poner.cedula(datos.cedula);
        if (datos.nombre && a.datos._poner) a.datos._poner.nombre(datos.nombre);
    }
    const faltan = lista.filter(a => a.datos.cedula.replace(/\D/g, '').length < 5).length;
    dlgLectura.textContent = faltan === 0
        ? '✅ Revisa las cédulas y escribe los nombres'
        : `✋ No pude leer ${faltan === 1 ? '1 cédula' : faltan + ' cédulas'}: escríbelas por favor`;
}

function puedeCompartir() {
    try {
        return !!(navigator.canShare &&
            navigator.canShare({ files: [new File(['x'], 'x.pdf', { type: 'application/pdf' })] }));
    } catch { return false; }
}

// Abrir la ventana de guardar
document.getElementById('pdf').addEventListener('click', () => {
    sesionDlg++;
    pdfsListos = {};
    pdfsHechos = {};
    progresoPDF = '';
    loteActual = 0;
    const hora = fechaHora();
    datosUno = { titulo: `Documento ${hora}`, cedula: '', nombre: '' };
    paginas.forEach((p, i) => { p.datosDlg = { titulo: `Documento ${hora} (${i + 1})`, cedula: '', nombre: '' }; });
    dlgLectura.textContent = '';
    dlgCompartir.style.display = puedeCompartir() ? 'block' : 'none';
    dlg.classList.add('visible');
    dibujarCampos();
    prepararPDFs(); // empieza a armar los PDF de una vez, mientras revisan los datos
    if (tipoDoc === 'paciente') {
        leerCedulas();
    } else if (archivos().length === 1) {
        const primero = dlgCampos.querySelector('input');
        if (primero) { primero.focus(); primero.select(); }
    }
});

// Cambiar entre "Todo en un PDF" y "Un PDF por foto"
document.querySelectorAll('.forma').forEach(boton => {
    boton.addEventListener('click', () => {
        forma = boton.dataset.forma;
        localStorage.setItem('formaPDF', forma);
        loteActual = 0;
        dibujarCampos();
        prepararPDFs();
        if (tipoDoc === 'paciente') leerCedulas();
    });
});

function cerrarDialogo() {
    dlg.classList.remove('visible');
    sesionDlg++;
    turnoLectura++;
    pdfsListos = {};
    pdfsHechos = {};
    loteActual = 0;
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
    // El documento ya salió: se borra la copia guardada en el celular
    respaldoActivo = false;
    borrarRespaldo();
    estado.textContent = mensaje;
    setTimeout(() => {
        if (confirm('Documento listo ✅\n¿Empezar un documento nuevo?')) empezarDeNuevo();
    }, 300);
}

dlgGuardar.addEventListener('click', async () => {
    const blobs = pdfsHechos[formaEfectiva()];
    if (!blobs) return;
    const nombres = nombresFinales();
    await mostrarCargando(true);
    try {
        for (let i = 0; i < blobs.length; i++) {
            descargar(blobs[i], nombres[i]);
            if (blobs.length > 1) await new Promise(r => setTimeout(r, 400)); // pausa entre descargas
        }
        await anotarEnvio(blobs.map((_, i) => i), blobs, nombres, 'Guardado');
        mostrarCargando(false);
        terminar(nombres.length > 1 ? `✅ Se guardaron ${nombres.length} PDF` : `✅ Guardado: ${nombres[0]}`);
    } catch (err) {
        console.error(err);
        avisar('❌ Hubo un error guardando el PDF.');
    } finally {
        mostrarCargando(false);
    }
});

dlgCompartir.addEventListener('click', async () => {
    // Los PDF ya están hechos: el menú de compartir se abre de inmediato
    const blobs = pdfsHechos[formaEfectiva()];
    if (!blobs) return;
    const nombres = nombresFinales();
    const lotes = lotesDe(blobs);
    const lote = lotes[Math.min(loteActual, lotes.length - 1)];
    const pdfs = lote.map(i => new File([blobs[i]], nombres[i], { type: 'application/pdf' }));

    if (navigator.canShare && !navigator.canShare({ files: pdfs })) {
        avisar('❌ Este celular no deja compartir estos archivos. Usa "Guardar".');
        return;
    }
    try {
        await navigator.share({
            files: pdfs,
            title: pdfs.length > 1 ? `${pdfs.length} documentos` : nombres[lote[0]]
        });
        await anotarEnvio(lote, blobs, nombres, 'Compartido');
        loteActual++;

        if (loteActual < lotes.length) {
            // Quedan más tandas: el botón ya muestra la siguiente
            actualizarDialogo();
            const siguiente = lotes[loteActual];
            dlgArchivo.textContent = `✅ Enviados ${rango(lote)}. Toca "Compartir" para enviar ${rango(siguiente)}.`;
            return;
        }
        terminar(nombres.length > 1 ? `📤 Se compartieron ${nombres.length} PDF` : `📤 Compartido: ${nombres[0]}`);
    } catch (err) {
        if (err.name === 'AbortError') return; // cerró el menú de compartir
        console.error(err);
        avisar(err.name === 'NotAllowedError'
            ? '👆 El celular no dejó compartir. Toca "Compartir" otra vez; si sigue, usa "Guardar".'
            : '❌ No se pudo compartir. Usa "Guardar".');
    }
});

// ---------- 13. Borrado automático por inactividad (protege los datos) ----------
let ultimaActividad = Date.now();
let ultimaAnotada = 0;
['pointerdown', 'keydown', 'change', 'input'].forEach(evento =>
    document.addEventListener(evento, () => {
        ultimaActividad = Date.now();
        // Se anota en el celular (como mucho cada 5 s) para la regla de los 10 minutos al volver
        if (ultimaActividad - ultimaAnotada > 5000) {
            ultimaAnotada = ultimaActividad;
            localStorage.setItem('ultimaActividad', String(ultimaActividad));
        }
    }, true));

function revisarInactividad() {
    if (!paginas.length) return;
    if (Date.now() - ultimaActividad < MINUTOS_INACTIVIDAD * 60000) return;
    if (document.getElementById('editor').classList.contains('visible')) return;
    cerrarTexto();
    cerrarDialogo();
    empezarDeNuevo();
    estado.textContent = '🔒 Las páginas se borraron por inactividad (protección de datos)';
}
setInterval(revisarInactividad, 30000);

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        // Se sale de la app: guardar lo último antes de que Android pueda cerrar Chrome
        localStorage.setItem('ultimaActividad', String(ultimaActividad));
        if (txDlg.classList.contains('visible')) guardarEdicionTx();
        respaldarSesion();
    } else {
        revisarInactividad();
    }
});

// ---------- 14. Reportar problema (sin datos de pacientes) ----------
// Celular y navegador en pocas palabras: "Android 14 · Chrome 130", "iPhone · Safari"
function resumirNavegador() {
    const ua = navigator.userAgent;
    const android = ua.match(/Android\s([\d.]+)/);
    const iphone = /iPhone|iPad/.test(ua);
    const chrome = ua.match(/(?:Chrome|CriOS)\/(\d+)/);
    const sistema = android ? `Android ${android[1].split('.')[0]}` : iphone ? 'iPhone' : 'Computador';
    const navegador = chrome ? `Chrome ${chrome[1]}` : /Safari/.test(ua) ? 'Safari' : 'Otro navegador';
    return `${sistema} · ${navegador}`;
}

function armarReporte(descripcion) {
    let estadoApp = '✅ La app cargó completa';
    if (!opencvListo) estadoApp = '⚠️ El recorte automático no cargó';
    else if (typeof Tesseract === 'undefined') estadoApp = '⚠️ El lector de texto no cargó';
    else if (typeof JSZip === 'undefined') estadoApp = '⚠️ La librería de Word no cargó';

    const tipo = tipoDoc === 'paciente' ? 'Paciente' : 'Documento normal';
    const hora = new Date().toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });

    return [
        '🐞 Reporte – Escáner de documentos',
        '',
        `Qué pasó: ${descripcion || '(sin descripción)'}`,
        '',
        `📱 Celular: ${resumirNavegador()}`,
        `📅 Fecha: ${hora}`,
        `🔢 Versión de la app: ${VERSION}`,
        estadoApp,
        `📄 Estaba escaneando: ${paginas.length} ${paginas.length === 1 ? 'página' : 'páginas'} (${tipo})`,
        '',
        'Errores recientes:',
        ...(erroresRecientes.length ? erroresRecientes.map(e => `• ${e}`) : ['• Ninguno'])
    ].join('\n');
}

const repDlg = document.getElementById('reporteDlg');
const repTexto = document.getElementById('repTexto');
const repFoto = document.getElementById('repFoto');
const repFotoNombre = document.getElementById('repFotoNombre');
const repAdjuntar = document.getElementById('repAdjuntar');
const repAdjuntarTexto = document.getElementById('repAdjuntarTexto');
const repQuitar = document.getElementById('repQuitar');
let repCapturas = []; // capturas elegidas (se suman, hasta MAX_CAPTURAS)

// Muestra cuántas capturas hay, sus nombres y qué botones aplican
function mostrarCapturas() {
    const n = repCapturas.length;
    repFotoNombre.innerHTML = n
        ? `📎 ${n} de ${MAX_CAPTURAS} ${n === 1 ? 'captura' : 'capturas'}:<br>` +
        repCapturas.map(f => `• ${escaparHTML(f.name)}`).join('<br>')
        : '';
    repAdjuntarTexto.textContent = n
        ? '📎 Agregar otra captura'
        : `📎 Adjuntar capturas de pantalla (hasta ${MAX_CAPTURAS}, opcional)`;
    repAdjuntar.style.display = n >= MAX_CAPTURAS ? 'none' : 'block';
    repQuitar.style.display = n ? 'block' : 'none';
}

function cerrarReporte() {
    repDlg.classList.remove('visible');
    repCapturas = [];
}

document.getElementById('reportar').addEventListener('click', (e) => {
    e.preventDefault();
    repTexto.value = '';
    repFoto.value = '';
    repCapturas = [];
    mostrarCapturas();
    repDlg.classList.add('visible');
    repTexto.focus();
});

// Cada vez que se eligen capturas, se SUMAN a las que ya había (hasta el límite)
repFoto.addEventListener('change', () => {
    const nuevas = [...repFoto.files];
    repFoto.value = '';
    if (!nuevas.length) return;
    const espacio = MAX_CAPTURAS - repCapturas.length;
    if (nuevas.length > espacio) {
        alert(`Solo se pueden adjuntar ${MAX_CAPTURAS} capturas. Se ${espacio === 1 ? 'agregó 1' : 'agregaron ' + espacio}.`);
    }
    repCapturas.push(...nuevas.slice(0, espacio));
    mostrarCapturas();
});

repQuitar.addEventListener('click', (e) => {
    e.preventDefault();
    repCapturas = [];
    mostrarCapturas();
});

document.getElementById('repCancelar').addEventListener('click', cerrarReporte);

// "Enviar" abre Compartir al instante (con el texto y las capturas, si hay)
document.getElementById('repEnviar').addEventListener('click', async () => {
    const texto = armarReporte(repTexto.value.trim());
    const fotos = [...repCapturas];
    try {
        if (fotos.length && navigator.canShare && navigator.canShare({ files: fotos, text: texto })) {
            await navigator.share({ title: 'Reporte Escáner', text: texto, files: fotos });
            cerrarReporte();
            return;
        }
        if (navigator.share) {
            // El celular no deja adjuntar las capturas: se envía solo el texto y se avisa
            await navigator.share({ title: 'Reporte Escáner', text: texto });
            cerrarReporte();
            if (fotos.length) alert('⚠️ El celular no dejó adjuntar las capturas. Envíalas aparte en el mismo chat.');
            return;
        }
    } catch (err) {
        if (err.name === 'AbortError') return; // cerró el menú de compartir
        console.error(err);
    }
    try {
        await navigator.clipboard.writeText(texto);
        alert('📋 No se pudo abrir Compartir. El reporte se copió: pégalo en Teams o WhatsApp' +
            (fotos.length ? ' y envía las capturas aparte.' : '.'));
        cerrarReporte();
    } catch {
        alert('❌ No se pudo enviar el reporte.');
    }
});

// ---------- 15. Imagen a texto: elegir páginas, leer y revisar con la foto al lado ----------
const porId = id => document.getElementById(id);
const txDlg = porId('textoDlg');
const txLienzo = porId('txLienzo');
const txTexto = porId('txTexto');
let txSeleccion = new Set();   // páginas marcadas para leer
let txDetenerPedido = false;
let txListaRevision = [];      // páginas que se están revisando (pestañas)
let txPag = null;              // página que se ve ahora
let txImagen = null;           // foto de esa página, en color
let txPalabras = [];           // palabras con su recuadro en la foto
let txSel = -1;                // palabra tocada
let txSeguirPalabra = false;   // la foto sigue a la palabra tocada (aunque salga o se esconda el teclado)
let txVista = { zoom: 1, ox: 0, oy: 0 };
let txTemporizador = null;     // espera un momento después de escribir para guardar
const esAndroid = /Android/i.test(navigator.userAgent);

function mostrarPaso(paso) {
    ['Elegir', 'Leyendo', 'Revisar'].forEach(p => porId('tx' + p).classList.toggle('activo', p === paso));
}

// Abrir: si hay una sola página, la lee de una; si hay varias, primero se eligen
porId('textoBtn').addEventListener('click', () => {
    if (!paginas.length) return;
    txSeleccion = new Set();
    paginas.forEach((p, i) => { if (p.ocrListo) txSeleccion.add(i); });
    txDlg.classList.add('visible');
    if (paginas.length === 1) {
        txSeleccion.add(0);
        leerSeleccion();
        return;
    }
    dibujarMiniaturasTx();
    mostrarPaso('Elegir');
});

function dibujarMiniaturasTx() {
    const cont = porId('txMiniaturas');
    cont.innerHTML = '';
    paginas.forEach((p, i) => {
        const marcada = txSeleccion.has(i);
        const d = document.createElement('div');
        d.className = 'txMini' + (marcada ? ' marcada' : '');
        d.innerHTML = `<img src="${p.finalURL}"><span>${i + 1}</span>
      <div class="check">${marcada ? '✓' : ''}</div>
      ${p.ocrListo ? '<div class="leida">✓ Leída</div>' : ''}`;
        d.onclick = () => {
            if (txSeleccion.has(i)) txSeleccion.delete(i); else txSeleccion.add(i);
            dibujarMiniaturasTx();
        };
        cont.appendChild(d);
    });
    const n = txSeleccion.size;
    const btn = porId('txLeer');
    btn.disabled = n === 0;
    btn.textContent = n ? `🔍 Leer ${n} ${n === 1 ? 'página' : 'páginas'}` : 'Marca al menos una página';
}
porId('txTodas').onclick = () => { paginas.forEach((_, i) => txSeleccion.add(i)); dibujarMiniaturasTx(); };
porId('txNinguna').onclick = () => { txSeleccion.clear(); dibujarMiniaturasTx(); };
porId('txLeer').onclick = () => leerSeleccion();

// Lee las páginas elegidas (las que ya se leyeron no se vuelven a leer)
async function leerSeleccion() {
    const lista = [...txSeleccion].sort((a, b) => a - b).map(i => paginas[i]).filter(Boolean);
    const pendientes = lista.filter(p => !p.ocrListo);
    txDetenerPedido = false;

    if (pendientes.length) {
        mostrarPaso('Leyendo');
        const tiempos = [], fallidas = [];
        for (let k = 0; k < pendientes.length; k++) {
            if (txDetenerPedido || !txDlg.classList.contains('visible')) break;
            const pag = pendientes[k];
            const numero = paginas.indexOf(pag) + 1;
            const promedio = tiempos.length ? tiempos.reduce((a, b) => a + b, 0) / tiempos.length : 0;
            const faltan = promedio ? ` · faltan unos ${Math.ceil(promedio * (pendientes.length - k) / 1000)} s` : ' · unos segundos...';
            porId('txProgresoTexto').textContent = `Leyendo página ${numero} (${k + 1} de ${pendientes.length})${faltan}`;
            progresoActualOCR = 0;
            alAvanzarOCR = () => {
                porId('txBarraRelleno').style.width = `${Math.round((k + progresoActualOCR) / pendientes.length * 100)}%`;
            };
            alAvanzarOCR();
            const inicio = Date.now();
            try { await ocrCompleto(pag); } catch { fallidas.push(numero); }
            tiempos.push(Date.now() - inicio);
        }
        alAvanzarOCR = null;
        porId('txBarraRelleno').style.width = '0';
        if (!txDlg.classList.contains('visible')) return;
        if (fallidas.length) alert(`⚠️ No se pudo leer: página ${fallidas.join(', ')}`);
    }

    const leidas = lista.filter(p => p.ocrListo);
    if (!leidas.length) {
        if (paginas.length === 1) cerrarTexto();
        else { dibujarMiniaturasTx(); mostrarPaso('Elegir'); }
        return;
    }
    mostrarPaso('Revisar');
    dibujarPestanas(leidas);
    await mostrarPaginaTx(leidas[0]);
}

porId('txDetener').onclick = () => {
    txDetenerPedido = true;
    porId('txProgresoTexto').textContent = '⏹ Deteniendo al terminar esta página...';
};

function dibujarPestanas(lista) {
    txListaRevision = lista;
    const cont = porId('txPestanas');
    cont.innerHTML = '';
    lista.forEach(p => {
        const b = document.createElement('button');
        b.textContent = `Página ${paginas.indexOf(p) + 1}`;
        b.onclick = () => mostrarPaginaTx(p);
        cont.appendChild(b);
    });
    cont.style.display = lista.length > 1 ? 'flex' : 'none';
}

// Guarda lo que se corrigió en el texto antes de cambiar de página o cerrar
function guardarEdicionTx() {
    clearTimeout(txTemporizador); // evita que un guardado pendiente se cruce con otra página
    if (txPag) txPag.ocrHTML = txTexto.innerHTML;
}

// Mientras escribes: un momento después de la última tecla, se guarda la corrección en el celular
txTexto.addEventListener('input', () => {
    clearTimeout(txTemporizador);
    txTemporizador = setTimeout(() => {
        guardarEdicionTx();
        respaldarSesion();
    }, 800);
});

async function mostrarPaginaTx(pag) {
    guardarEdicionTx();
    txPag = pag;
    txSel = -1;
    txSeguirPalabra = false;
    [...porId('txPestanas').children].forEach((b, i) =>
        b.classList.toggle('activa', txListaRevision[i] === pag));

    const ocr = await ocrCompleto(pag);
    liberar(txImagen);
    txImagen = await aCanvas(pag.recBlob);
    const esc = txImagen.width / ocr.ancho; // de la lectura a la foto en color

    // Lista de palabras con su recuadro en la foto
    txPalabras = [];
    ocr.lineas.forEach(linea => linea.forEach(w => txPalabras.push({
        c: w.c, x0: w.b.x0 * esc, y0: w.b.y0 * esc, x1: w.b.x1 * esc, y1: w.b.y1 * esc
    })));

    // Texto: si ya se había corregido, se muestra lo corregido
    if (pag.ocrHTML) {
        txTexto.innerHTML = pag.ocrHTML;
    } else if (ocr.lineas.length) {
        let i = 0;
        txTexto.innerHTML = ocr.lineas.map(linea => '<div>' + linea.map(w => {
            const dudosa = w.c < UMBRAL_DUDOSA ? ' dudosa' : '';
            return `<span class="pal${dudosa}" data-i="${i++}">${escaparHTML(w.t)}</span>`;
        }).join(' ') + '</div>').join('');
    } else {
        txTexto.textContent = ocr.texto || '(No se encontró texto en esta página)';
    }
    txTexto.scrollTop = 0;

    ajustarLienzoTx();
    vistaAjustada();
    dibujarTx();
    respaldarSesion(); // recuerda qué página se estaba revisando
}

// ----- Foto con zoom -----
function ajustarLienzoTx() {
    const r = txLienzo.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    txLienzo.width = Math.max(1, Math.round(r.width * dpr));
    txLienzo.height = Math.max(1, Math.round(r.height * dpr));
}
function escalaBase() {
    return Math.min(txLienzo.width / txImagen.width, txLienzo.height / txImagen.height);
}
function vistaAjustada() {
    if (!txImagen) return;
    const s = escalaBase();
    txVista = { zoom: 1, ox: (txLienzo.width - txImagen.width * s) / 2, oy: (txLienzo.height - txImagen.height * s) / 2 };
}

// Que la foto no se pueda arrastrar fuera del recuadro
function limitarVista() {
    const s = escalaBase() * txVista.zoom;
    const w = txImagen.width * s, h = txImagen.height * s;
    const W = txLienzo.width, H = txLienzo.height;
    txVista.ox = w <= W ? (W - w) / 2 : Math.min(0, Math.max(W - w, txVista.ox));
    txVista.oy = h <= H ? (H - h) / 2 : Math.min(0, Math.max(H - h, txVista.oy));
}

function dibujarTx() {
    const ctx = txLienzo.getContext('2d');
    ctx.fillStyle = '#222';
    ctx.fillRect(0, 0, txLienzo.width, txLienzo.height);
    if (!txImagen) return;
    limitarVista();
    const s = escalaBase() * txVista.zoom;
    const dpr = window.devicePixelRatio || 1;
    ctx.drawImage(txImagen, txVista.ox, txVista.oy, txImagen.width * s, txImagen.height * s);
    txPalabras.forEach((w, i) => {
        const x = txVista.ox + w.x0 * s, y = txVista.oy + w.y0 * s;
        const ancho = (w.x1 - w.x0) * s, alto = (w.y1 - w.y0) * s;
        if (w.c < UMBRAL_DUDOSA) {
            ctx.fillStyle = 'rgba(255, 235, 59, 0.45)';
            ctx.fillRect(x, y, ancho, alto);
        }
        if (i === txSel) {
            ctx.strokeStyle = '#d93025';
            ctx.lineWidth = 3 * dpr;
            ctx.strokeRect(x - 3, y - 3, ancho + 6, alto + 6);
        }
    });
}

// Pone una palabra en el centro de la foto, acercada
function centrarEnPalabra(i) {
    const w = txPalabras[i];
    if (!w || !txImagen) return;
    txVista.zoom = Math.max(txVista.zoom, 2.5);
    const s = escalaBase() * txVista.zoom;
    txVista.ox = txLienzo.width / 2 - ((w.x0 + w.x1) / 2) * s;
    txVista.oy = txLienzo.height / 2 - ((w.y0 + w.y1) / 2) * s;
}

function zoomEn(factor, px, py) {
    txSeguirPalabra = false;
    const nuevo = Math.min(8, Math.max(1, txVista.zoom * factor));
    const f = nuevo / txVista.zoom;
    txVista.ox = px - (px - txVista.ox) * f;
    txVista.oy = py - (py - txVista.oy) * f;
    txVista.zoom = nuevo;
    if (nuevo === 1) vistaAjustada();
    dibujarTx();
}

// Cuando cambia el tamaño (sale o se esconde el teclado, se mueve la barrita):
// se conserva el acercamiento y el mismo punto de la foto en el centro
function reacomodarTx() {
    if (!txDlg.classList.contains('visible') || !txImagen) return;
    const sAntes = escalaBase() * txVista.zoom;
    const cx = (txLienzo.width / 2 - txVista.ox) / sAntes;
    const cy = (txLienzo.height / 2 - txVista.oy) / sAntes;
    ajustarLienzoTx();
    if (txSeguirPalabra && txSel >= 0) {
        centrarEnPalabra(txSel);
    } else if (txVista.zoom === 1) {
        vistaAjustada();
    } else {
        const s = escalaBase() * txVista.zoom;
        txVista.ox = txLienzo.width / 2 - cx * s;
        txVista.oy = txLienzo.height / 2 - cy * s;
    }
    dibujarTx();
}

// ----- No sacar del texto: los toques en la foto no cierran el teclado -----
let txFocoTexto = false, txRango = null;
function recordarFoco() {
    txFocoTexto = document.activeElement === txTexto;
    const sel = window.getSelection();
    txRango = txFocoTexto && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
}
function devolverFoco() {
    if (!txFocoTexto || document.activeElement === txTexto) return;
    txTexto.focus({ preventScroll: true });
    if (txRango) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(txRango);
    }
}
[porId('txImagenPanel'), porId('txDivisor')].forEach(zona => {
    zona.addEventListener('pointerdown', e => { recordarFoco(); e.preventDefault(); });
    zona.addEventListener('mousedown', e => e.preventDefault());
});

porId('txMas').onclick = () => { zoomEn(1.5, txLienzo.width / 2, txLienzo.height / 2); devolverFoco(); };
porId('txMenos').onclick = () => { zoomEn(1 / 1.5, txLienzo.width / 2, txLienzo.height / 2); devolverFoco(); };
porId('txAjustar').onclick = () => { txSeguirPalabra = false; vistaAjustada(); dibujarTx(); devolverFoco(); };

// Mover con un dedo, acercar con dos (pellizco)
const punteros = new Map();
let distPellizco = 0;
txLienzo.onpointerdown = e => {
    txLienzo.setPointerCapture(e.pointerId);
    punteros.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (punteros.size === 2) {
        const [a, b] = [...punteros.values()];
        distPellizco = Math.hypot(a.x - b.x, a.y - b.y);
    }
};
txLienzo.onpointermove = e => {
    if (!punteros.has(e.pointerId) || !txImagen) return;
    const dpr = window.devicePixelRatio || 1;
    const antes = punteros.get(e.pointerId);
    const ahora = { x: e.clientX, y: e.clientY };
    punteros.set(e.pointerId, ahora);
    if (punteros.size === 1) {
        txSeguirPalabra = false;
        txVista.ox += (ahora.x - antes.x) * dpr;
        txVista.oy += (ahora.y - antes.y) * dpr;
        dibujarTx();
    } else if (punteros.size === 2 && distPellizco) {
        const [a, b] = [...punteros.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const r = txLienzo.getBoundingClientRect();
        zoomEn(d / distPellizco, ((a.x + b.x) / 2 - r.left) * dpr, ((a.y + b.y) / 2 - r.top) * dpr);
        distPellizco = d;
    }
};
txLienzo.onpointerup = txLienzo.onpointercancel = e => {
    punteros.delete(e.pointerId);
    if (punteros.size < 2) distPellizco = 0;
    if (punteros.size === 0) devolverFoco();
};

// Tocar una palabra: la foto se acerca a ella y la marca en rojo (y se puede escribir de una)
txTexto.addEventListener('click', e => {
    const span = e.target.closest('.pal');
    if (!span) return;
    const i = Number(span.dataset.i);
    if (!txPalabras[i] || !txImagen) return;
    txTexto.querySelectorAll('.activa').forEach(s => s.classList.remove('activa'));
    span.classList.add('activa');
    txSel = i;
    txSeguirPalabra = true;
    centrarEnPalabra(i);
    dibujarTx();
});

// Barrita del medio: más espacio para la foto o para el texto
const txDivisor = porId('txDivisor');
let moviendoDivisor = false;
txDivisor.onpointerdown = e => { moviendoDivisor = true; txDivisor.setPointerCapture(e.pointerId); };
txDivisor.onpointermove = e => {
    if (!moviendoDivisor) return;
    const panel = porId('txPanel');
    const r = panel.getBoundingClientRect();
    const enFila = getComputedStyle(panel).flexDirection === 'row';
    const fraccion = enFila ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
    porId('txImagenPanel').style.flexBasis = `${Math.min(80, Math.max(20, fraccion * 100))}%`;
};
txDivisor.onpointerup = txDivisor.onpointercancel = () => {
    if (!moviendoDivisor) return;
    moviendoDivisor = false;
    reacomodarTx();
    devolverFoco();
};

// Teclado abierto: la pantalla se achica; se esconden botones de abajo para dar espacio
let alturaSinTeclado = window.innerHeight;
let anchoPrevio = window.innerWidth;
window.addEventListener('resize', () => {
    if (window.innerWidth !== anchoPrevio) { // se giró el celular
        anchoPrevio = window.innerWidth;
        alturaSinTeclado = window.innerHeight;
    } else if (window.innerHeight > alturaSinTeclado) {
        alturaSinTeclado = window.innerHeight;
    }
    txDlg.classList.toggle('escribiendo', window.innerHeight < alturaSinTeclado * 0.8);
    reacomodarTx();
});

// ----- Copiar, Word y compartir -----
// Texto plano de una página (con las correcciones, si las hay)
function textoDePagina(pag) {
    if (pag === txPag) return txTexto.innerText;
    if (pag.ocrHTML) {
        const d = document.createElement('div');
        d.style.cssText = 'position:fixed;left:-9999px;top:0;';
        d.innerHTML = pag.ocrHTML;
        document.body.appendChild(d);
        const t = d.innerText;
        d.remove();
        return t;
    }
    const r = pag.ocrResultado;
    if (!r) return '';
    return r.lineas.length ? r.lineas.map(l => l.map(w => w.t).join(' ')).join('\n') : r.texto;
}

function textoTodo() {
    if (txListaRevision.length === 1) return textoDePagina(txListaRevision[0]).trim();
    return txListaRevision
        .map(p => `── Página ${paginas.indexOf(p) + 1} ──\n${textoDePagina(p).trim()}`)
        .join('\n\n');
}

porId('txCopiar').onclick = async () => {
    const boton = porId('txCopiar');
    try {
        await navigator.clipboard.writeText(textoTodo());
        boton.textContent = '✅ Copiado';
    } catch {
        boton.textContent = '❌ No se pudo';
    }
    setTimeout(() => { boton.textContent = '📋 Copiar'; }, 2000);
};

// ----- Documento de Word (.docx) completo -----
// Un .docx es un .zip con varias piezas. Van todas las que Word espera:
// tipos de contenido, relaciones, documento, estilos, configuración, fuentes y datos del documento.
const XML_INICIO = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function escaparXML(texto) {
    return String(texto)
        .replace(/[\u0000-\u0008\u000B\u000C\u000D\u000E-\u001F]/g, '') // caracteres que Word no acepta
        .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Un párrafo con un estilo (Title, Subtitle, Heading1 o normal); puede empezar en hoja nueva
function parrafoWord(texto, estilo = '', hojaNueva = false) {
    const props = (estilo ? `<w:pStyle w:val="${estilo}"/>` : '') + (hojaNueva ? '<w:pageBreakBefore/>' : '');
    const pPr = props ? `<w:pPr>${props}</w:pPr>` : '';
    if (!texto) return `<w:p>${pPr}</w:p>`;
    return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${escaparXML(texto)}</w:t></w:r></w:p>`;
}

function piezasWord(cuerpo) {
    const ahora = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

    const tipos = XML_INICIO +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
        '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
        '<Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
        '</Types>';

    const relacionesPaquete = XML_INICIO +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
        '</Relationships>';

    const relacionesDocumento = XML_INICIO +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/>' +
        '</Relationships>';

    // Hoja Carta con márgenes de 2,54 cm
    const documento = XML_INICIO +
        `<w:document xmlns:w="${NS_W}" xmlns:r="${NS_REL}"><w:body>` +
        cuerpo +
        '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>' +
        '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>' +
        '<w:cols w:space="708"/></w:sectPr>' +
        '</w:body></w:document>';

    // Letra Calibri 11, español de Colombia, y estilos de título, subtítulo y encabezado
    const estilos = XML_INICIO +
        `<w:styles xmlns:w="${NS_W}">` +
        '<w:docDefaults>' +
        '<w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/>' +
        '<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="es-CO" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>' +
        '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
        '</w:docDefaults>' +
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
        '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/>' +
        '<w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>' +
        '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>' +
        '<w:next w:val="Normal"/><w:uiPriority w:val="10"/><w:qFormat/>' +
        '<w:pPr><w:spacing w:after="60"/></w:pPr>' +
        '<w:rPr><w:b/><w:color w:val="1A3D6D"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>' +
        '<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/>' +
        '<w:next w:val="Normal"/><w:uiPriority w:val="11"/><w:qFormat/>' +
        '<w:pPr><w:spacing w:after="240"/></w:pPr>' +
        '<w:rPr><w:color w:val="777777"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>' +
        '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>' +
        '<w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>' +
        '<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr>' +
        '<w:rPr><w:b/><w:color w:val="5E35B1"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>' +
        '</w:styles>';

    const configuracion = XML_INICIO +
        `<w:settings xmlns:w="${NS_W}">` +
        '<w:zoom w:percent="100"/><w:defaultTabStop w:val="708"/>' +
        '<w:characterSpacingControl w:val="doNotCompress"/>' +
        '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>' +
        '</w:settings>';

    const fuentes = XML_INICIO +
        `<w:fonts xmlns:w="${NS_W}">` +
        '<w:font w:name="Calibri"><w:panose1 w:val="020F0502020204030204"/><w:charset w:val="00"/>' +
        '<w:family w:val="swiss"/><w:pitch w:val="variable"/></w:font>' +
        '</w:fonts>';

    // Datos del documento: sin nombres ni cédulas de pacientes
    const datosBasicos = XML_INICIO +
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
        'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
        'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
        '<dc:title>Texto escaneado</dc:title><dc:creator>Escáner</dc:creator>' +
        '<cp:lastModifiedBy>Escáner</cp:lastModifiedBy><cp:revision>1</cp:revision>' +
        `<dcterms:created xsi:type="dcterms:W3CDTF">${ahora}</dcterms:created>` +
        `<dcterms:modified xsi:type="dcterms:W3CDTF">${ahora}</dcterms:modified>` +
        '</cp:coreProperties>';

    const datosApp = XML_INICIO +
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
        'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
        '<Application>Escaner Colombiana de Trasplantes</Application><DocSecurity>0</DocSecurity>' +
        '<ScaleCrop>false</ScaleCrop><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc>' +
        '<HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0000</AppVersion>' +
        '</Properties>';

    return {
        '[Content_Types].xml': tipos,
        '_rels/.rels': relacionesPaquete,
        'docProps/core.xml': datosBasicos,
        'docProps/app.xml': datosApp,
        'word/document.xml': documento,
        'word/_rels/document.xml.rels': relacionesDocumento,
        'word/styles.xml': estilos,
        'word/settings.xml': configuracion,
        'word/fontTable.xml': fuentes
    };
}

async function crearWord() {
    const hoy = new Date().toLocaleString('es-CO', { dateStyle: 'long', timeStyle: 'short' });
    const varias = txListaRevision.length > 1;
    let cuerpo = parrafoWord('Texto escaneado', 'Title') + parrafoWord(hoy, 'Subtitle');
    txListaRevision.forEach((pag, i) => {
        // Con varias páginas, cada una empieza en hoja nueva con su encabezado
        if (varias) cuerpo += parrafoWord(`Página ${paginas.indexOf(pag) + 1}`, 'Heading1', i > 0);
        textoDePagina(pag).split(/\r?\n/).forEach(linea => { cuerpo += parrafoWord(linea); });
    });

    const zip = new JSZip();
    const piezas = piezasWord(cuerpo);
    // [Content_Types].xml va primero, como lo hace Word
    Object.keys(piezas).forEach(ruta => zip.file(ruta, piezas[ruta]));
    return zip.generateAsync({
        type: 'blob',
        mimeType: TIPO_WORD,
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
    });
}

// Word: en Android se guarda directo en Descargas (Chrome no deja compartir Word);
// en iPhone y computador se intenta Compartir, y si falla, también se descarga
porId('txWord').onclick = async () => {
    const boton = porId('txWord');
    if (typeof JSZip === 'undefined') {
        alert('❌ Falta la librería de Word (libs/jszip.min.js).');
        return;
    }
    boton.textContent = '⏳ Creando...';
    const nombre = `Texto escaneado ${fechaHora()}.docx`;
    let blob;
    try {
        blob = await crearWord();
    } catch (err) {
        console.error(err);
        alert('❌ No se pudo crear el documento de Word.');
        boton.textContent = '📝 Word';
        return;
    }
    const guardarEnDescargas = () => {
        descargar(blob, nombre);
        alert(esAndroid
            ? '📥 El Word quedó guardado en Descargas.\n\n' +
            'Para enviarlo:\n' +
            '• WhatsApp: abre el chat → 📎 → Documento → elige el archivo.\n' +
            '• Teams: abre el chat → 📎 → Archivo → elige el archivo.\n' +
            '• O en la app Archivos → Descargas: deja presionado el archivo → Compartir.'
            : '📥 El Word quedó guardado en Descargas.');
    };
    try {
        const archivo = new File([blob], nombre, { type: TIPO_WORD });
        if (!esAndroid && navigator.canShare && navigator.canShare({ files: [archivo] })) {
            await navigator.share({ files: [archivo], title: nombre });
        } else {
            guardarEnDescargas();
        }
    } catch (err) {
        if (err.name !== 'AbortError') {
            console.log('Compartir Word no se pudo, se descarga:', err.message);
            guardarEnDescargas();
        }
    } finally {
        boton.textContent = '📝 Word';
    }
};

porId('txCompartir').onclick = async () => {
    const texto = textoTodo();
    const archivo = new File([texto], `Texto escaneado ${fechaHora()}.txt`, { type: 'text/plain' });
    try {
        if (navigator.canShare && navigator.canShare({ files: [archivo] })) {
            await navigator.share({ files: [archivo], title: 'Texto escaneado' });
        } else if (navigator.share) {
            await navigator.share({ title: 'Texto escaneado', text: texto });
        } else {
            await navigator.clipboard.writeText(texto);
            alert('📋 Texto copiado. Pégalo donde lo necesites.');
        }
    } catch (err) {
        if (err.name !== 'AbortError') {
            console.error(err);
            alert('❌ No se pudo compartir. Usa "Copiar".');
        }
    }
};

porId('txOtras').onclick = () => {
    guardarEdicionTx();
    dibujarMiniaturasTx();
    mostrarPaso('Elegir');
    respaldarSesion();
};

function cerrarTexto() {
    txDetenerPedido = true;
    guardarEdicionTx();
    txDlg.classList.remove('visible', 'escribiendo');
    liberar(txImagen);
    txImagen = null;
    txPag = null;
    txPalabras = [];
    txSel = -1;
    txSeguirPalabra = false;
    respaldarSesion();
}
porId('txCerrar').onclick = cerrarTexto;

// ---------- 15c. Seleccionar varias páginas (mantener presionada) ----------
// Va ANTES del bloque 15b, porque 15b dibuja las páginas al abrir y necesita estas variables
let modoSeleccion = false;
const seleccionadas = new Set(); // ids de las páginas marcadas

function entrarSeleccion(id) {
    modoSeleccion = true;
    seleccionadas.clear();
    seleccionadas.add(id);
    if (navigator.vibrate) navigator.vibrate(30); // pequeña vibración, como en las apps
    mostrarPaginas();
}
function salirSeleccion() {
    modoSeleccion = false;
    seleccionadas.clear();
    mostrarPaginas();
}
function alternarSeleccion(id) {
    if (seleccionadas.has(id)) seleccionadas.delete(id); else seleccionadas.add(id);
    if (!seleccionadas.size) { salirSeleccion(); return; }
    mostrarPaginas();
}
function actualizarBarraSeleccion() {
    document.body.classList.toggle('seleccionando', modoSeleccion);
    const n = seleccionadas.size;
    document.getElementById('selCuenta').textContent = `${n} ${n === 1 ? 'seleccionada' : 'seleccionadas'}`;
    document.getElementById('selTodas').textContent = n === paginas.length ? 'Ninguna' : 'Todas';
}
document.getElementById('selCancelar').addEventListener('click', salirSeleccion);
document.getElementById('selTodas').addEventListener('click', () => {
    if (seleccionadas.size === paginas.length) { salirSeleccion(); return; }
    paginas.forEach(p => seleccionadas.add(p.id));
    mostrarPaginas();
});
document.getElementById('selBorrar').addEventListener('click', () => {
    const n = seleccionadas.size;
    if (!n || !confirm(`¿Borrar ${n} ${n === 1 ? 'página' : 'páginas'}?`)) return;
    for (let i = paginas.length - 1; i >= 0; i--) {
        const p = paginas[i];
        if (seleccionadas.has(p.id)) {
            URL.revokeObjectURL(p.finalURL);
            paginas.splice(i, 1);
            quitarPaginaRespaldo(p.id);
        }
    }
    modoSeleccion = false;
    seleccionadas.clear();
    mostrarPaginas();
    respaldarSesion();
    estado.textContent = `✅ Se borraron ${n} ${n === 1 ? 'página' : 'páginas'}`;
});

// ---------- 15b. Diseño 2.0: cabecera, menús y avisos flotantes ----------

// Cabecera: muestra el modo y, en Paciente, la cédula leída de la primera página
function actualizarCabecera() {
    const btn = document.getElementById('modoBtn');
    const poner = texto => { btn.innerHTML = `<span>${texto}</span><svg class="ic"><use href="#i-cambiar"/></svg>`; };
    if (tipoDoc !== 'paciente') { poner('Documento'); return; }
    poner('Paciente');
    const pag = paginas[0];
    if (!pag) return;
    leerPagina(pag).then(d => {
        if (tipoDoc === 'paciente' && paginas[0] === pag && d.cedula) {
            poner(`Paciente · ${formatoCedula(d.cedula)}`);
        }
    });
}

// Menú de una página: aparece al tocar una miniatura
const hoja = document.getElementById('hoja');
let paginaMenu = -1;
function abrirMenuPagina(i) {
    paginaMenu = i;
    document.getElementById('hojaTitulo').textContent = `Página ${i + 1} de ${paginas.length}`;
    hoja.querySelector('[data-accion="antes"]').disabled = i === 0;
    hoja.querySelector('[data-accion="despues"]').disabled = i === paginas.length - 1;
    hoja.querySelector('[data-accion="recorte"]').disabled = !opencvListo;
    hoja.classList.add('visible');
}
hoja.addEventListener('click', e => {
    const boton = e.target.closest('button[data-accion]');
    if (e.target !== hoja && !boton) return;
    const i = paginaMenu;
    hoja.classList.remove('visible');
    paginaMenu = -1;
    if (!boton || i < 0 || !paginas[i]) return;
    const accion = boton.dataset.accion;
    if (accion === 'recorte') editarPagina(i);
    if (accion === 'girar') rotarPagina(i);
    if (accion === 'seleccionar') entrarSeleccion(paginas[i].id);
    if (accion === 'antes') moverPagina(i, -1);
    if (accion === 'despues') moverPagina(i, 1);
    if (accion === 'borrar' && confirm(`¿Borrar la página ${i + 1}?`)) borrarPagina(i);
});

// Menú "Más": Empezar de nuevo, Reportar problema y versión
const menuMas = document.getElementById('menuMas');
document.getElementById('masBtn').addEventListener('click', () => menuMas.classList.add('visible'));
menuMas.addEventListener('click', e => {
    if (e.target === menuMas || e.target.closest('button')) menuMas.classList.remove('visible');
});

// Avisos flotantes: toman el mensaje de #estado, le quitan el emoji del inicio
// y lo muestran con un icono propio (los importantes duran más)
const aviso = document.getElementById('aviso');
let temporizadorAviso = null;
new MutationObserver(() => {
    const original = estado.textContent.trim();
    if (!original) return;
    const importante = /^(⚠|❌|🔒|✋)/u.test(original);
    document.getElementById('avisoTexto').textContent = original.replace(/^[^\p{L}\p{N}¿¡]+/u, '');
    document.getElementById('avisoIcono').setAttribute('href', importante ? '#i-alerta' : '#i-ok');
    aviso.classList.toggle('alerta', importante);
    aviso.classList.add('visible');
    clearTimeout(temporizadorAviso);
    temporizadorAviso = setTimeout(() => aviso.classList.remove('visible'), importante ? 7000 : 3500);
}).observe(estado, { childList: true, characterData: true, subtree: true });
aviso.addEventListener('click', () => aviso.classList.remove('visible'));
mostrarPaginas(); // dibuja la pantalla vacía al abrir

// ---------- 16. Recuperar el trabajo al volver a la app ----------
async function recuperarTrabajo() {
    let sesion, registros;
    try {
        sesion = await enBD('sesion', tx => tx.objectStore('sesion').get('actual'));
        registros = await enBD('paginas', tx => tx.objectStore('paginas').getAll());
    } catch (err) {
        console.error(err); // sin almacenamiento la app funciona igual, solo que sin respaldo
        return;
    }

    const orden = (sesion && sesion.orden) || [];
    if (!orden.length) {
        if (registros.length) borrarRespaldo(); // restos sueltos de una vez anterior
        return;
    }

    // Regla de los 10 minutos: si pasó más tiempo sin uso, se borra todo
    if (Date.now() - actividadAnterior >= MINUTOS_INACTIVIDAD * 60000) {
        await borrarRespaldo();
        avisoInicio = '🔒 Las páginas se borraron por inactividad (protección de datos)';
        estado.textContent = avisoInicio;
        return;
    }

    await mostrarCargando(true);
    let revisionPendiente = null;
    try {
        const porIdReg = new Map(registros.map(r => [r.id, r]));
        const textos = sesion.textos || {};
        for (const id of orden) {
            const r = porIdReg.get(id);
            if (!r || !r.baseBlob || !r.recBlob || !r.finalBlob) continue;
            const pag = {
                id: r.id,
                baseBlob: r.baseBlob,
                esquinas: r.esquinas,
                giro: r.giro || 0,
                recBlob: r.recBlob,
                finalBlob: r.finalBlob,
                finalURL: URL.createObjectURL(r.finalBlob),
                ancho: r.ancho,
                alto: r.alto,
                formato: r.formato,
                lectura: null,
                ocrPromesa: null,
                ocrResultado: null,
                ocrListo: false,
                ocrHTML: textos[r.id] || null
            };
            if (r.ocrResultado) { // ya estaba leída: no se vuelve a leer
                pag.ocrResultado = r.ocrResultado;
                pag.ocrListo = true;
                pag.ocrPromesa = Promise.resolve(r.ocrResultado);
            }
            paginas.push(pag);
        }

        // Quitar páginas guardadas que ya no hacen parte del documento
        registros.forEach(r => { if (!paginas.some(p => p.id === r.id)) quitarPaginaRespaldo(r.id); });
        if (!paginas.length) { borrarRespaldo(); return; }

        if (sesion.modo) { modo = sesion.modo; marcarModo(); }
        mostrarPaginas();
        respaldarSesion();
        localStorage.setItem('ultimaActividad', String(Date.now()));
        const n = paginas.length;
        avisoInicio = `♻️ Se recuperó tu trabajo: ${n} ${n === 1 ? 'página' : 'páginas'}`;
        estado.textContent = avisoInicio;
        revisionPendiente = sesion.revision;
    } catch (err) {
        console.error(err);
        estado.textContent = '⚠️ No se pudo recuperar el trabajo anterior';
    } finally {
        mostrarCargando(false);
    }

    // Si estaba revisando el texto, se vuelve a abrir en la misma página
    if (revisionPendiente && revisionPendiente.ids) {
        const lista = revisionPendiente.ids
            .map(id => paginas.find(p => p.id === id))
            .filter(p => p && p.ocrListo);
        if (lista.length) {
            const actual = lista.find(p => p.id === revisionPendiente.actual) || lista[0];
            txSeleccion = new Set(lista.map(p => paginas.indexOf(p)));
            txDlg.classList.add('visible');
            mostrarPaso('Revisar');
            dibujarPestanas(lista);
            try { await mostrarPaginaTx(actual); } catch (err) { console.error(err); cerrarTexto(); }
        }
    }
}

// Se revisa al abrir la app (va en la fila: si tomas una foto de inmediato, espera a que termine)
enCola(recuperarTrabajo);

// ---------- 17. App instalable y sin internet (PWA, 2.4) ----------
// El service worker guarda la app en el celular para que abra sin internet.
// En Live Server (computador) no se activa, para que los cambios se vean al instante.
const nuevaVersion = document.getElementById('nuevaVersion');
let swEsperando = null;

function mostrarNuevaVersion(sw) {
    swEsperando = sw;
    nuevaVersion.classList.add('visible');
}

document.getElementById('nuevaVersionBtn').addEventListener('click', () => {
    if (!swEsperando) return;
    // Guardar lo último antes de recargar: el trabajo se recupera al abrir
    if (txDlg.classList.contains('visible')) guardarEdicionTx();
    respaldarSesion();
    localStorage.setItem('ultimaActividad', String(Date.now()));
    nuevaVersion.classList.remove('visible');
    swEsperando.postMessage('actualizar');
});

const enComputadorLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
if ('serviceWorker' in navigator && !enComputadorLocal) {
    let recargando = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (recargando) return;
        recargando = true;
        location.reload();
    });
    navigator.serviceWorker.register('service-worker.js').then(reg => {
        const revisar = () => {
            if (reg.waiting && navigator.serviceWorker.controller) mostrarNuevaVersion(reg.waiting);
        };
        revisar();
        reg.addEventListener('updatefound', () => {
            const nuevo = reg.installing;
            if (nuevo) nuevo.addEventListener('statechange', () => { if (nuevo.state === 'installed') revisar(); });
        });
        // Cada vez que se vuelve a la app, se revisa si hay versión nueva
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) reg.update().catch(() => { });
        });
    }).catch(err => console.error(err));
}

// Almacenamiento persistente: pide a Chrome que no borre el historial si el celular se llena
if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persisted()
        .then(ya => ya || navigator.storage.persist())
        .then(ok => console.log('Almacenamiento persistente:', ok))
        .catch(() => { });
}


