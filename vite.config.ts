import {execFile as searchCommand} from 'node:child_process';
import {execFile} from 'node:child_process';
import {defineConfig,loadEnv} from 'vite';
import {createHmac,randomUUID} from 'node:crypto';
const SECRETISH = /(SECRET|SERVICE_ROLE|PRIVATE|PASSWORD|API_TOKEN|ACCESS_TOKEN)/i;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('VITE_') && SECRETISH.test(key) && process.env[key]) {
    throw new Error(
      `Refusing to build: ${key} looks like a secret and VITE_* vars are inlined into the public bundle. Use server-side only.`,
    );
  }
}

export default defineConfig(({mode})=>{
 const env=loadEnv(mode,process.cwd(),'GOOGLE_');
 const callback='http://127.0.0.1:5173/auth/google/callback';
 const sessions=new Map<string,string>();
 const sign=(state:string)=>createHmac('sha256',env.GOOGLE_CLIENT_SECRET||'').update(state).digest('hex');
 return {server:{proxy:{'/metadata':{target:'https://www.youtube.com',changeOrigin:true,rewrite:path=>path.replace(/^\/metadata/,'/oembed')}}},plugins:[{name:'youtube-local-auth',configureServer(server){
 server.middlewares.use(async(req,res,next)=>{
 const url=new URL(req.url||'/',callback);
 const cookie=(name:string)=>req.headers.cookie?.match(new RegExp('(?:^|; )'+name+'=([^;]+)'))?.[1];
 const redirect=(target:string)=>{res.writeHead(302,{Location:target});res.end()};
 const json=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value))};
 try{
 if(url.pathname==='/api/search'){
 const q=url.searchParams.get('q')?.trim();
 if(!q||q.length>120)return json(400,{error:'Enter a search query.'});
 return searchCommand('python',['-m','yt_dlp','--ignore-config','--flat-playlist','--dump-single-json','--','ytsearch15:'+q],{timeout:30000},(error,output)=>{
   if(error)return json(502,{error:'YouTube search failed.'});
   try{return json(200,JSON.parse(output).entries.filter((v:any)=>/^[\w-]{11}$/.test(v.id)).map((v:any)=>({id:v.id,title:v.title,author_name:v.channel||v.uploader||'',thumbnail_url:'https://i.ytimg.com/vi/'+v.id+'/mqdefault.jpg',duration:Math.max(0,Number(v.duration)||0)})))}catch{return json(502,{error:'Invalid search results.'})}
 });
 }
 if(url.pathname==='/api/audio'){
 const id=url.searchParams.get('id');
 if(req.method!=='GET'||!id||!/^[A-Za-z0-9_-]{11}$/.test(id))return json(400,{error:'Invalid video ID.'});
 return execFile(process.env.SPOTITUBE_YTDLP||'python',[...(process.env.SPOTITUBE_YTDLP?[]:['-m','yt_dlp']),'--js-runtimes','node','--ignore-config','--no-playlist','-f','bestaudio[protocol=https]','--get-url','https://www.youtube.com/watch?v='+id],{timeout:30000,windowsHide:true},(error,output)=>{
 const stream=output.trim();
 if(error||!/^https:\/\/[^\s]+$/.test(stream))return json(502,{error:'YouTube audio could not be resolved. Switch to Video to try the embed.'});
 return json(200,{stream});
 });
 }
 if(url.pathname==='/auth/google'){
 if(!env.GOOGLE_CLIENT_ID||!env.GOOGLE_CLIENT_SECRET)return json(503,{error:'Configure Google OAuth in .env.local and restart Vite.'});
 const state=Date.now()+'-'+randomUUID();
 res.setHeader('Set-Cookie','oauth_state='+sign(state)+'; HttpOnly; SameSite=Lax; Path=/auth/google; Max-Age=600');
 return redirect('https://accounts.google.com/o/oauth2/v2/auth?'+new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,redirect_uri:callback,response_type:'code',scope:'https://www.googleapis.com/auth/youtube.readonly',state}));
 }
 if(url.pathname==='/auth/google/callback'){
 const state=url.searchParams.get('state'),code=url.searchParams.get('code');
 if(url.searchParams.has('error'))return redirect('/?youtube=denied');
 res.setHeader('Set-Cookie','oauth_state=; HttpOnly; SameSite=Lax; Path=/auth/google; Max-Age=0');
 if(!state||!code||cookie('oauth_state')!==sign(state)||!(Math.abs(Date.now()-Number(state.split('-')[0]))<600000))return redirect('/?youtube=session');
 const token=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({code,client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,redirect_uri:callback,grant_type:'authorization_code'})});
 const data=await token.json();if(!token.ok||!data.access_token)return redirect('/?youtube='+ (data.error==='invalid_client'?'credentials':'exchange'));
 const sid=randomUUID();sessions.set(sid,data.access_token);setTimeout(()=>sessions.delete(sid),Number(data.expires_in)*1000).unref();
 res.setHeader('Set-Cookie','youtube_session='+sid+'; HttpOnly; SameSite=Lax; Path=/; Max-Age='+Number(data.expires_in));
 return redirect('/?youtube=connected');
 }
 if(url.pathname==='/api/youtube/playlist-items'){
 const token=sessions.get(cookie('youtube_session')||'');if(!token)return json(401,{error:'Connect YouTube again.'});
 const playlistId=url.searchParams.get('id');if(!playlistId||!/^[A-Za-z0-9_-]{1,128}$/.test(playlistId))return json(400,{error:'Invalid playlist.'});
 const params=new URLSearchParams({part:'snippet',playlistId,maxResults:'50'});
 const items=[];do{
 const response=await fetch('https://www.googleapis.com/youtube/v3/playlistItems?'+params,{headers:{Authorization:'Bearer '+token}});
 if(!response.ok)return json(response.status,{error:'YouTube could not load this playlist.'});
 const data=await response.json();
 for(const item of data.items){
 const v=item.snippet;const id=v.resourceId?.videoId;
 if(id&&v.thumbnails?.default?.url)items.push({id,title:v.title,author_name:v.videoOwnerChannelTitle||'',thumbnail_url:(v.thumbnails.medium||v.thumbnails.default).url});
 }
 if(!data.nextPageToken)break;params.set('pageToken',data.nextPageToken);
 }while(true);
 return json(200,items);
 }
 if(url.pathname==='/api/youtube/playlists'){
 const token=sessions.get(cookie('youtube_session')||'');if(!token)return json(401,{error:'Connect YouTube again.'});
 const params=new URLSearchParams({part:'snippet',mine:'true',maxResults:'50'});
 const items=[];do{
 const response=await fetch('https://www.googleapis.com/youtube/v3/playlists?'+params,{headers:{Authorization:'Bearer '+token}});
 if(!response.ok)return json(response.status,{error:'YouTube could not load your playlists.'});
 const data=await response.json();items.push(...data.items.map((p:any)=>({id:p.id,title:p.snippet.title})));
 if(!data.nextPageToken)break;params.set('pageToken',data.nextPageToken);
 }while(true);
 return json(200,items);
 }
 return next();
 }catch{return json(502,{error:'Could not reach Google or YouTube.'})}
 });
 }}]};
});






