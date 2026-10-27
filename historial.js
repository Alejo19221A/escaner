// =====================================================================
// historial.js – Historial de envíos (versión 2.1.1)
// Guarda en ESTE celular cada PDF que se comparte o se guarda, con su
// registro: quién lo envió, cuándo, de qué paciente y cómo salió.
// Se borra solo a los 7 días. Nada sale del celular.
// La vista previa usa PDF.js (libs/pdfjs), que se carga solo al usarla.
// Usa funciones de app.js, por eso se carga DESPUÉS de app.js.
// =====================================================================
const DIAS_HISTORIAL = 7;
const UN_DIA = 24 * 60 * 60 * 1000;
let enviosCache = [];   // registros en memoria: para buscar y avisar duplicados al instante
let bdHistorial = null;

// ---------- Base de datos del historial (aparte del respaldo del trabajo) ----------
function abrirBDHistorial() {
    if (!bdHistorial) {
        bdHistorial = new Promise((resolve, reject) => {
            if (!window.indexedDB) { reject(new Error('Sin almacenamiento para el historial')); return; }
            const pedido = indexedDB.open('escanerHistorial', 1);
            pedido.onupgradeneeded = () => pedido.result.createObjectStore('envios', { keyPath: 'id' });
            pedido.onsuccess = () => resolve(pedido.result);
            pedido.onerror = () => reject(pedido.error);
        });
        bdHistorial.catch(() => { bdHistorial = null; });
    }
    return bdHistorial;
}

function enHistorial(accion) {
    return abrirBDHistorial().then(bd => new Promise((resolve, reject) => {
        const tx = bd.transaction('envios', 'readwrite');
        const pedido = accion(tx.objectStore('envios'));
        tx.oncomplete = () => resolve(pedido ? pedido.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('No se guardó el historial'));
    }));
}

// Lee el historial y borra lo que tenga más de 7 días
async function cargarHistorial() {
    try {
        const todos = await enHistorial(a => a.getAll());
        const limite = Date.now() - DIAS_HISTORIAL * UN_DIA;
        const viejos = todos.filter(r => r.fecha < limite);
        if (viejos.length) await enHistorial(a => { viejos.forEach(r => a.delete(r.id)); });
        enviosCache = todos.filter(r => r.fecha >= limite).sort((a, b) => b.fecha - a.fecha);
    } catch (err) {
        console.error(err);
    }
}

// ---------- Ayudantes de fechas y texto ----------
function inicioDia(diasAtras = 0) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - diasAtras);
    return d.getTime();
}
const horaDe = t => new Date(t).toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit' });
function cuandoDe(t) {
    if (t >= inicioDia(0)) return `hoy ${horaDe(t)}`;
    return `${new Date(t).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' })} ${horaDe(t)}`;
}
function nombreDia(t) {
    if (t >= inicioDia(0)) return 'Hoy';
    if (t >= inicioDia(1)) return 'Ayer';
    return new Date(t).toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
}
const sinTildes = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const textoDestino = d => (d === 'Otro' ? 'otra app' : d);

// ---------- Usuario de este celular ----------
function usuarioActual() {
    return `${localStorage.getItem('usuNombre') || ''} ${localStorage.getItem('usuApellido') || ''}`.trim();
}
function actualizarUsuarioMenu() {
    const u = usuarioActual();
    document.getElementById('usuarioTexto').textContent = u ? `Usuario: ${u}` : 'Escribir mi nombre';
}
const nombreDlg = document.getElementById('nombreDlg');
function abrirNombre(obligatorio) {
    document.getElementById('usuNombre').value = localStorage.getItem('usuNombre') || '';
    document.getElementById('usuApellido').value = localStorage.getItem('usuApellido') || '';
    document.getElementById('usuCancelar').style.display = obligatorio ? 'none' : '';
    nombreDlg.classList.add('visible');
}
function guardarNombre() {
    const limpiar = s => s.trim().replace(/\s+/g, ' ');
    const n = limpiar(document.getElementById('usuNombre').value);
    const a = limpiar(document.getElementById('usuApellido').value);
    if (n.length < 2 || a.length < 2) { alert('Escribe tu nombre y tu apellido.'); return; }
    localStorage.setItem('usuNombre', n);
    localStorage.setItem('usuApellido', a);
    nombreDlg.classList.remove('visible');
    actualizarUsuarioMenu();
    estado.textContent = `✅ Hola, ${n}`;
}
document.getElementById('usuGuardar').addEventListener('click', guardarNombre);
document.getElementById('usuApellido').addEventListener('keydown', e => { if (e.key === 'Enter') guardarNombre(); });
document.getElementById('usuCancelar').addEventListener('click', () => nombreDlg.classList.remove('visible'));
document.getElementById('usuarioBtn').addEventListener('click', () => abrirNombre(false));

// ---------- ¿A dónde lo enviaste? (opcional; recuerda la última elección) ----------
const destinoActivo = () => localStorage.getItem('preguntarDestino') !== 'no';
function actualizarOpcionDestino() {
    document.getElementById('destinoOpcionTexto').textContent =
        `Preguntar destino al compartir: ${destinoActivo() ? 'Sí' : 'No'}`;
}
document.getElementById('destinoOpcionBtn').addEventListener('click', () => {
    localStorage.setItem('preguntarDestino', destinoActivo() ? 'no' : 'si');
    actualizarOpcionDestino();
    estado.textContent = destinoActivo()
        ? '✅ La app preguntará a dónde enviaste cada PDF'
        : '✅ La app ya no preguntará a dónde enviaste';
});

function preguntarDestino() {
    if (!destinoActivo()) return Promise.resolve('');
    const capa = document.getElementById('destinoDlg');
    const ultimo = localStorage.getItem('ultimoDestino') || '';
    capa.querySelectorAll('button[data-destino]').forEach(b =>
        b.classList.toggle('sugerido', !!ultimo && b.dataset.destino === ultimo));
    capa.classList.add('visible');
    return new Promise(resolve => {
        capa.onclick = e => {
            const boton = e.target.closest('button[data-destino]');
            if (e.target !== capa && !boton) return;
            capa.classList.remove('visible');
            capa.onclick = null;
            const elegido = boton ? boton.dataset.destino : '';
            if (elegido) localStorage.setItem('ultimoDestino', elegido);
            resolve(elegido);
        };
    });
}

// ---------- Anotar envíos (lo llama app.js al Guardar o Compartir) ----------
// indices: qué PDF de la lista se enviaron; como: 'Guardado' o 'Compartido'
async function anotarEnvio(indices, blobs, nombres, como) {
    const lista = archivos(); // de app.js: cada PDF con sus páginas y sus datos
    const ahora = Date.now();
    const nuevos = indices.map(i => {
        const a = lista[i] || { paginas: [], datos: {} };
        const d = a.datos || {};
        return {
            id: `${ahora}-${i}-${Math.random().toString(36).slice(2, 6)}`,
            fecha: ahora,
            usuario: usuarioActual(),
            tipo: tipoDoc,
            cedula: (d.cedula || '').replace(/\D/g, ''),
            paciente: tipoDoc === 'paciente' ? limpiarNombre(d.nombre || '') : '',
            titulo: tipoDoc === 'normal' ? limpiarTitulo(d.titulo || '') : '',
            archivo: nombres[i],
            paginas: a.paginas.length,
            como,
            destino: '',
            reenvios: [],
            pdf: blobs[i]
        };
    });
    try {
        await enHistorial(alm => { nuevos.forEach(r => alm.put(r)); });
        enviosCache = [...nuevos, ...enviosCache];
    } catch (err) {
        console.error(err);
        return;
    }
    if (como === 'Compartido') {
        const destino = await preguntarDestino();
        if (destino) {
            nuevos.forEach(r => { r.destino = destino; });
            enHistorial(alm => { nuevos.forEach(r => alm.put(r)); }).catch(err => console.error(err));
        }
    }
}

// ---------- Aviso de posible duplicado (lo usa la ventana de guardar) ----------
function textoDuplicados(lista) {
    if (tipoDoc !== 'paciente') return '';
    const hoy = inicioDia(0);
    const avisos = [];
    lista.forEach(a => {
        const c = ((a.datos && a.datos.cedula) || '').replace(/\D/g, '');
        if (c.length < 5) return;
        const previo = enviosCache.find(r => r.cedula === c && r.fecha >= hoy);
        if (previo) avisos.push(`La cédula ${formatoCedula(c)} ya se envió hoy a las ${horaDe(previo.fecha)}.`);
    });
    return avisos.length ? `${avisos.join(' ')} Revisa que no sea un duplicado.` : '';
}

// ---------- Pantalla del historial ----------
const historialDlg = document.getElementById('historialDlg');
let hiFiltroDias = 'hoy';
let hiFiltroTipo = 'todos';

function filtrarEnvios() {
    const texto = sinTildes(document.getElementById('hiBuscar').value.trim());
    const digitos = texto.replace(/\D/g, '');
    const hoy = inicioDia(0), ayer = inicioDia(1);
    return enviosCache.filter(r => {
        if (hiFiltroTipo !== 'todos' && r.tipo !== hiFiltroTipo) return false;
        if (texto) { // al buscar, se busca en los 7 días
            if (digitos.length >= 3 && r.cedula.includes(digitos)) return true;
            return sinTildes(`${r.paciente} ${r.titulo} ${r.archivo} ${r.usuario}`).includes(texto);
        }
        if (hiFiltroDias === 'hoy') return r.fecha >= hoy;
        if (hiFiltroDias === 'ayer') return r.fecha >= ayer && r.fecha < hoy;
        return true;
    });
}

function dibujarHistorial() {
    const lista = filtrarEnvios();
    const buscando = document.getElementById('hiBuscar').value.trim() !== '';

    // Resumen: cuántos PDF envió cada persona
    const porPersona = {};
    lista.forEach(r => { const u = r.usuario || 'Sin nombre'; porPersona[u] = (porPersona[u] || 0) + 1; });
    const titulo = buscando ? 'Resultados (últimos 7 días)'
        : { hoy: 'Enviados hoy', ayer: 'Enviados ayer', todos: 'Últimos 7 días' }[hiFiltroDias];
    const filas = Object.entries(porPersona)
        .map(([u, n]) => `<div><span>${escaparHTML(u)}</span><b>${n} PDF</b></div>`).join('');
    const total = Object.keys(porPersona).length > 1 ? `<div><span>Total</span><b>${lista.length} PDF</b></div>` : '';
    document.getElementById('hiResumen').innerHTML =
        lista.length ? `<p class="hiResTitulo">${titulo}</p>${filas}${total}` : '';

    // Lista agrupada por día
    const cont = document.getElementById('hiLista');
    if (!lista.length) {
        cont.innerHTML = `<p class="hiVacio">${buscando ? 'No se encontraron envíos con esa búsqueda.' : 'No hay envíos en este período.'}</p>`;
        return;
    }
    let html = '', diaActual = '';
    lista.forEach(r => {
        const dia = nombreDia(r.fecha);
        if (dia !== diaActual) { html += `<h3 class="hiDia">${dia}</h3>`; diaActual = dia; }
        const quien = r.tipo === 'paciente'
            ? `CC ${formatoCedula(r.cedula)} · ${r.paciente}`
            : r.titulo || r.archivo;
        const como = r.destino ? `${r.como} por ${textoDestino(r.destino)}` : r.como;
        const quedan = Math.max(1, Math.ceil((r.fecha + DIAS_HISTORIAL * UN_DIA - Date.now()) / UN_DIA));
        let reenvio = '';
        if (r.reenvios && r.reenvios.length) {
            const ultimo = r.reenvios[r.reenvios.length - 1];
            const veces = r.reenvios.length === 1 ? 'una vez' : `${r.reenvios.length} veces`;
            reenvio = `<div class="hiReenvio">Reenviado ${veces} · último ${cuandoDe(ultimo.fecha)}` +
                (ultimo.destino ? ` por ${escaparHTML(textoDestino(ultimo.destino))}` : '') + '</div>';
        }
        html += `<div class="hiItem" data-id="${r.id}">
      <div class="hiFila1"><b>${horaDe(r.fecha)}</b><span>${escaparHTML(quien)}</span></div>
      <div class="hiFila2">${r.paginas} ${r.paginas === 1 ? 'pág.' : 'págs.'} · ${escaparHTML(como)} · ${escaparHTML(r.usuario || 'Sin nombre')}</div>
      ${reenvio}
      <div class="hiFila3">Se borra en ${quedan} ${quedan === 1 ? 'día' : 'días'}</div>
    </div>`;
    });
    cont.innerHTML = html;
}

// Abrir y cerrar el historial
document.getElementById('historialBtn').addEventListener('click', async () => {
    await cargarHistorial();
    historialDlg.classList.add('visible');
    dibujarHistorial();
});
document.getElementById('hiCerrar').addEventListener('click', () => historialDlg.classList.remove('visible'));
document.getElementById('hiBuscar').addEventListener('input', dibujarHistorial);

// Filtros: Hoy / Ayer / 7 días y Todos / Paciente / Documento
function marcarFiltro(grupo, activo) {
    document.querySelectorAll(`#${grupo} button`).forEach(b => b.classList.toggle('activo', b === activo));
}
document.getElementById('hiDias').addEventListener('click', e => {
    const b = e.target.closest('button[data-dias]');
    if (!b) return;
    hiFiltroDias = b.dataset.dias;
    marcarFiltro('hiDias', b);
    dibujarHistorial();
});
document.getElementById('hiTipos').addEventListener('click', e => {
    const b = e.target.closest('button[data-tipo]');
    if (!b) return;
    hiFiltroTipo = b.dataset.tipo;
    marcarFiltro('hiTipos', b);
    dibujarHistorial();
});

// Tocar un envío: se abre la vista previa
document.getElementById('hiLista').addEventListener('click', e => {
    const item = e.target.closest('.hiItem');
    if (!item) return;
    const r = enviosCache.find(x => x.id === item.dataset.id);
    if (r) abrirVisor(r);
});

// ---------- Vista previa del PDF (PDF.js) ----------
const visorDlg = document.getElementById('visorDlg');
const viPaginas = document.getElementById('viPaginas');
let viRegistro = null;  // envío que se está viendo
let viURLs = [];        // imágenes de las páginas (se liberan al cerrar)
let viTurno = 0;        // evita mezclar páginas si se abre otro PDF rápido
let viZoom = 1;
let pdfjsPromesa = null;

// Carga PDF.js solo la primera vez que se necesita
function cargarPDFjs() {
    if (!pdfjsPromesa) {
        pdfjsPromesa = new Promise((resolve, reject) => {
            if (window.pdfjsLib) { resolve(window.pdfjsLib); return; }
            const s = document.createElement('script');
            s.src = 'libs/pdfjs/pdf.min.js';
            s.onload = () => {
                const lib = window.pdfjsLib || window['pdfjs-dist/build/pdf'];
                if (!lib) { reject(new Error('PDF.js no cargó')); return; }
                lib.GlobalWorkerOptions.workerSrc = 'libs/pdfjs/pdf.worker.min.js';
                resolve(lib);
            };
            s.onerror = () => reject(new Error('No se encontró libs/pdfjs/pdf.min.js'));
            document.head.appendChild(s);
        });
        pdfjsPromesa.catch(() => { pdfjsPromesa = null; });
    }
    return pdfjsPromesa;
}

function limpiarVisor() {
    viURLs.forEach(u => URL.revokeObjectURL(u));
    viURLs = [];
    viPaginas.innerHTML = '';
}

async function abrirVisor(r) {
    const turno = ++viTurno;
    viRegistro = r;
    limpiarVisor();
    document.getElementById('viTitulo').textContent = r.archivo;
    visorDlg.classList.add('visible');
    ponerZoom(1);
    viPaginas.scrollTop = 0;
    viPaginas.innerHTML = '<p class="viCargando">Cargando vista previa...</p>';
    let doc = null;
    try {
        const lib = await cargarPDFjs();
        const datos = new Uint8Array(await r.pdf.arrayBuffer());
        // isEvalSupported: false = protección contra PDF maliciosos
        doc = await lib.getDocument({ data: datos, isEvalSupported: false }).promise;
        if (turno !== viTurno) return;
        viPaginas.innerHTML = '';
        const anchoMeta = Math.min(1400, Math.round(viPaginas.clientWidth * (window.devicePixelRatio || 1) * 1.5));
        for (let n = 1; n <= doc.numPages; n++) {
            if (turno !== viTurno) return;
            const pagina = await doc.getPage(n);
            const base = pagina.getViewport({ scale: 1 });
            const vista = pagina.getViewport({ scale: anchoMeta / base.width });
            const c = document.createElement('canvas');
            c.width = Math.round(vista.width);
            c.height = Math.round(vista.height);
            await pagina.render({ canvasContext: c.getContext('2d'), viewport: vista }).promise;
            const blob = await aBlob(c, 0.85); // de app.js: la página como imagen liviana
            liberar(c);
            pagina.cleanup();
            if (turno !== viTurno) return;
            const url = URL.createObjectURL(blob);
            viURLs.push(url);
            const img = document.createElement('img');
            img.src = url;
            img.alt = `Página ${n}`;
            viPaginas.appendChild(img);
        }
    } catch (err) {
        console.error(err);
        if (turno === viTurno) {
            viPaginas.innerHTML = '<p class="viCargando">No se pudo mostrar la vista previa. Puedes reenviarlo o guardarlo.</p>';
        }
    } finally {
        if (doc) doc.destroy();
    }
}

function cerrarVisor() {
    viTurno++;
    visorDlg.classList.remove('visible');
    limpiarVisor();
    viRegistro = null;
}
document.getElementById('viCerrar').addEventListener('click', cerrarVisor);

// Zoom: botones y pellizco con dos dedos (mantiene el punto que se está mirando)
function ponerZoom(nuevo, cx = viPaginas.clientWidth / 2, cy = viPaginas.clientHeight / 2) {
    nuevo = Math.min(4, Math.max(1, nuevo));
    const f = nuevo / viZoom;
    const x = viPaginas.scrollLeft + cx, y = viPaginas.scrollTop + cy;
    viZoom = nuevo;
    viPaginas.style.setProperty('--zoom', nuevo);
    viPaginas.scrollLeft = x * f - cx;
    viPaginas.scrollTop = y * f - cy;
}
document.getElementById('viMas').addEventListener('click', () => ponerZoom(viZoom * 1.5));
document.getElementById('viMenos').addEventListener('click', () => ponerZoom(viZoom / 1.5));
document.getElementById('viAjustar').addEventListener('click', () => ponerZoom(1));

let viDist = 0, viZoomInicio = 1;
const distanciaDedos = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
viPaginas.addEventListener('touchstart', e => {
    if (e.touches.length === 2) { viDist = distanciaDedos(e.touches); viZoomInicio = viZoom; }
}, { passive: true });
viPaginas.addEventListener('touchmove', e => {
    if (e.touches.length !== 2 || !viDist) return;
    e.preventDefault();
    const caja = viPaginas.getBoundingClientRect();
    const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - caja.left;
    const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - caja.top;
    ponerZoom(viZoomInicio * distanciaDedos(e.touches) / viDist, cx, cy);
}, { passive: false });
viPaginas.addEventListener('touchend', e => { if (e.touches.length < 2) viDist = 0; });

// Botones de abajo: Reenviar, Guardar y Borrar
document.querySelector('.viPie').addEventListener('click', async e => {
    const boton = e.target.closest('button[data-hacer]');
    if (!boton || !viRegistro) return;
    const r = viRegistro;
    const accion = boton.dataset.hacer;

    if (accion === 'compartir') await reenviar(r);

    if (accion === 'guardar') {
        descargar(r.pdf, r.archivo);
        estado.textContent = '✅ El PDF quedó de nuevo en Descargas';
    }

    if (accion === 'borrar' && await preguntar('¿Borrar este envío del historial?', 'Borrar', 'Cancelar',
        { peligro: true, alerta: true })) {
        try {
            await enHistorial(a => a.delete(r.id));
            enviosCache = enviosCache.filter(x => x.id !== r.id);
            cerrarVisor();
            dibujarHistorial();
        } catch (err) {
            console.error(err);
            estado.textContent = '❌ No se pudo borrar del historial';
        }
    }
});

// Reenviar: abre el menú de Compartir del celular y anota el reenvío
async function reenviar(r) {
    const archivo = new File([r.pdf], r.archivo, { type: 'application/pdf' });
    if (!navigator.canShare || !navigator.canShare({ files: [archivo] })) {
        descargar(r.pdf, r.archivo);
        estado.textContent = '⚠️ Este celular no deja compartir: el PDF quedó en Descargas';
        return;
    }
    try {
        await navigator.share({ files: [archivo], title: r.archivo });
    } catch (err) {
        if (err.name !== 'AbortError') {
            console.error(err);
            estado.textContent = '❌ No se pudo reenviar. Intenta otra vez.';
        }
        return;
    }
    const destino = await preguntarDestino();
    r.reenvios = [...(r.reenvios || []), { fecha: Date.now(), destino }];
    try {
        await enHistorial(a => a.put(r));
    } catch (err) {
        console.error(err);
    }
    dibujarHistorial();
    estado.textContent = '✅ Reenvío anotado en el historial';
}

// ---------- Al abrir la app ----------
cargarHistorial();
actualizarUsuarioMenu();
actualizarOpcionDestino();
if (!usuarioActual()) abrirNombre(true);

// ---------- Abrir PDF: convierte cada página de un PDF en una página escaneada ----------
const MAX_PAGINAS_PDF = 30;

document.getElementById('abrirPdfBtn').addEventListener('click', () => {
    document.getElementById('entradaPDF').click();
});
document.getElementById('entradaPDF').addEventListener('change', e => {
    const archivo = e.target.files[0];
    e.target.value = '';
    if (!archivo) return;
    enCola(() => importarPDF(archivo)); // en fila, igual que las fotos
});

async function importarPDF(archivo) {
    const textoCargando = document.querySelector('#cargando div');
    await mostrarCargando(true);
    let doc = null;
    try {
        textoCargando.textContent = 'Abriendo PDF...';
        const lib = await cargarPDFjs();
        const datos = new Uint8Array(await archivo.arrayBuffer());
        // isEvalSupported: false = protección contra PDF maliciosos
        doc = await lib.getDocument({ data: datos, isEvalSupported: false }).promise;
        const total = doc.numPages;
        if (total > MAX_PAGINAS_PDF &&
            !(await preguntar(`El PDF tiene ${total} páginas. Se traerán las primeras ${MAX_PAGINAS_PDF}.`, 'Continuar', 'Cancelar'))) {
            return;
        }
        const cuantas = Math.min(total, MAX_PAGINAS_PDF);
        for (let n = 1; n <= cuantas; n++) {
            textoCargando.textContent = `Abriendo PDF: página ${n} de ${cuantas}...`;
            const pagina = await doc.getPage(n);
            // Tamaño a 200 DPI (el PDF mide en puntos: 72 por pulgada), sin pasarse de 2800 px
            let vista = pagina.getViewport({ scale: DPI / 72 });
            const lado = Math.max(vista.width, vista.height);
            if (lado > 2800) vista = pagina.getViewport({ scale: (DPI / 72) * (2800 / lado) });
            const c = document.createElement('canvas');
            c.width = Math.round(vista.width);
            c.height = Math.round(vista.height);
            const ctx = c.getContext('2d');
            ctx.fillStyle = 'white';
            ctx.fillRect(0, 0, c.width, c.height);
            await pagina.render({ canvasContext: ctx, viewport: vista }).promise;
            pagina.cleanup();
            await agregarPagina(c, null, n <= 2); // la cédula solo se busca en las 2 primeras
            liberar(c);
        }
        estado.textContent = `✅ Se agregaron ${cuantas} ${cuantas === 1 ? 'página' : 'páginas'} del PDF`;
    } catch (err) {
        console.error(err);
        estado.textContent = err && err.name === 'PasswordException'
            ? '❌ Ese PDF tiene contraseña: no se puede abrir'
            : '❌ No se pudo abrir el PDF';
    } finally {
        if (doc) doc.destroy();
        textoCargando.textContent = 'Procesando...';
        mostrarCargando(false);
    }
}