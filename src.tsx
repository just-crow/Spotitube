import React,{useState,useEffect,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import './style.css';

type Video={id:string,title:string,author_name:string,thumbnail_url:string};
type Entry={key:string,video:Video};
const entry=(video:Video):Entry=>({key:crypto.randomUUID(),video});
const read=<T,>(key:string,fallback:T):T=>{try{return JSON.parse(localStorage.getItem(key)||'null')??fallback}catch{return fallback}};
const clock=(seconds:number)=>Math.floor(seconds/60)+':'+String(Math.floor(seconds%60)).padStart(2,'0');

const native=(window as any).SpotitubeAndroid;
if(native)document.documentElement.classList.add("android-app");
function shuffled<T>(items:T[]):T[]{
  const result=[...items];
  for(let i=result.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [result[i],result[j]]=[result[j],result[i]];
  }
  return result;
}
function App(){
  const [videos,save]=useState(()=>read<Video[]>('videos',[]));
  const [likes,like]=useState(()=>read<string[]>('likes',[]));
  const [history,remember]=useState(()=>read<string[]>('history',[]));
  const [page,navigate]=useState('Home'),[query,search]=useState('');
  const [url,setUrl]=useState(''),[error,fail]=useState(''),[busy,loading]=useState(false);
  const [queue,setQueue]=useState<Entry[]>([]),[current,select]=useState<Entry>();
  const [shuffle,toggleShuffle]=useState(false),[repeat,setRepeat]=useState(0);
  const [expanded,expand]=useState(false),[playing,setPlaying]=useState(false);
  const [time,setTime]=useState(0),[duration,setDuration]=useState(0),[volume,setVolume]=useState(native?100:80);
  useEffect(()=>{
    if(!native)return;
    const update=()=>{const state=JSON.parse(native.state());if(typeof state.volume==='number')setVolume(state.volume)};
    update();const timer=setInterval(update,350);return()=>clearInterval(timer);
  },[]);
  const [nativeReady,setNativeReady]=useState(false);
  const [playerError,setPlayerError]=useState('');
  const [playlists,setPlaylists]=useState<{id:string,title:string}[]>([]);
  const [syncError,setSyncError]=useState(({failed:'Google sign-in did not complete. Try Connect YouTube again.',denied:'Google did not grant access. Use the account listed under Test users and allow YouTube access.',session:'Sign-in session expired or the browser changed. Start again in the same browser at 127.0.0.1:5173.',credentials:'Google rejected the client credentials. Check the client ID and replacement secret in .env.local.',exchange:'Google could not complete sign-in. Start again and verify the exact redirect URI.'} as Record<string,string>)[new URLSearchParams(location.search).get('youtube')||'']||'');
  useEffect(()=>{if(native)return;fetch('/api/youtube/playlists').then(async res=>{if(res.ok)setPlaylists(await res.json());else if(res.status!==401)setSyncError('Could not load YouTube playlists.')}).catch(()=>setSyncError('Could not load YouTube playlists.'))},[]);
  const [playlist,setPlaylist]=useState<{id:string,title:string}>();
  const [playlistTracks,setPlaylistTracks]=useState<Video[]>([]);
  const [playlistStatus,setPlaylistStatus]=useState('');
  useEffect(()=>{
    if(!playlist)return;
    const request=new AbortController();
    setPlaylistTracks([]);setPlaylistStatus('Loading playlist…');
    fetch('/api/youtube/playlist-items?id='+encodeURIComponent(playlist.id),{signal:request.signal})
      .then(async response=>{
        const data=await response.json();
        if(!response.ok)throw Error(data.error);
        if(!request.signal.aborted){setPlaylistTracks(data);setPlaylistStatus(data.length?'':'No available videos in this playlist.')}
      })
      .catch(error=>{if(!request.signal.aborted)setPlaylistStatus(error.message||'Could not load this playlist.')});
    return()=>request.abort();
  },[playlist]);
  const [audioMode,setAudioMode]=useState(true);
  const audio=useRef<HTMLAudioElement>(null);
  const frame=useRef<HTMLIFrameElement>(null),player=useRef<any>(null),ended=useRef(()=>{});
  const video=current?.video;
  useEffect(()=>{localStorage.setItem('videos',JSON.stringify(videos));localStorage.setItem('likes',JSON.stringify(likes));localStorage.setItem('history',JSON.stringify(history))},[videos,likes,history]);

  function start(item:Entry){
    setRecentVideos(items=>[item.video,...items.filter(v=>v.id!==item.video.id)].slice(0,20));
    select(item);setTime(0);setDuration(0);setPlaying(false);setPlayerError('');
    remember(ids=>[item.video.id,...ids.filter(id=>id!==item.video.id)].slice(0,30));
  }
  function step(direction:number,automatic=false){
    if(!current)return;
    if(automatic&&repeat===2){player.current?.seekTo(0,true);player.current?.playVideo();return}
    const index=queue.findIndex(item=>item.key===current.key);

    const next=
      queue[index+direction]||(repeat===1&&queue.length?queue[(index+direction+queue.length)%queue.length]:undefined);
    if(next?.key===current.key){player.current?.seekTo(0,true);player.current?.playVideo()}
    else if(next)start(next);
  }
  const currentIndex=queue.findIndex(item=>item.key===current?.key);
  const nextItem=currentIndex>=0&&repeat!==2?(queue[currentIndex+1]||(repeat===1?queue[0]:undefined)):undefined;
  useEffect(()=>{if(native&&playing)native.preload(nextItem?.video.id||'')},[playing,shuffle,nextItem?.key]);
  ended.current=()=>step(1,true);

  useEffect(()=>{
    if(!current)return;
    if(native){
      const control=(action:string,value=0)=>native.control(action,value);
      player.current={playVideo:()=>control('play'),pauseVideo:()=>control('pause'),seekTo:(t:number)=>control('seek',t),setVolume:(v:number)=>control('volume',v)};
      setPlaying(false);setTime(0);setDuration(0);setPlayerError('');
      setNativeReady(false);
      native.load(current.video.id,current.video.title,current.video.author_name,current.key);

      let wasEnded=false;
      const poll=setInterval(()=>{
        const state=JSON.parse(native.state());

        if(state.key!==current.key)return;
        setNativeReady(!state.loading&&Boolean(state.duration)&&!state.error);
        setPlaying(Boolean(state.playing));setTime(state.time||0);setDuration(state.duration||0);setPlayerError(state.error||(state.loading?'Loading audio…':''));
        if(!state.loading&&state.ended&&!wasEnded)ended.current();
        wasEnded=Boolean(state.ended);
      },350);
      return()=>{clearInterval(poll);player.current=null};
    }
    if(audioMode){
      const element=audio.current;
      if(!element)return;
      const request=new AbortController();
      const update=()=>{setTime(element.currentTime);setDuration(Number.isFinite(element.duration)?element.duration:0)};
      const sync=()=>setPlaying(!element.paused);
      const advance=()=>ended.current();
      const failed=()=>setPlayerError('This audio stream could not play. Try Video mode.');
      const listeners={timeupdate:update,durationchange:update,play:sync,pause:sync,ended:advance,error:failed};
      Object.entries(listeners).forEach(([name,listener])=>element.addEventListener(name,listener));
      element.volume=volume/100;
      player.current={playVideo:()=>element.play().catch(failed),pauseVideo:()=>element.pause(),seekTo:(t:number)=>{element.currentTime=t},setVolume:(v:number)=>{element.volume=v/100}};
      setPlayerError('');setTime(0);setDuration(0);setPlaying(false);
      fetch('/api/audio?id='+encodeURIComponent(current.video.id),{signal:request.signal}).then(async res=>{
        const data=await res.json();
        if(!res.ok)throw Error(data.error);
        if(request.signal.aborted)return;
        element.src=data.stream;
        await element.play().catch(()=>{});
      }).catch(error=>{if(!request.signal.aborted)setPlayerError(error.message)});
      return()=>{request.abort();Object.entries(listeners).forEach(([name,listener])=>element.removeEventListener(name,listener));element.pause();element.removeAttribute('src');element.load();player.current=null};
    }
    const api=window as any;
    let disposed=false;
    let instance:any;
    const connect=()=>{
      if(disposed||!frame.current||player.current)return;
      instance=player.current=new api.YT.Player(frame.current,{events:{
        onReady:({target}:any)=>{target.setVolume(volume);if(!document.hidden)target.playVideo()},
        onStateChange:({data,target}:any)=>{setPlaying(data===1);if(data===1&&document.hidden)target.pauseVideo();if(data===0&&!document.hidden)ended.current()},
        onError:({data}: {data:number})=>{setPlaying(false);setPlayerError(data===153?'YouTube could not identify Spotitube. Open the app in Chrome or Edge and try again.':data===101||data===150?'The uploader does not allow this video to play in embedded players.':data===100?'This video is private or has been removed.':'YouTube could not play this video (error '+data+').')},
        onAutoplayBlocked:()=>setPlaying(false)
      }});
    };
    if(api.YT?.Player)connect();
    else{
      api.onYouTubeIframeAPIReady=connect;
      if(!document.querySelector('script[data-youtube]')){
        const script=document.createElement('script');script.src='https://www.youtube.com/iframe_api';script.dataset.youtube='';document.head.append(script);
      }
    }
    const ticker=setInterval(()=>{const p=player.current;if(p?.getCurrentTime){setTime(p.getCurrentTime()||0);setDuration(p.getDuration()||0)}},350);
    const pause=()=>{if(document.hidden)player.current?.pauseVideo?.()};
    document.addEventListener('visibilitychange',pause);
    return()=>{disposed=true;clearInterval(ticker);document.removeEventListener('visibilitychange',pause);instance?.destroy?.();player.current=null};
  },[current?.key,audioMode]);

  function playPlaylist(list:Video[],random:boolean){
    const items=(random?shuffled(list):list).map(entry);
    if(!items.length)return;
    toggleShuffle(random);setQueue(items);start(items[0]);
  }
  function changeShuffle(){
    if(!shuffle){
      setQueue(items=>{
        const index=items.findIndex(item=>item.key===current?.key);
        return [...items.slice(0,index+1),...shuffled(items.slice(index+1))];
      });
    }
    toggleShuffle(!shuffle);
  }
  function playVideo(item:Video,list:Video[],position?:number){
    const items=list.map(entry);
    const selected=(position===undefined?undefined:items[position])??items.find(row=>row.video.id===item.id)??entry(item);
    setQueue(shuffle?[selected,...shuffled(items.filter(row=>row.key!==selected.key))]:items.length?items:[selected]);start(selected);
  }
  function favorite(id:string){const match=matches.find(v=>v.id===id);if(match)save(list=>list.some(v=>v.id===id)?list:[match,...list]);like(ids=>ids.includes(id)?ids.filter(value=>value!==id):[id,...ids])}
  async function add(e:React.FormEvent){
    e.preventDefault();fail('');loading(true);
    try{
      const link=new URL(url.trim());
      const id=link.hostname==='youtu.be'?link.pathname.split('/')[1]:['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com'].includes(link.hostname)?link.searchParams.get('v')||(link.pathname.startsWith('/shorts/')?link.pathname.split('/')[2]:null):null;
      if(!id||!/^[A-Za-z0-9_-]{11}$/.test(id))throw Error();
      const res=native?new Response(native.metadata(id)||'{}') : await fetch('/metadata?url='+encodeURIComponent('https://www.youtube.com/watch?v='+id));
      if(!res.ok)throw Error('YouTube could not load this video.');
      const metadata=await res.json();if(!metadata.title)throw Error('YouTube could not load this video.');
      const item={...metadata,id} as Video;
      const list=[item,...videos.filter(v=>v.id!==id)];
      save(list);playVideo(item,list);setUrl('');navigate('Home');
    }catch(e){fail(e instanceof Error&&e.message.startsWith('YouTube')?e.message:'Paste a valid YouTube video link.')}finally{loading(false)}
  }

  const recent=history.map(id=>videos.find(v=>v.id===id)).filter((v):v is Video=>Boolean(v));
  const [matches,setMatches]=useState<Video[]>([]);
  const [searchStatus,setSearchStatus]=useState('');
  const searchRequest=useRef(0);
  useEffect(()=>{
    if(!native)return;
    const receive=(event:Event)=>{
      const {request,videos}= (event as CustomEvent).detail;
      if(request!==searchRequest.current)return;
      setMatches(videos||[]);
      setSearchStatus(!videos?'YouTube search failed. Try again.':videos.length?'':'No videos found.');
    };
    window.addEventListener('spotitube-search',receive);
    return()=>window.removeEventListener('spotitube-search',receive);
  },[]);
  function submitSearch(event:React.FormEvent){
    event.preventDefault();navigate('Search');
    if(!native||!query.trim())return;
    setMatches([]);setSearchStatus('Searching YouTube…');
    native.search(query.trim(),++searchRequest.current);
  }
  const [results,setResults]=useState<Video[]>([]);
  const [searchMessage,setSearchMessage]=useState('');
  const [lists,setLists]=useState(()=>read<{name:string,ids:string[],source?:string}[]>('spotitube-playlists',[]));
  const [name,setName]=useState('');
  const [listIndex,setListIndex]=useState(-1);
  const [pick,setPick]=useState<Video>();
  const [destination,setDestination]=useState(0);
  useEffect(()=>{localStorage.setItem('spotitube-playlists',JSON.stringify(lists))},[lists]);
  function saveVideo(v:Video){save(items=>items.some(item=>item.id===v.id)?items:[v,...items])}
  function findVideos(e:React.FormEvent){
    e.preventDefault();navigate('Search');
    if(!query.trim())return;
    setResults([]);setSearchMessage('Searching YouTube…');
    fetch('/api/search?q='+encodeURIComponent(query.trim())).then(async response=>{
      const data=await response.json();if(!response.ok)throw Error(data.error);
      setResults(data);setSearchMessage(data.length?'':'No results found.');
    }).catch(()=>setSearchMessage('YouTube search is unavailable.'));
  }
  const [recentVideos,setRecentVideos]=useState(()=>read<Video[]>("recent-videos",[]));
  useEffect(()=>{localStorage.setItem("recent-videos",JSON.stringify(recentVideos))},[recentVideos]);
  const [playlistUrl,setPlaylistUrl]=useState('');
  const [importStatus,setImportStatus]=useState('');
  const [importing,setImporting]=useState(false);
  useEffect(()=>{
    const receive=(event:Event)=>{
      const {id,playlist}=(event as CustomEvent).detail as {id:string,playlist:{name:string,videos:Video[]}|null};
      setImporting(false);
      if(!playlist){setImportStatus('Could not import this playlist. Check that it is public or unlisted.');return}
      save(items=>Array.from(new Map([...items,...playlist.videos].map(v=>[v.id,v])).values()));
      const incoming={name:playlist.name,ids:playlist.videos.map(v=>v.id),source:id};
      setLists(items=>items.some(p=>p.source===id)?items.map(p=>p.source===id?incoming:p):[...items,incoming]);
      setPlaylistUrl('');setImportStatus('Synced '+playlist.videos.length+' videos.');
    };
    window.addEventListener('spotitube-playlist',receive);
    return()=>window.removeEventListener('spotitube-playlist',receive);
  },[]);
  function syncPlaylist(id:string){
    setImporting(true);setImportStatus('Loading playlist…');native.importPlaylist(id);
  }
  function importPlaylist(event:React.FormEvent){
    event.preventDefault();
    try{
      const url=new URL(playlistUrl.trim());
      const id=url.searchParams.get('list');
      if(url.protocol!=='https:'||!['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com','youtu.be'].includes(url.hostname)||!id||!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw Error();
      syncPlaylist(id);
    }catch{setImportStatus('Paste a YouTube link that includes a playlist.')}
  }
  const selectedList=lists[listIndex];
  const listTracks=(selectedList?.ids||[]).map(id=>videos.find(v=>v.id===id)).filter((v):v is Video=>Boolean(v));
  const playlistQueue=page==='Playlist'?playlistTracks:page==='My playlist'?listTracks:[];
  const shown=page==='My playlist'?listTracks:native&&page==='Search'?matches:page==='Liked videos'?videos.filter(v=>likes.includes(v.id)):videos.filter(v=>page!=='Search'||(v.title+' '+v.author_name).toLowerCase().includes(query.trim().toLowerCase()));
  const icon=(label:string,glyph:string,action:()=>void,active?:boolean,disabled?:boolean)=><button type="button" className={'icon '+(active?'active':'')} title={label} aria-label={label} onClick={action} disabled={disabled}>{glyph}</button>;
  const row=(v:Video,index:number,list:Video[])=><div className={"track"+(video?.id===v.id?" is-playing":"")} key={v.id+index}>
    <button className="track-play" onClick={()=>playVideo(v,list,index)}><span className="index">{video?.id===v.id?'♪':index+1}</span><img src={v.thumbnail_url} alt=""/><span className="copy"><strong>{v.title}</strong><small>{v.author_name}</small></span></button>
    {icon(likes.includes(v.id)?'Unlike video':'Like video',likes.includes(v.id)?'♥':'♡',()=>favorite(v.id),likes.includes(v.id))}
    {icon('Save video','↓',()=>saveVideo(v),videos.some(item=>item.id===v.id))}{lists.length>0&&icon('Add to playlist','≡',()=>{setDestination(0);setPick(v)})}{page==='My playlist'&&icon('Remove from playlist','×',()=>setLists(items=>items.map((p,i)=>i===listIndex?{...p,ids:p.ids.filter(id=>id!==v.id)}:p)))}{icon('Add to queue','＋',()=>setQueue(items=>[...items,entry(v)]))}
  </div>;

  return <>
    <header><button className="brand" onClick={()=>navigate('Home')}><span>◉</span> Spotitube</button><nav aria-label="Main navigation">{['Home','Library','Liked videos','Queue'].map(name=><button key={name} className={page===name?'selected':''} aria-current={page===name?'page':undefined} onClick={()=>navigate(name)}>{name}</button>)}</nav><form className="search-form" onSubmit={submitSearch}><input aria-label={native?"Search YouTube":"Search saved videos"} placeholder={native?"Search YouTube":"Search saved videos"} maxLength={120} value={query} onFocus={()=>navigate('Search')} onChange={e=>search(e.target.value)}/>{native&&<button type="submit" aria-label="Search YouTube">Search</button>}</form></header>
    <main className={expanded&&video?'expanded':''}>
      <aside className="panel library"><h2>Your library</h2>{!native&&<a href="/auth/google">Connect YouTube</a>}{syncError&&<p role="alert">{syncError}</p>}{playlists.map(p=><button key={p.id} className="library-link playlist-link" aria-current={page==='Playlist'&&playlist?.id===p.id?'page':undefined} onClick={()=>{setPlaylist(p);navigate('Playlist')}}><i>♫</i><span>{p.title}<small>YouTube playlist</small></span></button>)}<button className="library-link" onClick={()=>navigate('Liked videos')}><i>♥</i><span>Liked videos<small>{likes.length} saved</small></span></button>{videos.map(v=><button key={v.id} className="library-link" onClick={()=>playVideo(v,videos)}><img src={v.thumbnail_url} alt=""/><span>{v.title}<small>{v.author_name}</small></span></button>)}</aside>
      <section className="panel content">
        {page==='Home'&&<div className="hero"><span className="eyebrow">YOUR YOUTUBE MUSIC LIBRARY</span><h1>Music for your day</h1><p>Bring a YouTube video into your library and press play.</p><form onSubmit={add}><input aria-label="YouTube link" placeholder="Paste a YouTube link" value={url} onChange={e=>setUrl(e.target.value)} required/><button className="primary" disabled={busy}>{busy?'Adding…':'Add video'}</button></form>{error&&<p role="alert">{error}</p>}</div>}
        {(page==='Library'||page==='Home')&&<div className="playlist-browser"><h2>Your playlists</h2>{lists.length===0&&<div className="playlist-empty"><p>Your favorites, in good company.<br/>Create a playlist to make it yours.</p>{page==='Home'&&<button className="secondary" onClick={()=>navigate('Library')}>Create playlist</button>}</div>}{page==='Library'&&<form onSubmit={e=>{e.preventDefault();if(!name.trim())return;setListIndex(lists.length);setLists([...lists,{name:name.trim(),ids:[]}]);setName('');navigate('My playlist')}}><input aria-label="Playlist name" placeholder="Playlist name" value={name} onChange={e=>setName(e.target.value)}/><button className="primary">Create playlist</button></form>}{lists.map((p,i)=><button className="library-link" key={i} onClick={()=>{setListIndex(i);navigate('My playlist')}}><i>♫</i><span>{p.name}<small>{p.ids.length} videos</small></span></button>)}</div>}
        {native&&page==='Library'&&<form onSubmit={importPlaylist}><input aria-label="YouTube playlist link" placeholder="Paste YouTube playlist link" value={playlistUrl} onChange={e=>setPlaylistUrl(e.target.value)}/><button className="primary" disabled={importing}>Import playlist</button></form>}
        {native&&page==='My playlist'&&selectedList?.source&&<button className="primary" disabled={importing} onClick={()=>syncPlaylist(selectedList.source!)}>Refresh from YouTube</button>}
        {native&&(page==='Library'||page==='My playlist')&&importStatus&&<p role="status">{importStatus}</p>}
        {pick&&<form onSubmit={e=>{e.preventDefault();saveVideo(pick);setLists(items=>items.map((p,i)=>i===destination&&!p.ids.includes(pick.id)?{...p,ids:[...p.ids,pick.id]}:p));setPick(undefined)}}><label>Add to playlist <select value={destination} onChange={e=>setDestination(+e.target.value)}>{lists.map((p,i)=><option key={i} value={i}>{p.name}</option>)}</select></label><button className="primary">Add</button><button type="button" onClick={()=>setPick(undefined)}>Cancel</button></form>}
        {page==='Library'&&playlists.length>0&&<div className="playlist-browser"><h2>YouTube playlists</h2>{playlists.map(p=><button key={p.id} className="library-link playlist-link" onClick={()=>{setPlaylist(p);navigate('Playlist')}}><i>♫</i><span>{p.title}<small>YouTube playlist</small></span></button>)}</div>}
        {page==='Home'&&recentVideos.length>0&&<><h2>Recently played</h2><div className="cards">{recentVideos.slice(0,5).map(v=><button key={v.id} onClick={()=>playVideo(v,recentVideos)}><img src={v.thumbnail_url} alt=""/><strong>{v.title}</strong><small>{v.author_name}</small></button>)}</div></>}
        <h2>{page==='My playlist'?selectedList?.name:page==='Playlist'?playlist?.title:page==='Home'?'Saved videos':page==='Search'?'Search results':page==='Queue'?'Play queue':page}</h2>
        {playlistQueue.length>0&&<div className="playlist-actions"><button className="primary" onClick={()=>playPlaylist(playlistQueue,false)}>▶ Play all</button><button className="secondary" onClick={()=>playPlaylist(playlistQueue,true)}>⤨ Shuffle play</button></div>}
        {page==='Playlist'?playlistStatus?<p className='empty' role='status'>{playlistStatus}</p>:playlistTracks.map((v,i)=>row(v,i,playlistTracks)):page==='Queue'?queue.length?queue.map((item,index)=><div className={"track"+(item.key===current?.key?" is-playing":"")} key={item.key}><button className="track-play" onClick={()=>start(item)}><span className="index">{item.key===current?.key?'♪':index+1}</span><img src={item.video.thumbnail_url} alt=""/><span className="copy"><strong>{item.video.title}</strong><small>{item.video.author_name}</small></span></button>{icon('Remove from queue','×',()=>setQueue(list=>list.filter(row=>row.key!==item.key)),false,item.key===current?.key)}</div>):<p className="empty">Play a track or add one to the queue.</p>:shown.length?shown.map((v,i)=>row(v,i,shown)):<p className="empty">{page==='Search'?(native?(searchStatus||'Enter a song or artist and tap Search.'):(searchMessage||'No videos found.')):page==='Liked videos'?'Tap the heart next to a video to save it here.':'Add a YouTube link from Home to build your library.'}</p>}
      </section>
      <article className="panel now"><div className="panel-heading"><h2>Now playing</h2>{video&&!native&&<button onClick={()=>setAudioMode(!audioMode)}>{audioMode?'Video':'Audio'}</button>}{video&&!audioMode&&icon(expanded?'Shrink video':'Expand video',expanded?'↙':'↗',()=>expand(!expanded))}</div>{video?<>{audioMode?<><img className="audio-art" src={video.thumbnail_url} alt=""/><audio ref={audio}/></>:<iframe ref={frame} key={current.key} title={video.title} src={'https://www.youtube.com/embed/'+video.id+'?enablejsapi=1&playsinline=1&origin='+encodeURIComponent(location.origin)} referrerPolicy="strict-origin-when-cross-origin" allow="autoplay; encrypted-media" allowFullScreen/>}<h3>{video.title}</h3><p>{video.author_name}</p>{playerError&&<p role="alert">{playerError}</p>}<a href={'https://www.youtube.com/watch?v='+video.id} target="_blank" rel="noreferrer">Watch on YouTube ↗</a></>:<div className="empty now-empty"><span aria-hidden="true">♫</span><strong>A little music goes a long way.</strong><p>Pick a track and settle into your next listen.</p></div>}</article>
    </main>
    <footer className="player" aria-label="Playback controls">
      <div className="track-info">{!video&&<div className="player-placeholder"><span aria-hidden="true">♫</span><div>Ready when you are<small>Choose something to play</small></div></div>}{video&&<><img src={video.thumbnail_url} alt=""/><span className="copy"><strong>{video.title}</strong><small>{video.author_name}</small></span>{icon(likes.includes(video.id)?'Unlike video':'Like video',likes.includes(video.id)?'♥':'♡',()=>favorite(video.id),likes.includes(video.id))}</>}</div>
      <div className="transport"><div className="controls">{icon('Shuffle','⤨',changeShuffle,shuffle)}{icon('Previous track','⏮',()=>time>3?player.current?.seekTo(0,true):step(-1),false,!video)}<button className="play" aria-label={playing?'Pause':'Play'} disabled={!video||Boolean(native&&!nativeReady)} onClick={()=>playing?player.current?.pauseVideo?.():player.current?.playVideo?.()}>{playing?'Ⅱ':'▶'}</button>{icon('Next track','⏭',()=>step(1),false,!video)}{icon(['Repeat off','Repeat queue','Repeat track'][repeat],repeat===2?'↻¹':'↻',()=>setRepeat((repeat+1)%3),Boolean(repeat))}</div><div className="seek"><span>{clock(time)}</span><input aria-label="Playback position" type="range" min="0" max={duration||1} value={Math.min(time,duration)} disabled={!duration} onChange={e=>{const value=+e.target.value;setTime(value);player.current?.seekTo(value,true)}}/><span>{clock(duration)}</span></div></div>
      <div className={"extras"+(native?" android-volume":"")}>{icon('Open queue','☰',()=>navigate('Queue'),page==='Queue')}<label className="volume-control">{native&&<span>{volume}%</span>}<input aria-label={native?"Volume and boost":"Volume"} type="range" min="0" max={native?300:100} value={volume} onChange={e=>{setVolume(+e.target.value);native?native.control("volume",+e.target.value):player.current?.setVolume?.(+e.target.value)}}/></label></div>
    </footer>
  </>;
}
createRoot(document.getElementById('root')!).render(<App/>);

















