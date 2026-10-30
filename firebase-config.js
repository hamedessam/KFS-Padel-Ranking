// Shared Firebase init — imported by app.js and admin.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  initializeFirestore,
  enableNetwork, disableNetwork,
  collection, doc, getDoc, getDocs, setDoc, updateDoc, addDoc, deleteDoc,
  query, where, limit, orderBy, arrayUnion, arrayRemove,
  runTransaction, writeBatch, increment, onSnapshot,
  serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  getAuth,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
  onAuthStateChanged, updatePassword, EmailAuthProvider, reauthenticateWithCredential
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyCnat9jgc77PMF32bvW1dyUFN2xgzgX0DQ",
  authDomain: "kfs-padel-ranking.firebaseapp.com",
  projectId: "kfs-padel-ranking",
  storageBucket: "kfs-padel-ranking.firebasestorage.app",
  messagingSenderId: "986572738670",
  appId: "1:986572738670:web:8677c538eed5f8e136967f"
};

const app = initializeApp(firebaseConfig);
// Auto-detect long polling: some networks / iOS PWAs break the default
// streaming connection, which shows up as lists that "load forever". With this
// setting the SDK notices a stalled connection and switches to long polling.
export const db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
export const auth = getAuth(app);

export {
  enableNetwork, disableNetwork,
  collection, doc, getDoc, getDocs, setDoc, updateDoc, addDoc, deleteDoc,
  query, where, limit, orderBy, arrayUnion, arrayRemove, runTransaction, writeBatch, increment, onSnapshot, serverTimestamp, Timestamp,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged, updatePassword, EmailAuthProvider, reauthenticateWithCredential
};
