// Service Worker — Feelpay Web Push
self.addEventListener("push", (event) => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title ?? "Nuevo reporte", {
      body: data.body ?? "",
      icon: "/opad-logo.png",
      badge: "/opad-logo.png",
      tag: data.tag ?? "reporte",
      renotify: true,
      data: { url: data.url ?? "/" },
      vibrate: [200, 100, 200],
      requireInteraction: true,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? "/";
  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (client.url.startsWith(self.location.origin) && "focus" in client) {
            return client.focus();
          }
        }
        return clients.openWindow(url);
      })
  );
});
