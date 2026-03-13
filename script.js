/**
 * Study Vault — script.js
 * - Metadata (subjects, notes, videos, flashcards) → localStorage
 * - PDF file blobs → IndexedDB  (survives refresh, no 5MB cap)
 */

// ==================== STATE ====================
let state = {
  subjects: [],
  activeSubject: null,
  activeFilter: 'all',
  searchQuery: '',
  planner: [],
  streak: { lastDate: null, count: 0 },
  studyStats: { cardsStudiedToday: 0, lastStudyDate: null }
};

let editingNoteId    = null;
let practiceCards    = [], practiceIndex = 0, practiceFlipped = false;
let practiceScores   = { easy: 0, medium: 0, hard: 0 };
let activeResourceType = 'pdf';

// ==================== INDEXEDDB ====================
let db = null;
const DB_NAME = 'StudyVaultDB', DB_VER = 1, STORE = 'pdfFiles';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = e => { db = e.target.result; resolve(db); };
    req.onerror   = e => reject(e.target.error);
  });
}

function dbSave(id, blob) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ id, blob });
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
}

function dbGet(id) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = e => resolve(e.target.result ? e.target.result.blob : null);
    req.onerror   = e => reject(e.target.error);
  });
}

function dbDelete(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
}

// ==================== LOCALSTORAGE (metadata only, no blobs) ====================
function saveState() {
  const toSave = {
    subjects: state.subjects.map(s => ({
      ...s,
      pdfs: s.pdfs.map(({ blobUrl, ...rest }) => rest) // never store ephemeral blobUrl
    })),
    activeSubject: state.activeSubject,
    planner:       state.planner,
    streak:        state.streak,
    studyStats:    state.studyStats
  };
  try {
    localStorage.setItem('studyVault_v3', JSON.stringify(toSave));
  } catch (e) {
    showToast('Storage full — delete some resources', 'error');
  }
}

function loadState() {
  const raw = localStorage.getItem('studyVault_v3') || localStorage.getItem('studyVault_v2');
  if (raw) {
    try {
      const saved = JSON.parse(raw);
      // Purge any old base64 data that may have been stored previously
      if (saved.subjects) {
        saved.subjects.forEach(s => {
          s.pdfs = (s.pdfs || []).map(p => {
            if (p.url && p.url.startsWith('data:')) {
              return { id: p.id, title: p.title, desc: p.desc, isLocal: true, needsReupload: true };
            }
            return p;
          });
        });
      }
      Object.assign(state, saved);
      saveState(); // write clean copy immediately
      localStorage.removeItem('studyVault_v2');
    } catch (e) { console.error('loadState failed', e); }
  }
  applyTheme();
}

// ==================== INIT ====================
async function init() {
  try { await openDB(); } catch (e) { console.warn('IndexedDB unavailable', e); }
  loadState();
  updateStreak();
  renderSubjects();
  renderSidebarStats();
  if (state.activeSubject && getSubject(state.activeSubject)) {
    selectSubject(state.activeSubject, false);
  } else if (state.subjects.length > 0) {
    selectSubject(state.subjects[0].id, false);
  }
  setupEventListeners();
}

// ==================== STREAK ====================
function updateStreak() {
  const today     = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86400000).toDateString();
  if (state.streak.lastDate === today) return;
  state.streak.count = state.streak.lastDate === yesterday ? state.streak.count + 1 : 1;
  state.streak.lastDate = today;
  saveState();
}

// ==================== SUBJECTS RENDER ====================
function renderSubjects() {
  const list = document.getElementById('subjectList');
  list.innerHTML = '';
  if (!state.subjects.length) {
    list.innerHTML = `<p style="font-size:.78rem;color:var(--text-light);padding:16px 12px">No subjects yet — create one!</p>`;
    return;
  }
  state.subjects.forEach(sub => {
    const item = document.createElement('div');
    item.className = `subject-item ${state.activeSubject === sub.id ? 'active' : ''}`;
    item.innerHTML = `
      <span class="subject-emoji">${sub.emoji}</span>
      <span class="subject-label">${escapeHtml(sub.name)}</span>
      <div class="subject-actions">
        <button class="subject-action-btn" title="Rename" onclick="renameSubject('${sub.id}',event)">✏️</button>
        <button class="subject-action-btn" title="Delete"  onclick="deleteSubject('${sub.id}',event)">🗑️</button>
      </div>`;
    item.addEventListener('click', () => selectSubject(sub.id));
    list.appendChild(item);
  });
}

function renderSidebarStats() {
  const total = state.subjects.reduce((a, s) => a + countResources(s), 0);
  document.getElementById('statSubjects').textContent  = state.subjects.length;
  document.getElementById('statResources').textContent = total;
  document.getElementById('statStreak').textContent    = state.streak.count;
}

// ==================== SELECT SUBJECT ====================
function selectSubject(id, save = true) {
  state.activeSubject = id;
  if (save) saveState();
  const sub = getSubject(id);
  if (!sub) return;
  renderSubjects();
  document.getElementById('subjectTitle').textContent    = `${sub.emoji} ${sub.name} Vault`;
  document.getElementById('subjectSubtitle').textContent = `${countResources(sub)} resources`;
  document.getElementById('welcomeState').classList.add('hidden');
  document.getElementById('subjectContent').classList.remove('hidden');
  renderAllResources();
  updateAnalyticsBar();
  if (window.innerWidth <= 768) {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarOverlay')?.classList.remove('active');
  }
}

function getSubject(id)      { return state.subjects.find(s => s.id === id); }
function countResources(sub) { return sub.pdfs.length + sub.notes.length + sub.videos.length + sub.flashcards.length; }

// ==================== SUBJECT CRUD ====================
function addSubject() {
  const name  = document.getElementById('subjectNameInput').value.trim();
  const emoji = document.getElementById('subjectEmojiInput').value || '📚';
  if (!name) return showToast('Enter a subject name', 'error');
  const sub = { id: genId(), name, emoji, pdfs: [], notes: [], videos: [], flashcards: [], studySessions: [] };
  state.subjects.push(sub);
  saveState(); renderSubjects(); renderSidebarStats();
  closeModal('subjectModal');
  document.getElementById('subjectNameInput').value = '';
  selectSubject(sub.id);
  showToast(`"${name}" created!`);
}

function renameSubject(id, e) {
  e.stopPropagation();
  const sub = getSubject(id);
  const n   = prompt('Rename subject:', sub.name);
  if (!n?.trim()) return;
  sub.name = n.trim();
  saveState(); renderSubjects();
  if (state.activeSubject === id)
    document.getElementById('subjectTitle').textContent = `${sub.emoji} ${sub.name} Vault`;
  showToast('Renamed!');
}

function deleteSubject(id, e) {
  e.stopPropagation();
  const sub = getSubject(id);
  if (!confirm(`Delete "${sub.name}" and all its resources?`)) return;
  sub.pdfs.forEach(p => { if (p.isLocal && db) dbDelete(p.id).catch(() => {}); });
  state.subjects = state.subjects.filter(s => s.id !== id);
  if (state.activeSubject === id) {
    state.activeSubject = state.subjects[0]?.id || null;
    if (state.activeSubject) selectSubject(state.activeSubject, false);
    else {
      document.getElementById('welcomeState').classList.remove('hidden');
      document.getElementById('subjectContent').classList.add('hidden');
      document.getElementById('subjectTitle').textContent = 'Select a Subject';
    }
  }
  saveState(); renderSubjects(); renderSidebarStats();
  showToast('Subject deleted');
}

// ==================== ADD RESOURCE MODAL ====================
function openAddModal(type = 'pdf') {
  if (!state.activeSubject) return showToast('Select a subject first', 'error');
  activeResourceType = type;
  setResourceTab(type);
  openModal('resourceModal');
}

function setResourceTab(type) {
  activeResourceType = type;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.type === type));
  document.querySelectorAll('.resource-form').forEach(f => f.classList.add('hidden'));
  document.getElementById(`form${type[0].toUpperCase() + type.slice(1)}`).classList.remove('hidden');
}

// ==================== ADD RESOURCE (dispatcher) ====================
function addResource() {
  const sub = getSubject(state.activeSubject);
  if (!sub) return;

  if (activeResourceType === 'pdf') {
    savePdfResource(sub); // async — returns early
    return;
  }

  if (activeResourceType === 'note') {
    const title   = document.getElementById('noteTitle').value.trim();
    const content = document.getElementById('noteContent').value.trim();
    const tags    = document.getElementById('noteTags').value.split(',').map(t => t.trim()).filter(Boolean);
    if (!title || !content) return showToast('Enter title and content', 'error');
    sub.notes.push({ id: genId(), title, content, tags, created: Date.now() });
    clearForm(['noteTitle','noteContent','noteTags']);
  }

  else if (activeResourceType === 'video') {
    const title   = document.getElementById('videoTitle').value.trim();
    const url     = document.getElementById('videoUrl').value.trim();
    if (!title || !url) return showToast('Enter title and URL', 'error');
    const videoId = extractYouTubeId(url);
    if (!videoId)   return showToast('Invalid YouTube URL', 'error');
    sub.videos.push({ id: genId(), title, url, videoId });
    clearForm(['videoTitle','videoUrl']);
  }

  else if (activeResourceType === 'flashcard') {
    const question   = document.getElementById('cardQuestion').value.trim();
    const answer     = document.getElementById('cardAnswer').value.trim();
    const difficulty = document.getElementById('cardDiff').value || 'easy';
    if (!question || !answer) return showToast('Enter question and answer', 'error');
    sub.flashcards.push({ id: genId(), question, answer, difficulty, nextReview: Date.now(), reviewCount: 0 });
    clearForm(['cardQuestion','cardAnswer']);
    document.getElementById('cardDiff').value = 'easy';
    document.querySelectorAll('.diff-btn[data-diff]').forEach(b => b.classList.toggle('active', b.dataset.diff === 'easy'));
  }

  finaliseAdd();
}

function finaliseAdd() {
  saveState(); renderAllResources(); updateAnalyticsBar(); renderSidebarStats();
  closeModal('resourceModal');
  showToast('Resource added!');
}

// ==================== SAVE PDF (async, IndexedDB) ====================
async function savePdfResource(sub) {
  const title = document.getElementById('pdfTitle').value.trim();
  const desc  = document.getElementById('pdfDesc').value.trim();
  const url   = document.getElementById('pdfUrl').value.trim();
  if (!title) return showToast('Enter a PDF title', 'error');

  const miniDrop    = document.getElementById('pdfDropZoneMini');
  const pendingFile = miniDrop?._pendingFile;

  if (pendingFile) {
    const id = genId();
    try {
      if (db) await dbSave(id, pendingFile);
      sub.pdfs.push({
        id, title,
        desc: desc || `Uploaded ${new Date().toLocaleDateString()}`,
        isLocal:  true,
        fileSize: formatSize(pendingFile.size),
        fileName: pendingFile.name
      });
      clearForm(['pdfTitle','pdfDesc','pdfUrl']);
      resetMiniDropZone();
      document.getElementById('pdfFileInputModal').value = '';
      finaliseAdd();
    } catch (err) {
      console.error(err);
      showToast('Failed to save PDF', 'error');
    }
    return;
  }

  if (!url) return showToast('Provide a PDF URL or upload a file', 'error');
  sub.pdfs.push({ id: genId(), title, desc, url, isLocal: false });
  clearForm(['pdfTitle','pdfDesc','pdfUrl']);
  finaliseAdd();
}

// ==================== OPEN PDF ====================
async function openPdf(id) {
  const sub = getSubject(state.activeSubject);
  const pdf = sub?.pdfs.find(p => p.id === id);
  if (!pdf) return;

  if (pdf.needsReupload) {
    return showToast('Old format — please delete and re-upload this PDF', 'error');
  }

  if (pdf.isLocal) {
    if (!db) return showToast('Storage not available', 'error');
    try {
      const blob = await dbGet(id);
      if (!blob) return showToast('File not found — please re-upload', 'error');
      const blobUrl = URL.createObjectURL(blob);
      const win     = window.open(blobUrl, '_blank');
      if (!win) showToast('Allow popups to open PDFs', 'error');
      setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);
    } catch (err) {
      console.error(err);
      showToast('Could not open PDF', 'error');
    }
  } else {
    const win = window.open(pdf.url, '_blank');
    if (!win) showToast('Allow popups to open PDFs', 'error');
  }
}

// ==================== DELETE RESOURCE ====================
function deleteResource(type, id) {
  const sub = getSubject(state.activeSubject);
  if (!sub) return;
  if (type === 'pdf') {
    const p = sub.pdfs.find(x => x.id === id);
    if (p?.isLocal && db) dbDelete(id).catch(() => {});
  }
  sub[type + 's'] = sub[type + 's'].filter(r => r.id !== id);
  saveState(); renderAllResources(); updateAnalyticsBar(); renderSidebarStats();
  showToast('Deleted');
}

// ==================== RENDER ALL ====================
function renderAllResources() {
  const sub = getSubject(state.activeSubject);
  if (!sub) return;
  applyFilter();
  renderPdfs(sub);
  renderNotes(sub);
  renderVideos(sub);
  renderFlashcards(sub);
  updateCounts(sub);
}

function applyFilter() {
  const f = state.activeFilter;
  [['pdf','pdfSection'],['note','noteSection'],['video','videoSection'],['flashcard','flashSection']].forEach(([t,sid]) => {
    document.getElementById(sid)?.classList.toggle('filtered-out', f !== 'all' && f !== t);
  });
}

function updateCounts(sub) {
  const q = state.searchQuery.toLowerCase();
  document.getElementById('pdfCount').textContent   = filterItems(sub.pdfs,   q).length;
  document.getElementById('noteCount').textContent  = filterItems(sub.notes,  q).length;
  document.getElementById('videoCount').textContent = filterItems(sub.videos, q).length;
  document.getElementById('flashCount').textContent = filterItems(sub.flashcards, q, true).length;
}

function filterItems(items, query, isFlash = false) {
  if (!query) return items;
  return items.filter(item => isFlash
    ? item.question.toLowerCase().includes(query) || item.answer.toLowerCase().includes(query)
    : [(item.title||''),(item.desc||''),(item.content||'')].some(t => t.toLowerCase().includes(query))
  );
}

// ==================== RENDER PDFs ====================
function renderPdfs(sub) {
  const grid  = document.getElementById('pdfGrid');
  const items = filterItems(sub.pdfs, state.searchQuery.toLowerCase());
  grid.innerHTML = '';
  if (!items.length) { grid.innerHTML = emptyState('No PDFs yet'); return; }

  items.forEach(pdf => {
    const canOpen = (pdf.isLocal && !pdf.needsReupload) || (pdf.url && !pdf.isLocal);
    const badge   = pdf.needsReupload
      ? `<span class="pdf-badge warn">⚠ Re-upload needed</span>`
      : pdf.isLocal
        ? `<span class="pdf-badge local">📁 Uploaded</span>`
        : `<span class="pdf-badge link">🔗 Link</span>`;
    const sizeTag = pdf.fileSize ? `<span class="pdf-size">${pdf.fileSize}</span>` : '';

    const card = document.createElement('div');
    card.className = 'resource-card';
    card.innerHTML = `
      <div class="card-header">
        <div class="card-icon pdf">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
          </svg>
        </div>
        <div class="card-menu">
          <button class="card-btn delete" title="Delete" onclick="deleteResource('pdf','${pdf.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="card-title">${escapeHtml(pdf.title)}</div>
      <div class="card-desc">${escapeHtml(pdf.desc || 'No description')}</div>
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:10px">${badge}${sizeTag}</div>
      <div class="card-footer">
        ${canOpen
          ? `<button class="card-action-btn primary" onclick="openPdf('${pdf.id}')">
               <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12" style="margin-right:4px;flex-shrink:0">
                 <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                 <polyline points="15 3 21 3 21 9"/>
                 <line x1="10" y1="14" x2="21" y2="3"/>
               </svg>Open in New Tab
             </button>`
          : `<button class="card-action-btn" disabled style="opacity:.4;cursor:not-allowed">No file attached</button>`
        }
      </div>`;
    grid.appendChild(card);
  });
}

// ==================== RENDER NOTES ====================
function renderNotes(sub) {
  const grid  = document.getElementById('noteGrid');
  const items = filterItems(sub.notes, state.searchQuery.toLowerCase());
  grid.innerHTML = '';
  if (!items.length) { grid.innerHTML = emptyState('No notes yet'); return; }
  items.forEach(note => {
    const preview = note.content.slice(0, 100) + (note.content.length > 100 ? '…' : '');
    const card    = document.createElement('div');
    card.className = 'resource-card';
    card.innerHTML = `
      <div class="card-header">
        <div class="card-icon note">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </div>
        <div class="card-menu">
          <button class="card-btn" title="Edit" onclick="openEditNote('${note.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <button class="card-btn delete" title="Delete" onclick="deleteResource('note','${note.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="card-title">${escapeHtml(note.title)}</div>
      <div class="card-desc">${escapeHtml(preview)}</div>
      <div class="card-footer">
        <button class="card-action-btn primary" onclick="openNoteView('${note.id}')">Open Note</button>
      </div>`;
    grid.appendChild(card);
  });
}

function openNoteView(id) {
  const sub  = getSubject(state.activeSubject);
  const note = sub?.notes.find(n => n.id === id);
  if (!note) return;
  document.getElementById('noteViewTitle').textContent   = note.title;
  document.getElementById('noteViewContent').textContent = note.content;
  document.getElementById('noteViewTags').innerHTML      = (note.tags||[]).map(t => `<span class="note-tag">${escapeHtml(t)}</span>`).join('');
  document.getElementById('noteSummaryBox').classList.add('hidden');
  document.getElementById('summarizeBtn').dataset.noteId = id;
  openModal('noteViewModal');
}

function openEditNote(id) {
  const sub  = getSubject(state.activeSubject);
  const note = sub?.notes.find(n => n.id === id);
  if (!note) return;
  editingNoteId = id;
  document.getElementById('editNoteTitle').value   = note.title;
  document.getElementById('editNoteContent').value = note.content;
  document.getElementById('editNoteTags').value    = (note.tags||[]).join(', ');
  openModal('editNoteModal');
}

function saveEditNote() {
  const sub  = getSubject(state.activeSubject);
  const note = sub?.notes.find(n => n.id === editingNoteId);
  if (!note) return;
  note.title   = document.getElementById('editNoteTitle').value.trim();
  note.content = document.getElementById('editNoteContent').value.trim();
  note.tags    = document.getElementById('editNoteTags').value.split(',').map(t => t.trim()).filter(Boolean);
  saveState(); renderAllResources(); closeModal('editNoteModal'); showToast('Note saved!');
}

function summarizeNote() {
  const id   = document.getElementById('summarizeBtn').dataset.noteId;
  const sub  = getSubject(state.activeSubject);
  const note = sub?.notes.find(n => n.id === id);
  if (!note) return;
  const sentences = note.content.match(/[^.!?]+[.!?]+/g) || [note.content];
  const keywords  = ['important','key','define','means','because','therefore','result','first','main','primary','critical','example','is','are'];
  const scored    = sentences.map(s => ({
    text:  s.trim(),
    score: s.length * 0.01 + keywords.reduce((sc, kw) => sc + (s.toLowerCase().includes(kw) ? 2 : 0), 0)
  })).sort((a, b) => b.score - a.score);
  document.getElementById('noteSummaryText').textContent = scored.slice(0, 3).map(s => s.text).join(' ');
  document.getElementById('noteSummaryBox').classList.remove('hidden');
}

// ==================== RENDER VIDEOS ====================
function renderVideos(sub) {
  const grid  = document.getElementById('videoGrid');
  const items = filterItems(sub.videos, state.searchQuery.toLowerCase());
  grid.innerHTML = '';
  if (!items.length) { grid.innerHTML = emptyState('No videos yet'); return; }
  items.forEach(video => {
    const card = document.createElement('div');
    card.className = 'video-card';
    card.innerHTML = `
      <img src="https://img.youtube.com/vi/${video.videoId}/mqdefault.jpg" alt="${escapeHtml(video.title)}" onerror="this.style.display='none'">
      <div class="video-overlay"><div class="video-title-overlay">${escapeHtml(video.title)}</div></div>
      <div class="video-play-btn">
        <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      </div>
      <button class="video-delete-btn" onclick="event.stopPropagation();deleteResource('video','${video.id}')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>`;
    card.addEventListener('click', () => openVideoPlayer(video));
    grid.appendChild(card);
  });
}

function openVideoPlayer(video) {
  document.getElementById('videoModalTitle').textContent = video.title;
  document.getElementById('videoPlayer').src = `https://www.youtube.com/embed/${video.videoId}?autoplay=1`;
  openModal('videoModal');
}
function closeVideoModal() { document.getElementById('videoPlayer').src = ''; closeModal('videoModal'); }

// ==================== RENDER FLASHCARDS ====================
function renderFlashcards(sub) {
  const grid  = document.getElementById('flashGrid');
  const items = filterItems(sub.flashcards, state.searchQuery.toLowerCase(), true);
  grid.innerHTML = '';
  if (!items.length) { grid.innerHTML = emptyState('No flashcards yet'); return; }
  items.forEach(card => {
    const wrapper = document.createElement('div');
    wrapper.className = 'flashcard-wrapper';
    wrapper.innerHTML = `
      <div class="flashcard" id="fc-${card.id}">
        <div class="fc-face fc-front">
          <div class="fc-label">Question</div>
          <div class="fc-text">${escapeHtml(card.question)}</div>
          <div class="fc-footer">
            <span class="fc-diff ${card.difficulty}">${card.difficulty}</span>
            <button class="card-btn delete" onclick="event.stopPropagation();deleteResource('flashcard','${card.id}')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="fc-face fc-back">
          <div class="fc-label">Answer</div>
          <div class="fc-text">${escapeHtml(card.answer)}</div>
          <div class="fc-footer"><span style="font-size:.7rem;opacity:.6">Click to flip back</span></div>
        </div>
      </div>`;
    wrapper.querySelector('.flashcard').addEventListener('click', e => e.currentTarget.classList.toggle('flipped'));
    grid.appendChild(wrapper);
  });
}

// ==================== PRACTICE MODE ====================
function openPracticeMode() {
  const sub = getSubject(state.activeSubject);
  if (!sub?.flashcards.length) return showToast('Add flashcards first!', 'error');
  practiceCards = [...sub.flashcards].sort(() => Math.random() - 0.5);
  practiceIndex = 0; practiceFlipped = false;
  practiceScores = { easy: 0, medium: 0, hard: 0 };
  document.getElementById('practiceDone').classList.add('hidden');
  document.getElementById('practiceControls').style.display = 'none';
  document.getElementById('practiceCard').style.display = '';
  loadPracticeCard();
  openModal('practiceModal');
}

function loadPracticeCard() {
  if (practiceIndex >= practiceCards.length) { showPracticeComplete(); return; }
  const card = practiceCards[practiceIndex];
  document.getElementById('pfQuestion').textContent = card.question;
  document.getElementById('pfAnswer').textContent   = card.answer;
  document.getElementById('practiceProgressFill').style.width = (practiceIndex / practiceCards.length * 100) + '%';
  document.getElementById('practiceProgressText').textContent = `${practiceIndex + 1} / ${practiceCards.length}`;
  practiceFlipped = false;
  document.getElementById('practiceCard').classList.remove('flipped');
  document.getElementById('practiceControls').style.display = 'none';
}

function flipPracticeCard() {
  practiceFlipped = !practiceFlipped;
  document.getElementById('practiceCard').classList.toggle('flipped', practiceFlipped);
  if (practiceFlipped) document.getElementById('practiceControls').style.display = 'flex';
}

function ratePracticeCard(rating) {
  practiceScores[rating]++;
  const sub  = getSubject(state.activeSubject);
  const card = sub?.flashcards.find(c => c.id === practiceCards[practiceIndex].id);
  if (card) {
    card.difficulty  = rating;
    card.reviewCount = (card.reviewCount || 0) + 1;
    card.nextReview  = Date.now() + { easy: 3, medium: 1, hard: 0 }[rating] * 86400000;
  }
  practiceIndex++;
  saveState();
  practiceIndex >= practiceCards.length ? showPracticeComplete() : loadPracticeCard();
}

function showPracticeComplete() {
  const today = new Date().toDateString();
  if (state.studyStats.lastStudyDate !== today) state.studyStats.cardsStudiedToday = 0;
  state.studyStats.cardsStudiedToday += practiceCards.length;
  state.studyStats.lastStudyDate = today;
  saveState();
  document.getElementById('practiceCard').style.display = 'none';
  document.getElementById('practiceControls').style.display = 'none';
  document.getElementById('practiceDone').classList.remove('hidden');
  document.getElementById('practiceProgressFill').style.width = '100%';
  document.getElementById('practiceProgressText').textContent = `${practiceCards.length} / ${practiceCards.length}`;
  document.getElementById('practiceScore').textContent = `Easy: ${practiceScores.easy} · Medium: ${practiceScores.medium} · Hard: ${practiceScores.hard}`;
}
function closePracticeMode() { closeModal('practiceModal'); }

// ==================== ANALYTICS ====================
function updateAnalyticsBar() {
  const sub = getSubject(state.activeSubject);
  if (!sub) return;
  document.getElementById('aPdfs').textContent   = sub.pdfs.length;
  document.getElementById('aNotes').textContent  = sub.notes.length;
  document.getElementById('aVideos').textContent = sub.videos.length;
  document.getElementById('aCards').textContent  = sub.flashcards.length;
  document.getElementById('aStreak').textContent = state.streak.count;
}

function openAnalyticsModal() {
  const total      = state.subjects.reduce((a, s) => a + countResources(s), 0);
  const cardsToday = state.studyStats.lastStudyDate === new Date().toDateString() ? state.studyStats.cardsStudiedToday : 0;
  const colors     = ['var(--pdf-color)','var(--note-color)','var(--video-color)','var(--card-color)'];
  const types      = ['pdfs','notes','videos','flashcards'];
  const labels     = ['PDFs','Notes','Videos','Flashcards'];

  document.getElementById('analyticsBody').innerHTML = `
    <div class="analytics-full-grid">
      <div class="analytics-full-card">
        <h4>Overview</h4>
        ${[['Total Subjects',state.subjects.length],['Total Resources',total],['Cards Today',cardsToday],['Streak',`🔥 ${state.streak.count} days`]]
          .map(([l,v])=>`<div style="display:flex;justify-content:space-between;font-size:.9rem;margin-bottom:8px"><span>${l}</span><strong>${v}</strong></div>`).join('')}
      </div>
      <div class="analytics-full-card">
        <h4>By Type</h4>
        ${types.map((t,i)=>{
          const c=state.subjects.reduce((a,s)=>a+s[t].length,0), p=total>0?Math.round(c/total*100):0;
          return `<div style="margin-bottom:10px">
            <div class="progress-label" style="display:flex;justify-content:space-between;font-size:.8rem;margin-bottom:4px"><span>${labels[i]}</span><span>${c}</span></div>
            <div class="progress-bar-bg"><div class="progress-bar-fill" style="width:${p}%;background:${colors[i]}"></div></div>
          </div>`;
        }).join('')}
      </div>
      <div class="analytics-full-card" style="grid-column:1/-1">
        <h4>By Subject</h4>
        ${state.subjects.map(s=>{
          const c=countResources(s),p=total>0?Math.round(c/total*100):0;
          return `<div style="margin-bottom:10px">
            <div class="progress-label" style="display:flex;justify-content:space-between;font-size:.8rem;margin-bottom:4px"><span>${s.emoji} ${escapeHtml(s.name)}</span><span>${c}</span></div>
            <div class="progress-bar-bg"><div class="progress-bar-fill" style="width:${p}%;background:var(--accent)"></div></div>
          </div>`;
        }).join('') || '<p style="color:var(--text-light);font-size:.85rem">No subjects yet</p>'}
      </div>
    </div>`;
  openModal('analyticsModal');
}

// ==================== PLANNER ====================
function openPlannerModal() {
  document.getElementById('plannerSubject').innerHTML =
    state.subjects.map(s => `<option value="${s.id}">${s.emoji} ${s.name}</option>`).join('');
  document.getElementById('plannerDate').value = new Date().toISOString().split('T')[0];
  renderPlannerSessions();
  openModal('plannerModal');
}

function addPlannerSession() {
  const subId = document.getElementById('plannerSubject').value;
  const topic = document.getElementById('plannerTopic').value.trim();
  const date  = document.getElementById('plannerDate').value;
  const time  = document.getElementById('plannerTime').value;
  if (!topic || !date || !time) return showToast('Fill all fields', 'error');
  const sub = getSubject(subId);
  state.planner.push({ id: genId(), subjectId: subId, subjectName: `${sub?.emoji||''} ${sub?.name||''}`, topic, date, time });
  state.planner.sort((a,b) => new Date(`${a.date}T${a.time}`) - new Date(`${b.date}T${b.time}`));
  saveState(); renderPlannerSessions();
  document.getElementById('plannerTopic').value = '';
  showToast('Session scheduled!');
}

function deletePlannerSession(id) {
  state.planner = state.planner.filter(s => s.id !== id);
  saveState(); renderPlannerSessions();
}

function renderPlannerSessions() {
  const c = document.getElementById('plannerSessions');
  if (!state.planner.length) {
    c.innerHTML = `<div class="empty-state" style="border:1.5px dashed var(--border);border-radius:12px;padding:24px"><p>No sessions scheduled yet</p></div>`;
    return;
  }
  c.innerHTML = state.planner.map(s => {
    const d = new Date(`${s.date}T${s.time}`);
    return `<div class="session-card">
      <div class="session-date-block">
        <div class="session-date-day">${d.getDate()}</div>
        <div class="session-date-month">${d.toLocaleString('default',{month:'short'})}</div>
      </div>
      <div class="session-info">
        <div class="session-subject">${escapeHtml(s.subjectName)}</div>
        <div class="session-topic">${escapeHtml(s.topic)}</div>
      </div>
      <div class="session-time">${d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</div>
      <button class="session-delete" onclick="deletePlannerSession('${s.id}')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>`;
  }).join('');
}

// ==================== DROP ZONE SETUP ====================
function setupDropZone() {
  const dropZone   = document.getElementById('pdfDropZone');
  const fileInput  = document.getElementById('pdfFileInput');
  const miniDrop   = document.getElementById('pdfDropZoneMini');
  const modalInput = document.getElementById('pdfFileInputModal');

  // Main drop zone — auto-adds without opening modal
  dropZone?.addEventListener('click', () => fileInput.click());
  fileInput?.addEventListener('change', e => {
    if (!state.activeSubject) return showToast('Select a subject first', 'error');
    Array.from(e.target.files).forEach(addPdfDirect);
    e.target.value = '';
  });
  dropZone?.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone?.addEventListener('dragleave', ()  => dropZone.classList.remove('drag-over'));
  dropZone?.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('drag-over');
    if (!state.activeSubject) return showToast('Select a subject first', 'error');
    Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf').forEach(addPdfDirect);
  });

  // Modal mini drop zone
  miniDrop?.addEventListener('click', () => modalInput.click());
  modalInput?.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    miniDrop._pendingFile = file;
    miniDrop.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      <span style="color:var(--accent);font-weight:600">${escapeHtml(file.name)} · ${formatSize(file.size)}</span>`;
    const titleEl = document.getElementById('pdfTitle');
    if (!titleEl.value) titleEl.value = file.name.replace(/\.pdf$/i, '');
  });
}

// Direct add (from main drop zone, bypasses modal)
async function addPdfDirect(file) {
  const sub = getSubject(state.activeSubject);
  if (!sub) return;
  const id = genId();
  try {
    if (db) await dbSave(id, file);
    sub.pdfs.push({
      id, title: file.name.replace(/\.pdf$/i, ''),
      desc:     `Uploaded ${new Date().toLocaleDateString()}`,
      isLocal:  true,
      fileSize: formatSize(file.size),
      fileName: file.name
    });
    saveState(); renderAllResources(); updateAnalyticsBar(); renderSidebarStats();
    showToast(`"${file.name}" added!`);
  } catch (err) {
    console.error(err);
    showToast('Failed to save PDF', 'error');
  }
}

function resetMiniDropZone() {
  const el = document.getElementById('pdfDropZoneMini');
  if (!el) return;
  el._pendingFile = null;
  el.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/>
    </svg>
    <span>Drop or click to upload</span>`;
}

// ==================== SEARCH & FILTER ====================
function handleSearch(q)       { state.searchQuery = q; if (state.activeSubject) renderAllResources(); }
function handleFilterChange(f) {
  state.activeFilter = f;
  document.querySelectorAll('.pill').forEach(p => p.classList.toggle('active', p.dataset.filter === f));
  if (state.activeSubject) renderAllResources();
}

// ==================== MODAL HELPERS ====================
function openModal(id)  { document.getElementById(id).classList.add('open');    document.body.style.overflow = 'hidden'; }
function closeModal(id) { document.getElementById(id).classList.remove('open'); document.body.style.overflow = '';       }

// ==================== THEME ====================
function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('studyVault_theme', next);
}
function applyTheme() {
  document.documentElement.setAttribute('data-theme', localStorage.getItem('studyVault_theme') || 'light');
}

// ==================== TOAST ====================
function showToast(msg, type = 'success') {
  const c = document.getElementById('toastContainer');
  const t = document.createElement('div');
  t.className = `toast${type === 'error' ? ' error' : ''}`;
  t.innerHTML = `${type === 'error' ? '⚠️' : '✓'} ${escapeHtml(msg)}`;
  c.appendChild(t);
  setTimeout(() => { t.style.animation = 'toastOut .3s ease forwards'; setTimeout(() => t.remove(), 300); }, 3000);
}

// ==================== BOTTOM NAV ====================
function bnActivate(id) {
  document.querySelectorAll('.bottom-nav-btn').forEach(b => b.classList.toggle('active', b.id === id));
}

// ==================== EVENT LISTENERS ====================
function setupEventListeners() {
  document.getElementById('sidebarToggle').addEventListener('click', () => document.getElementById('sidebar').classList.toggle('collapsed'));
  document.getElementById('mobileMenuBtn').addEventListener('click', () => {
    const sb = document.getElementById('sidebar');
    const ov = document.getElementById('sidebarOverlay');
    sb.classList.toggle('open');
    ov.classList.toggle('active', sb.classList.contains('open'));
  });
  // Overlay click closes sidebar
  document.getElementById('sidebarOverlay')?.addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarOverlay').classList.remove('active');
  });
  document.addEventListener('click', e => {
    const sb = document.getElementById('sidebar');
    if (window.innerWidth <= 768 && sb.classList.contains('open') && !sb.contains(e.target) && e.target.id !== 'mobileMenuBtn') sb.classList.remove('open');
  });
  document.getElementById('addSubjectBtn').addEventListener('click', () => openModal('subjectModal'));
  document.getElementById('addResourceBtn').addEventListener('click', () => openAddModal(activeResourceType));
  document.getElementById('darkModeBtn').addEventListener('click', toggleTheme);
  document.getElementById('plannerBtn').addEventListener('click', openPlannerModal);
  document.getElementById('analyticsBtn').addEventListener('click', openAnalyticsModal);
  document.getElementById('searchInput').addEventListener('input', e => {
    handleSearch(e.target.value);
    const mob = document.getElementById('searchInputMobile');
    if (mob) mob.value = e.target.value;
  });
  document.getElementById('searchInputMobile')?.addEventListener('input', e => {
    handleSearch(e.target.value);
    document.getElementById('searchInput').value = e.target.value;
  });
  document.querySelectorAll('.pill').forEach(p => p.addEventListener('click', () => {
    handleFilterChange(p.dataset.filter);
    // Sync all pill groups
    document.querySelectorAll('.pill').forEach(x => x.classList.toggle('active', x.dataset.filter === p.dataset.filter));
  }));
  document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => setResourceTab(b.dataset.type)));
  document.querySelectorAll('.emoji-opt').forEach(opt => opt.addEventListener('click', () => {
    document.querySelectorAll('.emoji-opt').forEach(o => o.classList.remove('selected'));
    opt.classList.add('selected');
    document.getElementById('subjectEmojiInput').value = opt.dataset.emoji;
  }));
  document.querySelectorAll('.diff-btn[data-diff]').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.diff-btn[data-diff]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    document.getElementById('cardDiff').value = b.dataset.diff;
  }));
  document.querySelectorAll('.modal-overlay').forEach(overlay => overlay.addEventListener('click', e => {
    if (e.target !== overlay) return;
    const id = overlay.id;
    if (id === 'videoModal') closeVideoModal();
    else if (id === 'practiceModal') closePracticeMode();
    else { closeModal(id); if (id === 'resourceModal') resetMiniDropZone(); }
  }));
  document.getElementById('subjectNameInput').addEventListener('keydown', e => { if (e.key === 'Enter') addSubject(); });
  setupDropZone();
}

// ==================== UTILS ====================
function genId()      { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
}
function clearForm(ids) { ids.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; }); }
function emptyState(msg) {
  return `<div class="empty-state" style="grid-column:1/-1">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="8" x2="12" y2="12"/>
      <line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
    <p>${msg}</p>
  </div>`;
}
function formatSize(bytes) {
  if (bytes < 1024)    return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}
function extractYouTubeId(url) {
  const m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([^&\n?#]+)/);
  return m ? m[1] : null;
}

// (styles moved to styles.css)

// ==================== SEED DATA ====================
function seedIfEmpty() {
  if (state.subjects.length > 0) return;
  state.subjects = [
    {
      id: genId(), name: 'Computer Science', emoji: '💻',
      pdfs: [],
      notes: [{
        id: genId(), title: 'Big O Notation',
        content: 'Big O notation describes algorithm complexity. O(1) is constant time. O(n) is linear. O(n²) is quadratic — seen in nested loops. O(log n) is logarithmic, common in binary search. Key insight: always optimize your most frequent operations first.',
        tags: ['algorithms','important'], created: Date.now()
      }],
      videos: [{ id: genId(), title: 'CS50 Intro to CS', url: 'https://youtube.com/watch?v=IDDmrzzB14M', videoId: 'IDDmrzzB14M' }],
      flashcards: [
        { id: genId(), question: 'What is a binary search tree?', answer: 'A tree where each node\'s value is greater than all left subtree values and less than all right subtree values.', difficulty: 'medium', nextReview: Date.now(), reviewCount: 0 },
        { id: genId(), question: 'Time complexity of quicksort?', answer: 'Average O(n log n), worst case O(n²).', difficulty: 'hard', nextReview: Date.now(), reviewCount: 0 }
      ],
      studySessions: []
    },
    {
      id: genId(), name: 'Mathematics', emoji: '🧮',
      pdfs: [],
      notes: [{
        id: genId(), title: 'Calculus Fundamentals',
        content: 'The derivative measures instantaneous rate of change. Power rule: d/dx[xⁿ] = nxⁿ⁻¹. Chain rule: d/dx[f(g(x))] = f\'(g(x))·g\'(x). Integration is the reverse of differentiation. The fundamental theorem of calculus connects the two operations.',
        tags: ['calculus','review'], created: Date.now()
      }],
      videos: [],
      flashcards: [{ id: genId(), question: 'Derivative of sin(x)?', answer: 'cos(x)', difficulty: 'easy', nextReview: Date.now(), reviewCount: 0 }],
      studySessions: []
    }
  ];
  saveState();
}

// ==================== BOOT ====================
document.addEventListener('DOMContentLoaded', () => {
  seedIfEmpty();
  init();
});
