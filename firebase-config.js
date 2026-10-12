// Firebase web config is public by design; access is controlled by the Realtime Database rules.
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAcahdEVwVPQc5J5ejAvFIAP7zu5ciiOqc',
  authDomain: 'kajanaudaynotes.firebaseapp.com',
  databaseURL: 'https://kajanaudaynotes-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'kajanaudaynotes',
  storageBucket: 'kajanaudaynotes.firebasestorage.app',
  messagingSenderId: '696311985600',
  appId: '1:696311985600:web:ceaf9f9fcaf30cabc5c425',
  measurementId: 'G-Y9QK783LVC'
};
// Everything this app stores lives under this key, apart from other apps' data in the same database.
const FIREBASE_ROOT = 'familyBudget';
