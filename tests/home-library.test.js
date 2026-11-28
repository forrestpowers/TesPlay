import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source = ts.transpileModule(fs.readFileSync(new URL('../src/home-library.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { loadHomeConnection, homeFeatures } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const connection = (type, id = type) => ({ id, name: type, type, configured: true });
const item = (id, type = 'movie', c = 'iptv') => ({ id, title: id, type, connectionId: c, source: c });
test('IPTV Home bundles account previews, keeps highlights balanced, and skips unselected stars', async () => {
  const {bundleIptvHomeShelves} = await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  const first = {...connection('xtream','first'),loadedCategories:['movie:1']}, second = connection('xtream','second');
  const rows = [first,second].map(c => ({id:c.id,connectionId:c.id,title:c.id,kind:'movie',items:[item('same','movie',c.id),item('other','movie',c.id)]}));
  const bundled = bundleIptvHomeShelves(rows,[first,second]);
  assert.equal(bundled.length,1);assert.equal(bundled[0].title,'IPTV · Movies');
  assert.deepEqual(homeFeatures(bundled).map(i=>i.connectionId),['first','second','first','second']);
  const paths=[];
  await loadHomeConnection(first,async path=>{paths.push(path);return{items:[]};},new AbortController().signal,[{connectionId:first.id,kind:'category',id:'live:1',title:'News'}]);
  assert.deepEqual(paths,[],'no movie or series previews, and a starred category outside the loaded selection is skipped');
});
test('IPTV home requests only starred live categories, without movie or series previews', async () => {
  const seen=[];
  const result=await loadHomeConnection(connection('xtream'),async path=>{
    const p=new URL(path,'https://tesplay.test').searchParams;seen.push([p.get('kind'),p.get('category')]);assert.equal(p.get('sort'),'recent');
    if(p.get('kind')==='series')throw Error('Unavailable');return {items:[item(p.get('category')||p.get('kind'),p.get('kind'),'xtream')]};
  },new AbortController().signal,[{connectionId:'xtream',kind:'category',id:'live:20',title:'Favourites'},{connectionId:'other',kind:'category',id:'live:90',title:'Other connection'}]);
  assert.deepEqual(seen,[['live','live:20']]);
  assert.deepEqual(result.shelves.map(s=>s.kind),['live']);assert.equal(result.shelves[0].category,'live:20');assert.equal(result.issues.length,0);
  const onDemand=[];
  await loadHomeConnection({...connection('xtream'),onDemand:true},async path=>{onDemand.push(new URL(path,'https://tesplay.test').searchParams.get('kind'));return {items:[]};},new AbortController().signal);
  assert.deepEqual(onDemand,['movie','series'],'with IPTV_ON_DEMAND the server offers them and Home previews them');
  const empty=await loadHomeConnection(connection('m3u'),()=>{throw Error('No unstarred channels should be requested');},new AbortController().signal);
  assert.deepEqual(empty.shelves,[]);assert.deepEqual(empty.issues,[]);
});
test('YouTube signed in on the screen shows the latest from your subscriptions on Home', async () => {
  const paths = [];
  const signedIn = { ...connection('youtube'), authMode: 'innertube', oauthAuthorized: true };
  const result = await loadHomeConnection(signedIn, async p => { paths.push(p); return { items: [item('New upload', 'video', 'youtube')], channelRows: [], basis: 'subscriptions' }; }, new AbortController().signal);
  assert.deepEqual(paths, ['/youtube/youtube/feed']);
  assert.equal(result.shelves.length, 1);
  assert.equal(result.shelves[0].title, 'YouTube · Latest from your subscriptions');
  assert.equal(result.shelves[0].items[0].title, 'New upload');
  assert.deepEqual(result.issues, []);
  const signedOut = await loadHomeConnection({ ...signedIn, oauthAuthorized: false }, () => { throw Error('Must not request the feed signed out'); }, new AbortController().signal);
  assert.deepEqual(signedOut, { shelves: [], issues: [] });
});
test('featured titles alternate providers and cannot become folder demos on an empty or failed library', async () => {
  const shelves = [{ connectionId: 'iptv', items: [item('folder', 'folder'), item('one'), item('two')] }, { connectionId: 'youtube', items: [item('upload', 'video', 'youtube')] }];
  assert.deepEqual(homeFeatures(shelves).map(i => i.id), ['one', 'upload', 'two']);
  assert.deepEqual(homeFeatures([]), []);
  const signedIn = { ...connection('youtube'), authMode: 'innertube', oauthAuthorized: true };
  const failed = await loadHomeConnection(signedIn, async () => { throw Error('Connection failed'); }, new AbortController().signal);
  assert.deepEqual(failed.shelves, []);
  assert.equal(failed.issues[0], 'Connection failed');
});
test('aborted home requests reject instead of publishing rows for the previous profile', async () => {
  const controller = new AbortController();
  await assert.rejects(loadHomeConnection({ ...connection('youtube'), authMode: 'innertube', oauthAuthorized: true }, async () => { controller.abort(); return { items: [item('old-profile')] }; }, controller.signal), { name: 'AbortError' });
});

const browserSource=ts.transpileModule(fs.readFileSync(new URL('../src/library-browser.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {librarySources}=await import('data:text/javascript;base64,'+Buffer.from(browserSource).toString('base64'));
test('shared library sources retain other connectors without mutating the connected accounts',()=>{
  const connections=['youtube','xtream','m3u','youtube'].map((type,index)=>connection(type,String(index)));
  assert.deepEqual(librarySources(connections).map(c=>c.type),['xtream','m3u']);
  assert.equal(connections.length,4);
  assert.deepEqual(librarySources(connections.filter(c=>c.type==='youtube')),[]);
});

test('six highlights balance three connectors and select their newest videos before older or live content',()=>{
 const shelves=['m3u','xtream','youtube'].map(connectionId=>({connectionId,items:[item('channel','live',connectionId),{...item('series container','series',connectionId),addedAt:'2026-10-01T00:00:00Z'},...Array.from({length:5},(_,i)=>({...item(`${connectionId}-${i}`,connectionId==='youtube'?'video':'movie',connectionId),addedAt:new Date(2026,0,i+1).toISOString()}))]}));
 const featured=homeFeatures(shelves);assert.equal(featured.length,6);
 for(const c of ['m3u','xtream','youtube'])assert.deepEqual(featured.filter(i=>i.connectionId===c).map(i=>i.id),[`${c}-4`,`${c}-3`]);
 assert.ok(featured.every(i=>!['live','series'].includes(i.type)));
});

test('a failed or partial background refresh keeps healthy shelves until replacement data arrives',async()=>{
 const {mergeHomeResult}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 const old={shelves:[{id:'movies',items:[item('old movie')]},{id:'shows',items:[item('old show')]}],issues:[]};
 assert.deepEqual(mergeHomeResult(old,{shelves:[],issues:['Provider unreachable']}).shelves,old.shelves);
 const updated={id:'movies',items:[item('new movie')]};
 const partial=mergeHomeResult(old,{shelves:[updated],issues:['Shows unavailable']});
 assert.deepEqual(partial.shelves,[updated,old.shelves[1]]);
 assert.deepEqual(mergeHomeResult(old,{shelves:[],issues:[]}).shelves,[]);
});

test('Home requests an explicit refresh only when instructed and prefers provided IPTV artwork',async()=>{
  for(const force of [false,true]){
    await loadHomeConnection(connection('xtream'),async path=>{
      const p=new URL(path,'https://tesplay.test').searchParams;
      assert.equal(p.get('refresh'),force?'1':null);assert.equal(p.get('artwork'),'prefer');
      return {items:[]};
    },new AbortController().signal,[],force);
  }
});
test('Home preview survives a reload, isolates identities and invalidates changed grants and stars',async()=>{
  const {readHomePreview,writeHomePreview}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  const values=new Map(),storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
  const c=connection('xtream'),result={shelves:[{id:'xtream:movie',title:'Films',connectionId:c.id,items:[item('Saved film','movie',c.id)]}],issues:[]};
  writeHomePreview('owner:profile',c,[],result,storage);
  assert.deepEqual(readHomePreview('owner:profile',c,[],storage),result);
  assert.equal(readHomePreview('other:profile',c,[],storage),undefined);
  assert.equal(readHomePreview('owner:profile',{...c,access:{kinds:['series']}},[],storage),undefined);
  assert.equal(readHomePreview('owner:profile',c,[{connectionId:c.id,id:'live:1',kind:'category'}],storage),undefined);
  writeHomePreview('owner:profile',c,[],{shelves:[],issues:['524']},storage);
  assert.deepEqual(readHomePreview('owner:profile',c,[],storage),result);
  values.set('tesplay:home:v1:owner:profile','invalid JSON');assert.equal(readHomePreview('owner:profile',c,[],storage),undefined);
});
