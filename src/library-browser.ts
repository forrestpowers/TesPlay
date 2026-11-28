import type { Connection, MediaItem } from './types';
export type CatalogResult = { items: MediaItem[]; categories?: {id:string;name:string}[]; hasMore?:boolean; nextPageToken?:string };
export type LibraryMode = 'movies'|'series'|'live'|'catalog';

/** YouTube is browsed in its dedicated hub, outside the shared TV and film libraries. */
export function librarySources(connections:Connection[]):Connection[] {
  return connections.filter(c=>c.type!=='youtube');
}
