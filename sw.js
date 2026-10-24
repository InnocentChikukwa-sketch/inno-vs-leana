// Only shows notifications and opens the game when one is tapped.
// It never caches the page, so updates to the game show up straight away.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const tab = e.notification.data && e.notification.data.tab;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) {
          if (tab) c.postMessage({ open: tab });
          return c.focus();
        }
      }
      return self.clients.openWindow("./");
    })
  );
});
