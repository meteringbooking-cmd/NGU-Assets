// Shared Firebase initialization for the Asset Tracking Management System.
// Every page imports { db, storage } from this module instead of
// initializing Firebase itself, so there is only ever one app instance.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyBb9x_7RJcsg0Iw2whRylbybuQNuLr6Yco",
  authDomain: "meter-install-check.firebaseapp.com",
  projectId: "meter-install-check",
  storageBucket: "meter-install-check.firebasestorage.app",
  messagingSenderId: "238786946643",
  appId: "1:238786946643:web:f1965fca6d3b79ef5e08a6",
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const storage = getStorage(app);

// NOTE: This project ("meter-install-check") is shared with other tools.
// The Asset Tracking system uses its own set of collections (see
// shared/collections.js) so it will not collide with existing data.
// Firestore Security Rules must allow read/write on these collections —
// if you are in test mode this already works; before going live, add
// rules scoped to the collection names below.
