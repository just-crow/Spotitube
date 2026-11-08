// Developer inspection helper. Launch with --remote-debugging-port=9334 only for local testing.
import fs from 'node:fs';
const tabs = await (await fetch('http://127.0.0.1:9334/json')).json();
const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (process.argv[2] === 'monitor' && ['Log.entryAdded', 'Media.playerErrorsRaised', 'Media.playerEventsAdded', 'Media.playerPropertiesChanged'].includes(m.method)) console.log(JSON.stringify(m));
};
async function call(method, params = {}) {
  const n = ++id; const response = new Promise(r => pending.set(n, r)); ws.send(JSON.stringify({ id: n, method, params }));
  const result = await response; if (result.error) throw Error(JSON.stringify(result.error)); return result.result;
}
async function ev(expression) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result?.value;
}
try {
  if (process.argv[2] === 'transition') {
    const prototype = await call('Runtime.evaluate', { expression: 'HTMLAudioElement.prototype' });
    const objects = await call('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId });
    await call('Runtime.callFunctionOn', { objectId: objects.objects.objectId, functionDeclaration: 'function(){this.previous=this.find(a=>!a.paused&&a.currentTime>0)}' });
    const start = Date.now();
    await ev('[...document.querySelectorAll(".controls button")].find(b=>b.getAttribute("aria-label")==="Next track").click()');
    let result;
    do {
      await new Promise(r => setTimeout(r, 25));
      result = (await call('Runtime.callFunctionOn', { objectId: objects.objects.objectId, functionDeclaration: 'function(){const a=this.find(a=>a!==this.previous&&!a.paused&&a.currentTime>0);return {playing:!!a,time:a?.currentTime}}', returnByValue: true })).result.value;
    } while (!result.playing && Date.now() - start < 15000);
    console.log({ transitionMs: Date.now() - start, ...result });
  } else if (process.argv[2] === 'startup') {
    const prototype = await call('Runtime.evaluate', { expression: 'HTMLAudioElement.prototype' });
    const objects = await call('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId });
    for (const videoId of process.argv.slice(3)) {
      await ev('[...document.querySelectorAll("nav button")].find(b=>b.textContent==="Home").click()');
      await ev('document.querySelector("input[placeholder^=Paste]").focus()');
      await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
      await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
      const start = Date.now();
      await call('Input.insertText', { text: 'https://www.youtube.com/watch?v=' + videoId });
      await ev('document.querySelector("input[placeholder^=Paste]").form.requestSubmit()');
      let result;
      do {
        await new Promise(r => setTimeout(r, 100));
        result = (await call('Runtime.callFunctionOn', { objectId: objects.objects.objectId, functionDeclaration: `function(){const a=this.find(a=>a.src.includes(${JSON.stringify(videoId)}));return a?{playing:!a.paused&&a.currentTime>0,time:a.currentTime,error:a.error?.code,buffered:a.buffered.length?a.buffered.end(a.buffered.length-1):0}:{};}`, returnByValue: true })).result.value;
      } while (!result.playing && Date.now() - start < 45000);
      console.log({ id: videoId, startupMs: Date.now() - start, ...result });
    }
  } else if (process.argv[2] === 'monitor') {
    await call('Log.enable'); await call('Media.enable');
    await ev('(async()=>{window.testAudio=new Audio();window.testAudio.crossOrigin="anonymous";window.testAudio.src=(await window.SpotitubeDesktop.invoke("resolve",{id:"dQw4w9WgXcQ"})).url;window.testAudio.volume=0;window.testAudio.play().catch(()=>{})})()');
    await new Promise(r => setTimeout(r, 8000));
    await ev('window.testAudio.pause()');
  } else if (process.argv[2] === 'audio') {
    const prototype = await call('Runtime.evaluate', { expression: 'HTMLAudioElement.prototype' });
    const objects = await call('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId });
    console.log(JSON.stringify((await call('Runtime.callFunctionOn', { objectId: objects.objects.objectId, functionDeclaration: 'function(){return this.map(a=>({source:a.src?new URL(a.src).protocol:null,paused:a.paused,time:a.currentTime,duration:a.duration,ready:a.readyState,network:a.networkState,error:a.error?.message,buffered:a.buffered.length?a.buffered.end(a.buffered.length-1):0}))}', returnByValue: true })).result.value, null, 2));
  } else if (process.argv[2] === 'signal') {
    const prototype = await call('Runtime.evaluate', { expression: 'HTMLAudioElement.prototype' });
    const objects = await call('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId });
    const result = await call('Runtime.callFunctionOn', { objectId: objects.objects.objectId, functionDeclaration: `async function(){const a=this.find(a=>!a.paused&&a.duration>0);if(!a)return {playing:false};const ctx=new AudioContext();const src=ctx.createMediaStreamSource(a.captureStream());const analyser=ctx.createAnalyser();src.connect(analyser);await ctx.resume();await new Promise(r=>setTimeout(r,300));const data=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(data);const rms=Math.sqrt(data.reduce((s,v)=>s+v*v,0)/data.length);await ctx.close();return {playing:true,rms,nonSilent:rms>0.0001}}`, awaitPromise: true, returnByValue: true });
    console.log(result.result.value);
  } else if (process.argv[2] === 'stream') {
    const stream = await ev('window.SpotitubeDesktop.invoke("resolve",{id:"dQw4w9WgXcQ"})');
    const response = await fetch(stream.url, { headers: { Range: 'bytes=0-' + (process.argv[3] || '1023'), Origin: 'null' }, signal: AbortSignal.timeout(12000) });
    const bytes = new Uint8Array(await response.arrayBuffer());
    console.log({ status: response.status, headers: Object.fromEntries(response.headers), bytes: bytes.length, first: [...bytes.slice(0, 8)] });
  } else if (process.argv[2] === 'layout') {
    for (const [width, height] of [[860,620],[1024,768],[1366,768],[1920,1080]]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      console.log(await ev(`({width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,player:document.querySelector('.player').getBoundingClientRect().bottom<=innerHeight+1})`));
    }
    await call('Emulation.clearDeviceMetricsOverride');
  } else if (process.argv[2] === 'eval') console.log(JSON.stringify(await ev(process.argv[3]), null, 2));
  else if (process.argv[2] === 'input') {
    await ev(`document.querySelector(${JSON.stringify(process.argv[3])}).focus()`);
    await call('Input.insertText', { text: process.argv[4] });
    await ev(`document.querySelector(${JSON.stringify(process.argv[3])}).form.requestSubmit()`);
  } else if (process.argv[2] === 'screenshot') {
    const result = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(process.argv[3], Buffer.from(result.data, 'base64'));
  } else if (process.argv[2] === 'close') { ws.send(JSON.stringify({ id: ++id, method: 'Browser.close' })); await new Promise(r => { ws.onclose = r; setTimeout(r, 2000); }); }
  else console.log(JSON.stringify(await ev(`({text:document.body.innerText.slice(0,4500),inputs:[...document.querySelectorAll('input')].map(i=>({placeholder:i.placeholder,type:i.type})),native:!!window.SpotitubeDesktop,overflow:document.documentElement.scrollWidth>innerWidth})`), null, 2));
} finally { ws.close(); }
