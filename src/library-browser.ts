import type { Connection, MediaItem } from './types';
export type CatalogResult = { items: MediaItem[]; categories?: {id:string;name:string}[]; hasMore?:boolean; nextPageToken?:string };
export type LibraryShelf = {id:string;title:string;connection:Connection;items:MediaItem[];parent?:MediaItem;kind:string;category?:string};
export type LibraryMode = 'movies'|'series'|'live'|'catalog';
type Request = <T>(path:string,signal:AbortSignal)=>Promise<T>;

/** YouTube is browsed in its dedicated hub, outside the shared TV and film libraries. */
export function librarySources(connections:Connection[]):Connection[] {
  return connections.filter(c=>c.type!=='youtube');
}

/** Preserve each source's hierarchy instead of asking its root for IPTV kinds. */
export async function unifiedShelves(c:Connection,mode:LibraryMode,request:Request,signal:AbortSignal,force=false):Promise<LibraryShelf[]> {
  if(c.type==='youtube') return [];
  // IPTV movies and series only when the server offers them; most are H.265.
  if(['xtream','m3u'].includes(c.type) && mode!=='live' && !c.onDemand) return [];
  // IPTV offers live channels only; its movies and series are mostly H.265.
  if(['xtream','m3u'].includes(c.type) && mode!=='live') return [];
  const kind=mode==='series'?'series':mode==='live'?'live':'movie';
  if(c.access&&!c.access.kinds.includes(kind)) return [];
  if(['xtream','m3u'].includes(c.type) && Array.isArray(c.loadedCategories) && !c.loadedCategories.some(id=>c.type==='m3u'||id.startsWith(`${kind}:`))) return [];
  const catalog=(parentId='',wanted=kind)=>request<CatalogResult>(`/catalog?${new URLSearchParams({connectionId:c.id,kind:wanted,parentId,limit:'12',...(force?{refresh:'1'}:{})})}`,signal);
  const shelf=(id:string,title:string,items:MediaItem[],parent?:MediaItem,wanted=kind):LibraryShelf=>({id:`${c.id}:${id}`,title,connection:c,items,parent,kind:wanted});
  if(c.type==='xtream' || c.type==='m3u' && kind==='live') return [shelf(kind,c.name,(await catalog()).items)];
  return [];
}
