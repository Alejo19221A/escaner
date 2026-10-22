// =====================================================================
// historial.js – Historial de envíos (versión 2.1)
// Guarda en ESTE celular cada PDF que se comparte o se guarda, con su
// registro: quién lo envió, cuándo, de qué paciente y cómo salió.
// Se borra solo a los 7 días. Nada sale del celular.
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

// ---------- ¿A dónde lo enviaste? (opcional, un toque) ----------
function preguntarDestino() {
  const capa = document.getElementById('destinoDlg');
  capa.classList.add('visible');
  return new Promise(resolve => {
    capa.onclick = e => {
      const boton = e.target.closest('button[data-destino]');
      if (e.target !== capa && !boton) return;
      capa.classList.remove('visible');
      capa.onclick = null;
      resolve(boton ? boton.dataset.destino : '');
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
const hiAcciones = document.getElementById('hiAcciones');
let hiFiltroDias = 'hoy';
let hiFiltroTipo = 'todos';
let hiSeleccion = null;

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

// Tocar un envío: Reenviar, Guardar de nuevo o Borrar
document.getElementById('hiLista').addEventListener('click', e => {
  const item = e.target.closest('.hiItem');
  if (!item) return;
  hiSeleccion = enviosCache.find(r => r.id === item.dataset.id);
  if (!hiSeleccion) return;
  document.getElementById('hiAccTitulo').textContent = hiSeleccion.archivo;
  hiAcciones.classList.add('visible');
});

hiAcciones.addEventListener('click', async e => {
  const boton = e.target.closest('button[data-hacer]');
  if (e.target !== hiAcciones && !boton) return;
  hiAcciones.classList.remove('visible');
  const r = hiSeleccion;
  hiSeleccion = null;
  if (!boton || !boton.dataset.hacer || !r) return;
  const accion = boton.dataset.hacer;

  if (accion === 'compartir') await reenviar(r);

  if (accion === 'guardar') {
    descargar(r.pdf, r.archivo);
    estado.textContent = '✅ El PDF quedó de nuevo en Descargas';
  }

  if (accion === 'borrar' && confirm('¿Borrar este envío del historial?')) {
    try {
      await enHistorial(a => a.delete(r.id));
      enviosCache = enviosCache.filter(x => x.id !== r.id);
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
}

// ---------- Al abrir la app ----------
cargarHistorial();
actualizarUsuarioMenu();
if (!usuarioActual()) abrirNombre(true);