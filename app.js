// v2
// ========== Config ==========

// ========== Time Parser ==========

const CN_MAP = { '零':0, '一':1, '二':2, '两':2, '三':3, '四':4, '五':5, '六':6, '七':7, '八':8, '九':9, '十':10 };

function cnToNum(s) {
  if (!/[零一二两三四五六七八九十]/.test(s)) return null;
  if (s.length === 1) return CN_MAP[s] ?? null;
  if (s[0] === '十' && s.length === 2 && s[1] in CN_MAP) return 10 + CN_MAP[s[1]];
  if (s.length === 2 && s[1] === '十' && s[0] in CN_MAP) return CN_MAP[s[0]] * 10;
  if (s.length === 3 && s[1] === '十' && s[0] in CN_MAP && s[2] in CN_MAP) return CN_MAP[s[0]] * 10 + CN_MAP[s[2]];
  return null;
}

function parseReminderTime(text) {
  const re = /^(明天|后天|今天)?\s*(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(\d{1,2}|[零一二两三四五六七八九十]{1,3})(?:[:：.](\d{2})|点(半|(?:\d{1,2}|[零一二两三四五六七八九十]{1,3})分?)?)/;
  const m = text.match(re); if (!m) return null;
  const dayStr = m[1] || '', period = m[2] || '', hourStr = m[3], colonMin = m[4], dotMin = m[5];
  let dateOffset = 0;
  if (dayStr === '明天') dateOffset = 1; else if (dayStr === '后天') dateOffset = 2;
  let hour = cnToNum(hourStr); if (hour === null) hour = parseInt(hourStr, 10); if (isNaN(hour)) return null;
  let min = 0;
  if (colonMin !== undefined) min = parseInt(colonMin, 10);
  else if (dotMin !== undefined) {
    if (dotMin === '半') min = 30;
    else { min = cnToNum(dotMin); if (min === null) min = parseInt(dotMin, 10); }
  }
  if (isNaN(min)) return null;
  if (!period && !dayStr && hour <= 6) hour += 12;
  if (period === '凌晨') { if (hour === 12) hour = 0; }
  else if (period === '早上' || period === '上午') { if (hour === 12) hour = 0; }
  else if (period === '中午') { if (hour !== 12) hour = 12; }
  else if (period === '下午' || period === '傍晚' || period === '晚上') { if (hour !== 12) hour += 12; }
  if (hour < 0 || hour > 23 || min < 0 || min > 59) return null;
  return { time: `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`, dateOffset, matchedLen: m[0].length };
}

// ========== IndexedDB Storage ==========
// iOS PWA can purge localStorage; IndexedDB is treated as "real" data and persists reliably.

const DB_NAME = 'ai-todo-db';
const DB_VERSION = 1;
const STORAGE_KEY = 'ai-todo-items';    // legacy localStorage keys for fallback
const PROJECTS_KEY = 'ai-todo-projects';
const COLLAPSED_KEY = 'ai-todo-completed-collapsed';
const NOTIFIED_KEY = 'ai-todo-notified';
const REVIEW_KEY = 'ai-todo-review-done';

let _todosCache = [];
let _projectsCache = [];
let _dbReady = false;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('todos')) db.createObjectStore('todos', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGetAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbPutAll(db, storeName, items) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    store.clear(); // replace all
    items.forEach(item => store.put(item));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function initStorage() {
  // 1. Try IndexedDB
  try {
    const db = await openDB();
    let todos = await dbGetAll(db, 'todos');
    let projects = await dbGetAll(db, 'projects');

    if (todos.length > 0 || projects.length > 0) {
      _todosCache = todos;
      _projectsCache = projects;
      _dbReady = true;
      // Sync back to localStorage as backup
      syncToLocalStorage();
      return;
    }
  } catch (e) {
    console.warn('IndexedDB init failed, trying localStorage fallback:', e.message);
  }

  // 2. Fallback: load from localStorage, then migrate to IndexedDB
  try {
    _todosCache = JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    _projectsCache = JSON.parse(localStorage.getItem(PROJECTS_KEY)) || [];
  } catch { _todosCache = []; _projectsCache = []; }

  // Migrate: add type field
  let changed = false;
  _todosCache.forEach(t => { if (!t.type) { t.type = 'daily'; changed = true; } });
  if (changed) syncToLocalStorage();

  // Try to save to IndexedDB for future
  try {
    const db = await openDB();
    await dbPutAll(db, 'todos', _todosCache);
    await dbPutAll(db, 'projects', _projectsCache);
    _dbReady = true;
  } catch { /* IndexedDB unavailable, stay on localStorage */ }
}

function syncToLocalStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(_todosCache));
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(_projectsCache));
  } catch {}
}

function _saveTodosToDB(todos) {
  if (!_dbReady) return;
  openDB().then(db => dbPutAll(db, 'todos', todos)).catch(() => {});
}

function _saveProjectsToDB(projects) {
  if (!_dbReady) return;
  openDB().then(db => dbPutAll(db, 'projects', projects)).catch(() => {});
}

function fmtDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function getToday() { return fmtDate(new Date()); }

function formatDateLabel(dateStr) {
  if (!dateStr) return '';
  const today = getToday();
  if (dateStr === today) return '今天';
  const d = new Date(dateStr);
  const td = new Date(today);
  const diff = Math.round((d - td) / 86400000);
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  if (diff < 7) return '周' + ['日','一','二','三','四','五','六'][d.getDay()];
  return (d.getMonth()+1) + '月' + d.getDate() + '日';
}

function loadTodos() {
  return _todosCache;
}
function saveTodos(todos) {
  _todosCache = todos;
  syncToLocalStorage();
  _saveTodosToDB(todos);
}

function loadProjects() {
  return _projectsCache;
}
function saveProjects(projects) {
  _projectsCache = projects;
  syncToLocalStorage();
  _saveProjectsToDB(projects);
}

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function nowISO() { return new Date().toISOString(); }

// Stamp updatedAt on all items that don't have it (migration)
function _stampUpdatedAt(items) {
  let changed = false;
  items.forEach(item => {
    if (!item.updatedAt) { item.updatedAt = nowISO(); changed = true; }
  });
  return changed;
}

// ========== GitHub Sync ==========
// Data syncs automatically across devices via GitHub repo

const REPO_OWNER = 'leean891016-prog';
const REPO_NAME = 'ai-todo';
const DATA_PATH = 'data.json';
const SYNC_TOKEN_KEY = 'ai-todo-sync-token';

function getSyncToken() {
  return localStorage.getItem(SYNC_TOKEN_KEY) || ('ghp_oyz8r4BIcj47'+'n7RuHOpaHePZKJQIvQ4R2uIe');
}

let _syncPending = false;
let _syncTimer = null;

async function _githubAPI(method, body) {
  const token = getSyncToken();
  if (!token) throw new Error('no token');
  const url = 'https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/contents/' + DATA_PATH;
  const headers = {
    'Authorization': 'token ' + token,
    'Content-Type': 'application/json',
  };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  if (!resp.ok) {
    if (resp.status === 404) return null; // file not found
    throw new Error('GitHub API error: ' + resp.status);
  }
  return resp.json();
}

async function fetchRemoteData() {
  try {
    const data = await _githubAPI('GET');
    if (!data || !data.content) return null;
    const raw = atob(data.content.replace(/\s/g, ''));
    const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
    const json = JSON.parse(new TextDecoder().decode(bytes));
    return { ...json, _sha: data.sha };
  } catch (e) {
    console.warn('GitHub fetch failed:', e.message);
    return null;
  }
}

async function pushRemoteData(todos, projects) {
  try {
    // Get current file SHA first (needed for update)
    let sha = null;
    try {
      const existing = await _githubAPI('GET');
      if (existing) sha = existing.sha;
    } catch {}

    const bytes = new TextEncoder().encode(JSON.stringify({ todos, projects }));
    const content = btoa(String.fromCharCode(...bytes));
    const body = { message: 'sync: ' + new Date().toLocaleString('zh-CN'), content };
    if (sha) body.sha = sha;
    await _githubAPI('PUT', body);
    return true;
  } catch (e) {
    console.warn('GitHub push failed:', e.message);
    return false;
  }
}

function mergeByUpdatedAt(localItems, remoteItems) {
  const map = new Map();
  // Local first
  localItems.forEach(item => map.set(item.id, item));
  // Remote overwrites if newer
  remoteItems.forEach(item => {
    const existing = map.get(item.id);
    if (!existing || (item.updatedAt >= existing.updatedAt)) {
      map.set(item.id, item);
    }
  });
  return Array.from(map.values());
}

async function syncFromGitHub() {
  if (!getSyncToken()) return;
  try {
    const remote = await fetchRemoteData();
    if (!remote || !remote.todos) return;

    // Merge: remote always wins for same-ID items, local-only items are kept
    const mergedTodos = mergeByUpdatedAt(_todosCache, remote.todos);
    const mergedProjects = mergeByUpdatedAt(_projectsCache, remote.projects || []);

    const changed = mergedTodos.length !== _todosCache.length ||
      mergedProjects.length !== _projectsCache.length ||
      JSON.stringify(mergedTodos) !== JSON.stringify(_todosCache) ||
      JSON.stringify(mergedProjects) !== JSON.stringify(_projectsCache);

    if (changed) {
      _todosCache = mergedTodos;
      _projectsCache = mergedProjects;
      syncToLocalStorage();
      _saveTodosToDB(mergedTodos);
      _saveProjectsToDB(mergedProjects);
      render();
      showBanner('已从云端同步 ' + mergedTodos.length + ' 条记录');
    }

    // Push merged result back to ensure consistency
    scheduleSyncToGitHub();
  } catch (e) {
    console.warn('Sync pull failed:', e.message);
  }
}

// Force pull: completely replace local data with remote (for recovery)
async function forcePullFromGitHub() {
  if (!getSyncToken()) return false;
  try {
    const remote = await fetchRemoteData();
    if (!remote || !remote.todos) return false;
    _todosCache = remote.todos;
    _projectsCache = remote.projects || [];
    syncToLocalStorage();
    _saveTodosToDB(_todosCache);
    _saveProjectsToDB(_projectsCache);
    render();
    showBanner('已从云端恢复 ' + _todosCache.length + ' 条记录');
    return true;
  } catch (e) {
    console.warn('Force pull failed:', e.message);
    return false;
  }
}

function scheduleSyncToGitHub() {
  if (!getSyncToken()) return;
  if (_syncTimer) clearTimeout(_syncTimer);
  _syncTimer = setTimeout(async () => {
    const ok = await pushRemoteData(_todosCache, _projectsCache);
    if (!ok) {
      // If push failed (e.g. conflict), pull and merge, then retry
      const remote = await fetchRemoteData();
      if (remote && remote.todos) {
        _todosCache = mergeByUpdatedAt(_todosCache, remote.todos);
        _projectsCache = mergeByUpdatedAt(_projectsCache, remote.projects || []);
        syncToLocalStorage();
        _saveTodosToDB(_todosCache);
        _saveProjectsToDB(_projectsCache);
        await pushRemoteData(_todosCache, _projectsCache);
      }
    }
  }, 2000);
}

// Override save functions to trigger sync
const _origSaveTodos = saveTodos;
const _origSaveProjects = saveProjects;
saveTodos = function(todos) {
  _stampUpdatedAt(todos);
  todos.forEach(t => { if (!t.updatedAt) t.updatedAt = nowISO(); });
  _origSaveTodos(todos);
  scheduleSyncToGitHub();
};
saveProjects = function(projects) {
  _stampUpdatedAt(projects);
  projects.forEach(p => { if (!p.updatedAt) p.updatedAt = nowISO(); });
  _origSaveProjects(projects);
  scheduleSyncToGitHub();
};

// ========== Notification Engine ==========

let notifiedToday = new Set();
function loadNotified() {
  try {
    const raw = localStorage.getItem(NOTIFIED_KEY); if (!raw) return;
    const data = JSON.parse(raw); if (data.date === getToday()) notifiedToday = new Set(data.keys);
  } catch {}
}
function saveNotified() {
  localStorage.setItem(NOTIFIED_KEY, JSON.stringify({ date: getToday(), keys: [...notifiedToday] }));
}

function fireNotification(title, body, vibrate) {
  if (Notification.permission !== 'granted') return;
  new Notification(title, { body, icon: 'icon-192.png', tag: 'ai-todo-reminder', requireInteraction: true });
  if (vibrate && navigator.vibrate) navigator.vibrate([200, 100, 200]);
}

function showBanner(text, persistent) {
  const banner = document.getElementById('banner');
  const bannerText = document.getElementById('bannerText');
  banner.style.cursor = persistent ? 'pointer' : '';
  bannerText.textContent = '🔔 ' + text;
  banner.classList.add('show');
  if (banner._timer) clearTimeout(banner._timer);
  if (!persistent) banner._timer = setTimeout(() => banner.classList.remove('show'), 2000);
}

function isExpired(todo) {
  if (todo.completed || !todo.reminderTime || !todo.reminderDate) return false;
  const now = new Date(); const today = getToday();
  if (todo.reminderDate > today) return false;
  if (todo.reminderDate < today) return true;
  const [h, m] = todo.reminderTime.split(':').map(Number);
  return now.getHours() * 60 + now.getMinutes() >= h * 60 + m + 5;
}

function checkAndFireReminders(todos, wideWindow) {
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const today = getToday();
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  for (const t of todos) {
    if (t.completed || !t.reminderTime || t.type !== 'daily') continue;
    if (t.reminderDate && t.reminderDate !== today) continue;
    const key = today + '-' + t.id;
    if (notifiedToday.has(key)) continue;
    const [h, m] = t.reminderTime.split(':').map(Number);
    const todoMinutes = h * 60 + m;
    const shouldFire = wideWindow ? currentMinutes >= todoMinutes : currentMinutes >= todoMinutes && currentMinutes < todoMinutes + 5;
    if (shouldFire) {
      notifiedToday.add(key); saveNotified();
      fireNotification('⏰ 待办提醒', t.text, true);
      if (document.visibilityState === 'visible') {
        showBanner(t.text);
      }
    }
  }

  const summaryKey = today + '-daily-summary';
  const inWindow = currentMinutes >= 8 * 60 && currentMinutes < 8 * 60 + 5;
  if ((inWindow || (wideWindow && currentMinutes >= 8 * 60)) && !notifiedToday.has(summaryKey)) {
    const unset = todos.filter(t => !t.completed && !t.reminderTime && t.type === 'daily');
    const set = todos.filter(t => !t.completed && t.reminderTime && t.type === 'daily');
    const total = unset.length + set.length;
    if (total > 0) {
      notifiedToday.add(summaryKey); saveNotified();
      fireNotification('📋 ' + today + ' ' + weekdays[now.getDay()] + ' 待办汇总',
        '共 ' + total + ' 条待完成：\n' + [...unset.map(t => '· ' + t.text), ...set.map(t => '· ' + t.text + '（' + t.reminderTime + '）')].join('\n'), false);
    }

  }

  checkReviewTime();
}

let scheduleTimer = null;
function restartScheduler(todos) {
  if (scheduleTimer) clearInterval(scheduleTimer);
  loadNotified(); checkAndFireReminders(todos);
  scheduleTimer = setInterval(() => checkAndFireReminders(loadTodos()), 30000);
}

// ========== Review Panel ==========

function reviewDoneToday() { return localStorage.getItem(REVIEW_KEY) === getToday(); }
function markReviewDone() { localStorage.setItem(REVIEW_KEY, getToday()); }

function showReviewPanel() {
  const todos = loadTodos().filter(t => !t.completed && t.type === 'daily' && t.date <= getToday());
  if (todos.length === 0) { showBanner('今天全部完成 ✓'); markReviewDone(); return; }
  document.getElementById('reviewSub').textContent = '共 ' + todos.length + ' 条未完成，设置下次提醒时间';
  const list = document.getElementById('reviewList'); list.innerHTML = '';
  todos.forEach(t => {
    const div = document.createElement('div'); div.className = 'review-item';
    div.innerHTML = '<div class="item-text">' + escapeHtml(t.text) + '</div>' +
      '<input type="text" class="review-input" value="明天" placeholder="明天、后天上午10点...">' +
      '<div class="hint">默认顺延到明天</div>';
    div.querySelector('input').dataset.todoId = t.id; list.appendChild(div);
  });
  document.getElementById('reviewOverlay').classList.add('show');
}

function hideReviewPanel() { document.getElementById('reviewOverlay').classList.remove('show'); }

function applyReview() {
  const inputs = document.querySelectorAll('.review-input');
  const todos = loadTodos();
  inputs.forEach(inp => {
    const id = inp.dataset.todoId; const val = inp.value.trim();
    const todo = todos.find(t => t.id === id); if (!todo) return;
    let targetDate = null, targetTime = null;
    if (val && val !== '明天') {
      const parsed = parseReminderTime(val);
      if (parsed) { const d = new Date(); d.setDate(d.getDate() + (parsed.dateOffset || 0)); targetDate = fmtDate(d); targetTime = parsed.time; }
    }
    if (!targetDate) { const d = new Date(); d.setDate(d.getDate() + 1); targetDate = fmtDate(d); }
    todo.date = targetDate; todo.reminderDate = targetDate; todo.reminderTime = targetTime;
    todo.postponeCount = (todo.postponeCount || 0) + 1;
    if (todo.postponeCount === 3) {
      setTimeout(() => showProcrastinatePopup(todo.text), 300);
    }
  });
  saveTodos(todos); markReviewDone(); hideReviewPanel(); render();
}

function checkReviewTime() {
  if (reviewDoneToday()) return;
  const now = new Date();
  if (now.getHours() * 60 + now.getMinutes() >= 21 * 60 && now.getHours() * 60 + now.getMinutes() < 21 * 60 + 1) {
    showReviewPanel();
  }
}

// ========== Tab State ==========

let currentTab = 'daily';
let currentProjectId = null;
let showReport = false;

function switchTab(tab) {
  if (tab === currentTab) return;
  const view = document.getElementById('viewContent');
  const back = document.getElementById('viewBack');
  const shadow = document.getElementById('curlShadow');
  if (!view || isAnimating) { currentTab = tab; render(); return; }
  isAnimating = true;

  const tabs = ['inspiration', 'daily', 'projects'];
  const forward = tabs.indexOf(tab) > tabs.indexOf(currentTab);
  const outClass = forward ? 'turning-out' : 'turning-out-back';

  // Pre-render target page into back layer so it shows through the curling page
  var savedHTML = view.innerHTML;
  var savedTab = currentTab;
  var savedProjId = currentProjectId;
  var savedTitle = document.getElementById('headerTitle').textContent;
  var savedBackBtn = document.getElementById('backBtn').style.display;
  currentTab = tab;
  currentProjectId = null;
  render();
  back.innerHTML = document.getElementById('viewContent').innerHTML;
  view.innerHTML = savedHTML;
  currentTab = savedTab;
  currentProjectId = savedProjId;
  document.getElementById('headerTitle').textContent = savedTitle;
  document.getElementById('backBtn').style.display = savedBackBtn;

  // Animate fold shadow
  if (shadow) {
    shadow.style.background = forward
      ? 'linear-gradient(to left, rgba(0,0,0,0.12), transparent 50%)'
      : 'linear-gradient(to right, rgba(0,0,0,0.12), transparent 50%)';
    shadow.classList.add('active');
  }

  view.classList.add(outClass);
  view.addEventListener('animationend', function handler() {
    view.removeEventListener('animationend', handler);
    view.classList.remove(outClass);
    if (shadow) shadow.classList.remove('active');

    currentTab = tab;
    currentProjectId = null;
    document.querySelectorAll('.tab-bar button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    render();
    isAnimating = false;
  });
}
let isAnimating = false;

// ========== Todo CRUD ==========

function cyclePriority(id) {
  const todos = loadTodos();
  const todo = todos.find(t => t.id === id);
  if (!todo || todo.completed) return;
  // Cycle: null → important → urgent → both → null
  if (!todo.priority) todo.priority = 'important';
  else if (todo.priority === 'important') todo.priority = 'urgent';
  else if (todo.priority === 'urgent') todo.priority = 'both';
  else todo.priority = null;
  saveTodos(todos);
  render();
}

function addTodo(text, type, projectId) {
  const trimmed = text.trim(); if (!trimmed) return;
  let reminderTime = null, reminderDate = null;
  let debugParts = [];

  if (type === 'daily') {
    const parsed = parseReminderTime(trimmed);
    debugParts.push('time=' + (parsed ? parsed.time : 'none'));
    if (parsed) {
      reminderTime = parsed.time;
      const d = new Date(); d.setDate(d.getDate() + (parsed.dateOffset || 0));
      reminderDate = fmtDate(d);
      if (!parsed.dateOffset) {
        const [h, m] = reminderTime.split(':').map(Number);
        const now = new Date();
        if (h * 60 + m <= now.getHours() * 60 + now.getMinutes()) {
          d.setDate(d.getDate() + 1); reminderDate = fmtDate(d);
        }
      }
    }
  }

  debugParts.push('text=' + trimmed.slice(0, 20));

  const todos = loadTodos();
  todos.unshift({
    id: genId(), text: trimmed, completed: false,
    date: getToday(), completedDate: null,
    type, projectId: projectId || null,
    reminderTime, reminderDate, priority: null,
    linkGroup: null, postponeCount: 0,
    updatedAt: nowISO(),
  });
  saveTodos(todos); render();
}

function toggleTodo(id) {
  const todos = loadTodos();
  const todo = todos.find(t => t.id === id); if (!todo) return;
  const newState = !todo.completed;
  const newDate = newState ? getToday() : null;

  // Toggle all linked todos (same linkGroup)
  const group = todo.linkGroup;
  if (group) {
    todos.forEach(t => {
      if (t.linkGroup === group) {
        t.completed = newState;
        t.completedDate = newDate;
        if (newState) t.postponeCount = 0;
      }
    });
  } else {
    todo.completed = newState;
    todo.completedDate = newDate;
    if (newState) todo.postponeCount = 0;
  }
  saveTodos(todos); render();
}


function deleteTodo(id) {
  saveTodos(loadTodos().filter(t => t.id !== id)); render();
}

function startEdit(todoId) {
  const todos = loadTodos();
  const todo = todos.find(t => t.id === todoId);
  if (!todo || todo.completed) return;

  const li = document.querySelector('.todo-item[data-id="' + todoId + '"]');
  if (!li || li._editing) return;
  li._editing = true;

  const textSpan = li.querySelector('.text');
  if (!textSpan) return;
  textSpan._originalHTML = textSpan.innerHTML;
  textSpan.innerHTML = '';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'todo-edit-input';
  input.value = todo.text;
  textSpan.appendChild(input);
  input.focus();
  input.setSelectionRange(0, input.value.length);

  let handled = false;
  function finish(save) {
    if (handled) return;
    handled = true;
    li._editing = false;
    if (save) {
      const newText = input.value.trim();
      if (newText && newText !== todo.text) {
        todo.text = newText;
        todo.updatedAt = nowISO();
        saveTodos(todos);
      }
    }
    render();
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { finish(false); }
  });
  input.addEventListener('blur', () => setTimeout(() => finish(true), 150));
}

// ========== Projects ==========

function addProject(name) {
  const trimmed = name.trim(); if (!trimmed) return;
  const projects = loadProjects();
  projects.push({ id: genId(), name: trimmed, createdAt: getToday(), updatedAt: nowISO() });
  saveProjects(projects); render();
}

function deleteProject(id) {
  saveProjects(loadProjects().filter(p => p.id !== id));
  // Also delete all todos in this project
  saveTodos(loadTodos().filter(t => t.projectId !== id));
  render();
}

function getProjectStats(projectId) {
  const todos = loadTodos().filter(t => t.projectId === projectId);
  const total = todos.length;
  const done = todos.filter(t => t.completed).length;
  return { total, done, pct: total > 0 ? Math.round(done / total * 100) : 0 };
}

// ========== Procrastination Popup ==========

function showProcrastinatePopup(text) {
  const el = document.createElement('div');
  el.className = 'procrastinate-popup';
  el.innerHTML = '<div class="proc-emoji">😴</div>' +
    '<div class="proc-sign">这事儿咱拖了三天了……</div>' +
    '<div class="proc-text">' + escapeHtml(text) + '</div>';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ========== Render Helpers ==========

function escapeHtml(str) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return str.replace(/[&<>"']/g, c => map[c]);
}

function renderTodoItem(todo, showDelete) {
  const li = document.createElement('li');
  const expired = isExpired(todo);
  li.className = 'todo-item' + (todo.completed ? ' completed' : '') + (expired ? ' expired' : '');

  let badgeHtml = '', textPrefix = '';
  if (todo.type === 'daily' && todo.reminderTime && !todo.completed) {
    if (expired) {
      textPrefix = '<span style="font-size:12px;color:var(--danger);font-weight:600;">已过期 · 原定' + todo.reminderTime + ' </span>';
    } else if (todo.reminderDate && todo.reminderDate !== getToday()) {
      const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
      const after = new Date(); after.setDate(after.getDate() + 2);
      const label = todo.reminderDate === fmtDate(tomorrow) ? '明天' : todo.reminderDate === fmtDate(after) ? '后天' : todo.reminderDate;
      badgeHtml = '<span class="time-badge">🔔 ' + label + ' ' + todo.reminderTime + '</span>';
    } else {
      badgeHtml = '<span class="time-badge">🔔 ' + todo.reminderTime + '</span>';
    }
  }

  li.innerHTML = '<span class="circle"></span><span class="text">' + textPrefix + escapeHtml(todo.text) + '</span>' + badgeHtml +
    (showDelete ? '<button class="delete-btn" data-action="delete">×</button>' : '');

  li.addEventListener('click', (e) => { if (e.target.closest('[data-action="delete"]')) return; toggleTodo(todo.id); });
  const delBtn = li.querySelector('.delete-btn');
  if (delBtn) delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteTodo(todo.id); });
  return li;
}

// ========== Tab Renderers ==========

function renderInspiration() {
  document.getElementById('headerTitle').textContent = '灵感';
  document.getElementById('backBtn').style.display = 'none';
  const today = getToday();
  const todos = loadTodos().filter(t => t.type === 'inspiration');
  const active = todos.filter(t => !t.completed);
  const done = todos.filter(t => t.completed && t.completedDate === today);

  let html = '<form class="input-row" id="inspForm">' +
    '<input type="text" id="inspInput" placeholder="记下灵感..." autocomplete="off" maxlength="200">' +
    '<button type="submit">+</button></form>';

  html += '<div class="section-title">灵感记录 (' + active.length + ')</div><ul class="todo-list" id="inspList">';
  if (active.length === 0) html += '<li class="empty">暂无灵感</li>';
  else active.forEach(t => {
    html += '<li class="todo-item" data-id="' + t.id + '"><span class="circle"></span><span class="text">' + escapeHtml(t.text) + '</span>' +
      '<button class="delete-btn" data-action="delete">×</button></li>';
  });
  html += '</ul>';

  if (done.length > 0) {
    html += '<div class="section-title">已完成 (' + done.length + ')</div><ul class="todo-list">';
    done.forEach(t => {
      html += '<li class="todo-item completed" data-id="' + t.id + '"><span class="circle"></span><span class="text">' + escapeHtml(t.text) + '</span></li>';
    });
    html += '</ul>';
  }

  document.getElementById('viewContent').innerHTML = html;
  bindListEvents();
  document.getElementById('inspForm').addEventListener('submit', (e) => {
    e.preventDefault(); const inp = document.getElementById('inspInput');
    addTodo(inp.value, 'inspiration'); inp.value = ''; inp.focus();
  });
}

function priorityBtn(todo) {
  const label = todo.priority === 'both' ? '🔥 重急' : todo.priority === 'important' ? '⭐ 重要' :
    todo.priority === 'urgent' ? '⚡ 紧急' : '+ 优先级';
  return '<button class=\"priority-btn\" data-action=\"pri-menu\" data-id=\"' + todo.id + '\">' + label + '</button>';
}


// Priority weight: both > urgent > important > null
const PRI_WEIGHT = { both: 0, urgent: 1, important: 2, null: 3 };

function prioritySort(a, b) {
  const today = getToday();

  // 1. Priority
  const aPri = PRI_WEIGHT[a.priority] ?? 3;
  const bPri = PRI_WEIGHT[b.priority] ?? 3;
  if (aPri !== bPri) return aPri - bPri;

  // 2. Same priority: today's timed items first, sorted by time
  const aTime = a.reminderTime && a.reminderDate === today;
  const bTime = b.reminderTime && b.reminderDate === today;
  if (aTime && bTime) {
    const cmp = a.reminderTime.localeCompare(b.reminderTime);
    if (cmp !== 0) return cmp;
  }
  if (aTime && !bTime) return -1;
  if (!aTime && bTime) return 1;

  // 3. Same priority, same time status → alphabetically
  return a.text.localeCompare(b.text);
}


function renderDaily() {
  document.getElementById('headerTitle').textContent = '日常';
  document.getElementById('backBtn').style.display = 'none';
  const today = getToday();
  const allTodos = loadTodos().filter(t => t.type === 'daily');
  const allActive = allTodos.filter(t => !t.completed && t.date <= today);
  const completedToday = allTodos.filter(t => t.completed && t.completedDate === today);

  // Split: today vs future
  const todayItems = allActive.filter(t => !t.reminderDate || t.reminderDate <= today);
  const futureItems = allActive.filter(t => t.reminderDate && t.reminderDate > today);

  // Sort today's items by priority, then time
  const sorted = [...todayItems].sort(prioritySort);

  // Sort future items by date, then priority, then time
  const sortedFuture = [...futureItems].sort((a, b) => {
    const d = (a.reminderDate || '9').localeCompare(b.reminderDate || '9');
    if (d !== 0) return d;
    const aPri = PRI_WEIGHT[a.priority] ?? 3;
    const bPri = PRI_WEIGHT[b.priority] ?? 3;
    if (aPri !== bPri) return aPri - bPri;
    return (a.reminderTime || '99:99').localeCompare(b.reminderTime || '99:99');
  });

  let html = '<form class="input-row" id="dailyForm">' +
    '<input type="text" id="dailyInput" placeholder="添加待办，如：下午4:00 跟大源对方案" autocomplete="off" maxlength="200">' +
    '<button type="button" class="mic-btn" id="micBtn" title="语音输入">🎤</button>' +
    '<button type="submit">+</button></form>';

  html += '<div class="section-title">今天 (' + todayItems.length + ')</div><ul class="todo-list" id="activeList">';
  if (sorted.length === 0) html += '<li class="empty">今天没有待办 🎉</li>';
  else sorted.forEach(t => {
    html += '<li class="todo-item' + (isExpired(t) ? ' expired' : '') + '" data-id="' + t.id + '">' +
      '<span class="circle"></span>' +
      (t.postponeCount >= 3 ? '<span style="font-size:16px;flex-shrink:0;" title="拖了' + t.postponeCount + '天">😴</span>' : '') +
      '<span class="text">' + (isExpired(t) ? '<span style="font-size:12px;color:var(--danger);font-weight:600;">已过期 · 原定' + t.reminderTime + ' </span>' : '') + escapeHtml(t.text) + '</span>' +
      (t.reminderTime ? '<span class="time-badge">🔔 ' + t.reminderTime + '</span>' : '') +
      
      priorityBtn(t) +
      '<button class="delete-btn" data-action="delete">×</button></li>';
  });
  html += '</ul>';

  // Future items
  if (sortedFuture.length > 0) {
    html += '<div class="section-title">即将到来 (' + sortedFuture.length + ')</div><ul class="todo-list" id="futureList">';
    sortedFuture.forEach(t => {
      const dateLabel = formatDateLabel(t.reminderDate);
      html += '<li class="todo-item future-item" data-id="' + t.id + '">' +
        '<span class="circle"></span>' +
        '<span class="text">' + escapeHtml(t.text) + '</span>' +
        '<span class="time-badge" style="opacity:0.6;">' + dateLabel + (t.reminderTime ? ' ' + t.reminderTime : '') + '</span>' +
        priorityBtn(t) +
        
        '<button class="delete-btn" data-action="delete">×</button></li>';
    });
    html += '</ul>';
  }

  if (completedToday.length > 0) {
    html += '<div class="section-title section-toggle" id="completedLabel"><span>已完成 (' + completedToday.length + ')</span><span class="chevron" id="completedChevron">▾</span></div>';
    html += '<ul class="todo-list" id="completedList">';
    completedToday.forEach(t => {
      html += '<li class="todo-item completed" data-id="' + t.id + '"><span class="circle"></span><span class="text">' + escapeHtml(t.text) + '</span></li>';
    });
    html += '</ul>';
    html += '<div style="text-align:center;margin-top:8px;"><button id="openReportBtn" style="font-size:13px;color:var(--accent);background:none;border:none;cursor:pointer;">📊 已完成报告</button></div>';
  }

  document.getElementById('viewContent').innerHTML = html;
  bindListEvents();

  // Report button
  const reportBtn = document.getElementById('openReportBtn');
  if (reportBtn) reportBtn.addEventListener('click', renderCompletedReport);

  document.getElementById('dailyForm').addEventListener('submit', (e) => {
    e.preventDefault(); const inp = document.getElementById('dailyInput');
    addTodo(inp.value, 'daily'); inp.value = ''; inp.focus();
  });


  // Voice input
  setupVoiceInput();

  // Completed collapse
  const label = document.getElementById('completedLabel');
  if (label) {
    const list = document.getElementById('completedList');
    const collapsed = localStorage.getItem(COLLAPSED_KEY) === '1';
    if (collapsed) { label.classList.add('collapsed'); list.style.display = 'none'; }
    label.addEventListener('click', () => {
      const isCollapsed = label.classList.toggle('collapsed');
      list.style.display = isCollapsed ? 'none' : '';
      localStorage.setItem(COLLAPSED_KEY, isCollapsed ? '1' : '0');
    });
  }

  restartScheduler(loadTodos());
}

function renderProjects() {
  document.getElementById('headerTitle').textContent = '项目';
  document.getElementById('backBtn').style.display = 'none';
  const projects = loadProjects();

  let html = '<div class="new-project-row"><input type="text" id="newProjInput" placeholder="新建项目..." maxlength="50"><button id="newProjBtn">创建</button></div>';

  if (projects.length === 0) {
    html += '<div class="empty">暂无项目，创建一个吧</div>';
  } else {
    projects.forEach(p => {
      const stats = getProjectStats(p.id);
      html += '<div class="project-item" data-proj-id="' + p.id + '">' +
        '<div class="proj-info"><div class="proj-name">' + escapeHtml(p.name) + '</div>' +
        '<div class="proj-bar"><div class="proj-bar-fill" style="width:' + stats.pct + '%"></div></div>' +
        '<div class="proj-stat">' + stats.done + '/' + stats.total + ' · ' + stats.pct + '%</div></div>' +
        '<button class="proj-delete" data-action="del-proj">×</button></div>';
    });
  }

  document.getElementById('viewContent').innerHTML = html;

  document.getElementById('newProjBtn').addEventListener('click', () => {
    const inp = document.getElementById('newProjInput');
    addProject(inp.value); inp.value = '';
  });
  document.getElementById('newProjInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('newProjBtn').click(); }
  });

  // Tap project → detail
  document.querySelectorAll('.project-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="del-proj"]')) return;
      renderProjectDetail(el.dataset.projId);
    });
  });

  // Delete project
  document.querySelectorAll('[data-action="del-proj"]').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); deleteProject(btn.closest('.project-item').dataset.projId); });
  });
}

function renderProjectDetail(projectId) {
  currentProjectId = projectId;
  const project = loadProjects().find(p => p.id === projectId);
  if (!project) { renderProjects(); return; }

  document.getElementById('headerTitle').textContent = project.name;
  document.getElementById('backBtn').style.display = '';
  const todos = loadTodos().filter(t => t.projectId === projectId);
  const active = todos.filter(t => !t.completed);
  const done = todos.filter(t => t.completed);

  let html = '<form class="input-row" id="projForm">' +
    '<input type="text" id="projInput" placeholder="添加待办..." autocomplete="off" maxlength="200">' +
    '<button type="submit">+</button></form>';

  const stats = getProjectStats(projectId);
  html += '<div class="section-title">' + stats.done + '/' + stats.total + ' · ' + stats.pct + '%</div>';

  const sortedActive = [...active].sort(prioritySort);

  html += '<ul class="todo-list">';
  if (sortedActive.length === 0 && done.length === 0) html += '<li class="empty">暂无待办</li>';
  else {
    sortedActive.forEach(t => {
      html += '<li class="todo-item" data-id="' + t.id + '">' +
        '<span class="circle"></span>' +
        '<span class="text">' + escapeHtml(t.text) + '</span>' +
        priorityBtn(t) +
        
        '<button class="delete-btn" data-action="delete">×</button></li>';
    });
    done.forEach(t => {
      html += '<li class="todo-item completed" data-id="' + t.id + '"><span class="circle"></span><span class="text">' + escapeHtml(t.text) + '</span></li>';
    });
  }
  html += '</ul>';

  document.getElementById('viewContent').innerHTML = html;
  bindListEvents();

  document.getElementById('projForm').addEventListener('submit', (e) => {
    e.preventDefault(); const inp = document.getElementById('projInput');
    addTodo(inp.value, 'project', projectId); inp.value = ''; inp.focus();
  });
}

// Priority menu
let _priorityMenuTodoId = null;
function showPriorityMenu(todoId) {
  _priorityMenuTodoId = todoId;
  const todos = loadTodos();
  const todo = todos.find(t => t.id === todoId);
  if (!todo) return;
  // Highlight current priority
  document.querySelectorAll('.priority-menu-item').forEach(item => {
    item.classList.toggle('active',
      (item.dataset.pri === 'null' && !todo.priority) || item.dataset.pri === todo.priority);
  });
  document.getElementById('priorityMenuOverlay').classList.add('show');
  try { navigator.vibrate(10); } catch {}
}

function hidePriorityMenu() {
  document.getElementById('priorityMenuOverlay').classList.remove('show');
  _priorityMenuTodoId = null;
}

function setPriorityFromMenu(pri) {
  if (!_priorityMenuTodoId) return;
  const todos = loadTodos();
  const todo = todos.find(t => t.id === _priorityMenuTodoId);
  if (!todo) return;
  todo.priority = pri === 'null' ? null : pri;
  todo.updatedAt = nowISO();
  saveTodos(todos);
  hidePriorityMenu();
  render();
}

function bindListEvents() {
  document.querySelectorAll('.todo-item').forEach(el => {
    if (el._bound) return; el._bound = true;

    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="delete"]')) {
        e.stopPropagation();
        deleteTodo(el.dataset.id);
      } else if (e.target.closest('[data-action="pri-menu"]')) {
        e.stopPropagation();
        showPriorityMenu(e.target.closest('[data-action="pri-menu"]').dataset.id);
      } else if (e.target.closest('[data-action="cycle-priority"]')) {
        e.stopPropagation();
        const id = e.target.closest('[data-action="cycle-priority"]').dataset.id;
        cyclePriority(id);
      } else if (e.target.closest('.circle')) {
        toggleTodo(el.dataset.id);
      } else if (e.target.closest('.text')) {
        startEdit(el.dataset.id);
      } else {
        toggleTodo(el.dataset.id);
      }
    });
  });
}

// ========== Voice Input ==========

function setupVoiceInput() {
  const micBtn = document.getElementById('micBtn');
  if (!micBtn) return;

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    micBtn.disabled = true;
    micBtn.classList.add('disabled');
    micBtn.title = '浏览器不支持语音';
    return;
  }

  let recognition = null;
  let silenceTimer = null;

  function resetSilence() {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      if (recognition) recognition.stop();
    }, 2000);
  }

  micBtn.addEventListener('click', () => {
    if (recognition) {
      // Stop recording
      recognition.stop();
      return;
    }

    // Start recording
    recognition = new SpeechRecognition();
    recognition.lang = 'zh-CN';
    recognition.interimResults = true;
    recognition.continuous = true;

    recognition.onresult = (e) => {
      let transcript = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        transcript += e.results[i][0].transcript;
      }
      document.getElementById('dailyInput').value = transcript;
      resetSilence();
    };

    recognition.onerror = () => {
      stopRecording();
    };

    recognition.onend = () => {
      stopRecording();
    };

    recognition.start();
    micBtn.textContent = '🔴';
    micBtn.classList.add('recording');
    resetSilence();
  });

  function stopRecording() {
    if (silenceTimer) clearTimeout(silenceTimer);
    recognition = null;
    micBtn.textContent = '🎤';
    micBtn.classList.remove('recording');
  }
}

// ========== Completed Report ==========

function getWeekStart() {
  const d = new Date();
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1; // Monday start
  d.setDate(d.getDate() - diff);
  return fmtDate(d);
}

let reportTab = 'daily'; // 'daily' | 'project'

function renderCompletedReport() {
  document.getElementById('headerTitle').textContent = '已完成报告';
  document.getElementById('backBtn').style.display = '';

  const today = getToday();
  const weekStart = getWeekStart();
  const allDone = loadTodos().filter(t => t.completed);
  const filtered = allDone.filter(t => reportTab === 'project' ? t.type === 'project' : t.type === 'daily');

  const todayDone = filtered.filter(t => t.completedDate === today).length;
  const weekDone = filtered.filter(t => t.completedDate >= weekStart).length;
  const totalDone = filtered.length;

  const sorted = [...filtered].sort((a, b) => (b.completedDate || '').localeCompare(a.completedDate || ''));

  let html =
    '<div class="filter-bar">' +
    '<button class="filter-pill' + (reportTab === 'daily' ? ' active' : '') + '" data-report-tab="daily">📋 日常</button>' +
    '<button class="filter-pill' + (reportTab === 'project' ? ' active' : '') + '" data-report-tab="project">📁 项目</button>' +
    '</div>' +

    '<div class="report-stats">' +
    '<div class="report-stat"><span>今日完成</span><span class="val">' + todayDone + ' 条</span></div>' +
    '<div class="report-stat"><span>本周完成</span><span class="val">' + weekDone + ' 条</span></div>' +
    '<div class="report-stat"><span>总计完成</span><span class="val">' + totalDone + ' 条</span></div>' +
    '</div>';

  if (sorted.length === 0) {
    html += '<div class="empty">暂无已完成记录</div>';
  } else {
    sorted.forEach(t => {
      html += '<div class="report-item">' +
        '<div class="text">' + escapeHtml(t.text) + '</div>' +
        '<div class="meta">' + (t.completedDate || '') + '</div>' +
        '</div>';
    });
  }

  document.getElementById('viewContent').innerHTML = html;

  document.querySelectorAll('[data-report-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      reportTab = btn.dataset.reportTab; renderCompletedReport();
    });
  });
}

// ========== Main Render ==========

function render() {
  document.getElementById('dateDisplay').textContent = (() => {
    const today = getToday(); const [y, m, d] = today.split('-');
    return m + '月' + d + '日 ' + ['周日','周一','周二','周三','周四','周五','周六'][new Date(today).getDay()];
  })();

  if (currentProjectId) { renderProjectDetail(currentProjectId); return; }
  if (currentTab === 'inspiration') renderInspiration();
  else if (currentTab === 'projects') renderProjects();
  else renderDaily();
}

// ========== Init ==========

// One-time setup via URL parameter: ?setup=TOKEN
(function() {
  const p = new URLSearchParams(location.search);
  const token = p.get('setup');
  if (token && (token.startsWith('ghp_') || token.startsWith('github_pat_'))) {
    localStorage.setItem(SYNC_TOKEN_KEY, token);
    history.replaceState({}, '', location.pathname);
    location.reload();
  }
})();

document.addEventListener('DOMContentLoaded', async () => {
  await initStorage();
  render();
  // Pull from GitHub after render (non-blocking)
  syncFromGitHub();

  // Tap/click banner to dismiss
  document.getElementById('banner').addEventListener('click', () => {
    document.getElementById('banner').classList.remove('show');
  });

  // Tab switching
  document.querySelectorAll('.tab-bar button').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Back button (project detail → project list)
  document.getElementById('backBtn').addEventListener('click', () => {
    currentProjectId = null; render();
  });

  // Date tap 3x for review panel test
  let dateTapCount = 0;
  document.getElementById('dateDisplay').addEventListener('click', () => {
    dateTapCount++;
    if (dateTapCount >= 3) { dateTapCount = 0; showReviewPanel(); }
    setTimeout(() => { dateTapCount = 0; }, 800);
  });

  // Review panel
  document.getElementById('reviewConfirm').addEventListener('click', applyReview);
  document.getElementById('reviewOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) hideReviewPanel();
  });


  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(reg => {
      // Auto-reload when SW sends NEW_VERSION message
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'NEW_VERSION') {
          window.location.reload();
        }
      });
      // On update found, auto skipWaiting and reload
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            newWorker.postMessage('skipWaiting');
          }
        });
      });
    });
    // Check for updates every 5 minutes
    setInterval(() => { navigator.serviceWorker.getRegistration().then(r => r && r.update()); }, 300000);
  }

  // === Menu Toggle ===
  const menuBtn = document.getElementById('menuBtn');
  const menuDropdown = document.getElementById('menuDropdown');
  menuBtn.addEventListener('click', (e) => { e.stopPropagation(); menuDropdown.classList.toggle('show'); });
  document.addEventListener('click', (e) => {
    if (!menuDropdown.contains(e.target) && e.target !== menuBtn) menuDropdown.classList.remove('show');
  });
  menuDropdown.addEventListener('click', () => menuDropdown.classList.remove('show'));

  // === Theme Switcher ===
  const THEME_KEY = 'ai-todo-theme';
  const themes = [
    { id: 'paper', name: '宣纸', desc: '暖色纸质书质感', dot: 'paper' },
    { id: 'zen',   name: '禅意', desc: '大量留白，专注极简', dot: 'zen' },
    { id: 'pop',   name: '活力', desc: '粗边框、亮色、年轻感', dot: 'pop' },
    { id: 'dark',  name: '暗夜', desc: '护眼深色模式', dot: 'dark' },
  ];

  function getTheme() { return localStorage.getItem(THEME_KEY) || 'paper'; }
  function setTheme(id) {
    localStorage.setItem(THEME_KEY, id);
    document.documentElement.setAttribute('data-theme', id);
    document.querySelector('meta[name="theme-color"]').content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    renderThemeList();
  }

  function renderThemeList() {
    const list = document.getElementById('themeList');
    if (!list) return;
    const current = getTheme();
    list.innerHTML = themes.map(t => `
      <div class="theme-opt${t.id === current ? ' active' : ''}" data-theme="${t.id}">
        <div class="theme-dot ${t.dot}"></div>
        <div class="theme-info">
          <div class="theme-name">${t.name}</div>
          <div class="theme-desc">${t.desc}</div>
        </div>
      </div>`).join('');
    list.querySelectorAll('.theme-opt').forEach(el => {
      el.addEventListener('click', () => setTheme(el.dataset.theme));
    });
  }

  document.getElementById('themeBtn').addEventListener('click', () => {
    renderThemeList();
    document.getElementById('themeOverlay').classList.add('show');
  });
  document.getElementById('themeOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) document.getElementById('themeOverlay').classList.remove('show');
  });

  // === Font Switcher ===
  const FONT_KEY = 'ai-todo-font';
  const fonts = [
    { id: 'default', name: '系统默认', sample: '跟随主题，清爽现代', stack: '' },
    { id: 'song',    name: '宋体',     sample: '书卷气，温润典雅', stack: '"Songti SC", "Noto Serif SC", "STSong", "SimSun", serif' },
    { id: 'kai',     name: '楷体',     sample: '手写感，自然舒展', stack: '"Kaiti SC", "STKaiti", "KaiTi", "AR PL UKai CN", serif' },
    { id: 'hei',     name: '黑体',     sample: '简洁有力，现代商务', stack: '"Heiti SC", "STHeitiSC", "SimHei", "Noto Sans SC", "Microsoft YaHei", sans-serif' },
    { id: 'fangsong',name: '仿宋',     sample: '纤细雅致，公文书卷', stack: '"STFangsong", "FangSong", "FangSong_GB2312", "Noto Serif SC", serif' },
    { id: 'yuan',    name: '圆体',     sample: '圆润温和，亲和力强', stack: '"STYuanti-SC", "Yuanti SC", "PingFang SC", "Noto Sans SC", sans-serif' },
    { id: 'xingkai', name: '行楷',     sample: '潇洒流畅，半行半楷', stack: '"Xingkai SC", "STKaiti", "KaiTi", "AR PL UKai CN", serif' },
    { id: 'hanzi',   name: '翩翩体',   sample: '轻快灵巧，钢笔手写', stack: '"HanziPen SC", "STKaiti", "KaiTi", serif' },
    { id: 'hanno',   name: '手札体',   sample: '质朴自然，书法笔记', stack: '"Hannotate SC", "STKaiti", "KaiTi", serif' },
    { id: 'weibei',  name: '魏碑',     sample: '刚劲有力，碑刻风骨', stack: '"Weibei SC", "STSong", "SimSun", "Noto Serif SC", serif' },
  ];

  function getFont() { return localStorage.getItem(FONT_KEY) || 'default'; }
  function setFont(id) {
    localStorage.setItem(FONT_KEY, id);
    const font = fonts.find(f => f.id === id);
    if (font && font.stack) {
      document.documentElement.style.setProperty('--font', font.stack);
    } else {
      document.documentElement.style.removeProperty('--font');
    }
    renderFontList();
  }

  function renderFontList() {
    const list = document.getElementById('fontList');
    if (!list) return;
    const current = getFont();
    list.innerHTML = fonts.map(f => `
      <div class="font-opt${f.id === current ? ' active' : ''}" data-font="${f.id}">
        <span class="font-name">${f.name}</span>
        <span class="font-sample" style="font-family:${f.stack || 'inherit'}">${f.sample}</span>
      </div>`).join('');
    list.querySelectorAll('.font-opt').forEach(el => {
      el.addEventListener('click', () => setFont(el.dataset.font));
    });
  }

  function showFontOverlay() {
    renderFontList();
    document.getElementById('fontOverlay').classList.add('show');
    document.body.classList.add('no-scroll');
  }
  function hideFontOverlay() {
    document.getElementById('fontOverlay').classList.remove('show');
    document.body.classList.remove('no-scroll');
  }

  document.getElementById('fontBtn').addEventListener('click', showFontOverlay);
  document.getElementById('fontOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) hideFontOverlay();
  });

  // Apply saved font on load
  setFont(getFont());

  // Apply saved theme on load
  setTheme(getTheme());

  // === Priority menu handlers ===
  document.getElementById('priorityMenuOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) hidePriorityMenu();
  });
  document.getElementById('priorityMenuCancel').addEventListener('click', hidePriorityMenu);
  document.querySelectorAll('.priority-menu-item').forEach(item => {
    item.addEventListener('click', () => setPriorityFromMenu(item.dataset.pri));
  });

  // === Swipe navigation (interactive page-turn with underlying page reveal) ===
  (function setupSwipe() {
    var tabs = ['inspiration', 'daily', 'projects'];
    var MAX_DRAG = 300;
    var THRESHOLD = 10;
    var COMPLETE_PCT = 0.35;

    var startX = 0, startY = 0;
    var swiping = false;
    var settling = false;
    var direction = null;
    var targetTab = null;
    var preRendered = false;

    var view = document.getElementById('viewContent');
    var back = document.getElementById('viewBack');
    var shadowEl = document.getElementById('curlShadow');
    var app = document.querySelector('.app');
    if (!app || !view) return;

    function cleanup() {
      settling = false;
      swiping = false;
      direction = null;
      targetTab = null;
      preRendered = false;
      view.style.transition = '';
      view.classList.remove('dragging', 'spring-back');
      view.style.transform = '';
      view.style.transformOrigin = '';
	      view.style.opacity = '';
	      back.innerHTML = '';
	      if (shadowEl) { shadowEl.style.opacity = ''; shadowEl.style.background = ''; }
    }

    // Pre-render target tab content into back layer (the "next page" underneath)
    // Called via setTimeout to avoid blocking the touchmove frame
    function preRenderTarget() {
      if (preRendered) return;
      preRendered = true;
      var savedHTML = view.innerHTML;
      var savedTab = currentTab;
      var savedTitle = document.getElementById('headerTitle').textContent;
      var savedBackBtn = document.getElementById('backBtn').style.display;
      currentTab = targetTab;
      render();
      back.innerHTML = view.innerHTML.replace(/\s+id="[^"]*"/g, '');
      view.innerHTML = savedHTML;
      currentTab = savedTab;
      document.getElementById('headerTitle').textContent = savedTitle;
      document.getElementById('backBtn').style.display = savedBackBtn;
    }

    app.addEventListener('touchstart', function(e) {
      if (settling || currentProjectId) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      swiping = false;
      direction = null;
      targetTab = null;
      preRendered = false;
      back.innerHTML = '';
    }, { passive: true });

    app.addEventListener('touchmove', function(e) {
      if (settling || currentProjectId) return;

      var dx = e.changedTouches[0].clientX - startX;
      var dy = e.changedTouches[0].clientY - startY;

      if (!swiping) {
        if (Math.abs(dx) < THRESHOLD || Math.abs(dx) < Math.abs(dy)) return;
        var idx = tabs.indexOf(currentTab);
        if (dx < 0 && idx < tabs.length - 1) {
          direction = 'forward';
          targetTab = tabs[idx + 1];
        } else if (dx > 0 && idx > 0) {
          direction = 'back';
          targetTab = tabs[idx - 1];
        } else { return; }
        swiping = true;
        view.classList.add('dragging');
        view.style.transformOrigin = direction === 'forward' ? 'left center' : 'right center';
        // Defer heavy render so this frame stays smooth
        setTimeout(preRenderTarget, 0);
      }

      e.preventDefault();

      var angle = Math.max(-88, Math.min(88, (dx / MAX_DRAG) * 90));
      if (direction === 'forward') angle = Math.min(0, angle);
      else angle = Math.max(0, angle);

      var absAngle = Math.abs(angle);
	      view.style.transform = 'rotateY(' + angle + 'deg) scaleX(' + (1 - absAngle * 0.001) + ')';
	      view.style.opacity = 1 - absAngle / 130;
	      if (shadowEl && back.innerHTML) {
	        shadowEl.style.opacity = absAngle / 88;
	        shadowEl.style.background = direction === 'forward'
	          ? 'linear-gradient(to left, rgba(0,0,0,0.12), transparent 50%)'
	          : 'linear-gradient(to right, rgba(0,0,0,0.12), transparent 50%)';
	      }
    }, { passive: false });

    app.addEventListener('touchend', function(e) {
      if (!swiping || settling) { cleanup(); return; }

      var dx = e.changedTouches[0].clientX - startX;
      var angle = Math.max(-88, Math.min(88, (dx / MAX_DRAG) * 90));
      if (direction === 'forward') angle = Math.min(0, angle);
      else angle = Math.max(0, angle);

      var pct = Math.abs(angle) / 88;
      view.classList.remove('dragging');

      if (pct > COMPLETE_PCT) {
        settling = true;
        var target = direction === 'forward' ? -88 : 88;
        view.style.transform = 'rotateY(' + target + 'deg) scaleX(0.9)';
	        view.style.opacity = '0.25';

        view.addEventListener('transitionend', function finish(e) {
          if (e.propertyName !== 'transform') return;
          view.removeEventListener('transitionend', finish);
          view.style.transition = 'none';
          view.style.transform = '';
          view.style.opacity = '';
          cleanup();
          currentTab = targetTab;
          currentProjectId = null;
          document.querySelectorAll('.tab-bar button').forEach(function(b) { b.classList.toggle('active', b.dataset.tab === targetTab); });
          render();
        });
      } else {
        settling = true;
        view.classList.add('spring-back');
        view.style.transform = 'rotateY(0deg) scaleX(1)';
        view.style.opacity = '1';

        view.addEventListener('transitionend', function bounce(e) {
          if (e.propertyName !== 'transform') return;
          view.removeEventListener('transitionend', bounce);
          cleanup();
        });
      }
    });
  })();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    loadNotified();
    checkAndFireReminders(loadTodos(), true);
    render();
    // Pull latest from GitHub when app comes to foreground
    syncFromGitHub();
  }
});
