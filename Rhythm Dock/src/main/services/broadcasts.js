'use strict';
const crypto=require('node:crypto');
const remote=require('./remote-cache');
function decode(text) {
    return String(text||'').replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/,'$1').replace(/<[^>]*>/g,'')
        .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'")
        .replace(/&#(x[\da-f]+|\d+);/gi,(_,n)=>{const c=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);return c>0&&c<=0x10ffff?String.fromCodePoint(c):'';}).trim().slice(0,500);
}
function parseFeed(xml,sourceUrl) {
    if(typeof xml!=='string'||Buffer.byteLength(xml)>1024*1024||/<!DOCTYPE|<!ENTITY/i.test(xml))throw new Error('Use an RSS or Atom feed up to 1 MB, without document entities.');
    const value=(body,name)=>decode(new RegExp('<'+name+'(?:\\s[^>]*)?>([\\s\\S]*?)</'+name+'>','i').exec(body)?.[1]);
    const attr=(text,name)=>new RegExp('\\b'+name+'\\s*=\\s*["\']([^"\']+)["\']','i').exec(text)?.[1];
    const blocks=[...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].slice(0,100);
    if(!/<(?:rss|feed)(?:\s|>)/i.test(xml))throw new Error('This address is not an RSS or Atom feed.');
    const episodes=[];
    for(const [,kind,body] of blocks){
        const enclosures=[...body.matchAll(/<(?:enclosure|link)\b[^>]*>/gi)];
        const match=enclosures.find(([tag])=>kind.toLowerCase()==='item'||attr(tag,'rel')==='enclosure');
        if(!match)continue;
        const tag=match[0],link=decode(attr(tag,'url')||attr(tag,'href'));if(!link)continue;
        try{const url=remote.validateUrl(new URL(link,sourceUrl).href).href;
            const mime=attr(tag,'type')||'';if(mime&&!/^audio\//.test(mime))continue;
            episodes.push({id:crypto.createHash('sha256').update(url).digest('hex').slice(0,20),url,title:value(body,'title')||'Episode',
                published:value(body,kind.toLowerCase()==='item'?'pubDate':'published'),description:value(body,'description')||value(body,'summary')});
        }catch(_) {/* Unsupported/private enclosure; other episodes remain usable. */}
    }
    const header=xml.split(/<(?:item|entry)\b/i)[0];return {title:value(header,'title')||'Podcast',url:sourceUrl,episodes};
}
async function feed(url,fetchImpl=fetch) {
    let address=remote.validateUrl(url),response;
    for(let i=0;i<4;i++){
        response=await fetchImpl(address,{redirect:'manual',signal:AbortSignal.timeout(12000)});
        if(![301,302,303,307,308].includes(response.status))break;
        const location=response.headers.get('location');await response.body?.cancel();address=remote.validateUrl(new URL(location,address).href);
    }
    if(!response?.ok)throw new Error('Could not load this podcast feed.');
    const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>1024*1024)throw new Error('Podcast feed exceeds 1 MB.');chunks.push(Buffer.from(chunk));}
    return parseFeed(Buffer.concat(chunks).toString('utf8'),address.href);
}
async function radioSearch(query,fetchImpl=fetch) {
    const url=new URL('https://de1.api.radio-browser.info/json/stations/search');
    const result=await require('./connected-providers').jsonRequest(url,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({name:String(query||'').slice(0,100),limit:30,hidebroken:true,order:'clickcount',reverse:true})},fetchImpl);
    return result.filter(s=>!s.hls).flatMap(s=>{try{return [{id:s.stationuuid,title:String(s.name).slice(0,300),
        url:remote.validateUrl(s.url_resolved||s.url).href,country:s.country,tags:s.tags}];}catch(_){return [];}});
}
module.exports={decode,parseFeed,feed,radioSearch};
