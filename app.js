var CLOUD=/^https:\/\/[^ ]+$/.test(CFG.url)&&CFG.key.length>30&&CFG.key.indexOf("PASTE")<0;
var USER="admin",PASS="sagarmatha123",CRED="sg_cred",KEY="sg_reports",SES="sg_session",editId=null,mem=[];
function lsGet(k){try{return JSON.parse(localStorage.getItem(k))||[]}catch(e){return[]}}
function lsSet(k,v){try{localStorage.setItem(k,JSON.stringify(v));return true}catch(e){return false}}
var RC=lsGet("sg_reports"),BC=lsGet("sg_bills"),SB={},CM={},dirty={},flushing=false,polling=false,pollT=null,firstPoll=true;
try{SB=JSON.parse(localStorage.getItem("sg_sb"))||{};dirty=JSON.parse(localStorage.getItem("sg_dirty"))||{}}catch(e){}
function sbSave(){try{localStorage.setItem("sg_sb",JSON.stringify(SB))}catch(e){}}
function dirtySave(){lsSet("sg_dirty",dirty)}
function setSync(st,msg){
  var e=document.getElementById("syncst");if(!e)return;
  e.style.color=st==="ok"?"#1e8e4e":st==="wait"?"#b7791f":"#c0392b";e.textContent="● "+msg
}
function byNew(a,b){return String(b.saved||"").localeCompare(String(a.saved||""))}
function sbFetch(path,opt,retried){
  opt=opt||{};var h=Object.assign({apikey:CFG.key,"Content-Type":"application/json"},opt.headers||{});
  if(SB.tok)h.Authorization="Bearer "+SB.tok;
  return fetch(CFG.url+path,Object.assign({},opt,{headers:h})).then(function(r){
    if(r.status===401&&!retried&&SB.ref)return sbRefresh().then(function(){return sbFetch(path,opt,true)});
    if(!r.ok)return r.text().then(function(t){var e=new Error(t||("HTTP "+r.status));e.status=r.status;throw e});
    return r.status===204?null:r.text().then(function(t){return t?JSON.parse(t):null})
  })
}
function sbAuth(grant,body){
  return fetch(CFG.url+"/auth/v1/token?grant_type="+grant,{method:"POST",headers:{apikey:CFG.key,"Content-Type":"application/json"},body:JSON.stringify(body)})
   .then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error_description||j.msg||j.message||"Login failed");return j})})
}
function sbRefresh(){
  return sbAuth("refresh_token",{refresh_token:SB.ref}).then(function(j){SB.tok=j.access_token;SB.ref=j.refresh_token;sbSave()})
   .catch(function(e){if(!navigator.onLine||/fetch|network/i.test(e.message))throw e;forceLogout();throw new Error("Session expired – please sign in again.")})
}
function forceLogout(){SB={};sbSave();stopPoll();setStaff(false);hideLogin();showLogin()}
function syncCol(kind,oldArr,newArr){
  var oldM={};oldArr.forEach(function(r){oldM[r.id]=JSON.stringify(r)});var newM={};
  newArr.forEach(function(r){newM[r.id]=1;if(oldM[r.id]!==JSON.stringify(r))dirty[r.id]={op:"set",kind:kind,rec:r}});
  oldArr.forEach(function(r){if(!newM[r.id])dirty[r.id]={op:"del",kind:kind,id:r.id}});
  dirtySave();if(CLOUD&&SB.tok)poll()
}
function load(){return RC.slice()}
function store(a){var old=RC;RC=a;var ok=lsSet("sg_reports",a);syncCol("report",old,a);return ok}
function flush(){
  if(flushing)return Promise.resolve();
  var keys=Object.keys(dirty);if(!keys.length)return Promise.resolve();
  flushing=true;var chain=Promise.resolve();
  keys.forEach(function(k){chain=chain.then(function(){
    var d=dirty[k];if(!d)return;
    var p=d.op==="set"?sbFetch("/rest/v1/records",{method:"POST",headers:{Prefer:"resolution=merge-duplicates,return=minimal"},body:JSON.stringify({id:d.rec.id,kind:d.kind,data:d.rec})})
                      :sbFetch("/rest/v1/records?id=eq."+encodeURIComponent(d.id),{method:"DELETE"});
    return p.then(function(){if(dirty[k]===d){delete dirty[k];dirtySave()}})
  })});
  return chain.then(function(){flushing=false},function(e){flushing=false;throw e})
}
function pageAll(path){
  var out=[];
  function next(off){return sbFetch(path+"&limit=1000&offset="+off).then(function(rows){rows=rows||[];out=out.concat(rows);return rows.length===1000?next(off+1000):out})}
  return next(0)
}
function rebuild(){
  var R={},B={};
  Object.keys(CM).forEach(function(id){var c=CM[id];(c.kind==="bill"?B:R)[id]=c.data});
  Object.keys(dirty).forEach(function(id){var d=dirty[id];var M=d.kind==="bill"?B:R;if(d.op==="set")M[id]=d.rec;else delete M[id]});
  var r=Object.keys(R).map(function(k){return R[k]}).sort(byNew),b=Object.keys(B).map(function(k){return B[k]}).sort(byNew);
  var ch=JSON.stringify(r)!==JSON.stringify(RC)||JSON.stringify(b)!==JSON.stringify(BC);
  RC=r;BC=b;lsSet("sg_reports",RC);lsSet("sg_bills",BC);if(ch)refreshViews()
}
function poll(){
  if(!CLOUD||!SB.tok||polling)return;polling=true;
  flush().then(function(){
    return pageAll("/rest/v1/records?select=id,kind,updated_at&order=id")
  }).then(function(metas){
    var seen={},changed=[];
    metas.forEach(function(m){seen[m.id]=1;if(!CM[m.id]||CM[m.id].up!==m.updated_at)changed.push(m)});
    if(firstPoll){ /* first time on this device: upload records that exist only on this device */
      firstPoll=false;
      if(!localStorage.getItem("sg_migrated")){
        RC.forEach(function(r){if(!seen[r.id])dirty[r.id]={op:"set",kind:"report",rec:r}});
        BC.forEach(function(r){if(!seen[r.id])dirty[r.id]={op:"set",kind:"bill",rec:r}});
        dirtySave();try{localStorage.setItem("sg_migrated","1")}catch(e){}
      }
    }
    Object.keys(CM).forEach(function(id){if(!seen[id])delete CM[id]});
    var chunks=[];for(var i=0;i<changed.length;i+=40)chunks.push(changed.slice(i,i+40));
    var chain=Promise.resolve();
    chunks.forEach(function(ch){chain=chain.then(function(){
      return sbFetch("/rest/v1/records?select=id,kind,data,updated_at&id=in.("+ch.map(function(m){return encodeURIComponent(m.id)}).join(",")+")").then(function(rows){
        (rows||[]).forEach(function(x){CM[x.id]={kind:x.kind,data:x.data,up:x.updated_at}})})})});
    return chain
  }).then(function(){
    rebuild();
    if(Object.keys(dirty).length)return flush().then(function(){setSync("ok","Synced")});
    setSync("ok","Synced")
  }).catch(function(e){
    rebuild();
    setSync("bad",navigator.onLine?"Sync problem: "+String(e.message||e).slice(0,80):"Offline – changes saved on this device, will upload when online")
  }).then(function(){polling=false;if(Object.keys(dirty).length&&navigator.onLine&&!flushing&&SB.tok)setTimeout(poll,4000)})
}
function startPoll(){if(!CLOUD||pollT)return;poll();pollT=setInterval(poll,5000)}
function stopPoll(){if(pollT){clearInterval(pollT);pollT=null}CM={};firstPoll=true}
document.addEventListener("visibilitychange",function(){if(!document.hidden)poll()});
window.addEventListener("online",poll);window.addEventListener("focus",poll);
function refreshViews(){
  try{
    fillRefList();
    if(!$("v-list").classList.contains("hide"))renderList();
    if(!$("v-bill").classList.contains("hide"))renderBills();
    if(!$("v-ref").classList.contains("hide"))renderRef()
  }catch(e){}
}
function $(i){return document.getElementById(i)}
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}

try{var _c=JSON.parse(localStorage.getItem(CRED));if(_c&&_c.u&&_c.p){USER=_c.u;PASS=_c.p}}catch(e){}
function saveCred(){
  if(CLOUD){
    var np2=$("a_new").value,cp2=$("a_conf").value,m2=$("a_msg");m2.style.color="var(--dg)";
    if(!np2||np2.length<6){m2.textContent="New password must be at least 6 characters.";return}
    if(np2!==cp2){m2.textContent="New passwords do not match.";return}
    sbFetch("/auth/v1/user",{method:"PUT",body:JSON.stringify({password:np2})}).then(function(){
      ["a_cur","a_new","a_conf"].forEach(function(i){$(i).value=""});m2.style.color="var(--ok,green)";m2.textContent="Password changed. Use it next time you sign in."
    }).catch(function(e){m2.textContent="Could not change password: "+String(e.message||e).slice(0,100)});return
  }
  var cur=$("a_cur").value,nu=$("a_user").value.trim(),np=$("a_new").value,cp=$("a_conf").value,m=$("a_msg");
  m.style.color="var(--dg)";
  if(cur!==PASS){m.textContent="Current password is wrong.";return}
  if(!nu){m.textContent="Username cannot be empty.";return}
  if(np&&np.length<6){m.textContent="New password must be at least 6 characters.";return}
  if(np&&np!==cp){m.textContent="New passwords do not match.";return}
  var p=np||PASS;
  try{localStorage.setItem(CRED,JSON.stringify({u:nu,p:p}))}catch(e){m.textContent="Could not save on this browser.";return}
  USER=nu;PASS=p;
  ["a_cur","a_new","a_conf"].forEach(function(i){$(i).value=""});
  m.style.color="var(--ok,green)";m.textContent="Saved. Use the new login next time."
}
function login(){
  if(CLOUD){
    $("lerr").textContent="Signing in…";
    sbAuth("password",{email:$("u").value.trim(),password:$("p").value}).then(function(j){
      SB={tok:j.access_token,ref:j.refresh_token,email:j.user&&j.user.email};sbSave();$("lerr").textContent="";showApp()
    }).catch(function(e){$("lerr").textContent=/invalid|credentials/i.test(e.message)?"Wrong email or password.":e.message});return
  }
  if($("u").value.trim()===USER&&$("p").value===PASS){try{sessionStorage.setItem(SES,"1")}catch(e){};showApp()}
  else $("lerr").textContent="Wrong username or password."
}
function setStaff(on){var _b=document.getElementById("syncst");if(_b)_b.style.display=on?"":"none";document.querySelectorAll(".staff").forEach(function(e){e.classList.toggle("hide",!on)});document.querySelectorAll(".pub").forEach(function(e){e.classList.toggle("hide",on)})}
function showLogin(){$("appView").classList.add("hide");$("loginView").classList.remove("hide");$("lerr").textContent=""}
function hideLogin(){$("loginView").classList.add("hide");$("appView").classList.remove("hide");$("p").value=""}
function logout(){if(CLOUD){SB={};sbSave();stopPoll();RC=[];BC=[];dirty={};try{localStorage.removeItem("sg_reports");localStorage.removeItem("sg_bills");localStorage.removeItem("sg_dirty");localStorage.removeItem("sg_migrated")}catch(e){}}try{sessionStorage.removeItem(SES)}catch(e){};$("p").value="";editId=null;setStaff(false);hideLogin();go("home")}
function showApp(){$("loginView").classList.add("hide");$("appView").classList.remove("hide");setStaff(true);go("home");startPoll()}
$("p").addEventListener("keydown",function(e){if(e.key==="Enter")login()});
try{if(CLOUD){if(SB.tok)showApp()}else if(sessionStorage.getItem(SES))showApp()}catch(e){}
if(CLOUD){document.querySelector("#u").parentNode.firstChild.textContent="Email";$("u").type="email";$("a_user").readOnly=true;setSync(SB.tok?"wait":"wait","Connecting…")}else{setSync("bad","Cloud not set up – saving on this device only")}

function go(v){
  ["home","new","list","ref","bill","acct"].forEach(function(n){$("v-"+n).classList.toggle("hide",n!==v)});
  document.querySelectorAll("nav button").forEach(function(b){b.classList.toggle("on",b.dataset.v===v)});
  if(v==="list"){renderList();$("view").classList.add("hide")}
  if(v==="new"&&!editId)resetForm();
  if(v==="ref"){renderRef()}
  if(v==="bill"){if(!billEdit)resetBill();renderBills()}
  if(v==="acct"){$("a_user").value=CLOUD?(SB.email||""):USER;$("a_msg").textContent=""}
  window.scrollTo(0,0)
}
document.querySelectorAll("nav button").forEach(function(b){b.onclick=function(){editId=null;go(b.dataset.v)}});

function resetForm(){
  editId=null;$("formTitle").textContent="New patient report";
  ["f_name","f_age","f_phone","f_part","f_ref","f_imp"].forEach(function(i){$(i).value=""});
  $("f_date").value=new Date().toISOString().slice(0,10);$("f_file").value="";$("ferr").textContent="";if(window.buildChips)buildChips()
}
function saveReport(doPrint){
  var name=$("f_name").value.trim();
  if(!name){$("ferr").textContent="Patient name is required.";return}
  var file=$("f_file").files[0];
  function finish(att){
    var a=load(),old=editId?a.find(function(r){return r.id===editId}):null;
    var r={id:editId||"R"+Date.now().toString().slice(-7),name:name,age:$("f_age").value,sex:$("f_sex").value,phone:$("f_phone").value,
      type:$("f_type").value,part:$("f_part").value,date:$("f_date").value,ref:$("f_ref").value,find:"",imp:$("f_imp").value,
      att:att||(old&&old.att)||null,saved:(old&&old.saved)||new Date().toISOString()};
    if(old)r.upd=new Date().toISOString();
    if(old)a[a.indexOf(old)]=r;else a.unshift(r);
    if(!store(a)){$("ferr").textContent="Could not save (browser storage full). Try without attachment.";return}
    editId=null;fillRefList();go("list");openReport(r.id);if(doPrint===true)setTimeout(printReport,300)
  }
  if(file){
    if(file.size>1500000){$("ferr").textContent="Attachment too large (max 1.5 MB). Save without it.";return}
    var fr=new FileReader();fr.onload=function(){finish({n:file.name,t:file.type,d:fr.result})};fr.readAsDataURL(file)
  }else finish(null)
}
function renderList(){
  var q=$("q").value.toLowerCase(),t=$("ft").value,a=load();
  var f=a.filter(function(r){return(!t||r.type===t)&&(r.name+r.phone+r.part+r.id+r.type).toLowerCase().indexOf(q)>-1});
  $("count").textContent=a.length;$("empty").classList.toggle("hide",f.length>0);
  $("rows").innerHTML=f.map(function(r){return'<tr><td>'+esc(r.id)+'</td><td>'+esc(r.date)+' <small style="color:var(--mu)">'+esc(fmtT(r.saved))+'</small></td><td>'+esc(r.name)+'</td><td><span class="tag">'+esc(r.type)+'</span></td><td>'+esc(partsOf(r.part).join(', '))+'</td><td><button class="btn alt" onclick="openReport(\''+r.id+'\')">Open</button></td></tr>'}).join("")
}
function openReport(id){
  var r=load().find(function(x){return x.id===id});if(!r)return;
  var att="";
  if(r.att){att=r.att.t.indexOf("video")===0?'<video controls style="max-width:100%;border-radius:10px" src="'+r.att.d+'"></video>':'<img alt="Attachment" style="max-width:100%;border-radius:10px" src="'+r.att.d+'">'}
  var v=$("view");v.classList.remove("hide");
  v.innerHTML='<h2>Sagarmatha Diagnostic and Health Care Center — '+esc(r.type)+' Report</h2><p style="margin-top:-6px;color:var(--mu)">Sagarmatha Digital X-Ray, Golbazar</p>'+
  '<p><b>Report ID:</b> '+esc(r.id)+' &nbsp; <b>Date:</b> '+esc(r.date)+'<br><b>Saved on:</b> '+esc(fmtDT(r.saved))+(r.upd?'<br><b>Last edited:</b> '+esc(fmtDT(r.upd)):'')+'</p>'+
  '<p><b>Patient:</b> '+esc(r.name)+' · '+esc(r.age)+' yrs · '+esc(r.sex)+' · '+esc(r.phone)+'<br><b>Study:</b> '+partsOf(r.part).map(function(p,i){return'<br>'+(i+1)+'. '+esc(p)}).join('')+'<br><b>Referred by:</b> '+esc(r.ref)+'</p>'+
  (r.find?'<h3>Findings</h3><p class="pre">'+esc(r.find)+'</p>':'')+'<h3>Impression / advice</h3><p class="pre">'+esc(r.imp)+'</p>'+att+
  '<div class="row noprint" style="margin-top:14px"><button class="btn" onclick="printReport()">Print / Save PDF</button>'+
  '<button class="btn alt" onclick="editReport(\''+r.id+'\')">Edit</button><button class="btn dg" onclick="delReport(\''+r.id+'\')">Delete</button></div>';
  v.scrollIntoView({behavior:"smooth"})
}
function editReport(id){
  var r=load().find(function(x){return x.id===id});if(!r)return;
  editId=id;go("new");$("formTitle").textContent="Edit report "+id;
  $("f_name").value=r.name;$("f_age").value=r.age;$("f_sex").value=r.sex;$("f_phone").value=r.phone;$("f_type").value=r.type;
  $("f_part").value=r.part;$("f_date").value=r.date;$("f_ref").value=r.ref;$("f_imp").value=r.imp;buildChips()
}
function delReport(id){
  if(!confirm("Delete this report permanently?"))return;
  store(load().filter(function(r){return r.id!==id}));fillRefList();$("view").classList.add("hide");renderList()
}
function exportJSON(){
  var b=new Blob([JSON.stringify(load(),null,1)],{type:"application/json"}),a=document.createElement("a");
  a.href=URL.createObjectURL(b);a.download="sagarmatha-reports-"+new Date().toISOString().slice(0,10)+".json";a.click()
}
function importJSON(el){
  var f=el.files[0];if(!f)return;var fr=new FileReader();
  fr.onload=function(){try{var inc=JSON.parse(fr.result),a=load(),ids={};a.forEach(function(r){ids[r.id]=1});
    inc.forEach(function(r){if(r&&r.id&&!ids[r.id])a.push(r)});store(a);fillRefList();renderList()}catch(e){alert("Invalid backup file")}};
  fr.readAsText(f)
}

/* ---- Bills ---- */
var BK="sg_bills",billEdit=null,bmem=[];
function fmtDT(iso){if(!iso)return"";var d=new Date(iso);if(isNaN(d))return"";return d.toLocaleString("en-GB",{day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:true})}
function fmtT(iso){if(!iso)return"";var d=new Date(iso);if(isNaN(d))return"";return d.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",hour12:true})}
function loadB(){return BC.slice()}
function storeB(a){var old=BC;BC=a;var ok=lsSet("sg_bills",a);syncCol("bill",old,a);return ok}
function addItem(d,a){
  var w=document.createElement("div");w.className="row bitem";w.style.margin="6px 0";
  w.innerHTML='<input class="bi_d" placeholder="Service e.g. Chest X-Ray" style="flex:3;min-width:140px;margin:0"><input class="bi_a" type="number" min="0" placeholder="Amount" style="flex:1;min-width:90px;margin:0"><button class="btn dg" type="button" title="Remove">✕</button>';
  w.querySelector(".bi_d").value=d||"";w.querySelector(".bi_a").value=a==null?"":a;
  w.querySelector(".bi_a").oninput=calcBill;
  w.querySelector("button").onclick=function(){if(document.querySelectorAll(".bitem").length>1){w.remove();calcBill()}};
  $("b_items").appendChild(w)
}
function billItems(){
  return Array.prototype.map.call(document.querySelectorAll(".bitem"),function(w){return{d:w.querySelector(".bi_d").value.trim(),a:parseFloat(w.querySelector(".bi_a").value)||0}}).filter(function(i){return i.d||i.a})
}
function calcBill(){
  var sub=billItems().reduce(function(t,i){return t+i.a},0),disc=parseFloat($("b_disc").value)||0,paid=parseFloat($("b_paid").value)||0;
  var tot=Math.max(0,sub-disc);$("b_total").textContent=tot;$("b_due").textContent=Math.max(0,tot-paid);return{sub:sub,disc:disc,paid:paid,tot:tot}
}
function resetBill(){
  billEdit=null;$("bTitle").textContent="Add bill";
  $("b_name").value="";$("b_phone").value="";$("b_disc").value=0;$("b_paid").value=0;$("b_err").textContent="";
  $("b_date").value=new Date().toISOString().slice(0,10);$("b_items").innerHTML="";addItem();calcBill()
}
function saveBill(){
  var name=$("b_name").value.trim(),items=billItems();
  if(!name){$("b_err").textContent="Patient name is required.";return}
  if(!items.length){$("b_err").textContent="Add at least one item.";return}
  var c=calcBill(),a=loadB(),old=billEdit?a.find(function(b){return b.id===billEdit}):null;
  var b={id:billEdit||"B"+Date.now().toString().slice(-7),name:name,phone:$("b_phone").value.trim(),date:$("b_date").value,items:items,sub:c.sub,disc:c.disc,tot:c.tot,paid:c.paid,due:Math.max(0,c.tot-c.paid),saved:(old&&old.saved)||new Date().toISOString()};
  if(old)a[a.indexOf(old)]=b;else a.unshift(b);
  if(!storeB(a)){$("b_err").textContent="Could not save (browser storage full).";return}
  var id=b.id;billEdit=null;resetBill();renderBills();openBill(id)
}
function renderBills(auto){
  var q=$("bq").value.toLowerCase().trim(),t=$("bf").value,a=loadB();
  var f=a.filter(function(b){
    if(t==="due"&&!(b.due>0))return false;if(t==="paid"&&b.due>0)return false;
    var hay=(b.id+" "+b.name+" "+b.phone+" "+b.date+" "+b.items.map(function(i){return i.d}).join(" ")).toLowerCase();
    return !q||hay.indexOf(q)>-1});
  $("bcount").textContent=a.length;$("bempty").classList.toggle("hide",f.length>0);
  $("brows").innerHTML=f.map(function(b){return'<tr><td>'+esc(b.id)+'</td><td>'+esc(b.date)+'</td><td>'+esc(b.name)+'</td><td>'+esc(b.phone)+'</td><td>Rs. '+b.tot+'</td><td>'+(b.due>0?'<span style="color:var(--dg);font-weight:600">Rs. '+b.due+'</span>':'<span class="tag">Paid</span>')+'</td><td><button class="btn alt" onclick="openBill(\''+b.id+'\')">Open</button></td></tr>'}).join("");
  if(auto===true&&q&&f.length===1)openBill(f[0].id,true);
  else if(auto===true)$("bview").classList.add("hide")
}
function openBill(id,quiet){
  var b=loadB().find(function(x){return x.id===id});if(!b)return;
  var v=$("bview");v.classList.remove("hide");
  v.innerHTML='<h2>Sagarmatha Diagnostic and Health Care Center</h2><p style="margin-top:-6px;color:var(--mu)">Golbazar-6, Siraha · 9811363762 / 9842362472</p>'+
  '<p><b>Bill no:</b> '+esc(b.id)+' &nbsp; <b>Date:</b> '+esc(b.date)+'<br><b>Saved on:</b> '+esc(fmtDT(b.saved))+'<br><b>Patient:</b> '+esc(b.name)+(b.phone?' · '+esc(b.phone):'')+'</p>'+
  '<div class="tbl"><table><thead><tr><th>#</th><th>Item</th><th style="text-align:right">Amount (Rs.)</th></tr></thead><tbody>'+
  b.items.map(function(i,n){return'<tr><td>'+(n+1)+'</td><td>'+esc(i.d)+'</td><td style="text-align:right">'+i.a+'</td></tr>'}).join("")+
  '</tbody></table></div><p style="text-align:right;margin:10px 0 0">Subtotal: Rs. '+b.sub+'<br>Discount: Rs. '+b.disc+'<br><b>Total: Rs. '+b.tot+'</b><br>Paid: Rs. '+b.paid+'<br><b>Due: Rs. '+b.due+'</b></p>'+
  '<div class="row noprint" style="margin-top:14px"><button class="btn" onclick="printBill()">Print bill</button><button class="btn alt" onclick="editBill(\''+b.id+'\')">Edit</button><button class="btn dg" onclick="delBill(\''+b.id+'\')">Delete</button></div>';
  if(!quiet)v.scrollIntoView({behavior:"smooth"})
}
function printReport(){document.body.classList.add("pr");window.print();document.body.classList.remove("pr")}
function printBill(){document.body.classList.add("pb");window.print();document.body.classList.remove("pb")}
function editBill(id){
  var b=loadB().find(function(x){return x.id===id});if(!b)return;
  billEdit=id;go("bill");$("bTitle").textContent="Edit bill "+id;
  $("b_name").value=b.name;$("b_phone").value=b.phone;$("b_date").value=b.date;$("b_disc").value=b.disc;$("b_paid").value=b.paid;
  $("b_items").innerHTML="";b.items.forEach(function(i){addItem(i.d,i.a)});calcBill();window.scrollTo(0,0)
}
function delBill(id){
  if(!confirm("Delete this bill permanently?"))return;
  storeB(loadB().filter(function(b){return b.id!==id}));$("bview").classList.add("hide");renderBills()
}
function exportBills(){
  var b=new Blob([JSON.stringify(loadB(),null,1)],{type:"application/json"}),a=document.createElement("a");
  a.href=URL.createObjectURL(b);a.download="sagarmatha-bills-"+new Date().toISOString().slice(0,10)+".json";a.click()
}
function importBills(el){
  var f=el.files[0];if(!f)return;var fr=new FileReader();
  fr.onload=function(){try{var inc=JSON.parse(fr.result),a=loadB(),ids={};a.forEach(function(r){ids[r.id]=1});
    inc.forEach(function(r){if(r&&r.id&&r.items&&!ids[r.id])a.push(r)});storeB(a);renderBills()}catch(e){alert("Invalid backup file")}};
  fr.readAsText(f)
}

/* ---- Referred ---- */
var refOpen={};
function refGroups(){
  var g={};
  load().forEach(function(r){
    var n=(r.ref||"").trim().replace(/\s+/g," ");if(!n)return;
    var k=n.toLowerCase();(g[k]=g[k]||{name:n,list:[]}).list.push(r)
  });
  return Object.keys(g).map(function(k){return g[k]}).sort(function(a,b){return b.list.length-a.list.length||a.name.localeCompare(b.name)})
}
function fillRefList(){
  $("refList").innerHTML=refGroups().map(function(g){return'<option value="'+esc(g.name)+'">'}).join("")
}
function renderRef(){
  var q=$("rq").value.toLowerCase().trim(),all=refGroups();
  var gs=all.filter(function(g){return !q||g.name.toLowerCase().indexOf(q)>-1||g.list.some(function(r){return (r.name+" "+r.phone).toLowerCase().indexOf(q)>-1})});
  $("rcount").textContent=all.length;$("rempty").classList.toggle("hide",gs.length>0);
  $("rlist").innerHTML=gs.map(function(g){
    var k=g.name.toLowerCase(),open=refOpen[k]||(q&&gs.length<=3);
    var pts=g.list.filter(function(r){return !q||g.name.toLowerCase().indexOf(q)>-1||(r.name+" "+r.phone).toLowerCase().indexOf(q)>-1});
    return'<div style="border:1px solid var(--bd);border-radius:10px;margin-bottom:8px;overflow:hidden">'+
    '<button class="btn alt" style="width:100%;text-align:left;border-radius:0;display:flex;justify-content:space-between" onclick="toggleRef(decodeURIComponent(\''+encodeURIComponent(k)+'\'))"><span>'+esc(g.name)+'</span><span>'+g.list.length+' patient'+(g.list.length>1?'s':'')+' '+(open?'▲':'▼')+'</span></button>'+
    (open?'<div class="tbl" style="padding:6px 10px"><table><thead><tr><th>ID</th><th>Date</th><th>Patient</th><th>Type</th><th>Study</th><th></th></tr></thead><tbody>'+
    pts.map(function(r){return'<tr><td>'+esc(r.id)+'</td><td>'+esc(r.date)+'</td><td>'+esc(r.name)+'</td><td><span class="tag">'+esc(r.type)+'</span></td><td>'+esc(partsOf(r.part).join(', '))+'</td><td><button class="btn alt" onclick="go(\'list\');openReport(\''+r.id+'\')">Open</button></td></tr>'}).join("")+
    '</tbody></table></div>':'')+'</div>'
  }).join("")
}
function toggleRef(k){refOpen[k]=!refOpen[k];renderRef()}
fillRefList();

/* ---- X-ray type selector ---- */
var PARTS={
"X-Ray":{"Head & Neck":["Skull AP/Lateral","PNS (Water's view)","Mandible","Nasal bone","Orbit","Mastoid","TM joint","Soft tissue neck","Cervical spine AP/Lat"],
"Chest":["Chest PA","Chest AP","Chest Lateral","Chest Apicogram","Ribs","Sternum","Clavicle"],
"Spine & Pelvis":["Lumbosacral spine AP/Lat","Thoracic spine","Sacrum / Coccyx","Whole spine","Pelvis AP","Hip joint","SI joint"],
"Upper limb":["Shoulder","Humerus","Elbow","Forearm","Wrist","Hand","Fingers"],
"Lower limb":["Femur","Knee","Leg (Tibia/Fibula)","Ankle","Foot","Calcaneum","Toes"],
"Abdomen":["Abdomen erect","Abdomen supine","KUB"],
"Others":["Bone age","Dental / IOPA","Other"]},
"Video X-Ray":{"Contrast studies":["Barium swallow","Barium meal","Barium follow through","Barium enema","IVU","HSG","MCU / RGU","Fistulogram","Sinogram","T-tube cholangiogram"],
"Other":["Joint movement study","Guided injection / procedure","Other"]}};
function partsOf(t){return String(t||"").split(/[\n,]+/).map(function(x){return x.trim()}).filter(Boolean)}
function curParts(){return partsOf($("f_part").value)}
function buildChips(){
  var g=PARTS[$("f_type").value]||{},h="";
  Object.keys(g).forEach(function(k){h+='<div class="chipg">'+esc(k)+'</div>'+g[k].map(function(p){return'<label class="opt"><input type="checkbox" data-p="'+esc(p)+'"> '+esc(p)+'</label>'}).join("")});
  $("partChips").innerHTML=h;
  Array.prototype.forEach.call($("partChips").querySelectorAll("input"),function(b){b.onchange=function(){
    var p=b.dataset.p,c=curParts(),i=c.findIndex(function(x){return x.toLowerCase()===p.toLowerCase()});
    if(b.checked&&i<0)c.push(p);if(!b.checked&&i>-1)c.splice(i,1);
    $("f_part").value=c.join("\n");syncChips()}});
  syncChips()
}
function syncChips(){
  var c=curParts().map(function(x){return x.toLowerCase()});
  Array.prototype.forEach.call($("partChips").querySelectorAll("input"),function(b){b.checked=c.indexOf(b.dataset.p.toLowerCase())>-1})
}
$("f_type").addEventListener("change",buildChips);
buildChips();
