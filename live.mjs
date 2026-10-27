/* Square One Live — read-only data aggregation for Netlify.
   No API keys embedded. For production commercial display, verify feed redistribution rights.
   ESPN endpoints are unofficial and may change; headlines via Google News RSS search.
*/
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'public, max-age=30, s-maxage=90, stale-while-revalidate=120',
  'Access-Control-Allow-Origin': '*',
};
const LEAGUES = [
  {key:'NFL', path:'football/nfl', order:1},
  {key:'NHL', path:'hockey/nhl', order:2},
  {key:'MLB', path:'baseball/mlb', order:3},
  {key:'NCAAF', path:'football/college-football', order:4},
  {key:'NBA', path:'basketball/nba', order:5},
];
const toText=(x,max=160)=>String(x??'').replace(/\s+/g,' ').trim().slice(0,max);
const fmtET=(date)=>{
  const d=new Date(date);if(Number.isNaN(d.valueOf()))return 'Upcoming';
  return new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(d)+' ET';
};
const favorite=(a,b)=>['PIT','PITT','PSU','PGH'].includes(a)||['PIT','PITT','PSU','PGH'].includes(b);
async function download(url, maxMs=6500){
  const res=await fetch(url,{signal:AbortSignal.timeout(maxMs),headers:{'Accept':'application/json, application/rss+xml, application/xml, text/xml, */*','User-Agent':'SquareOneLive/1.0 (public storefront display; contact through shop website)'}});
  if(!res.ok)throw new Error('upstream '+res.status);
  return res;
}
function parseGame(event,league){
  try{
    const competition=event.competitions?.[0];const teams=competition?.competitors||[];
    const home=teams.find(c=>c.homeAway==='home'),away=teams.find(c=>c.homeAway==='away');
    if(!home||!away)return null;
    const ha=toText(home.team?.abbreviation||home.team?.shortDisplayName,15),aa=toText(away.team?.abbreviation||away.team?.shortDisplayName,15);
    const status=competition.status||event.status||{};const type=status.type||{};
    const state=type.state==='in'?'LIVE':type.state==='post'||type.completed?'FINAL':'SCHEDULED';
    const scoreAvailable=home.score!==undefined&&away.score!==undefined;
    const hs=String(home.score?.displayValue??home.score??'');
    const as=String(away.score?.displayValue??away.score??'');
    let detail=state==='LIVE'?toText(type.shortDetail||type.detail||status.displayClock||'In progress',38):state==='FINAL'?'Final':fmtET(event.date);
    if(state==='LIVE'&&!detail)detail='Live';
    let text=aa+' @ '+ha+' · '+(scoreAvailable&&(state==='FINAL'||state==='LIVE')?as+'–'+hs+' · '+detail:detail);
    return {id:toText(event.id,36),league,home:ha,away:aa,state,detail,text,when:event.date||'',favorite:favorite(ha,aa),source:'ESPN (unofficial)'};
  }catch{return null}
}
async function fetchScores(){
  const tasks=LEAGUES.map(async l=>{
    let suffix=l.key==='NCAAF'?'?groups=80&limit=20':'';
    let resp=await download('https://site.api.espn.com/apis/site/v2/sports/'+l.path+'/scoreboard'+suffix,6000);
    const body=await resp.json();
    return {league:l.key,games:(Array.isArray(body.events)?body.events:[]).map(e=>parseGame(e,l.key)).filter(Boolean)};
  });
  const settled=await Promise.allSettled(tasks);
  const results=settled.filter(x=>x.status==='fulfilled').map(x=>x.value);
  let flat=results.flatMap(x=>x.games);
  // Rank Pittsburgh teams and games in progress first. Keep useful league variety.
  flat.sort((a,b)=>Number(b.favorite)-Number(a.favorite)||Number(b.state==='LIVE')-Number(a.state==='LIVE')||LEAGUES.findIndex(l=>l.key===a.league)-LEAGUES.findIndex(l=>l.key===b.league));
  const selected=flat.slice(0,20);
  return {items:selected,ok:results.length>0,leaguesOk:results.map(x=>x.league),source:'ESPN unofficial scoreboard',checkedAt:new Date().toISOString(),error:results.length?'': 'Score provider not responding'};
}
function decodeXml(text){
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')
    .replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos|nbsp);/g,(_,entity)=>{
      const named={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};if(named[entity])return named[entity];
      let n=entity[1]?.toLowerCase()==='x'?parseInt(entity.slice(2),16):parseInt(entity.slice(1),10);
      return Number.isFinite(n)&&n>0&&n<=0x10FFFF?String.fromCodePoint(n):'';
    }).replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
}
function tag(body,name){const m=body.match(new RegExp('<'+name+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/'+name+'>','i'));return m?decodeXml(m[1]):'';}
function parseRss(xml){
  let items=[...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].slice(0,24).map(m=>{
    const title=toText(tag(m[1],'title'),145),link=tag(m[1],'link');
    const source=tag(m[1],'source')||'Google News';
    const published=tag(m[1],'pubDate');
    return {title,link:/^https:\/\//i.test(link)?link:'',source:toText(source,70),published:published&& !Number.isNaN(Date.parse(published))?new Date(published).toISOString():null};
  }).filter(x=>x.title&&x.link);
  return items.slice(0,12);
}
async function fetchNews(){
  const url='https://news.google.com/rss/search?q='+encodeURIComponent('Pittsburgh OR Steelers OR Penguins when:2d')+'&hl=en-US&gl=US&ceid=US:en';
  try{
    const xml=await (await download(url,7200)).text();const items=parseRss(xml);
    return {items,ok:items.length>0,source:'Google News RSS (linked headlines)',checkedAt:new Date().toISOString(),error:items.length?'':'No current headlines available'};
  }catch(e){
    // Fallback: links to the actual originating ESPN sports headlines.
    try{
      const resp=await download('https://site.api.espn.com/apis/site/v2/sports/football/nfl/news',5500);
      const data=await resp.json();
      const items=(data.articles||[]).slice(0,10).map(a=>({title:toText(a.headline,145),link:a.links?.web?.href||'',source:'ESPN NFL',published:a.published||null})).filter(a=>/^https?:\/\//.test(a.link)&&a.title);
      return {items,ok:items.length>0,source:'ESPN NFL headlines (fallback)',checkedAt:new Date().toISOString(),error:items.length?'':'News provider unavailable'};
    }catch{return {items:[],ok:false,source:'Unavailable',checkedAt:new Date().toISOString(),error:'News feed unavailable'};}
  }
}
export default async function handler(request){
  if(request.method!=='GET')return new Response('Method not allowed',{status:405});
  const mode=new URL(request.url).searchParams.get('type')||'all';
  if(!['all','sports','news'].includes(mode))return Response.json({error:'Invalid feed type'},{status:400,headers:JSON_HEADERS});
  const [sports,news]=await Promise.all([mode==='news'?Promise.resolve(null):fetchScores(),mode==='sports'?Promise.resolve(null):fetchNews()]);
  return Response.json({sports,news,generatedAt:new Date().toISOString(),note:'Feeds are independent of this website and may have licensing restrictions for commercial displays.'},{headers:JSON_HEADERS});
}
