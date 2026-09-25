/* ==========================================================================
   firebase-config.js - hand-edit this once per shop.

   Sunshine Gadgets POS works completely offline with this file left blank.
   Cloud sync is an optional enhancement layer, never a requirement.

   To turn sync on:
     1. Create a free project at https://console.firebase.google.com
        (Add project -> name it -> Google Analytics is not needed, skip it).
     2. In the project, open Build -> Firestore Database -> Create database.
        Start in production mode (the default). Pick any region.
     3. Build -> Authentication -> Get started -> enable the "Anonymous"
        sign-in provider. This app signs every device in anonymously so
        Firestore's security rules can require request.auth != null instead
        of allowing fully public access - see firebase/firestore.rules.
     4. Paste the contents of firebase/firestore.rules into
        Firestore Database -> Rules, replacing the default, and Publish.
     5. Project settings (gear icon) -> General -> "Your apps" -> Add app ->
        Web (</>) -> register it (no Firebase Hosting needed) -> copy the
        firebaseConfig object it shows you into the fields below.
     6. Reload the app on every device that should sync. That's it - no
        rebuild, no deploy step.

   Leaving every field as "" keeps the app in pure offline mode: the sync
   pill will read "Offline only" and nothing else changes.

   TESTING AGAINST A SEPARATE PROJECT
   A test harness may define window.FIREBASE_CONFIG_OVERRIDE before this
   file runs (Playwright's addInitScript does this), and the app will use
   that project instead. This exists so automated tests never point at the
   shop's live database - see "Testing safely" in README.md.

   Nothing a normal browser does can set this: it has to be injected into
   the page before any script executes. In ordinary use this file behaves
   exactly as it always has.
   ========================================================================== */

window.FIREBASE_CONFIG = window.FIREBASE_CONFIG_OVERRIDE || {
  apiKey: "AIzaSyBSydCYchOOOy0bE56j1-nMLbosg2AqFKc",
  authDomain: "sunshine-8f335.firebaseapp.com",
  projectId: "sunshine-8f335",
  storageBucket: "sunshine-8f335.firebasestorage.app",
  messagingSenderId: "855217738366",
  appId: "1:855217738366:web:68c1d491f156c1851e7e2f"
};
