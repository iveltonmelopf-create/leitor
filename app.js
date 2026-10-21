'use strict';
/* Leitor EPUB/PDF — sincroniza progresso, destaques, notas e tinta via Google Drive (appDataFolder) */

const SCOPES = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.appdata';
const $ = s => document.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
const now = () => Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const COLORS = ['#facc15', '#4ade80', '#60a5fa', '#f472b6', '#fb923c'];
const INK_COLORS = ['#111111', '#2563eb', '#dc2626', '#16a34a', '#facc15'];

pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js';

/* ---------- armazenamento local ---------- */
const idb = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('leitor', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('files'); r.result.createObjectStore('kv'); };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode); const q = fn(t.objectStore(store));
      t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error);
    });
  },
  get: (s, k) => idb.tx(s, 'readonly', o => o.get(k)),
  set: (s, k, v) => idb.tx(s, 'readwrite', o => o.put(v, k)),
  del: (s, k) => idb.tx(s, 'readwrite', o => o.delete(k)),
  keys: s => idb.tx(s, 'readonly', o => o.getAllKeys()),
};

const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } };

let cfg = Object.assign({ clientId: '674620611576-d1gfmdv2t89kn9fia7rn4svli0s46m8l.apps.googleusercontent.com', folder: '', theme: 'light', fs: 110, flow: 'paginated', finger: false, zoom: 1 }, lsGet('cfg', {}));
const saveCfg = () => lsSet('cfg', cfg);

// S.library: [{id,name,mime,size,mt,cover,local}]  S.books[id]: {prog,hl,ink}  S.driveIds[id]: id do json no appData
let S = { library: [], books: {}, driveIds: {} };
let dlCache = new Set(); // ids com arquivo baixado
let saveT;
function saveState() { clearTimeout(saveT); saveT = setTimeout(() => idb.set('kv', 'state', S).catch(() => { }), 400); }
const getBook = id => (S.books[id] ||= { prog: null, hl: [], ink: [] });

function toast(msg, ms = 2800) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, ms);
}

/* ---------- login Google / Drive ---------- */
let token = null, tokenExp = 0;
try { const t = lsGet('token', null); if (t && t.exp > Date.now()) { token = t.v; tokenExp = t.exp; } } catch { }
const authed = () => token && Date.now() < tokenExp;

function signIn(prompt = '') {
  return new Promise((res, rej) => {
    if (!cfg.clientId) return rej(new Error('Falta o Client ID (⚙).'));
    if (!window.google || !google.accounts) return rej(new Error('Google indisponível (sem internet?).'));
    const tc = google.accounts.oauth2.initTokenClient({
      client_id: cfg.clientId, scope: SCOPES,
      callback: r => {
        if (r.error) return rej(new Error(r.error));
        token = r.access_token; tokenExp = now() + (r.expires_in - 90) * 1000;
        lsSet('token', { v: token, exp: tokenExp }); lsSet('wasLogged', true); res();
      },
      error_callback: e => rej(new Error(e.type || 'login cancelado')),
    });
    tc.requestAccessToken({ prompt });
  });
}
async function api(url, opt = {}) {
  if (!authed()) throw new Error('auth');
  const r = await fetch(url, { ...opt, headers: { ...(opt.headers || {}), Authorization: 'Bearer ' + token } });
  if (r.status === 401) { token = null; throw new Error('auth'); }
  if (!r.ok) throw new Error('Drive ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return r;
}
async function listAll(q, fields, spaces) {
  const out = []; let pt;
  do {
    const u = new URL('https://www.googleapis.com/drive/v3/files');
    u.searchParams.set('q', q); u.searchParams.set('pageSize', '1000');
    u.searchParams.set('fields', 'nextPageToken,files(' + fields + ')');
    if (spaces) u.searchParams.set('spaces', spaces);
    if (pt) u.searchParams.set('pageToken', pt);
    const j = await (await api(u)).json(); out.push(...j.files); pt = j.nextPageToken;
  } while (pt);
  return out;
}

const isBookFile = f => /\.(epub|pdf)$/i.test(f.name) || f.mimeType === 'application/pdf' || f.mimeType === 'application/epub+zip';
const kindOf = it => (/pdf/i.test(it.mime) || /\.pdf$/i.test(it.name)) ? 'pdf' : 'epub';
const cleanName = n => n.replace(/\.(epub|pdf)$/i, '').replace(/[_]+/g, ' ');

async function refreshLibrary() {
  if (!authed()) await signIn('');
  let files = [];
  const fields = 'id,name,mimeType,size,modifiedTime,parents';
  if (cfg.folder.trim()) {
    const fol = await listAll("mimeType='application/vnd.google-apps.folder' and trashed=false and name='" + cfg.folder.trim().replace(/'/g, "\\'") + "'", 'id,name');
    if (!fol.length) throw new Error('Pasta "' + cfg.folder + '" não encontrada no Drive.');
    const queue = fol.map(f => f.id), seen = new Set(queue);
    while (queue.length) {
      const id = queue.shift();
      const kids = await listAll("'" + id + "' in parents and trashed=false", fields);
      for (const k of kids) {
        if (k.mimeType === 'application/vnd.google-apps.folder') { if (!seen.has(k.id)) { seen.add(k.id); queue.push(k.id); } }
        else if (isBookFile(k)) files.push(k);
      }
    }
  } else {
    files = (await listAll("trashed=false and (mimeType='application/pdf' or mimeType='application/epub+zip' or name contains '.epub')", fields)).filter(isBookFile);
  }
  const old = new Map(S.library.map(x => [x.id, x]));
  const fromDrive = files.map(f => ({ id: f.id, name: f.name, mime: f.mimeType, size: +f.size || 0, mt: f.modifiedTime, cover: old.get(f.id)?.cover || null }));
  const locals = S.library.filter(x => x.local);
  S.library = [...fromDrive, ...locals]; saveState();
}

/* ---------- sincronização do progresso/anotações ---------- */
const serialize = b => JSON.stringify({ ...b, ink: b.ink.map(s => s.del ? { id: s.id, t: s.t, del: true } : (({ _p, ...r }) => r)(s)) });
const mergeArr = (a = [], b = []) => { const m = new Map(); for (const x of [...a, ...b]) { const o = m.get(x.id); if (!o || x.t > o.t) m.set(x.id, x); } return [...m.values()]; };
function mergeBook(l, r) {
  if (!r) return l;
  return { prog: (r.prog && (!l.prog || r.prog.t > l.prog.t)) ? r.prog : l.prog, hl: mergeArr(l.hl, r.hl), ink: mergeArr(l.ink, r.ink) };
}
let syncing = new Set(), syncTimers = {};
async function syncBook(id) {
  if (!authed() || !navigator.onLine || syncing.has(id)) return;
  syncing.add(id);
  try {
    const b = getBook(id);
    let did = S.driveIds[id];
    if (!did) {
      const l = await listAll("name='book_" + id + ".json' and 'appDataFolder' in parents", 'id', 'appDataFolder');
      did = l[0]?.id; if (did) S.driveIds[id] = did;
    }
    let remote = null;
    if (did) remote = await (await api('https://www.googleapis.com/drive/v3/files/' + did + '?alt=media')).json();
    const merged = mergeBook(b, remote);
    const body = serialize(merged);
    if (!remote || body !== JSON.stringify(remote)) {
      const boundary = 'b' + uid();
      const meta = did ? {} : { name: 'book_' + id + '.json', parents: ['appDataFolder'] };
      const payload = '--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' + JSON.stringify(meta) + '\r\n--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' + body + '\r\n--' + boundary + '--';
      const url = did ? 'https://www.googleapis.com/upload/drive/v3/files/' + did + '?uploadType=multipart&fields=id' : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id';
      const j = await (await api(url, { method: did ? 'PATCH' : 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body: payload })).json();
      S.driveIds[id] = j.id;
    }
    S.books[id] = merged; saveState();
  } catch (e) { console.warn('sync', e); }
  finally { syncing.delete(id); }
}
function scheduleSync(id) { clearTimeout(syncTimers[id]); syncTimers[id] = setTimeout(() => syncBook(id), 5000); }
function changed() { saveState(); if (cur) scheduleSync(cur.item.id); }
document.addEventListener('visibilitychange', () => { if (document.hidden && cur) { saveState(); syncBook(cur.item.id); } });

/* ---------- download de arquivos ---------- */
async function getFileBuf(item) {
  const cached = await idb.get('files', item.id);
  if (cached) return cached;
  if (!authed()) await signIn('');
  toast('Baixando…', 60000);
  const r = await api('https://www.googleapis.com/drive/v3/files/' + item.id + '?alt=media');
  const total = +r.headers.get('content-length') || item.size || 0;
  const rd = r.body.getReader(); const chunks = []; let got = 0;
  for (; ;) {
    const { done, value } = await rd.read(); if (done) break;
    chunks.push(value); got += value.length;
    if (total) toast('Baixando… ' + Math.round(got / total * 100) + '%', 60000);
  }
  const buf = await new Blob(chunks).arrayBuffer();
  await idb.set('files', item.id, buf); dlCache.add(item.id); toast('Pronto', 800);
  return buf;
}

/* ---------- estante ---------- */
function renderLibrary() {
  const grid = $('#grid'); grid.innerHTML = '';
  const q = $('#q').value.trim().toLowerCase();
  let list = S.library.filter(x => !q || x.name.toLowerCase().includes(q));
  list.sort((a, b) => ((getBook(b.id).prog?.t || 0) - (getBook(a.id).prog?.t || 0)) || a.name.localeCompare(b.name));
  if (!list.length) {
    grid.innerHTML = '<div class="empty">' + (S.library.length ? 'Nada encontrado.' :
      (!cfg.clientId ? 'Para começar, abra as configurações (⚙) e cole o Client ID do Google.<br>Ou use ＋ para abrir um arquivo deste aparelho.<br><button id="eSet">Configurações</button>' :
        'Sua estante está vazia.<br>Coloque EPUB/PDF no Google Drive e toque em ↻.<br><button id="eSync">Atualizar do Drive</button>')) + '</div>';
    $('#eSet')?.addEventListener('click', openSettings); $('#eSync')?.addEventListener('click', doSync);
    return;
  }
  for (const it of list) {
    const b = getBook(it.id); const pct = Math.round((b.prog?.pct || 0) * 100);
    const d = document.createElement('div'); d.className = 'card';
    d.innerHTML = '<div class="cover"></div><div class="t"></div><div class="prog"><i></i></div>' + (dlCache.has(it.id) ? '<span class="badge">offline</span>' : '');
    const cv = d.querySelector('.cover');
    if (it.cover) cv.style.backgroundImage = 'url(' + it.cover + ')'; else cv.textContent = kindOf(it).toUpperCase();
    d.querySelector('.t').textContent = cleanName(it.name);
    d.querySelector('.prog i').style.width = pct + '%';
    d.title = cleanName(it.name) + (pct ? ' — ' + pct + '%' : '');
    d.addEventListener('click', () => openBook(it));
    d.addEventListener('contextmenu', e => { e.preventDefault(); cardMenu(it); });
    let lp; d.addEventListener('touchstart', () => lp = setTimeout(() => cardMenu(it), 650), { passive: true });
    ['touchend', 'touchmove'].forEach(ev => d.addEventListener(ev, () => clearTimeout(lp), { passive: true }));
    grid.appendChild(d);
  }
}
function cardMenu(it) {
  modal(`<div class="box"><b></b><div class="row"><button id="mDel" class="danger">${dlCache.has(it.id) ? 'Remover cópia offline' : ''}</button>${it.local ? '<button id="mRm" class="danger">Remover da estante</button>' : ''}<span class="sp"></span><button id="mX">Fechar</button></div></div>`);
  $('#modal b').textContent = cleanName(it.name);
  const del = $('#mDel'); if (!dlCache.has(it.id)) del.hidden = true;
  del.onclick = async () => { await idb.del('files', it.id); dlCache.delete(it.id); closeModal(); renderLibrary(); };
  if ($('#mRm')) $('#mRm').onclick = async () => { await idb.del('files', it.id); dlCache.delete(it.id); S.library = S.library.filter(x => x.id !== it.id); saveState(); closeModal(); renderLibrary(); };
  $('#mX').onclick = closeModal;
}
async function doSync() {
  const b = $('#bSync'); b.textContent = '…';
  try { await refreshLibrary(); hideBanner(); renderLibrary(); toast(S.library.length + ' livros'); }
  catch (e) { showBanner(e.message === 'auth' ? 'Sessão expirada.' : e.message, true); }
  b.textContent = '↻';
}
function showBanner(msg, withLogin) {
  const b = $('#banner'); b.hidden = false; b.innerHTML = '<span></span>' + (withLogin && cfg.clientId ? '<button id="bLogin">Entrar com Google</button>' : '');
  b.firstChild.textContent = msg;
  $('#bLogin')?.addEventListener('click', async () => { try { await signIn('select_account'); hideBanner(); doSync(); } catch (e) { toast(e.message); } });
}
const hideBanner = () => $('#banner').hidden = true;

/* ---------- painéis / modal ---------- */
function openPanel(title, build) {
  const p = $('#panel'); p.innerHTML = '<h2><span></span><button id="pX">✕</button></h2><div class="body"></div>';
  p.querySelector('h2 span').textContent = title; p.hidden = false;
  $('#pX').onclick = () => p.hidden = true; build(p.querySelector('.body'));
}
const closePanel = () => $('#panel').hidden = true;
function modal(html) { const m = $('#modal'); m.innerHTML = html; m.hidden = false; m.onclick = e => { if (e.target === m) closeModal(); }; }
const closeModal = () => $('#modal').hidden = true;

function openSettings() {
  openPanel('Configurações', body => {
    body.innerHTML = `
      <label>Client ID do Google (OAuth, tipo "Aplicativo da Web")</label><input id="sCid" type="text" placeholder="123456-abc.apps.googleusercontent.com">
      <label>Pasta do Drive com os livros (opcional — vazio = todo o Drive)</label><input id="sFolder" type="text" placeholder="Livros">
      <button class="primary" id="sSave">Salvar e entrar</button>
      <button id="sOut" style="margin:.2rem .4rem">Sair da conta neste aparelho</button>
      <div class="help">Aparência (tema, fonte, modo de rolagem) fica no botão <b>Aa</b> dentro do livro.<br>O progresso, os destaques, as notas e a tinta da caneta ficam na área privada do app no seu Drive (não aparecem nos seus arquivos).</div>`;
    $('#sCid').value = cfg.clientId; $('#sFolder').value = cfg.folder;
    $('#sSave').onclick = async () => {
      cfg.clientId = $('#sCid').value.trim(); cfg.folder = $('#sFolder').value.trim(); saveCfg(); closePanel();
      try { await signIn('select_account'); hideBanner(); doSync(); } catch (e) { showBanner(e.message, true); }
    };
    $('#sOut').onclick = () => { token = null; tokenExp = 0; lsSet('token', null); lsSet('wasLogged', false); if (window.google?.accounts) google.accounts.oauth2.revoke?.(token, () => { }); closePanel(); toast('Sessão encerrada'); };
  });
}

/* ================== LEITOR ================== */
let cur = null;      // {item, kind, page}
let rend = null, ebook = null;            // epub
let pdf = null, pdfPageNum = 1, pdfZoom = 1, renderTok = 0; // pdf
let pending = null;  // seleção pendente

async function openBook(item) {
  cur = { item, kind: kindOf(item), page: 1 };
  $('#lib').hidden = true; $('#reader').hidden = false;
  $('#rTitle').textContent = cleanName(item.name);
  $('#viewer').hidden = cur.kind !== 'epub'; $('#pdfWrap').hidden = cur.kind !== 'pdf';
  $('#rInk').hidden = cur.kind !== 'pdf'; $('#zoomBtns').hidden = cur.kind !== 'pdf';
  setInk(false); hideSheet();
  let buf;
  try { buf = await getFileBuf(item); }
  catch (e) { toast(e.message === 'auth' ? 'Entre com o Google (⚙) para baixar.' : e.message); closeReader(); return; }
  if (authed() && navigator.onLine) await Promise.race([syncBook(item.id), sleep(4000)]);
  try { cur.kind === 'pdf' ? await openPdf(buf) : await openEpub(buf); }
  catch (e) { console.error(e); toast('Não consegui abrir: ' + e.message, 6000); closeReader(); }
}

async function closeReader() {
  hideSheet(); closePanel();
  const id = cur?.item.id;
  try { rend?.destroy(); ebook?.destroy(); } catch { } rend = ebook = null;
  try { pdf?.destroy(); } catch { } pdf = null;
  $('#viewer').innerHTML = '';
  $('#reader').hidden = true; $('#lib').hidden = false;
  cur = null; saveState(); renderLibrary();
  if (id) syncBook(id);
}

/* ---- util: miniatura ---- */
function thumbFrom(src) { // src: HTMLImageElement | canvas
  const w = 200, h = Math.round(w * (src.height / src.width || 1.5));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(src, 0, 0, w, h); return c.toDataURL('image/jpeg', .7);
}
function setCover(id, url) { const it = S.library.find(x => x.id === id); if (it && !it.cover) { it.cover = url; saveState(); } }

/* ---- destaque (comum) ---- */
function showSheet(p) {
  pending = p; const s = $('#sheet'); s.hidden = false;
  const dots = s.querySelector('.dots'); dots.innerHTML = '';
  COLORS.forEach(c => { const b = document.createElement('button'); b.className = 'dot'; b.style.background = c; b.onclick = () => addHl(c, false); dots.appendChild(b); });
}
function hideSheet() {
  $('#sheet').hidden = true;
  try { if (pending?.contents) pending.contents.window.getSelection().removeAllRanges(); else getSelection().removeAllRanges(); } catch { }
  pending = null;
}
$('#shX').onclick = hideSheet;
$('#shNote').onclick = () => addHl(COLORS[0], true);
$('#shCopy').onclick = () => { navigator.clipboard?.writeText(pending?.text || '').then(() => toast('Copiado')); hideSheet(); };

function addHl(color, openNote) {
  const p = pending; if (!p) return;
  const h = { id: uid(), t: now(), color, text: p.text.slice(0, 600), note: '', kind: p.kind };
  if (p.kind === 'epub') h.cfi = p.cfi;
  else { h.page = pdfPageNum; h.rects = pdfSelRects(); if (!h.rects.length) return; }
  getBook(cur.item.id).hl.push(h); renderHl(h); changed(); hideSheet();
  if (openNote) editHl(h.id);
}
function renderHl(h) {
  if (h.del) return;
  if (h.kind === 'epub') {
    rend?.annotations.remove(h.cfi, 'highlight');
    rend?.annotations.highlight(h.cfi, { id: h.id }, () => editHl(h.id), 'hl', { fill: h.color, 'fill-opacity': '0.35', 'mix-blend-mode': 'multiply' });
  } else if (h.page === pdfPageNum) drawPdfHl();
}
function editHl(id) {
  const b = getBook(cur.item.id); const h = b.hl.find(x => x.id === id); if (!h || h.del) return;
  modal(`<div class="box"><blockquote></blockquote><div class="row" id="eCols"></div><textarea id="eNote" placeholder="Escreva uma nota…"></textarea><div class="row"><button id="eDel" class="danger">Excluir</button><span class="sp"></span><button id="eX">Cancelar</button><button id="eOk" class="ok">Salvar</button></div></div>`);
  $('#modal blockquote').textContent = h.text; $('#eNote').value = h.note || '';
  let col = h.color;
  COLORS.forEach(c => { const d = document.createElement('button'); d.className = 'dot' + (c === col ? ' on' : ''); d.style.background = c; d.onclick = () => { col = c; document.querySelectorAll('#eCols .dot').forEach(x => x.classList.remove('on')); d.classList.add('on'); }; $('#eCols').appendChild(d); });
  $('#eX').onclick = closeModal;
  $('#eOk').onclick = () => { const recolor = col !== h.color; h.note = $('#eNote').value.trim(); h.color = col; h.t = now(); closeModal(); if (recolor) renderHl(h); if (h.kind === 'pdf') drawPdfHl(); changed(); };
  $('#eDel').onclick = () => {
    if (h.kind === 'epub') rend?.annotations.remove(h.cfi, 'highlight');
    h.del = true; h.t = now(); h.text = ''; h.note = ''; delete h.rects; closeModal(); if (h.kind === 'pdf') drawPdfHl(); changed();
  };
}
function openNotes() {
  const b = getBook(cur.item.id);
  openPanel('Destaques e notas', body => {
    const list = b.hl.filter(h => !h.del).sort((a, c) => (a.page || 0) - (c.page || 0) || a.t - c.t);
    if (!list.length) body.innerHTML = '<div class="help">Nenhum destaque ainda. Selecione um trecho de texto para marcar.</div>';
    for (const h of list) {
      const d = document.createElement('div'); d.className = 'item'; d.style.borderLeftColor = h.color;
      d.innerHTML = '<div></div>' + (h.note ? '<div class="n"></div>' : '');
      d.firstChild.textContent = (h.kind === 'pdf' ? 'p. ' + h.page + ' — ' : '') + h.text;
      if (h.note) d.querySelector('.n').textContent = h.note;
      d.onclick = () => { closePanel(); h.kind === 'epub' ? rend.display(h.cfi) : pdfGo(h.page); };
      d.oncontextmenu = e => { e.preventDefault(); closePanel(); editHl(h.id); };
      const ed = document.createElement('button'); ed.textContent = '✎ editar'; ed.style.cssText = 'font-size:.75rem;color:var(--acc);padding:.1rem 0';
      ed.onclick = e => { e.stopPropagation(); closePanel(); editHl(h.id); }; d.appendChild(ed);
      body.appendChild(d);
    }
    const ex = document.createElement('button'); ex.className = 'primary'; ex.textContent = 'Copiar tudo (Markdown)';
    ex.onclick = () => { navigator.clipboard?.writeText('# ' + cleanName(cur.item.name) + '\n\n' + list.map(h => '> ' + h.text + (h.page ? ' (p. ' + h.page + ')' : '') + (h.note ? '\n\n' + h.note : '')).join('\n\n')).then(() => toast('Copiado')); };
    body.appendChild(ex);
  });
}

/* ---- EPUB ---- */
const EPUB_THEMES = {
  light: { body: { background: '#ffffff !important', color: '#1f2937 !important' }, 'p,div,span,li,h1,h2,h3,h4,h5,h6,td': { color: '#1f2937 !important' } },
  sepia: { body: { background: '#f4ecd8 !important', color: '#4b3b2a !important' }, 'p,div,span,li,h1,h2,h3,h4,h5,h6,td': { color: '#4b3b2a !important' } },
  dark: { body: { background: '#111318 !important', color: '#d6d8de !important' }, 'p,div,span,li,h1,h2,h3,h4,h5,h6,td': { color: '#d6d8de !important' } },
};
function applyEpubLook() {
  if (!rend) return;
  rend.themes.select(cfg.theme); rend.themes.fontSize(cfg.fs + '%');
}
async function openEpub(buf) {
  const id = cur.item.id, b = getBook(id);
  ebook = ePub(buf, { openAs: 'binary' });
  rend = ebook.renderTo($('#viewer'), { width: '100%', height: '100%', flow: cfg.flow, spread: 'auto', allowScriptedContent: false });
  for (const [n, r] of Object.entries(EPUB_THEMES)) rend.themes.register(n, r);
  applyEpubLook();
  b.hl.filter(h => h.kind === 'epub' && !h.del).forEach(renderHl);
  rend.on('relocated', loc => {
    const pct = ebook.locations.length() ? ebook.locations.percentageFromCfi(loc.start.cfi) : (loc.start.percentage || 0);
    setProg({ loc: loc.start.cfi, pct });
    $('#slider').value = Math.round(pct * 1000); $('#pos').textContent = Math.round(pct * 100) + '%';
  });
  rend.on('selected', (cfi, contents) => {
    const text = rend.getRange(cfi)?.toString().trim(); if (text) showSheet({ kind: 'epub', cfi, text, contents });
  });
  let tx = 0, ty = 0;
  rend.on('touchstart', e => { tx = e.changedTouches[0].screenX; ty = e.changedTouches[0].screenY; });
  rend.on('touchend', e => {
    const dx = e.changedTouches[0].screenX - tx, dy = e.changedTouches[0].screenY - ty;
    if (cfg.flow === 'paginated' && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) dx < 0 ? rend.next() : rend.prev();
  });
  rend.on('keyup', keyNav);
  await rend.display(b.prog?.loc || undefined);
  ebook.loaded.metadata.then(() => ebook.coverUrl()).then(async u => {
    if (!u) return; const im = new Image(); im.onload = () => setCover(id, thumbFrom(im)); im.src = u;
  }).catch(() => { });
  ebook.ready.then(async () => {
    const key = 'loc_' + id, saved = await idb.get('kv', key);
    if (saved) ebook.locations.load(saved); else { await ebook.locations.generate(1600); idb.set('kv', key, ebook.locations.save()); }
    const loc = rend?.currentLocation?.(); if (loc?.start) { const p = ebook.locations.percentageFromCfi(loc.start.cfi); $('#slider').value = Math.round(p * 1000); $('#pos').textContent = Math.round(p * 100) + '%'; setProg({ loc: loc.start.cfi, pct: p }, true); }
  }).catch(() => { });
}
function setProg(p, keepT) {
  const b = getBook(cur.item.id); const t = keepT && b.prog ? b.prog.t : now();
  b.prog = { ...p, t }; changed();
}

/* ---- PDF ---- */
async function openPdf(buf) {
  const id = cur.item.id, b = getBook(id);
  pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
  pdfZoom = cfg.zoom || 1;
  $('#slider').max = pdf.numPages; $('#slider').min = 1;
  pdfPageNum = Math.min(Math.max(b.prog?.page || 1, 1), pdf.numPages);
  await renderPdfPage();
  if (!S.library.find(x => x.id === id)?.cover) {
    pdf.getPage(1).then(async pg => {
      const vp = pg.getViewport({ scale: 220 / pg.getViewport({ scale: 1 }).width });
      const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
      await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise; setCover(id, c.toDataURL('image/jpeg', .7));
    }).catch(() => { });
  }
}
async function renderPdfPage() {
  const tok = ++renderTok; cur.page = pdfPageNum;
  const pg = await pdf.getPage(pdfPageNum); if (tok !== renderTok) return;
  const wrap = $('#pdfWrap'), base = pg.getViewport({ scale: 1 });
  const cssScale = Math.max(50, wrap.clientWidth - 18) / base.width * pdfZoom;
  const vp = pg.getViewport({ scale: cssScale }), dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const page = $('#pdfPage'); page.style.width = vp.width + 'px'; page.style.height = vp.height + 'px';
  const cv = $('#pdfCv'); cv.width = vp.width * dpr; cv.height = vp.height * dpr; cv.style.width = '100%'; cv.style.height = '100%';
  const r = pg.render({ canvasContext: cv.getContext('2d'), viewport: pg.getViewport({ scale: cssScale * dpr }) });
  const tl = $('#textLayer'); tl.innerHTML = ''; tl.style.setProperty('--scale-factor', cssScale);
  pg.getTextContent().then(tc => { if (tok !== renderTok) return; pdfjsLib.renderTextLayer({ textContentSource: tc, container: tl, viewport: vp, textDivs: [] }); });
  const ic = $('#inkCv'); ic.width = vp.width * dpr; ic.height = vp.height * dpr;
  drawPdfHl(); drawInk();
  try { await r.promise; } catch { }
  wrap.scrollTop = 0;
  $('#slider').value = pdfPageNum; $('#pos').textContent = pdfPageNum + ' / ' + pdf.numPages;
  setProg({ page: pdfPageNum, pct: pdfPageNum / pdf.numPages });
}
function pdfGo(n) { n = Math.min(Math.max(1, n), pdf.numPages); if (n === pdfPageNum && $('#pdfCv').width) return; pdfPageNum = n; renderPdfPage(); }
function pdfSelRects() {
  const s = getSelection(); if (!s || !s.rangeCount) return [];
  const pr = $('#pdfPage').getBoundingClientRect(), W = pr.width;
  return [...s.getRangeAt(0).getClientRects()].filter(r => r.width > 1 && r.height > 1)
    .map(r => ({ x: +((r.left - pr.left) / W).toFixed(5), y: +((r.top - pr.top) / W).toFixed(5), w: +(r.width / W).toFixed(5), h: +(r.height / W).toFixed(5) }));
}
function drawPdfHl() {
  const L = $('#hlLayer'); L.innerHTML = ''; if (!cur || cur.kind !== 'pdf') return;
  const W = $('#pdfPage').clientWidth;
  for (const h of getBook(cur.item.id).hl) if (!h.del && h.kind === 'pdf' && h.page === pdfPageNum)
    for (const r of h.rects) { const d = document.createElement('div'); d.style.cssText = `left:${r.x * W}px;top:${r.y * W}px;width:${r.w * W}px;height:${r.h * W}px;background:${h.color}`; L.appendChild(d); }
}
document.addEventListener('selectionchange', () => {
  if (!pdf || !cur || cur.kind !== 'pdf') return;
  clearTimeout(document._st);
  document._st = setTimeout(() => {
    const s = getSelection();
    if (!s || s.isCollapsed || !s.anchorNode || !$('#textLayer').contains(s.anchorNode)) { if (pending?.kind === 'pdf') { $('#sheet').hidden = true; pending = null; } return; }
    const text = s.toString().trim(); if (text) showSheet({ kind: 'pdf', text });
  }, 350);
});
// toque em destaque PDF para editar
$('#textLayer').addEventListener('click', e => {
  const s = getSelection(); if (s && !s.isCollapsed) return;
  const pr = $('#pdfPage').getBoundingClientRect(), x = (e.clientX - pr.left) / pr.width, y = (e.clientY - pr.top) / pr.width;
  const h = getBook(cur.item.id).hl.find(h => !h.del && h.kind === 'pdf' && h.page === pdfPageNum && h.rects.some(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h));
  if (h) editHl(h.id);
});
// deslizar para trocar de página (PDF)
{
  let x0 = 0, y0 = 0, t0 = 0;
  const w = $('#pdfWrap');
  w.addEventListener('touchstart', e => { x0 = e.changedTouches[0].clientX; y0 = e.changedTouches[0].clientY; t0 = now(); }, { passive: true });
  w.addEventListener('touchend', e => {
    if ($('#inkCv').classList.contains('on') || pdfZoom > 1.05) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    if (now() - t0 < 600 && Math.abs(dx) > 80 && Math.abs(dx) > Math.abs(dy) * 2 && getSelection().isCollapsed) pdfGo(pdfPageNum + (dx < 0 ? 1 : -1));
  }, { passive: true });
}

/* ---- tinta (caneta) no PDF ---- */
const ink = { tool: 'pen', color: INK_COLORS[1], size: 2, on: false, cur: null, undo: [] };
const pageInk = () => getBook(cur.item.id).ink.filter(s => !s.del && s.page === pdfPageNum);
function strokePath(ctx, pts, W) {
  if (pts.length === 1) { ctx.beginPath(); ctx.arc(pts[0][0] * W, pts[0][1] * W, ctx.lineWidth / 2, 0, 6.3); ctx.fill(); return; }
  ctx.beginPath(); ctx.moveTo(pts[0][0] * W, pts[0][1] * W);
  for (let i = 1; i < pts.length - 1; i++) { const mx = (pts[i][0] + pts[i + 1][0]) / 2 * W, my = (pts[i][1] + pts[i + 1][1]) / 2 * W; ctx.quadraticCurveTo(pts[i][0] * W, pts[i][1] * W, mx, my); }
  const l = pts[pts.length - 1]; ctx.lineTo(l[0] * W, l[1] * W); ctx.stroke();
}
function drawInk() {
  const cv = $('#inkCv'); if (!cv.width) return; const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, cv.width, cv.height);
  const W = cv.width; ctx.lineCap = ctx.lineJoin = 'round';
  for (const s of [...pageInk(), ...(ink.cur ? [ink.cur] : [])]) {
    ctx.globalAlpha = s.k === 'mk' ? .35 : 1; ctx.globalCompositeOperation = s.k === 'mk' ? 'multiply' : 'source-over';
    ctx.strokeStyle = ctx.fillStyle = s.c; ctx.lineWidth = s.w * W; strokePath(ctx, s.p, W);
  }
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
}
function setInk(on) {
  ink.on = on; $('#inkbar').hidden = !on; $('#rInk').classList.toggle('on', on);
  $('#inkCv').classList.toggle('on', on);
  if (on) hideSheet();
  document.querySelectorAll('#inkbar .tool').forEach(b => b.classList.toggle('on', b.dataset.tool === ink.tool));
  document.querySelectorAll('#inkbar .sz').forEach(b => b.classList.toggle('on', +b.dataset.size === ink.size));
  document.querySelectorAll('#inkColors .dot').forEach(b => b.classList.toggle('on', b.dataset.c === ink.color));
}
{
  const cc = $('#inkColors');
  INK_COLORS.forEach(c => { const b = document.createElement('button'); b.className = 'dot'; b.dataset.c = c; b.style.background = c; b.onclick = () => { ink.color = c; if (ink.tool === 'er') ink.tool = 'pen'; setInk(true); }; cc.appendChild(b); });
  document.querySelectorAll('#inkbar .tool').forEach(b => b.onclick = () => { ink.tool = b.dataset.tool; setInk(true); });
  document.querySelectorAll('#inkbar .sz').forEach(b => b.onclick = () => { ink.size = +b.dataset.size; setInk(true); });
  $('#finger').checked = cfg.finger; $('#finger').onchange = e => { cfg.finger = e.target.checked; saveCfg(); };
  $('#rInk').onclick = () => setInk(!ink.on);
  $('#inkUndo').onclick = () => {
    const op = ink.undo.pop(); if (!op) return; const all = getBook(cur.item.id).ink;
    for (const id of op.ids) { const s = all.find(x => x.id === id); if (!s) continue; if (op.type === 'add') { s.del = true; s.p = []; s.t = now(); } else { s.del = false; s.p = s._p || s.p; s.t = now(); } }
    drawInk(); changed();
  };
}
{
  const cv = $('#inkCv'); let raf = 0, erased = null, panY = 0, panX = 0;
  const pt = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.width, e.pressure || .5]; };
  const widthFor = () => ink.tool === 'mk' ? [.012, .022, .04][ink.size - 1] : [.0012, .0025, .0055][ink.size - 1];
  cv.addEventListener('pointerdown', e => {
    if (!ink.on) return;
    if (e.pointerType === 'touch' && !cfg.finger) { panX = e.clientX; panY = e.clientY; try { cv.setPointerCapture(e.pointerId); } catch { } cv._pan = e.pointerId; return; } // dedo = rolar
    e.preventDefault(); try { cv.setPointerCapture(e.pointerId); } catch { } cv._draw = e.pointerId;
    if (ink.tool === 'er') { erased = []; eraseAt(pt(e)); }
    else ink.cur = { id: uid(), page: pdfPageNum, k: ink.tool, c: ink.color, w: widthFor(), p: [pt(e).slice(0, 2)], t: now() };
    drawInk();
  });
  cv.addEventListener('pointermove', e => {
    if (cv._pan === e.pointerId) { $('#pdfWrap').scrollBy(panX - e.clientX, panY - e.clientY); panX = e.clientX; panY = e.clientY; return; }
    if (cv._draw !== e.pointerId) return; e.preventDefault();
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of (evs.length ? evs : [e])) {
      if (ink.tool === 'er') eraseAt(pt(ev));
      else if (ink.cur) { const q = pt(ev), l = ink.cur.p[ink.cur.p.length - 1]; if (Math.hypot(q[0] - l[0], q[1] - l[1]) > .0006) ink.cur.p.push([+q[0].toFixed(4), +q[1].toFixed(4)]); }
    }
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; drawInk(); });
  });
  const end = e => {
    if (cv._pan === e.pointerId) { cv._pan = null; return; }
    if (cv._draw !== e.pointerId) return; cv._draw = null;
    if (ink.cur) { const s = ink.cur; ink.cur = null; s.p = s.p.map(p => [+p[0].toFixed(4), +p[1].toFixed(4)]); getBook(cur.item.id).ink.push(s); ink.undo.push({ type: 'add', ids: [s.id] }); changed(); }
    if (erased?.length) { ink.undo.push({ type: 'del', ids: erased }); erased = null; changed(); }
    drawInk();
  };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  function eraseAt([x, y]) {
    const R = .018;
    for (const s of pageInk()) if (s.p.some(q => Math.hypot(q[0] - x, q[1] - y) < R)) { s._p = s.p; s.del = true; s.t = now(); erased.push(s.id); }
    // não guardamos pontos de tombstone no JSON enviado: _p é só local e removido na serialização abaixo
  }
}
/* ---- navegação / UI do leitor ---- */
function next() { cur.kind === 'epub' ? rend?.next() : pdfGo(pdfPageNum + 1); }
function prev() { cur.kind === 'epub' ? rend?.prev() : pdfGo(pdfPageNum - 1); }
function keyNav(e) {
  if (!cur || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') next();
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') prev();
  else if (e.key === 'Escape') { hideSheet(); closePanel(); closeModal(); }
}
document.addEventListener('keyup', keyNav);
$('#next').onclick = next; $('#prev').onclick = prev;
$('#rBack').onclick = closeReader;
$('#rNotes').onclick = openNotes;
$('#zIn').onclick = () => { pdfZoom = Math.min(4, pdfZoom * 1.25); cfg.zoom = pdfZoom; saveCfg(); renderPdfPage(); };
$('#zOut').onclick = () => { pdfZoom = Math.max(.6, pdfZoom / 1.25); cfg.zoom = pdfZoom; saveCfg(); renderPdfPage(); };
$('#slider').addEventListener('change', e => {
  const v = +e.target.value;
  if (cur.kind === 'pdf') pdfGo(v);
  else if (ebook?.locations.length()) rend.display(ebook.locations.cfiFromPercentage(v / 1000));
});
$('#rToc').onclick = async () => {
  openPanel('Sumário', async body => {
    if (cur.kind === 'epub') {
      await ebook.loaded.navigation;
      const add = (items, lvl) => items.forEach(it => {
        const d = document.createElement('div'); d.className = 'toc'; d.style.paddingLeft = (0.6 + lvl * 1) + 'rem'; d.textContent = it.label.trim();
        d.onclick = () => { closePanel(); rend.display(it.href); }; body.appendChild(d); if (it.subitems) add(it.subitems, lvl + 1);
      });
      add(ebook.navigation.toc, 0);
      if (!ebook.navigation.toc.length) body.innerHTML = '<div class="help">Este livro não tem sumário.</div>';
    } else {
      const out = await pdf.getOutline();
      if (!out) { body.innerHTML = '<div class="help">Este PDF não tem sumário. Use a barra de páginas.</div>'; return; }
      const add = (items, lvl) => items.forEach(it => {
        const d = document.createElement('div'); d.className = 'toc'; d.style.paddingLeft = (0.6 + lvl) + 'rem'; d.textContent = it.title;
        d.onclick = async () => { try { const dest = typeof it.dest === 'string' ? await pdf.getDestination(it.dest) : it.dest; const i = await pdf.getPageIndex(dest[0]); closePanel(); pdfGo(i + 1); } catch { } };
        body.appendChild(d); if (it.items?.length) add(it.items, lvl + 1);
      });
      add(out, 0);
    }
  });
};
$('#rSet').onclick = () => openPanel('Aparência', body => {
  const mk = (label, opts, get, set) => {
    const l = document.createElement('label'); l.textContent = label; body.appendChild(l);
    const r = document.createElement('div'); r.className = 'row'; body.appendChild(r);
    opts.forEach(([v, t]) => { const b = document.createElement('button'); b.textContent = t; b.className = get() === v ? 'on' : ''; b.onclick = () => { set(v); [...r.children].forEach(c => c.classList.remove('on')); b.classList.add('on'); }; r.appendChild(b); });
  };
  mk('Tema', [['light', 'Claro'], ['sepia', 'Sépia'], ['dark', 'Escuro']], () => cfg.theme, v => { cfg.theme = v; saveCfg(); applyTheme(); applyEpubLook(); });
  if (cur.kind === 'epub') {
    mk('Tamanho do texto', [[90, 'A−−'], [100, 'A−'], [110, 'A'], [130, 'A+'], [160, 'A++'], [200, 'A+++']], () => cfg.fs, v => { cfg.fs = v; saveCfg(); applyEpubLook(); });
    mk('Modo', [['paginated', 'Páginas'], ['scrolled-doc', 'Rolagem']], () => cfg.flow, v => { cfg.flow = v; saveCfg(); rend.flow(v); $('.edge.l').hidden = $('.edge.r').hidden = v !== 'paginated'; });
  }
});
function applyTheme() { document.body.dataset.theme = cfg.theme; document.querySelector('meta[name=theme-color]').content = cfg.theme === 'dark' ? '#0a0b0e' : '#1f2937'; }

/* ---- biblioteca: botões e arquivo local ---- */
$('#q').addEventListener('input', renderLibrary);
$('#bSync').onclick = doSync;
$('#bSet').onclick = openSettings;
$('#bLocal').onclick = () => $('#fileIn').click();
$('#fileIn').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  const buf = await f.arrayBuffer();
  const h = await crypto.subtle.digest('SHA-1', buf.slice(0, 200000));
  const id = 'local_' + [...new Uint8Array(h)].slice(0, 8).map(x => x.toString(16).padStart(2, '0')).join('') + '_' + f.size;
  if (!S.library.find(x => x.id === id)) S.library.push({ id, name: f.name, mime: f.type, size: f.size, mt: '', cover: null, local: true });
  await idb.set('files', id, buf); dlCache.add(id); saveState(); renderLibrary();
  openBook(S.library.find(x => x.id === id));
};

/* ---- iniciar ---- */
window.gisReady = () => { if (lsGet('wasLogged', false) && !authed() && cfg.clientId && !S.library.length) showBanner('Toque para entrar de novo.', true); };
window.addEventListener('online', () => { if (cur) syncBook(cur.item.id); });
(async function init() {
  await idb.open();
  const st = await idb.get('kv', 'state'); if (st) S = Object.assign(S, st);
  (await idb.keys('files')).forEach(k => dlCache.add(k));
  applyTheme(); renderLibrary();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
  if (cfg.clientId && navigator.onLine) {
    if (authed()) doSync();
    else if (lsGet('wasLogged', false)) showBanner('Sessão do Google expirada.', true);
    else showBanner('Entre com o Google para ver os livros do Drive.', true);
  } else if (!cfg.clientId) showBanner('Configure o Client ID do Google (⚙) para sincronizar com o Drive.', false);
})();
