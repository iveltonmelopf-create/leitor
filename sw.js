const C='leitor-v9';
const SHELL=['./','index.html','style.css','app.js','manifest.json','icon.svg','archivo.woff2','plexmono-400.woff2','plexmono-500.woff2','catalogo.js','mobi.js','pdf.min.js','pdf.worker.min.js','epub.min.js','jszip.min.js'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(u.origin!==location.origin||e.request.method!=='GET')return;
  // rede primeiro (pega atualizações), cai para o cache offline
  e.respondWith(fetch(e.request,{cache:'no-cache'}).then(r=>{const c=r.clone();caches.open(C).then(x=>x.put(e.request,c));return r}).catch(()=>caches.match(e.request,{ignoreSearch:true})));
});
