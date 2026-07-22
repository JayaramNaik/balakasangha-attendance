// ===================== SUBMIT-LOCK, CORRECTIONS, AUDIT LOG =====================

function isLocked(key, date){ return !!(key && date && locks[key+'|'+date]); }

async function toggleSessionLock(key){
  if(!curDate){ showToast('Select a Sunday session first'); return; }
  const lockKey = key+'|'+curDate;
  const secLabel = (SECTIONS[key]||{}).label || key;
  if(locks[lockKey]){
    // Unlocking is admin-only — a volunteer shouldn't be able to undo a
    // submitted session once it's locked.
    if(currentUserRole!=='admin'){ showToast('Only an admin can unlock a submitted session'); return; }
    if(!confirm('Unlock '+secLabel+' for '+fmtFull(curDate)+'?\n\nMarks can be edited directly again until re-locked.')) return;
    delete locks[lockKey];
    await saveLockFields([lockKey]);
    showToast('🔓 Session unlocked');
  } else {
    // Both admins and volunteers can submit & lock a session they've
    // finished marking.
    if(!confirm('Submit & lock '+secLabel+' for '+fmtFull(curDate)+'?\n\nAfter this, marks can only be changed through a correction request that an admin reviews.')) return;
    locks[lockKey] = {
      lockedBy: currentUser?currentUser.email:'',
      lockedByName: currentUserName||'',
      lockedAt: new Date().toISOString()
    };
    await saveLockFields([lockKey]);
    showToast('🔒 Session submitted and locked');
  }
  renderSection(key);
}

// Admin-only bar showing lock status across ALL sections for the currently
// selected Sunday, with a single button to lock/unlock everything at once —
// alongside (not instead of) the per-section lock buttons.
function renderGlobalLockBar(){
  const el = document.getElementById('global-lock-bar');
  if(!el) return;
  if(currentUserRole!=='admin' || !curDate){
    el.style.display='none';
    el.innerHTML='';
    return;
  }
  el.style.display='flex';
  const lockedCount = SEC_KEYS.filter(k=>isLocked(k,curDate)).length;
  const total = SEC_KEYS.length;
  const allLocked = lockedCount===total;
  const noneLocked = lockedCount===0;
  const statusText = allLocked
    ? `🔒 All ${total} sections locked for ${fmtFull(curDate)}`
    : noneLocked
      ? `🔓 No sections locked yet for ${fmtFull(curDate)}`
      : `⚠️ ${lockedCount}/${total} sections locked for ${fmtFull(curDate)}`;
  el.innerHTML = `
    <span style="font-size:12.5px;color:var(--text2);flex:1">${statusText}</span>
    <button onclick="toggleAllSectionsLock()" style="background:${allLocked?'#856404':'#1D9E75'};color:#fff;border:none;border-radius:8px;padding:7px 14px;cursor:pointer;font-size:12.5px;font-weight:600;white-space:nowrap">
      ${allLocked ? '🔓 Unlock All Sections' : '🔒 Submit & Lock All Sections'}
    </button>`;
}

async function toggleAllSectionsLock(){
  if(currentUserRole!=='admin'){ showToast('Admin only'); return; }
  if(!curDate){ showToast('Select a Sunday session first'); return; }
  const lockedCount = SEC_KEYS.filter(k=>isLocked(k,curDate)).length;
  const allLocked = lockedCount===SEC_KEYS.length;

  if(allLocked){
    if(!confirm('Unlock ALL sections for '+fmtFull(curDate)+'?\n\nMarks can be edited directly again in every section until re-locked.')) return;
    SEC_KEYS.forEach(k=>delete locks[k+'|'+curDate]);
    await saveLockFields(SEC_KEYS.map(k=>k+'|'+curDate));
    showToast('🔓 All sections unlocked');
  } else {
    if(!confirm('Submit & lock ALL sections for '+fmtFull(curDate)+'?\n\nAfter this, marks in every section can only be changed through a correction request that you review.')) return;
    SEC_KEYS.forEach(k=>{
      locks[k+'|'+curDate] = {
        lockedBy: currentUser?currentUser.email:'',
        lockedByName: currentUserName||'',
        lockedAt: new Date().toISOString()
      };
    });
    await saveLockFields(SEC_KEYS.map(k=>k+'|'+curDate));
    showToast('🔒 All sections submitted and locked');
  }
  renderCurrentSection();
}

// Writes one entry to the auditLog collection. Never blocks the calling
// action if logging fails — the attendance/correction operation itself has
// already succeeded by the time this is called.
async function logAudit(action, details){
  if(!auditLogCollection) return;
  try{
    await auditLogCollection.add(Object.assign({
      action,
      performedBy: currentUserName || (currentUser?currentUser.email:'unknown'),
      performedByEmail: currentUser?currentUser.email:'',
      performedAt: firebase.firestore.FieldValue.serverTimestamp(),
      performedAtLocal: new Date().toISOString()
    }, details));
  }catch(e){ console.warn('[Audit] failed to log', e); }
}

let allMyStudentRequests = []; // volunteer's own student-add requests, any status — for the Corrections tab tracking view
function initMyStudentRequestsListener(){
  if(!db || !studentAddRequestsCollection || currentUserRole==='admin') return; // admins review these in the Approvals tab instead
  const myEmail = currentUser ? currentUser.email : '';
  studentAddRequestsCollection.where('requestedBy','==', myEmail).onSnapshot(snap=>{
    allMyStudentRequests = snap.docs.map(d=>Object.assign({id:d.id}, d.data()));
    // No .orderBy() in the query — same composite-index avoidance as the
    // corrections listener below. Sort client-side instead.
    allMyStudentRequests.sort((a,b)=>{
      const ta = a.requestedAt && a.requestedAt.toMillis ? a.requestedAt.toMillis() : 0;
      const tb = b.requestedAt && b.requestedAt.toMillis ? b.requestedAt.toMillis() : 0;
      return tb - ta;
    });
    if(curView==='corrections') renderCorrections();
  }, err=>console.warn('[MyStudentRequests] listener error', err));
}

// Live listener for correction requests — keeps the badge count and the
// Corrections tab in sync across all signed-in devices.
//
// IMPORTANT: the query itself must match what the Firestore security rule
// allows a non-admin to read. The rule only lets a volunteer read documents
// where requestedBy == their own email — but this listener used to run one
// single unfiltered orderBy() query for everyone. Firestore doesn't quietly
// filter an unconstrained query down to "just what you're allowed to see";
// if the query COULD return documents the rule wouldn't allow, it rejects
// the entire query. For an admin (whom the rule allows to read everything)
// that succeeded; for every volunteer it silently failed in full — logged
// to console, invisible to the person actually using the app — which is
// exactly why a volunteer's own correction request, visible fine to an
// admin, showed as "no such correction" in their own view. The fix is to
// scope the query itself to match the rule for non-admins.
function initCorrectionsListener(){
  if(!correctionsCollection) return;
  const isAdmin = currentUserRole === 'admin';
  const myEmail = currentUser ? currentUser.email : '';
  // Volunteer path deliberately has NO .orderBy() here — combining a
  // .where() filter with .orderBy() on a different field requires a
  // Firestore composite index that doesn't exist for this collection, and
  // creating one is an easy-to-miss manual step in Firebase Console. A
  // volunteer's own request count is always small, so sorting client-side
  // below is simpler and needs no index at all. The admin path keeps its
  // .orderBy() since a single-field sort with no .where() needs no
  // composite index — Firestore indexes every field individually by
  // default.
  const query = isAdmin
    ? correctionsCollection.orderBy('requestedAt','desc')
    : correctionsCollection.where('requestedBy','==', myEmail);
  query.onSnapshot(snap=>{
    allCorrections = snap.docs.map(d=>Object.assign({id:d.id}, d.data()));
    if(!isAdmin){
      allCorrections.sort((a,b)=>{
        const ta = a.requestedAt && a.requestedAt.toMillis ? a.requestedAt.toMillis() : 0;
        const tb = b.requestedAt && b.requestedAt.toMillis ? b.requestedAt.toMillis() : 0;
        return tb - ta;
      });
    }
    const pendingCount = allCorrections.filter(c=>c.status==='pending').length;
    const badge = document.getElementById('corrections-badge');
    if(badge){
      if(pendingCount>0 && currentUserRole==='admin'){ badge.textContent=pendingCount; badge.style.display='inline-block'; }
      else { badge.style.display='none'; }
    }
    if(curView==='corrections') renderCorrections();
  }, err=>console.warn('[Corrections] listener error', err));
}

let correctionContext = { key:null, idx:null, date:null };

function openCorrectionModal(key, idx, requestedType){
  if(!curDate) return;
  correctionContext = { key, idx, date: curDate };
  const student = students[key][idx];
  const name = typeof student==='string' ? student : student.name;
  const current = getRecord(key, curDate, idx);
  const currentLabel = current==='P' ? 'Present' : current==='A' ? 'Absent' : 'Not marked';
  document.getElementById('correction-student-name').textContent = name+' — '+((SECTIONS[key]||{}).label||key)+' · '+fmtFull(curDate);
  document.getElementById('correction-current-value').textContent = currentLabel;
  document.getElementById('correction-new-value').value = requestedType || (current==='P' ? 'A' : 'P');
  document.getElementById('correction-reason').value = '';
  document.getElementById('correction-modal').classList.add('visible');
}

function closeCorrectionModal(){
  document.getElementById('correction-modal').classList.remove('visible');
  correctionContext = { key:null, idx:null, date:null };
}

async function submitCorrectionRequest(){
  const { key, idx, date } = correctionContext;
  if(key===null || idx===null) return;
  const newValue = document.getElementById('correction-new-value').value;
  const reason = document.getElementById('correction-reason').value.trim();
  if(!reason){ showToast('Please describe the reason for this correction'); return; }
  if(!correctionsCollection){ showToast('Not connected — try again shortly'); return; }

  const student = students[key][idx];
  const name = typeof student==='string' ? student : student.name;
  const oldValue = getRecord(key, date, idx);
  const secLabel = (SECTIONS[key]||{}).label || key;

  try{
    await correctionsCollection.add({
      section: key, sectionLabel: secLabel,
      date, studentIdx: idx, studentId: idFor(key, idx), studentName: name,
      field: 'attendance',
      oldValue: oldValue || null,
      newValue,
      reason,
      status: 'pending',
      requestedBy: currentUser?currentUser.email:'',
      requestedByName: currentUserName||'',
      requestedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    logAudit('correction_requested', {section:key, sectionLabel:secLabel, date, studentName:name, oldValue, newValue, reason});
    closeCorrectionModal();
    showToast('✅ Correction request sent to admin');
  }catch(e){
    showToast('Error submitting request: '+e.message);
  }
}

function renderCorrections(){
  const el = document.getElementById('corrections-content');
  if(!el) return;
  const isAdmin = currentUserRole==='admin';
  const myEmail = currentUser?currentUser.email:'';
  const list = isAdmin ? allCorrections : allCorrections.filter(c=>c.requestedBy===myEmail);

  let html = '';

  // Volunteers get a second section here tracking their own student-add
  // requests — admins already see and act on these in the Approvals tab,
  // so this is read-only status tracking for the person who submitted it.
  if(!isAdmin){
    html += '<h3 style="margin:6px 0 14px">🧑‍🎓 My Student Requests</h3>';
    if(!allMyStudentRequests.length){
      html += '<div class="empty-state" style="margin-bottom:22px">You haven\u2019t requested any students be added yet.</div>';
    } else {
      html += allMyStudentRequests.map(r=>{
        const statusColor = r.status==='pending' ? '#856404' : r.status==='approved' ? '#1D9E75' : '#C0392B';
        const statusBg    = r.status==='pending' ? '#FFF3CD' : r.status==='approved' ? '#E3F6EE' : '#FBEAEA';
        const detail = r.class ? 'Class '+escapeHtml(r.class) : (r.professionType ? escapeHtml(r.professionType)+': '+escapeHtml(r.professionDetail||'') : '');
        return `<div style="background:var(--surface);border:1px solid var(--border2);border-radius:10px;padding:14px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap">
          <div>
            <div style="font-weight:700">${escapeHtml(r.name)}</div>
            <div style="font-size:12px;color:var(--text3)">${escapeHtml(r.sectionLabel||r.section)} · ${detail}</div>
            ${r.reviewedByName ? `<div style="font-size:11px;color:var(--text4);margin-top:6px">Reviewed by ${escapeHtml(r.reviewedByName)}</div>` : ''}
          </div>
          <span style="background:${statusBg};color:${statusColor};font-weight:700;font-size:11px;padding:3px 10px;border-radius:10px;white-space:nowrap">${r.status.toUpperCase()}</span>
        </div>`;
      }).join('') + '<div style="margin-bottom:22px"></div>';
    }
  }

  html += '<h3 style="margin:6px 0 14px">'+(isAdmin?'🔄 Correction Requests':'🔄 My Correction Requests')+'</h3>';

  if(!list.length){
    html += '<div class="empty-state">'+(isAdmin?'No correction requests yet.':'You haven\u2019t submitted any correction requests yet.')+'</div>';
    el.innerHTML = html;
    return;
  }

  const fmtVal = v => v==='P' ? 'Present' : v==='A' ? 'Absent' : 'Not marked';

  html += list.map(c=>{
    const statusColor = c.status==='pending' ? '#856404' : c.status==='approved' ? '#1D9E75' : '#C0392B';
    const statusBg    = c.status==='pending' ? '#FFF3CD' : c.status==='approved' ? '#E3F6EE' : '#FBEAEA';
    return `<div style="background:var(--surface);border:1px solid var(--border2);border-radius:10px;padding:14px;margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap">
        <div>
          <div style="font-weight:700">${escapeHtml(c.studentName)}</div>
          <div style="font-size:12px;color:var(--text3)">${escapeHtml(c.sectionLabel)} · ${fmtFull(c.date)}</div>
          <div style="font-size:12.5px;margin-top:6px">Change: <strong>${fmtVal(c.oldValue)}</strong> → <strong>${fmtVal(c.newValue)}</strong></div>
          <div style="font-size:12.5px;color:var(--text2);margin-top:4px">"${escapeHtml(c.reason)}"</div>
          <div style="font-size:11px;color:var(--text4);margin-top:6px">Requested by ${escapeHtml(c.requestedByName||c.requestedBy)}${c.reviewedByName?' · Reviewed by '+escapeHtml(c.reviewedByName):''}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px">
          <span style="background:${statusBg};color:${statusColor};font-weight:700;font-size:11px;padding:3px 10px;border-radius:10px;white-space:nowrap">${c.status.toUpperCase()}</span>
          ${isAdmin && c.status==='pending' ? `
            <div style="display:flex;gap:6px">
              <button onclick="approveCorrection('${c.id}')" style="background:#1D9E75;color:#fff;border:none;border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer">✓ Approve</button>
              <button onclick="rejectCorrection('${c.id}')" style="background:#C0392B;color:#fff;border:none;border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer">✕ Reject</button>
            </div>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');

  el.innerHTML = html;
}

async function approveCorrection(id){
  if(currentUserRole!=='admin') return;
  const c = allCorrections.find(x=>x.id===id);
  if(!c) return;

  // Find where this student currently sits in the roster. Prefer the
  // permanent id (present on corrections submitted after the ID system
  // existed) — it's exact regardless of whether the roster has since been
  // reordered, promoted, or the student's name edited. Older pending
  // corrections filed before this existed fall back to the previous
  // name-at-index check.
  let liveIdx = null;
  if(c.studentId){
    liveIdx = (students[c.section]||[]).findIndex(s => typeof s==='object' && s.id === c.studentId);
    if(liveIdx === -1){
      showToast('⚠️ ' + c.studentName + ' is no longer on the ' + (c.sectionLabel||c.section) + ' roster (removed or promoted since this request) — cannot safely apply. Please ask them to resubmit if needed.');
      return;
    }
  } else {
    const rosterAtIdx = (students[c.section] || [])[c.studentIdx];
    const nameAtIdx = rosterAtIdx ? (typeof rosterAtIdx === 'object' ? rosterAtIdx.name : rosterAtIdx) : null;
    if(!rosterAtIdx || nameAtIdx !== c.studentName){
      showToast('⚠️ Roster has changed since this request was submitted — cannot safely apply to ' + c.studentName + '. Please ask them to resubmit.');
      return;
    }
    liveIdx = c.studentIdx;
  }

  if(!confirm('Approve this correction for '+c.studentName+'?')) return;
  try{
    const writes = [
      setRecord(c.section, c.date, liveIdx, c.newValue),
      setAttendanceTracker(c.section, c.date, liveIdx, currentUserName, getCurrentTime(), fmtDate(new Date()))
    ];
    await saveRecordWrites(writes);
    await correctionsCollection.doc(id).update({
      status: 'approved',
      reviewedBy: currentUser?currentUser.email:'',
      reviewedByName: currentUserName||'',
      reviewedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    logAudit('correction_approved', {section:c.section, sectionLabel:c.sectionLabel, date:c.date, studentName:c.studentName, oldValue:c.oldValue, newValue:c.newValue, reason:c.reason});
    renderSection(c.section);
    showToast('✅ Correction approved and applied');
  }catch(e){ showToast('Error: '+e.message); }
}

async function rejectCorrection(id){
  if(currentUserRole!=='admin') return;
  const c = allCorrections.find(x=>x.id===id);
  if(!c) return;
  if(!confirm('Reject this correction request for '+c.studentName+'?')) return;
  try{
    await correctionsCollection.doc(id).update({
      status: 'rejected',
      reviewedBy: currentUser?currentUser.email:'',
      reviewedByName: currentUserName||'',
      reviewedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    logAudit('correction_rejected', {section:c.section, sectionLabel:c.sectionLabel, date:c.date, studentName:c.studentName, oldValue:c.oldValue, newValue:c.newValue, reason:c.reason});
    showToast('Correction rejected');
  }catch(e){ showToast('Error: '+e.message); }
}

// Only correction_* actions are ever logged (see logAudit call sites) and
// the Audit Log view filters to these exclusively — no routine marks,
// locks, or student edits, per the "corrections only" requirement.
const AUDIT_ACTION_LABEL = {
  correction_requested: '🔄 Correction requested',
  correction_approved: '✅ Correction approved',
  correction_rejected: '❌ Correction rejected'
};

async function renderAuditLog(){
  const el = document.getElementById('auditlog-content');
  if(!el) return;
  if(currentUserRole!=='admin'){ el.innerHTML = '<div class="empty-state">Admin only.</div>'; return; }

  // Storage maintenance panel — shown above the log itself, only when
  // there's actually legacy data to deal with. This is where
  // migrateRecordsToSubcollection/clearLegacyRecordsField live: moving
  // attendance records out of the single attendance/state document (which
  // has a hard 1MB Firestore limit and, more urgently, meant two people
  // marking different sections at the same moment could silently overwrite
  // each other's marks) into their own small documents, one per record.
  const legacyCount = Object.keys(legacyRecordsField || {}).length;
  const migratedCount = Object.keys(legacyRecordsField || {}).filter(k=>legacyKeysConfirmedMigrated.has(k)).length;
  let maintenanceHtml = '';
  if(legacyCount > 0){
    const fullyMigrated = migratedCount >= legacyCount;
    maintenanceHtml = `<div style="background:${fullyMigrated?'#E3F6EE':'#FFF3CD'};border:1.5px solid ${fullyMigrated?'#1D9E75':'#FFC107'};border-radius:10px;padding:14px;margin-bottom:16px">
      <div style="font-weight:700;margin-bottom:6px">${fullyMigrated?'✅':'⚠️'} Attendance storage maintenance</div>
      <div style="font-size:12.5px;color:var(--text2);margin-bottom:10px">
        ${legacyCount} record${legacyCount===1?'':'s'} still in the old storage format.
        ${fullyMigrated ? 'All appear copied into the new storage already — safe to clear the old copy and reclaim space.' : 'Migrate them to the new per-record storage (safe to run anytime, copies forward only, never deletes).'}
      </div>
      <button onclick="migrateRecordsToSubcollection()" style="background:#1D9E75;color:#fff;border:none;border-radius:6px;padding:6px 12px;font-size:12.5px;cursor:pointer;margin-right:8px">↪ Migrate to new storage</button>
      <button onclick="clearLegacyRecordsField()" style="background:#C0392B;color:#fff;border:none;border-radius:6px;padding:6px 12px;font-size:12.5px;cursor:pointer">🗑 Clear old storage${fullyMigrated?'':' (not fully migrated yet)'}</button>
    </div>`;
  }

  if(!auditLogCollection){ el.innerHTML = maintenanceHtml + '<div class="empty-state">Not connected.</div>'; return; }
  el.innerHTML = maintenanceHtml + '<div class="empty-state">Loading audit log...</div>';
  try{
    // Fetch a larger raw batch since we filter down to corrections only —
    // older entries from before this filter existed (routine marks/locks)
    // are skipped here, even though they still exist in Firestore.
    const snap = await auditLogCollection.orderBy('performedAt','desc').limit(500).get();
    const entries = snap.docs.map(d=>d.data())
      .filter(e => e.action && e.action.startsWith('correction_'))
      .slice(0, 200);
    if(!entries.length){ el.innerHTML = maintenanceHtml + '<div class="empty-state">No corrections logged yet.</div>'; return; }
    const fmtVal = v => v==='P' ? 'Present' : v==='A' ? 'Absent' : escapeHtml(v || '—');
    const rows = entries.map(e=>{
      const when = (e.performedAt && e.performedAt.toDate) ? e.performedAt.toDate().toLocaleString() : (e.performedAtLocal||'');
      let detail = '';
      if(e.oldValue!==undefined || e.newValue!==undefined){
        detail = fmtVal(e.oldValue)+' → '+fmtVal(e.newValue);
      }
      if(e.reason) detail += (detail?' · ':'')+'"'+escapeHtml(e.reason)+'"';
      if(e.detail) detail += (detail?' · ':'')+escapeHtml(e.detail);
      return `<tr>
        <td style="font-size:11.5px;white-space:nowrap">${escapeHtml(when)}</td>
        <td style="font-size:12px;white-space:nowrap">${escapeHtml(AUDIT_ACTION_LABEL[e.action]||e.action)}</td>
        <td style="font-size:12px">${escapeHtml(e.sectionLabel||e.section||'')}</td>
        <td style="font-size:12px">${escapeHtml(e.studentName||'')}</td>
        <td style="font-size:12px">${detail}</td>
        <td style="font-size:12px">${escapeHtml(e.performedBy||'')}</td>
      </tr>`;
    }).join('');
    el.innerHTML = maintenanceHtml + `<h3 style="margin:6px 0 14px">🕵️ Audit Log <span style="font-size:12px;color:var(--text3);font-weight:400">(corrections only — most recent 200)</span></h3>
      <table><thead><tr><th>When</th><th>Action</th><th>Section</th><th>Student</th><th>Detail</th><th>By</th></tr></thead><tbody>${rows}</tbody></table>`;
  }catch(e){
    el.innerHTML = maintenanceHtml + '<div class="empty-state">Could not load audit log: '+e.message+'</div>';
  }
}
