// ===================== BULK IMPORT =====================
let bulkImportContext = { key: null, students: [] };

function openBulkImport(key) {
  bulkImportContext = { key, students: [] };
  const profession = isProfessionSection(key);
  document.getElementById('bulk-import-title').textContent = profession ? '📥 Bulk Import Volunteers' : '📥 Bulk Import Students';
  document.getElementById('bulk-columns-hint').textContent = profession
    ? 'Columns: Name, Type (Profession/Education), Detail, Joining Date, Joined Via (Directly / VBS — optional, defaults to Directly)'
    : 'Columns: Name, Class, Joining Date';
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
      ['Name', 'Type', 'Detail', 'Joining Date', 'Joined Via'],
      ['Ramesh Rao', 'Profession', 'Software Engineer', '22-06-2026', 'Directly'],
      ['Anjali Bhat', 'Education', 'B.Com 2nd Year', '22-06-2026', 'VBS'],
    ]);
    ws['!cols'] = [{wch:25},{wch:12},{wch:22},{wch:15},{wch:12}];
    XLSX.utils.book_append_sheet(wb, ws, 'Volunteers');
    XLSX.writeFile(wb, 'YuvakaSangha_Volunteer_Template.xlsx');
  } else {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Name', 'Class', 'Joining Date'],
      ['Ravi Kumar', '7', '22-06-2026'],
      ['Priya Sharma', '8', '22-06-2026'],
      ['Arjun Naik', '5', '22-06-2026'],
    ]);
    ws['!cols'] = [{wch:25},{wch:10},{wch:15}];
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
      const parseDate = (raw) => {
        raw = (raw||'').toString().trim();
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
            return { name: vals[0]||'', type: vals[1]||'', detail: vals[2]||'', joiningDateRaw: (vals[3]||'').trim(), joiningDate: parseDate(vals[3]), joinedVia: vals[4]||'' };
          }
          return { name: vals[0]||'', class: vals[1]||'', joiningDateRaw: (vals[2]||'').trim(), joiningDate: parseDate(vals[2]) };
        });
      } else {
        // Parse Excel
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: 'array', cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(ws, { raw: false });
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
          const rawJoin = (r['Joining Date'] || r['joining date'] || r['JoiningDate']
                         || r['Date Of Joining'] || r['Date of Joining'] || r['date of joining']
                         || '').toString().trim();
          if(profession){
            return {
              name,
              type: (r['Type'] || r['type'] || r['Profession'] || r['profession'] || '').toString().trim(),
              detail: (r['Detail'] || r['detail'] || r['Designation'] || r['designation'] || '').toString().trim(),
              joiningDateRaw: rawJoin,
              joiningDate: parseDate(rawJoin),
              joinedVia: (r['Joined Via'] || r['joined via'] || r['JoinedVia']
                        || r['VBS/VYS'] || r['VBS / VYS'] || r['vbs/vys'] || '').toString().trim()
            };
          }
          return {
            name,
            class: (r['Class'] || r['class'] || '').toString().trim(),
            joiningDateRaw: rawJoin,
            joiningDate: parseDate(rawJoin)
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

          let status = '✅ Valid';
          let valid = true;

          if (!name) { status = '❌ Missing name'; valid = false; errors.push(`Row ${rowNum}: Missing name`); }
          else if (!type) { status = '⚠️ Type must be Profession or Education'; valid = false; errors.push(`Row ${rowNum}: Invalid type "${r.type}"`); }
          else if (!detail) { status = '⚠️ Detail is required'; valid = false; errors.push(`Row ${rowNum}: Missing detail`); }
          else if (r.joiningDate === null) { status = '⚠️ Could not understand Joining Date "'+r.joiningDateRaw+'" (use DD-MM-YYYY)'; valid = false; errors.push(`Row ${rowNum}: Invalid Joining Date "${r.joiningDateRaw}" — use DD-MM-YYYY`); }
          else if (joinedVia.origin === null) { status = '⚠️ Joined Via must be Directly or VBS'; valid = false; errors.push(`Row ${rowNum}: Invalid "Joined Via" value "${r.joinedVia}"`); }

          previewRows.push({ name, secondary: valid ? type+': '+detail : (r.type||'—'), joining, origin: joinedVia.label, status, valid });
          if (valid) validStudents.push({ name, profession: { type, detail }, joiningDate: joining, originOverride: joinedVia.origin });
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

          let status = '✅ Valid';
          let valid = true;

          if (!name) { status = '❌ Missing name'; valid = false; errors.push(`Row ${rowNum}: Missing name`); }
          else if (isNaN(clsNum) || !validRange.includes(clsNum)) {
            status = `⚠️ Class must be ${validRange[0]}-${validRange[validRange.length-1]}`; valid = false;
            errors.push(`Row ${rowNum}: Invalid class "${cls}" for this section (must be ${validRange[0]}-${validRange[validRange.length-1]})`);
          }
          else if (r.joiningDate === null) { status = '⚠️ Could not understand Joining Date "'+r.joiningDateRaw+'" (use DD-MM-YYYY)'; valid = false; errors.push(`Row ${rowNum}: Invalid Joining Date "${r.joiningDateRaw}" — use DD-MM-YYYY`); }

          previewRows.push({ name, secondary: cls ? 'Class '+cls : '—', joining, status, valid });
          if (valid) validStudents.push({ name, class: String(clsNum), joiningDate: joining });
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
