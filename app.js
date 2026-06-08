// v2
// ========== Config ==========

const DEEPSEEK_KEY = 'sk-adfe808bbd3c4932938a0689a60a5be9';

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
  return localStorage.getItem(SYNC_TOKEN_KEY) || '';
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
    const json = JSON.parse(decodeURIComponent(escape(raw)));
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

    const content = btoa(unescape(encodeURIComponent(JSON.stringify({ todos, projects }))));
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
    if (!existing || (item.updatedAt > existing.updatedAt)) {
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

    const mergedTodos = mergeByUpdatedAt(_todosCache, remote.todos);
    const mergedProjects = mergeByUpdatedAt(_projectsCache, remote.projects || []);

    // Check if anything changed
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

    // Also push local changes that remote didn't have
    scheduleSyncToGitHub();
  } catch (e) {
    console.warn('Sync pull failed:', e.message);
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
  if (!persistent) banner._timer = setTimeout(() => banner.classList.remove('show'), 5000);
}

function isExpired(todo) {
  if (todo.completed || !todo.reminderTime || !todo.reminderDate) return false;
  const now = new Date(); const today = getToday();
  if (todo.reminderDate > today) return false;
  if (todo.reminderDate < today) return true;
  const [h, m] = todo.reminderTime.split(':').map(Number);
  return now.getHours() * 60 + now.getMinutes() >= h * 60 + m + 5;
}

function updateBadge(todos) {
  const badge = document.getElementById('badge');
  const expired = todos.filter(t => isExpired(t)).length;
  if (expired > 0) { badge.textContent = expired; badge.classList.add('show'); }
  else { badge.classList.remove('show'); }
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

    // AI priority sort at 8 AM
    if (!wideWindow) fetchAIPrioritySort();
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
  checkMusicTrigger('evening');
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
  if (!view || isAnimating) { currentTab = tab; render(); return; }
  isAnimating = true;

  view.classList.add('turning-out');
  view.addEventListener('animationend', function handler() {
    view.removeEventListener('animationend', handler);
    view.classList.remove('turning-out');

    currentTab = tab;
    currentProjectId = null;
    document.querySelectorAll('.tab-bar button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    render();

    requestAnimationFrame(() => {
      view.classList.add('turning-in');
      view.addEventListener('animationend', function h2() {
        view.removeEventListener('animationend', h2);
        view.classList.remove('turning-in');
        isAnimating = false;
      });
    });
  });
}

let isAnimating = false;

// ========== Todo CRUD ==========

function cyclePriority(id) {
  const todos = loadTodos();
  const todo = todos.find(t => t.id === id);
  if (!todo || todo.completed) return;
  // Cycle: null → important → urgent → null
  if (!todo.priority) todo.priority = 'important';
  else if (todo.priority === 'important') todo.priority = 'urgent';
  else todo.priority = null;
  saveTodos(todos);
  // User override clears AI order
  if (aiOrder) { aiOrder = null; localStorage.removeItem(AI_ORDER_KEY); }
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

  // AI classification (async, non-blocking)
  if (type === 'daily') {
    const el = document.getElementById('aiSuggestion');
    el.style.display = '';
    el.style.color = 'var(--text-dim)';
    el.textContent = '🤖 正在调用 AI 分类... → ' + getAPIBase();
    classifyTodo(trimmed).then(result => {
      if (result) showAISuggestion(null, result);
      else { el.textContent = '🤖 AI 调用完成，无结果'; el.style.color = 'var(--danger)'; }
    }).catch(e => {
      el.textContent = '🤖 调用失败: ' + e.message;
      el.style.color = 'var(--danger)';
    });
  }
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

function linkToProject(todoId, projectId) {
  const todos = loadTodos();
  const todo = todos.find(t => t.id === todoId); if (!todo) return;

  const linkGroup = todo.linkGroup || genId();
  todo.linkGroup = linkGroup;

  // Create project copy
  const copy = { ...todo, id: genId(), type: 'project', projectId, linkGroup };
  todos.push(copy);
  saveTodos(todos);
  hideLinkPanel();
  render();
}

let pendingLinkId = null;

function showLinkPanel(todoId) {
  pendingLinkId = todoId;
  const projects = loadProjects();
  const list = document.getElementById('linkList');
  if (projects.length === 0) {
    list.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:20px;">还没有项目，先去 📁 项目 创建一个</div>';
  } else {
    list.innerHTML = projects.map(p =>
      '<div class="link-item" data-proj-id="' + p.id + '">📁 ' + escapeHtml(p.name) + '</div>'
    ).join('');
    list.querySelectorAll('.link-item').forEach(el => {
      el.addEventListener('click', () => linkToProject(todoId, el.dataset.projId));
    });
  }
  document.getElementById('linkOverlay').classList.add('show');
}

function hideLinkPanel() {
  document.getElementById('linkOverlay').classList.remove('show');
  pendingLinkId = null;
}

function deleteTodo(id) {
  saveTodos(loadTodos().filter(t => t.id !== id)); render();
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

function priorityDot(todo) {
  const cls = todo.priority === 'urgent' ? 'urgent' : todo.priority === 'important' ? 'important' : '';
  return '<span class="priority-dot-wrap" data-action="cycle-priority" data-id="' + todo.id + '">' +
    '<span class="priority-dot ' + cls + '"></span></span>';
}

function prioritySort(a, b) {
  const today = getToday();
  const aHasTime = a.reminderTime && a.reminderDate === today;
  const bHasTime = b.reminderTime && b.reminderDate === today;

  // 1. Today's timed items sorted by time (earliest first)
  if (aHasTime && bHasTime) {
    const cmp = a.reminderTime.localeCompare(b.reminderTime);
    if (cmp !== 0) return cmp;
  }
  if (aHasTime && !bHasTime) return -1;
  if (!aHasTime && bHasTime) return 1;

  // 2. Same time status → by priority (urgent > important > none)
  const order = { urgent: 0, important: 1, null: 2 };
  const priCmp = (order[a.priority] ?? 2) - (order[b.priority] ?? 2);
  if (priCmp !== 0) return priCmp;

  // 3. Same priority, no time → sort by text (stable)
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

  // Sort today's items: expired first → timed (nearest) → priority
  const sorted = applyAIOrder(todayItems).sort((a, b) => {
    const expDiff = (isExpired(b) ? 1 : 0) - (isExpired(a) ? 1 : 0);
    if (expDiff !== 0) return expDiff;
    if (aiOrder && aiOrder.order) return 0;
    return prioritySort(a, b);
  });

  // Sort future items by date then time
  const sortedFuture = [...futureItems].sort((a, b) => {
    const d = (a.reminderDate || '9').localeCompare(b.reminderDate || '9');
    if (d !== 0) return d;
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
      priorityDot(t) +
      '<button class="link-btn' + (t.linkGroup ? ' linked' : '') + '" data-action="link-todo" data-id="' + t.id + '">📎</button>' +
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
        priorityDot(t) +
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
  updateBadge(allActive);

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
        priorityDot(t) +
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

function bindListEvents() {
  document.querySelectorAll('.todo-item').forEach(el => {
    if (el._bound) return; el._bound = true;
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="delete"]')) {
        e.stopPropagation();
        deleteTodo(el.dataset.id);
      } else if (e.target.closest('[data-action="link-todo"]')) {
        e.stopPropagation();
        showLinkPanel(el.dataset.id);
      } else if (e.target.closest('[data-action="cycle-priority"]')) {
        e.stopPropagation();
        const id = e.target.closest('[data-action="cycle-priority"]').dataset.id;
        cyclePriority(id);
      } else {
        toggleTodo(el.dataset.id);
      }
    });
  });
}

// ========== Music Player ==========

const MUSIC_KEY = 'ai-todo-music-on';
const FAVORITES_KEY = 'ai-todo-music-fav';
let musicOn = localStorage.getItem(MUSIC_KEY) !== '0';
let audioCtx = null;
let musicPlaying = false;
let currentMelodyIndex = 0;

// Simple pentatonic melodies (note frequencies in Hz)
const MELODIES = [
  { name: '晨间鸟鸣', time: 'morning', notes: [
    { f: 523, d: 0.3 }, { f: 659, d: 0.3 }, { f: 784, d: 0.4 }, { f: 1047, d: 0.3 },
    { f: 784, d: 0.3 }, { f: 659, d: 0.3 }, { f: 523, d: 0.4 },
    { f: 0, d: 0.2 }, { f: 659, d: 0.3 }, { f: 784, d: 0.3 }, { f: 880, d: 0.5 }, { f: 784, d: 0.3 },
    { f: 659, d: 0.3 }, { f: 523, d: 0.4 },
  ]},
  { name: '午后花园', time: 'morning', notes: [
    { f: 440, d: 0.4 }, { f: 554, d: 0.3 }, { f: 659, d: 0.5 }, { f: 554, d: 0.3 },
    { f: 440, d: 0.4 }, { f: 0, d: 0.2 }, { f: 659, d: 0.3 }, { f: 784, d: 0.4 },
    { f: 880, d: 0.5 }, { f: 784, d: 0.3 }, { f: 659, d: 0.4 },
  ]},
  { name: '星空漫步', time: 'evening', notes: [
    { f: 392, d: 0.5 }, { f: 440, d: 0.3 }, { f: 523, d: 0.5 }, { f: 440, d: 0.3 },
    { f: 0, d: 0.2 }, { f: 349, d: 0.4 }, { f: 440, d: 0.3 }, { f: 523, d: 0.5 },
    { f: 587, d: 0.4 }, { f: 523, d: 0.3 }, { f: 440, d: 0.5 },
  ]},
  { name: '晚安曲', time: 'evening', notes: [
    { f: 330, d: 0.6 }, { f: 392, d: 0.4 }, { f: 440, d: 0.6 },
    { f: 0, d: 0.3 }, { f: 392, d: 0.4 }, { f: 330, d: 0.4 }, { f: 294, d: 0.6 },
    { f: 330, d: 0.4 }, { f: 262, d: 0.8 },
  ]},
];

function playMelody(melody) {
  if (!musicOn) return;
  stopMusic();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  audioCtx = ctx;
  musicPlaying = true;
  currentMelodyIndex = MELODIES.indexOf(melody);

  const gain = ctx.createGain();
  gain.gain.value = 0.12; // low volume
  gain.connect(ctx.destination);

  let time = 0;
  for (const note of melody.notes) {
    if (note.f === 0) { time += note.d; continue; }
    const osc = ctx.createOscillator();
    const noteGain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = note.f;
    noteGain.gain.setValueAtTime(0.08, ctx.currentTime + time);
    noteGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + time + note.d - 0.05);
    osc.connect(noteGain);
    noteGain.connect(gain);
    osc.start(ctx.currentTime + time);
    osc.stop(ctx.currentTime + time + note.d);
    time += note.d;
  }

  document.getElementById('musicTitle').textContent = '🎵 ' + melody.name;
  document.getElementById('musicPlayer').classList.add('show');

  // Auto-stop after melody ends
  setTimeout(() => { musicPlaying = false; }, time * 1000 + 500);
}

function stopMusic() {
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
  musicPlaying = false;
}

function showMusicPlayer(melody) {
  if (!musicOn) return;
  playMelody(melody);
}

function checkMusicTrigger(reason) {
  if (!musicOn) return;
  const today = getToday();
  const dailyKey = 'music-triggered-' + reason + '-' + today;
  if (localStorage.getItem(dailyKey)) return;
  localStorage.setItem(dailyKey, '1');

  const candidates = MELODIES.filter(m => reason === 'morning' ? m.time === 'morning' : m.time === 'evening');
  // Prefer favorites
  const favs = JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
  const favMelody = candidates.find(m => favs.includes(m.name));
  const melody = favMelody || candidates[Math.floor(Math.random() * candidates.length)];
  showMusicPlayer(melody);
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

// ========== AI Classification ==========

function getTrainingData() {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const cutoff = fmtDate(thirtyDaysAgo);
  return loadTodos()
    .filter(t => t.date >= cutoff)
    .map(t => ({ text: t.text, type: t.type, priority: t.priority || 'normal' }));
}

async function classifyTodo(text) {
  const training = getTrainingData();
  const historyText = training.length > 0
    ? '\n用户过去30天的分类记录：\n' + JSON.stringify(training.slice(0, 50))
    : '';

  const systemPrompt =
    '你是一个待办分类助手。根据用户过去的分类习惯，判断新待办应该归类到哪个层级和优先级。\n' +
    '只返回JSON，不要其他内容：{"layer":"daily"|"inspiration"|"project","priority":"normal"|"important"|"urgent","reason":"一句话理由"}\n' +
    '如果没把握，layer返回daily，priority返回normal。' + historyText;

  try {
    const resp = await fetch(getAPIBase(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DEEPSEEK_KEY },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: '分类这条待办：' + text },
        ],
        temperature: 0.3,
        max_tokens: 150,
      }),
    });

    if (!resp.ok) return null;
    const raw = await resp.text();
    let data;
    try { data = JSON.parse(raw); } catch { return null; }
    const content = data.choices?.[0]?.message?.content || '';
    const clean = content.replace(/```json\s*|\s*```/g, '').trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}


function getAPIBase() {
  if (location.protocol === 'http:') {
    return location.protocol + '//' + location.hostname + ':3001';
  }
  return 'https://api.deepseek.com/v1/chat/completions';
}

function showAISuggestion(todo, result) {
  if (!result || !result.layer) return;
  const layerLabel = result.layer === 'daily' ? '日常' : result.layer === 'inspiration' ? '灵感' : '项目';
  const priLabel = result.priority === 'urgent' ? '重要且紧急' : result.priority === 'important' ? '重要' : '普通';
  const el = document.getElementById('aiSuggestion');
  el.style.display = '';
  el.textContent = '💡 AI 建议：归入「' + layerLabel + '」· ' + priLabel + (result.reason ? ' —— ' + result.reason : '');
  setTimeout(() => { el.style.display = 'none'; }, 15000);
}

// ========== AI Priority Sort ==========

let aiOrder = null; // {order: [id,...], reason: string}
const AI_ORDER_KEY = 'ai-todo-order';

function loadAIOrder() {
  try {
    const raw = localStorage.getItem(AI_ORDER_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data.date === getToday()) return data;
  } catch {}
  return null;
}

function saveAIOrder(data) {
  localStorage.setItem(AI_ORDER_KEY, JSON.stringify({ ...data, date: getToday() }));
}

async function fetchAIPrioritySort() {
  const today = getToday();
  const active = loadTodos().filter(t => !t.completed && t.type === 'daily' && t.date <= today && (!t.reminderDate || t.reminderDate <= today));
  if (active.length < 3) return;

  const todoList = active.map(t => ({
    id: t.id,
    text: t.text,
    priority: t.priority || 'normal',
    deadline: t.reminderTime || '无',
    postponeCount: t.postponeCount || 0,
  }));

  const systemPrompt =
    '你是待办优先级排序助手。根据待办的时间紧迫度和重要程度，给出今天的执行顺序建议。\n' +
    '核心规则：截止时间越近的越靠前（今天10:00 > 今天16:00 > 明天）。时间排第一优先级。\n' +
    '同等时间下：重要且紧急 > 已延期3次以上 > 重要 > 其他。没有截止时间的排在最后。\n' +
    '返回JSON，不要其他内容：{"order":["id1","id2",...],"reason":"一句话建议"}\n' +
    '只排序，不增删。';

  try {
    const resp = await fetch(getAPIBase(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DEEPSEEK_KEY },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: '今天的待办：\n' + JSON.stringify(todoList) },
        ],
        temperature: 0.3,
        max_tokens: 500,
      }),
    });

    if (!resp.ok) return;
    const raw = await resp.text();
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    const content = data.choices?.[0]?.message?.content || '';
    const clean = content.replace(/```json\s*|\s*```/g, '').trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    const result = JSON.parse(jsonMatch[0]);
    if (result.order) {
      aiOrder = result;
      saveAIOrder(result);
      render();
      showAISortHint(result);
    }
  } catch {}
}

function showAISortHint(result) {
  const todos = loadTodos();
  const names = (result.order || []).slice(0, 3)
    .map(id => todos.find(t => t.id === id))
    .filter(Boolean)
    .map(t => t.text.slice(0, 10))
    .join('、');
  if (names) {
    const el = document.getElementById('aiSuggestion');
    el.textContent = '💡 AI建议：今天先处理 ' + names + (result.reason ? '（' + result.reason + '）' : '');
    el.style.color = 'var(--accent)';
    setTimeout(() => { el.textContent = ''; }, 8000);
  }
}

function applyAIOrder(todos) {
  if (!aiOrder || !aiOrder.order) return todos;
  const orderMap = {};
  aiOrder.order.forEach((id, i) => { orderMap[id] = i; });
  return [...todos].sort((a, b) => {
    const aIdx = orderMap[a.id] ?? 999;
    const bIdx = orderMap[b.id] ?? 999;
    if (aIdx !== bIdx) return aIdx - bIdx;
    return prioritySort(a, b);
  });
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

  // Tab switching
  document.querySelectorAll('.tab-bar button').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Back button (project detail → project list)
  document.getElementById('backBtn').addEventListener('click', () => {
    currentProjectId = null; render();
  });

  // Music player controls
  document.getElementById('musicPlayBtn').addEventListener('click', () => {
    if (musicPlaying) { stopMusic(); document.getElementById('musicPlayBtn').textContent = '▶️'; }
    else { playMelody(MELODIES[currentMelodyIndex] || MELODIES[0]); document.getElementById('musicPlayBtn').textContent = '⏸'; }
  });
  document.getElementById('musicSkipBtn').addEventListener('click', () => {
    const pool = MELODIES.filter(m => {
      const isMorning = new Date().getHours() >= 8 && new Date().getHours() < 10;
      return isMorning ? m.time === 'morning' : m.time === 'evening';
    });
    const next = pool[Math.floor(Math.random() * pool.length)];
    playMelody(next);
    document.getElementById('musicPlayBtn').textContent = '⏸';
  });
  document.getElementById('musicCloseBtn').addEventListener('click', () => {
    stopMusic(); document.getElementById('musicPlayer').classList.remove('show');
  });

  // Music toggle
  document.getElementById('musicToggle').addEventListener('click', function() {
    musicOn = !musicOn;
    localStorage.setItem(MUSIC_KEY, musicOn ? '1' : '0');
    this.textContent = musicOn ? '🎵 早晚音乐' : '🔇 音乐已关';
    this.style.color = musicOn ? '' : 'var(--danger)';
    if (!musicOn) stopMusic();
  });
  if (!musicOn) {
    const btn = document.getElementById('musicToggle');
    btn.textContent = '🔇 音乐已关';
    btn.style.color = 'var(--danger)';
  }

  // Morning music trigger on first open each day
  checkMusicTrigger('morning');

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

  // Link panel
  document.getElementById('linkOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) hideLinkPanel();
  });

  // API Key toggle

  aiSortBtn.addEventListener('click', () => {
    aiSortBtn.textContent = '🔀 排序中...';
    aiSortBtn.disabled = true;
    fetchAIPrioritySort().finally(() => {
      aiSortBtn.textContent = '🔀 AI排序';
      aiSortBtn.disabled = false;
    });
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js?v=' + Date.now()).then(reg => {
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            showBanner('有新版本，点击更新', true);
            document.getElementById('banner').onclick = () => { newWorker.postMessage('skipWaiting'); window.location.reload(); };
          }
        });
      });
    });
    setInterval(() => { navigator.serviceWorker.getRegistration().then(r => r && r.update()); }, 600000);
  }

  // === Menu Toggle ===
  const menuBtn = document.getElementById('menuBtn');
  const menuDropdown = document.getElementById('menuDropdown');
  menuBtn.addEventListener('click', (e) => { e.stopPropagation(); menuDropdown.classList.toggle('show'); });
  document.addEventListener('click', (e) => {
    if (!menuDropdown.contains(e.target) && e.target !== menuBtn) menuDropdown.classList.remove('show');
  });
  menuDropdown.addEventListener('click', () => menuDropdown.classList.remove('show'));

  // === Notification ===
  const notifBtn = document.getElementById('notifBtn');
  if (!('Notification' in window)) {
    notifBtn.textContent = '🚫 不支持通知';
  } else {
    function updateNotifBtn() {
      if (Notification.permission === 'granted') notifBtn.textContent = '🔔 提醒（已开）';
      else if (Notification.permission === 'default') notifBtn.textContent = '🔔 开启提醒';
      else notifBtn.textContent = '🔕 提醒（已关）';
    }
    notifBtn.addEventListener('click', async () => {
      if (Notification.permission === 'granted') return;
      const result = await Notification.requestPermission();
      updateNotifBtn();
    });
    updateNotifBtn();
  }

  // Load today's AI order
  const savedOrder = loadAIOrder();
  if (savedOrder) {
    aiOrder = savedOrder;
    showAISortHint(savedOrder);
  }

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

  // === Sync Settings ===
  const syncOverlay = document.getElementById('syncOverlay');
  const syncTokenInput = document.getElementById('syncTokenInput');
  const syncHint = document.getElementById('syncHint');
  const syncBtn = document.getElementById('syncBtn');

  function updateSyncBtnLabel() {
    if (getSyncToken()) syncBtn.textContent = '☁️ 同步（已设）';
    else syncBtn.textContent = '☁️ 同步设置';
  }
  updateSyncBtnLabel();

  syncBtn.addEventListener('click', () => {
    syncTokenInput.value = getSyncToken();
    syncHint.textContent = '';
    syncHint.className = 'sync-hint';
    syncOverlay.classList.add('show');
    setTimeout(() => syncTokenInput.focus(), 200);
  });

  document.getElementById('syncCancelBtn').addEventListener('click', () => {
    syncOverlay.classList.remove('show');
  });
  syncOverlay.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) syncOverlay.classList.remove('show');
  });

  document.getElementById('syncSaveBtn').addEventListener('click', async () => {
    const token = syncTokenInput.value.trim();
    if (!token) {
      syncHint.textContent = '请输入 Token';
      syncHint.className = 'sync-hint error';
      return;
    }
    if (!token.startsWith('ghp_') && !token.startsWith('github_pat_')) {
      syncHint.textContent = 'Token 格式不正确，应以 ghp_ 或 github_pat_ 开头';
      syncHint.className = 'sync-hint error';
      return;
    }
    syncHint.textContent = '正在验证...';
    syncHint.className = 'sync-hint';
    localStorage.setItem(SYNC_TOKEN_KEY, token);
    updateSyncBtnLabel();

    // Test the token by fetching
    try {
      const remote = await fetchRemoteData();
      syncHint.textContent = remote ? '✓ 同步成功！已连接云端' : '✓ Token 已保存，首次同步将创建云端数据';
      syncHint.className = 'sync-hint';
      if (remote && remote.todos) {
        syncFromGitHub();
      } else {
        // Push local data to create the file
        await pushRemoteData(_todosCache, _projectsCache);
      }
    } catch (e) {
      syncHint.textContent = '⚠️ 连接失败：' + e.message + '，Token 已保存';
      syncHint.className = 'sync-hint error';
    }
  });

  // Apply saved theme on load
  setTheme(getTheme());
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
