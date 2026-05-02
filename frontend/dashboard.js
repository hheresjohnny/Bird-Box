const GOOGLE_MAPS_API_KEY = 'AIzaSyAfLt0wEer0nmX_WN3-1e--PWN18nJO91E';
  let ws=null,map=null,marker=null,circle=null,pulseCircle=null,mapsReady=false;
  let trailLine=null,trailCoords=[],obstacleDots=[];
  let lastTrailPos=null;
  let logCount=0,stats={total:0,warning:0,urgent:0},activeFilter='all',allEntries=[];
  let lastUpdateTime=null,statusAgeTimer=null;

  const clockEl=document.getElementById('clock');
  setInterval(()=>clockEl.textContent=new Date().toLocaleTimeString(),1000);
  clockEl.textContent=new Date().toLocaleTimeString();

  function startStatusAgeTimer(){
    clearInterval(statusAgeTimer);
    statusAgeTimer=setInterval(()=>{
      if(!lastUpdateTime)return;
      const s=Math.round((Date.now()-lastUpdateTime)/1000);
      document.getElementById('statusAge').textContent=s<5?'just now':`${s}s ago`;
    },1000);
  }

  const wsDot=document.getElementById('wsDot');
  const wsLabel=document.getElementById('wsLabel');
  const btnConn=document.getElementById('btnConnect');

  function setConnected(on){
    wsDot.className='ws-dot'+(on?' on':'');
    wsLabel.textContent=on?'Connected':'Disconnected';
    btnConn.textContent=on?'Disconnect':'Connect';
    btnConn.className='btn-connect'+(on?' disc':'');
    document.getElementById('connectHint').textContent=on
      ?'✓ Live — open BirdBox on the phone to start streaming.'
      :'Click Connect, then open BirdBox on your phone.';
  }

  btnConn.addEventListener('click',()=>{
    if(ws){ws.close();return;}
    const url=document.getElementById('wsUrl').value.trim();
    try{
      ws=new WebSocket(url);
      ws.onopen=()=>{setConnected(true);addLog('info','Connected to BirdBox backend');};
      ws.onclose=()=>{
        setConnected(false);ws=null;
        wsDot.className='ws-dot';
        document.getElementById('liveBadge').classList.remove('visible');
        addLog('info','Disconnected from backend');
      };
      ws.onerror=()=>addLog('urgent','WebSocket error — is the backend running?');
      ws.onmessage=(e)=>{try{handleMessage(JSON.parse(e.data));}catch{}};
    }catch{addLog('urgent','Invalid WebSocket URL');}
  });

  function handleMessage(data){
    if(data.type!=='location')return;
    document.getElementById('liveBadge').classList.add('visible');
    wsDot.className='ws-dot live';
    lastUpdateTime=Date.now();
    updateMap(data.lat,data.lng,data.level);
    updateStatus(data.level,data.message);
    if(data.message&&data.message!=='Location acquired'){
      addLog(data.level,data.message,data.lat,data.lng);
    }
    stats.total++;
    if(data.level==='warning')stats.warning++;
    if(data.level==='urgent')stats.urgent++;
    document.getElementById('statTotal').textContent=stats.total;
    document.getElementById('statWarn').textContent=stats.warning;
    document.getElementById('statUrgent').textContent=stats.urgent;
    document.getElementById('mapLastSeen').textContent='Last seen: '+new Date().toLocaleTimeString();
    document.getElementById('mapCoords').textContent=data.lat.toFixed(5)+', '+data.lng.toFixed(5);
  }

  const levelIcons={safe:'✅',warning:'⚠️',urgent:'🚨',info:'📡'};

  function updateStatus(level,message){
    document.getElementById('statusRing').className='status-ring '+level;
    document.getElementById('statusRing').textContent=levelIcons[level]||'📍';
    document.getElementById('statusLevel').className='status-lvl '+level;
    document.getElementById('statusLevel').textContent=level.charAt(0).toUpperCase()+level.slice(1);
    document.getElementById('statusMsg').textContent=message||'—';
    document.getElementById('statusTime').textContent=new Date().toLocaleTimeString();
    startStatusAgeTimer();
  }

  function addLog(level,message,lat,lng){
    const empty=document.getElementById('logEmpty');
    if(empty)empty.remove();
    logCount++;
    document.getElementById('logCount').textContent=`${logCount} event${logCount!==1?'s':''}`;
    allEntries.unshift({level,message,lat,lng,time:new Date()});
    if(allEntries.length>200)allEntries.pop();
    renderLog();
  }

  function renderLog(){
    const scroll=document.getElementById('logScroll');
    const filtered=allEntries.filter(e=>activeFilter==='all'||e.level===activeFilter);
    scroll.innerHTML='';
    if(!filtered.length){
      scroll.innerHTML=`<div class="log-empty">No ${activeFilter==='all'?'':activeFilter+' '}events yet.</div>`;
      return;
    }
    filtered.forEach(entry=>{
      const el=document.createElement('div');
      el.className=`log-entry ${entry.level}`;
      const coordStr=(entry.lat&&entry.lng)?`${entry.lat.toFixed(4)}, ${entry.lng.toFixed(4)}`:'';
      el.innerHTML=`
        <div class="log-row"><div class="log-msg">${entry.message}</div><div class="log-time">${entry.time.toLocaleTimeString()}</div></div>
        <div class="log-sub"><span class="log-lvl">${entry.level.toUpperCase()}</span>${coordStr?`<span class="log-coords">${coordStr}</span>`:''}</div>`;
      scroll.appendChild(el);
    });
  }

  document.querySelectorAll('.filter-pill').forEach(pill=>{
    pill.addEventListener('click',()=>{
      activeFilter=pill.dataset.filter;
      document.querySelectorAll('.filter-pill').forEach(p=>p.className='filter-pill');
      pill.className=`filter-pill active ${activeFilter}`;
      renderLog();
    });
  });

  window.initMap=function(){mapsReady=true;};
  const levelColors={safe:'#00e87a',warning:'#ffb020',urgent:'#ff4545',info:'#00e5c8'};

  function haversine2(lat1,lng1,lat2,lng2){
    const R=6371000,p1=lat1*Math.PI/180,p2=lat2*Math.PI/180;
    const dp=(lat2-lat1)*Math.PI/180,dl=(lng2-lng1)*Math.PI/180;
    const a=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
    return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
  }

  function updateMap(lat,lng,level){
    const placeholder=document.getElementById('map-placeholder');
    if(placeholder)placeholder.style.display='none';
    if(!mapsReady)return;
    const color=levelColors[level]||levelColors.safe;
    const pos={lat,lng};

    const shouldAddTrail = !lastTrailPos || haversine2(lastTrailPos.lat,lastTrailPos.lng,lat,lng) > 3;
    if(shouldAddTrail){ trailCoords.push(pos); lastTrailPos=pos; }

    if(!map){
      map=new google.maps.Map(document.getElementById('map'),{
        center:pos,zoom:17,mapTypeControl:false,streetViewControl:false,fullscreenControl:true,
        zoomControlOptions:{position:google.maps.ControlPosition.RIGHT_TOP},
        styles:[
          {elementType:'geometry',stylers:[{color:'#08101a'}]},
          {elementType:'labels.text.fill',stylers:[{color:'#4a6070'}]},
          {elementType:'labels.text.stroke',stylers:[{color:'#06090f'}]},
          {featureType:'road',elementType:'geometry',stylers:[{color:'#182030'}]},
          {featureType:'road',elementType:'geometry.stroke',stylers:[{color:'#0c1018'}]},
          {featureType:'road.highway',elementType:'geometry',stylers:[{color:'#1c2c44'}]},
          {featureType:'road.highway',elementType:'labels.text.fill',stylers:[{color:'#3c5068'}]},
          {featureType:'water',elementType:'geometry',stylers:[{color:'#040810'}]},
          {featureType:'poi',elementType:'geometry',stylers:[{color:'#0d1420'}]},
          {featureType:'poi.park',elementType:'geometry',stylers:[{color:'#0a1a12'}]},
          {featureType:'transit',elementType:'geometry',stylers:[{color:'#0d1420'}]},
          {featureType:'administrative',elementType:'geometry.stroke',stylers:[{color:'#182030'}]},
          {featureType:'landscape',elementType:'geometry',stylers:[{color:'#0d1420'}]},
        ]
      });

      trailLine=new google.maps.Polyline({
        path: new google.maps.MVCArray(trailCoords),
        map,
        strokeColor:'#00e5c8',
        strokeOpacity:0.7,
        strokeWeight:3,
        zIndex:2
      });

      marker=new google.maps.Marker({position:pos,map,title:'BirdBox User',
        icon:{path:google.maps.SymbolPath.CIRCLE,scale:10,fillColor:color,fillOpacity:1,strokeColor:'#06090f',strokeWeight:3},zIndex:10});
      circle=new google.maps.Circle({map,center:pos,radius:12,fillColor:color,fillOpacity:.12,strokeColor:color,strokeOpacity:.35,strokeWeight:1});
      pulseCircle=new google.maps.Circle({map,center:pos,radius:25,fillColor:color,fillOpacity:.05,strokeColor:color,strokeOpacity:.2,strokeWeight:1});
    } else {
      if(shouldAddTrail) trailLine.getPath().push(new google.maps.LatLng(lat,lng));

      marker.setPosition(pos);
      marker.setIcon({path:google.maps.SymbolPath.CIRCLE,scale:10,fillColor:color,fillOpacity:1,strokeColor:'#06090f',strokeWeight:3});
      circle.setCenter(pos);circle.setOptions({fillColor:color,strokeColor:color});
      pulseCircle.setCenter(pos);pulseCircle.setOptions({fillColor:color,strokeColor:color});
      map.panTo(pos);
    }

    if(level==='warning'||level==='urgent'){
      const dot=new google.maps.Marker({
        position:pos,map,
        icon:{path:google.maps.SymbolPath.CIRCLE,scale:5,fillColor:color,fillOpacity:0.9,strokeColor:'#06090f',strokeWeight:1.5},
        zIndex:5
      });
      obstacleDots.push(dot);
    }

    new google.maps.Geocoder().geocode({location:pos},(results,status)=>{
      if(status==='OK'&&results[0])document.getElementById('mapAddress').textContent=results[0].formatted_address;
    });
  }

  const s=document.createElement('script');
  s.src=`https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&callback=initMap`;
  s.async=true;s.defer=true;
  document.head.appendChild(s);