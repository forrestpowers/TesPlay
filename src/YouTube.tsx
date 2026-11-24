import { RefreshButton } from "./components";
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Search, Play, Users, Clock, ListVideo, Sparkles, ChevronLeft, ArrowRight, Star, X, House } from 'lucide-react';
import { api, ApiError, errorMessage, youtubeId } from './api';
import { Busy, Card, Empty, Row, YouTubeLogo } from './components';
import type { Connection, Library, MediaItem, Starred } from './types';
import { itemKey } from './types';
import { filterLibraryForYouTubeVisibility, filterYouTubeItems, filterYouTubeShelves } from './youtube-visibility';
import YouTubeSignIn from './YouTubeSignIn';
type Pane = 'home' | 'suggestions' | 'subscriptions' | 'playlists' | 'history' | 'search';
type Collection = { id:string;title:string;thumbnail?:string;videoCount?:number;subtitle?:string };
type ChannelRow = {id:string;title:string;items:MediaItem[]};
type Result = {items?:MediaItem[];channels?:Collection[];playlists?:Collection[];channelRows?:ChannelRow[];nextPageToken?:string|null;nextOffset?:number|null;partial?:boolean;total?:number;totalChannels?:number};
const tabsFor=(innertube:boolean)=>[...(innertube?[['home','Home',House]] as const:[]),['suggestions',innertube?'Latest':'For you',Sparkles],['subscriptions','Subscriptions',Users],['playlists','Playlists',ListVideo],['history','Watched',Clock],['search','Search',Search]] as const;
export default function YouTubeHub({connections,library:rawLibrary,hideYouTubeShorts = false,onOpen,onFavorite,onConnect,onStar,onClearQueue,onRemoveQueue,initialConnectionId,initialChannel,canManage=false,onReloadConnections}: {
  connections:Connection[];library:Library;hideYouTubeShorts?:boolean;onOpen:(item:MediaItem)=>void;onFavorite:(item:MediaItem)=>void;onConnect:()=>void;onStar:(value:Starred)=>void;onClearQueue:()=>void;onRemoveQueue:(item:MediaItem)=>void;initialConnectionId?:string;initialChannel?:Collection;canManage?:boolean;onReloadConnections?:()=>Promise<void>;
}) {
  const library=useMemo(()=>filterLibraryForYouTubeVisibility(rawLibrary,hideYouTubeShorts,connections),[rawLibrary,hideYouTubeShorts,connections]);
  const accounts=connections.filter(c=>c.type==='youtube');
  const [accountId,setAccountId]=useState(initialConnectionId||accounts[0]?.id||'');
  const c=accounts.find(a=>a.id===accountId)||accounts[0];
  const innertube=c?.authMode==='innertube'||!c;
  // No YouTube connection yet, or an on-screen one that is not signed in: show the phone sign-in page.
  const showSignIn=!c||(c.authMode==='innertube'&&!c.oauthAuthorized);
  const createConnection=useCallback(async()=>{const r=await api<{connection:Connection}>('/connections',{type:'youtube',name:'YouTube',config:{authMode:'innertube'}});await onReloadConnections?.();return r.connection;},[onReloadConnections]);
  const signedIn=useCallback(async()=>{await onReloadConnections?.();},[onReloadConnections]);
  const tabs=tabsFor(innertube);
  const [pane,setPane]=useState<Pane>(initialChannel?'subscriptions':innertube?'home':'suggestions');
  const [selection,setSelection]=useState<(Collection&{kind:'channel'|'playlist'})|null>(initialChannel?{...initialChannel,kind:'channel'}:null);
  const [draft,setDraft]=useState(''),[query,setQuery]=useState(''),[cursor,setCursor]=useState<{token?:string;offset?:number}|null>(null),[next,setNext]=useState<typeof cursor>(null);
  const [items,setItems]=useState<MediaItem[]>([]),[collections,setCollections]=useState<Collection[]>([]),[channelRows,setChannelRows]=useState<ChannelRow[]>([]);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[partial,setPartial]=useState(false),[total,setTotal]=useState<number|null>(null),[refresh,setRefresh]=useState(0);
  const [reconnect,setReconnect]=useState(false);
  const personal=(c?.authMode==='oauth'||c?.authMode==='innertube')&&c.oauthAuthorized;
  const accountHistory=innertube&&personal;
  const needsGoogle=!selection&&(['home','suggestions','subscriptions','playlists'].includes(pane)||innertube&&pane!=='history')&&!personal;
  const rawHistory=rawLibrary.progress.filter(p=>accounts.some(a=>a.id===p.item.connectionId));
  const history=library.progress.filter(p=>accounts.some(a=>a.id===p.item.connectionId));
  const queue=library.queue||[],queued=new Set(queue.map(itemKey));
  const starred=(id:string)=>library.stars?.some(s=>s.connectionId===c?.id&&s.kind==='channel'&&s.id===id)||false;
  const starredKey=(library.stars||[]).filter(s=>s.connectionId===c?.id&&s.kind==='channel').map(s=>s.id).join(',');
  const progress=new Map(history.map(p=>[itemKey(p.item),p.duration?p.seconds/p.duration*100:0]));
  useEffect(()=>{if(initialChannel){setPane('subscriptions');setSelection({...initialChannel,kind:'channel'});setCursor(null);}},[initialChannel]);
  useEffect(()=>{
    const controller=new AbortController();
    if(!cursor){setItems([]);setCollections([]);setChannelRows([]);setTotal(null);}setError('');setReconnect(false);setPartial(false);setNext(null);
    if(!c||(pane==='history'&&!accountHistory)||needsGoogle||(pane==='search'&&!query&&!selection)){setBusy(false);return()=>controller.abort();}
    const params=new URLSearchParams();if(cursor?.token)params.set('pageToken',cursor.token);if(cursor?.offset!==undefined)params.set('offset',String(cursor.offset));if(pane==='search')params.set('q',query);
    const path=selection?`${selection.kind}/${encodeURIComponent(selection.id)}/videos`:{home:'home',suggestions:'feed',subscriptions:'subscriptions',playlists:'playlists',search:'search',history:'history'}[pane];
    setBusy(true);
    void api<Result>(`/youtube/${c.id}/${path}?${params}`,undefined,undefined,controller.signal).then(r=>{
      if(controller.signal.aborted)return;
      setItems(previous=>[...new Map([...(cursor?previous:[]),...(r.items||[])].map(i=>[i.id,i])).values()]);
      setCollections(previous=>[...new Map([...(cursor?previous:[]),...(r.channels||r.playlists||[])].map(i=>[i.id,i])).values()]);
      setChannelRows(previous=>[...new Map([...(cursor?previous:[]),...(r.channelRows||[])].map(row=>[row.id,row])).values()]);
      setNext(r.nextPageToken?{token:r.nextPageToken}:r.nextOffset!=null?{offset:r.nextOffset}:null);setTotal(r.total??r.totalChannels??null);setPartial(!!r.partial);
    }).catch(e=>{if(!controller.signal.aborted){setError(errorMessage(e));setReconnect(e instanceof ApiError&&e.status===409&&c.authMode==='oauth');}}).finally(()=>{if(!controller.signal.aborted)setBusy(false);});
    return()=>controller.abort();
  },[c?.id,c?.authMode,c?.oauthAuthorized,pane,selection?.id,selection?.kind,query,cursor,refresh,needsGoogle,starredKey,accountHistory]);
  useEffect(()=>{if(pane==='home'&&!innertube)setPane('suggestions');},[pane,innertube]);
  const changePane=(value:Pane)=>{setPane(value);setSelection(null);setCursor(null);};
  const choose=(value:Collection,kind:'channel'|'playlist'=pane==='playlists'?'playlist':'channel')=>{setSelection({...value,kind});setCursor(null);};
  const search=(e:FormEvent)=>{e.preventDefault();const id=youtubeId(draft);if(id&&c){onOpen({id,title:'YouTube video',type:'video',source:'YouTube',providerType:'youtube',connectionId:c.id});return;}setSelection(null);setCursor(null);setQuery(draft.trim());setPane('search');};
  const unfiltered=pane==='history'&&!selection&&!accountHistory?rawHistory.map(p=>p.item):items;
  const visible=filterYouTubeItems(unfiltered,hideYouTubeShorts,connections,rawLibrary.progress),visibleRows=filterYouTubeShelves(channelRows,hideYouTubeShorts,connections,rawLibrary.progress);
  const ordered=[...collections].sort((a,b)=>pane==='subscriptions'?Number(starred(b.id))-Number(starred(a.id)):0);
  if(showSignIn)return <section className="page-section youtube-hub"><YouTubeSignIn connection={c} canManage={canManage} onSignedIn={signedIn} onCreateConnection={createConnection}/></section>;
  return <section className="page-section youtube-hub">
    <div className="page-heading"><div><span className="eyebrow"><YouTubeLogo/>YOUR YOUTUBE</span><h1>Your channels. Your next watch.</h1><p>Star the channels you love. Build a playlist for your next break.</p></div><div className="youtube-account">{accounts.length>1&&<select aria-label="YouTube account" value={c?.id||''} onChange={e=>{setAccountId(e.target.value);setSelection(null);setCursor(null);}}>{accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select>}<button className="button ghost small" onClick={onConnect}>{personal?'Connections':'Connect Google'}<ArrowRight size={15}/></button></div></div>
    <form className="inline-search youtube-hub-search" onSubmit={search}><Search size={20}/><input aria-label="Search YouTube or paste a video link" placeholder="Search YouTube or paste a video link…" value={draft} onChange={e=>setDraft(e.target.value)}/><button className="button primary small">Search<ArrowRight size={16}/></button></form>
    <div className="youtube-tabs" aria-label="YouTube sections">{tabs.map(([value,label,Icon])=><button key={value} className={pane===value?'selected':''} aria-pressed={pane===value} onClick={()=>changePane(value)}><Icon size={17}/>{label}</button>)}</div>
    {selection&&<div className="youtube-collection-heading"><button className="text-button" onClick={()=>{setSelection(null);setCursor(null);}}><ChevronLeft size={18}/>Back to {pane==='playlists'?'playlists':'channels'}</button><h2>{selection.title}</h2></div>}
    {pane==='playlists'&&!selection&&<section className="watch-playlist"><div className="section-heading"><div><h2>Watch playlist</h2><p>{queue.length} videos · saved to this profile</p></div><div className="row-actions">{queue.length>0&&<><button className="text-button" onClick={onClearQueue}>Clear</button><button className="button primary small" onClick={()=>onOpen(queue[0])}><Play size={17} fill="currentColor"/>Play all</button></>}</div></div>{queue.length?<ol className="queue-list">{queue.map((item,index)=><li key={itemKey(item)}><span>{index+1}</span><button className="queue-video" onClick={()=>onOpen(item)}>{item.poster&&<img src={item.poster} alt="" loading="lazy"/>}<span><strong>{item.title}</strong><small>{item.subtitle||item.categoryLabel||'YouTube'}</small></span><Play size={17}/></button><button className="icon-button" aria-label={`Remove ${item.title} from playlist`} onClick={()=>onRemoveQueue(item)}><X size={17}/></button></li>)}</ol>:<p className="form-help">Use the playlist button on any video to add it here. Videos play in this order.</p>}</section>}
    {pane==='home'&&!selection&&personal&&<div className="youtube-feed-heading"><div><h2>Your YouTube Home</h2><p>The same recommendations YouTube shows your account.</p></div><RefreshButton label="Refresh YouTube Home" disabled={busy} onRefresh={()=>{setCursor(null);setRefresh(n=>n+1);}}/></div>}
    {pane==='suggestions'&&!selection&&personal&&<div className="youtube-feed-heading"><div><h2>{innertube?'Latest from your subscriptions':'Fresh from your starred channels'}</h2><p>{innertube?'Newest uploads across every channel you follow.':'Each channel’s latest upload comes first.'}</p></div><RefreshButton label="Refresh YouTube feed" disabled={busy} onRefresh={()=>{setCursor(null);setRefresh(n=>n+1);}}/></div>}
    {pane==='history'&&!selection&&accountHistory&&<div className="youtube-feed-heading"><div><h2>Your YouTube watch history</h2><p>From your Google account, newest first.</p></div><RefreshButton label="Refresh watch history" disabled={busy} onRefresh={()=>{setCursor(null);setRefresh(n=>n+1);}}/></div>}
    {pane==='subscriptions'&&!selection&&personal&&<p className="youtube-count">{total!=null?`${collections.length} of ${total} subscribed channels`:'Your subscribed channels'}{innertube?'':' · Star a channel to include it in For you and Home.'}</p>}
    {error&&<div className="form-error" role="alert">{error}<button className="text-button" onClick={reconnect?onConnect:()=>setRefresh(n=>n+1)}>{reconnect?'Reconnect Google':'Try again'}</button></div>}
    {partial&&<p className="form-help" role="status">Some channels could not load. Your other channels are shown below.</p>}
    {!c&&pane!=='history'?<Empty icon={<YouTubeLogo/>} title="Bring your YouTube here" action={<button className="button primary" onClick={onConnect}>Connections</button>}>Connect YouTube to start watching.</Empty>:needsGoogle?<Empty icon={<Users size={34}/>} title={innertube?'Sign in with Google on this screen':'Connect Google for your channels'} action={<button className="button primary" onClick={onConnect}>Connections<ArrowRight size={17}/></button>}>{innertube?'Open Connections, edit this YouTube connection and enter the short code on your phone. Your Home feed, subscriptions, history and search then appear here.':'Your Google connection gives TesPlay access to your subscriptions and existing playlists.'}</Empty>:<>
      {pane==='search'&&!selection&&collections.length>0&&<h2 className="search-section-title">Channels</h2>}
      {collections.length>0&&!selection&&<div className="youtube-channels">{ordered.map(value=><div className="youtube-channel-entry" key={value.id}><button className={`youtube-channel ${pane==='playlists'?'youtube-playlist':''}`} onClick={()=>choose(value)}>{value.thumbnail?<img src={value.thumbnail} alt="" loading="lazy"/>:<span className="youtube-channel-fallback"><Users/></span>}<span><strong>{value.title}</strong><small>{pane==='search'?'Browse channel':value.subtitle||`${value.videoCount||0} videos`}</small></span><Play size={17}/></button>{pane==='subscriptions'&&c&&<button className={`icon-button channel-star ${starred(value.id)?'selected':''}`} aria-label={`${starred(value.id)?'Unstar':'Star'} ${value.title}`} aria-pressed={starred(value.id)} onClick={()=>onStar({connectionId:c.id,kind:'channel',id:value.id,title:value.title})}><Star size={18} fill={starred(value.id)?'currentColor':'none'}/></button>}</div>)}</div>}
      {pane==='search'&&!selection&&visible.length>0&&<h2 className="search-section-title">Videos</h2>}
      {pane==='suggestions'&&!selection&&!innertube?visibleRows.map(row=><Row key={row.id} title={row.title} items={row.items} onOpen={onOpen} onFavorite={onFavorite} isSaved={i=>queued.has(itemKey(i))} progress={i=>progress.get(itemKey(i))} more={()=>choose(row,'channel')}/>):visible.length>0&&<div className="catalog-grid youtube-video-grid">{visible.map(item=><Card key={itemKey(item)} item={item} onOpen={onOpen} onFavorite={onFavorite} saved={queued.has(itemKey(item))} progress={progress.get(itemKey(item))}/>)}</div>}
      {busy&&<Busy label="Loading your YouTube…"/>}
      {!busy&&!error&&visible.length===0&&collections.length===0&&<Empty icon={<YouTubeLogo/>} title={pane==='home'?'Nothing on Home yet':pane==='suggestions'&&!innertube?'Make this space yours':pane==='history'?'Your next watch starts here':'Nothing here yet'} action={pane==='suggestions'&&!innertube?<button className="button primary" onClick={()=>changePane('subscriptions')}><Star size={17}/>Star your channels</button>:undefined}>{hideYouTubeShorts&&unfiltered.length?'Short videos are hidden. Change this in Settings or load more videos.':pane==='home'?'YouTube has no recommendations for this account yet. Watch a few videos and refresh.':pane==='suggestions'?innertube?'Subscribe to channels on YouTube to see their newest uploads here.':'Star subscriptions to see their latest videos here and on Home.':pane==='history'?accountHistory?'Your YouTube account has no watch history yet, or history is paused.':'Videos you watch in TesPlay appear here.':'Search for a video or choose another channel.'}</Empty>}
      {next&&<div className="load-more"><button className="button ghost" disabled={busy} onClick={()=>setCursor(next)}>Load more<ArrowRight size={16}/></button></div>}
    </>}
  </section>;
}
