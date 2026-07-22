// ===================== PERMANENT STUDENT IDs =====================
// Format: VBS<2-digit year><serial>  (Balaka Sangha)
//      or VYS<2-digit year><serial>  (Yuvaka Sangha)
//   VBS/VYS = which program the person FIRST joined under
//   <year> = last 2 digits of the joining year, set once, never recalculated
//   <serial> = a counter starting at 001 for each new calendar year, per
//              program — the 26th student joining Balaka Sangha in 2026 is
//              ...26026, and the very first one joining in 2027 restarts
//              at ...27001. Never reused within a given year, but the
//              counter itself resets every January 1st, per program.
// Balaka Sangha and Yuvaka Sangha each have their OWN counter (and their
// own per-year reset), so their numbers never interleave with each other
// even within the same year.
//
// The ID is assigned once, at the time a person FIRST joins either program,
// and never changes again — including if a VBS student later grows up and
// moves into Yuvaka Sangha. Their id stays VBS... forever in that case,
// by design: it's meant to show how long they've been part of the Ashram
// overall, not just their current program. (confirmEditStudent's "move to
// section" logic already preserves the same id across any section move —
// nothing needed there for this.)
//
// LEGACY_ID_PREFIXES below is what everyone imported before this format
// change already has (R53VBS.../R53VYS..., 3-digit year) — those ids are
// NOT rewritten by this change, they stay exactly as issued (permanent
// means permanent). Anywhere the app needs to recognize "is this already a
// real id" or "how do I sort/compare ids", it has to check BOTH the new
// short prefixes and the old long ones, or older students would silently
// stop being recognized as already having an id.
const ID_PREFIXES = { balaka: 'VBS', yuvaka: 'VYS' };
const LEGACY_ID_PREFIXES = { balaka: 'R53VBS', yuvaka: 'R53VYS' };
const ID_COUNTER_PATHS = { balaka: 'attendance/idCounter', yuvaka: 'attendance/idCounterYuvaka' };

// Which program a section belongs to, for ID-prefix/counter purposes.
function programFor(key){
  return key === 'yuvaka-sangha' ? 'yuvaka' : 'balaka';
}

function studentIdYearPart(joiningDateStr){
  let year = new Date().getFullYear();
  if(joiningDateStr){
    const y = parseInt(String(joiningDateStr).slice(0,4), 10);
    if(!isNaN(y) && y > 1900 && y < 3000) year = y;
  }
  return String(year % 100).padStart(2, '0');
}

// Each counter document holds one field per year: { serials: { "026": 5,
// "027": 1, ... } }. A transaction reads the whole map, reads (or defaults)
// just that one year's count, increments it, and writes the complete map
// back — so two people joining the same program in the same year still
// can't ever collide, and a new year always starts fresh at 1 without
// needing any separate "reset" step or scheduled job.
async function nextSerial(program, yearKey){
  if(!db) throw new Error('Firebase not ready');
  const counterRef = db.doc(ID_COUNTER_PATHS[program] || ID_COUNTER_PATHS.balaka);
  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    const serials = (snap.exists && snap.data().serials) ? snap.data().serials : {};
    const current = (typeof serials[yearKey] === 'number') ? serials[yearKey] : 1;
    tx.set(counterRef, { serials: { ...serials, [yearKey]: current + 1 } });
    return current;
  });
}

async function generateStudentId(joiningDateStr, program){
  const prog = (program === 'yuvaka') ? 'yuvaka' : 'balaka';
  const yearPart = studentIdYearPart(joiningDateStr);
  const serial = await nextSerial(prog, yearPart);
  return ID_PREFIXES[prog] + yearPart + String(serial).padStart(3, '0');
}

// ===================== DIAGNOSTIC: FIND DUPLICATE IDS =====================
// Read-only — scans every student (active in any section, and archived) and
// reports any id that's currently assigned to more than one of them. Two
// students sharing an id is serious: attendance is stored keyed BY id, so
// marking one silently marks the other too, since Firestore sees them as
// the same record. This has no legitimate cause under normal use — it can
// only happen from a bug (e.g. a ambiguous rename creating a collision with
// an id already in use). Safe to run any time; changes nothing.
function findDuplicateStudentIds(){
  const byId = {}; // id -> [{name, key, kind, idx}]
  SEC_KEYS.forEach(key => {
    (students[key]||[]).forEach((s, idx) => {
      if(s && typeof s==='object' && s.id){
        (byId[s.id] = byId[s.id] || []).push({ name: s.name, key, kind:'active', idx });
      }
    });
  });
  archivedStudents.forEach((a, idx) => {
    if(a && a.id){
      (byId[a.id] = byId[a.id] || []).push({ name: a.name, key: null, kind:'archived', idx });
    }
  });
  const dupes = Object.entries(byId).filter(([id, list]) => list.length > 1);
  if(!dupes.length){
    alert('✅ No duplicate ids found — every student has a unique id.');
    return;
  }
  const lines = dupes.map(([id, list]) =>
    id + ':\n' + list.map(s => '  - ' + s.name + ' (' + (s.kind==='archived' ? 'archived' : (SECTIONS[s.key]||{}).label || s.key) + ')').join('\n')
  );
  alert('⚠️ Found ' + dupes.length + ' duplicate id(s):\n\n' + lines.join('\n\n') +
        '\n\nDo NOT mark attendance for these people until this is resolved — ' +
        'marking one currently marks all of them. Send this list to whoever is fixing the app.');
}

// Checks the LIVE id counters (attendance/idCounter, idCounterYuvaka) against
// every id actually in use on the current roster, and bumps any counter
// that's behind. This matters because generateStudentId() — the NORMAL
// "add student" / bulk-import path — reads its next serial from these
// counter documents, NOT from scanning the roster. Anything that ever
// assigns an id WITHOUT going through that exact counter transaction (the
// July 2026 repair tool's freshIdForYear is one such case, and the
// original id-shortening migration would have been too, if it didn't
// already call reserveMinSerial itself) leaves the counter unaware that
// serial is now taken — so a later NORMAL add could get handed that exact
// same id again. Only ever moves a counter FORWARD, never back, so this is
// safe to run at any time, as often as you like, as a general safety net.
async function syncIdCountersToRoster(){
  if(currentUserRole !== 'admin'){ showToast('Only admins can run this'); return; }
  if(!db){ showToast('Not connected — try again shortly'); return; }

  const highestByProgYear = {}; // "prog|yearKey" -> highest serial currently in use
  const scan = (id) => {
    for(const [prog, prefix] of Object.entries(ID_PREFIXES)){
      if(id.startsWith(prefix)){
        const rest = id.slice(prefix.length);
        if(rest.length === 5){ // 2-digit year + 3-digit serial — the current short format
          const yearKey = rest.slice(0,2);
          const serial = parseInt(rest.slice(2), 10);
          if(!isNaN(serial)){
            const key = prog+'|'+yearKey;
            if(!(key in highestByProgYear) || serial > highestByProgYear[key]) highestByProgYear[key] = serial;
          }
        }
        return;
      }
    }
  };
  SEC_KEYS.forEach(key => (students[key]||[]).forEach(s => { if(s && typeof s==='object' && s.id) scan(s.id); }));
  archivedStudents.forEach(a => { if(a && a.id) scan(a.id); });

  const entries = Object.entries(highestByProgYear);
  if(!entries.length){ showToast('Nothing to sync — no short-format ids found on the roster'); return; }

  if(!confirm(
    `This checks ${entries.length} (program, year) counter(s) against every id actually on the ` +
    `roster right now, and bumps any counter that's behind — so a normal new-student add can never ` +
    `be handed an id that collides with someone already here. Safe to run any time. Proceed?`
  )) return;

  setSyncStatus('syncing', 'Syncing id counters...');
  let bumped = 0;
  try{
    for(const [key, highestSerial] of entries){
      const [prog, yearKey] = key.split('|');
      await reserveMinSerial(prog, yearKey, highestSerial + 1);
      bumped++;
    }
    showToast(`✅ Checked ${bumped} counter(s) against the roster — any that were behind are now caught up.`);
  }catch(e){
    showToast('⚠️ Sync stopped partway: ' + e.message);
  }finally{
    setSyncStatus('synced');
  }
}

// Read-only diagnostic. Every attendance-record document carries a
// studentId field — this finds any record whose studentId doesn't belong
// to ANYONE currently on the roster (active or archived), i.e. history
// that's genuinely invisible right now because nothing points to it. Two
// sources of that are already known and expected: the 13 pairs' old
// retired ids from the July 2026 repair (deliberately left parked, pending
// your manual reconciliation) — anything else found here is new
// information, not something already accounted for.
async function findOrphanedAttendanceRecords(){
  if(currentUserRole !== 'admin'){ showToast('Only admins can run this'); return; }
  if(!db || !recordsCollection){ showToast('Not connected — try again shortly'); return; }

  const knownIds = new Set();
  SEC_KEYS.forEach(key => (students[key]||[]).forEach(s => { if(s && typeof s==='object' && s.id) knownIds.add(s.id); }));
  archivedStudents.forEach(a => { if(a && a.id) knownIds.add(a.id); });

  // The 13 pairs' old ids, deliberately retired by the July 2026 repair —
  // orphaned records under these are EXPECTED, not a new finding.
  const knownRetiredIds = new Set([
    'VBS25011','VBS22001','VBS24006','VBS24007','VBS22002','VBS23001','VBS22003',
    'VBS22004','VBS23002','VBS24008','VBS24009','VBS24010','VBS23003'
  ]);

  setSyncStatus('syncing', 'Scanning attendance records...');
  try{
    const snap = await recordsCollection.get();
    const byId = {};
    snap.docs.forEach(doc => {
      const sid = doc.data().studentId;
      if(sid && !knownIds.has(sid)){
        (byId[sid] = byId[sid] || []).push(doc.id);
      }
    });

    const expectedIds = Object.keys(byId).filter(id => knownRetiredIds.has(id));
    const unexpectedIds = Object.keys(byId).filter(id => !knownRetiredIds.has(id));

    let msg = `Scanned ${snap.size} attendance record(s) total.\n\n`;
    msg += `${expectedIds.length} orphaned id(s) are the known retired ids from the July 2026 repair `
         + `(expected — this is exactly the history your reconciliation Excel is meant to recover).\n\n`;
    if(unexpectedIds.length){
      msg += `⚠️ ${unexpectedIds.length} UNEXPECTED orphaned id(s) — these don't belong to any current `
           + `student and aren't part of the known repair:\n`;
      unexpectedIds.forEach(id => { msg += `  ${id}: ${byId[id].length} record(s)\n`; });
    } else {
      msg += `✅ No unexpected orphaned records — everything else is accounted for.`;
    }
    alert(msg);
  }catch(e){
    showToast('⚠️ Scan failed: ' + e.message);
  }finally{
    setSyncStatus('synced');
  }
}

// ===================== APPLY ATTENDANCE RECONCILIATION =====================
// Applies the admin's answers (from the "Attendance Recheck" spreadsheet)
// for who was ACTUALLY present on a date where two people used to share an
// id. Only covers entries that have a real answer — 14 of the 23 needed
// date/pair entries are still blank (see chat), those are simply left
// alone here, not guessed. Matches each name to its CURRENT (already
// -unique, post-repair) id live at run time, so there's no risk of writing
// to a stale/retired id.
//
// Two entries below (Advaith Aithal D P on 19-Jul, Bharatesh Gowda M on
// 19-Jul) have an answer that CONTRADICTS what the shared record used to
// say (recorded as Absent, but the admin says that person was actually
// present) — meaning the original mark itself was wrong that day, not
// just misattributed between two people. Flagged here and in the confirm
// dialog so this gets a second look before running, in case of a typo.
const RECONCILIATION_ENTRIES = [
  { key:'old-middle', date:'2026-07-19', present:'Vishnu S', absent:'Narasimha R' },
  { key:'old-high',   date:'2026-07-19', present:'Aarya Smaran', absent:'Dhruvanandan M J' },
  { key:'old-high',   date:'2026-07-19', present:'Hithaish R', absent:'Abhiram B G' },
  { key:'old-high',   date:'2026-07-19', present:'Advaith Aithal D P', absent:'Kushal G H', flagContradiction:true },
  { key:'old-high',   date:'2026-07-19', bothAbsent:['Advaya G','Lok Niranjan R'] },
  { key:'old-high',   date:'2026-07-19', bothAbsent:['Amogh Sai V','Lalith Devraj'] },
  { key:'old-high',   date:'2026-07-19', present:'Bharatesh Gowda M', absent:'Ichith V', flagContradiction:true },
  { key:'old-high',   date:'2026-07-19', present:'Bhuvan R', absent:'Madav S' },
  { key:'old-high',   date:'2026-07-19', present:'Likith N', absent:'Bhuvan S R' }
];

async function applyAttendanceReconciliation(){
  if(currentUserRole !== 'admin'){ showToast('Only admins can run this'); return; }
  if(!recordsCollection){ showToast('Not connected — try again shortly'); return; }

  const contradictionCount = RECONCILIATION_ENTRIES.filter(e => e.flagContradiction).length;
  if(!confirm(
    `This applies the admin's confirmed answers for ${RECONCILIATION_ENTRIES.length} of the 23 disputed ` +
    `date/pair entries — 14 still need someone's memory of an earlier Sunday and are left untouched.\n\n` +
    (contradictionCount ? `⚠️ ${contradictionCount} of these CONTRADICT the originally recorded mark ` +
    `(recorded absent, but the admin says that person WAS present that day) — double check these ` +
    `aren't a typo before proceeding.\n\n` : '') +
    `Proceed?`
  )) return;

  setSyncStatus('syncing', 'Applying reconciliation...');
  let applied = 0;
  const notFound = [];
  try{
    for(const e of RECONCILIATION_ENTRIES){
      const names = e.bothAbsent ? e.bothAbsent : [e.present, e.absent];
      for(const name of names){
        const idx = (students[e.key]||[]).findIndex(s => s && typeof s==='object' && s.name === name);
        if(idx < 0){ notFound.push(name+' ('+e.key+')'); continue; }
        const id = idFor(e.key, idx);
        const value = e.bothAbsent ? 'A' : (name === e.present ? 'P' : 'A');
        const recordKey = e.key+'|'+e.date+'|'+id;
        await recordsCollection.doc(firestoreDocIdFor(recordKey)).set({ v: value, section: e.key, date: e.date, studentId: id });
        records[recordKey] = value;
        applied++;
      }
    }
    renderCurrentSection();
    let msg = `✅ Applied ${applied} corrected mark(s) for ${RECONCILIATION_ENTRIES.length} entries.`;
    if(notFound.length) msg += `\n\n⚠️ Could not find on the roster: ${notFound.join(', ')}`;
    msg += `\n\n14 entries across pairs 1,2,3,4,5,6,7,8,9,11 still need an answer for 5-Jul and/or 12-Jul — send those back to the admin when you can.`;
    alert(msg);
  }catch(err){
    showToast('⚠️ Reconciliation stopped partway: ' + err.message);
  }finally{
    setSyncStatus('synced');
  }
}


// Converts an existing student's OLD-format id (R53VBS.../R53VYS..., 3-digit
// year) to the NEW short format (VBS.../VYS..., 2-digit year) — same
// joining year, same serial number, just reformatted. This is NOT a
// renumbering: the 5th Balaka Sangha joiner of 2024 (R53VBS024005) becomes
// VBS24005, not a freshly-assigned new serial — so it's safe to run on
// students who already have real attendance history, since every record
// moves with them under the exact same serial, just a shorter id string.
// Converts an existing student's OLD-format id (R53VBS.../R53VYS..., 3-digit
// year) to the NEW short format (VBS.../VYS..., 2-digit year) — same
// joining year, same serial number, just reformatted, UNLESS that exact
// short id is already taken by someone else. That collision is a real risk:
// once the app switched to issuing short ids directly, brand-new students
// started their OWN counter fresh at 001 for the current year — completely
// independent of whatever serial the OLD legacy counter had already
// reached for that same year. So a legacy student's "natural" reformatted
// id can land EXACTLY on an id already given to someone added after the
// switch. Two people sharing one id is not cosmetic — attendance is stored
// keyed BY id, so marking one silently marks both (see
// findDuplicateStudentIds() above, and mark()/setRecord() below). So: if
// the natural candidate is taken, bump forward to the next free serial for
// that prefix+year instead. `takenIds` must include every id currently in
// use (checked and updated by the caller as it goes, so two legacy
// students being migrated in the same run can't collide with EACH OTHER
// either, not just with pre-existing ids).
function shortIdFor(legacyId, takenIds){
  for(const [prog, legacyPrefix] of Object.entries(LEGACY_ID_PREFIXES)){
    if(legacyId.startsWith(legacyPrefix)){
      const rest = legacyId.slice(legacyPrefix.length); // "<3-digit year><serial>"
      const yearNum = parseInt(rest.slice(0,3), 10) || 0;
      let serialNum = parseInt(rest.slice(3), 10) || 0;
      const yearKey = String(yearNum % 100).padStart(2,'0');
      const prefix = ID_PREFIXES[prog];
      let candidate = prefix + yearKey + String(serialNum).padStart(3,'0');
      let bumped = false;
      while(takenIds && takenIds.has(candidate)){
        serialNum++;
        candidate = prefix + yearKey + String(serialNum).padStart(3,'0');
        bumped = true;
      }
      return { id: candidate, prog, yearKey, serial: serialNum, bumped };
    }
  }
  return null;
}

// After migrating, make sure the live serial counter for a given
// prefix+year can never re-issue a serial that a bumped migration just
// consumed. Only ever moves the counter FORWARD, never back — if the
// counter is already ahead of what we need, this is a no-op.
async function reserveMinSerial(program, yearKey, minNextValue){
  if(!db) return;
  const counterRef = db.doc(ID_COUNTER_PATHS[program] || ID_COUNTER_PATHS.balaka);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    const serials = (snap.exists && snap.data().serials) ? snap.data().serials : {};
    const current = (typeof serials[yearKey] === 'number') ? serials[yearKey] : 1;
    if(minNextValue > current){
      tx.set(counterRef, { serials: { ...serials, [yearKey]: minNextValue } });
    }
  });
}

// ===================== ONE-TIME REPAIR: JULY 2026 EXPORT AUDIT =====================
// This repairs a specific, already-identified set of data issues found by
// auditing a July 2026 attendance export against the live roster, from
// BEFORE the id-collision fix in migrateLegacyIdsToShortFormat() existed.
// Three distinct problems, three distinct fixes — see runKnownIssueRepair()
// below for what each one actually does and why. This is data-specific
// (hardcoded to the exact students found in that audit), not a general
// detector — findDuplicateStudentIds() above remains the general-purpose
// tool for anything found after this.

// Issue A: 33 students (all Old High School) whose Joining Date is literally
// corrupted text like "undefined-undefined-15/6/2025" — a symptom of a very
// old, pre-fix bulk import choking on slash-formatted dates. Their real
// date was recovered from the tail of that corrupted string; their id's
// embedded year (26, i.e. 2026) does not match their real joining year.
const REPAIR_ISSUE_A = [
    { name:"Manjunath Prasad Bhat C", key:"old-high", oldId:"VBS26072", correctJoiningDate:"2025-06-15" },
    { name:"Narendra Meda", key:"old-high", oldId:"VBS26073", correctJoiningDate:"2025-07-27" },
    { name:"Nikelesh Kumar B", key:"old-high", oldId:"VBS26074", correctJoiningDate:"2024-06-09" },
    { name:"Nuthan Sagar M", key:"old-high", oldId:"VBS26075", correctJoiningDate:"2024-06-02" },
    { name:"Pranav G", key:"old-high", oldId:"VBS26076", correctJoiningDate:"2025-05-18" },
    { name:"Pranav R Kavatekar", key:"old-high", oldId:"VBS26077", correctJoiningDate:"2025-06-22" },
    { name:"Purushottam S Murthy", key:"old-high", oldId:"VBS26078", correctJoiningDate:"2025-07-13" },
    { name:"Rachith N S", key:"old-high", oldId:"VBS26079", correctJoiningDate:"2024-06-09" },
    { name:"Raghava C S", key:"old-high", oldId:"VBS26080", correctJoiningDate:"2025-06-15" },
    { name:"Rakshith S", key:"old-high", oldId:"VBS26081", correctJoiningDate:"2025-07-06" },
    { name:"Rohan J C", key:"old-high", oldId:"VBS26082", correctJoiningDate:"2023-06-04" },
    { name:"Rudraansh Nagabushi", key:"old-high", oldId:"VBS26083", correctJoiningDate:"2025-06-29" },
    { name:"Sai Eshwar R S", key:"old-high", oldId:"VBS26084", correctJoiningDate:"2023-06-11" },
    { name:"Sai Sheshadri S N", key:"old-high", oldId:"VBS26085", correctJoiningDate:"2025-08-17" },
    { name:"Sai Vibhumai T S", key:"old-high", oldId:"VBS26086", correctJoiningDate:"2025-06-01" },
    { name:"Samanyu Hoysala S", key:"old-high", oldId:"VBS26087", correctJoiningDate:"2025-05-18" },
    { name:"Shankar Narayan U", key:"old-high", oldId:"VBS26088", correctJoiningDate:"2024-06-02" },
    { name:"Shibhijeeth Bharadwaj H", key:"old-high", oldId:"VBS26089", correctJoiningDate:"2023-07-02" },
    { name:"Shreyas A V", key:"old-high", oldId:"VBS26090", correctJoiningDate:"2024-06-09" },
    { name:"Skanda S M", key:"old-high", oldId:"VBS26091", correctJoiningDate:"2022-09-04" },
    { name:"Srikanta Ravishankar", key:"old-high", oldId:"VBS26092", correctJoiningDate:"2024-06-02" },
    { name:"Sughosh S M", key:"old-high", oldId:"VBS26093", correctJoiningDate:"2023-07-09" },
    { name:"Sumukh Arun", key:"old-high", oldId:"VBS26094", correctJoiningDate:"2024-06-02" },
    { name:"Svanik G", key:"old-high", oldId:"VBS26095", correctJoiningDate:"2023-07-02" },
    { name:"Satvik R", key:"old-high", oldId:"VBS26096", correctJoiningDate:"2025-08-10" },
    { name:"Tejas S V", key:"old-high", oldId:"VBS26097", correctJoiningDate:"2025-05-18" },
    { name:"Thanush Krishna P S", key:"old-high", oldId:"VBS26098", correctJoiningDate:"2024-06-09" },
    { name:"Ujwal S", key:"old-high", oldId:"VBS26099", correctJoiningDate:"2024-06-02" },
    { name:"Uthkarsh S", key:"old-high", oldId:"VBS26100", correctJoiningDate:"2024-06-02" },
    { name:"Venkata Shreyas V", key:"old-high", oldId:"VBS26101", correctJoiningDate:"2025-07-20" },
    { name:"Vibhu K Viralam", key:"old-high", oldId:"VBS26102", correctJoiningDate:"2024-06-09" },
    { name:"Vimarsh C V", key:"old-high", oldId:"VBS26103", correctJoiningDate:"2024-10-06" },
    { name:"Yashonidhi Bhat C N", key:"old-high", oldId:"VBS26104", correctJoiningDate:"2024-06-09" }
  ];

// Issue B (safe): 15 groups where a legacy migration collision gave an id
// to more than one student, but the collision happened to fall across
// DIFFERENT sections. Since attendance is keyed by section+date+id
// together, these students' histories were never actually mixed — this is
// a confusing duplicate LABEL, not merged data. Every member EXCEPT the
// first keeps its history; the first keeps the existing id unchanged, the
// rest get freshly reserved ids in the SAME year and their history is
// re-keyed to match, with zero data loss.
const REPAIR_SAFE_DUP_GROUPS = [
    { oldId:"VBS25001", members:[{ name:"Akshay H S", key:"old-middle" }, { name:"Dhyan K Prasad", key:"old-high" }, { name:"Koushik G", key:"new-middle" }] },
    { oldId:"VBS25002", members:[{ name:"Atharv Savvasere J", key:"old-middle" }, { name:"Hemanth Sakthi", key:"old-high" }, { name:"Lochana Krishna B S", key:"new-middle" }] },
    { oldId:"VBS25003", members:[{ name:"Bhargav S Murthy", key:"old-middle" }, { name:"Himanth N", key:"old-high" }, { name:"Ritvik B R", key:"new-middle" }] },
    { oldId:"VBS24001", members:[{ name:"Arya Vamshi G J", key:"old-middle" }, { name:"Eshwar P", key:"old-high" }] },
    { oldId:"VBS25004", members:[{ name:"Bimal N", key:"old-middle" }, { name:"Jeevith Gowda S J", key:"old-high" }] },
    { oldId:"VBS24002", members:[{ name:"Dhavan P", key:"old-middle" }, { name:"Gagan S M", key:"old-high" }] },
    { oldId:"VBS25005", members:[{ name:"Gagan Deep M", key:"old-middle" }, { name:"Keshav M G", key:"old-high" }] },
    { oldId:"VBS24003", members:[{ name:"Gourav A", key:"old-middle" }, { name:"Gautam S Kumar", key:"old-high" }] },
    { oldId:"VBS25006", members:[{ name:"Havish V", key:"old-middle" }, { name:"Kritin Rao D", key:"old-high" }] },
    { oldId:"VBS25007", members:[{ name:"Havish Vanka", key:"old-middle" }, { name:"Kushal Gowda M", key:"old-high" }] },
    { oldId:"VBS25008", members:[{ name:"Ishaan Puranik", key:"old-middle" }, { name:"Likith Gowda K", key:"old-high" }] },
    { oldId:"VBS25009", members:[{ name:"Krivish M", key:"old-middle" }, { name:"Likith R Gowda", key:"old-high" }] },
    { oldId:"VBS25010", members:[{ name:"Mohith L", key:"old-middle" }, { name:"Madhan N", key:"old-high" }] },
    { oldId:"VBS24004", members:[{ name:"Sohan M", key:"old-middle" }, { name:"Gyanendra M", key:"old-high" }] },
    { oldId:"VBS24005", members:[{ name:"Vishnu Tej H S", key:"old-middle" }, { name:"Harsha V", key:"old-high" }] }
  ];

// Issue B (real corruption): 13 groups where the collision happened WITHIN
// the same section — attendance is genuinely one shared record for every
// member, confirmed identical on every date they overlap. There is no way
// to know which person a shared P/A mark actually belongs to. Per your
// decision: no one "keeps" the old id here — EVERY member gets a fresh
// distinct id going forward, so there is no more collision from today on.
// The disputed shared history stays parked under the OLD id, untouched —
// not deleted, just no longer linked to either person's live profile. If
// you want to manually reconcile any of it later (e.g. asking volunteers
// who was actually present), the old id is preserved below for reference.
const REPAIR_CORRUPTED_DUP_GROUPS = [
    { oldId:"VBS25011", members:[{ name:"Narasimha R", key:"old-middle" }, { name:"Vishnu S", key:"old-middle" }] },
    { oldId:"VBS22001", members:[{ name:"Aarya Smaran", key:"old-high" }, { name:"Dhruvanandan M J", key:"old-high" }] },
    { oldId:"VBS24006", members:[{ name:"Abhinava Navada K G", key:"old-high" }, { name:"Harshavardhan R", key:"old-high" }] },
    { oldId:"VBS24007", members:[{ name:"Abhiram B G", key:"old-high" }, { name:"Hithaish R", key:"old-high" }] },
    { oldId:"VBS22002", members:[{ name:"Achyuth S R", key:"old-high" }, { name:"Jayanth Ram B N", key:"old-high" }] },
    { oldId:"VBS23001", members:[{ name:"Aditya Sharma", key:"old-high" }, { name:"Ishaan Katta", key:"old-high" }] },
    { oldId:"VBS22003", members:[{ name:"Advaith Aithal D P", key:"old-high" }, { name:"Kushal G H", key:"old-high" }] },
    { oldId:"VBS22004", members:[{ name:"Advaya G", key:"old-high" }, { name:"Lok Niranjan R", key:"old-high" }] },
    { oldId:"VBS23002", members:[{ name:"Amogh Sai V", key:"old-high" }, { name:"Lalith Devraj", key:"old-high" }] },
    { oldId:"VBS24008", members:[{ name:"Bharatesh Gowda M", key:"old-high" }, { name:"Ichith V", key:"old-high" }] },
    { oldId:"VBS24009", members:[{ name:"Bharath G R", key:"old-high" }, { name:"Krishna R B", key:"old-high" }] },
    { oldId:"VBS24010", members:[{ name:"Bhuvan R", key:"old-high" }, { name:"Madav S", key:"old-high" }] },
    { oldId:"VBS23003", members:[{ name:"Bhuvan S R", key:"old-high" }, { name:"Likith N", key:"old-high" }] }
  ];

function freshIdForYear(yearNum, takenIds){
  const yearKey = String(yearNum % 100).padStart(2,'0');
  const prefix = ID_PREFIXES.balaka; // all repair targets are Balaka Sangha school students
  let serial = 1;
  let candidate = prefix + yearKey + String(serial).padStart(3,'0');
  while(takenIds.has(candidate)){
    serial++;
    candidate = prefix + yearKey + String(serial).padStart(3,'0');
  }
  return { id: candidate, yearKey, serial };
}

// Moves every attendance-record document (regular marks + tracker docs)
// for oldId IN A SPECIFIC SECTION to newId. Scoped by section because some
// of these old ids are shared by people in DIFFERENT sections (Issue B
// safe groups) — without the section filter, re-keying one person's
// records could accidentally sweep up and move a completely different
// person's records too, since they currently share the same studentId text.
async function repairMoveRecords(oldId, newId, section){
  const snap = await recordsCollection.where('studentId','==', oldId).where('section','==', section).get();
  if(snap.empty) return 0;
  const docs = snap.docs;
  const CHUNK = 200;
  for(let start=0; start<docs.length; start+=CHUNK){
    const batch = db.batch();
    docs.slice(start, start+CHUNK).forEach(doc => {
      const data = doc.data();
      const internalKey = internalKeyFromDocId(doc.id);
      const parts = internalKey.split('|');
      parts[2] = newId;
      const newDocId = firestoreDocIdFor(parts.join('|'));
      batch.set(recordsCollection.doc(newDocId), { ...data, studentId: newId });
      batch.delete(doc.ref);
    });
    await batch.commit();
  }
  return docs.length;
}

async function repairMovePendingCorrections(oldId, newId, section){
  const snap = await correctionsCollection.where('studentId','==', oldId).where('section','==', section).where('status','==','pending').get();
  for(const doc of snap.docs) await doc.ref.update({ studentId: newId });
  return snap.size;
}

function findStudentInRoster(name, key){
  const idx = (students[key]||[]).findIndex(s => s && typeof s==='object' && s.name === name);
  return idx >= 0 ? idx : null;
}

async function runKnownIssueRepair(){
  if(currentUserRole !== 'admin'){ showToast('Only admins can run this'); return; }
  if(!db || !recordsCollection || !correctionsCollection){ showToast('Not connected — try again shortly'); return; }

  const totalCount = REPAIR_ISSUE_A.length
    + REPAIR_SAFE_DUP_GROUPS.reduce((n,g)=>n+g.members.length-1, 0)
    + REPAIR_CORRUPTED_DUP_GROUPS.reduce((n,g)=>n+g.members.length, 0);

  if(!confirm(
    `This is the one-time repair for the July 2026 export audit findings:\n\n` +
    `• ${REPAIR_ISSUE_A.length} students with a corrupted joining date and wrong-year id (Old High School)\n` +
    `• ${REPAIR_SAFE_DUP_GROUPS.length} safe duplicate-id groups (different sections, no data was actually mixed)\n` +
    `• ${REPAIR_CORRUPTED_DUP_GROUPS.length} genuinely-merged duplicate-id groups — everyone in these gets a fresh id, old shared history stays parked, untouched\n\n` +
    `About ${totalCount} id changes total. This can take a little while — don't close the app while it runs. Proceed?`
  )) return;

  const takenIds = new Set();
  SEC_KEYS.forEach(key => (students[key]||[]).forEach(s => { if(s && typeof s==='object' && s.id) takenIds.add(s.id); }));
  archivedStudents.forEach(a => { if(a && a.id) takenIds.add(a.id); });

  setSyncStatus('syncing', 'Running repair...');
  let recordsMoved = 0, correctionsMoved = 0, studentsFixed = 0, notFound = [];
  const touchedSections = new Set();

  try{
    // --- Issue A: corrupted joining date + wrong-year id ---
    for(const item of REPAIR_ISSUE_A){
      const idx = findStudentInRoster(item.name, item.key);
      if(idx === null || students[item.key][idx].id !== item.oldId){ notFound.push(item.name+' (Issue A)'); continue; }
      const correctYear = parseInt(item.correctJoiningDate.slice(0,4), 10);
      const result = freshIdForYear(correctYear, takenIds);
      recordsMoved += await repairMoveRecords(item.oldId, result.id, item.key);
      correctionsMoved += await repairMovePendingCorrections(item.oldId, result.id, item.key);
      students[item.key][idx].id = result.id;
      students[item.key][idx].joiningDate = item.correctJoiningDate;
      takenIds.add(result.id);
      touchedSections.add(item.key);
      studentsFixed++;
    }

    // --- Issue B safe: first member keeps id, rest get fresh ids in the same year ---
    for(const group of REPAIR_SAFE_DUP_GROUPS){
      const yearKey = group.oldId.replace(/^(VBS|VYS)/, '').slice(0,2);
      const yearNum = 2000 + parseInt(yearKey, 10);
      for(let i=0; i<group.members.length; i++){
        if(i === 0) continue; // first member keeps the existing id untouched
        const m = group.members[i];
        const idx = findStudentInRoster(m.name, m.key);
        if(idx === null || students[m.key][idx].id !== group.oldId){ notFound.push(m.name+' (Issue B safe)'); continue; }
        const result = freshIdForYear(yearNum, takenIds);
        recordsMoved += await repairMoveRecords(group.oldId, result.id, m.key);
        correctionsMoved += await repairMovePendingCorrections(group.oldId, result.id, m.key);
        students[m.key][idx].id = result.id;
        takenIds.add(result.id);
        touchedSections.add(m.key);
        studentsFixed++;
      }
    }

    // --- Issue B corrupted: EVERY member gets a fresh id, old records left untouched ---
    for(const group of REPAIR_CORRUPTED_DUP_GROUPS){
      const yearKey = group.oldId.replace(/^(VBS|VYS)/, '').slice(0,2);
      const yearNum = 2000 + parseInt(yearKey, 10);
      for(const m of group.members){
        const idx = findStudentInRoster(m.name, m.key);
        if(idx === null || students[m.key][idx].id !== group.oldId){ notFound.push(m.name+' (Issue B corrupted)'); continue; }
        const result = freshIdForYear(yearNum, takenIds);
        // Deliberately NOT moving records here — the shared history under
        // group.oldId is disputed and stays parked there, untouched.
        students[m.key][idx].id = result.id;
        takenIds.add(result.id);
        touchedSections.add(m.key);
        studentsFixed++;
      }
    }

    await saveRosterChange({ sections: [...touchedSections], archived: false });

    let msg = `✅ Repair complete: ${studentsFixed} id(s) fixed, ${recordsMoved} attendance record(s) moved, ${correctionsMoved} pending correction(s) updated.`;
    if(notFound.length){
      msg += `\n\n⚠️ ${notFound.length} entrie(s) could not be matched (name/id changed since the audit?):\n` + notFound.join('\n');
    }
    alert(msg);
    renderCurrentSection();
  }catch(e){
    showToast('⚠️ Repair stopped partway due to an error: ' + e.message + ' — check what got done before re-running.');
  }finally{
    setSyncStatus('synced');
  }
}


// One-time admin action: finds every student (active in any section, OR
// archived/departed) still on the old long-form id, and for each one:
//   1. Re-keys every attendance-record document they have — regular P/A
//      marks AND "who marked it" tracker docs alike — to the new id,
//      found via the `studentId` field every record document already
//      carries (the same field fetchFullHistoryForStudent already queries
//      by), so their full History view keeps working under the new id.
//   2. Updates any correction request that's still PENDING (not yet
//      approved/rejected) and references their old id, so
//      approveCorrection()'s id-match lookup keeps finding them. Already
//      -resolved corrections are left alone — those are just a historical
//      log entry at that point, not a live reference to the current id.
//   3. Updates the roster entry's `.id` field itself (active or archived).
// Idempotent and safe to re-run: only ever touches ids that still match the
// OLD prefix, so anyone already migrated (or newly created under the short
// format) is simply skipped on a second run — useful if it's interrupted
// partway (e.g. a dropped connection) and needs to be run again.
async function migrateLegacyIdsToShortFormat(){
  if(currentUserRole !== 'admin'){ showToast('Only admins can run this'); return; }
  if(!db || !recordsCollection || !correctionsCollection){ showToast('Not connected — try again shortly'); return; }

  // This migration only re-keys records living in the SUBCOLLECTION
  // (recordsCollection) — it has no way to find or move records still
  // sitting in the OLD attendance/state.records field (legacyRecordsField).
  // If any student being renamed here still has entries back there, this
  // migration would silently leave them behind under the OLD id forever —
  // the UI would have no way to find them again after the roster id
  // changes. So: require the old-storage cleanup (Audit Log tab →
  // "Migrate to new storage") to be fully done first, rather than risk
  // that gap.
  if(legacyRecordsField && Object.keys(legacyRecordsField).length){
    showToast('⚠️ There is still old-format attendance data waiting to be migrated. Go to the Audit Log tab and click "Migrate to new storage" first, then come back and run this.');
    return;
  }

  // Build the full worklist BEFORE touching anything, so the confirm
  // dialog shows an accurate count and nothing partial happens if the
  // admin cancels. takenIds starts as every id currently in use anywhere
  // (active or archived) — shortIdFor() checks against this AND adds each
  // newly-assigned id to it immediately, so two legacy students in the same
  // run can't collide with each other either, not just with ids that
  // already existed before this run started.
  const takenIds = new Set();
  SEC_KEYS.forEach(key => (students[key]||[]).forEach(s => { if(s && typeof s==='object' && s.id) takenIds.add(s.id); }));
  archivedStudents.forEach(a => { if(a && a.id) takenIds.add(a.id); });

  const jobs = []; // { oldId, newId, kind: 'active'|'archived', key?, idx, prog, yearKey, serial }
  let collisionsAvoided = 0;
  SEC_KEYS.forEach(key => {
    (students[key]||[]).forEach((s, idx) => {
      if(s && typeof s==='object' && s.id){
        const result = shortIdFor(s.id, takenIds);
        if(result){
          if(result.bumped) collisionsAvoided++;
          jobs.push({ oldId: s.id, newId: result.id, kind:'active', key, idx, prog: result.prog, yearKey: result.yearKey, serial: result.serial });
          takenIds.add(result.id);
        }
      }
    });
  });
  archivedStudents.forEach((a, idx) => {
    if(a && a.id){
      const result = shortIdFor(a.id, takenIds);
      if(result){
        if(result.bumped) collisionsAvoided++;
        jobs.push({ oldId: a.id, newId: result.id, kind:'archived', idx, prog: result.prog, yearKey: result.yearKey, serial: result.serial });
        takenIds.add(result.id);
      }
    }
  });

  if(!jobs.length){ showToast('Nothing to migrate — no legacy-format ids found'); return; }

  if(!confirm(
    `This will shorten ${jobs.length} existing student id(s) to the new format ` +
    `(e.g. R53VBS026001 → VBS26001) and move all of their attendance history ` +
    `to the new id. Same person, same history, same serial — just a shorter id.\n\n` +
    `This may take a little while if there's a lot of history. Don't close the ` +
    `app while it's running. Proceed?`
  )) return;

  setSyncStatus('syncing', 'Migrating ids...');
  let recordsMoved = 0, correctionsUpdated = 0, studentsMigrated = 0;
  try{
    for(const job of jobs){
      // 1. Re-key every attendance-record document for this student, in
      // chunks of 200 (= up to 400 batched ops: one set + one delete per
      // record), safely under Firestore's 500-writes-per-batch limit.
      const snap = await recordsCollection.where('studentId','==', job.oldId).get();
      if(!snap.empty){
        const docs = snap.docs;
        const CHUNK = 200;
        for(let start=0; start<docs.length; start+=CHUNK){
          const batch = db.batch();
          docs.slice(start, start+CHUNK).forEach(doc => {
            const data = doc.data();
            const internalKey = internalKeyFromDocId(doc.id);
            const parts = internalKey.split('|');
            parts[2] = job.newId;
            const newDocId = firestoreDocIdFor(parts.join('|'));
            batch.set(recordsCollection.doc(newDocId), { ...data, studentId: job.newId });
            batch.delete(doc.ref);
          });
          await batch.commit();
        }
        recordsMoved += docs.length;
      }

      // 2. Update any still-pending correction referencing the old id.
      const pendingSnap = await correctionsCollection
        .where('studentId','==', job.oldId)
        .where('status','==','pending')
        .get();
      for(const doc of pendingSnap.docs){
        await doc.ref.update({ studentId: job.newId });
        correctionsUpdated++;
      }

      // 3. Update the roster entry itself (saved together, once, below).
      if(job.kind === 'active') students[job.key][job.idx].id = job.newId;
      else archivedStudents[job.idx].id = job.newId;
      studentsMigrated++;
    }

    const touchedSections = [...new Set(jobs.filter(j=>j.kind==='active').map(j=>j.key))];
    await saveRosterChange({ sections: touchedSections, archived: jobs.some(j=>j.kind==='archived') });

    // 4. Reserve each touched prefix+year's counter to at least one past
    // the highest serial any bumped job landed on, so a NEW student added
    // right after this can never be handed a serial that collides with
    // what we just assigned here.
    const maxSerialByProgYear = {}; // "prog|yearKey" -> highest serial used
    jobs.forEach(j => {
      const k = j.prog + '|' + j.yearKey;
      if(!(k in maxSerialByProgYear) || j.serial > maxSerialByProgYear[k]) maxSerialByProgYear[k] = j.serial;
    });
    for(const [k, maxSerial] of Object.entries(maxSerialByProgYear)){
      const [prog, yearKey] = k.split('|');
      await reserveMinSerial(prog, yearKey, maxSerial + 1);
    }

    const collisionNote = collisionsAvoided > 0 ? ` (${collisionsAvoided} id collision(s) were automatically avoided by bumping to the next free serial)` : '';
    showToast(`✅ Migrated ${studentsMigrated} id(s), moved ${recordsMoved} attendance record(s), updated ${correctionsUpdated} pending correction(s)${collisionNote}`);
    renderCurrentSection();
  }catch(e){
    showToast('⚠️ Migration stopped partway due to an error: ' + e.message + ' — safe to re-run, already-migrated ids are skipped automatically.');
  }finally{
    setSyncStatus('synced');
  }
}

// One-time migration: assigns a permanent id to any existing student who
// doesn't have one yet, AND rewrites that section's existing records from
// the old index-based keys to the new id-based keys in the same pass (a
// student's id only ever gets assigned once, but the records that were
// already keyed by their old array position need to move to the new key
// alongside it, or they'd become invisible the moment id-based lookups
// take over). Runs once per admin login where anything is still missing an
// id; harmless if it runs more than once since it always checks for a
// pre-existing id before assigning a new one.
let idMigrationInFlight = false;

async function migrateMissingStudentIds(){
  if(currentUserRole !== 'admin') return;
  if(idMigrationInFlight) return;

  let anyMissing = false;
  SEC_KEYS.forEach(key=>{
    (students[key]||[]).forEach(s=>{ if(s && typeof s === 'object' && !s.id) anyMissing = true; });
  });
  if(!anyMissing) return;

  idMigrationInFlight = true;
  try{
    const batchEntries = []; // collected across all sections, written once at the end
    for(const key of SEC_KEYS){
      const program = programFor(key);
      const list = students[key] || [];
      const idxToId = {};
      for(let i=0;i<list.length;i++){
        const s = list[i];
        if(!s || typeof s !== 'object') continue;
        if(!s.id){ s.id = await generateStudentId(s.joiningDate, program); }
        idxToId[i] = s.id;
      }
      const rebuilt = {};
      Object.keys(records).forEach(k=>{
        if(!k.startsWith(key + '|')) return; // untouched, still present in `records` afterward
        const parts = k.split('|');
        const idxStr = parts[2];
        // Already an archive tag, or already an id-shaped key (starts with
        // either program's fixed prefix) — leave it exactly as it is, no
        // Firestore write needed since nothing about it changed.
        // Recognize BOTH the new short prefixes (VBS/VYS) and the legacy
        // long ones (R53VBS/R53VYS) here — students imported before the id
        // format change keep their original long-form ids forever, so this
        // check has to accept both shapes or those older students' record
        // keys would look "unmigrated" and get incorrectly re-processed.
        if(idxStr.startsWith('__') || idxStr.startsWith(ID_PREFIXES.balaka) || idxStr.startsWith(ID_PREFIXES.yuvaka)
           || idxStr.startsWith(LEGACY_ID_PREFIXES.balaka) || idxStr.startsWith(LEGACY_ID_PREFIXES.yuvaka)){
          rebuilt[k] = records[k];
          return;
        }
        const oldIdx = parseInt(idxStr, 10);
        const suffix = parts[3] ? '|'+parts[3] : '';
        if(!isNaN(oldIdx) && idxToId[oldIdx] !== undefined){
          const newKey = key+'|'+parts[1]+'|'+idxToId[oldIdx]+suffix;
          rebuilt[newKey] = records[k];
          // Persist the rename: write the new key, delete the old one.
          // (Deleting a key that only ever lived in the legacy field, not
          // the subcollection, is a harmless no-op — see the big comment
          // on migrateRecordsToSubcollection for why that's an acceptable
          // tradeoff here.)
          batchEntries.push({key: newKey, value: records[k]});
          batchEntries.push({key: k, value: null});
        } else {
          // Unrecognized shape for this section — keep as-is rather than
          // silently dropping data we don't understand.
          rebuilt[k] = records[k];
        }
      });
      Object.keys(records).forEach(k=>{ if(k.startsWith(key+'|')) delete records[k]; });
      Object.assign(records, rebuilt);
    }
    await writeRecordKeysBatch(batchEntries);
    await saveState();
    console.log('[ID migration] complete');
  }catch(e){
    console.warn('[ID migration] failed', e);
  }finally{
    idMigrationInFlight = false;
  }
}

// Admin-triggered, one-time (but safely re-runnable) migration: copies
// every entry still sitting in the old attendance/state.records field into
// the new subcollection. Does NOT clear the old field automatically —
// that's a separate, explicitly-confirmed action (clearLegacyRecordsField
// below) so copying-forward and deleting-the-old-copy can never be
// accidentally combined into one irreversible click.
// Tracks exactly which legacy keys have been successfully copied forward.
// Deliberately NOT based on the windowed records listener
// (latestSubcollectionRecords) — that only covers the current + previous
// year, so anything older would incorrectly look "not yet migrated"
// forever, even immediately after a fully successful migration.
let legacyKeysConfirmedMigrated = new Set();

async function migrateRecordsToSubcollection(){
  if(currentUserRole!=='admin'){ showToast('Admin only'); return; }
  const legacy = legacyRecordsField || {};
  const keys = Object.keys(legacy);
  if(!keys.length){
    showToast('Nothing to migrate — no legacy records field found.');
    return;
  }
  if(!confirm(`Copy ${keys.length} attendance record${keys.length===1?'':'s'} from the old storage into the new one?\n\nThis only copies forward — nothing is deleted, and it's safe to run again if interrupted.`)) return;

  showToast(`Migrating ${keys.length} records — this may take a moment...`);
  try{
    const entries = keys.map(k=>({key:k, value:legacy[k]}));
    await writeRecordKeysBatch(entries);
    keys.forEach(k=>legacyKeysConfirmedMigrated.add(k));
    showToast(`✅ Migrated ${keys.length} records. Old data is still kept as a backup until you explicitly clear it.`);
  }catch(e){
    showToast('❌ Migration error: '+e.message);
  }
}

// Separate, deliberately-harder-to-trigger action: wipes the OLD
// attendance/state.records field now that its contents are confirmed safe
// in the new subcollection. Only meaningful to run after
// migrateRecordsToSubcollection() has succeeded — this is what actually
// reclaims space in attendance/state and gets it back under Firestore's
// 1MB document limit for good.
async function clearLegacyRecordsField(){
  if(currentUserRole!=='admin'){ showToast('Admin only'); return; }
  const legacyKeys = Object.keys(legacyRecordsField || {});
  const legacyCount = legacyKeys.length;
  if(!legacyCount){ showToast('Old records field is already empty — nothing to clear.'); return; }
  const migratedCount = legacyKeys.filter(k=>legacyKeysConfirmedMigrated.has(k)).length;
  if(migratedCount < legacyCount){
    if(!confirm(`⚠️ Only ${migratedCount} of ${legacyCount} legacy records are confirmed migrated in this session. Run "Migrate" again first — are you SURE you want to clear the old data anyway? This cannot be undone.`)) return;
  } else {
    if(!confirm(`Permanently clear the old attendance records field (${legacyCount} entries)? All ${legacyCount} are confirmed present in the new storage already. This cannot be undone.`)) return;
  }
  try{
    await stateDoc.update({records: firebase.firestore.FieldValue.delete()});
    showToast('✅ Old records field cleared — attendance/state is back to a small, permanent size.');
  }catch(e){
    showToast('❌ Error clearing old field: '+e.message);
  }
}

// Backend view is mostly static HTML (the tool boxes themselves), so
// there's little to actually render — this exists mainly as a defense-in
// -depth check: the tab itself is already hidden from anyone who isn't
// currentUserIsBackend (see showApp()), but if that state is ever stale
// (e.g. account switched without a full reload), this stops the content
// from being usable regardless.
function renderBackendTools(){
  const view = document.getElementById('backend-view');
  if(!view) return;
  if(!currentUserIsBackend){
    view.innerHTML = '<div class="empty-state">Not available for this account.</div>';
    curView = 'attendance';
    document.querySelectorAll('.main-tab').forEach(t=>t.classList.remove('active'));
    const attTab = document.querySelector('.main-tab[data-view="attendance"]');
    if(attTab) attTab.classList.add('active');
    document.getElementById('attendance-view').classList.add('visible');
    view.classList.remove('visible');
    renderCurrentSection();
  }
  // else: nothing dynamic to do — the tool boxes are already in the
  // static HTML and fully functional as-is.
}
