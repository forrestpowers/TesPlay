import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source=ts.transpileModule(fs.readFileSync(new URL('../src/global-search.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {searchConnection}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
test('global YouTube search includes channels and videos and preserves its next page',async()=>{
 const rows=await searchConnection({id:'yt',name:'API',type:'youtube'},'A & B',async path=>{assert.equal(path,'/youtube/yt/search?q=A%20%26%20B');return {items:[{id:'abcdefghijk',type:'video'}],channels:[{id:'UCmatch',title:'A & B'}],nextPageToken:'page two'};},new AbortController().signal);
 assert.equal(rows[0].title,'YouTube');assert.equal(rows[0].channels[0].title,'A & B');assert.equal(rows[0].nextPageToken,'page two');
});
