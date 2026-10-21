// Service worker: shows Box Scheduler's Web Push notifications and opens the
// app where they point when clicked.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: event.data ? event.data.text() : '' }
  }
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(data.title || 'Box Scheduler', {
        body: data.body || '',
        tag: data.tag,
        data: { url: data.url || '/' },
        requireInteraction: data.kind === 'reminder',
      })
      // Open tabs refresh their bell right away.
      for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'notification' })
    })(),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href
  event.waitUntil(
    (async () => {
      const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const tab = tabs.find((c) => new URL(c.url).origin === self.location.origin)
      if (tab) {
        await tab.focus()
        return tab.navigate(url)
      }
      return self.clients.openWindow(url)
    })(),
  )
})
