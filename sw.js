// Only shows notifications and opens the game when one is tapped.
// It never caches the page, so updates to the game show up straight away.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const tab = data.tab;
  const url = data.url; // set by Last Card so the tap opens that game, not Truth or Dare
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const same = url
        ? list.filter((c) => c.url.split("#")[0] === url.split("#")[0])
        : list.filter((c) => !/(lastcard|tsoro)\.html/.test(c.url)); // Truth or Dare notifications
      for (const c of same.length ? same : list) {
        if ("focus" in c) {
          if (tab) c.postMessage({ open: tab });
          return c.focus();
        }
      }
      return self.clients.openWindow(url || "./");
    })
  );
});
