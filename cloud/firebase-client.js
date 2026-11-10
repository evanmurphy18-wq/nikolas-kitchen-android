// Nikola's Kitchen: optional shared shopping list. Private data is stored in Cloud Firestore.
// Firebase config is a public project identifier, NOT a password or private key.
import {initializeApp} from 'firebase/app';
import {getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut} from 'firebase/auth';
import {initializeFirestore, persistentLocalCache, persistentSingleTabManager, getFirestore, doc, getDoc, setDoc, deleteDoc, collection, onSnapshot, serverTimestamp} from 'firebase/firestore';

(function(){
  'use strict';
  const REPO='https://github.com/evanmurphy18-wq/nikolas-kitchen-android';
  const PREFIX='nk4:';
  const cfg=window.NK_CLOUD_CONFIG;
  let auth=null, db=null, user=null, household=null, unsubList=null, unsubUser=null, flushing=false, status='Local only', loading=false, firebaseApp=null;
  let localShoppingSnapshot=null;
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
    return count?`☁️ Shared with household · ${count} change${count===1?'':'s'} pending`:'☁️ Shared household · Live updates on';
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
  function stopWatching(){if(unsubList){unsubList();unsubList=null;}if(unsubUser){unsubUser();unsubUser=null;}}
  function leaveSharedView(){stopWatching();household=null;try{const s=JSON.parse(localStorage.getItem(PREFIX+'local-shopping')||'[]');setLocalShopping(s)}catch(_){setLocalShopping([])}updateStatus();}
  async function watchHousehold(id){
    stopWatching();household={id};backupPersonalList();
    message('Connecting to household…');
    try{
      const shared=await getDoc(doc(db,'households',id));
      if(!shared.exists())throw Error('Household not found');
      household={id,...shared.data()};
      unsubList=onSnapshot(collection(db,'households',id,'shopping'),snap=>{
        const remote=snap.docs.map(d=>({id:d.id,text:d.data().text||'',done:Boolean(d.data().done)}));
        setLocalShopping(blend(remote));
        flush();
      },e=>message(err(e)));
      message('Shared household connected');
    }catch(e){message(err(e));household=null;}
    updateStatus();
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
    return `<div class="eyebrow">LIVE HOUSEHOLD SHOPPING</div><h2>${escape(household.name||'Our Kitchen')} ☁️</h2>${badge}<p>Both phones see additions, checkmarks and deletions automatically. Offline changes queue and sync when you reconnect.</p><div class="household-field"><label>Invitation for Nikola (keep private)</label><textarea id="nk-invite-output" readonly class="backup-text" style="height:74px">${escape(code)}</textarea></div><button class="btn full" onclick="NKCloud.copyInvite()">Copy invitation code</button><button class="btn outline full" style="margin-top:8px" onclick="NKCloud.importLocal()">Add my old personal shopping items</button><button class="btn outline full" style="margin-top:8px" onclick="openShopping()">Open shared shopping list</button><p class="cloud-help">Signed in as ${escape(user.email||'account')}. Inventory and meal plans are still stored only on this phone.</p><button class="btn ghost full" onclick="NKCloud.unshare()">Disconnect this phone from household</button><button class="btn ghost full" onclick="NKCloud.logout()">Sign out</button>`;
  }
  function open(){window.showModal(html());}
  window.NKCloud={statusText,isSharing,mutate,open,html,register,login,logout,makeHousehold,joinHousehold,copyInvite,unshare,importLocal};
  init();
})();
