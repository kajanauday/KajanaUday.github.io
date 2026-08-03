// Firebase app/database/auth setup — the one place credentials live. Every
// other module reaches the database through `database`/`wordsRef` exported
// here rather than initializing its own connection.
const firebaseConfig = {
  apiKey: "AIzaSyAcahdEVwVPQc5J5ejAvFIAP7zu5ciiOqc",
  authDomain: "kajanaudaynotes.firebaseapp.com",
  databaseURL: "https://kajanaudaynotes-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "kajanaudaynotes",
  storageBucket: "kajanaudaynotes.firebasestorage.app",
  messagingSenderId: "696311985600",
  appId: "1:696311985600:web:ceaf9f9fcaf30cabc5c425",
  measurementId: "G-Y9QK783LVC"
};

export const firebaseApp = firebase.apps.length ? firebase.app() : firebase.initializeApp(firebaseConfig);
export const database = firebase.database(firebaseApp);
export const auth = firebase.auth();
export const wordsRef = database.ref('words');
