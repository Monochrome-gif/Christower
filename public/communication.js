
'use strict';

/* =========================================
   CHRISTOWER CONNECT
   Frontend communication system
   Backend: Node.js / Express / MongoDB
   Live messaging: Socket.IO
========================================= */

const API = '/api';

let conversations = [];
let directoryUsers = [];
let activeId = null;
let currentUser = null;

let socket = null;
let socketReady = false;

let currentFilter = 'all';
let currentView = 'all';
let announcementConversationOpen = false;

let communicationStarted = false;
let communicationStarting = false;
let messageRequestNumber = 0;

const $ = selector => document.querySelector(selector);


/* =========================================
   GENERAL HELPERS
========================================= */

function safe(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function toast(message) {
  const element = $('#toast');

  if (!element) {
    console.log(message);
    return;
  }

  element.textContent = message;
  element.classList.add('show');

  clearTimeout(toast.timer);

  toast.timer = setTimeout(() => {
    element.classList.remove('show');
  }, 3000);
}

function getId(item) {
  if (!item) return '';

  if (typeof item === 'string') return item;

  return String(item._id || item.id || '');
}

function getList(data, keys = []) {
  if (Array.isArray(data)) return data;

  for (const key of keys) {
    if (Array.isArray(data?.[key])) {
      return data[key];
    }
  }

  return [];
}

function getUserName(user) {
  if (!user) return 'Unknown user';

  if (typeof user === 'string') {
    return 'School member';
  }

  return (
    user.name ||
    user.fullName ||
    user.email ||
    'School member'
  );
}

function getInitials(name) {
  return String(name || 'U')
    .trim()
    .split(/\s+/)
    .map(part => part[0])
    .join('')
    .substring(0, 2)
    .toUpperCase();
}

function getTime(date) {
  if (!date) return '';

  const parsed = new Date(date);

  if (Number.isNaN(parsed.getTime())) return '';

  return parsed.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function getCurrentUserId() {
  return getId(currentUser);
}

function setText(selector, value) {
  const element = $(selector);

  if (element) {
    element.textContent = value;
  }
}


/* =========================================
   API REQUEST HANDLER
========================================= */

async function apiRequest(url, options = {}) {
  const headers = {
    Accept: 'application/json',
    ...(options.headers || {})
  };

  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(API + url, {
    ...options,
    credentials: 'same-origin',
    headers
  });

  let data = {};

  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (response.status === 401) {
    window.dispatchEvent(
      new Event('christower:session-expired')
    );

    throw new Error(
      data.error || 'Your session has expired. Please sign in again.'
    );
  }

  if (response.status === 403) {
    throw new Error(
      data.error || 'You do not have permission to do that.'
    );
  }

  if (!response.ok) {
    throw new Error(
      data.error || `Server error (${response.status}).`
    );
  }

  return data;
}


/* =========================================
   SESSION MANAGEMENT
========================================= */

async function loadCurrentUser() {
  const data = await apiRequest('/auth/me');

  currentUser = data.user || data;

  if (!getCurrentUserId()) {
    throw new Error('Could not identify the signed-in account.');
  }

  return currentUser;
}

function handleExpiredSession() {
  communicationStarted = false;
  communicationStarting = false;

  if (socket) {
    socket.disconnect();
    socket = null;
    socketReady = false;
  }

  const app = $('#communicationApp');
  const login = $('#loginScreen');

  if (app) app.hidden = true;
  if (login) login.hidden = false;

  const error = $('#loginError');

  if (error) {
    error.textContent = 'Your session expired. Please sign in again.';
  }

  currentUser = null;
  conversations = [];
  directoryUsers = [];
  activeId = null;

  messageRequestNumber++;
}

window.addEventListener(
  'christower:session-expired',
  handleExpiredSession
);


/* =========================================
   CONVERSATION HELPERS
========================================= */

function getConversationType(conversation) {
  return conversation?.type || 'group';
}

function getConversationName(conversation) {
  if (conversation?.title) {
    return conversation.title;
  }

  const type = getConversationType(conversation);

  if (type === 'direct') {
    const members = conversation.members || [];

    const other = members.find(member => {
      const id = getId(member);

      return id && id !== getCurrentUserId();
    });

    if (other && typeof other === 'object') {
      return getUserName(other);
    }

    return 'Private conversation';
  }

  if (type === 'announcement') {
    return 'School Announcement';
  }

  return 'Group Conversation';
}

function getConversationColor(type) {
  if (type === 'direct') return 'green';
  if (type === 'announcement') return 'pink';

  return 'blue';
}

function getLastMessage(conversation) {
  const last = conversation?.lastMessage;

  if (!last) return 'No messages yet';

  if (typeof last === 'string') {
    return last;
  }

  return last.body || last.text || 'Message';
}


/* =========================================
   LOAD CONVERSATIONS
========================================= */

async function loadConversations() {
  const data = await apiRequest('/conversations');

  conversations = getList(data, [
    'conversations',
    'items',
    'data'
  ]);

  drawList();

  if (!conversations.length) {
    activeId = null;
    messageRequestNumber++;
    showEmptyConversation();
    return;
  }

  const existing = conversations.find(
    item => getId(item) === activeId
  );

  if (!existing) {
    await selectChat(getId(conversations[0]));
  }
}


/* =========================================
   FILTER CONVERSATIONS
========================================= */

function visibleConversations() {
  const query = ($('#search')?.value || '')
    .trim()
    .toLowerCase();

  return conversations.filter(conversation => {
    const type = getConversationType(conversation);
    const name = getConversationName(conversation);
    const preview = getLastMessage(conversation);

    const matchesFilter =
      currentFilter === 'all' ||
      (currentFilter === 'groups' && type === 'group') ||
      (currentFilter === 'direct' && type === 'direct');

    const matchesView =
      currentView === 'all' ||
      (currentView === 'groups' && type === 'group') ||
      (currentView === 'direct' && type === 'direct') ||
      (currentView === 'announcements' && type === 'announcement');

    const matchesSearch =
      !query ||
      `${name} ${preview}`.toLowerCase().includes(query);

    return matchesFilter && matchesView && matchesSearch;
  });
}


/* =========================================
   ANNOUNCEMENTS NOTICE BOARD
========================================= */

function isStaffUser() {
  return ['teacher', 'admin'].includes(currentUser?.role);
}

function formatAnnouncementDate(value) {
  if (!value) return 'Recently posted';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Recently posted';
  return date.toLocaleDateString([], {
    day: 'numeric', month: 'short', year: 'numeric'
  });
}

function renderAnnouncementBoard() {
  const page = $('#announcementsPage');
  const workspace = $('#messagingWorkspace');
  const list = $('#announcementList');
  const createButton = $('#createAnnouncementButton');

  if (!page || !workspace || !list) return;

  const showingBoard = currentView === 'announcements' && !announcementConversationOpen;
  page.hidden = !showingBoard;
  workspace.hidden = showingBoard;

  if (createButton) createButton.hidden = !isStaffUser();

  const heading = $('.topbar h1');
  if (heading) heading.textContent = currentView === 'announcements'
    ? (announcementConversationOpen ? 'Announcement Details' : 'Announcements')
    : 'Student Communication';

  if (!showingBoard) return;

  const query = ($('#search')?.value || '').trim().toLowerCase();
  const items = conversations
    .filter(item => getConversationType(item) === 'announcement')
    .filter(item => !query || `${item.title || ''} ${getLastMessage(item)} ${item.className || ''}`.toLowerCase().includes(query))
    .sort((a, b) => new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0));

  if (!items.length) {
    list.innerHTML = `
      <div class="announcement-empty">
        <div style="font-size:30px;margin-bottom:8px">📢</div>
        <b>${query ? 'No announcements match your search.' : 'No announcements yet.'}</b>
        <div style="margin-top:6px">${query ? 'Try another search term.' : (isStaffUser() ? 'Create the first official school notice.' : 'Official school notices will appear here when they are published.')}</div>
      </div>`;
    return;
  }

  list.innerHTML = items.map(item => {
    const id = getId(item);
    const audience = item.className ? item.className : 'Whole school';
    const author = item.createdBy?.name || 'School staff';
    return `
      <article class="announcement-card">
        <div class="announcement-card-top">
          <span class="announcement-tag">📢 Official notice</span>
          <time class="announcement-date">${safe(formatAnnouncementDate(item.lastMessageAt))}</time>
        </div>
        <h3>${safe(item.title || 'School announcement')}</h3>
        <p>${safe(getLastMessage(item))}</p>
        <div class="announcement-card-foot">
          <span class="announcement-audience">${safe(audience)} · By ${safe(author)}</span>
          <button type="button" class="announcement-open" data-open-announcement="${safe(id)}">Read announcement →</button>
        </div>
      </article>`;
  }).join('');
}

function createAnnouncementModal() {
  if ($('#announcementModal')) return;

  const overlay = document.createElement('div');
  overlay.id = 'announcementModal';
  overlay.className = 'announcement-modal-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `
    <section class="announcement-modal" role="dialog" aria-modal="true" aria-labelledby="announcementModalTitle">
      <h2 id="announcementModalTitle">Create an announcement</h2>
      <p>Publish an official notice to the whole school or a selected school section.</p>
      <form id="announcementForm">
        <div class="announcement-field">
          <label for="announcementTitle">Announcement title</label>
          <input id="announcementTitle" name="title" maxlength="80" minlength="2" required placeholder="e.g. Mid-term break dates">
        </div>
        <div class="announcement-field">
          <label for="announcementBody">Announcement message</label>
          <textarea id="announcementBody" name="body" maxlength="1000" required placeholder="Write the official school notice..."></textarea>
        </div>
        <div class="announcement-field">
          <label for="announcementAudience">Who should receive this?</label>
          <select id="announcementAudience" name="className">
            <option value="">Whole school</option>
            <option value="Nursery">Nursery</option>
            <option value="Primary">Primary</option>
            <option value="JSS">JSS</option>
            <option value="SSS">SSS</option>
          </select>
        </div>
        <div class="announcement-modal-actions">
          <button type="button" class="announcement-cancel" id="cancelAnnouncement">Cancel</button>
          <button type="submit" class="announcement-publish" id="publishAnnouncement">Publish announcement</button>
        </div>
      </form>
    </section>`;
  document.body.appendChild(overlay);

  $('#createAnnouncementButton')?.addEventListener('click', openAnnouncementModal);
  $('#cancelAnnouncement')?.addEventListener('click', closeAnnouncementModal);
  overlay.addEventListener('click', event => {
    if (event.target === overlay) closeAnnouncementModal();
  });
  $('#announcementForm')?.addEventListener('submit', publishAnnouncement);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !$('#announcementModal')?.hidden) closeAnnouncementModal();
  });
}

function openAnnouncementModal() {
  if (!isStaffUser()) {
    toast('Only teachers and administrators can publish announcements.');
    return;
  }
  createAnnouncementModal();
  $('#announcementModal').hidden = false;
  $('#announcementTitle')?.focus();
}

function closeAnnouncementModal() {
  const modal = $('#announcementModal');
  if (modal) modal.hidden = true;
}

async function publishAnnouncement(event) {
  event.preventDefault();
  if (!isStaffUser()) return;

  const form = $('#announcementForm');
  const button = $('#publishAnnouncement');
  const title = $('#announcementTitle')?.value.trim() || '';
  const body = $('#announcementBody')?.value.trim() || '';
  const className = $('#announcementAudience')?.value || '';

  if (title.length < 2 || !body) {
    toast('Enter an announcement title and message.');
    return;
  }

  button.disabled = true;
  button.textContent = 'Publishing...';

  try {
    const created = await apiRequest('/conversations/groups', {
      method: 'POST',
      body: JSON.stringify({ title, className, type: 'announcement' })
    });

    const conversation = created.conversation || created;
    const id = getId(conversation);
    if (!id) throw new Error('The announcement channel was created but no ID was returned.');

    await apiRequest(`/conversations/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body })
    });

    form.reset();
    closeAnnouncementModal();
    announcementConversationOpen = false;
    await loadConversations();
    renderAnnouncementBoard();
    toast('Announcement published successfully.');
  } catch (error) {
    console.error('Announcement publishing failed:', error);
    toast(error.message || 'Could not publish the announcement.');
    // Refresh in case the channel was created before the message request failed.
    loadConversations().catch(() => {});
  } finally {
    button.disabled = false;
    button.textContent = 'Publish announcement';
  }
}

function setupAnnouncements() {
  createAnnouncementModal();
  $('#announcementList')?.addEventListener('click', event => {
    const button = event.target.closest('[data-open-announcement]');
    if (!button) return;
    const id = button.dataset.openAnnouncement;
    announcementConversationOpen = true;
    renderAnnouncementBoard();
    selectChat(id).catch(error => toast(error.message));
  });
}

/* =========================================
   DRAW CONVERSATION LIST
========================================= */

function drawList() {
  const container = $('#chatList');

  if (!container) return;

  container.innerHTML = '';
  renderAnnouncementBoard();

  const rows = visibleConversations();

  if (!rows.length) {
    container.innerHTML = `
      <div class="empty-state">
        No conversations available.
        <br>
        Click + to find a student or staff member.
      </div>
    `;
    return;
  }

  rows.forEach(conversation => {
    const id = getId(conversation);
    const name = getConversationName(conversation);
    const type = getConversationType(conversation);

    const button = document.createElement('button');

    button.type = 'button';

    button.className =
      'chat-item' +
      (id === activeId ? ' selected' : '');

    button.innerHTML = `
      <span class="chat-avatar ${getConversationColor(type)}">
        ${safe(getInitials(name))}
      </span>

      <span class="chat-copy">
        <b>${safe(name)}</b>
        <small>${safe(getLastMessage(conversation))}</small>
      </span>

      <span class="chat-time">
        ${safe(getTime(conversation.lastMessageAt))}
      </span>
    `;

    button.addEventListener('click', () => {
      selectChat(id).catch(error => {
        console.error(error);
        toast(error.message);
      });
    });

    container.appendChild(button);
  });
}


/* =========================================
   SELECT CONVERSATION
========================================= */

async function selectChat(id) {
  const conversation = conversations.find(
    item => getId(item) === String(id)
  );

  if (!conversation) return;

  activeId = String(id);
  messageRequestNumber++;

  const name = getConversationName(conversation);
  const type = getConversationType(conversation);

  let backButton = $('#backToAnnouncements');
  if (type === 'announcement' && currentView === 'announcements') {
    if (!backButton) {
      backButton = document.createElement('button');
      backButton.type = 'button';
      backButton.id = 'backToAnnouncements';
      backButton.className = 'announcement-back';
      backButton.textContent = '← All announcements';
      backButton.addEventListener('click', () => {
        announcementConversationOpen = false;
        renderAnnouncementBoard();
      });
      $('.conversation-head')?.prepend(backButton);
    }
  } else {
    backButton?.remove();
  }

  const composer = $('#messageForm');
  if (composer) composer.hidden = type === 'announcement' && !isStaffUser();

  setText('#activeTitle', name);
  setText('#activeAvatar', getInitials(name));

  setText(
    '#activeSubtitle',
    type === 'direct'
      ? 'Private conversation'
      : type === 'announcement'
        ? 'Official school announcement'
        : 'School group conversation'
  );

  setText('#detailAvatar', getInitials(name));
  setText('#detailTitle', name);

  setText(
    '#detailDescription',
    conversation.description ||
    (type === 'announcement'
      ? 'Official updates from the school.'
      : 'A school communication space.')
  );

  setText(
    '#memberCount',
    Array.isArray(conversation.members)
      ? conversation.members.length
      : '—'
  );

  setText(
    '#chatType',
    type === 'direct'
      ? 'Private'
      : type === 'announcement'
        ? 'Announcement'
        : 'Group'
  );

  drawList();

  await loadMessages(id);

  if (activeId === String(id) && socket && socketReady) {
    socket.emit('conversation:join', String(id));
  }

  $('#sidebar')?.classList.remove('open');
}


/* =========================================
   LOAD MESSAGE HISTORY
========================================= */

async function loadMessages(id) {
  const container = $('#messages');

  if (!container) return;

  const requestNumber = ++messageRequestNumber;

  container.innerHTML = `
    <div class="empty-state">
      Loading messages...
    </div>
  `;

  try {
    const data = await apiRequest(
      `/conversations/${encodeURIComponent(id)}/messages`
    );

    if (
      requestNumber !== messageRequestNumber ||
      String(id) !== activeId
    ) {
      return;
    }

    const messages = getList(data, [
      'messages',
      'items',
      'data'
    ]);

    drawMessages(messages);

  } catch (error) {
    if (
      requestNumber !== messageRequestNumber ||
      String(id) !== activeId
    ) {
      return;
    }

    container.innerHTML = `
      <div class="empty-state">
        ${safe(error.message)}
      </div>
    `;
  }
}


/* =========================================
   DISPLAY MESSAGES
========================================= */

function drawMessages(messages) {
  const container = $('#messages');

  if (!container) return;

  container.innerHTML = '';

  if (!messages.length) {
    container.innerHTML = `
      <div class="empty-state">
        No messages yet. Start the conversation.
      </div>
    `;
    return;
  }

  messages.forEach(message => {
    appendMessage(message, false);
  });

  container.scrollTop = container.scrollHeight;
}

function appendMessage(message, scroll = true) {
  const container = $('#messages');

  if (!container || !message) return;

  const messageId = getId(message);

  if (messageId) {
    const exists = Array.from(
      container.querySelectorAll('[data-message-id]')
    ).some(element => element.dataset.messageId === messageId);

    if (exists) return;
  }

  const sender = message.sender || {};
  const senderId = getId(sender);

  const mine =
    senderId &&
    senderId === getCurrentUserId();

  const senderName = mine
    ? 'You'
    : getUserName(sender);

  const body = message.body || message.text || '';

  const row = document.createElement('article');

  row.className = 'message' + (mine ? ' mine' : '');

  if (messageId) {
    row.dataset.messageId = messageId;
  }

  row.innerHTML = `
    <span class="msg-avatar">
      ${safe(getInitials(senderName))}
    </span>

    <div class="msg-content">
      <div class="msg-meta">
        <b>${safe(senderName)}</b>
        <span>${safe(sender.role || '')}</span>
        <span>${safe(getTime(message.createdAt || message.updatedAt))}</span>
      </div>

      <div class="bubble">
        ${safe(body).replace(/\n/g, '<br>')}
      </div>
    </div>
  `;

  container.appendChild(row);

  if (scroll) {
    container.scrollTop = container.scrollHeight;
  }
}


/* =========================================
   SEND MESSAGE
========================================= */

async function sendMessage(event) {
  event.preventDefault();

  const input = $('#messageInput');
  const form = $('#messageForm');

  if (!input || !form) {
    toast('Message form could not be found.');
    return;
  }

  const body = input.value.trim();

  if (!body) {
    toast('Please enter a message.');
    return;
  }

  if (!activeId) {
    toast('Select a conversation first.');
    return;
  }

  if (body.length > 1000) {
    toast('Your message is too long.');
    return;
  }

  const conversationId = activeId;

  const button = form.querySelector('button[type="submit"]');

  if (button) button.disabled = true;

  try {
    const data = await apiRequest(
      `/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({ body })
      }
    );

    if (activeId !== conversationId) return;

    const message = data.message || data;

    if (message && (message.body || message.text)) {
      appendMessage(message);
    } else {
      await loadMessages(conversationId);
    }

    input.value = '';
    input.style.height = 'auto';

    setText('#counter', '0 / 1000');

    const conversation = conversations.find(
      item => getId(item) === conversationId
    );

    if (conversation) {
      conversation.lastMessage = body;
      conversation.lastMessageAt = new Date();
    }

    drawList();

    toast('Message sent successfully.');

  } catch (error) {
    console.error('Message sending failed:', error);
    toast(error.message || 'Could not send your message.');

  } finally {
    if (button) button.disabled = false;
  }
}


/* =========================================
   STUDENT AND STAFF DIRECTORY
========================================= */

function createDirectoryModal() {
  if ($('#directoryModal')) return;

  const modal = document.createElement('div');

  modal.id = 'directoryModal';
  modal.className = 'directory-overlay';
  modal.hidden = true;

  modal.innerHTML = `
    <section class="directory-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="directoryTitle">

      <header class="directory-header">
        <div>
          <h2 id="directoryTitle">School Directory</h2>
          <p>Find students and staff to start a conversation.</p>
        </div>

        <button type="button"
          id="closeDirectory"
          class="directory-close"
          aria-label="Close">×</button>
      </header>

      <div class="directory-search">
        <input
          id="directorySearch"
          type="search"
          placeholder="Search by name or class..."
          autocomplete="off">

        <button type="button" id="refreshDirectory">
          Refresh
        </button>
      </div>

      <div id="directoryResults" class="directory-results">
        <p class="empty-state">Loading school members...</p>
      </div>
    </section>
  `;

  document.body.appendChild(modal);

  $('#closeDirectory').addEventListener(
    'click',
    closeDirectory
  );

  modal.addEventListener('click', event => {
    if (event.target === modal) {
      closeDirectory();
    }
  });

  $('#directorySearch').addEventListener(
    'input',
    renderDirectory
  );

  $('#refreshDirectory').addEventListener(
    'click',
    loadDirectory
  );

  $('#directoryResults').addEventListener(
    'click',
    event => {
      const button = event.target.closest('[data-message-user]');

      if (!button || button.disabled) return;

      startDirectConversation(button.dataset.messageUser);
    }
  );

  document.addEventListener('keydown', event => {
    if (
      event.key === 'Escape' &&
      !$('#directoryModal')?.hidden
    ) {
      closeDirectory();
    }
  });
}

function openDirectory() {
  createDirectoryModal();

  $('#directoryModal').hidden = false;
  $('#directorySearch').value = '';

  loadDirectory();

  setTimeout(() => {
    $('#directorySearch')?.focus();
  }, 50);
}

function closeDirectory() {
  const modal = $('#directoryModal');

  if (modal) {
    modal.hidden = true;
  }
}


/* =========================================
   LOAD SCHOOL MEMBERS
========================================= */

async function loadDirectory() {
  const results = $('#directoryResults');

  if (!results) return;

  results.innerHTML = `
    <p class="empty-state">Loading school members...</p>
  `;

  try {
    const data = await apiRequest('/users');

    directoryUsers = getList(data, [
      'users',
      'members',
      'items',
      'data'
    ]);

    renderDirectory();

  } catch (error) {
    console.error('Directory loading failed:', error);

    results.innerHTML = `
      <div class="directory-error">
        <p>Could not load school members.</p>
        <p>${safe(error.message)}</p>
        <button type="button" id="retryDirectory">
          Try again
        </button>
      </div>
    `;

    $('#retryDirectory')?.addEventListener(
      'click',
      loadDirectory
    );
  }
}


/* =========================================
   DISPLAY SCHOOL MEMBERS
========================================= */

function renderDirectory() {
  const results = $('#directoryResults');

  if (!results) return;

  const query = ($('#directorySearch')?.value || '')
    .trim()
    .toLowerCase();

  const users = directoryUsers.filter(user => {
    const name = getUserName(user);
    const className = user.className || '';
    const role = user.role || '';

    const id = getId(user);

    if (!id || id === getCurrentUserId()) {
      return false;
    }

    return `${name} ${className} ${role}`
      .toLowerCase()
      .includes(query);
  });

  if (!users.length) {
    results.innerHTML = `
      <div class="empty-state">
        ${
          directoryUsers.length
            ? 'No school members match your search.'
            : 'No other active school members were found.'
        }
      </div>
    `;
    return;
  }

  results.innerHTML = users.map(user => {
    const id = getId(user);
    const name = getUserName(user);
    const role = user.role || 'School member';
    const className = user.className || '';

    return `
      <article class="directory-person">

        <span class="directory-avatar">
          ${safe(getInitials(name))}
        </span>

        <div class="directory-person-info">
          <b>${safe(name)}</b>

          <small>
            ${safe(role)}
            ${className ? ' · ' + safe(className) : ''}
          </small>
        </div>

        <button
          type="button"
          class="directory-message"
          data-message-user="${safe(id)}">
          Message
        </button>

      </article>
    `;
  }).join('');
}


/* =========================================
   START PRIVATE CONVERSATION
========================================= */

async function startDirectConversation(userId) {
  if (!userId) return;

  const buttons = document.querySelectorAll(
    '[data-message-user]'
  );

  buttons.forEach(button => {
    button.disabled = true;
  });

  try {
    const data = await apiRequest('/conversations/direct', {
      method: 'POST',
      body: JSON.stringify({ userId })
    });

    const conversation = data.conversation || data;
    const conversationId = getId(conversation);

    // Reload the inbox to get the saved conversation.
    await loadConversations();

    let selected = conversations.find(
      item => getId(item) === conversationId
    );

    // Fallback: find the direct conversation by its members.
    if (!selected) {
      selected = conversations.find(item => {
        if (getConversationType(item) !== 'direct') {
          return false;
        }

        return (item.members || []).some(
          member => getId(member) === String(userId)
        );
      });
    }

    // Fallback if the server returned a conversation
    // that was not included in the refreshed inbox.
    if (!selected && conversationId) {
      conversations.unshift(conversation);
      selected = conversation;
      drawList();
    }

    if (!selected) {
      throw new Error(
        'Conversation created, but could not be found. Please refresh your inbox.'
      );
    }

    await selectChat(getId(selected));

    closeDirectory();

    toast('Private conversation opened.');

  } catch (error) {
    console.error('Private conversation error:', error);
    toast(error.message);

  } finally {
    buttons.forEach(button => {
      button.disabled = false;
    });
  }
}


/* =========================================
   CREATE PRIVATE CONVERSATION
========================================= */

function createDirectConversation() {
  openDirectory();
}

/* =========================================
   CREATE GROUP CONVERSATION
========================================= */

async function createGroupConversation() {
  if (!currentUser || !['teacher', 'admin'].includes(currentUser.role)) {
    toast('Only teachers and administrators can create groups.');
    return;
  }

  const title = window.prompt('Enter the group name:');

  if (title === null || title.trim().length < 2) {
    return;
  }

  const className = window.prompt(
    'Enter the exact class name (e.g. JSS 1 or SS 2).\nLeave blank to create an all-school group:'
  );

  if (className === null) {
    return;
  }

  try {
    const data = await apiRequest('/conversations/groups', {
      method: 'POST',
      body: JSON.stringify({
        title: title.trim(),
        className: className.trim(),
        type: 'group'
      })
    });

    await loadConversations();

    const newId = getId(data.conversation);

    if (newId) {
      await selectChat(newId);
    }

    toast('Group created successfully.');

  } catch (error) {
    console.error('Group creation failed:', error);
    toast(error.message);
  }
}


/* =========================================
   GROUP CREATION BUTTON
========================================= */

function setupGroupCreation() {
  const heading = document.querySelector('.inbox-heading');

  if (!heading || !currentUser) return;

  if (!['teacher', 'admin'].includes(currentUser.role)) {
    return;
  }

  if ($('#createGroupButton')) return;

  const button = document.createElement('button');

  button.type = 'button';
  button.id = 'createGroupButton';
  button.className = 'plus';
  button.textContent = '◎';
  button.title = 'Create a group chat';
  button.setAttribute('aria-label', 'Create a group chat');

  button.style.marginLeft = '8px';

  button.addEventListener('click', createGroupConversation);

  heading.appendChild(button);
}


/* =========================================
   CREATE GROUP CONVERSATION
========================================= */

async function createGroupConversation() {
  if (!currentUser || !['teacher', 'admin'].includes(currentUser.role)) {
    toast('Only teachers and administrators can create groups.');
    return;
  }

  const title = window.prompt('Enter the group name:');

  if (title === null || title.trim().length < 2) {
    return;
  }

  const className = window.prompt(
    'Enter the exact class name (e.g. JSS 1 or SS 2).\nLeave blank to create an all-school group:'
  );

  if (className === null) {
    return;
  }

  try {
    const data = await apiRequest('/conversations/groups', {
      method: 'POST',
      body: JSON.stringify({
        title: title.trim(),
        className: className.trim(),
        type: 'group'
      })
    });

    await loadConversations();

    const newId = getId(data.conversation);

    if (newId) {
      await selectChat(newId);
    }

    toast('Group created successfully.');

  } catch (error) {
    console.error('Group creation failed:', error);
    toast(error.message);
  }
}


/* =========================================
   GROUP CREATION BUTTON
========================================= */

function setupGroupCreation() {
  const heading = document.querySelector('.inbox-heading');

  if (!heading || !currentUser) return;

  if (!['teacher', 'admin'].includes(currentUser.role)) {
    return;
  }

  if ($('#createGroupButton')) return;

  const button = document.createElement('button');

  button.type = 'button';
  button.id = 'createGroupButton';
  button.className = 'plus';
  button.textContent = '◎';
  button.title = 'Create a group chat';
  button.setAttribute('aria-label', 'Create a group chat');

  button.style.marginLeft = '8px';

  button.addEventListener('click', createGroupConversation);

  heading.appendChild(button);
}



/* =========================================
   SCHOOL CHANNEL SHORTCUTS
========================================= */

function setupChannels() {
  document.querySelectorAll('[data-chat]').forEach(button => {
    const requested = button.dataset.chat.toLowerCase();

    // Keep the Teachers' Corner shortcut visible to teachers and admins.
    if (requested === 'teachers') {
      button.hidden = !['teacher', 'admin'].includes(currentUser?.role);
    }

    button.addEventListener('click', () => {
      if (requested === 'teachers' && !['teacher', 'admin'].includes(currentUser?.role)) {
        toast('Teachers’ Corner is available to teachers and admins only.');
        return;
      }

      const names = {
        general: 'general',
        ss2: 'ss2',
        teachers: 'teacher',
        notices: 'notice'
      };

      const keyword = names[requested] || requested;
      const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

      let match = conversations.find(conversation => {
        const titleKey = normalize(getConversationName(conversation));
        const classKey = normalize(conversation.className);
        if (requested === 'ss2') {
          // This shortcut must open the SS2-specific group, not an arbitrary
          // whole-SSS group that happens to be returned first by the API.
          return getConversationType(conversation) === 'group' &&
            (titleKey.includes('ss2') || classKey === 'ss2');
        }
        if (requested === 'notices') {
          return getConversationType(conversation) === 'announcement' || titleKey.includes('notice');
        }
        return titleKey.includes(normalize(keyword));
      });

      if (match) {
        selectChat(getId(match)).catch(error => {
          toast(error.message);
        });
      } else {
        toast('This conversation is not available to your account.');
      }
    });
  });
}


/* =========================================
   SEARCH AND FILTERS
========================================= */

function setupFilters() {
  $('#search')?.addEventListener('input', () => { drawList(); renderAnnouncementBoard(); });

  document.querySelectorAll('[data-filter]').forEach(button => {
    button.addEventListener('click', () => {
      currentFilter = button.dataset.filter;

      document.querySelectorAll('[data-filter]').forEach(item => {
        item.classList.toggle('selected', item === button);
      });

      drawList();
    });
  });

  document.querySelectorAll('[data-view]').forEach(button => {
    button.addEventListener('click', () => {
      currentView = button.dataset.view;
      currentFilter = 'all';
      announcementConversationOpen = false;
      $('#backToAnnouncements')?.remove();

      document.querySelectorAll('[data-view]').forEach(item => {
        item.classList.toggle('active', item === button);
      });

      document.querySelectorAll('[data-filter]').forEach(item => {
        item.classList.toggle(
          'selected',
          item.dataset.filter === 'all'
        );
      });

      drawList();
    });
  });
}


/* =========================================
   MESSAGE COMPOSER
========================================= */

function setupComposer() {
  const input = $('#messageInput');
  const form = $('#messageForm');

  if (!input || !form) {
    console.warn('Message composer elements are missing.');
    return;
  }

  input.addEventListener('input', event => {
    setText(
      '#counter',
      `${event.target.value.length} / 1000`
    );

    input.style.height = 'auto';

    input.style.height =
      Math.min(input.scrollHeight, 110) + 'px';
  });

  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();

      form.requestSubmit();
    }
  });

  form.addEventListener('submit', sendMessage);
}


/* =========================================
   PAGE CONTROLS
========================================= */

function setupPageControls() {
  $('#newMessage')?.addEventListener(
    'click',
    createDirectConversation
  );

  $('#closePinned')?.addEventListener('click', () => {
    $('#pinned')?.remove();
  });

  $('#infoButton')?.addEventListener('click', () => {
    toast('Conversation information is shown in the details panel.');
  });

  $('#menuToggle')?.addEventListener('click', () => {
    $('#sidebar')?.classList.toggle('open');
  });

  document.addEventListener('click', event => {
    if (
      window.innerWidth < 780 &&
      !event.target.closest('#sidebar') &&
      !event.target.closest('#menuToggle')
    ) {
      $('#sidebar')?.classList.remove('open');
    }
  });
}


/* =========================================
   SOCKET.IO
========================================= */

function connectSocket() {
  if (typeof window.io !== 'function') {
    console.warn('Socket.IO client is unavailable.');
    return;
  }

  if (socket) {
    socket.disconnect();
  }

  socket = window.io({
    withCredentials: true
  });

  socket.on('connect', () => {
    socketReady = true;

    setText('#connectionStatus', 'Connected');
    setText('#connectionDescription', 'Live messaging active');

    if (activeId) {
      socket.emit('conversation:join', activeId);
    }
  });

  socket.on('disconnect', () => {
    socketReady = false;

    setText('#connectionStatus', 'Reconnecting');
    setText('#connectionDescription', 'Trying to reconnect');
  });

  socket.on('connect_error', error => {
    console.error('Socket.IO connection error:', error.message);
  });

  socket.on('message:new', message => {
    if (!message) return;

    const conversationId =
      getId(message.conversation) ||
      String(message.conversationId || '');

    if (conversationId === activeId) {
      appendMessage(message);
    }

    loadConversations().catch(error => {
      console.error('Conversation refresh failed:', error);
    });
  });

  socket.on('announcements:refresh', () => {
    loadConversations().catch(error => {
      console.error('Announcement refresh failed:', error);
    });
  });
}

function loadSocketClient() {
  if (typeof window.io === 'function') {
    connectSocket();
    return;
  }

  const existingScript = document.querySelector(
    'script[src="/socket.io/socket.io.js"]'
  );

  if (existingScript) {
    existingScript.addEventListener('load', connectSocket, {
      once: true
    });
    return;
  }

  const script = document.createElement('script');

  script.src = '/socket.io/socket.io.js';

  script.onload = connectSocket;

  script.onerror = () => {
    console.warn('Could not load the Socket.IO client.');
  };

  document.head.appendChild(script);
}


/* =========================================
   EMPTY CHAT
========================================= */

function showEmptyConversation() {
  setText('#activeTitle', 'No conversations');
  setText('#activeSubtitle', 'Your conversations will appear here.');
  setText('#activeAvatar', '?');

  setText('#detailTitle', 'No conversation selected');
  setText('#detailDescription', 'Select a conversation to see its details.');
  setText('#detailAvatar', '?');

  setText('#memberCount', '—');
  setText('#chatType', '—');

  const messages = $('#messages');

  if (messages) {
    messages.innerHTML = `
      <div class="empty-state">
        You do not have any conversations yet.
        <br>
        Click + to find someone in your school.
      </div>
    `;
  }
}


/* =========================================
   INITIALIZE
========================================= */
async function initializeCommunication() {
  await loadCurrentUser();

  setupFilters();
  setupAnnouncements();
  setupComposer();
  setupPageControls();
  setupChannels();
  setupGroupCreation();

  createDirectoryModal();

  await loadConversations();

  loadSocketClient();
}


/* =========================================
   STARTUP CONTROL
========================================= */

async function startCommunication() {
  const app = $('#communicationApp');

  if (!app || app.hidden) return;

  if (communicationStarted || communicationStarting) {
    return;
  }

  communicationStarting = true;

  try {
    await initializeCommunication();

    communicationStarted = true;

    console.log('Christower Connect started successfully.');

  } catch (error) {
    console.error('Christower Connect startup error:', error);

    const chatList = $('#chatList');

    if (chatList) {
      chatList.innerHTML = `
        <div class="empty-state">
          Could not load conversations.
          <br>
          ${safe(error.message)}
        </div>
      `;
    }

    toast(error.message || 'Unable to start communication.');

  } finally {
    communicationStarting = false;
  }
}


/* =========================================
   LOGIN EVENTS
========================================= */

window.addEventListener(
  'christower:authenticated',
  () => {
    communicationStarted = false;
    startCommunication();
  }
);


/* =========================================
   PAGE STARTUP
========================================= */

document.addEventListener('DOMContentLoaded', () => {
  startCommunication();
});
