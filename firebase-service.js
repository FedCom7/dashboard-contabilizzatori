import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, collection, getDocs, doc, setDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

// Initialize Firebase
let db = null;
try {
    const app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    console.log("Firebase initialized successfully");
} catch (error) {
    console.error("Error initializing Firebase:", error);
}

// Service object exposed globally
window.FirebaseService = {
    isInitialized: () => !!db,

    // Letture
    getLetture: async () => {
        if (!db) throw new Error("Firebase not initialized");
        const querySnapshot = await getDocs(collection(db, "letture"));
        return querySnapshot.docs.map(doc => doc.data());
    },

    saveLettura: async (lettura) => {
        if (!db) throw new Error("Firebase not initialized");
        // Usa la data come ID del documento per evitare duplicati
        await setDoc(doc(db, "letture", lettura.data), lettura);
    },

    deleteLettura: async (dateStr) => {
        if (!db) throw new Error("Firebase not initialized");
        await deleteDoc(doc(db, "letture", dateStr));
    },

    // Periodi Riscaldamento
    getHeatingPeriods: async () => {
        if (!db) throw new Error("Firebase not initialized");
        const querySnapshot = await getDocs(collection(db, "heating_periods"));
        if (querySnapshot.empty) return null;
        return querySnapshot.docs.map(doc => doc.data());
    },

    saveHeatingPeriod: async (period) => {
        if (!db) throw new Error("Firebase not initialized");
        // Usa data inizio come ID
        await setDoc(doc(db, "heating_periods", period.start), period);
    },

    deleteHeatingPeriod: async (startStr) => {
        if (!db) throw new Error("Firebase not initialized");
        await deleteDoc(doc(db, "heating_periods", startStr));
    }
};
