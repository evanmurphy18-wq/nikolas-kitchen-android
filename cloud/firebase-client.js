// Nikola's Kitchen: opt-in household shopping and food inventory sync. Cloud data is private.
// Firebase config is a public project identifier, NOT a password or private key.
import {initializeApp} from 'firebase/app';
import {getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut} from 'firebase/auth';
import {initializeFirestore, persistentLocalCache, persistentSingleTabManager, getFirestore, doc, getDoc, setDoc, deleteDoc, collection, onSnapshot, serverTimestamp, writeBatch, increment} from 'firebase/firestore';

(function(){
  'use strict';
  const REPO='https://github.com/evanmurphy18-wq/nikolas-kitchen-android';
  const PREFIX='nk4:';
  const cfg=window.NK_CLOUD_CONFIG;
  let auth=null, db=null, user=null, household=null, unsubList=null, unsubUser=null, flushing=false, status='Local only', loading=false, firebaseApp=null;
  let localShoppingSnapshot=null;
  let inventoryAvailable=false, inventoryEnabled=false, inventoryLoaded=false;
  let unsubInventorySettings=null, unsubInventory=null;
  const inventoryKey=()=>PREFIX+'inventory-enabled:'+(user?.uid||'')+':'+(household?.id||'');
  const inventoryRef=id=>doc(db,'households',household.id,'inventory',id);
  const validInventoryId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,140}$/.test(id);
  const text=s=>String(s??'');
  const escape=s=>text(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const escapeAttr=escape;
  const randomToken=(n=20)=>{const a=new Uint8Array(n);crypto.getRandomValues(a);return Array.from(a,b=>b.toString(16).padStart(2,'0')).join('');};
  const ready=()=>Boolean(auth&&db&&user&&household);
  const pendingKey=()=>PREFIX+'pending:'+user.uid+':'+household.id;
  const readQueue=()=>{try{return JSON.parse(localStorage.getItem(pendingKey())||'[]')}catch(_){return [];}};
  const writeQueue=q=>{try{localStorage.setItem(pendingKey(),JSON.stringify(q))}catch(_){status='Storage full — export a backup';}};
  const message=(value)=>{status=value;updateStatus();};
  const updateStatus=()=>{const el=document.getElementById('shop-cloud-status');if(el)el.innerHTML=escape(statusText())+' <span style="margin-left:auto">›</span>';};
  const err=e=>{
    const c=text(e?.code||'');
    if(c.includes('email-already-in-use'))return 'An account already uses that email. Choose Sign in.';
    if(c.includes('invalid-email'))return 'Enter a valid email address.';
    if(c.includes('weak-password'))return 'Use a stronger password (at least 6 characters).';
    if(c.includes('invalid-credential')||c.includes('wrong-password'))return 'Email or password is incorrect.';
    if(c.includes('permission-denied'))return 'Cloud access denied. Check the Firestore security rules and household invitation.';
    if(c.includes('network')||!navigator.onLine)return 'Internet unavailable. Your local list is still saved.';
    return 'Cloud error: '+(c||text(e?.message||'Unknown error').slice(0,150));
  };
  function statusText(){
    if(!cfg?.apiKey)return '☁️ Local list · Shared cloud not configured';
    if(!user)return '☁️ Personal list · Sign in to share';
    if(!household)return '☁️ Signed in · Choose a household';
    if(!navigator.onLine)return '☁️ Offline · Changes will sync on reconnect';
    const count=readQueue().length;
    if(count)return `☁️ Shared household · ${count} shopping change${count===1?'':'s'} pending`;
    return inventoryEnabled?(inventoryLoaded?'☁️ Shopping + food stock · Live sync':'☁️ Connecting shared food stock…'):'☁️ Shared shopping · Live updates on';
  }
  function isSharing(){return ready();}
  function setLocalShopping(newItems){
    if(!Array.isArray(newItems))return;
    window.NKHost.setShopping(newItems);
    updateStatus();
  }
  function blend(remote){
    const entries=new Map(remote.map(i=>[i.id,i]));
    for(const action of readQueue()){
      if(action.type==='put'&&action.item)entries.set(action.item.id,{...action.item});
      if(action.type==='delete')entries.delete(action.id);
    }
    return Array.from(entries.values()).sort((a,b)=>text(a.text).localeCompare(text(b.text)));
  }
  function backupPersonalList(){
    if(localShoppingSnapshot!==null)return;
    const prior=localStorage.getItem(PREFIX+'local-shopping');
    if(prior){try{localShoppingSnapshot=JSON.parse(prior);return;}catch(_){}}
    localShoppingSnapshot=window.NKHost.getShopping();
    localStorage.setItem(PREFIX+'local-shopping',JSON.stringify(localShoppingSnapshot));
  }
  function stopInventory(){
    if(unsubInventory){unsubInventory();unsubInventory=null;}
    if(unsubInventorySettings){unsubInventorySettings();unsubInventorySettings=null;}
    inventoryAvailable=false;inventoryEnabled=false;inventoryLoaded=false;
  }
  function stopWatching(){
    if(unsubList){unsubList();unsubList=null;}
    if(unsubUser){unsubUser();unsubUser=null;}
    stopInventory();
  }
  function leaveSharedView(){stopWatching();household=null;try{const s=JSON.parse(localStorage.getItem(PREFIX+'local-shopping')||'[]');setLocalShopping(s)}catch(_){setLocalShopping([])}updateStatus();}
  async function watchHousehold(id){
    stopWatching();household={id};backupPersonalList();
    message('Connecting to household…');
    try{
      const shared=await getDoc(doc(db,'households',id));
      if(!shared.exists())throw Error('Household not found');
      household={id,...shared.data()};
      watchInventorySetup();
      unsubList=onSnapshot(collection(db,'households',id,'shopping'),snap=>{
        const remote=snap.docs.map(d=>({id:d.id,text:d.data().text||'',done:Boolean(d.data().done)}));
        setLocalShopping(blend(remote));
        flush();
      },e=>message(err(e)));
      message('Shared household connected');
    }catch(e){message(err(e));household=null;}
    updateStatus();
  }

  // Each inventory item is stored separately; other foods can be updated
  // independently, while quantity adjustments use atomic increments.
  function inventoryEntries(snapshot){
    const docs=new Map();
    const custom=new Map((snapshot.custom||[]).filter(i=>validInventoryId(i?.id)).map(i=>[i.id,i]));
    const meta=snapshot.meta||{};
    const stock=snapshot.stock||{};
    for(const id of new Set([...Object.keys(stock),...custom.keys(),...Object.keys(meta)])){
      if(!validInventoryId(id))continue;
      const qty=Number(stock[id]??custom.get(id)?.qty??0);
      if(!Number.isFinite(qty)||qty<0||qty>100000)continue;
      const value={qty};
      if(custom.has(id))value.custom=custom.get(id);
      if(meta[id]&&typeof meta[id]==='object'&&!Array.isArray(meta[id]))value.meta=meta[id];
      docs.set(id,value);
    }
    return docs;
  }
  function watchInventorySetup(){
    if(!ready())return;
    const ref=doc(db,'households',household.id,'settings','inventory');
    unsubInventorySettings=onSnapshot(ref,snap=>{
      inventoryAvailable=Boolean(snap.exists()&&snap.data()?.enabled);
      if(inventoryAvailable&&localStorage.getItem(inventoryKey())==='yes')startInventory();
      updateStatus();
    },e=>message(err(e)));
  }
  function startInventory(){
    if(!ready()||unsubInventory||!inventoryAvailable)return;
    inventoryEnabled=true;inventoryLoaded=false;updateStatus();
    const hid=household.id;
    unsubInventory=onSnapshot(collection(db,'households',hid,'inventory'),{includeMetadataChanges:true},snap=>{
      if(!inventoryLoaded&&snap.metadata.fromCache)return;
      inventoryLoaded=true;
      const stock={}, custom=[], meta={};
      for(const entry of snap.docs){
        const d=entry.data(),id=entry.id;
        if(!validInventoryId(id)||typeof d.qty!=='number'||!Number.isFinite(d.qty)||d.qty<0||d.qty>100000)continue;
        stock[id]=d.qty;
        if(d.custom&&typeof d.custom==='object'&&d.custom.id===id)custom.push(d.custom);
        if(d.meta&&typeof d.meta==='object')meta[id]=d.meta;
      }
      window.NKHost?.setInventory({stock,custom,meta});
      updateStatus();
    },e=>message(err(e)));
  }
  function inventoryChanged(before,after){
    if(!ready()||!inventoryEnabled)return;
    const previous=inventoryEntries(before),current=inventoryEntries(after);
    for(const [id,oldData] of previous){
      if(!current.has(id)&&id.startsWith('custom_'))deleteDoc(inventoryRef(id)).catch(e=>message(err(e)));
    }
    for(const [id,data] of current){
      const old=previous.get(id);
      if(JSON.stringify(old)===JSON.stringify(data))continue;
      const payload={updatedBy:user.uid,updatedAt:serverTimestamp()};
      if(!old){
        Object.assign(payload,data);
      }else{
        const delta=Number((data.qty-old.qty).toFixed(4));
        if(delta!==0)payload.qty=increment(delta);
        if(JSON.stringify(data.custom||null)!==JSON.stringify(old.custom||null))payload.custom=data.custom||null;
        if(JSON.stringify(data.meta||null)!==JSON.stringify(old.meta||null))payload.meta=data.meta||null;
      }
      setDoc(inventoryRef(id),payload,{merge:true}).catch(e=>message(err(e)));
    }
  }
  async function publishInventory(){
    if(!ready()||household.ownerUid!==user.uid||inventoryAvailable)return;
    if(!confirm('Use THIS phone as the starting freezer, fridge and pantry for your household? Finish imports and export a backup first. This uploads your current quantities and food details.'))return;
    try{
      const config=doc(db,'households',household.id,'settings','inventory');
      if((await getDoc(config)).exists()){window.toast('Shared inventory already exists. Reopen household settings.');return;}
      const entries=Array.from(inventoryEntries(window.NKHost.getInventory()));
      for(let i=0;i<entries.length;i+=300){
        const batch=writeBatch(db);
        for(const [id,data] of entries.slice(i,i+300)){
          batch.set(inventoryRef(id),{...data,updatedBy:user.uid,updatedAt:serverTimestamp()});
        }
        await batch.commit();
      }
      await setDoc(config,{enabled:true,ownerUid:user.uid,startedAt:serverTimestamp()});
      inventoryAvailable=true;
      localStorage.setItem(inventoryKey(),'yes');
      startInventory();
      window.toast('Freezer, fridge and pantry are ready to share ✓');
      open();
    }catch(e){window.toast(err(e));}
  }
  function joinInventory(){
    if(!ready()||!inventoryAvailable||inventoryEnabled)return;
    if(!confirm('Replace the freezer, fridge and pantry on THIS phone with your household inventory? Export a backup first if this phone has food you need to keep.'))return;
    localStorage.setItem(inventoryKey(),'yes');
    startInventory();
    window.toast('Connecting to household food inventory ✓');
    open();
  }
  function pauseInventory(){
    if(!inventoryEnabled)return;
    if(!confirm('Stop syncing this phone’s freezer, fridge and pantry? Your current local food remains, but edits here will no longer update the other phone.'))return;
    localStorage.removeItem(inventoryKey());
    if(unsubInventory){unsubInventory();unsubInventory=null;}
    inventoryEnabled=false;inventoryLoaded=false;
    window.toast('Food stock sync paused on this phone');
    open();
  }

  async function handleAuth(next){
    if(!next){user=null;leaveSharedView();message('Signed out');return;}
    user=next;message('Signed in');
    try{
      const ref=doc(db,'users',user.uid);
      const snap=await getDoc(ref);
      if(snap.exists()&&snap.data().householdId)await watchHousehold(snap.data().householdId);
    }catch(e){message(err(e));}
    updateStatus();
  }
  async function init(){
    if(!cfg||!cfg.apiKey||!cfg.projectId||!cfg.appId){status='Cloud not configured';updateStatus();return;}
    try{
      firebaseApp=initializeApp(cfg,'nk4-shared-shopping');
      auth=getAuth(firebaseApp);
      try{db=initializeFirestore(firebaseApp,{localCache:persistentLocalCache({tabManager:persistentSingleTabManager()})});}
      catch(_){db=getFirestore(firebaseApp);}
      onAuthStateChanged(auth,handleAuth,e=>message(err(e)));
      window.addEventListener('online',()=>{if(ready())flush();updateStatus()});
      window.addEventListener('offline',updateStatus);
    }catch(e){message(err(e));}
  }
  async function register(){
    const email=document.getElementById('nk-email')?.value.trim();
    const pwd=document.getElementById('nk-pass')?.value||'';
    if(!email||pwd.length<6){window.toast('Enter your email and a password of 6+ characters.');return;}
    try{await createUserWithEmailAndPassword(auth,email,pwd);window.toast('Account created');open();}catch(e){window.toast(err(e));}
  }
  async function login(){
    const email=document.getElementById('nk-email')?.value.trim(),pwd=document.getElementById('nk-pass')?.value||'';
    if(!email||!pwd){window.toast('Enter email and password');return;}
    try{await signInWithEmailAndPassword(auth,email,pwd);window.toast('Signed in');open();}catch(e){window.toast(err(e));}
  }
  async function logout(){
    if(!auth)return;
    try{await signOut(auth);window.toast('Signed out of shared shopping');open();}catch(e){window.toast(err(e));}
  }
  async function makeHousehold(){
    if(!user||household)return;
    const name=document.getElementById('nk-house-name')?.value.trim().slice(0,60)||'Our Kitchen';
    const id=crypto.randomUUID();
    const key=randomToken(20);
    try{
      await setDoc(doc(db,'households',id),{ownerUid:user.uid,name,inviteKey:key,createdAt:serverTimestamp()});
      await setDoc(doc(db,'households',id,'members',user.uid),{joinKey:key,email:user.email||'',joinedAt:serverTimestamp()});
      await setDoc(doc(db,'users',user.uid),{householdId:id,updatedAt:serverTimestamp()});
      await watchHousehold(id);
      window.toast('Shared household created ✓');open();
    }catch(e){window.toast(err(e));}
  }
  async function joinHousehold(){
    if(!user||household)return;
    const code=(document.getElementById('nk-invite')?.value||'').trim();
    const parts=code.split('.');
    if(parts.length!==2||!/^[-0-9a-f]{36}$/.test(parts[0])||!/^[0-9a-f]{40}$/.test(parts[1])){window.toast('Paste the complete household invitation code.');return;}
    try{
      await setDoc(doc(db,'households',parts[0],'members',user.uid),{joinKey:parts[1],email:user.email||'',joinedAt:serverTimestamp()});
      await setDoc(doc(db,'users',user.uid),{householdId:parts[0],updatedAt:serverTimestamp()});
      await watchHousehold(parts[0]);window.toast('Joined the household ✓');open();
    }catch(e){window.toast(err(e));}
  }
  async function copyInvite(){
    if(!household||!household.inviteKey)return;
    const code=household.id+'.'+household.inviteKey;
    try{await navigator.clipboard.writeText(code);window.toast('Invitation code copied ✓');}
    catch(_){const input=document.getElementById('nk-invite-output');if(input){input.focus();input.select();document.execCommand('copy');window.toast('Code selected — copy it');}}
  }
  async function unshare(){
    if(!household||!user)return;
    if(!confirm('Leave this household on this phone? Your local inventory is not affected.'))return;
    try{await deleteDoc(doc(db,'users',user.uid));leaveSharedView();window.toast('Left shared shopping view');open();}
    catch(e){window.toast(err(e));}
  }
  function mutate(operation){
    if(!ready())return;
    const queue=readQueue();queue.push({...operation,operationId:randomToken(6)});
    writeQueue(queue.slice(-350));updateStatus();flush();
  }
  async function flush(){
    if(flushing||!ready()||!navigator.onLine)return;
    flushing=true;
    try{
      for(;;){const q=readQueue();if(!q.length)break;const op=q[0];
        try{
          const reference=doc(db,'households',household.id,'shopping',op.type==='put'?op.item.id:op.id);
          if(op.type==='delete')await deleteDoc(reference);
          else await setDoc(reference,{text:String(op.item.text).slice(0,120),done:Boolean(op.item.done),updatedBy:user.uid,updatedAt:serverTimestamp()},{merge:true});
          const latest=readQueue();const index=latest.findIndex(v=>v.operationId===op.operationId);if(index>=0){latest.splice(index,1);writeQueue(latest);}
        }catch(e){message(err(e));break;}
      }
    }finally{flushing=false;updateStatus();}
  }
  function importLocal(){
    if(!ready())return;
    let list=[];try{list=JSON.parse(localStorage.getItem(PREFIX+'local-shopping')||'[]')}catch(_){list=[];}
    if(!list.length){window.toast('No local shopping items to import');return;}
    if(!confirm(`Add ${list.length} items from your old personal shopping list to the shared household?`))return;
    for(const entry of list){if(entry&&entry.id&&entry.text)mutate({type:'put',item:{id:entry.id,text:entry.text,done:!!entry.done}});}
    window.toast('Import queued — will sync when online');open();
  }
  function html(){
    const badge=`<div class="cloud-status ${!ready()?'warn':''}">${escape(statusText())}</div>`;
    if(!cfg?.apiKey)return `<div class="eyebrow">SHARED SHOPPING</div><h2>Household cloud ☁️</h2>${badge}<p>This version includes live shopping-list sharing, but its Firebase backend has not yet been connected.</p><p>Once the household cloud service is configured, you and Nikola can each sign in and use a private shared list. Until then all shopping and inventory changes remain on this phone.</p><button class="btn outline full" onclick="closeModal()">Keep using locally</button>`;
    if(!user)return `<div class="eyebrow">HOUSEHOLD SHARING</div><h2>Share groceries together ☁️</h2>${badge}<p>Create an account or sign in. Each of you should use your own email address and password.</p><div class="household-field"><label>Email</label><input id="nk-email" type="email" autocomplete="email" placeholder="you@example.com"></div><div class="household-field"><label>Password</label><input id="nk-pass" type="password" autocomplete="current-password" placeholder="At least 6 characters"></div><button class="btn full" onclick="NKCloud.login()">Sign in</button><button class="btn outline full" style="margin-top:8px" onclick="NKCloud.register()">Create account</button><p class="cloud-help">This account is for shopping-list sharing only. Your recipes and inventory stay local on each phone.</p>`;
    if(!household)return `<div class="eyebrow">HOUSEHOLD SHARING</div><h2>Hello, ${escape(user.email||'there')}!</h2>${badge}<p>Create one household, then send Nikola its invitation code, or join an existing household with her code.</p><div class="household-field"><label>Household name</label><input id="nk-house-name" value="Our Kitchen" maxlength="60"></div><button class="btn full" onclick="NKCloud.makeHousehold()">Create household</button><div class="rule"></div><div class="household-field"><label>Enter a household invitation code</label><input id="nk-invite" placeholder="Paste the full code" autocomplete="off"></div><button class="btn outline full" onclick="NKCloud.joinHousehold()">Join a household</button><button class="btn ghost full" onclick="NKCloud.logout()">Sign out</button>`;
    const code=household.inviteKey?household.id+'.'+household.inviteKey:'';
    const inventoryControls=inventoryEnabled
      ? `<div class="cloud-status">🥫 Freezer, fridge and pantry syncing on this phone</div><button class="btn ghost full" onclick="NKCloud.pauseInventory()">Pause food stock sync on this phone</button>`
      :inventoryAvailable
        ? `<div class="cloud-status">🥫 Shared household food stock is available</div><button class="btn full" onclick="NKCloud.joinInventory()">Use shared freezer, fridge and pantry on this phone</button><p class="cloud-help">This replaces this phone's food stock, not your recipes or meal plans. Export a backup first.</p>`
        :household.ownerUid===user.uid
          ? `<div class="cloud-status">🥫 Food stock is currently private to each phone</div><button class="btn full" onclick="NKCloud.publishInventory()">Share this phone's freezer, fridge and pantry</button><p class="cloud-help">Finish importing all food first. This phone's stock becomes the starting household inventory. Export a backup before enabling.</p>`
          : `<p class="cloud-help">Food stock is not shared yet. The household creator can enable it once imports are finished.</p>`;
    return `<div class="eyebrow">HOUSEHOLD SHARING</div><h2>${escape(household.name||'Our Kitchen')} ☁️</h2>${badge}<p>Shopping items sync between both phones. You can also share the entire freezer, fridge and pantry.</p>${inventoryControls}<div class="household-field"><label>Invitation for Nikola (keep private)</label><textarea id="nk-invite-output" readonly class="backup-text" style="height:74px">${escape(code)}</textarea></div><button class="btn full" onclick="NKCloud.copyInvite()">Copy invitation code</button><button class="btn outline full" style="margin-top:8px" onclick="NKCloud.importLocal()">Add my old personal shopping items</button><button class="btn outline full" style="margin-top:8px" onclick="openShopping()">Open shared shopping list</button><p class="cloud-help">Signed in as ${escape(user.email||'account')}. Recipes, favourites and meal plans stay personal. Shared food quantities and details sync when enabled above.</p><button class="btn ghost full" onclick="NKCloud.unshare()">Disconnect this phone from household</button><button class="btn ghost full" onclick="NKCloud.logout()">Sign out</button>`;
  }
  function open(){window.showModal(html());}
  window.NKCloud={statusText,isSharing,mutate,inventoryChanged,publishInventory,joinInventory,pauseInventory,open,html,register,login,logout,makeHousehold,joinHousehold,copyInvite,unshare,importLocal};
  init();
})();
