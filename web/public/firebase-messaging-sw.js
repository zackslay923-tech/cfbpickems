importScripts("https://www.gstatic.com/firebasejs/12.1.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.1.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyBjEhQs6kmYhD0TbCqVHdhRE5b1n2motnk",
  authDomain: "pickems-2k25.firebaseapp.com",
  projectId: "pickems-2k25",
  storageBucket: "pickems-2k25.firebasestorage.app",
  messagingSenderId: "382904529891",
  appId: "1:382904529891:web:a5420c75700a9ccd4da6d6"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const { title, body } = payload.notification || {};
  self.registration.showNotification(title || "CFB Pick'em", {
    body: body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png"
  });
});
