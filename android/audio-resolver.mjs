import {createServer} from 'node:http';
import {execFile} from 'node:child_process';

createServer((request,response)=>{
  const url=new URL(request.url,'http://localhost');
  const id=url.searchParams.get('id');
  if(request.method!=='GET'||url.pathname!=='/audio'||!id||!/^[A-Za-z0-9_-]{11}$/.test(id)){
    response.writeHead(400).end('Invalid video request');
    return;
  }
  execFile(process.env.SPOTITUBE_YTDLP||'yt-dlp',['--no-playlist','--no-warnings','-f','bestaudio[protocol=https]','--get-url','https://www.youtube.com/watch?v='+id],{timeout:30000,windowsHide:true},(error,stdout)=>{
    const stream=stdout.trim();
    if(error||!/^https:\/\/[^\s]+$/.test(stream)){
      response.writeHead(502).end('Audio resolution failed');
      return;
    }
    response.writeHead(200,{'Content-Type':'text/plain','Cache-Control':'no-store'}).end(stream);
  });
}).listen(5180,'127.0.0.1',()=>console.log('Spotitube audio resolver listening on 5180'));
