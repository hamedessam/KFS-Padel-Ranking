// Shared Firebase init — imported by app.js and admin.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore,
  collection, doc, getDoc, getDocs, setDoc, updateDoc, addDoc,
  query, where, limit, orderBy, arrayUnion,
  runTransaction, writeBatch, increment,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCnat9jgc77PMF32bvW1dyUFN2xgzgX0DQ",
  authDomain: "kfs-padel-ranking.firebaseapp.com",
  projectId: "kfs-padel-ranking",
  storageBucket: "kfs-padel-ranking.firebasestorage.app",
  messagingSenderId: "986572738670",
  appId: "1:986572738670:web:8677c538eed5f8e136967f"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

export {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, addDoc,
  query, where, limit, orderBy, arrayUnion, runTransaction, writeBatch, increment, serverTimestamp
};
