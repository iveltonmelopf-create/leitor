'use strict';
/* Leitor EPUB/PDF — sincroniza progresso, destaques, notas e tinta via Google Drive (appDataFolder) */

const DEFAULT_FOLDER = '1TbIk2RmluOSd3zmzXTJE7pnWDcZqZnyi'; // pasta oficial dos livros no Drive
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

let cfg = Object.assign({ clientId: '674620611576-d1gfmdv2t89kn9fia7rn4svli0s46m8l.apps.googleusercontent.com', folder: '', theme: 'dark', fs: 110, flow: 'paginated', finger: false, zoom: 1, fit: 'crop', dim: 0, warm: 0, lh: 0, ff: 'book', just: false, cols: 'auto', mg: 2 }, lsGet('cfg', {}));
const saveCfg = () => lsSet('cfg', cfg);

// S.library: [{id,name,mime,size,mt,cover,local}]  S.books[id]: {prog,hl,ink}  S.driveIds[id]: id do json no appData
let S = { library: [], books: {}, driveIds: {}, crops: {} };
let dlCache = new Set(); // ids com arquivo baixado
let saveT;
function saveState() { clearTimeout(saveT); saveT = setTimeout(() => idb.set('kv', 'state', S).catch(() => { }), 400); }
const getBook = id => (S.books[id] ||= { prog: null, hl: [], ink: [] });

let lastPt = [50, 50];
document.addEventListener('pointerdown', e => { lastPt = [e.clientX / innerWidth * 100, e.clientY / innerHeight * 100]; }, true);
const REDUCED = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function show(el) { clearTimeout(el._lt); el.classList.remove('out'); el.hidden = false; }
function leave(el) {
  if (el.hidden) return;
  clearTimeout(el._lt); el.classList.add('out');
  el._lt = setTimeout(() => { el.hidden = true; el.classList.remove('out'); }, REDUCED() ? 100 : 140);
}
function toast(msg, ms = 2800) {
  const t = $('#toast'); t.textContent = msg; show(t);
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms);
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

const isBookFile = f => /\.(epub|pdf|mobi|azw3?|prc)$/i.test(f.name) || f.mimeType === 'application/pdf' || f.mimeType === 'application/epub+zip';
const kindOf = it => (/pdf/i.test(it.mime) || /\.pdf$/i.test(it.name)) ? 'pdf' : /\.(mobi|azw3?|prc)$/i.test(it.name) ? 'mobi' : 'epub';
const cleanName = n => n.replace(/\.(epub|pdf|mobi|azw3?|prc)$/i, '').replace(/[_]+/g, ' ');

async function refreshLibrary() {
  if (!authed()) await signIn('');
  let files = [];
  const fields = 'id,name,mimeType,size,modifiedTime,parents';
  const fRaw = (cfg.folder || '').trim() || DEFAULT_FOLDER;
  const fId = (fRaw.match(/folders\/([\w-]{15,})/) || fRaw.match(/^([\w-]{20,})$/) || [])[1];
  if (fRaw) {
    let fol;
    if (fId) fol = [{ id: fId }];
    else {
      fol = await listAll("mimeType='application/vnd.google-apps.folder' and trashed=false and name='" + fRaw.replace(/'/g, "\'") + "'", 'id,name');
      if (!fol.length) throw new Error('Pasta "' + fRaw + '" não encontrada no Drive.');
    }
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
    files = (await listAll("trashed=false and (mimeType='application/pdf' or mimeType='application/epub+zip' or name contains '.epub' or name contains '.mobi' or name contains '.azw3')", fields)).filter(isBookFile);
  }
  const old = new Map(S.library.map(x => [x.id, x]));
  const fromDrive = files.map(f => ({ id: f.id, name: f.name, mime: f.mimeType, size: +f.size || 0, mt: f.modifiedTime, cover: old.get(f.id)?.cover || null, noCover: old.get(f.id)?.noCover || false }));
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
async function getFileBuf(item, silent) {
  const cached = await idb.get('files', item.id);
  if (cached) return cached;
  if (!authed()) await signIn('');
  if (!silent) toast('Baixando…', 60000);
  const r = await api('https://www.googleapis.com/drive/v3/files/' + item.id + '?alt=media');
  const total = +r.headers.get('content-length') || item.size || 0;
  const rd = r.body.getReader(); const chunks = []; let got = 0;
  for (; ;) {
    const { done, value } = await rd.read(); if (done) break;
    chunks.push(value); got += value.length;
    if (total && !silent) toast('Baixando… ' + Math.round(got / total * 100) + '%', 60000);
  }
  const buf = await new Blob(chunks).arrayBuffer();
  await idb.set('files', item.id, buf); dlCache.add(item.id); if (!silent) toast('Pronto', 800);
  return buf;
}

/* ---- capas em segundo plano: lê só o pedaço do arquivo onde a capa está (HTTP Range), sem baixar o livro ---- */
const loadImg = src => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
const driveUrl = id => 'https://www.googleapis.com/drive/v3/files/' + id + '?alt=media';
async function rangeGet(id, range) {             // range: 'bytes=a-b' ou 'bytes=-n'
  const r = await api(driveUrl(id), { headers: { Range: range } });
  if (r.status !== 206 && r.status !== 200) throw new Error('Range ' + r.status);
  return { buf: new Uint8Array(await r.arrayBuffer()), partial: r.status === 206 };
}
const inflateRaw = async u8 => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
async function zipEntries(it) {                  // lê só o índice (diretório central) do ZIP/EPUB
  const size = it.size; if (!size) throw new Error('sem tamanho');
  const t = await rangeGet(it.id, 'bytes=-' + Math.min(size, 65536)); if (!t.partial && size > 65536) throw new Error('sem Range');
  const dv = new DataView(t.buf.buffer, t.buf.byteOffset, t.buf.byteLength);
  let e = -1; for (let i = t.buf.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('zip inválido');
  const cdSize = dv.getUint32(e + 12, true), cdOff = dv.getUint32(e + 16, true), tailStart = size - t.buf.length;
  const cd = cdOff >= tailStart ? t.buf.subarray(cdOff - tailStart, cdOff - tailStart + cdSize) : (await rangeGet(it.id, 'bytes=' + cdOff + '-' + (cdOff + cdSize - 1))).buf;
  const cdv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength), dec = new TextDecoder(), map = new Map();
  for (let p = 0; p + 46 <= cd.length && cdv.getUint32(p, true) === 0x02014b50;) {
    const method = cdv.getUint16(p + 10, true), csize = cdv.getUint32(p + 20, true), n = cdv.getUint16(p + 28, true), x = cdv.getUint16(p + 30, true), c = cdv.getUint16(p + 32, true), off = cdv.getUint32(p + 42, true);
    map.set(dec.decode(cd.subarray(p + 46, p + 46 + n)), { method, csize, off, n, x });
    p += 46 + n + x + c;
  }
  return map;
}
async function zipRead(it, ent) {
  const { buf } = await rangeGet(it.id, 'bytes=' + ent.off + '-' + (ent.off + 30 + ent.n + ent.x + 2048 + ent.csize - 1));
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const start = 30 + dv.getUint16(26, true) + dv.getUint16(28, true), raw = buf.subarray(start, start + ent.csize);
  return ent.method === 0 ? raw : await inflateRaw(raw);
}
async function epubCoverByRange(it) {
  const map = await zipEntries(it), dec = new TextDecoder(), dp = new DOMParser();
  const text = async name => dec.decode(await zipRead(it, map.get(name)));
  if (!map.has('META-INF/container.xml')) return null;
  const opfPath = dp.parseFromString(await text('META-INF/container.xml'), 'application/xml').querySelector('rootfile')?.getAttribute('full-path');
  if (!opfPath || !map.has(opfPath)) return null;
  const opf = dp.parseFromString(await text(opfPath), 'application/xml');
  const items = [...opf.getElementsByTagName('item')], isImg = i => /^image\//.test(i.getAttribute('media-type') || '');
  const metaId = [...opf.getElementsByTagName('meta')].find(m => m.getAttribute('name') === 'cover')?.getAttribute('content');
  const ci = items.find(i => (i.getAttribute('properties') || '').split(/\s+/).includes('cover-image'))
    || items.find(i => metaId && i.getAttribute('id') === metaId && isImg(i))
    || items.find(i => isImg(i) && /cover|capa/i.test((i.getAttribute('id') || '') + (i.getAttribute('href') || '')));
  if (!ci) return null;
  const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const path = decodeURIComponent(new URL(ci.getAttribute('href'), 'http://x/' + dir).pathname.slice(1)), ent = map.get(path);
  if (!ent) return null;
  const url = URL.createObjectURL(new Blob([await zipRead(it, ent)], { type: ci.getAttribute('media-type') || 'image/jpeg' }));
  try { return thumbFrom(await loadImg(url)); } finally { URL.revokeObjectURL(url); }
}
async function pdfThumb(doc) {
  try {
    const pg = await doc.getPage(1), vp = pg.getViewport({ scale: 220 / pg.getViewport({ scale: 1 }).width });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    return c.toDataURL('image/jpeg', .7);
  } finally { doc.destroy(); }
}
const pdfCoverByRange = it => pdfjsLib.getDocument({ url: driveUrl(it.id), httpHeaders: { Authorization: 'Bearer ' + token }, rangeChunkSize: 131072, disableAutoFetch: true }).promise.then(pdfThumb);
async function coverFromEpubBuf(epub) {
  const book = ePub(epub, { openAs: 'binary' });
  try { await book.ready; const u = await book.coverUrl(); return u ? thumbFrom(await loadImg(u)) : null; }
  finally { try { book.destroy(); } catch { } }
}
async function fastCover(it) {
  const k = kindOf(it);
  if (k === 'mobi') {                                      // MOBI/AZW3 são pequenos: baixa na memória, não guarda
    const buf = await (await api(driveUrl(it.id))).arrayBuffer();
    return coverFromEpubBuf(await mobiToEpub(buf));
  }
  try { return k === 'pdf' ? await pdfCoverByRange(it) : await epubCoverByRange(it); }
  catch (e) {
    if (e.message === 'auth' || !(it.size && it.size < 25e6)) throw e;   // sem Range: só baixa arquivos pequenos
    console.warn('Range falhou, baixando', it.name, e.message);
    const buf = await (await api(driveUrl(it.id))).arrayBuffer();
    return k === 'pdf' ? await pdfThumb(await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise) : coverFromEpubBuf(buf);
  }
}
let covering = false;
async function genCovers(manual) {
  if (covering) { if (manual) toast('Já estou buscando as capas…'); return; }
  if (!authed()) { if (manual) toast('Entre com o Google primeiro (Configurações).', 4000); return; }
  if (!navigator.onLine) { if (manual) toast('Sem internet.'); return; }
  if (navigator.connection?.saveData && !manual) return;
  const todo = S.library.filter(x => !x.cover && !x.noCover && !x.local && (!x.size || x.size < 60e6));
  if (!todo.length) { if (manual) toast('Todos os livros já têm capa (ou não têm imagem de capa no arquivo).', 4000); return; }
  covering = true; const queue = [...todo]; let done = 0, ok = 0, fail = 0, lastErr = '';
  toast('Buscando as capas de ' + todo.length + ' livros (só um pedacinho de cada arquivo)…', 4000);
  const worker = async () => {
    while (queue.length) {
      while (cur) await sleep(2500);                     // não atrapalha enquanto você lê
      if (!authed()) return;
      const it = queue.shift();
      try { const cv = await fastCover(it); if (cv) { it.cover = cv; ok++; } else { it.noCover = true; fail++; } }
      catch (e) { console.warn('capa', it.name, e); lastErr = e.message; if (e.message === 'auth') { queue.length = 0; return; } it.noCover = true; fail++; }
      if (++done % 6 === 0) { saveState(); if (!cur && !$('#lib').hidden) renderLibrary(); toast('Capas: ' + done + ' de ' + todo.length + '…', 1500); }
    }
  };
  try { await Promise.all([worker(), worker(), worker()]); }
  finally { covering = false; saveState(); if (!cur && !$('#lib').hidden) renderLibrary(); toast('Capas: ' + ok + ' encontradas' + (fail ? ', ' + fail + ' sem capa' : '') + (lastErr ? ' (' + lastErr.slice(0, 60) + ')' : ''), 6000); }
}

/* ---------- estante ---------- */
function renderLibrary() {
  const grid = $('#grid'); grid.innerHTML = '';
  const q = $('#q').value.trim().toLowerCase();
  let list = S.library.filter(x => !q || x.name.toLowerCase().includes(q));
  list.sort((a, b) => ((getBook(b.id).prog?.t || 0) - (getBook(a.id).prog?.t || 0)) || a.name.localeCompare(b.name));
  if (!list.length) {
    grid.innerHTML = '<div class="empty">' + (S.library.length ? 'Nada encontrado.' :
      (!cfg.clientId ? 'Para começar, abra as configurações e cole o Client ID do Google.<br>Ou abra um arquivo deste aparelho pelo botão de adicionar.<br><button id="eSet">Configurações</button>' :
        'Sua estante está vazia.<br>Coloque EPUB, PDF ou MOBI na pasta do Google Drive e atualize.<br><button id="eSync">Atualizar do Drive</button>')) + '</div>';
    $('#eSet')?.addEventListener('click', openSettings); $('#eSync')?.addEventListener('click', doSync);
    return;
  }
  const hero = !q && getBook(list[0].id).prog?.t ? list[0] : null;
  if (hero) {
    const hp = Math.round((getBook(hero.id).prog?.pct || 0) * 100);
    const h = document.createElement('div'); h.className = 'hero';
    h.innerHTML = '<div class="cover"></div><div><div class="cap"></div><h2></h2><div class="prog"><i></i></div><button class="go">Continuar leitura</button></div>';
    const hc = h.querySelector('.cover'); if (hero.cover) hc.style.backgroundImage = 'url(' + hero.cover + ')'; else hc.textContent = kindOf(hero).toUpperCase();
    h.querySelector('.cap').textContent = 'Continuar de onde parou' + (hp ? ' · ' + hp + '%' : '');
    h.querySelector('h2').textContent = cleanName(hero.name); h.querySelector('.prog i').style.width = hp + '%';
    h.addEventListener('click', () => openBook(hero)); grid.appendChild(h);
    if (list.length > 1) { const s = document.createElement('div'); s.className = 'sect'; s.textContent = 'Estante'; grid.appendChild(s); }
  }
  for (const it of list) {
    if (it === hero) continue;
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
  const b = $('#bSync'); b.classList.add('busy');
  try { await refreshLibrary(); hideBanner(); renderLibrary(); toast(S.library.length + ' livros'); genCovers(); }
  catch (e) { showBanner(e.message === 'auth' ? 'Sessão expirada.' : e.message, true); }
  b.classList.remove('busy');
}
function showBanner(msg, withLogin) {
  const b = $('#banner'); b.hidden = false; b.innerHTML = '<span></span>' + (withLogin && cfg.clientId ? '<button id="bLogin">Entrar com Google</button>' : '');
  b.firstChild.textContent = msg;
  $('#bLogin')?.addEventListener('click', async () => { try { await signIn('select_account'); hideBanner(); doSync(); } catch (e) { toast(e.message); } });
}
const hideBanner = () => $('#banner').hidden = true;

/* ---------- painéis / modal ---------- */
function openPanel(title, build) {
  const p = $('#panel'); p.innerHTML = '<h2><span></span><button id="pX" class="ic" aria-label="Fechar"><svg><use href="#i-x"/></svg></button></h2><div class="body"></div>';
  p.querySelector('h2 span').textContent = title; p.style.setProperty('--oy', lastPt[1] + '%'); show(p);
  $('#pX').onclick = closePanel; build(p.querySelector('.body'));
}
const closePanel = () => leave($('#panel'));
function modal(html) {
  const m = $('#modal'); m.innerHTML = html; m.style.setProperty('--ox', lastPt[0] + '%'); m.style.setProperty('--oy', lastPt[1] + '%');
  show(m); m.onclick = e => { if (e.target === m) closeModal(); };
}
const closeModal = () => leave($('#modal'));

function openSettings() {
  openPanel('Configurações', body => {
    body.innerHTML = `
      <label>Client ID do Google (OAuth, tipo "Aplicativo da Web")</label><input id="sCid" type="text" placeholder="123456-abc.apps.googleusercontent.com">
      <label>Pasta do Drive com os livros (nome, link ou ID — vazio = pasta oficial)</label><input id="sFolder" type="text" placeholder="Livros">
      <button class="primary" id="sSave">Salvar e entrar</button>
      <label>Capas dos livros</label><div class="help" id="sCov"></div><button id="sCovBtn" class="primary">Buscar capas agora</button>
      <button id="sOut" style="margin:.2rem .4rem">Sair da conta neste aparelho</button>
      <div class="help">Aparência (tema, fonte, modo de rolagem) fica no botão <b>Aa</b> dentro do livro.<br>O progresso, os destaques, as notas e a tinta da caneta ficam na área privada do app no seu Drive (não aparecem nos seus arquivos).</div>`;
    $('#sCid').value = cfg.clientId; $('#sFolder').value = cfg.folder;
    const nd = S.library.filter(x => !x.local), nc = nd.filter(x => x.cover).length, nn = nd.filter(x => !x.cover && x.noCover).length;
    $('#sCov').textContent = nc + ' de ' + nd.length + ' livros do Drive com capa' + (nn ? ' · ' + nn + ' sem imagem de capa no arquivo' : '') + '.';
    $('#sCovBtn').onclick = () => { S.library.forEach(x => { if (!x.cover) x.noCover = false; }); closePanel(); genCovers(true); };
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
let pdf = null, pdfPageNum = 1, pdfZoom = 1, renderTok = 0, pinched = false; // pdf
let pending = null;  // seleção pendente

/* ---- MOBI / AZW3 → EPUB em memória (foliate-js lê o MOBI; o resto do app trata como EPUB) ---- */
const RES_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/webp': 'webp', 'text/css': 'css', 'font/ttf': 'ttf', 'font/otf': 'otf', 'font/woff': 'woff', 'font/woff2': 'woff2', 'application/font-woff': 'woff', 'application/vnd.ms-opentype': 'otf', 'application/x-font-truetype': 'ttf' };
const xmlEsc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function mobiToEpub(buf) {
  const { MOBI } = await import('./mobi.js');
  const unzlib = async u8 => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  const book = await new MOBI({ unzlib }).open(new Blob([buf]));
  const zip = new JSZip(), res = new Map();
  let rn = 0;
  // troca as URLs temporárias (blob:) por arquivos dentro do EPUB, para ele ficar completo e poder ser guardado
  const embed = async (text, prefix) => {
    for (const u of new Set(text.match(/blob:[^\s"'()<>]+/g) || [])) {
      let r = res.get(u);
      if (!r) {
        const bl = await (await fetch(u)).blob();
        r = { file: 'r' + (rn++) + '.' + (RES_EXT[bl.type] || 'bin'), type: bl.type || 'application/octet-stream' };
        res.set(u, r);
        zip.file('OEBPS/res/' + r.file, bl.type === 'text/css' ? await embed(await bl.text(), '') : bl);
      }
      text = text.split(u).join(prefix + r.file);
    }
    return text;
  };
  const secs = [];
  for (let i = 0; i < book.sections.length; i++) {
    const s = book.sections[i]; if (!s.load) continue;
    const html = await embed(await (await fetch(await s.load())).text(), 'res/');
    zip.file('OEBPS/s' + i + '.html', html); secs.push(i);
  }
  if (!secs.length) throw new Error('Livro vazio ou protegido por DRM.');
  // sumário
  const nav = [];
  const walk = async (items, lvl) => {
    for (const it of items || []) {
      let idx = null; try { idx = (await book.resolveHref(it.href))?.index; } catch { }
      nav.push({ label: String(it.label || '').trim() || 'Seção', idx: secs.includes(idx) ? idx : null, lvl });
      if (it.subitems) await walk(it.subitems, lvl + 1);
    }
  };
  try { await walk(book.toc, 0); } catch { }
  const navItems = nav.filter(n => n.idx != null);
  let cover = null; try { cover = await book.getCover?.(); } catch { }
  if (cover) zip.file('OEBPS/cover.' + (RES_EXT[cover.type] || 'jpg'), cover);
  const meta = book.metadata || {};
  const items = [
    ...secs.map(i => `<item id="s${i}" href="s${i}.html" media-type="application/xhtml+xml"/>`),
    ...[...res.values()].map((r, k) => `<item id="r${k}" href="res/${r.file}" media-type="${xmlEsc(r.type)}"/>`),
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    cover ? `<item id="cover-img" href="cover.${RES_EXT[cover.type] || 'jpg'}" media-type="${xmlEsc(cover.type || 'image/jpeg')}" properties="cover-image"/>` : ''
  ].join('');
  const author = [].concat(meta.author || []).join(', ');
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">${xmlEsc(meta.identifier || 'mobi')}</dc:identifier><dc:title>${xmlEsc(meta.title || 'Livro')}</dc:title>${author ? '<dc:creator>' + xmlEsc(author) + '</dc:creator>' : ''}<dc:language>${xmlEsc(meta.language || 'pt')}</dc:language>${cover ? '<meta name="cover" content="cover-img"/>' : ''}</metadata><manifest>${items}</manifest><spine>${secs.map(i => `<itemref idref="s${i}"/>`).join('')}</spine></package>`);
  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Sumário</title></head><body><nav epub:type="toc"><ol>${(navItems.length ? navItems : secs.map(i => ({ label: 'Parte ' + (secs.indexOf(i) + 1), idx: i }))).map(n => `<li><a href="s${n.idx}.html">${xmlEsc(n.label)}</a></li>`).join('')}</ol></nav></body></html>`);
  const out = await zip.generateAsync({ type: 'arraybuffer' });
  try { book.destroy?.(); } catch { }
  return out;
}
async function getReadable(item, buf) {   // devolve o EPUB convertido quando o livro é MOBI/AZW3
  if (kindOf(item) !== 'mobi') return buf;
  const key = 'conv1_' + item.id;
  const cached = await idb.get('kv', key); if (cached) return cached;
  toast('Convertendo o livro para leitura…', 60000);
  const epub = await mobiToEpub(buf);
  await idb.set('kv', key, epub); toast('Pronto', 700);
  return epub;
}

async function openBook(item) {
  cur = { item, kind: kindOf(item) === 'pdf' ? 'pdf' : 'epub', page: 1 };
  $('#lib').hidden = true; $('#reader').hidden = false;
  $('#rTitle').textContent = cleanName(item.name);
  $('#viewer').hidden = cur.kind !== 'epub'; $('#pdfWrap').hidden = cur.kind !== 'pdf';
  $('#rInk').hidden = cur.kind !== 'pdf'; $('#zoomBtns').hidden = cur.kind !== 'pdf';
  setInk(false); hideSheet(); $('#reader').classList.remove('imm'); $('#viewer').style.left = $('#viewer').style.right = '';
  let buf;
  try { buf = await getFileBuf(item); }
  catch (e) { toast(e.message === 'auth' ? 'Entre com o Google (⚙) para baixar.' : e.message); closeReader(); return; }
  if (authed() && navigator.onLine) await Promise.race([syncBook(item.id), sleep(4000)]);
  try { buf = await getReadable(item, buf); cur.kind === 'pdf' ? await openPdf(buf) : await openEpub(buf); }
  catch (e) { console.error(e); toast('Não consegui abrir: ' + e.message, 6000); closeReader(); }
}

async function closeReader() {
  hideSheet(); closePanel();
  $('#reader').classList.remove('imm'); $('#viewer').style.left = $('#viewer').style.right = '';
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
      const ed = document.createElement('button'); ed.textContent = 'Editar'; ed.className = 'ed';
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
  light: { body: { background: '#E8E8E6 !important', color: '#1C1D20 !important' }, 'p,div,span,li,h1,h2,h3,h4,h5,h6,td': { color: '#1C1D20 !important' } },
  sepia: { body: { background: '#E6DBC3 !important', color: '#4b3b2a !important' }, 'p,div,span,li,h1,h2,h3,h4,h5,h6,td': { color: '#4b3b2a !important' } },
  black: { body: { background: '#000000 !important', color: '#B5B7BA !important' }, 'p,div,span,li,h1,h2,h3,h4,h5,h6,td': { color: '#B5B7BA !important' } },
  dark: { body: { background: '#1C1D20 !important', color: '#C5C7CA !important' }, 'p,div,span,li,h1,h2,h3,h4,h5,h6,td': { color: '#C5C7CA !important' } },
};
async function openEpub(buf) {
  const id = cur.item.id, b = getBook(id);
  ebook = ePub(buf, { openAs: 'binary' });
  rend = ebook.renderTo($('#viewer'), { width: '100%', height: '100%', flow: cfg.flow, spread: 'auto', allowScriptedContent: false });
  for (const [n, r] of Object.entries(EPUB_THEMES)) rend.themes.register(n, r);
  rend.hooks.content.register(c => applyUserCss(c));
  applyEpubLook(true);
  b.hl.filter(h => h.kind === 'epub' && !h.del).forEach(renderHl);
  rend.on('relocated', loc => {
    epubTurn();
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
    if (cfg.flow === 'paginated' && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) dx < 0 ? next() : prev();
  });
  rend.on('click', e => {
    if (e.target?.closest?.('a[href]')) return;
    const s = e.view?.getSelection?.(); if (s && !s.isCollapsed) return;
    const vr = $('#viewer').getBoundingClientRect(), fx = e.view?.frameElement ? e.view.frameElement.getBoundingClientRect().left : 0;
    if (cfg.flow === 'paginated') zoneTap((fx + e.clientX - vr.left) / vr.width); else toggleChrome();
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
  if (cfg.fit === 'crop' && !S.crops?.[id]) { toast('Ajustando as margens do livro…', 8000); await pdfAutoCrop(); toast('Pronto', 600); }
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
const lay = { ox: 0, oy: 0, cw: 0, ch: 0, W: 0, H: 0 };
const cropOf = id => (cfg.fit === 'crop' && S.crops?.[id]) || [0, 0, 1, 1];
const quant = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * p)))]; };
// Descobre as margens em branco do livro olhando ~9 páginas; usa o mesmo corte em todas, para o texto não "pular" de tamanho.
async function pdfAutoCrop(force) {
  const id = cur.item.id; S.crops ||= {};
  if (S.crops[id] && !force) return;
  const n = pdf.numPages, from = n > 12 ? 3 : 1, to = n > 12 ? n - 2 : n, cnt = Math.min(9, to - from + 1), boxes = [];
  for (let i = 0; i < cnt; i++) {
    const p = Math.round(from + (to - from) * (cnt === 1 ? 0 : i / (cnt - 1)));
    try {
      const pg = await pdf.getPage(p), vp = pg.getViewport({ scale: 260 / pg.getViewport({ scale: 1 }).width });
      const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const x = c.getContext('2d', { willReadFrequently: true }); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
      await pg.render({ canvasContext: x, viewport: vp }).promise;
      const W = c.width, H = c.height, d = x.getImageData(0, 0, W, H).data;
      const L = (px, py) => { const k = (py * W + px) * 4; return .299 * d[k] + .587 * d[k + 1] + .114 * d[k + 2]; };
      const bg = (L(2, 2) + L(W - 3, 2) + L(2, H - 3) + L(W - 3, H - 3)) / 4;
      const rows = new Uint16Array(H), cols = new Uint16Array(W);
      for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) if (Math.abs(L(xx, yy) - bg) > 45) { rows[yy]++; cols[xx]++; }
      const first = a => a.findIndex(v => v >= 2), last = a => { for (let i = a.length - 1; i >= 0; i--) if (a[i] >= 2) return i; return -1; };
      const t = first(rows), b = last(rows), l = first(cols), r = last(cols);
      if (t >= 0 && l >= 0 && b > t && r > l) boxes.push([l / W, t / H, (r + 1) / W, (b + 1) / H]);
    } catch { }
  }
  let crop = [0, 0, 1, 1];
  if (boxes.length >= 2) {
    const pad = .015;
    const c = [Math.max(0, quant(boxes.map(b => b[0]), .2) - pad), Math.max(0, quant(boxes.map(b => b[1]), .2) - pad), Math.min(1, quant(boxes.map(b => b[2]), .8) + pad), Math.min(1, quant(boxes.map(b => b[3]), .8) + pad)];
    if (c[2] - c[0] > .4 && c[3] - c[1] > .4) crop = c.map(v => +v.toFixed(4));
  }
  S.crops[id] = crop; saveState();
}
async function renderPdfPage() {
  if (!pdf || !cur) return;
  const tok = ++renderTok; cur.page = pdfPageNum;
  const pg = await pdf.getPage(pdfPageNum); if (tok !== renderTok || !pdf || !cur) return;
  const wrap = $('#pdfWrap'), base = pg.getViewport({ scale: 1 });
  const [cl, ct, cr, cb] = cropOf(cur.item.id);
  const cwPt = (cr - cl) * base.width, chPt = (cb - ct) * base.height;
  const availW = Math.max(60, wrap.clientWidth - 18), availH = Math.max(60, wrap.clientHeight - 16);
  const wide = availW > availH * 0.85;                // computador / tablet deitado
  const fit = (cfg.fit === 'page' || (cfg.fit === 'crop' && wide)) ? Math.min(availW / cwPt, availH / chPt) : availW / cwPt;
  const cssScale = fit * pdfZoom;
  const vp = pg.getViewport({ scale: cssScale }), dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  Object.assign(lay, { W: vp.width, H: vp.height, ox: cl * vp.width, oy: ct * vp.height, cw: (cr - cl) * vp.width, ch: (cb - ct) * vp.height });
  const page = $('#pdfPage'), inner = $('#pdfInner');
  page.style.width = lay.cw + 'px'; page.style.height = lay.ch + 'px';
  page.style.overflow = (cl > 0 || ct > 0 || cr < 1 || cb < 1) ? 'hidden' : 'visible';
  inner.style.width = vp.width + 'px'; inner.style.height = vp.height + 'px'; inner.style.left = -lay.ox + 'px'; inner.style.top = -lay.oy + 'px';
  const cv = $('#pdfCv'); cv.width = vp.width * dpr; cv.height = vp.height * dpr;
  const r = pg.render({ canvasContext: cv.getContext('2d'), viewport: pg.getViewport({ scale: cssScale * dpr }) });
  const tl = $('#textLayer'); tl.innerHTML = ''; tl.style.setProperty('--scale-factor', cssScale);
  pg.getTextContent().then(tc => { if (tok !== renderTok) return; pdfjsLib.renderTextLayer({ textContentSource: tc, container: tl, viewport: vp, textDivs: [] }); });
  const ic = $('#inkCv'); ic.width = vp.width * dpr; ic.height = vp.height * dpr;
  drawPdfHl(); drawInk();
  try { await r.promise; } catch { }
  wrap.scrollTop = 0;
  if (!pdf || !cur) return;
  $('#slider').value = pdfPageNum; $('#pos').textContent = pdfPageNum + ' / ' + pdf.numPages;
  setProg({ page: pdfPageNum, pct: pdfPageNum / pdf.numPages });
}
function flipOverlay(dir) {
  const page = $('#pdfPage'), snap = document.createElement('canvas'), cv = $('#pdfCv'), ic = $('#inkCv');
  snap.width = cv.width; snap.height = cv.height;
  const x = snap.getContext('2d'); x.drawImage(cv, 0, 0); if (ic.width) x.drawImage(ic, 0, 0, snap.width, snap.height);
  snap.className = 'flip';
  snap.style.cssText = `left:${-lay.ox}px;top:${-lay.oy}px;width:${lay.W}px;height:${lay.H}px;filter:${getComputedStyle(cv).filter};transform-origin:${dir > 0 ? lay.ox : lay.ox + lay.cw}px center`;
  page.appendChild(snap); return snap;
}
function playFlip(snap, dir) {
  const wrap = $('#pdfWrap'); wrap.style.overflow = 'hidden';
  const to = dir > 0 ? -105 : 105;
  const anim = snap.animate([
    { transform: 'rotateY(0deg)', filter: snap.style.filter + ' brightness(1)', boxShadow: '0 0 0 #0000' },
    { transform: 'rotateY(' + (to * .5) + 'deg)', filter: snap.style.filter + ' brightness(.75)', boxShadow: (dir > 0 ? '-' : '') + '24px 0 40px #0008', offset: .5 },
    { transform: 'rotateY(' + to + 'deg)', filter: snap.style.filter + ' brightness(.5)', boxShadow: '0 0 0 #0000' }
  ], { duration: 380, easing: 'cubic-bezier(.45,.05,.35,1)', fill: 'forwards' });
  const done = () => { snap.remove(); wrap.style.overflow = ''; };
  anim.onfinish = done; anim.oncancel = done;
}
async function pdfGo(n) {
  n = Math.min(Math.max(1, n), pdf.numPages);
  if (n === pdfPageNum && $('#pdfCv').width) return;
  const dir = n > pdfPageNum ? 1 : -1;
  const fx = cfg.flip !== false && Math.abs(n - pdfPageNum) === 1 && $('#pdfCv').width && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  const snap = fx ? flipOverlay(dir) : null;
  pdfPageNum = n; await renderPdfPage();
  if (snap) playFlip(snap, dir);
}
function pdfSelRects() {
  const s = getSelection(); if (!s || !s.rangeCount) return [];
  const pr = $('#pdfInner').getBoundingClientRect(), W = pr.width;
  return [...s.getRangeAt(0).getClientRects()].filter(r => r.width > 1 && r.height > 1)
    .map(r => ({ x: +((r.left - pr.left) / W).toFixed(5), y: +((r.top - pr.top) / W).toFixed(5), w: +(r.width / W).toFixed(5), h: +(r.height / W).toFixed(5) }));
}
function drawPdfHl() {
  const L = $('#hlLayer'); L.innerHTML = ''; if (!cur || cur.kind !== 'pdf') return;
  const W = $('#pdfInner').clientWidth;
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
  const pr = $('#pdfInner').getBoundingClientRect(), x = (e.clientX - pr.left) / pr.width, y = (e.clientY - pr.top) / pr.width;
  const h = getBook(cur.item.id).hl.find(h => !h.del && h.kind === 'pdf' && h.page === pdfPageNum && h.rects.some(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h));
  if (h) { e.stopPropagation(); editHl(h.id); }
});
// deslizar para trocar de página (PDF)
{
  let x0 = 0, y0 = 0, t0 = 0;
  const w = $('#pdfWrap');
  w.addEventListener('touchstart', e => { x0 = e.changedTouches[0].clientX; y0 = e.changedTouches[0].clientY; t0 = now(); }, { passive: true });
  w.addEventListener('touchend', e => {
    if ($('#inkCv').classList.contains('on') || pdfZoom > 1.05 || pinched) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    if (now() - t0 < 600 && Math.abs(dx) > 80 && Math.abs(dx) > Math.abs(dy) * 2 && getSelection().isCollapsed) pdfGo(pdfPageNum + (dx < 0 ? 1 : -1));
  }, { passive: true });
}

/* ---- tela cheia (esconde as barras) e toques nas laterais ---- */
function relayout() {
  if (!cur) return;
  if (cur.kind === 'pdf') renderPdfPage(); else { try { rend?.resize(); } catch { } }
}
function toggleChrome(force) {
  const r = $('#reader'), on = force ?? !r.classList.contains('imm');
  r.classList.toggle('imm', on);
  if (on && !lsGet('immHint', false)) { lsSet('immHint', true); toast('Toque no centro da tela para mostrar os botões de novo', 3500); }
  setTimeout(relayout, 80);
}
function zoneTap(x) { if (x < .28) prev(); else if (x > .72) next(); else toggleChrome(); }
$('#rFull').onclick = () => toggleChrome(true);
new MutationObserver(() => { $('#mini').textContent = $('#pos').textContent; }).observe($('#pos'), { childList: true, characterData: true, subtree: true });
$('#pdfWrap').addEventListener('click', e => {
  if (!cur || cur.kind !== 'pdf' || $('#inkCv').classList.contains('on')) return;
  const s = getSelection(); if (s && !s.isCollapsed) return;
  const r = e.currentTarget.getBoundingClientRect(); zoneTap((e.clientX - r.left) / r.width);
});
// pinça (dois dedos) para ajustar o zoom do PDF
{
  const w = $('#pdfWrap'); let d0 = 0, d1 = 0; const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  w.addEventListener('touchstart', e => { if (e.touches.length === 2) { d0 = d1 = dist(e.touches); pinched = true; } }, { passive: true });
  w.addEventListener('touchmove', e => { if (e.touches.length === 2 && d0) d1 = dist(e.touches); }, { passive: true });
  w.addEventListener('touchend', e => {
    if (d0 && e.touches.length < 2) {
      const f = d1 / d0; d0 = 0;
      if (Math.abs(f - 1) > .08) { pdfZoom = Math.min(4, Math.max(.5, pdfZoom * f)); cfg.zoom = +pdfZoom.toFixed(2); saveCfg(); renderPdfPage(); }
      setTimeout(() => pinched = false, 300);
    }
  }, { passive: true });
}

/* ---- computador: roda do mouse, zoom, redimensionar ---- */
{
  let wt = 0, zt;
  $('#pdfWrap').addEventListener('wheel', e => {
    if (!cur || cur.kind !== 'pdf') return;
    if (e.ctrlKey) {                                       // Ctrl + rolagem = zoom
      e.preventDefault(); pdfZoom = Math.min(4, Math.max(.5, pdfZoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1))); cfg.zoom = +pdfZoom.toFixed(2);
      clearTimeout(zt); zt = setTimeout(() => { saveCfg(); renderPdfPage(); }, 120); return;
    }
    const w = e.currentTarget;
    if (w.scrollHeight > w.clientHeight + 12 || Math.abs(e.deltaY) < 20) return;   // página maior que a tela: rola normal
    const t = now(); if (t - wt < 450) return; wt = t; e.preventDefault(); e.deltaY > 0 ? next() : prev();
  }, { passive: false });
  let rz; window.addEventListener('resize', () => {
    if (!cur) return; clearTimeout(rz);
    rz = setTimeout(() => { if (cur.kind === 'pdf') renderPdfPage(); else if (rend) { viewerInset(); reflow(); } }, 220);
  });
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
  ink.on = on; if (on) $('#reader').classList.remove('imm'); $('#inkbar').hidden = !on; $('#rInk').classList.toggle('on', on);
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
let turnDir = 0;
function epubTurn() {
  if (!turnDir || cfg.flip === false || cfg.flow !== 'paginated' || matchMedia('(prefers-reduced-motion: reduce)').matches) { turnDir = 0; return; }
  const v = $('#viewer'), d = turnDir; turnDir = 0;
  v.style.transformOrigin = d > 0 ? 'left center' : 'right center';
  v.animate([{ transform: 'perspective(1800px) rotateY(' + (d > 0 ? 16 : -16) + 'deg)', opacity: .35 }, { transform: 'perspective(1800px) rotateY(0deg)', opacity: 1 }], { duration: 380, easing: 'cubic-bezier(.2,.7,.3,1)' });
}
function next() { if (cur.kind === 'epub') { turnDir = 1; rend?.next(); } else pdfGo(pdfPageNum + 1); }
function prev() { if (cur.kind === 'epub') { turnDir = -1; rend?.prev(); } else pdfGo(pdfPageNum - 1); }
function keyNav(e) {
  if (!cur || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') next();
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') prev();
  else if (e.key === 'Home' || e.key === 'End') {
    if (cur.kind === 'pdf') pdfGo(e.key === 'Home' ? 1 : pdf.numPages); else if (ebook?.locations.length()) rend.display(ebook.locations.cfiFromPercentage(e.key === 'Home' ? 0 : .999));
  }
  else if (e.key === '+' || e.key === '=' || e.key === '-') {
    if (cur.kind === 'pdf') $(e.key === '-' ? '#zOut' : '#zIn').click();
    else { cfg.fs = Math.min(300, Math.max(70, cfg.fs + (e.key === '-' ? -10 : 10))); saveCfg(); applyEpubLook(); }
  }
  else if (e.key === 'f' || e.key === 'F') toggleChrome();
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
const FONTS = {
  book: ['Do livro', ''],
  literata: ['Literata', '"Literata", Georgia, serif'],
  garamond: ['Garamond', '"EB Garamond", Georgia, serif'],
  crimson: ['Crimson', '"Crimson Pro", Georgia, serif'],
  merri: ['Merriweather', '"Merriweather", Georgia, serif'],
  serif: ['Georgia', 'Georgia, "Times New Roman", serif'],
  sans: ['Sem serifa', 'system-ui, "Segoe UI", Roboto, Arial, sans-serif'],
};
const FONT_FILES = { literata: ['Literata', 'literata'], garamond: ['EB Garamond', 'ebgaramond'], crimson: ['Crimson Pro', 'crimsonpro'], merri: ['Merriweather', 'merriweather'] };
function fontFace(key) {                      // fontes embutidas no app, carregadas dentro da página do livro
  const f = FONT_FILES[key]; if (!f) return '';
  const u = n => new URL(n, location.href).href;
  return '@font-face{font-family:"' + f[0] + '";src:url(' + u(f[1] + '-r.woff2') + ') format("woff2");font-weight:200 900;font-style:normal;font-display:swap}' +
    '@font-face{font-family:"' + f[0] + '";src:url(' + u(f[1] + '-i.woff2') + ') format("woff2");font-weight:200 900;font-style:italic;font-display:swap}';
}
function userCss() {
  const d = [];
  if (FONTS[cfg.ff]?.[1]) d.push('font-family:' + FONTS[cfg.ff][1] + ' !important');
  if (cfg.lh) d.push('line-height:' + cfg.lh + ' !important');
  if (cfg.just) d.push('text-align:justify !important');
  return (d.length ? fontFace(cfg.ff) : '') + (d.length ? 'html body, html body p, html body li, html body div, html body span, html body blockquote, html body td{' + d.join(';') + '}' : '');
}
function applyUserCss(contents) {
  try {
    const doc = contents.document; let st = doc.getElementById('u-style');
    if (!st) { st = doc.createElement('style'); st.id = 'u-style'; doc.head.appendChild(st); }
    st.textContent = userCss();
  } catch { }
}
let reflowT;
function reflow() {
  clearTimeout(reflowT);
  reflowT = setTimeout(() => {
    if (!rend || !cur) return;
    const loc = getBook(cur.item.id).prog?.loc;
    try { rend.resize(); if (loc) rend.display(loc); } catch { }
  }, 280);
}
function viewerInset() {
  const v = $('#viewer'), w = $('#stage').clientWidth, side = Math.max(w * (cfg.mg || 0) / 100, (w - 1240) / 2);
  v.style.left = v.style.right = Math.round(side) + 'px';
}
function applyEpubLook(noReflow) {
  if (!rend) return;
  rend.themes.select(cfg.theme); rend.themes.fontSize(cfg.fs + '%');
  rend.getContents().forEach(applyUserCss);
  viewerInset();
  try { rend.spread(cfg.cols === '1' ? 'none' : 'auto'); } catch { }
  if (!noReflow) reflow();
}
$('#rSet').onclick = () => openPanel('Aparência e leitura', body => {
  const mk = (label, opts, get, set) => {
    const l = document.createElement('label'); l.textContent = label; body.appendChild(l);
    const r = document.createElement('div'); r.className = 'row'; body.appendChild(r);
    opts.forEach(([v, t]) => { const b = document.createElement('button'); b.textContent = t; b.className = get() === v ? 'on' : ''; b.onclick = () => { set(v); [...r.children].forEach(c => c.classList.remove('on')); b.classList.add('on'); }; r.appendChild(b); });
  };
  const slider = (label, min, max, step, get, set, fmt) => {
    const l = document.createElement('label'); body.appendChild(l);
    const row = document.createElement('div'); row.className = 'row srow'; body.appendChild(row);
    const inp = document.createElement('input'); inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = get();
    const minus = document.createElement('button'), plus = document.createElement('button'); minus.textContent = '−'; plus.textContent = '+';
    const show = () => l.textContent = label + ': ' + fmt(+inp.value);
    const go = v => { inp.value = Math.min(max, Math.max(min, v)); show(); set(+inp.value); };
    inp.oninput = () => go(+inp.value); minus.onclick = () => go(+inp.value - step); plus.onclick = () => go(+inp.value + step);
    show(); row.append(minus, inp, plus);
  };
  mk('Fundo', [['light', 'Claro'], ['sepia', 'Sépia'], ['dark', 'Escuro'], ['black', 'Preto']], () => cfg.theme, v => { cfg.theme = v; saveCfg(); applyTheme(); applyEpubLook(true); setNightLabel(); });
  const nb = document.createElement('div'); nb.className = 'row'; body.appendChild(nb);
  const night = document.createElement('button'); nb.appendChild(night);
  const setNightLabel = () => { night.textContent = isNightMode() ? 'Voltar ao modo dia' : 'Ativar modo noite'; night.className = isNightMode() ? 'on' : ''; };
  setNightLabel();
  const eyes = [];
  const lbl = document.createElement('label'); lbl.textContent = 'Conforto para os olhos'; body.insertBefore(lbl, nb);
  night.onclick = () => {
    if (isNightMode()) { cfg.theme = cfg.dayTheme || 'sepia'; cfg.warm = 0; cfg.dim = 0; }
    else { cfg.dayTheme = cfg.theme; cfg.theme = 'black'; cfg.warm = 35; cfg.dim = 15; }
    saveCfg(); applyTheme(); applyNight(); applyEpubLook(true); closePanel(); setTimeout(() => $('#rSet').click(), 180);
  };
  slider('Brilho do app (escurecer)', 0, 70, 5, () => cfg.dim || 0, v => { cfg.dim = v; saveCfg(); applyNight(); setNightLabel(); }, v => v ? '−' + v + '%' : 'normal');
  slider('Luz quente (menos azul)', 0, 100, 5, () => cfg.warm || 0, v => { cfg.warm = v; saveCfg(); applyNight(); setNightLabel(); }, v => v ? v + '%' : 'desligada');
  const eh = document.createElement('div'); eh.className = 'help';
  eh.textContent = 'À noite: fundo Preto + luz quente de 30% a 50% + brilho reduzido. O botão acima liga tudo de uma vez. Isso vale para o app inteiro e funciona junto com o brilho do celular.'; body.appendChild(eh);
  if (cur.kind === 'epub') {
    slider('Tamanho da letra', 70, 300, 5, () => cfg.fs, v => { cfg.fs = v; saveCfg(); applyEpubLook(); }, v => v + '%');
    slider('Espaço entre linhas', 0, 2.4, .1, () => cfg.lh || 0, v => { cfg.lh = v < 1 ? 0 : +v.toFixed(1); saveCfg(); applyEpubLook(); }, v => v < 1 ? 'do livro' : v.toFixed(1));
    slider('Margens laterais', 0, 25, 1, () => cfg.mg, v => { cfg.mg = v; saveCfg(); applyEpubLook(); }, v => v + '%');
    mk('Fonte (parecidas com livro)', Object.entries(FONTS).map(([k, [t]]) => [k, t]), () => cfg.ff, v => { cfg.ff = v; saveCfg(); applyEpubLook(); });
    mk('Alinhamento', [[false, 'Padrão'], [true, 'Justificado']], () => !!cfg.just, v => { cfg.just = v; saveCfg(); applyEpubLook(); });
    mk('Colunas (tela larga)', [['auto', 'Automático'], ['1', 'Uma só']], () => cfg.cols, v => { cfg.cols = v; saveCfg(); applyEpubLook(); });
    mk('Modo', [['paginated', 'Páginas'], ['scrolled-doc', 'Rolagem']], () => cfg.flow, v => { cfg.flow = v; saveCfg(); rend.flow(v); $('.edge.l').hidden = $('.edge.r').hidden = v !== 'paginated'; });
  } else {
    mk('Ajuste da página', [['crop', 'Sem margens'], ['width', 'Largura'], ['page', 'Página inteira']], () => cfg.fit, async v => {
      cfg.fit = v; saveCfg();
      if (v === 'crop' && !S.crops?.[cur.item.id]) { toast('Medindo as margens do livro…', 8000); await pdfAutoCrop(); toast('Pronto', 700); }
      renderPdfPage();
    });
    slider('Tamanho (zoom)', 50, 300, 5, () => Math.round(pdfZoom * 100), v => { pdfZoom = v / 100; cfg.zoom = pdfZoom; saveCfg(); renderPdfPage(); }, v => v + '%');
    const h = document.createElement('div'); h.className = 'help';
    h.innerHTML = 'PDF não reorganiza o texto: para letras maiores use <b>Sem margens</b> (corta o branco das bordas) e aumente o <b>zoom</b>. No celular, pinça com dois dedos também ajusta. No computador: roda do mouse vira a página, Ctrl + roda dá zoom, setas/Espaço viram página, + e − dão zoom, F esconde os botões.'; body.appendChild(h);
  }
  mk('Efeito de virar página', [[true, 'Ligado'], [false, 'Desligado']], () => cfg.flip !== false, v => { cfg.flip = v; saveCfg(); });
  const row = document.createElement('div'); row.className = 'row'; body.appendChild(row);
  const b1 = document.createElement('button'); b1.textContent = 'Esconder botões'; b1.onclick = () => { closePanel(); toggleChrome(true); };
  row.appendChild(b1);
  if (document.documentElement.requestFullscreen) {
    const b2 = document.createElement('button'); b2.textContent = 'Tela cheia do navegador';
    b2.onclick = () => { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => { }); };
    row.appendChild(b2);
  }
});
function applyNight() {
  $('#night .dim').style.opacity = String(Math.min(70, Math.max(0, cfg.dim || 0)) / 100);
  $('#night .warm').style.opacity = String(Math.min(100, Math.max(0, cfg.warm || 0)) / 100 * .8);
}
const isNightMode = () => cfg.theme === 'black' && (cfg.warm || 0) > 0;
function applyTheme() { document.body.dataset.theme = cfg.theme; document.querySelector('meta[name=theme-color]').content = '#1C1D20'; }
const THEMES = ['light', 'sepia', 'dark', 'black'];
$('#rTheme').onclick = () => { cfg.theme = THEMES[(THEMES.indexOf(cfg.theme) + 1) % THEMES.length]; saveCfg(); applyTheme(); applyEpubLook(); toast({ light: 'Fundo claro', sepia: 'Fundo sépia', dark: 'Fundo escuro', black: 'Fundo preto' }[cfg.theme], 900); };

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

/* ================== DESCOBRIR (catálogo Amazon BR) ================== */
const SPR = { cols: 10, w: 96, h: 144 };
const favs = new Set(lsGet('favs', []));
const dst = { cat: '__all', q: '', shown: {} };
function coverEl(asin, title, big) {
  const d = document.createElement('div'), c = CAPAS[asin];
  d.className = big ? 'cvbig' : 'cv';
  if (!c) { d.textContent = title.charAt(0); return d; }
  const k = big ? 2.25 : 1, col = c[1] % SPR.cols, row = Math.floor(c[1] / SPR.cols);
  d.style.backgroundImage = 'url(capas' + c[0] + '.jpg)';
  d.style.backgroundSize = (SPR.cols * 64 * k) + 'px auto';
  d.style.backgroundPosition = '-' + (col * 64 * k) + 'px -' + (row * 96 * k) + 'px';
  d.setAttribute('role', 'img'); d.setAttribute('aria-label', 'Capa de ' + title);
  return d;
}
function discItems() {
  const q = dst.q.trim().toLowerCase(), out = [], seen = new Set();
  DATA.forEach(([cat, bs]) => bs.forEach((b, i) => {
    if (dst.cat === '__fav' ? !favs.has(b[3]) : (!q && dst.cat !== '__all' && dst.cat !== cat)) return;
    if (q && !(b[0] + ' ' + b[1] + ' ' + b[4] + ' ' + ((DET[b[3]] || [])[1] || '')).toLowerCase().includes(q)) return;
    if ((q || dst.cat === '__fav' || dst.cat === '__all') && seen.has(b[3])) return;
    seen.add(b[3]); out.push({ cat, rank: i + 1, b });
  }));
  return out;
}
function renderDisc() {
  const cats = $('#dcats'); cats.innerHTML = '';
  [['__all', 'Todas'], ['__fav', 'Favoritos (' + favs.size + ')'], ...DATA.map(d => [d[0], d[0]])].forEach(([id, t]) => {
    const b = document.createElement('button'); b.textContent = t; b.className = dst.cat === id ? 'on' : '';
    b.onclick = () => { dst.cat = id; renderDisc(); $('#dlist').scrollTop = 0; }; cats.appendChild(b);
  });
  const list = $('#dlist'); list.innerHTML = '';
  const items = discItems(), key = dst.cat + '|' + dst.q, step = 20;
  const n = Math.min(items.length, dst.shown[key] || step);
  if (!items.length) {
    const e = document.createElement('div'); e.className = 'empty';
    e.textContent = dst.cat === '__fav' ? 'Nenhum favorito ainda. Abra um livro e toque em Favoritar.' : 'Nada encontrado.'; list.appendChild(e);
  }
  items.slice(0, n).forEach(({ cat, rank, b }) => {
    const row = document.createElement('div'); row.className = 'bk';
    const info = document.createElement('div');
    const tt = document.createElement('div'); tt.className = 'tt';
    if (dst.cat !== '__fav' && !dst.q) { const rk = document.createElement('span'); rk.className = 'rk'; rk.textContent = '#' + rank; tt.appendChild(rk); }
    tt.appendChild(document.createTextNode(b[0]));
    const au = document.createElement('div'); au.className = 'au'; au.textContent = b[1];
    const rt = document.createElement('div'); rt.className = 'rt';
    rt.textContent = [b[2] ? 'Nota ' + b[2] : '', favs.has(b[3]) ? 'Favorito' : '', (dst.q || dst.cat === '__all' || dst.cat === '__fav') ? cat : ''].filter(Boolean).join(' · ');
    const ds = document.createElement('div'); ds.className = 'ds'; ds.textContent = b[4] || ((DET[b[3]] || [])[1]) || '';
    info.append(tt, au, rt, ds);
    row.append(coverEl(b[3], b[0]), info); row.onclick = () => discDetail(b[3]);
    list.appendChild(row);
  });
  if (n < items.length) {
    const m = document.createElement('div'); m.className = 'more';
    const b1 = document.createElement('button'); b1.textContent = 'Mostrar mais ' + step; b1.onclick = () => { dst.shown[key] = n + step; renderDisc(); };
    const b2 = document.createElement('button'); b2.textContent = 'Mostrar todos (' + items.length + ')'; b2.onclick = () => { dst.shown[key] = items.length; renderDisc(); };
    m.append(b1, b2); list.appendChild(m);
  }
}
function discDetail(asin) {
  const pos = []; let b = null;
  DATA.forEach(([c, bs]) => bs.forEach((x, i) => { if (x[3] === asin) { b = b || x; pos.push('#' + (i + 1) + ' em ' + c); } }));
  if (!b) return;
  const desc = (DET[asin] || [])[1] || b[4] || 'Sem sinopse coletada.';
  modal('<div class="box"><div class="dh"><div id="mCv"></div><div style="flex:1;min-width:180px"><b id="mT"></b><div class="au" id="mA"></div><div class="rt" id="mR"></div><div class="rt" id="mP" style="margin-top:.4rem"></div></div></div><div class="dd" id="mD"></div><div class="row"><button id="mFav"></button><a class="btn" id="mAz" target="_blank" rel="noopener noreferrer">Ver na Amazon</a><span class="sp"></span><button id="mX">Fechar</button></div></div>');
  $('#mCv').appendChild(coverEl(asin, b[0], true));
  $('#mT').textContent = b[0]; $('#mA').textContent = b[1]; $('#mR').textContent = b[2] ? 'Nota ' + b[2] : '';
  $('#mP').textContent = pos.join(' · '); $('#mD').textContent = desc;
  $('#mAz').href = 'https://www.amazon.com.br/dp/' + encodeURIComponent(asin);
  const fb = $('#mFav'), setF = () => fb.textContent = favs.has(asin) ? 'Nos favoritos' : 'Favoritar';
  setF(); fb.onclick = () => { favs.has(asin) ? favs.delete(asin) : favs.add(asin); lsSet('favs', [...favs]); setF(); renderDisc(); };
  $('#mX').onclick = closeModal;
}
$('#bDisc').onclick = () => { $('#lib').hidden = true; $('#disc').hidden = false; renderDisc(); };
$('#dBack').onclick = () => { $('#disc').hidden = true; $('#lib').hidden = false; };
$('#dq').addEventListener('input', e => { dst.q = e.target.value; renderDisc(); });

/* ---- iniciar ---- */
window.gisReady = () => { if (lsGet('wasLogged', false) && !authed() && cfg.clientId && !S.library.length) showBanner('Toque para entrar de novo.', true); };
window.addEventListener('online', () => { if (cur) syncBook(cur.item.id); });
(async function init() {
  await idb.open();
  const st = await idb.get('kv', 'state'); if (st) S = Object.assign(S, st);
  (await idb.keys('files')).forEach(k => dlCache.add(k));
  applyTheme(); applyNight(); renderLibrary();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
  if (cfg.clientId && navigator.onLine) {
    if (authed()) { doSync(); genCovers(); }
    else if (lsGet('wasLogged', false)) showBanner('Sessão do Google expirada.', true);
    else showBanner('Entre com o Google para ver os livros do Drive.', true);
  } else if (!cfg.clientId) showBanner('Configure o Client ID do Google (⚙) para sincronizar com o Drive.', false);
})();
