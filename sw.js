// omonitor service worker, for Web Push and the app badge. It has no fetch handler, so it never caches or intercepts a
// page load; the one cache entry it keeps is its own badge state.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

const STATE_CACHE = 'omonitor-sw-state';
const stateKey = () => new URL('__omonitor/badge-state', self.registration.scope).href;
const isCount = (n) => Number.isSafeInteger(n) && n >= 0;
const positiveId = (n) => (Number.isSafeInteger(n) && n > 0 ? n : null);
const nonEmpty = (s) => (typeof s === 'string' && s ? s : null);

// The last badge applied, {revision, badgeCount}. It is kept in the cache so a restarted worker still knows it.
let known = null;
async function loadBadge() {
  if (known) return known;
  try {
    const r = await (await self.caches.open(STATE_CACHE)).match(stateKey());
    const v = r ? await r.json() : null;
    if (v && isCount(v.revision) && isCount(v.badgeCount)) known = v;
  } catch (e) { console.warn('[omonitor sw] could not read the badge state', e); }
  return (known ||= { revision: -1, badgeCount: 0 });
}

// The Badging API is optional (missing in Firefox and some desktop browsers); without it only the state is kept.
async function showBadge(n) {
  const nav = self.navigator;
  if (!nav || typeof nav.setAppBadge !== 'function') return;
  try {
    if (n > 0) await nav.setAppBadge(n);
    else if (typeof nav.clearAppBadge === 'function') await nav.clearAppBadge();
    else await nav.setAppBadge(0);
  } catch (e) { console.warn('[omonitor sw] could not set the app badge', e); }
}

// A device with push off shows no number, whatever an open tab or a request still in flight reports. A lookup that
// fails rejects the update instead of passing for "off", so the report is not answered and the page sends it again.
const subscribed = async () => !!(await self.registration.pushManager?.getSubscription());

// Page snapshots and pushes arrive in any order: a push can be delayed past the read that cleared it, or land after a
// restart. A count is applied only when its revision is not older than the last one applied. Updates run one at a time.
let badgeQueue = Promise.resolve();
function updateBadge(revision, badgeCount) {
  if (!isCount(revision) || !isCount(badgeCount)) return Promise.resolve(false);
  const run = badgeQueue.then(async () => {
    if (!(await subscribed())) return false;
    const cur = await loadBadge();
    if (revision < cur.revision) return false;
    known = { revision, badgeCount };
    try {
      await (await self.caches.open(STATE_CACHE)).put(stateKey(), new Response(JSON.stringify(known), { headers: { 'content-type': 'application/json' } }));
    } catch (e) { console.warn('[omonitor sw] could not save the badge state', e); }
    await showBadge(badgeCount);
    return true;
  });
  badgeQueue = run.then(() => {}, () => {});
  return run;
}

// Push turned off: no count is kept, so the next one the dashboard reports (push back on) is taken whatever its revision.
function clearBadge() {
  const run = badgeQueue.then(async () => {
    known = { revision: -1, badgeCount: 0 };
    try { await (await self.caches.open(STATE_CACHE)).delete(stateKey()); } catch (e) { console.warn('[omonitor sw] could not drop the badge state', e); }
    await showBadge(0);
  });
  badgeQueue = run.then(() => {}, () => {});
  return run;
}

// The dashboard reports {type:'omonitor:badge', revision, badgeCount} with each snapshot, and 'omonitor:badge-off' when
// push is turned off on this device. A report is answered on its port once handled (applied, older than the badge, or
// push off): the page counts a snapshot as delivered only then. A worker from before this version never answers.
self.addEventListener('message', (e) => {
  const m = e.data;
  const ack = () => e.ports?.[0]?.postMessage('ok');
  const failed = (err) => console.warn('[omonitor sw] could not update the badge', err);
  if (m?.type === 'omonitor:badge') e.waitUntil(updateBadge(m.revision, m.badgeCount).then(ack, failed));
  else if (m?.type === 'omonitor:badge-off') e.waitUntil(clearBadge());
});

// A push was sent with the count of its moment; a read on another device while it waited for delivery makes that count
// stale. The server's current snapshot fixes it; offline, the payload's count stays until the next push or app open.
async function freshBadge() {
  const api = (p) => new URL(`api/${p}`, self.registration.scope).href;
  const signal = AbortSignal.timeout(4000);
  try {
    const cfg = await (await self.fetch(api('config'), { cache: 'no-store', signal })).json();
    const r = await self.fetch(api('push/unread'), { cache: 'no-store', signal, headers: { 'x-mc-key': cfg.key } });
    if (!r.ok) return;
    const s = await r.json();
    if (s && s.unread && typeof s.unread === 'object') await updateBadge(s.revision, Object.keys(s.unread).length);
  } catch (e) { console.warn('[omonitor sw] could not read the unread count', e); }
}

self.addEventListener('push', (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { body: e.data ? e.data.text() : '' }; }
  if (!m || typeof m !== 'object') m = {};
  const threadId = nonEmpty(m.threadId);
  // One notification per session: a newer one replaces the older instead of stacking up. Every push shows one, even a
  // stale one, since the browser requires a visible notification for each push.
  const tag = threadId ? `omonitor:${threadId}` : `omonitor:${m.kind || 'note'}`;
  e.waitUntil(Promise.all([
    self.registration.showNotification(m.title || 'omonitor', {
      body: m.body || '', tag, renotify: true, icon: 'app/icon-180.png', data: { threadId, notificationId: positiveId(m.notificationId) },
    }),
    updateBadge(m.revision, m.badgeCount).catch((err) => console.warn('[omonitor sw] could not update the badge', err)).then(freshBadge),
  ]));
});

// Opens the session: an open dashboard is focused and told which one; otherwise the app opens at
// #session=<id>&notification=<n>. The page marks the notification read once it shows the session, not here.
// Notifications shown by an older worker carry only threadId and open the same way without a notification id.
async function openApp(threadId, notificationId) {
  const scope = self.registration.scope;
  const rank = (w) => (w.focused ? 2 : 0) + (w.visibilityState === 'visible' ? 1 : 0);
  const wins = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
    .filter((w) => w.url.startsWith(scope))
    .sort((a, b) => rank(b) - rank(a));
  if (wins.length) {
    let win = null;
    try { win = await wins[0].focus(); } catch (err) { console.warn('[omonitor sw] could not focus the dashboard', err); }
    if (win) {
      if (threadId) win.postMessage({ type: 'omonitor:open', threadId, ...(notificationId ? { notificationId } : {}) });
      return;
    }
  }
  const hash = threadId ? `#session=${encodeURIComponent(threadId)}${notificationId ? `&notification=${notificationId}` : ''}` : '';
  await self.clients.openWindow(`./${hash}`);
}

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const d = e.notification.data || {};
  const threadId = nonEmpty(d.threadId);
  e.waitUntil(openApp(threadId, threadId ? positiveId(d.notificationId) : null));
});
