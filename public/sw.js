// Service Worker — Feelpay Web Push

// Tomar control inmediatamente al instalarse o actualizarse.
// Sin esto, cuando sw.js cambia el SW viejo sigue activo hasta que
// el usuario cierre todas las pestañas — el nuevo queda en "waiting"
// y el browser NO lo despierta para push en segundo plano.
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener("push", (event) => {
  if (!event.data) return;
  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: "Nuevo reporte", body: event.data.text() };
  }
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

// Cuando el browser rota el endpoint push (renovación automática),
// notificar al servidor para que actualice la DB sin perder user_id/rol.
self.addEventListener("pushsubscriptionchange", (event) => {
  const newSub = event.newSubscription;
  const oldEndpoint = event.oldSubscription?.endpoint;

  if (!newSub || !oldEndpoint) return;

  const p256dhBuffer = newSub.getKey("p256dh");
  const authBuffer = newSub.getKey("auth");
  if (!p256dhBuffer || !authBuffer) return;

  const toBase64 = (buf) =>
    btoa(String.fromCharCode(...new Uint8Array(buf)));

  event.waitUntil(
    fetch(self.location.origin + "/api/push/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        oldEndpoint,
        subscription: {
          endpoint: newSub.endpoint,
          keys: {
            p256dh: toBase64(p256dhBuffer),
            auth: toBase64(authBuffer),
          },
        },
      }),
    }).catch((err) => {
      console.error("[v0 sw] pushsubscriptionchange refresh error:", err);
    })
  );
});
