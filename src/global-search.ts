import type {Connection,MediaItem} from './types';
export type SearchChannel={id:string;title:string;thumbnail?:string};
export type SearchGroup={id:string;title:string;connection:Connection;items:MediaItem[];channels?:SearchChannel[];path:string;hasMore?:boolean;nextPageToken?:string|null;page:number;error?:string};
type Result={items:MediaItem[];channels?:SearchChannel[];hasMore?:boolean;nextPageToken?:string|null};
type Request=<T>(path:string,signal:AbortSignal)=>Promise<T>;
export async function searchConnection(c:Connection,query:string,request:Request,signal:AbortSignal):Promise<SearchGroup[]> {
 const path=`/catalog?${new URLSearchParams({connectionId:c.id,kind:'all',q:query,limit:'60',recursive:'1'})}`;
 const source=c.type==='youtube'?`/youtube/${c.id}/search?q=${encodeURIComponent(query)}`:path;
 return [{id:c.id,title:c.type==='youtube'?'YouTube':c.name,connection:c,...await request<Result>(source,signal),path:source,page:1}];
}
