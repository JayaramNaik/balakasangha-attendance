# API Reference - Balakasangha Enhanced Attendance Tracker

## Table of Contents
1. [Authentication Functions](#authentication-functions)
2. [Data Management Functions](#data-management-functions)
3. [UI/Display Functions](#uidisplay-functions)
4. [Export Functions](#export-functions)
5. [State Management](#state-management)
6. [Firebase Integration](#firebase-integration)

---

## Authentication Functions

### `signIn()`
Signs in a user with email and password.

**Parameters:** None (reads from DOM)
- `auth-email` input value
- `auth-password` input value
- `currentUserRole` global state

**Returns:** void (async)

**Firebase Method:** `auth.signInWithEmailAndPassword(email, password)`

**Behavior:**
1. Validates email and password
2. Sets sync status to "syncing"
3. Calls Firebase auth
4. On success: loads user role, shows app
5. On error: shows error message

**Example:**
```javascript
// User fills email/password, clicks sign in
signIn();
// → Firebase authenticates
// → User role loaded
// → Main app displayed
```

---

### `registerUser()`
Registers a new user account.

**Parameters:** None (reads from DOM)
- `register-name` input value
- `register-email` input value
- `register-password` input value

**Returns:** void (async)

**Validations:**
- All fields required
- Password minimum 6 characters
- Email format validation

**Behavior:**
1. Validates input fields
2. Calls `auth.createUserWithEmailAndPassword()`
3. Creates user document in Firestore
4. Saves: name, email, role, createdAt
5. Shows success message
6. Returns to login screen

**Example:**
```javascript
// New volunteer registration
registerUser();
// → Creates Firebase auth user
// → Saves profile to Firestore
// → Returns to login
```

---

### `signOutUser()`
Signs out the current user.

**Parameters:** None

**Returns:** void (async)

**Behavior:**
1. Calls `auth.signOut()`
2. Returns to login screen
3. Sets sync status to "Signed out"

**Example:**
```javascript
// Admin clicks Sign Out
signOutUser();
// → User logged out
// → Login screen shown
```

---

### `loadUserRole(user)`
Loads and assigns user's role from Firestore.

**Parameters:**
- `user` (Firebase User object)

**Returns:** void (async)

**Behavior:**
1. Queries `attendance/admins` document
2. Checks if user UID in admin list
3. Sets `currentUserRole` to "admin" or "volunteer"
4. Sets `currentUserName` from email

**Side Effects:**
- Sets global `currentUserRole`
- Sets global `currentUserName`

**Example:**
```javascript
loadUserRole(firebaseUser);
// → Checks if admin
// → Sets role in state
```

---

### `selectRole(role)`
Selects user role during login.

**Parameters:**
- `role` (string): "admin" or "volunteer"

**Returns:** void

**Behavior:**
1. Sets `currentUserRole` global variable
2. Updates UI button states (active/inactive)
3. Visual feedback for user

---

### `showLoginMode()`
Switches UI from register to login screen.

**Parameters:** None

**Returns:** void

**Behavior:**
1. Hides register screen
2. Shows login screen
3. Clears form data

---

### `showRegisterMode()`
Switches UI from login to register screen.

**Parameters:** None

**Returns:** void

**Behavior:**
1. Hides login screen
2. Shows register screen
3. Clears form data

---

## Data Management Functions

### `getRecord(k, d, i)`
Retrieves attendance record for a student.

**Parameters:**
- `k` (string): Section key (e.g., "old-middle")
- `d` (string): Date in YYYY-MM-DD format
- `i` (number): Student index

**Returns:** string | null
- "P" = Present
- "A" = Absent
- null = Not marked

**Example:**
```javascript
const status = getRecord("old-middle", "2024-01-15", 0);
// → "P" (student 0 was present)
```

---

### `setRecord(k, d, i, v)`
Sets attendance record for a student.

**Parameters:**
- `k` (string): Section key
- `d` (string): Date (YYYY-MM-DD)
- `i` (number): Student index
- `v` (string | null): "P", "A", or null

**Returns:** void

**Behavior:**
1. If value is null, deletes record
2. Otherwise stores value
3. Updates internal records object
4. Does NOT save to Firebase (use `saveState()`)

**Example:**
```javascript
setRecord("old-middle", "2024-01-15", 0, "P");
// → Student marked present locally
saveState(); // Then sync to Firebase
```

---

### `getLeaveStatus(k, d, i)`
Gets leave letter status for absent student.

**Parameters:**
- `k` (string): Section key
- `d` (string): Date (YYYY-MM-DD)
- `i` (number): Student index

**Returns:** boolean

**Example:**
```javascript
if (getLeaveStatus("old-middle", "2024-01-15", 0)) {
  // Student was absent with leave letter
}
```

---

### `setLeaveStatus(k, d, i, v)`
Sets leave letter status.

**Parameters:**
- `k` (string): Section key
- `d` (string): Date (YYYY-MM-DD)
- `i` (number): Student index
- `v` (boolean): true/false

**Returns:** void

---

### `getAttendanceTracker(k, d, i)`
Gets metadata about who marked attendance.

**Parameters:**
- `k` (string): Section key
- `d` (string): Date (YYYY-MM-DD)
- `i` (number): Student index

**Returns:** object
```javascript
{
  name: "john_doe",
  time: "14:30:45",
  date: "2024-01-15"
}
```

---

### `setAttendanceTracker(k, d, i, name, time, date)`
Records who marked attendance.

**Parameters:**
- `k` (string): Section key
- `d` (string): Date (YYYY-MM-DD)
- `i` (number): Student index
- `name` (string): Marking person's name
- `time` (string): Time in HH:MM:SS
- `date` (string): Marking date

**Returns:** void

**Called Automatically:**
When `mark()` function is called

---

### `mark(key, idx, type, el)`
Marks a single student attendance.

**Parameters:**
- `key` (string): Section key
- `idx` (number): Student index
- `type` (string): "P" or "A"
- `el` (HTMLElement): Checkbox element

**Returns:** void (async)

**Behavior:**
1. Sets record to "P" or "A"
2. Automatically records metadata
3. Unchecks opposite checkbox
4. Re-renders section
5. Saves to Firebase

**Example:**
```javascript
// Called from checkbox onchange
mark("old-middle", 0, "P", checkboxElement);
// → Marks student present
// → Records who & when
// → Updates display
// → Syncs to Firebase
```

---

### `markAll(key, type)`
Marks entire section Present or Absent.

**Parameters:**
- `key` (string): Section key
- `type` (string): "P" or "A"

**Returns:** void (async)

**Behavior:**
1. Marks all students in section
2. Records metadata for each
3. Shows success toast
4. Saves to Firebase

**Example:**
```javascript
// Admin clicks "All present"
markAll("old-middle", "P");
// → All students marked present
// → Metadata recorded
// → Saved to Firebase
```

---

### `addStudent(key)`
Adds new student to section.

**Parameters:**
- `key` (string): Section key

**Returns:** void (async)

**Requirements:**
- User must be admin
- Uses modal dialog for input

**Behavior:**
1. Opens modal dialog
2. Collects: name, class, joining date
3. Validates input
4. Adds to students array
5. Saves to Firebase
6. Re-renders table

---

### `removeStudent(key, idx)`
Removes student from section.

**Parameters:**
- `key` (string): Section key
- `idx` (number): Student index

**Returns:** void (async)

**Requirements:**
- User must be admin
- Shows confirmation dialog

**Behavior:**
1. Confirms deletion
2. Removes from students array
3. Updates all record indices
4. Saves to Firebase
5. Re-renders table

---

### `getStats(key, idx)`
Calculates attendance statistics for a student.

**Parameters:**
- `key` (string): Section key
- `idx` (number): Student index

**Returns:** object
```javascript
{
  present: 5,        // Times marked present
  total: 8,          // Total sessions
  pct: 63,           // Percentage
  streak: 2,         // Consecutive present
  mPresent: 2,       // Present this month
  mTotal: 4          // Sessions this month
}
```

---

### `todayStats(key)`
Calculates section statistics for current date.

**Parameters:**
- `key` (string): Section key

**Returns:** object
```javascript
{
  present: 15,    // Students marked present
  absent: 3,      // Students marked absent
  unmarked: 2,    // Students not marked
  total: 20       // Total students
}
```

---

## UI/Display Functions

### `renderSection(key)`
Renders attendance table for a section.

**Parameters:**
- `key` (string): Section key

**Returns:** void

**Renders:**
- Summary metrics
- Search/filter controls
- Add student button (admin only)
- Attendance table
- Leave letter rows (when absent)

**Permissions:**
- Admin: see all buttons
- Volunteer: limited view

---

### `renderAnalytics()`
Renders analytics dashboard.

**Parameters:** None

**Returns:** void

**Renders:**
- Current session pie charts
- Monthly trend bar charts
- All sections comparison
- Export button (admin only)

**Permissions:**
- Admin: full analytics
- Volunteer: "Restricted Access" message

---

### `renderCurrent()`
Renders current view (attendance or analytics).

**Parameters:** None

**Returns:** void

**Behavior:**
1. Checks `curView` global
2. Calls appropriate render function
3. Updates display

---

### `buildSundayBtns()`
Builds Sunday selector buttons.

**Parameters:** None

**Returns:** void

**Behavior:**
1. Gets all Sundays in current month
2. Creates clickable buttons
3. Marks today's date
4. Sets first Sunday as default

---

### `openAddStudentModal(key)`
Opens modal dialog to add student.

**Parameters:**
- `key` (string): Section key

**Returns:** void

---

### `closeAddStudentModal()`
Closes add student modal.

**Parameters:** None

**Returns:** void

---

### `filterTable(key)`
Filters attendance table by search/status.

**Parameters:**
- `key` (string): Section key

**Returns:** void

**Filters:**
- Student name (search)
- Attendance status (Present/Absent/Unmarked)

---

### `showToast(msg)`
Shows temporary notification message.

**Parameters:**
- `msg` (string): Message to display

**Returns:** void

**Behavior:**
1. Shows message at bottom-right
2. Auto-hides after 2.2 seconds

---

### `showError(msg, elementId)`
Shows error message.

**Parameters:**
- `msg` (string): Error message
- `elementId` (string): Target element ID

**Returns:** void

**Behavior:**
1. Shows error with red styling
2. Auto-hides after 4 seconds

---

## Export Functions

### `exportExcel(key)`
Exports section attendance to Excel file.

**Parameters:**
- `key` (string): Section key

**Returns:** void

**Requirements:**
- User must be admin
- Uses XLSX library

**Includes:**
- Student name, class, joining date
- All Sundays with P/A/Leave status
- Attendance statistics
- Streaks and percentages

**Permissions:**
- Admin: can export
- Volunteer: shows error

---

### `exportAllExcel()`
Exports all sections to single Excel file.

**Parameters:** None

**Returns:** void

**Requirements:**
- User must be admin

**Creates:**
- One sheet per section
- All attendance data
- Comprehensive statistics

**Permissions:**
- Admin: can export
- Volunteer: shows error

---

## State Management

### Global Variables

```javascript
// Data
let students = {
  'old-middle': [],
  'old-high': [],
  'new-middle': [],
  'new-high': []
};
let records = {};  // Attendance records

// UI State
let curMonth = 0;        // Current month (0-11)
let curYear = 2024;      // Current year
let curDate = null;      // Selected Sunday (YYYY-MM-DD)
let curView = 'attendance'; // Current tab
let curType = 'old';     // Old/New students
let curSchool = {        // Current section per type
  old: 'old-middle',
  new: 'new-middle'
};

// User/Auth
let currentUser = null;           // Firebase user object
let currentUserRole = 'volunteer'; // 'admin' or 'volunteer'
let currentUserName = '';          // User's display name
```

---

### `loadState()`
Loads state from Firebase or local storage.

**Parameters:** None

**Returns:** void (async)

**Behavior:**
1. Tries to load from Firestore
2. Falls back to localStorage
3. Updates global state
4. Sets sync status

---

### `saveState()`
Saves state to Firebase.

**Parameters:** None

**Returns:** void (async)

**Behavior:**
1. Sets sync status to "syncing"
2. Uploads to Firestore
3. Falls back to localStorage
4. Updates sync status

---

### `persistLocal()`
Manually saves state to local storage.

**Parameters:** None

**Returns:** void

---

## Firebase Integration

### Firebase Configuration

```javascript
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAGpZNwnekU2BEpEbmIHmsMWYBI2fI7KcE",
  authDomain: "balakasangha-attendance.firebaseapp.com",
  projectId: "balakasangha-attendance",
  storageBucket: "balakasangha-attendance.appspot.com",
  messagingSenderId: "814303496942",
  appId: "1:814303496942:web:5cf712e73513480f5b81ff"
};
```

---

### Firestore Collections

#### `attendance/state`
Main state document.

**Fields:**
```javascript
{
  students: {
    'old-middle': [...],
    'old-high': [...],
    'new-middle': [...],
    'new-high': [...]
  },
  records: {
    'key|date|index': 'P' | 'A',
    'key|date|index|leave': true,
    'key|date|index|tracker': {...}
  }
}
```

---

#### `attendance/admins`
List of admin user IDs.

**Fields:**
```javascript
{
  list: ["uid1", "uid2", ...]
}
```

---

#### `users/{uid}`
User profile documents.

**Fields:**
```javascript
{
  name: "John Doe",
  email: "john@example.com",
  role: "admin" | "volunteer",
  createdAt: Timestamp
}
```

---

### Real-Time Listeners

```javascript
// Automatically syncs state when updated
stateDoc.onSnapshot(snapshot => {
  // Update global state
  // Re-render UI
  // Set sync status
});

// Detects auth changes
auth.onAuthStateChanged(user => {
  if (user) {
    // Load user role
    // Show app
  } else {
    // Show login
  }
});
```

---

## Helper Functions

### `getSundays(year, month)`
Gets all Sundays in a month.

**Parameters:**
- `year` (number): Year
- `month` (number): Month (0-11)

**Returns:** array of Date objects

---

### `fmtDate(date)`
Formats date as YYYY-MM-DD.

**Parameters:**
- `date` (Date object)

**Returns:** string

---

### `fmtShort(dateStr)`
Formats YYYY-MM-DD to "D MMM" (e.g., "15 Jan").

**Parameters:**
- `dateStr` (string): YYYY-MM-DD

**Returns:** string

---

### `fmtFull(dateStr)`
Formats to full date string (e.g., "Monday, 15 January 2024").

**Parameters:**
- `dateStr` (string): YYYY-MM-DD

**Returns:** string

---

### `getCurrentTime()`
Gets current time as HH:MM:SS.

**Parameters:** None

**Returns:** string

---

### `barColor(percentage)`
Gets color based on attendance percentage.

**Parameters:**
- `percentage` (number): 0-100

**Returns:** string (hex color)
- Green (#1D9E75) if ≥75%
- Amber (#EF9F27) if ≥50%
- Red (#D85A30) if <50%

---

### `pillClass(percentage)`
Gets CSS class for attendance pill.

**Parameters:**
- `percentage` (number | null): Attendance percentage

**Returns:** string (CSS class)
- "pill-green" if ≥75%
- "pill-amber" if ≥50%
- "pill-red" if <50%
- "pill-gray" if null

---

## Event Handlers

### Form Events
```javascript
// Login form
document.getElementById('sign-in-btn').addEventListener('click', signIn);

// Register form
document.getElementById('register-btn').addEventListener('click', registerUser);

// Attendance marking
input.addEventListener('change', (e) => mark(key, idx, type, e.target));

// Month/year change
document.getElementById('month-sel').addEventListener('change', onMonthChange);
```

### Navigation Events
```javascript
// Tab switching
document.querySelectorAll('.main-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    // Switch view
    // Update curView
    // Re-render
  });
});
```

---

## Data Flow Diagram

```
User Input
    ↓
Event Handler (e.g., mark())
    ↓
Update Global State
    ↓
Update Firebase
    ↓
Real-time Listener
    ↓
Re-render UI
    ↓
User sees update
    ↑ (synced across devices)
```

---

## Error Handling

### Firebase Errors
```javascript
auth.signInWithEmailAndPassword(email, password)
  .catch(e => {
    setSyncStatus('error', 'Sign in failed');
    showError(e.message);
  });
```

### Validation Errors
```javascript
if (!email || !password) {
  showError('Enter email and password');
  return;
}
```

### Fallback Handling
```javascript
try {
  // Try Firebase
  await loadState();
} catch (e) {
  // Fall back to localStorage
  const stored = localStorage.getItem('balaka_students');
  if (stored) {
    // Use local data
  }
}
```

---

## Performance Considerations

### Optimization Techniques
1. **Chart destruction**: `destroyChart()` before recreation
2. **Efficient filtering**: Uses data attributes for quick lookup
3. **Lazy rendering**: Only render visible sections
4. **Local caching**: localStorage for offline support
5. **Real-time sync**: Firebase listeners only for current user

### Limits
- Max records per month: ~500 (before performance impact)
- Max students per section: ~200
- Recommended: 4 sections × 50 students each

---

## Testing Tips

### Unit Tests
```javascript
// Test getStats
const stats = getStats('old-middle', 0);
console.assert(stats.present >= 0);
console.assert(stats.total >= stats.present);
console.assert(stats.pct <= 100);
```

### Integration Tests
```javascript
// Test mark → render flow
mark('old-middle', 0, 'P', element);
// Check attendance reflects in UI
// Check Firebase updated
```

### Manual Testing
- [ ] Login flows
- [ ] Role restrictions
- [ ] Attendance marking
- [ ] Leave letter tracking
- [ ] Excel exports
- [ ] Analytics rendering
- [ ] Cross-device sync
- [ ] Offline functionality

---

## Migration Guide

### Migrating from v1.0 to v2.0

```javascript
// Old student format
"John Doe"

// New student format
{
  name: "John Doe",
  class: "9",
  joiningDate: "2024-01-01"
}

// Migration code (auto-handled)
students[key] = students[key].map(s =>
  typeof s === 'string'
    ? { name: s, class: '', joiningDate: '' }
    : s
);
```

---

## Future API Enhancements

### Proposed Additions
- `getStudentById(uid)` - Direct lookup
- `getMonthlyReport(month, year)` - Comprehensive report
- `bulkImport(data)` - Import from CSV
- `getNotifications()` - Admin alerts
- `setSyncInterval(ms)` - Customize sync frequency

---

## Support & Examples

### Example: Get Student's Attendance for Month
```javascript
const month = 0; // January
const year = 2024;
const key = 'old-middle';
const studentIdx = 0;

const stats = getStats(key, studentIdx);
console.log(`${stats.present}/${stats.total} sessions attended`);
console.log(`Attendance: ${stats.pct}%`);
```

### Example: Export Current Section
```javascript
const key = document.querySelector('.school-tab.active').dataset.key;
exportExcel(key);
// → Triggers file download
```

### Example: Add Custom Sync Handler
```javascript
stateDoc.onSnapshot(snapshot => {
  // Custom logic here
  customAlert('Data updated!');
});
```

---

**Last Updated:** January 2024  
**API Version:** 2.0  
**Status:** Stable ✅
