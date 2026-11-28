import './home.css';
import { RefreshButton } from "./components";
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Plus, ArrowUpRight, Cable, ArrowUp, ArrowDown, Eye, EyeOff, LayoutList } from 'lucide-react';
import { api } from './api';
import { Busy, Card, Empty, Row, YouTubeLogo, isYouTubeItem } from './components';
import { services } from './catalog';
import { itemKey } from './types';
import type { Connection, Library, MediaItem } from './types';
import { bundleIptvHomeShelves, loadHomeConnection, mergeHomeResult, readHomePreview, writeHomePreview } from './home-library';
import { arrangeHomeSections, moveHomeSection, persistHomeOrder, toggleHomeSection, type HomeLayout } from './home-layout';
import type { HomeCatalog, HomeResult, HomeShelf } from './home-library';
import { filterLibraryForYouTubeVisibility, filterYouTubeShelves } from './youtube-visibility';
export default function Home({ cacheIdentity, connections, library: rawLibrary, hideYouTubeShorts = false, signedIn, query, connectionsReady, connectionsError, onReloadConnections, canManage, onOpen, onFavorite, onBrowse, onConnect, onNavigate, homeLayout, onHomeLayout }: {
  cacheIdentity:string; connections: Connection[]; library: Library; hideYouTubeShorts?: boolean; signedIn: boolean; query: string; connectionsReady: boolean; connectionsError: string; onReloadConnections: () => Promise<void>; canManage: boolean;
  onOpen: (item: MediaItem) => void; onFavorite: (item: MediaItem) => void; onDetails: (item: MediaItem) => void;
  onBrowse: (c: Connection, parent?: MediaItem, kind?: string, channel?: {id:string;title:string}, category?:string) => void; onConnect: (type?: string) => void;
  onNavigate: (view: 'connections' | 'movies' | 'apps' | 'list') => void;
  /** The account's saved home arrangement; saving null restores the default. */
  homeLayout?: HomeLayout | null; onHomeLayout?: (layout: HomeLayout | null) => Promise<void>;
}) {
  const library = useMemo(() => filterLibraryForYouTubeVisibility(rawLibrary, hideYouTubeShorts, connections), [rawLibrary, hideYouTubeShorts, connections]);
  const [results, setResults] = useState<Record<string, HomeResult>>({});
  const [pending, setPending] = useState<string[]>([]), [refresh, setRefresh] = useState(0);
  // Customize home: a draft arrangement while editing, saved to the account on Done.
  const [editing, setEditing] = useState<HomeLayout | null>(null), [savingLayout, setSavingLayout] = useState(false);
  const lastRefresh=useRef(refresh);
  const starredChannelsKey=(library.stars||[]).map(s=>`${s.connectionId}:${s.id}`).join(',');
  const connected = signedIn && connections.length > 0;
  useEffect(() => {
    const controller = new AbortController();
    if (!connected) { setResults({}); setPending([]); return () => controller.abort(); }
    const force=refresh!==lastRefresh.current;lastRefresh.current=refresh;
    const cachedResults:Record<string,HomeResult>={};
    for(const c of connections)try{const value=readHomePreview(cacheIdentity,c,library.stars||[],sessionStorage);if(value)cachedResults[c.id]=value;}catch{/* Storage may be disabled. */}
    setResults(previous => Object.fromEntries(connections.filter(c => cachedResults[c.id]||force&&previous[c.id]).map(c => [c.id, cachedResults[c.id]||previous[c.id]])));
    const requested=connections.filter(c=>force||!cachedResults[c.id]);
    setPending(requested.map(c => c.id));
    for (const c of requested) void loadHomeConnection(c, (path, signal) => api<HomeCatalog>(path, undefined, undefined, signal), controller.signal, library.stars || [], force)
      .then(result => { if (!controller.signal.aborted) setResults(previous => {
        const merged=mergeHomeResult(previous[c.id],result);
        try{writeHomePreview(cacheIdentity,c,library.stars||[],merged,sessionStorage);}catch{/* Storage may be disabled. */}
        return { ...previous, [c.id]: merged };
      }); })
      .finally(() => { if (!controller.signal.aborted) setPending(previous => previous.filter(id => id !== c.id)); })
      .catch(() => { /* An aborted request belongs to the previous home/profile. */ });
    return () => controller.abort();
  }, [cacheIdentity, connected, connections, refresh, starredChannelsKey]);
  const visibleResults = useMemo(() => Object.fromEntries(Object.entries(results).map(([id, result]) => [id, {
    ...result, shelves: filterYouTubeShelves(result.shelves, hideYouTubeShorts, connections, rawLibrary.progress),
  }])), [results, hideYouTubeShorts, connections, rawLibrary.progress]);
  const shelves = useMemo(() => bundleIptvHomeShelves(connections.flatMap(c => visibleResults[c.id]?.shelves || []),connections), [connections, visibleResults]);
  const favorites = new Set([...library.favorites,...(library.queue||[])].map(itemKey));
  const progress = new Map(library.progress.map(p => [itemKey(p.item), p.duration ? p.seconds / p.duration * 100 : 0]));
  const continuing = library.progress.filter(p => p.duration > 0 && p.seconds > 5 && p.seconds / p.duration < 0.97).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // Continue watching is split by source: the IPTV provider, YouTube, and everything else.
  const iptvConnections = connections.filter(c => c.type === 'xtream' || c.type === 'm3u');
  const iptvIds = new Set(iptvConnections.map(c => c.id));
  const continueGroups = [
    { id: 'continue:iptv', title: `Continue watching · ${iptvConnections.length === 1 ? iptvConnections[0].name : 'IPTV'}`, items: continuing.filter(p => !isYouTubeItem(p.item) && iptvIds.has(p.item.connectionId || '')) },
    { id: 'continue:youtube', title: 'Continue watching · YouTube', items: continuing.filter(p => isYouTubeItem(p.item)) },
    { id: 'continue:other', title: 'Continue watching', items: continuing.filter(p => !isYouTubeItem(p.item) && !iptvIds.has(p.item.connectionId || '')) },
  ].map(group => ({ ...group, items: group.items.slice(0, 12) }));
  const viewAll = (shelf: HomeShelf) => { const c = connections.find(c => c.id === shelf.connectionId); if (c) onBrowse(c, shelf.parent, shelf.kind, shelf.channel, shelf.category); };
  const searchItems = [...new Map([...(connected ? shelves.flatMap(s => s.items) : []), ...library.favorites, ...library.progress.map(p => p.item)].map(i => [itemKey(i), i])).values()]
    .filter(i => `${i.title} ${i.categoryLabel || ''} ${i.source} ${i.subtitle || ''}`.toLowerCase().includes(query.toLowerCase()));
  // Every part of the home screen is a section the account can move or hide.
  const sections: { id: string; title: string; node: React.ReactNode }[] = [
    { id: 'libraries', title: 'Your libraries', node: <section className="worlds">
      <div className="section-heading"><h2>Your libraries</h2><div className="row-actions">{connected && <RefreshButton label="Refresh home libraries" disabled={pending.length > 0} onRefresh={() => setRefresh(value => value + 1)} />}<button className="text-button" onClick={() => onNavigate('connections')}>{canManage ? 'Manage connections' : 'Shared connections'} <ArrowUpRight size={16} /></button></div></div>
      <div className="service-rail">{services.filter(s => canManage || connections.some(c => c.type === s.id || s.id === 'xtream' && c.type === 'm3u')).map(s => {
        const c = connections.find(c => c.type === s.id || (s.id === 'xtream' && c.type === 'm3u'));
        return <button key={s.id} className={`service-tile service-${s.id}`} onClick={() => s.id === 'youtube' ? onNavigate('apps') : c ? onBrowse(c) : onConnect(s.id)}>
          <span className={`service-logo ${s.id}`} style={{ color: s.color }}>{s.id === 'youtube' ? <YouTubeLogo /> : s.letters}</span>
          <span className="service-copy"><span className="service-label">{s.name}</span><span className="service-state">{c ? 'Connected' : s.id === 'youtube' ? 'Browse videos' : 'Connect'}</span></span>
          {c ? <Check size={16} /> : <ArrowUpRight size={16} />}
        </button>;
      })}</div>
    </section> },
    ...continueGroups.filter(group => group.items.length).map(group => ({ id: group.id, title: group.title, node: <Row presentation="continue" title={group.title} items={group.items.map(p => p.item)} onOpen={onOpen} onFavorite={onFavorite} isSaved={i => favorites.has(itemKey(i))} progress={i => progress.get(itemKey(i))} /> })),
    ...(connected ? shelves.filter(s => s.items.length).map(shelf => ({ id: `shelf:${shelf.id}`, title: shelf.title, node: <Row title={shelf.title} items={shelf.items} onOpen={onOpen} onFavorite={onFavorite} isSaved={i => favorites.has(itemKey(i))} progress={i => progress.get(itemKey(i))} more={() => viewAll(shelf)} /> })) : []),
    ...(library.favorites.length ? [{ id: 'my-list', title: 'My list', node: <Row title="My list" items={library.favorites} onOpen={onOpen} onFavorite={onFavorite} isSaved={i => favorites.has(itemKey(i))} more={() => onNavigate('list')} /> }] : []),
    { id: 'youtube-card', title: 'YouTube: your channels', node: <div className="discovery-row"><button onClick={() => onNavigate('apps')} className="discovery-card"><YouTubeLogo /><div><span className="small-caps">YouTube</span><h3>Your channels, on this screen</h3><p>Browse subscriptions or play a video link</p></div><ArrowUpRight size={20} /></button></div> },
  ];
  const byId = new Map(sections.map(section => [section.id, section]));
  const arrangement = editing ?? homeLayout;
  const order = arrangeHomeSections(sections.map(section => section.id), arrangement);
  const hidden = new Set((arrangement?.hidden || []).filter(id => byId.has(id)));
  // Edits keep sections that are absent right now (and their hidden state) in the saved arrangement.
  const edit = (present: string[], hiddenIds: string[]) => setEditing({ order: persistHomeOrder(arrangement?.order, present), hidden: hiddenIds });
  if (signedIn && (!connectionsReady || (connectionsError && !connections.length))) return <section className="page-section home-loading">
    <span className="eyebrow">Your library</span><h1>Your collection, together</h1>
    {connectionsError ? <div className="home-source-status" role="alert"><div><strong>Your connections could not load</strong><p>{connectionsError}</p></div><button className="button ghost" onClick={() => void onReloadConnections().catch(() => {})}>Try again</button></div> : <Busy label="Loading your connections…" />}
  </section>;
  return <>
    {query ? <section className="page-section">
      <div className="page-heading"><div><span className="eyebrow">Your library</span><h1>Results for “{query}”</h1><p>Search within a connected library for its complete collection</p></div></div>
      {pending.length > 0 && <Busy label="Loading your connected libraries…" />}
      {searchItems.length ? <div className="catalog-grid">{searchItems.map(item => <Card key={itemKey(item)} item={item} onOpen={onOpen} onFavorite={onFavorite} saved={favorites.has(itemKey(item))} progress={progress.get(itemKey(item))} />)}</div> : !pending.length && <Empty title="No matches in your home collection">Browse a connected library to search all its titles.</Empty>}
    </section> : <>
      <div className="home-content">
        <div className="home-toolbar">
          <h1>{connections.length ? 'Home' : 'Your libraries. One screen.'}</h1>
          {signedIn && connections.length > 0 && onHomeLayout && (editing
            ? <div className="home-toolbar-actions">
                <button className="button ghost small" disabled={savingLayout} onClick={() => { setSavingLayout(true); void onHomeLayout(null).finally(() => { setSavingLayout(false); setEditing(null); }); }}>Reset to default</button>
                <button className="button primary small" disabled={savingLayout} onClick={() => { setSavingLayout(true); void onHomeLayout(editing).finally(() => { setSavingLayout(false); setEditing(null); }); }}>{savingLayout ? 'Saving…' : 'Done'}</button>
              </div>
            : <button className="button ghost small" onClick={() => edit(order, arrangement?.hidden || [])}><LayoutList size={16} />Customize home</button>)}
        </div>
        {editing && <p className="home-edit-help">Move sections up or down, or hide the ones you do not use. Your arrangement is saved to your account and used on every screen.</p>}
        {!connections.length && pending.length === 0 && <p className="home-intro">{canManage ? 'Bring your channels and videos into TesPlay. Start with a library below.' : 'Your server owner can share connections with your account.'}</p>}
        {/* Connection notices on Home are for IPTV and other libraries; YouTube is browsed from its own page. */}
        {connected ? connections.filter(c => c.type !== 'youtube').map(c => <div key={c.id}>
          {visibleResults[c.id]?.issues.map((issue, index) => <div className="home-source-status" role="status" key={index}><div><strong>{c.type === 'youtube' ? 'YouTube' : c.name}</strong><p>{issue}</p></div><button className="text-button" onClick={() => onBrowse(c)}>Open connection <ArrowUpRight size={16} /></button></div>)}
          {!pending.includes(c.id) && visibleResults[c.id] && !visibleResults[c.id].issues.length && !visibleResults[c.id].shelves.some(s => s.items.length) && <div className="home-source-status"><div><strong>{c.type === 'youtube' ? 'YouTube' : c.name}</strong><p>{hideYouTubeShorts && results[c.id]?.shelves.some(s => s.items.length) ? 'Short videos are hidden. Change this in Settings or browse another library.' : c.type === 'youtube' ? 'Star subscriptions in YouTube to show their latest uploads here.' : 'No titles in this preview yet.'}</p></div><button className="text-button" onClick={() => onBrowse(c)}>Browse library <ArrowUpRight size={16} /></button></div>}
        </div>) : canManage ? null : <Empty title="No libraries shared yet">Your server owner can share connections with your account.</Empty>}
        {pending.length > 0 && !shelves.some(s => s.items.length) && <Busy label="Loading your collection…" />}
        {editing ? <ol className="home-arrange" aria-label="Home sections">{order.map((id, index) => {
          const section = byId.get(id)!, isHidden = hidden.has(id);
          return <li key={id} className={isHidden ? 'is-hidden' : ''}>
            <span className="home-arrange-title">{section.title}{isHidden && <small>Hidden</small>}</span>
            <span className="home-arrange-actions">
              <button className="icon-button" aria-label={`Move ${section.title} up`} disabled={index === 0} onClick={() => edit(moveHomeSection(order, id, -1), editing.hidden)}><ArrowUp size={20} /></button>
              <button className="icon-button" aria-label={`Move ${section.title} down`} disabled={index === order.length - 1} onClick={() => edit(moveHomeSection(order, id, 1), editing.hidden)}><ArrowDown size={20} /></button>
              <button className="button ghost small" aria-label={`${isHidden ? 'Show' : 'Hide'} ${section.title}`} onClick={() => edit(order, toggleHomeSection(editing.hidden, id))}>{isHidden ? <><Eye size={16} />Show</> : <><EyeOff size={16} />Hide</>}</button>
            </span>
          </li>;
        })}</ol> : order.filter(id => !hidden.has(id)).map(id => <div key={id}>{byId.get(id)!.node}</div>)}
        {canManage && !connections.length && <div className="connect-banner"><div><Cable size={24} /><div><h3>Add your first library</h3><p>Connect IPTV or YouTube</p></div></div><button className="button ghost" onClick={() => onNavigate('connections')}>Add a connection <Plus size={18} /></button></div>}
      </div>
    </>}
  </>;
}
