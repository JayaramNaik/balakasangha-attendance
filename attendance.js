// ===================== CONFIG =====================
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAGpZNwnekU2BEpEbmIHmsMWYBI2fI7KcE",
  authDomain: "balakasangha-attendance.firebaseapp.com",
  projectId: "balakasangha-attendance",
  storageBucket: "balakasangha-attendance.firebasestorage.app",
  messagingSenderId: "814303496942",
  appId: "1:814303496942:web:5cf712e73513480f5b81ff"
};
const STATE_DOC_PATH = 'attendance/state';
const ADMINS_DOC_PATH = 'attendance/admins';
const VOLUNTEERS_DOC_PATH = 'attendance/volunteers';

// ===================== CONSTANTS =====================
const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
const SECTIONS={
  'old-middle':{label:'Old Students — Middle School',type:'old',color:'#1D9E75'},
  'old-high':  {label:'Old Students — High School',  type:'old',color:'#185FA5'},
  'new-middle':{label:'New Students — Middle School',type:'new',color:'#D85A30'},
  'new-high':  {label:'New Students — High School',  type:'new',color:'#C07A00'},
  'yuvaka-sangha':{label:'Yuvaka Sangha', type:'yuvaka', color:'#7B4FA6', fieldType:'profession'},
};
const SEC_KEYS=Object.keys(SECTIONS);
// Balaka Sangha sections only (excludes Yuvaka Sangha) — used for anything that
// should never mix the two groups together, like combined exports.
const BALAKA_SEC_KEYS=SEC_KEYS.filter(k=>SECTIONS[k].type!=='yuvaka');

// A section can define fieldType:'profession' (Yuvaka Sangha) instead of the
// default Class field. These helpers keep every render/export site in sync.
function isProfessionSection(key){ return (SECTIONS[key]||{}).fieldType === 'profession'; }

// Middle School = Class 4-7, High School = Class 8-10. Previously the class
// dropdown offered 5-10 regardless of which section you were adding to —
// meaning nothing stopped a Class 8 student from being added to a Middle
// School section, or Class 4 wasn't even selectable at all. Populating the
// dropdown with only the valid range for whichever section is selected
// makes the invalid combination impossible to create through the UI,
// rather than just detecting it after the fact.
const CLASS_RANGES = { middle: [4,5,6,7], high: [8,9,10] };
function schoolLevelForKey(key){
  if(!key) return null;
  if(key.includes('high')) return 'high';
  if(key.includes('middle')) return 'middle';
  return null; // yuvaka-sangha — class/school-level doesn't apply
}
function populateClassOptions(selectEl, key, currentValue){
  if(!selectEl) return;
  const level = schoolLevelForKey(key);
  const range = level ? CLASS_RANGES[level] : [4,5,6,7,8,9,10];
  selectEl.innerHTML = '<option value="">Select Class</option>' +
    range.map(c => `<option value="${c}">Class ${c}</option>`).join('');
  if(currentValue && range.includes(parseInt(currentValue,10))) selectEl.value = String(currentValue);
}
function secondaryFieldLabel(key){ return isProfessionSection(key) ? 'Profession/Education' : 'Class'; }
// Yuvaka Sangha members aren't "students" anymore — label the name field
// accordingly wherever a section-specific label is shown.
function nameFieldLabel(key){ return isProfessionSection(key) ? 'Volunteer Name' : 'Student Name'; }
function secondaryFieldValue(key, student){
  if(typeof student !== 'object' || !student) return '';
  if(isProfessionSection(key)){
    const p = student.profession;
    return p && p.detail ? (p.type+': '+p.detail) : '';
  }
  return student.class || '';
}
function exportFilePrefix(key){ return isProfessionSection(key) ? 'YuvakaSangha' : 'BalakaSangha'; }

// Returns the permanent id for the student currently at students[key][idx].
// Falls back to the plain array index (as a string) if that student somehow
// hasn't been assigned an id yet — this matches the OLD key format exactly,
// so during the brief window before migrateMissingStudentIds() finishes,
// record lookups still find their existing index-keyed data rather than
// coming up empty.
function idFor(key, idx){
  const s = students[key] && students[key][idx];
  if(s && typeof s === 'object' && s.id) return s.id;
  return String(idx);
}

// Now that records live in their own subcollection, attendance/state only
// holds students + locks + archivedStudents, which grows far slower — but
// "far slower" isn't "never," especially archivedStudents (append-only,
// forever) and a growing active roster over many years. Low urgency
// compared to what this used to be, but still worth a cheap periodic
// check rather than assuming the subcollection migration made this
// document's size a non-issue forever.
let docSizeCheckInterval = null;
const DOC_SIZE_HARD_LIMIT = 1048576; // Firestore's actual per-document limit, 1 MiB
const DOC_SIZE_WARN_THRESHOLD = DOC_SIZE_HARD_LIMIT * 0.7;
function checkDocumentSizeWarning(){
  if(currentUserRole !== 'admin') return;
  const banner = document.getElementById('doc-size-banner');
  const textEl = document.getElementById('doc-size-banner-text');
  if(!banner || !textEl) return;
  try{
    const json = JSON.stringify({students, locks, archivedStudents});
    const bytes = new TextEncoder().encode(json).length;
    if(bytes >= DOC_SIZE_WARN_THRESHOLD){
      const pct = Math.round((bytes / DOC_SIZE_HARD_LIMIT) * 100);
      const kb = Math.round(bytes / 1024);
      textEl.textContent = `Currently using ~${kb.toLocaleString()} KB (~${pct}% of the 1 MB limit). Consider archiving graduated/inactive students' older data, or check in with your developer.`;
      banner.style.display = 'block';
    } else {
      banner.style.display = 'none';
    }
  }catch(e){
    console.warn('[doc size check] failed:', e.message);
  }
}


let students={'old-middle':[],'old-high':[],'new-middle':[],'new-high':[],'yuvaka-sangha':[]};
// records: the in-memory attendance-mark/tracker map — SAME shape and key
// format as always ('section|date|studentId' and its '|tracker' variant).
// Nothing that reads this object (getRecord, setRecord, getStats, every
// render function) needed to change at all when the underlying storage
// moved from one big document field to a subcollection — only the sync
// layer below changed. That's deliberate: keeping this object's shape
// identical was the single biggest risk-reduction available for this
// migration.
let records={};
// Snapshot of the OLD 'records' field inside attendance/state, if any still
// exists from before this migration. Only ever read by
// migrateRecordsToSubcollection() — never used for live rendering.
let legacyRecordsField=null;
// locks: key = 'sectionKey|date', value = {lockedBy, lockedByName, lockedAt}
// Once a session is locked, marks can't be changed directly — only via a
// correction request that an admin reviews and approves.
let locks={};
// archivedStudents: students who left ("removed & keep records") or
// graduated, kept as an explicit registry {id, name, section, class,
// profession, joiningDate, archivedAt, reason} so that if the same person
// rejoins later, the app can look them up and reconnect their *exact*
// original permanent ID — rather than guessing from a sanitized version of
// their name, which is what the old scheme did and which could occasionally
// misattribute history if a different person later shared that same name.
let archivedStudents=[];
const now=new Date();
let curMonth=now.getMonth(),curYear=now.getFullYear();
let curDate=null,curView='attendance',curType='old';
let curSchool={old:'old-middle',new:'new-middle',yuvaka:'yuvaka-sangha'};

// Display-only sort for the attendance table — does NOT change the stored
// order of students[key] at all (that stays exactly as insertion order,
// which is what "Order Added" shows), so this is purely a rendering
// choice. Safe by construction: since attendance records are keyed by each
// student's permanent id rather than their array position, re-ordering how
// rows are DISPLAYED can never cause any record to attach to the wrong
// person, no matter which sort mode is active or how many different people
// are viewing the same section with different sort choices at once.
let curSort = 'added'; // 'added' | 'name' | 'id'
function setSortMode(mode){
  curSort = mode;
  renderCurrentSection();
}

// Parses a permanent student ID into its parts for correct numeric
// comparison. Two shapes exist and both must be handled: the CURRENT
// format (3-char prefix VBS/VYS + 2-digit year + serial) and the LEGACY
// format every already-imported student still has (6-char prefix
// R53VBS/R53VYS + 3-digit year + serial) — ids are permanent and are never
// rewritten when the format changes, so both shapes coexist forever.
// Comparing the PARSED numbers (not the raw string) is what makes "join
// year order" reliable — a plain string comparison would usually happen to
// work, but would break silently the day any single year's serial count
// reaches 4 digits (e.g. "999" sorting after "1000" as text, even though
// 999 joined earlier). Note both shapes' year fields parse to the SAME
// number for the same year (legacy "026" and current "26" both give 26),
// so old and new ids still sort correctly against each other by year.
function parseStudentId(id){
  if(!id) return { prefix: '', year: 0, serial: 0 };
  for(const p of [LEGACY_ID_PREFIXES.balaka, LEGACY_ID_PREFIXES.yuvaka]){
    if(id.startsWith(p) && id.length >= p.length + 3){
      return {
        prefix: p,
        year: parseInt(id.slice(p.length, p.length + 3), 10) || 0,
        serial: parseInt(id.slice(p.length + 3), 10) || 0
      };
    }
  }
  for(const p of [ID_PREFIXES.balaka, ID_PREFIXES.yuvaka]){
    if(id.startsWith(p) && id.length >= p.length + 2){
      return {
        prefix: p,
        year: parseInt(id.slice(p.length, p.length + 2), 10) || 0,
        serial: parseInt(id.slice(p.length + 2), 10) || 0
      };
    }
  }
  return { prefix: id, year: 0, serial: 0 }; // unrecognized shape (e.g. legacy array-index key)
}
function compareStudentIds(idA, idB){
  const a = parseStudentId(idA), b = parseStudentId(idB);
  if(a.year !== b.year) return a.year - b.year;       // earlier joining year always first
  if(a.serial !== b.serial) return a.serial - b.serial; // then join order within that year
  return a.prefix.localeCompare(b.prefix);              // tiebreak, shouldn't normally matter
}

// Returns the array indices for students[key] in the CURRENT sort order.
// Callers still use the returned index (i) for every actual data lookup
// (getRecord, getStats, mark, edit, delete, history) — only the ITERATION
// order changes, nothing about how any individual student's data is found.
function sortedIndices(key){
  const st = students[key] || [];
  const idxs = st.map((_, i) => i);
  if(curSort === 'name'){
    idxs.sort((a, b) => {
      const nameA = (typeof st[a]==='string' ? st[a] : (st[a].name||'')).toLowerCase();
      const nameB = (typeof st[b]==='string' ? st[b] : (st[b].name||'')).toLowerCase();
      return nameA.localeCompare(nameB);
    });
  } else if(curSort === 'id'){
    idxs.sort((a, b) => compareStudentIds(idFor(key, a), idFor(key, b)));
  }
  // 'added' (default): idxs is already [0,1,2,...] — original insertion order
  return idxs;
}
const chartInstances={};

// User & Auth
let db=null;
let auth=null;
let currentUser=null;
let currentUserRole='volunteer'; // 'admin', 'volunteer', or 'pending' (awaiting approval)
// Separate from currentUserRole: a small, extra layer ON TOP of admin,
// for one-time/developer maintenance tools (id repair, migrations,
// diagnostics) that a regular admin doesn't need cluttering their day-to
// -day Approvals tab. Read from the SAME attendance/admins document as
// the admin list (a new backendEmails field on it), so no new Firestore
// rules are needed — read access to that document is already granted to
// anyone signed in, and every backend tool's actual write still goes
// through the normal isAdmin()-gated rules, so a backend account must
// ALSO be a normal admin for any of these tools to actually work.
let currentUserIsBackend=false;
let currentUserStatus='approved'; // 'approved', 'pending', or 'rejected' — drives currentUserRole above
let currentUserName='';
let stateDoc=null;
let adminsDoc=null;
let volunteersDoc=null;
let correctionsCollection=null;
let auditLogCollection=null;
let recordsCollection=null;
let studentAddRequestsCollection=null;
let allCorrections=[]; // full live list from Firestore, kept in sync via onSnapshot

// Modal state
let addStudentContext={key:null};

// ===================== UTILITY FUNCTIONS =====================
function setSyncStatus(status,msg){
  const dot=document.getElementById('sync-dot');
  const label=document.getElementById('sync-label');
  dot.className='sync-dot '+status;
  label.textContent=msg;
}

// ===================== SECURITY: HTML ESCAPING =====================
// Every one of these fields is user-controlled and gets rendered via
// innerHTML somewhere in the app: student/volunteer names (typed by an
// admin, by anyone via bulk import, or by an unvetted self-registration),
// correction "reason" text (typed by any volunteer), and profession/
// education details. Without escaping, a name like
// <img src=x onerror="..."> would silently execute in the browser of every
// admin or volunteer who later views that row — including in the
// Approvals tab, which is the single easiest attack path since it doesn't
// even require an approved account, just submitting the registration form.
// ALWAYS wrap user-controlled text in escapeHtml() before interpolating it
// into an innerHTML template string. Values already going through
// .textContent (not innerHTML) don't need this — the browser escapes those
// automatically.
function escapeHtml(str){
  if(str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// For user text embedded inside a single-quoted JS string literal that is
// itself inside a double-quoted HTML attribute (e.g. onclick="fn('${x}')").
// Order matters: escape backslashes first, then quotes for the JS string,
// then HTML-escape the double-quote so the outer HTML attribute can't be
// broken out of either.
function escapeForJsAttr(str){
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function showToast(msg){
  const t=document.getElementById('toast');
  t.textContent=msg;
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),2200);
}

function showError(msg, elementId='error-message'){
  const el=document.getElementById(elementId);
  if(el){
    el.textContent=msg;
    el.classList.add('show');
    setTimeout(()=>el.classList.remove('show'),4000);
  }
}

function persistLocal(){
  try{ localStorage.setItem('balaka_students', JSON.stringify(students)); }catch(e){}
  try{ localStorage.setItem('balaka_records', JSON.stringify(records)); }catch(e){}
}

// ===== OFFLINE SAFETY NET =====
let pendingSync = false;
let syncRetryTimer = null;

function setPendingSync(val){
  pendingSync = val;
  try{ localStorage.setItem('balaka_pendingSync', val ? '1' : '0'); }catch(e){}
}

async function trySyncNow(){
  if(!stateDoc || !navigator.onLine) return;
  try{
    const payload = {students, locks, archivedStudents};
    if(legacyRecordsField && Object.keys(legacyRecordsField).length){
      payload.records = legacyRecordsField;
    }
    await stateDoc.set(payload);
    setPendingSync(false);
    setSyncStatus('synced','✓ Synced to Firebase');
    showToast('✅ Offline marks synced successfully!');
    if(syncRetryTimer){ clearInterval(syncRetryTimer); syncRetryTimer = null; }
  }catch(e){ /* still offline, keep retrying */ }
}

window.addEventListener('online', ()=>{
  if(pendingSync || localStorage.getItem('balaka_pendingSync')==='1'){
    setSyncStatus('syncing','Internet restored — syncing...');
    showToast('🌐 Internet back — syncing attendance...');
    setTimeout(trySyncNow, 1500);
  } else {
    setSyncStatus('synced','Online');
  }
});

// A phone screen locking, or switching apps, can leave this page sitting in
// the background for a long time. The underlying data listeners keep
// receiving live updates the whole time (corrections, records, roster —
// all still correctly in sync), but several views only re-render when
// their own tab is the ACTIVE one at the moment new data arrives (see
// initCorrectionsListener, for example). Coming back to a backgrounded tab
// showing a "Pending" correction that was actually already approved/rejected
// hours ago is exactly that: correct underlying data, stale render. Forcing
// a re-render of whatever view is currently open when the tab becomes
// visible again closes that gap directly.
document.addEventListener('visibilitychange', ()=>{
  if(document.visibilityState !== 'visible') return;
  if(!currentUser) return;
  if(curView==='attendance') renderCurrentSection();
  else if(curView==='analytics') renderAnalytics();
  else if(curView==='corrections') renderCorrections();
  else if(curView==='auditlog') renderAuditLog();
  else if(curView==='approvals') renderApprovals();
});

window.addEventListener('offline', ()=>{
  setSyncStatus('error','⚠️ Offline — marks saved locally');
  showToast('⚠️ No internet — marks saved locally, will auto-sync when online');
});

// Role is determined automatically from Firebase adminEmails list

function showLoginMode(){
  document.getElementById('register-screen').style.display='none';
  document.getElementById('login-screen').style.display='block';
}

function showRegisterMode(){
  document.getElementById('login-screen').style.display='none';
  document.getElementById('register-screen').style.display='block';
}

// ===================== AUTH FUNCTIONS =====================
async function initFirebase(){
  try{
    if(!FIREBASE_CONFIG.projectId || FIREBASE_CONFIG.projectId==='YOUR_PROJECT_ID'){
      throw new Error('Firebase configuration not set');
    }
    firebase.initializeApp(FIREBASE_CONFIG);
    auth = firebase.auth();
    db = firebase.firestore();
    // Enable offline persistence - marks saved locally, auto-sync when internet returns
    db.enablePersistence({ synchronizeTabs: true }).catch(err => {
      if(err.code === 'failed-precondition') console.warn('[SW] Multiple tabs open, persistence in one tab only');
      else if(err.code === 'unimplemented') console.warn('[SW] Browser does not support offline persistence');
    });
    stateDoc = db.doc(STATE_DOC_PATH);
    adminsDoc = db.doc(ADMINS_DOC_PATH);
    volunteersDoc = db.doc(VOLUNTEERS_DOC_PATH);
    correctionsCollection = db.collection('corrections');
    auditLogCollection = db.collection('auditLog');
    studentAddRequestsCollection = db.collection('studentAddRequests');
    // Attendance records now live as individual documents in this
    // subcollection instead of one giant field inside attendance/state.
    // See the "RECORDS STORAGE" section below for why.
    recordsCollection = stateDoc.collection('records');

    // Real-time listener for students/locks/archivedStudents — small,
    // slow-growing data that's fine as one document. This is the SOLE
    // writer of these three (see earlier note on the loadState() race fix).
    //
    // Attendance records used to live in this same document too, as a
    // 'records' field that grew forever with every mark, every session,
    // every year — with real projected growth (~2MB/year for an org this
    // size) that would exceed Firestore's 1MB-per-document hard limit
    // within about 2 years, at which point EVERY write to this document
    // would start failing outright. Worse, every save rewrote the ENTIRE
    // document, so two people marking different, unrelated sections at the
    // same moment could silently overwrite each other's marks — proven by
    // direct simulation, not just theory.
    //
    // Records now live as individual documents in the 'records'
    // subcollection instead (see initRecordsListener below), which has no
    // aggregate size limit and where two people's writes go to two
    // different documents and can never collide.
    stateDoc.onSnapshot(snapshot=>{
      if(snapshot.exists){
        const data = snapshot.data();
        SEC_KEYS.forEach(key=>{
          // Normalize legacy string-only student records to objects —
          // previously only loadState() did this; onSnapshot didn't, which
          // would have been a silent behavior gap once loadState() was removed.
          students[key] = (data.students?.[key] || []).map(s=>
            typeof s === 'string' ? {name:s, class:'', joiningDate:''} : s
          );
        });
        locks = data.locks || {};
        archivedStudents = data.archivedStudents || [];
        // Old-format records, if any exist from before the subcollection
        // migration — kept ONLY so migrateRecordsToSubcollection() can copy
        // them forward. Never read for live rendering.
        legacyRecordsField = data.records || null;
        rebuildRecordsFromSources();
        setSyncStatus('synced','Synced with Firebase');
        renderCurrent();
      } else {
        // First-ever run for this project — initialize the shared document.
        SEC_KEYS.forEach(key=>students[key]=[]);
        locks={};
        archivedStudents=[];
        legacyRecordsField=null;
        saveState();
      }
    }, err=>{
      setSyncStatus('error','Firebase sync error');
      loadFromLocalCache();
    });

    initRecordsListener();

// Guards against onAuthStateChanged showing the app for an account that's
// still in the middle of being registered. Firebase logs a brand-new
// account in immediately as a side effect of createUserWithEmailAndPassword
// — before registerUser()'s own .then() chain has had a chance to write
// the users/{uid} profile doc (with status:'pending') or sign back out.
// Without this guard, onAuthStateChanged and registerUser() are two
// separate, uncoordinated async flows racing each other: if the auth-state
// event fires first, loadUserRole() finds no profile doc yet, defaults to
// treating that as an already-approved grandfathered account (the same
// default that correctly protects real pre-existing volunteers with no
// status field), and briefly — or not so briefly, depending on timing —
// shows the full volunteer interface to a brand-new, not-yet-approved
// registrant. This flag makes onAuthStateChanged simply ignore that
// transient sign-in event entirely; registerUser() is already handling it.
let isRegisteringNewAccount = false;

    auth.onAuthStateChanged(async user=>{
      currentUser = user;
      if(user){
        if(isRegisteringNewAccount) return; // registerUser()'s own flow owns this account right now
        await loadUserRole(user);
        showApp(user);
      } else {
        showLogin();
      }
    });
  }catch(e){
    setSyncStatus('error','Firebase init failed');
    showToast('Firebase setup incomplete');
  }
}

// Offline fallback — used only when the real-time listener itself errors
// out (e.g. no network). Not used during normal operation, so it can never
// race with onSnapshot.
function loadFromLocalCache(){
  try{
    const storedStudents = localStorage.getItem('balaka_students');
    const storedRecords = localStorage.getItem('balaka_records');
    if(storedStudents){
      const data = JSON.parse(storedStudents);
      SEC_KEYS.forEach(key=>{students[key]=data[key]||[];});
    }
    records = storedRecords ? JSON.parse(storedRecords) : {};
    setSyncStatus('synced','Loaded local data (offline)');
    renderCurrent();
  }catch(e){
    console.warn('[Offline fallback] failed to load local cache', e);
  }
}

async function loadUserRole(user){
  try{
    const adminSnapshot = await adminsDoc.get();
    const admins = adminSnapshot.data()?.adminEmails || adminSnapshot.data()?.list || [];
    const backendEmails = adminSnapshot.data()?.backendEmails || [];
    currentUserIsBackend = backendEmails.includes(user.email);
    if(admins.includes(user.email)){
      currentUserRole = 'admin';
      currentUserStatus = 'approved';
    } else {
      // Non-admin: check their approval status. Accounts created before this
      // fix have no `status` field at all — we treat those as grandfathered
      // (already-trusted, already in use) rather than suddenly locking real
      // volunteers out. Only a NEW self-registration explicitly gets
      // status:'pending', and only an explicit 'pending' or 'rejected'
      // blocks access. See registerUser() for where 'pending' gets set.
      let status = 'approved'; // default for pre-existing accounts with no status field
      try{
        const userDoc = await db.collection('users').doc(user.uid).get();
        if(userDoc.exists && userDoc.data().status){
          status = userDoc.data().status;
        }
      }catch(e3){
        console.warn('[Auth] could not fetch user profile doc', e3);
        status = 'pending';
      }
      currentUserStatus = status;
      currentUserRole = (status === 'pending' || status === 'rejected') ? 'pending' : 'volunteer';
    }
    // Fetch full name from users collection
    try{
      const userDoc = await db.collection('users').doc(user.uid).get();
      if(userDoc.exists && userDoc.data().name){
        currentUserName = userDoc.data().name;
      } else {
        currentUserName = user.email.split('@')[0];
      }
    }catch(e2){
      currentUserName = user.email.split('@')[0];
    }
  }catch(e){
    currentUserRole = 'volunteer';
    currentUserIsBackend = false;
    currentUserStatus = 'approved';
    currentUserName = user.email.split('@')[0];
  }
}

// NOTE: the old one-time loadState() function has been removed — its logic
// is now split between the onSnapshot listener (normal path) and
// loadFromLocalCache() (offline fallback), eliminating the race between a
// one-off .get() and the live listener. See initFirebase() above.

async function saveState(){
  // ALWAYS save locally first — zero data loss guarantee
  persistLocal();

  if(!navigator.onLine){
    setPendingSync(true);
    setSyncStatus('error','⚠️ Offline — saved locally');
    if(!syncRetryTimer){
      syncRetryTimer = setInterval(()=>{ if(navigator.onLine) trySyncNow(); }, 30000);
    }
    return;
  }

  setSyncStatus('syncing','Saving...');
  try{
    if(stateDoc){
      const payload = {students, locks, archivedStudents};
      if(legacyRecordsField && Object.keys(legacyRecordsField).length){
        payload.records = legacyRecordsField;
      }
      await stateDoc.set(payload);
      setPendingSync(false);
      setSyncStatus('synced','Saved to Firebase ✓');
    } else {
      throw new Error('Firebase unavailable');
    }
  }catch(e){
    setPendingSync(true);
    setSyncStatus('error','⚠️ Sync failed — saved locally');
    showToast('⚠️ Could not reach server — saved locally, will auto-retry');
    if(!syncRetryTimer){
      syncRetryTimer = setInterval(()=>{ if(navigator.onLine) trySyncNow(); }, 30000);
    }
  }
}

// ===================== TARGETED FIELD UPDATES (students/locks/archivedStudents) =====================
// attendance/state now only holds students, locks, and archivedStudents —
// attendance records moved to their own subcollection (see the big comment
// on the stateDoc listener above), which is small and slow-growing, so a
// full-document .set() on every roster/lock change is a much smaller
// concern than it used to be for records. BUT the same concurrency risk
// still applies here in principle: two admins editing the roster or a lock
// at the exact same moment could still silently overwrite each other with
// a blind .set(). These helpers use targeted .update() with FieldPath
// instead, so an edit to one section (or one lock) can never clobber a
// concurrent edit to a different one.
async function saveFields(fieldUpdates){
  persistLocal();
  if(!navigator.onLine){
    setPendingSync(true);
    setSyncStatus('error','⚠️ Offline — saved locally');
    if(!syncRetryTimer){
      syncRetryTimer = setInterval(()=>{ if(navigator.onLine) trySyncNow(); }, 30000);
    }
    return;
  }
  if(!fieldUpdates.length) return;

  setSyncStatus('syncing','Saving...');
  try{
    if(!stateDoc) throw new Error('Firebase unavailable');
    const args = [];
    fieldUpdates.forEach(([segments, value])=>{
      args.push(new firebase.firestore.FieldPath(...segments));
      args.push(value);
    });
    await stateDoc.update(...args);
    setPendingSync(false);
    setSyncStatus('synced','Saved to Firebase ✓');
  }catch(e){
    console.warn('[saveFields] targeted update failed, falling back to full save:', e.message);
    return saveState();
  }
}

// Roster mutation (add/delete/edit/promote/bulk import): scoped to just the
// section(s) actually touched, and archivedStudents if it changed.
async function saveRosterChange({ sections = [], archived = false } = {}){
  const updates = [];
  [...new Set(sections)].forEach(key => updates.push([['students', key], students[key]]));
  if(archived) updates.push([['archivedStudents'], archivedStudents]);
  return saveFields(updates);
}

// Lock/unlock (single section or all sections): scoped to just the lock
// key(s) actually touched.
async function saveLockFields(lockKeys){
  const updates = [...new Set(lockKeys)].map(lk => [
    ['locks', lk],
    locks[lk] === undefined ? firebase.firestore.FieldValue.delete() : locks[lk]
  ]);
  return saveFields(updates);
}

// Attendance marks and tracker entries are already written directly to the
// records subcollection inside setRecord()/setAttendanceTracker() — there is
// nothing left to save in attendance/state for a plain mark. This just
// waits for those writes and drives the same sync-status UI saveState()
// used to, without ever touching the roster/lock document at all (which is
// the point — marking attendance has no business overwriting the roster).
async function saveRecordWrites(writePromises){
  setSyncStatus('syncing','Saving...');
  try{
    await Promise.all(writePromises);
    setSyncStatus('synced','Saved to Firebase ✓');
  }catch(e){
    setPendingSync(true);
    setSyncStatus('error','⚠️ Sync failed — will retry');
    console.warn('[saveRecordWrites] failed:', e.message);
  }
}

// ===================== INIT =====================
window.addEventListener('load', initApp);
const monthSel=document.getElementById('month-sel');
const yearSel=document.getElementById('year-sel');
MONTHS.forEach((m,i)=>{const o=document.createElement('option');o.value=i;o.textContent=m;if(i===curMonth)o.selected=true;monthSel.appendChild(o);});
for(let y=curYear-2;y<=curYear+3;y++){const o=document.createElement('option');o.value=y;o.textContent=y;if(y===curYear)o.selected=true;yearSel.appendChild(o);}

async function initApp(){
  await initFirebase();
  // Real-time sync handled by onSnapshot listener in initFirebase — no polling needed
}

function showLogin(){
  document.getElementById('login-screen').style.display='block';
  document.getElementById('register-screen').style.display='none';
  document.getElementById('main-app').style.display='none';
  const pendingScreen = document.getElementById('pending-approval-screen');
  if(pendingScreen) pendingScreen.style.display='none';
  setSyncStatus('error','Please sign in to sync');
}

function showApp(user){
  document.getElementById('login-screen').style.display='none';
  document.getElementById('register-screen').style.display='none';

  if(currentUserRole==='pending'){
    document.getElementById('main-app').style.display='none';
    showPendingApprovalScreen(user);
    return;
  }
  document.getElementById('pending-approval-screen').style.display='none';
  document.getElementById('main-app').style.display='block';
  
  // Update user info
  document.getElementById('user-name-display').textContent=currentUserName || user.email;
  document.getElementById('user-role-display').textContent=(currentUserRole==='admin'?'Administrator':'Volunteer')+' — '+user.email;
  document.getElementById('user-role-icon').textContent=currentUserRole==='admin'?'👨‍💼':'🙋';
  
  // Hide analytics/audit/approvals tabs completely for volunteers
  const analyticsTab=document.getElementById('analytics-tab');
  const auditlogTab=document.getElementById('auditlog-tab');
  const approvalsTab=document.getElementById('approvals-tab');
  const backendTab=document.getElementById('backend-tab');
  if(currentUserRole==='volunteer'){
    analyticsTab.style.display='none';
    auditlogTab.style.display='none';
    approvalsTab.style.display='none';
    // If somehow on analytics/audit/approvals view, switch back to attendance
    if(curView==='analytics'||curView==='auditlog'||curView==='approvals'||curView==='backend'){ curView='attendance'; }
  } else {
    analyticsTab.style.display='';
    auditlogTab.style.display='';
    approvalsTab.style.display='';
    initPendingUsersListener();
    initStudentRequestsListener();
  }
  // Backend tab is independent of admin/volunteer — a normal admin who
  // isn't also a backend account never sees it, even though they see
  // everything else above. If it's currently open but this account isn't
  // backend (e.g. a different account just logged in), fall back to
  // attendance rather than leaving an inaccessible tab active.
  backendTab.style.display = currentUserIsBackend ? '' : 'none';
  if(!currentUserIsBackend && curView==='backend'){ curView='attendance'; }
  
  buildSundayBtns();
  renderCurrentSection();
  checkYearEndPromotion();
  migrateMissingStudentIds();
  checkDocumentSizeWarning();
  if(!docSizeCheckInterval){
    docSizeCheckInterval = setInterval(checkDocumentSizeWarning, 5*60*1000);
  }
  initCorrectionsListener();
  initMyStudentRequestsListener();
}

function showPendingApprovalScreen(user){
  document.getElementById('pending-approval-screen').style.display='flex';
  document.getElementById('pending-approval-email').textContent = user.email;
  const statusLine = document.getElementById('pending-approval-status');
  statusLine.textContent = currentUserStatus === 'rejected'
    ? 'This account\u2019s access request was not approved. Contact an admin if you think this is a mistake.'
    : 'Your account is waiting for an admin to approve it. You\u2019ll be able to sign in normally once approved — no need to register again.';
}

function signIn(){
  const email=document.getElementById('auth-email').value.trim();
  const password=document.getElementById('auth-password').value;
  if(!email||!password){showError('Enter email and password');return;}
  if(email.indexOf('@')===-1){showError('Enter valid email');return;}
  setSyncStatus('syncing','Signing in...');
  auth.signInWithEmailAndPassword(email,password).catch(e=>{
    setSyncStatus('error','Sign in failed');
    showError(e.message);
  });
}

function registerUser(){
  const name=document.getElementById('register-name').value.trim();
  const email=document.getElementById('register-email').value.trim();
  const password=document.getElementById('register-password').value;
  
  if(!name||!email||!password){
    showError('Fill all fields','register-error');
    return;
  }
  if(password.length<6){
    showError('Password must be at least 6 characters','register-error');
    return;
  }
  
  setSyncStatus('syncing','Registering...');
  isRegisteringNewAccount = true;
  auth.createUserWithEmailAndPassword(email,password).then(async (userCred)=>{
    // Save user info. status:'pending' means this account has NO write
    // access to attendance data until an admin approves it (see
    // loadUserRole() and the approvals tab). Previously this doc wrote a
    // `role` field that was never actually checked anywhere — removed.
    await db.collection('users').doc(userCred.user.uid).set({
      name:name,
      email:email,
      status:'pending',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    await auth.signOut(); // don't leave them signed into a pending/no-access session
    isRegisteringNewAccount = false;
    showToast('Account created — an admin needs to approve it before you can sign in.');
    showLoginMode();
  }).catch(e=>{
    isRegisteringNewAccount = false;
    setSyncStatus('error','Registration failed');
    showError(e.message,'register-error');
  });
}

function signOutUser(){
  auth.signOut().then(()=>{ showLogin(); setSyncStatus('error','Signed out'); }).catch(e=>{showToast('Sign out failed');});
}

// ===================== SUNDAYS =====================
function getSundays(year,month){
  const res=[];const d=new Date(year,month,1,12,0,0);
  while(d.getMonth()===month){if(d.getDay()===0)res.push(new Date(d));d.setDate(d.getDate()+1);}
  return res;
}
function fmtDate(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
// Display format DD-MM-YYYY (for showing to users)
function fmtDisplay(ds){if(!ds)return '';const[y,m,d]=ds.split('-');return `${d}-${m}-${y}`;}
function fmtShort(ds){const[,m,d]=ds.split('-').map(Number);return d+' '+MONTHS[m-1].slice(0,3);}
function fmtFull(ds){const[y,m,d]=ds.split('-').map(Number);return new Date(y,m-1,d,12).toLocaleDateString('en-IN',{weekday:'long',day:'numeric',month:'long',year:'numeric'});}
function getCurrentTime(){
  const now=new Date();
  return `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
}

async function onMonthChange(){
  curMonth=parseInt(monthSel.value);curYear=parseInt(yearSel.value);
  curDate=null;buildSundayBtns();
  await loadMonthAttendance();
  renderCurrent();
}

function buildSundayBtns(){
  const sundays=getSundays(curYear,curMonth);
  const row=document.getElementById('sundays-row');row.innerHTML='';
  if(!sundays.length){row.innerHTML='<span style="font-size:11px;color:#888">No Sundays found</span>';return;}
  const dStrs=sundays.map(fmtDate),todayStr=fmtDate(new Date());
  if(!curDate||!dStrs.includes(curDate)){
    // If today is a Sunday in this month's list, select it
    if(dStrs.includes(todayStr)){
      curDate=todayStr;
    } else {
      // Find the most recent past Sunday in this month
      const pastSundays=dStrs.filter(ds=>ds<=todayStr);
      if(pastSundays.length>0){
        curDate=pastSundays[pastSundays.length-1]; // last past Sunday
      } else {
        curDate=dStrs[0]; // fallback to first Sunday if all are future
      }
    }
  }
  dStrs.forEach(ds=>{
    const[,m,d]=ds.split('-').map(Number);
    const btn=document.createElement('button');
    btn.className='sunday-btn'+(ds===curDate?' active':'');
    btn.textContent=d+' '+MONTHS[m-1].slice(0,3)+(ds===todayStr?' · today':'');
    btn.onclick=async()=>{curDate=ds;buildSundayBtns();renderCurrent();};
    row.appendChild(btn);
  });
  document.getElementById('session-info').textContent=curDate?'Session: '+fmtFull(curDate):'';
}

// ===================== NAV =====================
document.querySelectorAll('.main-tab').forEach(btn=>{
  btn.addEventListener('click',()=>{
    if(btn.classList.contains('disabled')) return;
    document.querySelectorAll('.main-tab').forEach(t=>t.classList.remove('active'));
    btn.classList.add('active');curView=btn.dataset.view;
    document.getElementById('attendance-view').classList.toggle('visible',curView==='attendance');
    document.getElementById('analytics-view').classList.toggle('visible',curView==='analytics');
    document.getElementById('corrections-view').classList.toggle('visible',curView==='corrections');
    document.getElementById('auditlog-view').classList.toggle('visible',curView==='auditlog');
    document.getElementById('approvals-view').classList.toggle('visible',curView==='approvals');
    document.getElementById('backend-view').classList.toggle('visible',curView==='backend');
    renderCurrent();
  });
});
document.querySelectorAll('.type-tab').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.type-tab').forEach(t=>t.classList.remove('active'));
    btn.classList.add('active');curType=btn.dataset.type;
    document.getElementById('old-view').classList.toggle('visible',curType==='old');
    document.getElementById('new-view').classList.toggle('visible',curType==='new');
    document.getElementById('yuvaka-view').classList.toggle('visible',curType==='yuvaka');
    renderCurrentSection();
  });
});
document.querySelectorAll('.school-tab').forEach(btn=>{
  btn.addEventListener('click',()=>{
    const type=btn.closest('#old-view')?'old':'new';
    btn.closest('.school-tabs').querySelectorAll('.school-tab').forEach(t=>t.classList.remove('active'));
    btn.classList.add('active');
    const key=btn.dataset.key;curSchool[type]=key;
    document.querySelectorAll('#'+type+'-view .panel').forEach(p=>p.classList.remove('visible'));
    document.getElementById('panel-'+key).classList.add('visible');
    renderSection(key);
  });
});

let _renderTimer=null;
function renderCurrent(){
  clearTimeout(_renderTimer);
  _renderTimer=setTimeout(()=>{
    if(curView==='attendance')renderCurrentSection();
    else if(curView==='analytics')renderAnalytics();
    else if(curView==='corrections')renderCorrections();
    else if(curView==='auditlog')renderAuditLog();
    else if(curView==='approvals')renderApprovals();
    else if(curView==='backend')renderBackendTools();
  },50); // 50ms debounce prevents flicker on rapid section switching
}
function renderCurrentSection(){renderSection(curSchool['old']);renderSection(curSchool['new']);renderSection(curSchool['yuvaka']);renderGlobalLockBar();}

// ===================== RECORDS =====================
// Records are keyed by the student's permanent ID (via idFor), not their
// array position — this is what makes promotion, deletion, and section
// moves safe: a student's history stays attached to THEM regardless of
// where they end up sitting in the roster array afterward.
//
// Two different key formats are in play, deliberately:
//  - INTERNAL key (used everywhere in getStats/rendering/exports, unchanged
//    from before): "section|date|studentId[|tracker]"
//  - FIRESTORE document ID (used only at the persistence boundary):
//    "date|section|studentId[|tracker]" — date first, so a range query on
//    document ID can cheaply fetch "everything in these two years" without
//    downloading the entire history. This is what actually bounds ongoing
//    read cost and sync bandwidth as years of data accumulate — the
//    subcollection move alone fixes the 1 MiB single-document ceiling, but
//    without this, every client would still download every attendance mark
//    ever recorded, forever, on every load.
function parseInternalKey(recordKey){
  const parts = recordKey.split('|');
  return { section: parts[0], date: parts[1], studentId: parts[2], isTracker: parts[3]==='tracker' };
}
function firestoreDocIdFor(recordKey){
  const {section, date, studentId, isTracker} = parseInternalKey(recordKey);
  return date + '|' + section + '|' + studentId + (isTracker ? '|tracker' : '');
}
function internalKeyFromDocId(docId){
  const parts = docId.split('|');
  // parts[0]=date, parts[1]=section, parts[2]=studentId, parts[3]=optional 'tracker'
  return parts[1] + '|' + parts[0] + '|' + parts[2] + (parts[3] ? '|'+parts[3] : '');
}

// Writes (or deletes) exactly ONE attendance-record document. This is the
// actual persistence point for records now — not saveState(). Most callers
// don't await this (fire-and-forget): Firestore's own offline persistence
// (enabled in initFirebase) queues it automatically if the device is
// offline and retries once connectivity returns, so no custom retry logic
// is needed here, unlike the old whole-document approach.
function writeRecordKey(recordKey, value){
  if(!recordsCollection) return Promise.resolve();
  const {section, date, studentId} = parseInternalKey(recordKey);
  const ref = recordsCollection.doc(firestoreDocIdFor(recordKey));
  return (value === null || value === undefined)
    ? ref.delete().catch(e=>console.warn('[Records] delete failed for', recordKey, e))
    : ref.set({v: value, section, date, studentId}).catch(e=>console.warn('[Records] write failed for', recordKey, e));
}

// For bulk operations that touch many record keys at once (deleting or
// moving a student's entire attendance history) — one Firestore batch per
// 450 keys instead of many separate calls, and each batch is atomic.
async function writeRecordKeysBatch(entries){
  if(!recordsCollection || !entries.length) return;
  const CHUNK = 450; // stay safely under Firestore's 500-per-batch limit
  for(let start=0; start<entries.length; start+=CHUNK){
    const batch = db.batch();
    entries.slice(start, start+CHUNK).forEach(({key, value})=>{
      const {section, date, studentId} = parseInternalKey(key);
      const ref = recordsCollection.doc(firestoreDocIdFor(key));
      if(value === null || value === undefined) batch.delete(ref);
      else batch.set(ref, {v: value, section, date, studentId});
    });
    try{ await batch.commit(); }
    catch(e){ console.warn('[Records] batch write failed', e); }
  }
}

function getRecord(k,d,i){const id=idFor(k,i);return records[k+'|'+d+'|'+id]||null;}
function setRecord(k,d,i,v){
  const id=idFor(k,i);
  const rk=k+'|'+d+'|'+id;
  if(v===null) delete records[rk]; else records[rk]=v;
  return writeRecordKey(rk, v);
}

// Track who marked attendance
function getAttendanceTracker(k,d,i){const id=idFor(k,i);const key=k+'|'+d+'|'+id+'|tracker';return records[key] || {name:'',time:'',date:''};}
function setAttendanceTracker(k,d,i,name,time,date){
  const id=idFor(k,i);
  const key=k+'|'+d+'|'+id+'|tracker';
  const trackerVal={name,time,date};
  records[key]=trackerVal;
  return writeRecordKey(key, trackerVal);
}

function getStats(key,idx){
  const id=idFor(key,idx);
  const keys=Object.keys(records).filter(k=>{
    const parts=k.split('|');
    return parts.length===3 && parts[0]===key && parts[2]===id;
  });
  const dates=[...new Set(keys.map(k=>k.split('|')[1]))].sort();
  const total=dates.length,present=dates.filter(d=>records[key+'|'+d+'|'+id]==='P').length;
  const pct=total?Math.round(present/total*100):null;
  let streak=0;for(const d of [...dates].reverse()){if(records[key+'|'+d+'|'+id]==='P')streak++;else break;}
  const mSundays=getSundays(curYear,curMonth).map(fmtDate);
  const mTotal=mSundays.filter(d=>records[key+'|'+d+'|'+id]).length;
  const mPresent=mSundays.filter(d=>records[key+'|'+d+'|'+id]==='P').length;
  // Consecutive absences (from most recent session backwards)
  let consAbsent=0;
  for(const d of [...dates].reverse()){
    if(records[key+'|'+d+'|'+id]==='A') consAbsent++;
    else break;
  }
  return{present,total,pct,streak,mPresent,mTotal,consAbsent};
}

function todayStats(key){
  const st=students[key];let p=0,a=0,u=0;
  st.forEach((_,i)=>{const r=getRecord(key,curDate,i);if(r==='P')p++;else if(r==='A')a++;else u++;});
  return{present:p,absent:a,unmarked:u,total:st.length};
}

function barColor(pct){return pct>=75?'#1D9E75':pct>=50?'#EF9F27':'#D85A30';}
function pillClass(pct){return pct===null?'pill-gray':pct>=75?'pill-green':pct>=50?'pill-amber':'pill-red';}

// ===================== RENDER =====================
function renderSection(key){
  const panel=document.getElementById('panel-'+key);if(!panel)return;
  if(!curDate){panel.innerHTML='<div class="empty-state">Select a Sunday session above.</div>';return;}
  const st=students[key];
  const ts=todayStats(key),rate=ts.total?Math.round(ts.present/ts.total*100):0;

  let html=`<div class="export-bar">`;
  if(currentUserRole==='admin'){
    html+=`<button class="btn-export" onclick="exportExcel('${key}')">⬇ Export Excel</button>`;
  }
  html+=`<button class="btn-export" onclick="printAttendanceSheet()" style="background:#555">🖨 Print</button>`;
  const locked = isLocked(key, curDate);
  if(locked && currentUserRole==='admin'){
    html+=`<button class="btn-export" onclick="toggleSessionLock('${key}')" style="background:#856404">🔓 Unlock Session</button>`;
  } else if(!locked){
    // Both admins and volunteers can submit & lock — they're the ones
    // actually taking attendance and know when a session is complete.
    html+=`<button class="btn-export" onclick="toggleSessionLock('${key}')" style="background:#1D9E75">🔒 Submit &amp; Lock</button>`;
  }
  html+=`</div>`;
  if(locked){
    const lockInfo = locks[key+'|'+curDate] || {};
    html+=`<div style="background:#FFF3CD;border:1.5px solid #FFC107;border-radius:10px;padding:8px 14px;margin-bottom:10px;font-size:12.5px;color:#856404">
      🔒 <strong>This session is submitted and locked</strong>${lockInfo.lockedByName?' by '+escapeHtml(lockInfo.lockedByName):''}. 
      Marks can no longer be changed directly — tap ✓/✕ to raise a correction request instead.
    </div>`;
  }
  html+=`
  <div class="summary-grid">
    <div class="metric"><div class="metric-label">Total</div><div class="metric-value mv-blue">${st.length}</div></div>
    <div class="metric" onclick="setFilter('${key}','P')" title="Click to filter Present" style="cursor:pointer"><div class="metric-label">Present ▾</div><div class="metric-value mv-green">${ts.present}</div></div>
    <div class="metric" onclick="setFilter('${key}','A')" title="Click to filter Absent" style="cursor:pointer"><div class="metric-label">Absent ▾</div><div class="metric-value mv-red">${ts.absent}</div></div>
    <div class="metric" onclick="setFilter('${key}','U')" title="Click to show unmarked" style="cursor:pointer"><div class="metric-label">Not marked ▾</div><div class="metric-value">${ts.unmarked}</div></div>
    <div class="metric"><div class="metric-label">Rate</div><div class="metric-value" style="color:${barColor(rate)}">${rate}%</div></div>
  </div>
  <div class="controls">
    <input type="text" placeholder="Search student..." id="search-${key}" oninput="filterTable('${key}')">
    <select id="filter-${key}" onchange="filterTable('${key}')">
      <option value="">All</option><option value="P">Present</option><option value="A">Absent</option><option value="U">Not marked</option>
    </select>
    <select id="sort-${key}" onchange="setSortMode(this.value)" title="Sort order — display only, doesn't change the stored roster order">
      <option value="added" ${curSort==='added'?'selected':''}>Order Added</option>
      <option value="name" ${curSort==='name'?'selected':''}>Name (A-Z)</option>
      <option value="id" ${curSort==='id'?'selected':''}>ID (Join Order)</option>
    </select>
    <button class="btn-sm btn-green" onclick="markAll('${key}','P')">✓ All present</button>
    <button class="btn-sm btn-red" onclick="markAll('${key}','A')">✗ All absent</button>
  </div>`;
  
  // Add/Request student row — admin gets "+ Add" + Bulk Import, volunteer
  // gets "📨 Request to Add" (same modal, different behavior — see
  // openAddStudentModal/confirmAddStudent). Shown to both roles; only the
  // Bulk Import button stays admin-only.
  if(currentUserRole==='admin' || currentUserRole==='volunteer'){
    html+=`<div class="add-row">
      <input type="text" id="new-${key}" placeholder="Add ${isProfessionSection(key)?'volunteer':'student'} name..." onkeydown="if(event.key==='Enter')openAddStudentModal('${key}')">
      <button onclick="openAddStudentModal('${key}')">${currentUserRole==='admin'?'+ Add':'📨 Request to Add'}</button>
      ${currentUserRole==='admin'?`<button onclick="openBulkImport('${key}')" style="background:#1D9E75;color:#fff;border:none;border-radius:8px;padding:8px 14px;cursor:pointer;font-size:13px;margin-left:6px;">📥 Bulk Import</button>`:''}
    </div>`;
  }
  
  // ── Smart "Marked By" logic ──
  // Collect all unique markers for this session
  let markerSummary = '';
  if(currentUserRole === 'admin' && st.length > 0 && curDate){
    const markerMap = {}; // name -> count
    st.forEach((_,i) => {
      const t = getAttendanceTracker(key, curDate, i);
      if(t.name && getRecord(key, curDate, i)){
        markerMap[t.name] = (markerMap[t.name]||0) + 1;
      }
    });
    const uniqueMarkers = Object.keys(markerMap);
    if(uniqueMarkers.length === 1){
      // Single marker — show as section banner, hide per-row column
      const onlyMarker = uniqueMarkers[0];
      // Get the time from first marked student
      let markedTime = '';
      for(let i=0;i<st.length;i++){
        const t = getAttendanceTracker(key, curDate, i);
        if(t.name === onlyMarker){ markedTime = t.time + ' ' + fmtDisplay(t.date); break; }
      }
      markerSummary = `<div style="display:flex;align-items:center;gap:8px;padding:7px 12px;
        background:var(--blue-light);border-radius:8px;font-size:12px;margin-bottom:.6rem;border:1px solid var(--blue-mid)">
        <span>✅</span>
        <span>Marked by <strong style="color:var(--blue-dark)">${escapeHtml(onlyMarker)}</strong>
        <span style="color:var(--text3);font-size:11px"> · ${markedTime}</span></span>
      </div>`;
    } else if(uniqueMarkers.length > 1){
      // Multiple markers — show summary banner + keep per-row column
      const parts = uniqueMarkers.map(n=>`<strong>${escapeHtml(n)}</strong> (${markerMap[n]})`).join(', ');
      markerSummary = `<div style="display:flex;align-items:center;gap:8px;padding:7px 12px;
        background:var(--amber-light);border-radius:8px;font-size:12px;margin-bottom:.6rem;border:1px solid var(--amber)">
        <span>👥</span>
        <span>Marked by ${parts} — see column for details</span>
      </div>`;
    }
  }
  const multipleMarkers = currentUserRole==='admin' && (() => {
    if(!st.length || !curDate) return false;
    const names = new Set();
    st.forEach((_,i)=>{ const t=getAttendanceTracker(key,curDate,i); if(t.name && getRecord(key,curDate,i)) names.add(t.name); });
    return names.size > 1;
  })();

  html += markerSummary;

  html+=`<table><thead><tr>
    <th class="col-num">#</th><th class="col-name">${nameFieldLabel(key)==='Volunteer Name'?'Volunteer':'Name'}</th><th class="col-class">${secondaryFieldLabel(key)}</th>
    <th class="col-check">Present</th><th class="col-check">Absent</th>
    <th class="col-sessions">Sessions</th><th class="col-streak">Streak</th>
    <th class="col-bar">This month</th>`;
  
  if(currentUserRole==='admin'){
    if(multipleMarkers) html+=`<th class="col-tracker">Marked By</th>`;
    html+=`<th class="col-edit"></th><th class="col-del"></th>`;
  }
  html+=`<th style="width:28px"></th>`;
  html+=`</tr></thead><tbody id="tbody-${key}">`;

  let displayPos = 0;
  sortedIndices(key).forEach(i=>{
    const student = st[i];
    displayPos++;
    const name=typeof student==='string'?student:student.name;
    const studentClass=secondaryFieldValue(key, student);
    const rec=getRecord(key,curDate,i),s=getStats(key,i);
    const sessLabel=s.total>0?`${s.present} of ${s.total}${s.pct!==null?' ('+s.pct+'%)':''}`:'—';
    const streakHtml=s.streak>0?`<span style="color:#E24B4A;font-size:11px">🔥${s.streak}</span>`:(()=>{
      let ca=0;const allS=getSundays(curYear,curMonth);
      for(let si=allS.length-1;si>=0;si--){
        const r=getRecord(key,fmtDate(allS[si]),i);
        if(r==='A')ca++;else break;
      }
      return ca>=3?`<span style="background:#FCEBEB;color:#D85A30;border-radius:4px;padding:2px 5px;font-size:10px;font-weight:700">⚡${ca}</span>`:'<span style="font-size:11px;color:var(--text4)">—</span>';
    })();
    const barHtml=s.mTotal>0?`<div style="font-size:9px;color:var(--text3)">${s.mPresent}/${s.mTotal}</div><div class="pct-bar"><div class="pct-fill" style="width:${Math.round(s.mPresent/s.mTotal*100)}%;background:${barColor(Math.round(s.mPresent/s.mTotal*100))}"></div></div>`:'<span style="font-size:10px;color:var(--text4)">—</span>';

    // At-risk: below 50% with at least 2 sessions recorded
    const atRisk = s.total >= 2 && s.pct !== null && s.pct < 50;
    const atRiskBadge = atRisk
      ? `<span title="Attendance below 50% — at risk" style="display:inline-block;font-size:9px;padding:1px 5px;border-radius:10px;background:var(--red-light);color:var(--red-dark);font-weight:700;margin-left:5px;vertical-align:middle">⚠ AT RISK</span>`
      : '';

    // Consecutive absences: 2+ in a row
    const consAbsBadge = s.consAbsent >= 2
      ? `<span title="${s.consAbsent} Sundays absent in a row" style="display:inline-block;font-size:9px;padding:1px 5px;border-radius:10px;background:var(--amber-light);color:var(--amber-dark);font-weight:700;margin-left:5px;vertical-align:middle">⚡ ${s.consAbsent} ABSENT</span>`
      : '';

    html+=`<tr data-idx="${i}" data-name="${escapeHtml(name.toLowerCase())}" data-rec="${rec||'U'}">
      <td class="col-num" style="color:var(--text4)">${displayPos}</td>
      <td class="col-name"><span style="font-weight:600">${escapeHtml(name)}</span>${atRiskBadge}${consAbsBadge}<br><span style="font-size:9.5px;color:var(--text4);letter-spacing:.3px">${escapeHtml(idFor(key,i))}</span></td>
      <td class="col-class" style="font-size:11px;color:var(--text2)">${escapeHtml(studentClass)}</td>
      <td class="col-check"><input type="checkbox" class="present-check" ${rec==='P'?'checked':''} onchange="mark('${key}',${i},'P',this)"></td>
      <td class="col-check"><input type="checkbox" class="absent-check" ${rec==='A'?'checked':''} onchange="mark('${key}',${i},'A',this)"></td>
      <td class="col-sessions"><span class="pill ${pillClass(s.pct)}">${sessLabel}</span></td>
      <td class="col-streak">${streakHtml}</td>
      <td class="col-bar">${barHtml}</td>`;
    
    if(currentUserRole==='admin'){
      if(multipleMarkers){
        const tracker=getAttendanceTracker(key,curDate,i);
        // Ledger style: show name only on first row this person marked, blank for subsequent
        let markedCell = `<span style="color:var(--text4)">—</span>`;
        if(tracker.name && rec){
          // Find if this is the FIRST row this marker appears (looking at all previous marked rows)
          let isFirst = true;
          for(let j = 0; j < i; j++){
            if(getRecord(key,curDate,j)){
              const prev = getAttendanceTracker(key,curDate,j);
              if(prev.name === tracker.name){ isFirst = false; break; }
            }
          }
          markedCell = isFirst
            ? `<span style="color:var(--blue);font-weight:600">${escapeHtml(tracker.name)}</span><br><span style="font-size:10px;color:var(--text4)">${escapeHtml(tracker.time)}${tracker.date?' '+escapeHtml(fmtDisplay(tracker.date)):''}</span>`
            : `<span style="color:var(--text4);font-size:11px">↳</span>`;
        }
        html+=`<td class="col-tracker">${markedCell}</td>`;
      }
      html+=`<td class="col-edit"><button class="edit-btn" onclick="openEditStudentModal('${key}',${i})" title="Edit student">✏️</button></td>`;
      html+=`<td class="col-del"><button class="del-btn" onclick="removeStudent('${key}',${i})">🗑</button></td>`;
    }
    // History button (all roles)
    html+=`<td style="width:28px;text-align:center"><button class="edit-btn" onclick="openHistoryModal('${key}',${i})" title="View history">📋</button></td>`;
    html+=`</tr>`;
    
  });
  
  html+=`</tbody></table>`;
  if(!st.length)html+=`<div class="empty-state">No students yet. ${currentUserRole==='admin'?'Add one above.':'Use "Request to Add" above to ask an admin to add one.'}</div>`;
  panel.innerHTML=html;
}

// Modal functions
function openAddStudentModal(key){
  addStudentContext.key=key;
  document.getElementById('modal-student-name').value='';
  populateClassOptions(document.getElementById('modal-student-class'), key);
  document.getElementById('modal-student-profession-type').value='';
  document.getElementById('modal-student-profession-detail').value='';
  document.getElementById('modal-student-joining').value=fmtDate(new Date());
  document.getElementById('modal-student-origin').value='yuvaka';
  const profession = isProfessionSection(key);
  document.getElementById('add-class-group').style.display = profession ? 'none' : 'block';
  document.getElementById('add-profession-group').style.display = profession ? 'block' : 'none';
  // "Joined via" only makes sense for Yuvaka Sangha — a VBS-side add is
  // always, by definition, a fresh VBS join.
  document.getElementById('add-origin-group').style.display = (key === 'yuvaka-sangha') ? 'block' : 'none';
  document.getElementById('modal-student-name-label').textContent = nameFieldLabel(key)+' *';
  const isAdmin = currentUserRole === 'admin';
  document.getElementById('add-student-modal-title').textContent = isAdmin ? 'Add New Student' : 'Request to Add a Student';
  document.getElementById('add-student-submit-btn').textContent = isAdmin ? 'Add Student' : 'Send Request to Admin';
  document.getElementById('add-student-modal').classList.add('visible');
}

function closeAddStudentModal(){
  document.getElementById('add-student-modal').classList.remove('visible');
}

// Duplicate-name check across ALL sections. Returns the section key a
// duplicate was found in, or null if the name is free to use.
function findDuplicateStudentName(name) {
  let duplicateSection = null;
  Object.keys(students).forEach(sec => {
    (students[sec] || []).forEach(s => {
      const sName = (typeof s === 'object' ? s.name : s).trim().toLowerCase();
      if(sName === name.toLowerCase()) duplicateSection = sec;
    });
  });
  return duplicateSection;
}

// Looks up whether an archived (departed or graduated) student matches
// this name, and if so, asks whoever's actually deciding (the admin adding
// directly, or the admin reviewing a volunteer's request) whether to
// restore that exact original id + history. Returns the id to reuse, or
// null if there's no match or the decision was "no, different person."
function checkArchiveRestore(name) {
  const matchIdx = archivedStudents.findIndex(a => (a.name||'').trim().toLowerCase() === name.toLowerCase());
  if(matchIdx === -1) return null;
  const match = archivedStudents[matchIdx];
  const whenLabel = match.archivedAt ? fmtDisplay(match.archivedAt) : 'previously';
  const secLabel = (SECTIONS[match.section]||{}).label || match.section;
  const proceedRestore = confirm(
    'Found a previous student record for "' + name + '"\n' +
    '(' + (match.reason==='graduated' ? 'graduated from' : 'left') + ' ' + secLabel + ' on ' + whenLabel + ').\n\n' +
    'If this is the same person rejoining, click OK to restore their attendance history.\n' +
    'If this is a different person who just happens to share this name, click Cancel to start with a clean record.'
  );
  if(!proceedRestore) return null;
  archivedStudents.splice(matchIdx, 1); // no longer "departed" — active again
  return match.id;
}

// Actually creates the student and saves. Assumes duplicate-checking and
// the archive-restore decision have ALREADY been made by the caller — this
// is the one shared write path used by both the admin's direct "+ Add" and
// approveStudentRequest(), so both go through identical id-generation and
// save logic rather than two separately-maintained copies of it.
async function createStudentInRoster(skey, { name, joiningDate, studentClass, professionType, professionDetail, originOverride, restoredId }) {
  const profession = isProfessionSection(skey);
  const newStudent = { name, joiningDate, id: restoredId || await generateStudentId(joiningDate, originOverride || programFor(skey)) };
  if(profession){ newStudent.profession = { type: professionType, detail: professionDetail }; }
  else { newStudent.class = studentClass; }
  students[skey].push(newStudent);
  await saveRosterChange({ sections: [skey], archived: restoredId != null });
  renderSection(skey);
  return newStudent;
}

async function confirmAddStudent(){
  const name=document.getElementById('modal-student-name').value.trim();
  const joiningDate=document.getElementById('modal-student-joining').value;
  const profession = isProfessionSection(addStudentContext.key);

  const studentClass = profession ? '' : document.getElementById('modal-student-class').value;
  const professionType = profession ? document.getElementById('modal-student-profession-type').value : '';
  const professionDetail = profession ? document.getElementById('modal-student-profession-detail').value.trim() : '';
  // Only meaningful for Yuvaka Sangha: did this person grow up through VBS,
  // or are they a direct/new Yuvaka Sangha member? Determines which ID
  // prefix/counter they draw from — see programFor() and generateStudentId().
  const originOverride = (addStudentContext.key === 'yuvaka-sangha')
    ? document.getElementById('modal-student-origin').value
    : null;

  if(!name){showToast('Enter student name');return;}
  if(!profession && !studentClass){showToast('Select class');return;}
  if(profession && (!professionType || !professionDetail)){showToast('Select Profession or Education, and fill in the detail');return;}
  if(!joiningDate){showToast('Select joining date');return;}

  if(!addStudentContext.key) return;
  const skey = addStudentContext.key;

  const duplicateSection = findDuplicateStudentName(name);
  if(duplicateSection) {
    const secLabel = (SECTIONS[duplicateSection]||{}).label || duplicateSection;
    showToast('❌ "' + name + '" already exists in ' + secLabel + '!');
    document.getElementById('modal-student-name').focus();
    return; // BLOCK — no duplicates allowed
  }

  // Volunteers request; only an admin can actually add a student directly.
  // The archive-restore decision (does this name match someone who left
  // before?) also moves to approval time in that case — the admin
  // reviewing the request is the one with the context to answer that, not
  // necessarily the volunteer submitting it.
  if(currentUserRole !== 'admin'){
    if(!studentAddRequestsCollection){ showToast('Not connected — try again shortly'); return; }
    try{
      await studentAddRequestsCollection.add({
        section: skey, sectionLabel: (SECTIONS[skey]||{}).label || skey,
        name, joiningDate,
        class: profession ? null : studentClass,
        professionType: profession ? professionType : null,
        professionDetail: profession ? professionDetail : null,
        originOverride: originOverride || null,
        status: 'pending',
        requestedBy: currentUser?currentUser.email:'',
        requestedByName: currentUserName||'',
        requestedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      closeAddStudentModal();
      showToast('✅ Request sent — an admin will review it shortly');
    }catch(e){
      showToast('Error sending request: '+e.message);
    }
    return;
  }

  setSyncStatus('syncing','Adding student...');
  try{
    const restoredId = checkArchiveRestore(name);
    await createStudentInRoster(skey, { name, joiningDate, studentClass, professionType, professionDetail, originOverride, restoredId });
    if(restoredId){
      showToast('✅ ' + name + ' added — previous attendance history restored!');
    }
    closeAddStudentModal();
    if(!restoredId) showToast(name+' added');
  }catch(e){
    setSyncStatus('error','Failed to add student');
    showToast('Error adding student');
  }
}

async function mark(key,idx,type,el){
  if(isLocked(key,curDate)){
    el.checked = !el.checked; // revert the visual toggle — this session is locked
    openCorrectionModal(key, idx, type);
    return;
  }
  const writes = [];
  if(el.checked){
    writes.push(setRecord(key,curDate,idx,type));
    writes.push(setAttendanceTracker(key,curDate,idx,currentUserName,getCurrentTime(),fmtDate(new Date())));
    const oc=type==='P'?'absent-check':'present-check';
    const ob=el.closest('tr').querySelector('.'+oc);
    if(ob)ob.checked=false;
  } else {
    writes.push(setRecord(key,curDate,idx,null));
  }
  renderSection(key);filterTable(key);
  await saveRecordWrites(writes);
}

async function markAll(key,type){
  if(isLocked(key,curDate)){
    showToast('🔒 This session is submitted and locked — use a correction request instead');
    return;
  }
  if(!confirm('Mark ALL '+(type==='P'?'PRESENT':'ABSENT')+'?\n\nThis will overwrite existing marks for all '+students[key].length+' students.'))return;
  const writes = [];
  students[key].forEach((_,i)=>{
    writes.push(setRecord(key,curDate,i,type));
    writes.push(setAttendanceTracker(key,curDate,i,currentUserName,getCurrentTime(),fmtDate(new Date())));
  });
  renderSection(key);
  await saveRecordWrites(writes);
  showToast('All marked '+(type==='P'?'present':'absent'));
}

// Delete modal state
let deleteContext = { key: null, idx: null, name: '', option: null };

function removeStudent(key, idx) {
  const student = students[key][idx];
  const name = typeof student === 'string' ? student : student.name;
  deleteContext = { key, idx, name, option: null };

  document.getElementById('delete-student-name').textContent = name;
  document.getElementById('delete-modal-subtitle').textContent =
    'This will remove them from the ' + (SECTIONS[key]?.label||key) + ' list.';

  // Reset options
  selectDeleteOption(null);
  document.getElementById('delete-confirm-btn').style.display = 'none';
  document.getElementById('delete-overlay').style.display = 'flex';
}

function selectDeleteOption(option) {
  deleteContext.option = option;
  const keepEl = document.getElementById('delete-opt-keep');
  const delEl  = document.getElementById('delete-opt-delete');
  const btnEl  = document.getElementById('delete-confirm-btn');

  keepEl.style.border = '2px solid var(--border)';
  keepEl.style.background = 'var(--surface)';
  delEl.style.border  = '2px solid var(--border)';
  delEl.style.background = 'var(--surface)';

  if(option === 'keep') {
    keepEl.style.border = '2px solid var(--green)';
    keepEl.style.background = 'var(--green-light)';
    btnEl.style.display = 'inline-block';
    btnEl.textContent = '📦 Remove & Keep Records';
    btnEl.style.background = '#1D9E75';
  } else if(option === 'delete') {
    delEl.style.border = '2px solid #c0392b';
    delEl.style.background = 'var(--red-light)';
    btnEl.style.display = 'inline-block';
    btnEl.textContent = '🧹 Remove & Delete Records';
    btnEl.style.background = '#c0392b';
  }
}

function closeDeleteModal() {
  document.getElementById('delete-overlay').style.display = 'none';
  deleteContext = { key: null, idx: null, name: '', option: null };
}

async function confirmDeleteStudent() {
  const { key, idx, name, option } = deleteContext;
  if(!key || idx === null || !option) return;

  closeDeleteModal();
  setSyncStatus('syncing', 'Removing...');

  try {
    const removedStudent = students[key][idx];
    const removedId = idFor(key, idx);

    // Step 1: Remove student from the roster array.
    students[key].splice(idx, 1);

    // Step 2: Records are keyed by this student's permanent ID, not their
    // array position, so no other student's records are ever touched here
    // — nothing to shift, nothing to renumber.
    if(option === 'delete') {
      const keysToDelete = [];
      Object.keys(records).forEach(k => {
        const parts = k.split('|');
        if(parts[0] === key && parts[2] === removedId){ delete records[k]; keysToDelete.push(k); }
      });
      await writeRecordKeysBatch(keysToDelete.map(k=>({key:k, value:null})));
    } else {
      // 'keep' — the id-keyed records stay exactly where they are. Register
      // this student as archived so a later re-add of the same person can
      // find and reconnect to this exact ID (see confirmAddStudent).
      archivedStudents.push({
        id: removedId,
        name: name,
        section: key,
        class: (removedStudent && typeof removedStudent === 'object' ? removedStudent.class : '') || '',
        profession: (removedStudent && typeof removedStudent === 'object' ? removedStudent.profession : null) || null,
        joiningDate: (removedStudent && typeof removedStudent === 'object' ? removedStudent.joiningDate : '') || '',
        archivedAt: fmtDate(new Date()),
        reason: 'removed'
      });
    }

    await saveRosterChange({ sections: [key], archived: option === 'keep' });
    renderSection(key);
    showToast(name + (option === 'keep' ? ' removed — records kept 📦' : ' removed — records deleted 🧹'));
    setSyncStatus('synced', 'Saved');

  } catch(e) {
    console.error('Delete error:', e);
    setSyncStatus('error', 'Failed to remove');
    showToast('Error: ' + e.message);
  }
}

function setFilter(key, value){
  const sel = document.getElementById('filter-'+key);
  if(!sel) return;
  // Toggle off if already active
  sel.value = sel.value === value ? '' : value;
  filterTable(key);
}

function filterTable(key){
  const search=(document.getElementById('search-'+key)||{}).value||'';
  const filter=(document.getElementById('filter-'+key)||{}).value||'';
  document.querySelectorAll('#tbody-'+key+' tr').forEach(r=>{
    const nm=!search||r.dataset.name.includes(search.toLowerCase());
    const rc=!filter||r.dataset.rec===filter;
    r.style.display=(nm&&rc)?'':'none';
  });
}

// ===================== EXPORT =====================
function exportExcel(key){
  if(currentUserRole!=='admin'){showToast('Export is admin-only');return;}
  try{
    persistLocal();
    const sec=SECTIONS[key],st=students[key];
    if(!sec){ showToast('Unknown section: '+key); return; }
    const sundays=getSundays(curYear,curMonth).map(fmtDate);
    const monthLabel=MONTHS[curMonth]+' '+curYear;
    const header=['#','Student ID',nameFieldLabel(key),secondaryFieldLabel(key),'Joining Date',...sundays.map(fmtShort),'Sessions Attended','Total Sessions','Attendance %','Streak'];
    const rows=[header];
    st.forEach((student,i)=>{
      const name=typeof student==='string'?student:student.name;
      const studentClass=secondaryFieldValue(key, student);
      const joiningDate=typeof student==='string'?'':student.joiningDate||'';
      const s=getStats(key,i);
      rows.push([i+1,idFor(key,i),name,studentClass,fmtDisplay(joiningDate),...sundays.map(d=>{
        const r=getRecord(key,d,i);
        if(r==='P')return'P';
        if(r==='A')return'A';
        return '';
      }),s.present,s.total,s.pct!==null?s.pct+'%':'—',s.streak>0?s.streak:'—']);
    });
    const wb=XLSX.utils.book_new();
    const ws=XLSX.utils.aoa_to_sheet(rows);
    ws['!cols']=[{wch:4},{wch:14},{wch:24},{wch:10},{wch:14},...sundays.map(()=>({wch:10})),{wch:18},{wch:14},{wch:14},{wch:8}];
    XLSX.utils.book_append_sheet(wb,ws,sec.label.slice(0,31));
    XLSX.writeFile(wb,`${exportFilePrefix(key)}_${key}_${monthLabel.replace(' ','_')}.xlsx`);
    showToast('Excel downloaded!');
  }catch(e){
    console.error('[Export] exportExcel failed:', e);
    showToast('❌ Export failed: '+e.message);
  }
}

// "Export All" bundles the four Balaka Sangha sections into one workbook.
// Yuvaka Sangha is intentionally excluded here — it gets its own export via
// the per-section Export button (exportExcel) so the two groups' Excel
// sheets never get merged together.
function exportAllExcel(){
  if(currentUserRole!=='admin'){showToast('Export is admin-only');return;}
  try{
    persistLocal();
    const wb=XLSX.utils.book_new();
    const sundays=getSundays(curYear,curMonth).map(fmtDate);
    const monthLabel=MONTHS[curMonth]+' '+curYear;
    BALAKA_SEC_KEYS.forEach(key=>{
      const sec=SECTIONS[key],st=students[key];
      const header=['#','Student ID','Student Name',secondaryFieldLabel(key),'Joining Date',...sundays.map(fmtShort),'Attended','Total','%','Streak'];
      const rows=[header];
      st.forEach((student,i)=>{
        const name=typeof student==='string'?student:student.name;
        const studentClass=secondaryFieldValue(key, student);
        const joiningDate=typeof student==='string'?'':student.joiningDate||'';
        const s=getStats(key,i);
        rows.push([i+1,idFor(key,i),name,studentClass,fmtDisplay(joiningDate),...sundays.map(d=>{
          const r=getRecord(key,d,i);
          if(r==='P')return'P';
          if(r==='A')return'A';
          return '';
        }),s.present,s.total,s.pct!==null?s.pct+'%':'—',s.streak>0?s.streak:'—']);
      });
      const ws=XLSX.utils.aoa_to_sheet(rows);
      ws['!cols']=[{wch:4},{wch:14},{wch:24},{wch:10},{wch:14},...sundays.map(()=>({wch:9})),{wch:9},{wch:7},{wch:7},{wch:7}];
      XLSX.utils.book_append_sheet(wb,ws,sec.label.slice(0,31));
    });
    XLSX.writeFile(wb,`BalakaSangha_All_${monthLabel.replace(' ','_')}.xlsx`);
    showToast('All Balaka Sangha sections exported!');
  }catch(e){
    console.error('[Export] exportAllExcel failed:', e);
    showToast('❌ Export failed: '+e.message);
  }
}

// ===================== UTILITY: loadMonthAttendance stub =====================
async function loadMonthAttendance(){ /* data already in memory via real-time listener */ }

// ===================== DARK MODE =====================
function applyDarkMode(dark){
  document.body.classList.toggle('dark', dark);
  const btn = document.getElementById('dark-toggle-btn');
  if(btn) btn.textContent = dark ? '☀️ Light' : '🌙 Dark';
  try{ localStorage.setItem('balaka_dark', dark ? '1' : '0'); }catch(e){}
}
function toggleDarkMode(){
  const isDark = document.body.classList.contains('dark');
  applyDarkMode(!isDark);
}
// Init dark mode from storage
(function(){
  try{ if(localStorage.getItem('balaka_dark')==='1') applyDarkMode(true); }catch(e){}
})();

// ===================== FEATURE 1: EDIT STUDENT =====================
let editStudentContext = { key: null, idx: null };

function openEditStudentModal(key, idx) {
  if(currentUserRole !== 'admin'){ showToast('Admin only'); return; }
  const student = students[key][idx];
  const name = typeof student === 'string' ? student : student.name;
  const join = typeof student === 'object' ? student.joiningDate || '' : '';
  editStudentContext = { key, idx };
  document.getElementById('edit-student-name').value = name;
  document.getElementById('edit-student-joining').value = join;
  document.getElementById('edit-student-section').value = key;
  if(isProfessionSection(key)){
    const p = (typeof student === 'object' && student.profession) ? student.profession : {type:'',detail:''};
    document.getElementById('edit-student-profession-type').value = p.type||'';
    document.getElementById('edit-student-profession-detail').value = p.detail||'';
    document.getElementById('edit-student-class').value = '';
  } else {
    populateClassOptions(document.getElementById('edit-student-class'), key, typeof student === 'object' ? student.class : '');
    document.getElementById('edit-student-profession-type').value = '';
    document.getElementById('edit-student-profession-detail').value = '';
  }
  toggleEditFieldGroup(key);
  document.getElementById('edit-student-modal').classList.add('visible');
}
// Shows Class or Profession/Education (and "Student Name" vs "Volunteer
// Name") depending on which section is selected in the "Move to Section"
// dropdown — matters if an admin moves a student between Balaka Sangha and
// Yuvaka Sangha.
function toggleEditFieldGroup(key){
  const profession = isProfessionSection(key);
  document.getElementById('edit-class-group').style.display = profession ? 'none' : 'block';
  document.getElementById('edit-profession-group').style.display = profession ? 'block' : 'none';
  document.getElementById('edit-student-name-label').textContent = nameFieldLabel(key)+' *';
  if(!profession){
    // Re-populate for the newly selected section — e.g. moving someone
    // from Middle to High School should offer Class 8-10, not 4-7. Keep
    // their current selection if it's still valid for the new range,
    // otherwise clear it rather than silently keeping an out-of-range value.
    const classSelect = document.getElementById('edit-student-class');
    populateClassOptions(classSelect, key, classSelect.value);
  }
}
function onEditSectionChange(){
  toggleEditFieldGroup(document.getElementById('edit-student-section').value);
}
function closeEditStudentModal(){
  document.getElementById('edit-student-modal').classList.remove('visible');
  editStudentContext = { key: null, idx: null };
}
async function confirmEditStudent(){
  const { key, idx } = editStudentContext;
  if(key === null || idx === null) return;
  const newName    = document.getElementById('edit-student-name').value.trim();
  const newJoin    = document.getElementById('edit-student-joining').value;
  const newSection = document.getElementById('edit-student-section').value;
  const profession = isProfessionSection(newSection);
  const newClass        = profession ? '' : document.getElementById('edit-student-class').value;
  const professionType   = profession ? document.getElementById('edit-student-profession-type').value : '';
  const professionDetail = profession ? document.getElementById('edit-student-profession-detail').value.trim() : '';
  if(!newName){ showToast('Enter student name'); return; }
  if(!profession && !newClass){ showToast('Select class'); return; }
  if(profession && (!professionType || !professionDetail)){ showToast('Select Profession or Education, and fill in the detail'); return; }

  // Duplicate check (exclude self)
  let dupFound = false;
  Object.keys(students).forEach(sec => {
    students[sec].forEach((s, i) => {
      if(sec === key && i === idx) return; // skip self
      const n = (typeof s === 'object' ? s.name : s).trim().toLowerCase();
      if(n === newName.toLowerCase()) dupFound = true;
    });
  });
  if(dupFound){ showToast('❌ "'+newName+'" already exists in another section!'); return; }

  setSyncStatus('syncing', 'Saving...');
  try{
    const movedId = idFor(key, idx); // this student's permanent id, preserved across any edit or section move
    const buildStudent = () => {
      const s = { name: newName, joiningDate: newJoin, id: movedId };
      if(profession) s.profession = { type: professionType, detail: professionDetail };
      else s.class = newClass;
      return s;
    };
    // If section changed — move student, then re-key just THEIR records to
    // the new section prefix. Records are keyed by permanent id, so no
    // other student in either section is affected by this move at all.
    if(newSection !== key){
      students[key].splice(idx, 1);
      students[newSection].push(buildStudent());

      const moveEntries = [];
      Object.keys(records).forEach(k => {
        const parts = k.split('|');
        if(parts[0] === key && parts[2] === movedId){
          const rest = parts.slice(1).join('|');
          const newKey = newSection + '|' + rest;
          records[newKey] = records[k];
          delete records[k];
          moveEntries.push({key: newKey, value: records[newKey]});
          moveEntries.push({key: k, value: null});
        }
      });
      await writeRecordKeysBatch(moveEntries);
    } else {
      // Same section — just update in place, same id
      students[key][idx] = buildStudent();
    }

    await saveRosterChange({ sections: newSection !== key ? [key, newSection] : [key] });
    renderCurrentSection();
    closeEditStudentModal();
    showToast('✅ Student details updated!');
  }catch(e){
    setSyncStatus('error','Save failed');
    showToast('Error: '+e.message);
  }
}

// ===================== FEATURE 3: ATTENDANCE HISTORY =====================
async function openHistoryModal(key, idx){
  const student = students[key][idx];
  const name = typeof student === 'string' ? student : student.name;
  const cls  = isProfessionSection(key)
    ? secondaryFieldValue(key, student)
    : (typeof student === 'object' ? 'Class '+(student.class||'?') : '');
  const secLabel = (SECTIONS[key]||{}).label || key;
  const id = idFor(key, idx);

  // Open immediately with a loading state — the in-memory windowed records
  // (current + previous year) render right away, then get replaced by the
  // student's complete lifetime history once the on-demand fetch resolves.
  // Without this, opening History would only ever show the live-synced
  // window, silently missing anything older — which would look exactly
  // like lost history to whoever's looking, even though it's actually just
  // sitting in Firestore, unfetched.
  document.getElementById('history-title').textContent = name;
  document.getElementById('history-subtitle').textContent = cls + ' · ' + secLabel + ' · ' + id;
  document.getElementById('history-body').innerHTML = `<div style="text-align:center;padding:20px;color:var(--text3)">Loading full history...</div>`;
  document.getElementById('history-modal').classList.add('visible');

  // Baseline: whatever's already in memory for this student (from the
  // live-synced window), in case the on-demand fetch below fails — better
  // to show "at least the recent sessions" than nothing at all.
  const windowedForStudent = {};
  Object.keys(records).forEach(k=>{
    const parts = k.split('|');
    if(parts[0]===key && parts[2]===id) windowedForStudent[k] = records[k];
  });

  const fullHistory = await fetchFullHistoryForStudent(id);
  // fullHistory is keyed by the internal format already (section|date|id[|tracker])
  const merged = Object.assign({}, windowedForStudent, fullHistory);

  const allDates = [...new Set(
    Object.keys(merged)
      .filter(k => {
        const parts = k.split('|');
        return parts[0] === key && parts[2] === id && parts.length === 3;
      })
      .map(k => k.split('|')[1])
  )].sort().reverse();

  const getRec = d => merged[key+'|'+d+'|'+id] || null;
  const getTracker = d => merged[key+'|'+d+'|'+id+'|tracker'] || {name:'',time:'',date:''};

  const present = allDates.filter(d => getRec(d)==='P').length;
  const absent  = allDates.filter(d => getRec(d)==='A').length;
  const total   = allDates.length;
  const pct     = total ? Math.round(present/total*100) : 0;

  const pctColor = pct>=75?'var(--green)':pct>=50?'var(--amber)':'var(--red)';
  document.getElementById('history-stats').innerHTML = `
    <div class="history-stat"><div class="history-stat-val mv-blue">${total}</div><div class="history-stat-lbl">Sessions</div></div>
    <div class="history-stat"><div class="history-stat-val" style="color:var(--green)">${present}</div><div class="history-stat-lbl">Present</div></div>
    <div class="history-stat"><div class="history-stat-val" style="color:var(--red)">${absent}</div><div class="history-stat-lbl">Absent</div></div>
    <div class="history-stat"><div class="history-stat-val" style="color:${pctColor}">${pct}%</div><div class="history-stat-lbl">Rate</div></div>
  `;

  let rows = allDates.map(d => {
    const rec = getRec(d);
    const tracker = getTracker(d);
    const status = rec==='P'
      ? `<span class="pill pill-green">✓ Present</span>`
      : rec==='A'
        ? `<span class="pill pill-red">✗ Absent</span>`
        : `<span class="pill pill-gray">—</span>`;
    const markedBy = tracker.name ? `${escapeHtml(tracker.name)} <span style="color:var(--text4)">${escapeHtml(tracker.time)}${tracker.date?' '+escapeHtml(fmtDisplay(tracker.date)):''}</span>` : '—';
    return `<tr>
      <td>${fmtDisplay(d)}</td>
      <td>${MONTHS[parseInt(d.split('-')[1])-1]} ${d.split('-')[0]}</td>
      <td>${status}</td>
      <td style="font-size:11px;color:var(--text2)">${markedBy}</td>
    </tr>`;
  }).join('');

  if(!rows) rows = `<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--text3)">No attendance records yet.</td></tr>`;

  document.getElementById('history-body').innerHTML = `
    <table class="history-table">
      <thead><tr><th>Date</th><th>Month</th><th>Status</th><th>Marked By</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}
function closeHistoryModal(){
  document.getElementById('history-modal').classList.remove('visible');
}

// ===================== FEATURE 6: GLOBAL SEARCH =====================
function globalSearch(query){
  const q = query.trim().toLowerCase();
  const resultsEl = document.getElementById('global-search-results');
  if(!q){ resultsEl.classList.remove('visible'); resultsEl.innerHTML=''; return; }

  const matches = [];
  SEC_KEYS.forEach(key => {
    students[key].forEach((s, i) => {
      const name = typeof s === 'string' ? s : s.name;
      const cls  = secondaryFieldValue(key, s);
      const id = idFor(key, i);
      const nameHit = name.toLowerCase().includes(q);
      const idHit = id.toLowerCase().includes(q);
      if(nameHit || idHit){
        const stats = getStats(key, i);
        const pct = stats.pct !== null ? stats.pct+'%' : '—';
        const mark = curDate ? getRecord(key, curDate, i) : null; // 'P' | 'A' | null
        matches.push({ key, i, name, cls, id, idHit, pct, mark, section: (SECTIONS[key]||{}).label||key });
      }
    });
  });

  if(!matches.length){
    resultsEl.innerHTML = `<div style="padding:12px 16px;color:var(--text3);font-size:13px">No students found matching "${escapeHtml(query)}"</div>`;
    resultsEl.classList.add('visible');
    return;
  }

  resultsEl.innerHTML = matches.map(m => {
    const presentActive = m.mark === 'P';
    const absentActive  = m.mark === 'A';
    const statusTag = !curDate
      ? ''
      : m.mark === 'P' ? `<span style="font-size:10px;color:var(--green,#1D9E75);font-weight:700">✓ PRESENT</span>`
      : m.mark === 'A' ? `<span style="font-size:10px;color:var(--red,#C0392B);font-weight:700">✗ ABSENT</span>`
      : `<span style="font-size:10px;color:var(--text3)">NOT MARKED</span>`;
    // If the match came from the id rather than the name, show the id
    // highlighted right under the name instead of the usual class/section
    // line, so it's clear WHY this row matched.
    const idLine = m.idHit
      ? `<div class="global-result-meta" style="font-family:monospace">${highlightMatch(m.id, query)}</div>`
      : '';
    return `
    <div class="global-result-row" onclick="jumpToStudent('${m.key}',${m.i})">
      <span style="font-size:18px">👤</span>
      <div style="flex:1">
        <div class="global-result-name">${m.idHit ? escapeHtml(m.name) : highlightMatch(m.name, query)}</div>
        ${idLine}
        <div class="global-result-meta">${isProfessionSection(m.key) ? escapeHtml(m.cls) : 'Class '+escapeHtml(m.cls)} · ${escapeHtml(m.section)} · Attendance: ${m.pct} · ${statusTag}</div>
      </div>
      <span class="global-result-badge">${escapeHtml(m.section.split('—')[0].trim())}</span>
      ${curDate ? `
      <button onclick="event.stopPropagation();quickMarkFromSearch('${m.key}',${m.i},'P','${escapeForJsAttr(query)}')"
              title="Mark present"
              style="background:${presentActive?'#1D9E75':'var(--green-light,#E3F6EE)'};color:${presentActive?'#fff':'#1D9E75'};border:none;border-radius:6px;padding:4px 8px;font-size:12px;cursor:pointer;font-weight:700">✓</button>
      <button onclick="event.stopPropagation();quickMarkFromSearch('${m.key}',${m.i},'A','${escapeForJsAttr(query)}')"
              title="Mark absent"
              style="background:${absentActive?'#C0392B':'var(--red-light,#FBEAEA)'};color:${absentActive?'#fff':'#C0392B'};border:none;border-radius:6px;padding:4px 8px;font-size:12px;cursor:pointer;font-weight:700">✕</button>
      ` : ''}
      <button onclick="event.stopPropagation();openHistoryModal('${m.key}',${m.i})" 
              style="background:var(--blue-light);border:none;border-radius:6px;padding:4px 8px;font-size:11px;cursor:pointer;color:var(--blue-dark)">📋 History</button>
    </div>
  `;
  }).join('');
  resultsEl.classList.add('visible');
}

// Quick-mark attendance directly from global search results, no need to
// navigate to the student's section tab first.
async function quickMarkFromSearch(key, idx, type, query){
  if(!curDate){ showToast('Select a Sunday session first'); return; }
  if(isLocked(key, curDate)){
    clearGlobalSearch();
    openCorrectionModal(key, idx, type);
    return;
  }
  const writes = [
    setRecord(key, curDate, idx, type),
    setAttendanceTracker(key, curDate, idx, currentUserName, getCurrentTime(), fmtDate(new Date()))
  ];
  renderSection(key);
  filterTable(key);
  await saveRecordWrites(writes);
  const s = students[key][idx];
  const name = typeof s === 'string' ? s : s.name;
  showToast(name + ' marked ' + (type === 'P' ? 'present' : 'absent'));
  globalSearch(query); // refresh the results so the status tag/buttons update
}

function highlightMatch(name, query){
  const idx = name.toLowerCase().indexOf(query.toLowerCase());
  if(idx < 0) return escapeHtml(name);
  return escapeHtml(name.slice(0, idx)) + `<mark style="background:var(--amber-light);color:var(--amber-dark);border-radius:2px">${escapeHtml(name.slice(idx, idx+query.length))}</mark>` + escapeHtml(name.slice(idx+query.length));
}

function clearGlobalSearch(){
  document.getElementById('global-search-input').value = '';
  globalSearch('');
}

function jumpToStudent(key, idx){
  clearGlobalSearch();
  // Navigate to the right tabs
  const type = (SECTIONS[key]||{}).type === 'yuvaka' ? 'yuvaka' : (key.startsWith('old') ? 'old' : 'new');
  // Switch type tab
  document.querySelectorAll('.type-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.type-tab[data-type="${type}"]`).classList.add('active');
  curType = type;
  document.getElementById('old-view').classList.toggle('visible', type==='old');
  document.getElementById('new-view').classList.toggle('visible', type==='new');
  document.getElementById('yuvaka-view').classList.toggle('visible', type==='yuvaka');
  if(type !== 'yuvaka'){
    // Switch school tab (Yuvaka Sangha has no middle/high sub-tabs)
    curSchool[type] = key;
    const viewEl = document.getElementById(type+'-view');
    viewEl.querySelectorAll('.school-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.key===key);
    });
    viewEl.querySelectorAll('.panel').forEach(p => p.classList.remove('visible'));
    const panelEl = document.getElementById('panel-'+key);
    if(panelEl) panelEl.classList.add('visible');
  }
  // Switch main tab to attendance
  document.querySelectorAll('.main-tab').forEach(t => t.classList.remove('active'));
  document.querySelector('.main-tab[data-view="attendance"]').classList.add('active');
  curView = 'attendance';
  document.getElementById('attendance-view').classList.add('visible');
  document.getElementById('analytics-view').classList.remove('visible');
  renderSection(key);
  // Highlight row
  setTimeout(()=>{
    const tbody = document.getElementById('tbody-'+key);
    if(!tbody) return;
    const targetRow = tbody.querySelector(`tr[data-idx="${idx}"]`);
    if(targetRow){
      targetRow.scrollIntoView({behavior:'smooth', block:'center'});
      targetRow.style.transition='background .3s';
      targetRow.style.background='var(--blue-light)';
      setTimeout(()=>{ targetRow.style.background=''; },2000);
    }
  }, 150);
}

// ===================== FEATURE 5: EXPORT ALL MONTHS =====================
async function exportAllMonths(){
  if(currentUserRole!=='admin'){showToast('Admin only');return;}
  showToast('Building multi-month export...');
  try{
    const wb = XLSX.utils.book_new();
    const yearSel = document.getElementById('year-sel');
    const exportYear = parseInt(yearSel.value);

    for(let m=0; m<12; m++){
      const sundays = getSundays(exportYear, m).map(fmtDate);
      if(!sundays.length) continue;
      const monthLabel = MONTHS[m];
      SEC_KEYS.filter(k=>!isProfessionSection(k)).forEach(key => {
        const sec = SECTIONS[key], st = students[key];
        if(!st.length) return;
        const header = ['#','Student ID','Name',secondaryFieldLabel(key),'Joining Date',...sundays.map(d=>{ const[,mo,day]=d.split('-').map(Number); return day+' '+MONTHS[mo-1].slice(0,3); }),'Attended','Total','%','Streak'];
        const rows = [header];
        st.forEach((student,i) => {
          const name = typeof student==='string'?student:student.name;
          const cls  = secondaryFieldValue(key, student);
          const join = typeof student==='string'?'':student.joiningDate||'';
          const s = getStats(key,i);
          rows.push([i+1,idFor(key,i),name,cls,fmtDisplay(join),...sundays.map(d=>{
            const r=getRecord(key,d,i);
            if(r==='P')return'P'; if(r==='A')return'A'; return '';
          }),s.present,s.total,s.pct!==null?s.pct+'%':'—',s.streak>0?s.streak:'—']);
        });
        const ws = XLSX.utils.aoa_to_sheet(rows);
        ws['!cols']=[{wch:4},{wch:14},{wch:22},{wch:7},{wch:12},...sundays.map(()=>({wch:8})),{wch:8},{wch:7},{wch:7},{wch:7}];
        const sheetName = (monthLabel.slice(0,3)+'-'+sec.label.slice(0,22)).slice(0,31);
        XLSX.utils.book_append_sheet(wb, ws, sheetName);
      });
    }

    // If every Balaka Sangha section had zero students for the whole year,
    // the workbook would have no sheets at all — XLSX.writeFile throws on
    // an empty workbook, which used to fail silently with no visible error.
    if(wb.SheetNames.length === 0){
      showToast('⚠️ Nothing to export — no students with attendance data found for '+exportYear);
      return;
    }

    XLSX.writeFile(wb, `BalakaSangha_FullYear_${exportYear}.xlsx`);
    showToast('✅ Full year exported!');
  }catch(e){
    console.error('[Export] exportAllMonths failed:', e);
    showToast('❌ Export failed: '+e.message);
  }
}

// ===================== FEATURE 8: PRINT =====================
function printAttendanceSheet(){
  const key = curSchool[curType];
  const sec = SECTIONS[key];
  const subtitle = `${sec.label} — ${MONTHS[curMonth]} ${curYear}${curDate?' — Session: '+fmtFull(curDate):''}`;
  document.getElementById('print-subtitle').textContent = subtitle;
  window.print();
}

// ===================== ANALYTICS =====================
function destroyChart(id){if(chartInstances[id]){chartInstances[id].destroy();delete chartInstances[id];}}

function renderAnalytics(){
  if(currentUserRole!=='admin'){
    document.getElementById('analytics-content').innerHTML='<div class="empty-state"><h2>🔒 Restricted Access</h2><p>Analytics are available to administrators only.</p></div>';
    return;
  }
  
  const sundays=getSundays(curYear,curMonth).map(fmtDate);
  const labels=sundays.map(fmtShort),monthLabel=MONTHS[curMonth]+' '+curYear;

  let html=`<div class="export-bar">
    <button class="btn-export" onclick="exportAllExcel()">⬇ This Month (Balaka Sangha)</button>
    <button class="btn-export" onclick="exportAllMonths()" style="background:var(--green)">📅 Full Year Export</button>
    <button class="btn-export" onclick="printAttendanceSheet()" style="background:#555">🖨 Print Sheet</button>
  </div>
  <div class="section-block">
    <div class="analytics-h3">This session — ${curDate?fmtFull(curDate):'none selected'}</div>
    <div class="chart-grid">`;

  SEC_KEYS.forEach(key=>{
    const sec=SECTIONS[key],st=students[key];
    let p=0,a=0,u=0;
    if(curDate&&st.length){st.forEach((_,i)=>{const r=getRecord(key,curDate,i);if(r==='P')p++;else if(r==='A')a++;else u++;});}
    html+=`<div class="chart-card">
      <div class="chart-title">${sec.label}</div>
      <div class="chart-subtitle">${st.length} students</div>
      <div style="position:relative;height:140px"><canvas id="pie-${key}"></canvas></div>
      <div class="legend">
        <span><span class="legend-dot" style="background:#1D9E75"></span>Present ${p}</span>
        <span><span class="legend-dot" style="background:#D85A30"></span>Absent ${a}</span>
        <span><span class="legend-dot" style="background:#888"></span>Unmarked ${u}</span>
      </div>
    </div>`;
  });
  html+=`</div></div>`;

  html+=`<div class="section-block"><div class="analytics-h3">Monthly trend — ${monthLabel}</div>`;
  SEC_KEYS.forEach(key=>{
    const sec=SECTIONS[key];
    html+=`<div class="chart-card" style="margin-bottom:10px">
      <div class="chart-title">${sec.label} — Sunday-wise attendance %</div>
      <div style="position:relative;height:130px"><canvas id="bar-${key}"></canvas></div>
    </div>`;
  });
  html+=`</div>`;

  html+=`<div class="section-block"><div class="analytics-h3">All sections compared — ${monthLabel}</div>
    <div class="chart-card">
      <div class="chart-title">Attendance % per Sunday</div>
      <div style="position:relative;height:210px"><canvas id="bar-all"></canvas></div>
      <div class="legend">${SEC_KEYS.map(k=>`<span><span class="legend-dot" style="background:${SECTIONS[k].color}"></span>${SECTIONS[k].label}</span>`).join('')}</div>
    </div>
  </div>`;

  document.getElementById('analytics-content').innerHTML=html;

  SEC_KEYS.forEach(key=>{
    const st=students[key];let p=0,a=0,u=0;
    if(curDate&&st.length){st.forEach((_,i)=>{const r=getRecord(key,curDate,i);if(r==='P')p++;else if(r==='A')a++;else u++;});}
    destroyChart('pie-'+key);
    const el=document.getElementById('pie-'+key);
    if(el)chartInstances['pie-'+key]=new Chart(el,{type:'doughnut',data:{labels:['Present','Absent','Not marked'],datasets:[{data:[p,a,u],backgroundColor:['#1D9E75','#D85A30','#888'],borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}}}});
  });

  SEC_KEYS.forEach(key=>{
    const sec=SECTIONS[key],st=students[key];
    const data=sundays.map(d=>{const p=st.filter((_,i)=>getRecord(key,d,i)==='P').length;return st.length?Math.round(p/st.length*100):0;});
    destroyChart('bar-'+key);
    const el=document.getElementById('bar-'+key);
    if(el)chartInstances['bar-'+key]=new Chart(el,{type:'bar',data:{labels,datasets:[{label:'%',data,backgroundColor:sec.color,borderRadius:3}]},options:{responsive:true,maintainAspectRatio:false,scales:{y:{min:0,max:100,ticks:{callback:v=>v+'%',font:{size:10}},grid:{color:'rgba(0,0,0,.05)'}},x:{ticks:{font:{size:10},autoSkip:false}}},plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>ctx.parsed.y+'%'}}}}});
  });

  destroyChart('bar-all');
  const oEl=document.getElementById('bar-all');
  if(oEl){
    const datasets=SEC_KEYS.map(key=>({label:SECTIONS[key].label,data:sundays.map(d=>{const st=students[key];const p=st.filter((_,i)=>getRecord(key,d,i)==='P').length;return st.length?Math.round(p/st.length*100):0;}),backgroundColor:SECTIONS[key].color,borderRadius:2}));
    chartInstances['bar-all']=new Chart(oEl,{type:'bar',data:{labels,datasets},options:{responsive:true,maintainAspectRatio:false,scales:{y:{min:0,max:100,ticks:{callback:v=>v+'%',font:{size:10}},grid:{color:'rgba(0,0,0,.05)'}},x:{ticks:{font:{size:10},autoSkip:false}}},plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>ctx.dataset.label+': '+ctx.parsed.y+'%'}}}}});
  }
}



if('serviceWorker' in navigator){
  navigator.serviceWorker.register('service-worker.js').then(()=>console.log('SW registered')).catch(()=>console.log('SW register failed'));

  // Without this, a new service worker version can install and take over
  // network requests (via skipWaiting()/clients.claim() in
  // service-worker.js) while anyone who ALREADY has the app open keeps
  // running the OLD JS silently in memory — nothing forces their existing
  // tab to actually pick up the update until they happen to close and
  // reopen it themselves. This reloads automatically the moment a new
  // service worker actually takes control, so "I deployed a fix but people
  // are still seeing the old version" stops being something that can
  // happen silently. Guarded against reloading more than once per page
  // load, since controllerchange can otherwise fire more than once.
  let reloadedForNewSW = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if(reloadedForNewSW) return;
    reloadedForNewSW = true;
    window.location.reload();
  });
}

// ===================== YEAR-END CLASS PROMOTION =====================

function getLastSundayOfMay(year) {
  // Find last Sunday of May
  const d = new Date(year, 5, 0); // Last day of May
  d.setDate(d.getDate() - d.getDay()); // Go back to Sunday
  return d;
}

function getFirstSundayOfJune(year) {
  const d = new Date(year, 5, 1); // June 1
  const day = d.getDay();
  const diff = day === 0 ? 0 : 7 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function fmtDateOnly(d) {
  return d.toISOString().split('T')[0];
}

// Shared, cross-device guard against running promotion more than once in
// the same year. The old version used localStorage, which is per-browser —
// if this org has more than one admin (the normal case), each admin's own
// device would have its OWN "already done" flag, meaning an admin who
// simply hadn't opened the app yet that week would see "not done" and
// silently re-run promotion — auto mode has no confirmation dialog, so
// this would double-promote everyone (class 6→8 instead of 6→7) with no
// warning to anyone. A Firestore transaction makes "claiming" this year's
// promotion atomic and shared: whichever admin's device gets there first
// wins, and every other device correctly sees it's already been claimed.
const PROMOTION_STATUS_DOC_PATH = 'attendance/promotionStatus';
async function claimYearPromotion(year){
  if(!db) return false;
  const ref = db.doc(PROMOTION_STATUS_DOC_PATH);
  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const lastPromotedYear = (snap.exists && typeof snap.data().lastPromotedYear === 'number') ? snap.data().lastPromotedYear : 0;
    if(lastPromotedYear >= year) return false; // someone else already claimed/ran this year
    tx.set(ref, { lastPromotedYear: year });
    return true; // this device just won the race — go ahead and run it
  });
}

function checkYearEndPromotion() {
  if(currentUserRole !== 'admin') return;

  const today = new Date();
  const lastMaySunday = getLastSundayOfMay(today.getFullYear());
  const firstJuneSunday = getFirstSundayOfJune(today.getFullYear());
  const todayStr = fmtDateOnly(today);
  const lastMayStr = fmtDateOnly(lastMaySunday);

  // Show reminder on last Sunday of May
  if(todayStr === lastMayStr) {
    document.getElementById('upgrade-banner').style.display = 'block';
  }

  // Auto-promote on/after the first Sunday of June. Using >= (not an exact
  // date match) means any admin login on or after that date catches it up,
  // however late — this is intentionally open-ended, not capped at any
  // fixed window, since the alternative (missing the window entirely) is
  // worse than being a few weeks late. The claimYearPromotion() transaction
  // above is what makes this safe with multiple admins: only the first
  // device to check in after the date actually runs it.
  if(today >= firstJuneSunday) {
    claimYearPromotion(today.getFullYear()).then(won => {
      if(won) runClassPromotion(true); // true = auto (no confirm dialog)
    });
  }
}

async function runClassPromotion(auto = false) {
  if(currentUserRole !== 'admin') {
    showToast('Only admins can promote classes');
    return;
  }

  const SECTION_KEYS = ['old-middle', 'old-high', 'new-middle', 'new-high'];

  // Flatten every Balaka Sangha student across all 4 sections into one
  // list first. This is what makes it possible to move someone between
  // Middle/High and New/Old in the SAME step — e.g. a "new-middle" Class 7
  // student completing one year becomes an "old-high" Class 8 student in
  // one promotion, not a class-increment followed by a separate manual
  // section move. Middle School = Class 4-7, High School = Class 8-10 —
  // whichever range the INCREMENTED class falls into determines the
  // destination, regardless of which section they started in.
  //
  // The New→Old side is simpler than it might look: ANY student who
  // survives one full annual promotion cycle becomes "old" this same
  // cycle, whether they were "new" or already "old" going in — so the
  // destination section is always "old-middle" or "old-high", never
  // "new-*". "new-*" only ever gets repopulated by fresh additions made
  // after this point, until the cycle repeats next year.
  const allEntries = [];
  SECTION_KEYS.forEach(key => {
    (students[key] || []).forEach(s => allEntries.push({ student: s, fromSection: key }));
  });

  const graduated = [];
  const survivors = []; // { student, fromSection, toSection }

  allEntries.forEach(({ student: s, fromSection }) => {
    if(typeof s !== 'object'){
      // legacy string-only entry (no class field to reason about) —
      // carried over as-is, in its current section, unchanged.
      survivors.push({ student: s, fromSection, toSection: fromSection });
      return;
    }
    const oldClass = parseInt(s.class);
    if(oldClass === 10){
      graduated.push({ name: s.name, section: fromSection, id: s.id, joiningDate: s.joiningDate });
      return;
    }
    const newClass = oldClass + 1;
    const toSection = 'old-' + (newClass <= 7 ? 'middle' : 'high');
    survivors.push({ student: { ...s, class: String(newClass) }, fromSection, toSection });
  });

  // Anyone whose section is actually changing — used both for the
  // confirmation message (so an admin sees this before it happens, not
  // after) and for migrating their existing attendance records afterward.
  const crossovers = survivors.filter(x => x.fromSection !== x.toSection);

  if(!auto) {
    const graduateNames = graduated.map(g => g.name).join(', ') || 'None';
    const crossoverLines = crossovers.length
      ? crossovers.map(x => `${typeof x.student==='object'?x.student.name:x.student}: ${x.fromSection.replace('-',' ')} → ${x.toSection.replace('-',' ')}`).join('\n')
      : 'None';
    const msg = `This will promote ALL students up one class.\n\n` +
      `🎓 Class 10 students who will GRADUATE (removed):\n${graduateNames}\n\n` +
      `↔️ Students moving between New/Old and/or Middle/High:\n${crossoverLines}\n\n` +
      `Everyone else moves up one class within their current section.\n\nProceed?`;
    if(!confirm(msg)) return;

    // Manual runs need the SAME atomic claim the automatic June trigger
    // uses (see checkYearEndPromotion/claimYearPromotion above) — without
    // this, two admins both clicking "Promote Now" within moments of each
    // other would both pass this confirm dialog and both run the full
    // promotion, silently double-promoting everyone (e.g. class 6→8
    // instead of 6→7). Checked AFTER confirm, not before: claiming marks
    // the year as done immediately, so claiming before the admin has even
    // decided to proceed would permanently burn this year's promotion if
    // they then hit Cancel.
    const won = await claimYearPromotion(new Date().getFullYear());
    if(!won) {
      showToast('⚠️ Classes were already promoted this year (possibly by another admin just now) — nothing done.');
      return;
    }
  }

  setSyncStatus('syncing', 'Promoting classes...');

  try {
    // Redistribute survivors into their correct destination sections.
    const newSectionArrays = { 'old-middle': [], 'old-high': [], 'new-middle': [], 'new-high': [] };
    survivors.forEach(({ student, toSection }) => newSectionArrays[toSection].push(student));
    SECTION_KEYS.forEach(key => { students[key] = newSectionArrays[key]; });

    // Migrate attendance records for anyone whose section actually changed
    // — otherwise their history would still be filed under their OLD
    // section prefix while they're now rendered under a different one.
    // NOTE (same limitation as confirmEditStudent's section-move logic):
    // this only finds records currently sitting in the live in-memory
    // window (current + previous year). Anything older is not re-keyed by
    // this step — it isn't lost (still reachable by the History modal's
    // on-demand fetch, which matches by student ID regardless of section),
    // but it would still be filed under the old section prefix rather than
    // the new one if ever queried that way directly.
    const moveEntries = [];
    crossovers.forEach(({ student, fromSection, toSection }) => {
      if(typeof student !== 'object' || !student.id) return;
      Object.keys(records).forEach(k => {
        const parts = k.split('|');
        if(parts[0] === fromSection && parts[2] === student.id){
          const rest = parts.slice(1).join('|');
          const newKey = toSection + '|' + rest;
          records[newKey] = records[k];
          delete records[k];
          moveEntries.push({key: newKey, value: records[newKey]});
          moveEntries.push({key: k, value: null});
        }
      });
    });
    if(moveEntries.length) await writeRecordKeysBatch(moveEntries);

    // Records are keyed by each student's permanent id, not their array
    // position, so promoting or graduating students never requires
    // rebuilding anyone's attendance history — a survivor's records stay
    // attached to them automatically no matter how the roster array
    // shifts underneath them.

    // Register graduates in the same archived-students list that "removed
    // & keep records" uses, so if a promotion turns out to have been a
    // mistake, re-adding that name restores their exact original id and
    // history rather than starting fresh.
    graduated.forEach(g => {
      if(!g.id) return; // no id to register (shouldn't normally happen post-migration)
      archivedStudents.push({
        id: g.id, name: g.name, section: g.section, class: '10',
        profession: null, joiningDate: g.joiningDate || '',
        archivedAt: fmtDate(new Date()), reason: 'graduated'
      });
    });

    await saveRosterChange({ sections: SECTION_KEYS, archived: true });
    // NOTE: no separate "mark year as done" write needed here anymore —
    // both the auto path (claimed in checkYearEndPromotion) and the manual
    // path (claimed just above, right after confirm) already recorded the
    // claim atomically BEFORE any of this work started, which is what
    // actually protects against double-runs. Writing it again here would
    // just be redundant, not additionally protective.

    // Hide banner
    document.getElementById('upgrade-banner').style.display = 'none';

    // Show graduated students
    if(graduated.length > 0) {
      const list = document.getElementById('graduated-list');
      list.innerHTML = graduated.map(g =>
        `<div style="padding:6px 0;border-bottom:1px solid var(--border);color:var(--text)">
          🎓 <strong>${escapeHtml(g.name)}</strong> 
          <span style="color:var(--text3);font-size:11px;">(${escapeHtml(g.section.replace('-',' '))})</span>
        </div>`
      ).join('');
      document.getElementById('graduated-overlay').style.display = 'flex';
    }

    renderCurrentSection();
    showToast('✅ All classes promoted successfully!');
    setSyncStatus('synced', 'Classes promoted');

  } catch(e) {
    setSyncStatus('error', 'Promotion failed');
    showToast('Error: ' + e.message);
  }
}

// ---------- Records subcollection (see writeRecordKey/writeRecordKeysBatch
// above and the big comment on the stateDoc listener for why this exists) ----------
let latestSubcollectionRecords = {}; // raw cache of what's in the CURRENT WINDOW of the 'records' subcollection

// Merges the new subcollection data with whatever's still sitting in the
// OLD attendance/state.records field (if any hasn't been migrated yet).
// Subcollection wins for any key present in both, but nothing that exists
// ONLY in the old field ever disappears from the UI just because it hasn't
// been migrated — that would look exactly like silent data loss to an
// admin, which is precisely what this whole migration exists to prevent.
function rebuildRecordsFromSources(){
  records = Object.assign({}, legacyRecordsField || {}, latestSubcollectionRecords);
  renderCurrent();
}

// How many years of history to keep live-synced at all times. Covers "this
// year's sessions" (daily use) and "last year" (year-over-year comparisons
// in Analytics) without ever downloading the organization's entire history
// on every login. Older years are fetched on-demand only when a specific
// feature actually needs them (see fetchFullHistoryForStudent below) —
// there's no need to keep them resident in memory or re-synced live.
const RECORDS_WINDOW_YEARS_BACK = 1;

function currentRecordsWindowBounds(){
  const thisYear = new Date().getFullYear();
  const startYear = thisYear - RECORDS_WINDOW_YEARS_BACK;
  const endYearExclusive = thisYear + 1;
  return { start: startYear + '-01-01', endExclusive: endYearExclusive + '-01-01' };
}

let recordsListenerUnsubscribe = null;
function initRecordsListener(){
  if(!recordsCollection) return;
  if(recordsListenerUnsubscribe) recordsListenerUnsubscribe(); // avoid stacking listeners if this is ever called again (e.g. after a year rolls over)

  const { start, endExclusive } = currentRecordsWindowBounds();
  recordsListenerUnsubscribe = recordsCollection
    .where(firebase.firestore.FieldPath.documentId(), '>=', start)
    .where(firebase.firestore.FieldPath.documentId(), '<', endExclusive)
    .onSnapshot(snapshot=>{
      const fromSubcollection = {};
      snapshot.forEach(doc=>{ fromSubcollection[internalKeyFromDocId(doc.id)] = doc.data().v; });
      latestSubcollectionRecords = fromSubcollection;
      rebuildRecordsFromSources();
    }, err=>console.warn('[Records] windowed listener error', err));
}

// On-demand fetch for a SPECIFIC student's complete lifetime history,
// regardless of the live-synced window above — used by the History modal,
// which is explicitly asking "show me everything for this one person," not
// "show me the current session." A one-off .get() (not a persistent
// listener), filtered by the studentId field rather than a date range,
// since we don't know in advance which years that student has records in.
// Firestore auto-indexes single-field equality filters, so this doesn't
// need any manual index configuration.
async function fetchFullHistoryForStudent(studentId){
  if(!recordsCollection) return {};
  try{
    const snapshot = await recordsCollection.where('studentId', '==', studentId).get();
    const result = {};
    snapshot.forEach(doc=>{ result[internalKeyFromDocId(doc.id)] = doc.data().v; });
    return result;
  }catch(e){
    console.warn('[Records] full-history fetch failed for', studentId, e);
    return {};
  }
}

// ---------- §1.3/§4 fix: new-account approvals ----------
let allPendingUsers = [];
let allPendingStudentRequests = [];

// Shared badge for the Approvals tab — combines pending accounts AND
// pending student requests into one count, since both live in that tab.
function updateApprovalsBadge(){
  const badge = document.getElementById('approvals-badge');
  if(!badge) return;
  const total = allPendingUsers.length + allPendingStudentRequests.length;
  if(total>0){ badge.textContent=total; badge.style.display='inline-block'; }
  else { badge.style.display='none'; }
}

// Admin-only — keeps the Approvals badge and tab live. Only called from
// showApp() when currentUserRole==='admin', so volunteers never run this
// query even though the users collection itself is broadly readable.
function initPendingUsersListener(){
  if(!db || currentUserRole!=='admin') return;
  db.collection('users').where('status','==','pending').onSnapshot(snap=>{
    allPendingUsers = snap.docs.map(d=>Object.assign({id:d.id}, d.data()));
    updateApprovalsBadge();
    if(curView==='approvals') renderApprovals();
  }, err=>console.warn('[Approvals] listener error', err));
}

// Admin-only — pending requests from volunteers asking for a student to be
// added. A volunteer marking attendance can spot someone missing from the
// list and ask for them to be added, without being able to add them
// directly — an admin reviews and decides (see approveStudentRequest).
function initStudentRequestsListener(){
  if(!db || !studentAddRequestsCollection || currentUserRole!=='admin') return;
  studentAddRequestsCollection.where('status','==','pending').onSnapshot(snap=>{
    allPendingStudentRequests = snap.docs.map(d=>Object.assign({id:d.id}, d.data()));
    updateApprovalsBadge();
    if(curView==='approvals') renderApprovals();
  }, err=>console.warn('[StudentRequests] listener error', err));
}

function renderApprovals(){
  const el = document.getElementById('approvals-content');
  if(!el) return;
  const promoBox = document.getElementById('promotion-utility-box');
  if(currentUserRole!=='admin'){
    if(promoBox) promoBox.style.display = 'none';
    el.innerHTML = '<div class="empty-state">Admin only.</div>';
    return;
  }
  if(promoBox) promoBox.style.display = 'block';

  let html = '<h3 style="margin:6px 0 14px">🧑‍🎓 Pending Student Requests</h3>';
  if(!allPendingStudentRequests.length){
    html += '<div class="empty-state" style="margin-bottom:22px">No pending student requests right now.</div>';
  } else {
    html += allPendingStudentRequests.map(r=>{
      const when = (r.requestedAt && r.requestedAt.toDate) ? r.requestedAt.toDate().toLocaleString() : '';
      const detail = r.class ? 'Class '+escapeHtml(r.class) : (r.professionType ? escapeHtml(r.professionType)+': '+escapeHtml(r.professionDetail||'') : '');
      return `<div style="background:var(--surface);border:1px solid var(--border2);border-radius:10px;padding:14px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
        <div>
          <div style="font-weight:700">${escapeHtml(r.name)}</div>
          <div style="font-size:12.5px;color:var(--text2)">${escapeHtml(r.sectionLabel||r.section)} · ${detail}</div>
          <div style="font-size:11px;color:var(--text4);margin-top:4px">Requested by ${escapeHtml(r.requestedByName||r.requestedBy)}${when?' · '+when:''}</div>
        </div>
        <div style="display:flex;gap:8px">
          <button onclick="approveStudentRequest('${r.id}')" style="background:#1D9E75;color:#fff;border:none;border-radius:6px;padding:6px 12px;font-size:12.5px;cursor:pointer">✓ Approve</button>
          <button onclick="rejectStudentRequest('${r.id}')" style="background:#C0392B;color:#fff;border:none;border-radius:6px;padding:6px 12px;font-size:12.5px;cursor:pointer">✕ Reject</button>
        </div>
      </div>`;
    }).join('') + '<div style="margin-bottom:22px"></div>';
  }

  html += '<h3 style="margin:6px 0 14px">👤 Pending Account Approvals</h3>';
  if(!allPendingUsers.length){
    html += '<div class="empty-state">No pending account requests right now.</div>';
  } else {
    html += allPendingUsers.map(u=>{
      const when = (u.createdAt && u.createdAt.toDate) ? u.createdAt.toDate().toLocaleString() : '';
      return `<div style="background:var(--surface);border:1px solid var(--border2);border-radius:10px;padding:14px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
        <div>
          <div style="font-weight:700">${escapeHtml(u.name)||'(no name)'}</div>
          <div style="font-size:12.5px;color:var(--text2)">${escapeHtml(u.email)}</div>
          ${when?`<div style="font-size:11px;color:var(--text4);margin-top:4px">Requested ${when}</div>`:''}
        </div>
        <div style="display:flex;gap:8px">
          <button onclick="approveUserAccount('${u.id}')" style="background:#1D9E75;color:#fff;border:none;border-radius:6px;padding:6px 12px;font-size:12.5px;cursor:pointer">✓ Approve</button>
          <button onclick="rejectUserAccount('${u.id}')" style="background:#C0392B;color:#fff;border:none;border-radius:6px;padding:6px 12px;font-size:12.5px;cursor:pointer">✕ Reject</button>
        </div>
      </div>`;
    }).join('');
  }

  el.innerHTML = html;
}

async function approveStudentRequest(requestId){
  if(currentUserRole!=='admin') return;
  const r = allPendingStudentRequests.find(x=>x.id===requestId);
  if(!r) return;

  // Re-check for a duplicate now, in case someone else already added this
  // exact name between when the request was submitted and now.
  const duplicateSection = findDuplicateStudentName(r.name);
  if(duplicateSection){
    const secLabel = (SECTIONS[duplicateSection]||{}).label || duplicateSection;
    showToast('❌ "'+r.name+'" already exists in '+secLabel+' — reject this request or ask the volunteer to check');
    return;
  }

  // The archive-restore decision belongs here, at approval time, not at
  // request time — the admin reviewing has the context to know whether
  // this is genuinely the same returning person.
  const restoredId = checkArchiveRestore(r.name);

  if(!confirm('Approve adding "'+r.name+'" to '+(r.sectionLabel||r.section)+'?')) return;

  try{
    await createStudentInRoster(r.section, {
      name: r.name, joiningDate: r.joiningDate,
      studentClass: r.class, professionType: r.professionType, professionDetail: r.professionDetail,
      originOverride: r.originOverride, restoredId
    });
    await studentAddRequestsCollection.doc(requestId).update({
      status: 'approved',
      reviewedBy: currentUser?currentUser.email:'',
      reviewedByName: currentUserName||'',
      reviewedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    showToast('✅ '+r.name+' added to '+(r.sectionLabel||r.section)+(restoredId?' — previous history restored!':''));
  }catch(e){ showToast('Error: '+e.message); }
}

async function rejectStudentRequest(requestId){
  if(currentUserRole!=='admin') return;
  const r = allPendingStudentRequests.find(x=>x.id===requestId);
  if(!r) return;
  if(!confirm('Reject the request to add "'+r.name+'"?')) return;
  try{
    await studentAddRequestsCollection.doc(requestId).update({
      status: 'rejected',
      reviewedBy: currentUser?currentUser.email:'',
      reviewedByName: currentUserName||'',
      reviewedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    showToast('Request rejected');
  }catch(e){ showToast('Error: '+e.message); }
}

async function approveUserAccount(uid){
  if(currentUserRole!=='admin') return;
  const u = allPendingUsers.find(x=>x.id===uid);
  if(!u) return;
  if(!confirm('Approve '+(u.name||u.email)+'? They\u2019ll get volunteer access the next time they sign in.')) return;
  try{
    await db.collection('users').doc(uid).update({
      status: 'approved',
      approvedBy: currentUser?currentUser.email:'',
      approvedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    showToast('✅ '+(u.name||u.email)+' approved');
  }catch(e){ showToast('Error: '+e.message); }
}

async function rejectUserAccount(uid){
  if(currentUserRole!=='admin') return;
  const u = allPendingUsers.find(x=>x.id===uid);
  if(!u) return;
  if(!confirm('Reject '+(u.name||u.email)+'? They will not get access.')) return;
  try{
    await db.collection('users').doc(uid).update({
      status: 'rejected',
      rejectedBy: currentUser?currentUser.email:'',
      rejectedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    showToast('Account rejected');
  }catch(e){ showToast('Error: '+e.message); }
}
