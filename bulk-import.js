// ===================== BULK IMPORT =====================
let bulkImportContext = { key: null, students: [] };
 
function openBulkImport(key) {
  bulkImportContext = { key, students: [] };
  const profession = isProfessionSection(key);
  document.getElementById('bulk-import-title').textContent = profession ? '📥 Bulk Import Volunteers' : '📥 Bulk Import Students';
  document.getElementById('bulk-columns-hint').textContent = profession
    ? 'Columns: Name, Type (Profession/Education), Detail, Joining Date (DD-MM-YYYY, or just a year like 2015 if the exact date is unknown), Joined Via (Directly / VBS — optional, defaults to Directly), WhatsApp Number (optional)'
    : 'Columns: Name, Class, Joining Date, Parent WhatsApp Number (optional)';
  document.getElementById('bulk-secondary-col-header').textContent = secondaryFieldLabel(key);
  // "Joined Via" only applies to Yuvaka Sangha imports — same reasoning as
  // the single-add modal's add-origin-group (see openAddStudentModal).
  document.getElementById('bulk-origin-col-header').style.display = profession ? 'table-cell' : 'none';
  document.getElementById('bulk-import-overlay').style.display = 'flex';
  document.getElementById('bulk-preview').style.display = 'none';
  document.getElementById('bulk-confirm-btn').style.display = 'none';
  document.getElementById('bulk-status').textContent = '';
  document.getElementById('bulk-file-input').value = '';
}
 
function closeBulkImport() {
  document.getElementById('bulk-import-overlay').style.display = 'none';
  bulkImportContext = { key: null, students: [] };
}
 
function downloadTemplate() {
  const profession = isProfessionSection(bulkImportContext.key);
  const wb = XLSX.utils.book_new();
  if(profession){
    const ws = XLSX.utils.aoa_to_sheet([
      ['Name', 'Type', 'Detail', 'Joining Date', 'Joined Via', 'WhatsApp Number'],
      ['Ramesh Rao', 'Profession', 'Software Engineer', '22-06-2026', 'Directly', '9876543210'],
      ['Anjali Bhat', 'Education', 'B.Com 2nd Year', '22-06-2026', 'VBS', ''],
      ['Suresh Kumar', 'Profession', 'Business', '2015', 'VBS', '+91 98450 12345'],
    ]);
    ws['!cols'] = [{wch:25},{wch:12},{wch:22},{wch:15},{wch:12},{wch:18}];
    // Row 4 is deliberate — shows that for senior volunteers whose exact
    // joining date isn't known, a bare 4-digit year (just "2015", no day
    // or month) is a valid Joining Date value on its own, not something
    // that needs a placeholder day tacked on.
    XLSX.utils.book_append_sheet(wb, ws, 'Volunteers');
    XLSX.writeFile(wb, 'YuvakaSangha_Volunteer_Template.xlsx');
  } else {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Name', 'Class', 'Joining Date', 'Parent WhatsApp Number'],
      ['Ravi Kumar', '7', '22-06-2026', '9876543210'],
      ['Priya Sharma', '8', '22-06-2026', '+91 98450 12345'],
      ['Arjun Naik', '5', '22-06-2026', ''],
    ]);
    ws['!cols'] = [{wch:25},{wch:10},{wch:15},{wch:24}];
    XLSX.utils.book_append_sheet(wb, ws, 'Students');
    XLSX.writeFile(wb, 'BalakaSangha_Student_Template.xlsx');
  }
}
 
function handleBulkFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  document.getElementById('bulk-status').textContent = 'Reading file...';
 
  const key = bulkImportContext.key;
  const profession = isProfessionSection(key);
  const reader = new FileReader();
 
  reader.onload = function(e) {
    try {
      let rows = [];
 
      // Robust date parser for bulk import. Accepts the app's established
      // day-first convention (DD-MM-YYYY OR DD/MM/YYYY, 1- or 2-digit day
      // /month) as well as already-ISO YYYY-MM-DD — spreadsheet software
      // often reformats a typed date in ways that don't match one single
      // rigid pattern (typing "22-06-2025" into Excel can come back out as
      // "6/22/2025" once the cell becomes a real date value, depending on
      // the sheet's locale/number format). Returns '' for a genuinely BLANK
      // cell (caller defaults that to today — a reasonable assumption for
      // missing data) but null for anything NON-blank it can't confidently
      // parse — the caller must treat that as an ERROR, not guess. This is
      // the actual fix for the reported bug: previously an unrecognized
      // format fell through as the raw, un-reformatted string, which
      // studentIdYearPart() then couldn't read a valid year out of either,
      // and silently substituted the CURRENT year in the id — with nothing
      // in the preview showing anything had gone wrong.
      const parseDate = (rawInput) => {
        // Excel can hand us a raw NUMBER instead of a string for this
        // column — most commonly this happens exactly when someone types a
        // BARE YEAR (e.g. "2015") into a cell that inherited a date number
        // format from neighboring cells (very easy to happen, since this
        // column normally holds real dates). Excel doesn't reinterpret
        // what was typed — it still stores the literal number 2015 — but
        // it DISPLAYS that number as a date using its day-serial system
        // (serial 2015, counted from 30-Dec-1899), which comes out to
        // 07-07-1905. Reading Excel's own formatted display text for a
        // cell like that (what this code used to do) hands us that bogus
        // 1905 date instead of "2015" — sometimes rejected as unparseable,
        // sometimes accidentally VALID-shaped and silently imported as a
        // garbage joining date. Working from the raw underlying number
        // sidesteps this entirely, regardless of how the cell happens to
        // be formatted.
        if(typeof rawInput === 'number'){
          const nowYear = new Date().getFullYear();
          // A genuine calendar date anywhere in the accepted 1950-current
          // range has an Excel serial in the tens of thousands (1950-01-01
          // is serial ~18262). A literal typed year (1950-2100) is always
          // far smaller than that, so this threshold cleanly tells "this
          // was meant as a year" apart from "this is a real date serial"
          // with no realistic ambiguity.
          if(profession && Number.isInteger(rawInput) && rawInput>=1950 && rawInput<=nowYear){
            return String(rawInput);
          }
          // Otherwise this is a genuine Excel date serial — convert it
          // properly via the library's own parser rather than hand-rolling
          // the 1900 leap-year quirk ourselves.
          if(typeof XLSX!=='undefined' && XLSX.SSF && XLSX.SSF.parse_date_code){
            const parsed = XLSX.SSF.parse_date_code(rawInput);
            // Sanity-check the resulting year even for a successfully
            // decoded date. Without this, a VBS (non-profession) row where
            // someone made the exact same "typed a bare year into a
            // date-formatted cell" mistake would decode into a real, valid
            // -shaped date (e.g. 1905-07-07 for the number 2015) and get
            // silently imported as-is — no error shown, just a garbage
            // joining date and a garbled id year. Any date outside a
            // plausible joining-date range is far more likely to be this
            // exact mistake than an actual 1905-era joining date.
            if(parsed && parsed.y && parsed.m && parsed.d){
              const nowYear = new Date().getFullYear();
              if(parsed.y>=1950 && parsed.y<=nowYear+1){
                return parsed.y+'-'+String(parsed.m).padStart(2,'0')+'-'+String(parsed.d).padStart(2,'0');
              }
              return null;
            }
          }
          return null;
        }
        let raw = (rawInput||'').toString().trim();
        // Strip a leading apostrophe — Excel's own marker for "treat this
        // cell as text, don't auto-convert it to a date" (people often add
        // this deliberately to stop Excel reformatting their typed date).
        // Some export paths carry that apostrophe through into the raw
        // text value, which would otherwise make an otherwise-valid date
        // fail to match either pattern below.
        if(raw.startsWith("'")) raw = raw.slice(1).trim();
        if(!raw) return '';
        let m = raw.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/); // YYYY-MM-DD or YYYY/MM/DD
        if(m){
          const mo = parseInt(m[2],10), d = parseInt(m[3],10);
          if(mo>=1 && mo<=12 && d>=1 && d<=31) return m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0');
          return null;
        }
        m = raw.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/); // DD-MM-YYYY, DD/MM/YYYY, or DD.MM.YYYY
        if(m){
          const d = parseInt(m[1],10), mo = parseInt(m[2],10);
          // Only accept the day-first reading if it's actually a valid date
          // that way (month 1-12, day 1-31) — e.g. Excel's US-locale
          // reformat of a date can come out as "6/22/2025", which is NOT a
          // valid day-first date (22 can't be a month), so this correctly
          // falls through to null (flagged as an error) instead of
          // silently accepting a nonsense month.
          if(mo>=1 && mo<=12 && d>=1 && d<=31) return m[3]+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0');
          return null;
        }
        // Bare 4-digit year — for senior Yuvaka Sangha volunteers whose
        // exact joining day and month were never recorded, only the
        // approximate year. Deliberately gated to `profession` (i.e. this
        // being a Yuvaka Sangha import) — VBS students always have a known
        // exact joining date, so a bare year here should stay an error for
        // them, same as before. `profession` is available via closure from
        // handleBulkFile() above. Returned as the plain year string,
        // unchanged — everywhere else that reads joiningDate (fmtDisplay,
        // studentIdYearPart, the Edit modal) is already built to recognize
        // this exact same shape, so nothing downstream needs to treat it as
        // a special case beyond this point.
        if(profession){
          m = raw.match(/^(\d{4})$/);
          if(m){
            const yearNum = parseInt(m[1],10);
            const nowYear = new Date().getFullYear();
            if(yearNum>=1950 && yearNum<=nowYear) return m[1];
            return null;
          }
        }
        return null; // unrecognized shape — flagged as an error downstream, never guessed
      };
 
      if (file.name.endsWith('.csv')) {
        // Parse CSV — respecting quoted fields that contain commas (e.g. a
        // profession detail like "Software Engineer, Backend"). A plain
        // line.split(',') would silently misalign every column after that
        // point for that row — not a crash, just quietly wrong data, which
        // is worse than an error since nothing would look obviously broken.
        const parseCSVLine = (line) => {
          const result = [];
          let cur = '';
          let inQuotes = false;
          for(let i=0; i<line.length; i++){
            const c = line[i];
            if(inQuotes){
              if(c === '"' && line[i+1] === '"'){ cur += '"'; i++; }
              else if(c === '"'){ inQuotes = false; }
              else cur += c;
            } else {
              if(c === '"'){ inQuotes = true; }
              else if(c === ','){ result.push(cur); cur = ''; }
              else cur += c;
            }
          }
          result.push(cur);
          return result.map(v => v.trim());
        };
        const text = e.target.result;
        const lines = text.split('\n').filter(l => l.trim());
        rows = lines.slice(1).map(line => {
          const vals = parseCSVLine(line);
          if(profession){
            return { name: vals[0]||'', type: vals[1]||'', detail: vals[2]||'', joiningDateRaw: (vals[3]||'').trim(), joiningDate: parseDate(vals[3]), joinedVia: vals[4]||'', phoneRaw: (vals[5]||'').trim() };
          }
          return { name: vals[0]||'', class: vals[1]||'', joiningDateRaw: (vals[2]||'').trim(), joiningDate: parseDate(vals[2]), phoneRaw: (vals[3]||'').trim() };
        });
      } else {
        // Parse Excel
        // cellDates:false + raw:true (rather than the previous cellDates:true
        // + raw:false) deliberately keeps numeric cells as plain numbers
        // instead of letting the library or Excel's own cell formatting
        // decide how to display them. This is what lets parseDate() tell a
        // bare typed year (e.g. 2015) apart from a genuine date serial by
        // its raw magnitude — see the big comment in parseDate() above for
        // why relying on the FORMATTED text was silently producing bogus
        // 1905-era dates for exactly that case.
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: 'array', cellDates: false });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(ws, { raw: true, defval: '' });
        // Header names are matched flexibly, not just the exact template
        // wording — real spreadsheets people actually hand you often use
        // their own naming ("Date Of Joining" instead of "Joining Date",
        // "VBS/VYS" instead of "Joined Via", "Profession"/"Designation"
        // instead of "Type"/"Detail"). Previously an unrecognized header
        // meant that column silently came through as an EMPTY string for
        // every row — which for Joining Date in particular meant every
        // row quietly defaulted to today's date (and so the CURRENT year
        // in the id) with no error shown, even though the file clearly had
        // a date column, just under a different name.
        rows = json.map(r => {
          const name = (r['Name'] || r['name'] || '').toString().trim();
          // Deliberately NOT forced through .toString().trim() here like the
          // other fields — rawJoin needs to stay a raw JS number when Excel
          // gave us one, so parseDate() can tell a bare typed year apart
          // from a real date serial by magnitude (see parseDate's comment).
          // joiningDateRaw (a display-only string, used only in error
          // messages / as a fallback value) is derived separately below.
          const rawJoin = (r['Joining Date'] !== '' && r['Joining Date'] !== undefined) ? r['Joining Date']
                         : (r['joining date'] !== '' && r['joining date'] !== undefined) ? r['joining date']
                         : (r['JoiningDate'] !== '' && r['JoiningDate'] !== undefined) ? r['JoiningDate']
                         : (r['Date Of Joining'] !== '' && r['Date Of Joining'] !== undefined) ? r['Date Of Joining']
                         : (r['Date of Joining'] !== '' && r['Date of Joining'] !== undefined) ? r['Date of Joining']
                         : (r['date of joining'] !== '' && r['date of joining'] !== undefined) ? r['date of joining']
                         : '';
          const rawJoinDisplay = (rawJoin === '' || rawJoin === undefined || rawJoin === null) ? '' : String(rawJoin).trim();
          // Phone: Excel often hands back a plain number (9876543210), which
          // String() turns into the right digits. Accepts several common headers.
          const phoneHeaders = ['Parent WhatsApp Number','Parent WhatsApp','WhatsApp Number','WhatsApp','Parent Phone','Parent Mobile','Phone Number','Phone','Mobile Number','Mobile','Contact','Contact Number'];
          let phoneRaw = '';
          for(const h of phoneHeaders){
            const v = r[h] !== undefined ? r[h] : r[h.toLowerCase()];
            if(v !== undefined && v !== ''){ phoneRaw = String(v).trim(); break; }
          }
          if(profession){
            return {
              name,
              type: (r['Type'] || r['type'] || r['Profession'] || r['profession'] || '').toString().trim(),
              detail: (r['Detail'] || r['detail'] || r['Designation'] || r['designation'] || '').toString().trim(),
              joiningDateRaw: rawJoinDisplay,
              joiningDate: parseDate(rawJoin),
              joinedVia: (r['Joined Via'] || r['joined via'] || r['JoinedVia']
                        || r['VBS/VYS'] || r['VBS / VYS'] || r['vbs/vys'] || '').toString().trim(),
              phoneRaw
            };
          }
          return {
            name,
            class: (r['Class'] || r['class'] || '').toString().trim(),
            joiningDateRaw: rawJoinDisplay,
            joiningDate: parseDate(rawJoin),
            phoneRaw
          };
        });
      }
 
      // Validate rows
      const validStudents = [];
      const previewRows = [];
      const errors = [];
 
      if(profession){
        // "Joined Via" mirrors the single-add modal's origin dropdown (see
        // openAddStudentModal / add-origin-group) — it only affects which
        // id prefix/counter the student draws from (R53VYS vs R53VBS), it's
        // never stored on the student record itself. Blank/unrecognized
        // values default to "Directly", matching the modal's own default.
        // Also accepts "VBS"/"VYS" directly, matching a real-world sheet
        // column literally named "VBS/VYS" whose values are those two
        // letters — VBS = grew up through Balaka Sangha, VYS = joined
        // Yuvaka Sangha directly.
        const parseJoinedVia = (raw) => {
          const v = (raw||'').trim().toLowerCase();
          if(!v) return { origin: 'yuvaka', label: 'Directly' };
          if(v==='vbs' || v==='balaka' || v==='via vbs' || v==='balaka sangha' || v.startsWith('grew up')) {
            return { origin: 'balaka', label: 'Via VBS' };
          }
          if(v==='direct' || v==='directly' || v==='yuvaka' || v==='vys' || v==='new') {
            return { origin: 'yuvaka', label: 'Directly' };
          }
          return { origin: null, label: raw }; // unrecognized — flagged below
        };
        rows.forEach((r, i) => {
          const rowNum = i + 2;
          const name = r.name;
          const rawType = (r.type||'').trim().toLowerCase();
          // Accepts the template's own wording (Profession/Education) AND
          // a real-world sheet's "Profession" column whose actual VALUES
          // are "Student"/"Working" rather than the header word itself.
          const type = (rawType==='profession' || rawType==='working') ? 'Profession'
                     : (rawType==='education' || rawType==='student') ? 'Education'
                     : '';
          const detail = r.detail;
          // '' (blank cell) defaults to today; null means a date WAS given
          // but couldn't be understood — that must be a hard error, never
          // a silent substitution (see parseDate's comment above).
          const joining = r.joiningDate === null ? r.joiningDateRaw : (r.joiningDate || fmtDate(new Date()));
          const joinedVia = parseJoinedVia(r.joinedVia);
          const phone = normalizePhone(r.phoneRaw); // '' = none given, null = invalid
 
          let status = '✅ Valid';
          let valid = true;
 
          if (!name) { status = '❌ Missing name'; valid = false; errors.push(`Row ${rowNum}: Missing name`); }
          else if (!type) { status = '⚠️ Type must be Profession or Education'; valid = false; errors.push(`Row ${rowNum}: Invalid type "${r.type}"`); }
          else if (!detail) { status = '⚠️ Detail is required'; valid = false; errors.push(`Row ${rowNum}: Missing detail`); }
          else if (r.joiningDate === null) { status = '⚠️ Could not understand Joining Date "'+r.joiningDateRaw+'" (use DD-MM-YYYY, or just a 4-digit year like 2015 if the exact date isn\'t known)'; valid = false; errors.push(`Row ${rowNum}: Invalid Joining Date "${r.joiningDateRaw}" — use DD-MM-YYYY, or a bare year like 2015`); }
          else if (joinedVia.origin === null) { status = '⚠️ Joined Via must be Directly or VBS'; valid = false; errors.push(`Row ${rowNum}: Invalid "Joined Via" value "${r.joinedVia}"`); }
          else if (phone === null) { status = '⚠️ Invalid WhatsApp number "'+r.phoneRaw+'"'; valid = false; errors.push(`Row ${rowNum}: Invalid WhatsApp number "${r.phoneRaw}" — use 10 digits or include the country code`); }
 
          previewRows.push({ name, secondary: valid ? type+': '+detail : (r.type||'—'), joining, origin: joinedVia.label, phone: phone ? formatPhone(phone) : (phone === null ? r.phoneRaw : ''), status, valid });
          if (valid) {
            const sObj = { name, profession: { type, detail }, joiningDate: joining, originOverride: joinedVia.origin };
            if (phone) sObj.parentPhone = phone;
            validStudents.push(sObj);
          }
        });
      } else {
        const today = fmtDate(new Date());
        rows.forEach((r, i) => {
          const rowNum = i + 2;
          const name = r.name;
          const cls = r.class.replace('Class ', '').replace('class ', '').trim();
          const clsNum = parseInt(cls);
          const joining = r.joiningDate === null ? r.joiningDateRaw : (r.joiningDate || today);
          const validRange = CLASS_RANGES[schoolLevelForKey(key)] || [4,5,6,7,8,9,10];
          const phone = normalizePhone(r.phoneRaw); // '' = none given, null = invalid
 
          let status = '✅ Valid';
          let valid = true;
 
          if (!name) { status = '❌ Missing name'; valid = false; errors.push(`Row ${rowNum}: Missing name`); }
          else if (isNaN(clsNum) || !validRange.includes(clsNum)) {
            status = `⚠️ Class must be ${validRange[0]}-${validRange[validRange.length-1]}`; valid = false;
            errors.push(`Row ${rowNum}: Invalid class "${cls}" for this section (must be ${validRange[0]}-${validRange[validRange.length-1]})`);
          }
          else if (r.joiningDate === null) { status = '⚠️ Could not understand Joining Date "'+r.joiningDateRaw+'" (use DD-MM-YYYY)'; valid = false; errors.push(`Row ${rowNum}: Invalid Joining Date "${r.joiningDateRaw}" — use DD-MM-YYYY`); }
 
          else if (phone === null) { status = '⚠️ Invalid WhatsApp number "'+r.phoneRaw+'"'; valid = false; errors.push(`Row ${rowNum}: Invalid WhatsApp number "${r.phoneRaw}" — use 10 digits or include the country code`); }
 
          previewRows.push({ name, secondary: cls ? 'Class '+cls : '—', joining, phone: phone ? formatPhone(phone) : (phone === null ? r.phoneRaw : ''), status, valid });
          if (valid) {
            const sObj = { name, class: String(clsNum), joiningDate: joining };
            if (phone) sObj.parentPhone = phone;
            validStudents.push(sObj);
          }
        });
      }
 
      // Show preview
      bulkImportContext.students = validStudents;
      const tbody = document.getElementById('bulk-preview-body');
      tbody.innerHTML = previewRows.map((r, i) => `
        <tr style="background:${r.valid ? 'transparent' : 'var(--red-light)'}">
          <td style="padding:6px 8px;border-bottom:1px solid var(--border);color:var(--text)">${i+1}</td>
          <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-weight:500;color:var(--text)">${escapeHtml(r.name)||'—'}</td>
          <td style="padding:6px 8px;border-bottom:1px solid var(--border);color:var(--text2)">${escapeHtml(r.secondary)||'—'}</td>
          <td style="padding:6px 8px;border-bottom:1px solid var(--border);color:var(--text2)">${escapeHtml(r.joining)||'—'}</td>
          ${profession ? `<td style="padding:6px 8px;border-bottom:1px solid var(--border);color:var(--text2)">${escapeHtml(r.origin)||'—'}</td>` : ''}
          <td style="padding:6px 8px;border-bottom:1px solid var(--border);color:var(--text2);white-space:nowrap">${escapeHtml(r.phone)||'—'}</td>
          <td style="padding:6px 8px;border-bottom:1px solid var(--border)">${r.status}</td>
        </tr>
      `).join('');
 
      document.getElementById('bulk-count').textContent = validStudents.length + ' valid';
      document.getElementById('bulk-errors').textContent = errors.length ? errors.join(' | ') : '';
      document.getElementById('bulk-preview').style.display = 'block';
      document.getElementById('bulk-confirm-btn').style.display = validStudents.length > 0 ? 'inline-block' : 'none';
      document.getElementById('bulk-status').textContent = 
        `Found ${previewRows.length} rows — ${validStudents.length} valid, ${previewRows.length - validStudents.length} skipped.`;
 
    } catch(err) {
      document.getElementById('bulk-status').textContent = '❌ Error reading file: ' + err.message;
    }
  };
 
  if (file.name.endsWith('.csv')) {
    reader.readAsText(file);
  } else {
    reader.readAsArrayBuffer(file);
  }
}
 
async function confirmBulkImport() {
  const key = bulkImportContext.key;
  const newStudents = bulkImportContext.students;
  if (!key || !newStudents.length) return;
 
  // Check for duplicate names against existing students in ALL sections
  const existingNames = new Set();
  Object.keys(students).forEach(sec => {
    students[sec].forEach(s => {
      existingNames.add((typeof s === 'object' ? s.name : s).trim().toLowerCase());
    });
  });
  const duplicates = newStudents.filter(s => existingNames.has(s.name.trim().toLowerCase()));
  if(duplicates.length > 0){
    document.getElementById('bulk-status').textContent =
      `❌ Duplicate names found: ${duplicates.map(s=>s.name).join(', ')}. Remove them from the file and re-upload.`;
    return;
  }
 
  document.getElementById('bulk-confirm-btn').disabled = true;
  document.getElementById('bulk-status').textContent = `Importing ${newStudents.length} students...`;
  setSyncStatus('syncing', 'Bulk importing...');
 
  try {
    // Records are now keyed by permanent id, not array position, so a
    // freshly-imported student can never inherit another (removed)
    // student's leftover records just by landing at the same array index —
    // each one gets its own brand-new id below.
    for(const s of newStudents){
      // originOverride (set per-row from the "Joined Via" column for Yuvaka
      // Sangha imports) picks the id prefix/counter exactly like the single
      // -add modal's origin dropdown does — see confirmAddStudent. It's
      // transient: used only to pick the prefix, then discarded so it never
      // ends up stored on the student record itself.
      s.id = await generateStudentId(s.joiningDate, s.originOverride || programFor(key));
      delete s.originOverride;
      students[key].push(s);
    }
 
    await saveRosterChange({ sections: [key] });
    renderSection(key);
    closeBulkImport();
    showToast('✅ Imported ' + newStudents.length + ' students!');
    setSyncStatus('synced', 'Import complete');
    setTimeout(()=>{const t=document.querySelector('table');if(t)t.scrollIntoView({behavior:'smooth',block:'start'});},400);
 
  } catch(e) {
    document.getElementById('bulk-status').textContent = '❌ Import failed: ' + e.message;
    document.getElementById('bulk-confirm-btn').disabled = false;
    setSyncStatus('error', 'Import failed');
  }
}
 