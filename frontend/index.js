// ════════════════════════════════════════════════════════════════
// SPEECH ENGINE: fetch → arrayBuffer → decodeAudioData → AudioBufferSourceNode
// No new Audio() / HTMLMediaElement anywhere.
// iOS keep-alive: silent ping every 20s prevents context suspension.
// Voice is read at dequeue time so settings changes take effect immediately.
// No listenForSelection / auto-prompt — user always says "Hey BirdBox" to reply.
// ════════════════════════════════════════════════════════════════

const BACKEND    = 'https://smelting-unleaded-plow.ngrok-free.dev';
const WAKE_WORDS = ['hey birdbox','hey bird box','birdbox','bird box','hey bird'];

const VOICES = [
  { id:'EXAVITQu4vr4xnSDxMaL', name:'Bella',  emoji:'👩', tag:'Female · Soft & Gentle',     desc:'Warm and soothing.',   preview:"Hello, I'm Bella.",  settings:{stability:0.60,similarity_boost:0.75,style:0.25} },
  { id:'pFZP5JQG7iQjIQuC4Bku', name:'Lily',   emoji:'👩', tag:'Female · Bright & Energetic', desc:'Upbeat and lively.',   preview:"Hello, I'm Lily.",   settings:{stability:0.45,similarity_boost:0.85,style:0.40} },
  { id:'pNInz6obpgDQGcFmaJgB', name:'Adam',   emoji:'👨', tag:'Male · Deep & Authoritative', desc:'Bold and commanding.', preview:"Hello, I'm Adam.",   settings:{stability:0.82,similarity_boost:0.88,style:0.05} },
  { id:'VR6AewLTigWG4xSOukaG', name:'Arnold', emoji:'👨', tag:'Male · Crisp & Direct',       desc:'Sharp and precise.',   preview:"Hello, I'm Arnold.", settings:{stability:0.68,similarity_boost:0.80,style:0.18} }
];
const VALID_IDS  = VOICES.map(v => v.id);
const savedVoice = localStorage.getItem('voice_id');
let selectedVoiceId = (savedVoice && VALID_IDS.includes(savedVoice)) ? savedVoice : 'pFZP5JQG7iQjIQuC4Bku';

// ── STATE ─────────────────────────────────────────────────────
let stream = null, scanInterval = null, facingMode = 'environment';
let intervalMs = 4000, frameCount = 0, userLocation = null;
let commandMode = false, wakeActive = false, wakeRecog = null;
let isScanning = false, scanAbort = null;
let navActive = false, navSteps = [], navStepIndex = 0;
let navDest = null, navDestName = '', lastAnnouncedStep = -1;
let geoWatchId = null, cachedAddress = null;
const conversationHistory = [];

// ── DOM ───────────────────────────────────────────────────────
const video          = document.getElementById('video');
const canvas         = document.getElementById('canvas');
const ctx            = canvas.getContext('2d');
const btnStart       = document.getElementById('btnStart');
const btnStop        = document.getElementById('btnStop');
const btnFlip        = document.getElementById('btnFlip');
const alertBox       = document.getElementById('alertBox');
const alertTypeEl    = document.getElementById('alertType');
const alertMsgEl     = document.getElementById('alertMsg');
const alertTimeEl    = document.getElementById('alertTime');
const statusPill     = document.getElementById('statusPill');
const scanLine       = document.getElementById('scanLine');
const noCam          = document.getElementById('noCam');
const frameCountEl   = document.getElementById('frameCount');
const glowBorder     = document.getElementById('glowBorder');
const wakeHint       = document.getElementById('wakeHint');
const voiceBox       = document.getElementById('voiceBox');
const userTranscript = document.getElementById('userTranscript');
const aiTranscript   = document.getElementById('aiTranscript');
const navBar         = document.getElementById('navBar');
const navDestEl      = document.getElementById('navDest');
const navTotalEl     = document.getElementById('navTotal');
const navStepEl      = document.getElementById('navStep');
const navStepDistEl  = document.getElementById('navStepDist');

// ════════════════════════════════════════════════════════════════
// AUDIO CONTEXT — single shared instance with iOS keep-alive
// ════════════════════════════════════════════════════════════════
let actx = null, keepAliveTimer = null;

function createActx() {
  actx = new (window.AudioContext || window.webkitAudioContext)();
  startKeepAlive();
  return actx;
}

// Await resume() with 500ms timeout — if iOS hangs, recreate context
async function resumeActx() {
  if (!actx || actx.state === 'closed') createActx();
  if (actx.state === 'running') return;
  try {
    await Promise.race([
      actx.resume(),
      new Promise((_, r) => setTimeout(() => r(new Error('resume timeout')), 500))
    ]);
  } catch {
    try { actx.close(); } catch {}
    createActx();
  }
}

// Silent ping every 20s — prevents iOS from suspending the context
function startKeepAlive() {
  stopKeepAlive();
  keepAliveTimer = setInterval(() => {
    if (!actx || actx.state === 'closed') return;
    try {
      if (actx.state === 'suspended') actx.resume();
      const buf = actx.createBuffer(1, 1, actx.sampleRate);
      const src = actx.createBufferSource();
      const gain = actx.createGain();
      gain.gain.value = 0; // completely silent
      src.buffer = buf; src.connect(gain); gain.connect(actx.destination); src.start(0);
    } catch {}
  }, 20000);
}

function stopKeepAlive() {
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
}

// Must be called on a user gesture (START tap) to unlock iOS audio
function unlockAudio() {
  if (actx) return;
  createActx();
  try {
    const buf = actx.createBuffer(1, 1, actx.sampleRate);
    const src = actx.createBufferSource();
    src.buffer = buf; src.connect(actx.destination); src.start(0);
  } catch {}
  try { const u = new SpeechSynthesisUtterance(''); u.volume = 0; window.speechSynthesis.speak(u); } catch {}
}

// ════════════════════════════════════════════════════════════════
// SPEECH ENGINE — pure Web Audio, no HTMLMediaElement
// ════════════════════════════════════════════════════════════════
let isSpeaking = false, currentSrc = null;
const speakQueue = [];

function speak(text) {
  return new Promise(resolve => {
    speakQueue.push({ text, resolve });
    if (!isSpeaking) processQueue();
  });
}

async function processQueue() {
  if (!speakQueue.length) { isSpeaking = false; return; }
  isSpeaking = true;
  const { text, resolve } = speakQueue.shift();
  // Read selectedVoiceId NOW — picks up any voice change made in settings
  const voice = VOICES.find(v => v.id === selectedVoiceId) || VOICES[0];

  try {
    const res = await fetch(`${BACKEND}/tts/stream`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
      body:    JSON.stringify({ text, voice_id: voice.id, voice_settings: voice.settings })
    });
    if (!res.ok) throw new Error(`TTS ${res.status}`);

    const arrayBuffer = await res.arrayBuffer();

    // Ensure context is running BEFORE decode — this is the iOS fix
    await resumeActx();

    const audioBuffer = await actx.decodeAudioData(arrayBuffer);

    await new Promise(done => {
      const src  = actx.createBufferSource();
      const gain = actx.createGain();
      gain.gain.value = 1.5;
      src.buffer = audioBuffer;
      src.connect(gain);
      gain.connect(actx.destination);
      currentSrc  = src;
      src.onended = () => { currentSrc = null; done(); };
      src.start(0);
    });

  } catch (e) {
    console.warn('ElevenLabs failed, browser TTS:', e.message);
    await new Promise(done => speakBrowser(text, done));
  }

  resolve();
  processQueue();
}

function cancelSpeech() {
  speakQueue.length = 0; isSpeaking = false;
  try { if (currentSrc) { currentSrc.stop(); currentSrc = null; } } catch {}
  try { window.speechSynthesis.cancel(); } catch {}
}

function speakBrowser(text, cb) {
  if (!window.speechSynthesis) { cb?.(); return; }
  const utt = new SpeechSynthesisUtterance(text);
  utt.rate = 1.0; utt.volume = 1.0;
  utt.onend = () => cb?.(); utt.onerror = () => cb?.();
  window.speechSynthesis.speak(utt);
}

// ── VOICE GRID ────────────────────────────────────────────────
function buildVoiceGrid() {
  const grid = document.getElementById('voiceGrid');
  grid.innerHTML = '';
  VOICES.forEach(v => {
    const card = document.createElement('div');
    card.className = 'voice-card' + (v.id === selectedVoiceId ? ' active' : '');
    card.dataset.voiceId = v.id;
    card.innerHTML = `
      <div class="voice-card-top"><span style="font-size:18px">${v.emoji}</span><span class="voice-card-name">${v.name}</span></div>
      <div class="voice-card-tag">${v.tag}</div>
      <div class="voice-card-desc">${v.desc}</div>`;
    card.addEventListener('click', () => previewVoice(v.id));
    grid.appendChild(card);
  });
}

async function previewVoice(voiceId) {
  document.querySelectorAll('.voice-card').forEach(c => c.classList.toggle('active', c.dataset.voiceId === voiceId));
  selectedVoiceId = voiceId;
  localStorage.setItem('voice_id', voiceId);
  cancelSpeech();

  const voice  = VOICES.find(v => v.id === voiceId);
  const status = document.getElementById('voicePreviewStatus');
  status.textContent = `Loading ${voice.name}…`;

  try {
    const res = await fetch(`${BACKEND}/tts/stream`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
      body:    JSON.stringify({ text: voice.preview, voice_id: voiceId, voice_settings: voice.settings })
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const arrayBuffer = await res.arrayBuffer();
    await resumeActx();
    const audioBuffer = await actx.decodeAudioData(arrayBuffer);
    status.textContent = `Playing ${voice.name}…`;
    const src = actx.createBufferSource(), gain = actx.createGain();
    gain.gain.value = 1.5;
    src.buffer = audioBuffer; src.connect(gain); gain.connect(actx.destination);
    src.onended = () => { status.textContent = `${voice.name} selected ✓`; };
    src.start(0);
  } catch (e) {
    status.textContent = `Backend error — using browser voice`;
    speakBrowser(voice.preview, () => { status.textContent = `${voice.name} selected (browser voice)`; });
  }
}

buildVoiceGrid();

// ── SETTINGS ─────────────────────────────────────────────────
document.getElementById('btnSettings').addEventListener('click', () => { buildVoiceGrid(); document.getElementById('settingsOverlay').classList.add('visible'); });
document.getElementById('btnCloseSettings').addEventListener('click', () => document.getElementById('settingsOverlay').classList.remove('visible'));
document.querySelectorAll('.ipill').forEach(pill => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('.ipill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    intervalMs = parseInt(pill.dataset.val);
    if (scanInterval) { clearInterval(scanInterval); scanInterval = setInterval(doScan, intervalMs); }
  });
});
document.getElementById('btnStopNav').addEventListener('click', stopNavigation);

// ── HAPTIC ────────────────────────────────────────────────────
const PATTERNS = { single:[150], double:[150,100,150], triple:[100,80,100,80,100], long:[600], nav:[400,100,400], arrived:[1200,200,1200] };
function vibrateOnce(ms) {
  if (navigator.vibrate) { navigator.vibrate(ms); return; }
  if (!actx) return;
  try {
    const sr=actx.sampleRate, len=Math.ceil(sr*.015), buf=actx.createBuffer(1,len,sr), d=buf.getChannelData(0);
    for (let i=0;i<len;i++) d[i]=(i<len*.4?1:-.5)*Math.exp(-i/(sr*.003));
    const src=actx.createBufferSource(), g=actx.createGain();
    src.buffer=buf; g.gain.value=4; src.connect(g); g.connect(actx.destination); src.start(actx.currentTime);
  } catch {}
}
function vibrate(pattern) { const seq=PATTERNS[pattern]||[150]; let d=0,on=true; seq.forEach(ms=>{if(on)setTimeout(()=>vibrateOnce(ms),d);d+=ms;on=!on;}); }
function hapticForLevel(level) { if(level==='urgent')vibrate('triple'); else if(level==='warning')vibrate('single'); }

// ── LOCATION ─────────────────────────────────────────────────
async function updateAddress(lat, lng) {
  try {
    const r = await fetch(`${BACKEND}/location/address?lat=${lat}&lng=${lng}`, { headers:{'ngrok-skip-browser-warning':'true'} });
    const d = await r.json();
    cachedAddress = (d.address && d.address !== 'Unknown location') ? d.address : `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  } catch { cachedAddress = `${lat.toFixed(4)}, ${lng.toFixed(4)}`; }
  return cachedAddress;
}

function initLocation() {
  if (!navigator.geolocation) { showAlert('warning','GPS not supported.'); return; }
  if (geoWatchId !== null) return;
  navigator.geolocation.getCurrentPosition(async pos => {
    userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    const addr = await updateAddress(userLocation.lat, userLocation.lng);
    showAlert('safe', `📍 ${addr}`);
    geoWatchId = navigator.geolocation.watchPosition(
      async pos => {
        userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        await updateAddress(userLocation.lat, userLocation.lng);
        if (navActive) checkNavProgress();
      },
      err => {
        const m = {1:'Location denied.',2:'GPS unavailable.',3:'GPS timed out.'};
        showAlert('warning', m[err.code]||'GPS error.');
        if (err.code===3) { if(geoWatchId!==null){navigator.geolocation.clearWatch(geoWatchId);geoWatchId=null;} setTimeout(initLocation,4000); }
      },
      { enableHighAccuracy:true, maximumAge:0, timeout:20000 }
    );
  },
  err => {
    const m = {1:'Location denied.',2:'GPS unavailable.',3:'GPS timed out.'};
    showAlert('warning', m[err.code]||'GPS failed.');
    if (err.code===3) setTimeout(initLocation,4000);
  },
  { enableHighAccuracy:true, timeout:15000, maximumAge:0 });
}

function haversine(lat1,lng1,lat2,lng2){const R=6371000,p1=lat1*Math.PI/180,p2=lat2*Math.PI/180,dp=(lat2-lat1)*Math.PI/180,dl=(lng2-lng1)*Math.PI/180,a=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));}

// ── CAMERA ────────────────────────────────────────────────────
async function startCamera() {
  try {
    if (stream) stream.getTracks().forEach(t=>t.stop());
    stream = await navigator.mediaDevices.getUserMedia({ video:{facingMode,width:{ideal:1280},height:{ideal:720}}, audio:false });
    video.srcObject=stream; noCam.style.display='none'; return true;
  } catch { showAlert('urgent','Camera access denied.'); return false; }
}
btnFlip.addEventListener('click', async () => { facingMode=facingMode==='environment'?'user':'environment'; await startCamera(); });

function captureFrame() {
  canvas.width=video.videoWidth||640; canvas.height=video.videoHeight||480;
  ctx.drawImage(video,0,0);
  const scale=Math.min(1,512/canvas.width),w=Math.round(canvas.width*scale),h=Math.round(canvas.height*scale);
  const s=document.createElement('canvas'); s.width=w; s.height=h;
  s.getContext('2d').drawImage(canvas,0,0,w,h);
  return s.toDataURL('image/jpeg',0.7).split(',')[1];
}

async function analyzeFrame(b64, signal) {
  const res=await fetch(`${BACKEND}/analyze`,{method:'POST',headers:{'Content-Type':'application/json','ngrok-skip-browser-warning':'true'},body:JSON.stringify({image:b64}),signal});
  if(!res.ok) throw new Error(`${res.status}`);
  return await res.json();
}

// ── UI ────────────────────────────────────────────────────────
function setGlow(s)       { glowBorder.className=s; }
function setStatus(s,lbl) { statusPill.className='status-pill '+s; statusPill.textContent=lbl||s.toUpperCase(); }
function showAlert(level,message) {
  alertBox.className=`visible ${level}`; alertTypeEl.textContent=level.toUpperCase();
  alertMsgEl.textContent=message; alertTimeEl.textContent=new Date().toLocaleTimeString();
  if(!navActive){
    if(level==='urgent') setGlow('urgent');
    else if(level==='warning') setGlow('warning');
    else setGlow('idle');
    if(level!=='urgent') setTimeout(()=>{if(!commandMode&&!navActive)setGlow('idle');},3000);
  }
}

// ── SCAN LOOP ─────────────────────────────────────────────────
async function doScan() {
  if(commandMode||isScanning) return;
  isScanning=true; scanAbort=new AbortController();
  scanLine.classList.add('running');
  if(!navActive) setStatus('scanning','SCANNING');
  try {
    const b64=captureFrame(), result=await analyzeFrame(b64,scanAbort.signal);
    if(commandMode) return;
    frameCount++; frameCountEl.textContent=`FRAMES ANALYZED: ${frameCount}`;
    showAlert(result.level,result.message); hapticForLevel(result.level);
    if(userLocation) fetch(`${BACKEND}/location/update`,{method:'POST',headers:{'Content-Type':'application/json','ngrok-skip-browser-warning':'true'},body:JSON.stringify({...userLocation,level:result.level,message:result.message})}).catch(()=>{});
    const voiceOn=document.getElementById('voiceAlerts').checked, silent=document.getElementById('silentSafe').checked;
    if(voiceOn&&!commandMode&&(result.level!=='safe'||!silent)) speak(result.message);
  } catch(e){ if(e.name!=='AbortError'&&!commandMode) showAlert('urgent',`Error: ${e.message}`); }
  finally { isScanning=false; scanAbort=null; scanLine.classList.remove('running'); if(!commandMode&&!navActive) setStatus('active','LIVE'); }
}

// ── START / STOP ──────────────────────────────────────────────
btnStart.addEventListener('click', async () => {
  unlockAudio(); // creates + unlocks AudioContext on this user gesture
  const ok=await startCamera(); if(!ok) return;
  initLocation();
  btnStart.style.display='none'; btnStop.style.display='flex';
  setStatus('active','LIVE');
  showAlert('safe','BirdBox active. Say "Hey BirdBox" anytime.');
  wakeHint.classList.remove('hidden'); setTimeout(()=>wakeHint.classList.add('hidden'),4000);
  startWakeLoop(); await doScan();
  scanInterval=setInterval(doScan,intervalMs);
});

btnStop.addEventListener('click', ()=>{
  clearInterval(scanInterval); scanInterval=null;
  stopWakeLoop(); stopNavigation(); stopKeepAlive();
  if(stream) stream.getTracks().forEach(t=>t.stop());
  stream=null; video.srcObject=null;
  noCam.style.display='flex'; btnStop.style.display='none'; btnStart.style.display='flex';
  setStatus('','OFFLINE'); setGlow('idle'); alertBox.className=''; cancelSpeech();
});

// ── WAKE WORD ─────────────────────────────────────────────────
function startWakeLoop(){ if(!('webkitSpeechRecognition' in window||'SpeechRecognition' in window))return; wakeActive=true; runWakeSession(); }
function stopWakeLoop(){ wakeActive=false; if(wakeRecog){try{wakeRecog.stop();}catch{}wakeRecog=null;} }
function runWakeSession(){
  if(!wakeActive||commandMode) return;
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  wakeRecog=new SR(); wakeRecog.continuous=false; wakeRecog.interimResults=true; wakeRecog.lang='en-US'; wakeRecog.maxAlternatives=3;
  wakeRecog.onresult=e=>{ for(let i=0;i<e.results.length;i++) for(let j=0;j<e.results[i].length;j++){const t=e.results[i][j].transcript.toLowerCase().trim(); if(WAKE_WORDS.some(w=>t.includes(w))){wakeRecog.abort();if(!commandMode)activateCommand();return;}} };
  wakeRecog.onend=()=>{ if(wakeActive&&!commandMode) setTimeout(runWakeSession,300); };
  wakeRecog.onerror=e=>{ if(e.error!=='aborted'&&wakeActive&&!commandMode) setTimeout(runWakeSession,1000); };
  try{wakeRecog.start();}catch{setTimeout(runWakeSession,1000);}
}

// ── COMMAND MODE ──────────────────────────────────────────────
function playChime(){
  if(!actx) return;
  try{
    [880,1100].forEach((freq,i)=>{
      const osc=actx.createOscillator(), gain=actx.createGain();
      osc.connect(gain); gain.connect(actx.destination); osc.frequency.value=freq;
      const t=actx.currentTime+i*.15;
      gain.gain.setValueAtTime(.3,t); gain.gain.exponentialRampToValueAtTime(.001,t+.3);
      osc.start(t); osc.stop(t+.3);
    });
  }catch{}
}

function activateCommand(){
  commandMode=true; if(scanAbort){scanAbort.abort();scanAbort=null;} cancelSpeech();
  vibrate('single'); playChime(); setGlow('listening'); setStatus('listening','LISTENING');
  voiceBox.classList.add('visible'); userTranscript.textContent=''; aiTranscript.textContent='Listening...';
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition, cmd=new SR();
  cmd.continuous=false; cmd.interimResults=false; cmd.lang='en-US'; cmd.maxAlternatives=1;
  let gotResult=false;
  cmd.onresult=async e=>{ gotResult=true; const text=e.results[0][0].transcript; userTranscript.textContent=`You: ${text}`; aiTranscript.textContent='Thinking...'; setGlow('speaking'); setStatus('speaking','RESPONDING'); await handleVoiceCommand(text); endCommand(); };
  cmd.onerror=()=>{ if(!gotResult) endCommand(); };
  cmd.onend=()=>{ if(!gotResult) endCommand(); };
  setTimeout(()=>{ try{cmd.start();}catch{endCommand();} },300);
}

function endCommand(){
  commandMode=false;
  if(navActive){setGlow('navigating');setStatus('navigating','NAVIGATING');}
  else{setGlow('idle');setStatus('active','LIVE');}
  // Always return to wake-word listening — never auto-prompt
  setTimeout(()=>{ voiceBox.classList.remove('visible'); if(wakeActive) runWakeSession(); },5000);
}

// ── VOICE COMMAND HANDLER ─────────────────────────────────────
async function handleVoiceCommand(text){
  const lower=text.toLowerCase();

  // Navigation intent
  const navMatch=lower.match(/(?:take me to|navigate to|go to|directions to|direct me to|bring me to|get me to|walk me to|lead me to|i want to go to|how do i get to|find me (?:a |an |the )?|find (?:a |an |the )?|nearest |closest |where is (?:the |a |an )?|where('s| is) (?:the |a |an )?|i need (?:a |an |the )?)\s*(.+)/i);
  if(navMatch){
    const query=(navMatch[2]||navMatch[1]||'').trim().replace(/\?+$/,'');
    if(!query){await speak('What place are you looking for?');return;}
    aiTranscript.textContent='BirdBox: Getting your location...';
    const freshLocation=await new Promise(resolve=>{
      if(!navigator.geolocation){resolve(userLocation);return;}
      navigator.geolocation.getCurrentPosition(
        pos=>resolve({lat:pos.coords.latitude,lng:pos.coords.longitude}),
        ()=>resolve(userLocation),
        {enableHighAccuracy:true,timeout:8000,maximumAge:0}
      );
    });
    if(!freshLocation){await speak('I need your location first. Please enable GPS and try again.');return;}
    userLocation=freshLocation;
    aiTranscript.textContent=`BirdBox: Searching for ${query} nearby...`;
    await speak(`Searching for ${query} nearby.`);
    try{
      const res=await fetch(`${BACKEND}/navigate`,{method:'POST',headers:{'Content-Type':'application/json','ngrok-skip-browser-warning':'true'},body:JSON.stringify({query,user_lat:userLocation.lat,user_lng:userLocation.lng})});
      const data=await res.json();
      if(!data.places?.length){aiTranscript.textContent=`BirdBox: Sorry, couldn't find ${query} nearby.`;await speak(`Sorry, I couldn't find ${query} nearby.`);return;}
      window._navPlaces=data.places;
      aiTranscript.textContent=`BirdBox: ${data.speech}`;
      // Speak options then return to idle — user says "Hey BirdBox, option 1" to pick
      await speak(data.speech);
    }catch(e){console.error('Nav:',e);await speak('Sorry, there was an error searching for locations.');}
    return;
  }

  // Option selection — triggered when user says "Hey BirdBox, option 1" etc
  if(window._navPlaces&&/option\s*[123]|first|second|third|one|two|three/i.test(lower)){
    let idx=0; if(/option\s*2|second|two/i.test(lower))idx=1; if(/option\s*3|third|three/i.test(lower))idx=2;
    const place=window._navPlaces[idx]; if(place){window._navPlaces=null;await startNavigation(place);return;}
  }

  // Stop navigation
  if(/stop|cancel|end navigation/i.test(lower)){stopNavigation();await speak('Navigation stopped.');return;}

  // General chat
  try{
    conversationHistory.push({role:'user',content:text});
    if(conversationHistory.length>10) conversationHistory.splice(0,2);
    const res=await fetch(`${BACKEND}/chat/stream`,{method:'POST',headers:{'Content-Type':'application/json','ngrok-skip-browser-warning':'true'},body:JSON.stringify({message:text,history:conversationHistory.slice(0,-1),location:userLocation?{lat:userLocation.lat,lng:userLocation.lng,address:cachedAddress}:null})});
    if(!res.ok){aiTranscript.textContent=`BirdBox: Error ${res.status}`;speakBrowser('Sorry, server error.',()=>{});return;}
    const reader=res.body.getReader(),decoder=new TextDecoder(); let reply='';
    while(true){
      const{done,value}=await reader.read(); if(done)break;
      for(const line of decoder.decode(value).split('\n')){
        if(!line.startsWith('data: '))continue;
        const d=line.slice(6).trim(); if(d==='[DONE]')break;
        try{const j=JSON.parse(d);if(j.type==='content_block_delta'){reply+=j.delta?.text||'';aiTranscript.textContent=`BirdBox: ${reply}`;}}catch{}
      }
    }
    if(reply){
      conversationHistory.push({role:'assistant',content:reply.trim()});
      const navTrigger=reply.match(/starting navigation to (.+)/i);
      if(navTrigger&&userLocation){
        const q=navTrigger[1].replace(/[.!?]$/,'').trim();
        await speak(reply.trim());
        setTimeout(async()=>{await handleVoiceCommand(`navigate to ${q}`);},300);
        return;
      }
      await speak(reply.trim());
      // Log fire-and-forget
      fetch(`${BACKEND}/chat`,{method:'POST',headers:{'Content-Type':'application/json','ngrok-skip-browser-warning':'true'},body:JSON.stringify({message:text,location:null,log_only:true,ai_response:reply.trim()})}).catch(()=>{});
      // No auto-prompt — user says "Hey BirdBox" to continue
    }
  }catch(e){console.error('Chat:',e);await speak('Sorry, I could not connect to the server.');}
}

// ── NAVIGATION ────────────────────────────────────────────────
async function startNavigation(place){
  if(!userLocation){await speak('Location not available yet.');return;}
  await speak(`Starting navigation to ${place.name}.`);
  try{
    const res=await fetch(`${BACKEND}/directions?origin_lat=${userLocation.lat}&origin_lng=${userLocation.lng}&dest_lat=${place.lat}&dest_lng=${place.lng}`,{headers:{'ngrok-skip-browser-warning':'true'}});
    const data=await res.json();
    if(!data.steps?.length){await speak('Could not get directions.');return;}
    navActive=true; navSteps=data.steps; navStepIndex=0; navDest={lat:place.lat,lng:place.lng}; navDestName=place.name; lastAnnouncedStep=-1;
    navDestEl.textContent=`→ ${place.name}`; navTotalEl.textContent=`${data.total_distance} · ${data.total_duration}`;
    navBar.classList.add('visible'); setGlow('navigating'); setStatus('navigating','NAVIGATING');
    await announceStep(0);
  }catch{await speak('Sorry, could not load directions.');}
}

async function announceStep(index){
  if(index>=navSteps.length)return;
  const step=navSteps[index]; lastAnnouncedStep=index;
  navStepEl.textContent=step.instruction; navStepDistEl.textContent=step.distance_text;
  vibrate('nav'); await speak(step.instruction);
}

async function checkNavProgress(){
  if(!navActive||!userLocation||navStepIndex>=navSteps.length)return;
  const step=navSteps[navStepIndex];
  const distToStep=haversine(userLocation.lat,userLocation.lng,step.end_lat,step.end_lng);
  const distToDest=haversine(userLocation.lat,userLocation.lng,navDest.lat,navDest.lng);
  navStepDistEl.textContent=`${Math.round(distToStep)}m away`;
  if(distToDest<25){vibrate('arrived');await speak(`You have arrived at ${navDestName}!`);stopNavigation();return;}
  if(distToStep<20&&navStepIndex!==lastAnnouncedStep){lastAnnouncedStep=navStepIndex;navStepIndex++;if(navStepIndex<navSteps.length)await announceStep(navStepIndex);return;}
  if(distToStep<40&&distToStep>=20&&navStepIndex!==lastAnnouncedStep){
    const upcoming=navSteps[navStepIndex];
    if(/turn|left|right|cross|continue/i.test(upcoming.instruction)){lastAnnouncedStep=navStepIndex;await speak(`In ${Math.round(distToStep)} meters, ${upcoming.instruction}`);vibrate('nav');}
  }
}

function stopNavigation(){
  navActive=false; navSteps=[]; navStepIndex=0; navDest=null;
  navBar.classList.remove('visible'); setGlow('idle');
  if(stream) setStatus('active','LIVE'); window._navPlaces=null;
}