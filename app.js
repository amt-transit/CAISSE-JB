import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import { getFirestore, collection, addDoc, setDoc, deleteDoc, query, where, orderBy, onSnapshot, updateDoc, doc, serverTimestamp, getDocs, Timestamp, writeBatch } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";
import { createApp, ref, computed, onMounted } from "https://unpkg.com/vue@3/dist/vue.esm-browser.js";

// --- CONFIGURATION FIREBASE ---
const firebaseConfig = {
    apiKey: "AIzaSyDvo7FRCpr_mE4nTGz6VW7-UL0U1JKe-g8",
    authDomain: "caisse-jb.firebaseapp.com",
    projectId: "caisse-jb",
    storageBucket: "caisse-jb.firebasestorage.app",
    messagingSenderId: "877905828814",
    appId: "1:877905828814:web:79840cd0dfcb8a8036e99f"   
};

let db, auth;
try {
    const app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    auth = getAuth(app);
} catch(e) { console.warn("Firebase non configuré"); }

createApp({
    setup() {
        // --- ETAT ---
        const user = ref(null);
        const isAdmin = ref(false);
        const authLoading = ref(true);
        const loginForm = ref({ email: '', password: '' });
        const loginError = ref('');

        const currentView = ref('dashboard'); 
        const currentSession = ref(null);
        const transactions = ref([]); 
        const loading = ref(false);
        const showClosingModal = ref(false);
        const showEditStartModal = ref(false);
        
        // BASE CLIENTS
        const clientDatabase = ref([]); // La liste complète en mémoire
        const searchQuery = ref('');
        const showSuggestions = ref(false);
        const fileInput = ref(null);
        const importStatus = ref('');

        // Historique
        const closedSessions = ref([]);
        const showHistoryModal = ref(false);
        const selectedSessionHistory = ref(null);
        const selectedTransactionsHistory = ref([]);
        
        const startAmounts = ref({ espece: 0, om: 0, wave: 0 });
        const getTodayString = () => new Date().toISOString().split('T')[0];
        // AJOUT de form.reference
        const form = ref({ 
            date: getTodayString(), 
            type: 'DEBIT', 
            category: 'ESPECE', 
            label: '', 
            recipient: '', 
            reference: '', 
            amount: '', 
            expectedPrice: 0, // <--- NOUVEAU : On stocke le prix théorique ici
            isHidden: false 
        });
        const closing = ref({ om: 0, wave: 0 });
        const billets = ref([
            { val: 10000, count: 0 }, { val: 5000, count: 0 }, { val: 2000, count: 0 },
            { val: 1000, count: 0 }, { val: 500, count: 0 }, { val: 200, count: 0 },
            { val: 100, count: 0 }, { val: 50, count: 0 }
        ]);

        // --- AUTH ---
        const login = async () => {
            loginError.value = '';
            try { await signInWithEmailAndPassword(auth, loginForm.value.email, loginForm.value.password); } 
            catch (e) { loginError.value = "Erreur login."; }
        };

        const logout = async () => {
            await signOut(auth);
            user.value = null; isAdmin.value = false; transactions.value = []; currentSession.value = null;
        };

        onMounted(() => {
            if (auth) {
                onAuthStateChanged(auth, (u) => {
                    user.value = u; authLoading.value = false;
                    if (u) {
                        // ⚠️ REMPLACEZ L'EMAIL CI-DESSOUS PAR LE VÔTRE ⚠️
                        // Exemple : isAdmin.value = (u.email === 'jean.bernard@gmail.com');
                        isAdmin.value = (u.email === 'admin@caisse.com'); 
                        
                        // Ou pour le test, forcez tout le monde Admin (déconseillé après) :
                        // isAdmin.value = true;

                        loadSessionData();
                        fetchHistory();
                        loadClients();
                    }
                });
            }
        });

        // --- CHARGEMENT DES DONNÉES (Mise à jour) ---
        const loadSessionData = () => {
            if(!db) return;
            const q = query(collection(db, "sessions"), where("status", "==", "OPEN"));
            onSnapshot(q, (snap) => {
                if (!snap.empty) {
                    const d = snap.docs[0];
                    const data = d.data();
                    
                    // Initialisation des reports si manquants
                    if (!data.startAmounts) data.startAmounts = { espece: data.startBalance || 0, om: 0, wave: 0 };
                    
                    // --- NOUVEAU : On charge le billetage s'il existe déjà en base ---
                    if (data.billetage) {
                        billets.value = data.billetage;
                    }

                    currentSession.value = { id: d.id, ...data };
                    subscribeToTransactions(d.id);
                } else { 
                    currentSession.value = null; 
                }
            });
        };

        // --- SAUVEGARDE AUTOMATIQUE DU BILLETAGE (Nouveau) ---
        const saveBilletage = async () => {
            if (!currentSession.value) return;
            try {
                // On met à jour uniquement le champ "billetage" de la session en cours
                await updateDoc(doc(db, "sessions", currentSession.value.id), {
                    billetage: billets.value
                });
                // Pas besoin d'alerte, c'est une sauvegarde silencieuse
            } catch (e) {
                console.error("Erreur sauvegarde billetage", e);
            }
        };

        // --- CLIENT DATABASE LOGIC ---
        const loadClients = async () => {
            if(!db) return;
            // On charge tout d'un coup (car ~1500 clients, c'est léger)
            const snap = await getDocs(collection(db, "clients"));
            clientDatabase.value = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        };

        // --- 1. FONCTION D'IMPORTATION (Mise à jour avec Conversion Euro -> CFA) ---
        const importClients = async () => {
            const file = fileInput.value.files[0];
            if (!file) return alert("Veuillez choisir un fichier CSV");
            
            importStatus.value = "Analyse en cours...";
            
            Papa.parse(file, {
                header: true,
                delimiter: ",", // Séparateur virgule
                skipEmptyLines: true,
                complete: async (results) => {
                    if (results.data.length === 0) return alert("Fichier vide ou mauvais format");
                    
                    importStatus.value = `Traitement de ${results.data.length} lignes...`;
                    
                    const chunks = [];
                    for (let i = 0; i < results.data.length; i += 400) {
                        chunks.push(results.data.slice(i, i + 400));
                    }

                    try {
                        let countAdded = 0;
                        for (const chunk of chunks) {
                            const batch = writeBatch(db);
                            chunk.forEach(row => {
                                if(row.REFERENCE) {
                                    const cleanRef = row.REFERENCE.replace(/\//g, "-").trim();
                                    const docRef = doc(db, "clients", cleanRef);
                                    
                                    // CONVERSION AUTOMATIQUE EURO -> CFA
                                    // On remplace la virgule par un point (au cas où) et on multiplie par 656
                                    let prixCFA = 0;
                                    if (row.PRIX) {
                                        // Nettoyage du prix (enlève les espaces, remplace , par .)
                                        const prixNet = row.PRIX.toString().replace(/\s/g, '').replace(',', '.');
                                        prixCFA = Math.round(parseFloat(prixNet) * 656);
                                    }

                                    batch.set(docRef, {
                                        REFERENCE: row.REFERENCE,
                                        EXPEDITEUR: row.EXPEDITEUR || '',
                                        TELEPHONE: row.TELEPHONE || '',
                                        PRIX: prixCFA, // Ici on stocke le montant converti
                                        DESTINATEUR: row.DESTINATEUR || '',
                                        TELEPHONE2: row.TELEPHONE2 || ''
                                    }, { merge: true });
                                    
                                    countAdded++;
                                }
                            });
                            await batch.commit();
                        }
                        importStatus.value = `Succès ! ${countAdded} fiches traitées (Converties en CFA).`;
                        loadClients(); 
                    } catch (e) {
                        console.error(e);
                        importStatus.value = "Erreur import : " + e.message;
                    }
                }
            });
        };

        // --- RECHERCHE INTELLIGENTE (Mise à jour avec RÉFÉRENCE) ---
        const filteredClients = computed(() => {
            // On attend au moins 2 caractères pour chercher
            if (!searchQuery.value || searchQuery.value.length < 2) return [];
            
            const q = searchQuery.value.toLowerCase();
            
            return clientDatabase.value.filter(c => 
                // Recherche par NOM (Expéditeur ou Destinataire)
                (c.EXPEDITEUR && c.EXPEDITEUR.toLowerCase().includes(q)) || 
                (c.DESTINATEUR && c.DESTINATEUR.toLowerCase().includes(q)) || 
                
                // Recherche par TÉLÉPHONE
                (c.TELEPHONE && c.TELEPHONE.includes(q)) ||
                (c.TELEPHONE2 && c.TELEPHONE2.includes(q)) ||

                // Recherche par RÉFÉRENCE (Nouveau)
                (c.REFERENCE && c.REFERENCE.toLowerCase().includes(q))
            ).slice(0, 10);
        });

        // --- DANS LA FONCTION selectClient ---
        const selectClient = (client) => {
            form.value.label = client.EXPEDITEUR;
            form.value.recipient = client.DESTINATEUR;
            form.value.reference = client.REFERENCE;
            form.value.amount = client.PRIX; // On pré-remplit le montant à payer
            form.value.expectedPrice = client.PRIX; // <--- On mémorise le prix officiel pour le comparatif
            
            searchQuery.value = ''; 
            showSuggestions.value = false;
        };

        

        // --- HISTORIQUE ---
        const fetchHistory = async () => {
            if(!db) return;
            const q = query(collection(db, "sessions"), where("status", "==", "CLOSED"), orderBy("endTime", "desc"));
            const snap = await getDocs(q);
            closedSessions.value = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        };

        const openHistoryDetails = async (session) => {
            selectedSessionHistory.value = session;
            const q = query(collection(db, "transactions"), where("sessionId", "==", session.id), orderBy("timestamp", "desc"));
            const snap = await getDocs(q);
            selectedTransactionsHistory.value = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            showHistoryModal.value = true;
        };
        // --- DANS LE SETUP (Ajout de la variable d'état) ---
        const showHiddenTransactions = ref(true); // Par défaut, l'admin voit tout

        // --- FILTRAGE ET TRI (Mise à jour : Groupé par Mode + Date Décroissante) ---
        const visibleTransactions = computed(() => {
            // 1. D'abord, on filtre selon les droits (Admin/Visiteur)
            let filteredList = [];
            
            if (!isAdmin.value) {
                // Visiteur : On cache toujours les lignes masquées
                filteredList = transactions.value.filter(t => !t.isHidden);
            } else {
                // Admin : On respecte la case à cocher
                filteredList = showHiddenTransactions.value ? transactions.value : transactions.value.filter(t => !t.isHidden);
            }

            // 2. Ensuite, on applique le Tri Spécial
            return filteredList.sort((a, b) => {
                // A. Définition de l'ordre des groupes (1. Espèce, 2. Wave, 3. OM, 4. Banque)
                const orderMap = { 
                    'ESPECE': 1, 
                    'WAVE': 2, 
                    'OM': 3, 
                    'BANQUE': 4 
                };

                const orderA = orderMap[a.category] || 99; // 99 si inconnu
                const orderB = orderMap[b.category] || 99;

                // Si les catégories sont différentes, on trie par catégorie
                if (orderA !== orderB) {
                    return orderA - orderB;
                }

                // B. Si les catégories sont les mêmes, on trie par date (Le plus récent en haut)
                // On gère le format Timestamp de Firebase
                const timeA = a.timestamp && a.timestamp.toMillis ? a.timestamp.toMillis() : 0;
                const timeB = b.timestamp && b.timestamp.toMillis ? b.timestamp.toMillis() : 0;

                return timeB - timeA; // Décroissant
            });
        });

        const visibleHistoryTransactions = computed(() => {
            if (isAdmin.value) return selectedTransactionsHistory.value;
            return selectedTransactionsHistory.value.filter(t => !t.isHidden);
        });
        

        // --- CALCULS ---
        const totals = computed(() => {
            let t = { espece: 0, om: 0, wave: 0, global: 0, totalCredit: 0, totalDebit: 0 };
            const initial = currentSession.value && currentSession.value.startAmounts ? currentSession.value.startAmounts : { espece: 0, om: 0, wave: 0 };
            t.espece += initial.espece || 0;
            t.om += initial.om || 0;
            t.wave += initial.wave || 0;

            transactions.value.forEach(tx => {
                const principal = tx.amount || 0;
                const fees = tx.fees || 0; 
                const totalTx = principal - fees; 
                const sign = tx.type === 'CREDIT' ? 1 : -1;

                if (tx.type === 'CREDIT') t.totalCredit += principal;
                else t.totalDebit += principal;

                if (tx.category === 'ESPECE') t.espece += (principal * sign);
                if (tx.category === 'OM') t.om += (totalTx * sign);
                if (tx.category === 'WAVE') t.wave += (principal * sign);
            });
            t.global = t.espece + t.om + t.wave;
            return t;
        });

        const totalEspeceCompte = computed(() => billets.value.reduce((acc, b) => acc + (b.val * b.count), 0));
        
        const hasGap = computed(() => {
            const gapOM = closing.value.om - totals.value.om;
            const gapWave = closing.value.wave - totals.value.wave;
            const gapEspece = totalEspeceCompte.value - totals.value.espece;
            return (Math.abs(gapOM) > 5 || Math.abs(gapWave) > 5 || Math.abs(gapEspece) > 5);
        });

        // --- ACTIONS ---
        const startSession = async () => {
            if (!isAdmin.value) return alert("Refusé");
            loading.value = true;
            try {
                const sessionData = { startAmounts: { ...startAmounts.value }, startTime: serverTimestamp(), status: 'OPEN' };
                const docRef = await addDoc(collection(db, "sessions"), sessionData);
                currentSession.value = { id: docRef.id, ...sessionData };
                subscribeToTransactions(docRef.id);
            } catch (e) { alert("Erreur: " + e.message); }
            loading.value = false;
        };

        
        // --- DANS LA FONCTION addTransaction ---
        const addTransaction = async () => {
            if (!isAdmin.value) return alert("Refusé");
            if (!form.value.amount || !form.value.label || !form.value.date) return;
            
            // 1. Calcul des frais
            let fees = 0;
            if (form.value.category === 'OM') {
                const net = form.value.amount / 1.01;
                fees = Math.round(form.value.amount - net); 
            }
            const netAmountPaid = form.value.amount - fees;

            // 2. Gestion Date
            const selectedDate = new Date(form.value.date);
            const now = new Date();
            selectedDate.setHours(now.getHours(), now.getMinutes(), now.getSeconds());

            try {
                // A. Enregistrement Transaction (Journal)
                await addDoc(collection(db, "transactions"), {
                    sessionId: currentSession.value.id,
                    ...form.value,
                    expectedPrice: form.value.expectedPrice || 0,
                    recipient: form.value.recipient || '',
                    isHidden: form.value.isHidden || false,
                    fees: fees,
                    timestamp: Timestamp.fromDate(selectedDate)
                });

                // B. GESTION INTELLIGENTE DE LA BASE CLIENTS
                if (form.value.reference) {
                    // Nettoyage de la référence pour l'ID (ex: "MD/123" devient "MD-123")
                    const cleanRef = form.value.reference.replace(/\//g, "-").trim();
                    const clientRef = doc(db, "clients", cleanRef);

                    // On vérifie si ce client existe déjà dans notre liste locale
                    const existingClientIndex = clientDatabase.value.findIndex(c => c.REFERENCE === form.value.reference);

                    if (existingClientIndex !== -1) {
                        // --- CAS 1 : LE CLIENT EXISTE DÉJÀ ---
                        // On met à jour son solde SEULEMENT SI on avait un prix attendu (gestion de dette)
                        if (form.value.expectedPrice > 0) {
                            let newBalance = form.value.expectedPrice - netAmountPaid;
                            if (newBalance < 0) newBalance = 0; // Soldé

                            // Mise à jour Firebase
                            await updateDoc(clientRef, { PRIX: newBalance });
                            // Mise à jour Locale immédiate
                            clientDatabase.value[existingClientIndex].PRIX = newBalance;
                        }
                    } else {
                        // --- CAS 2 : C'EST UN NOUVEAU CLIENT (INCONNU) ---
                        // On le crée dans la base de données
                        const newClientData = {
                            REFERENCE: form.value.reference,
                            EXPEDITEUR: form.value.label,
                            DESTINATEUR: form.value.recipient || '',
                            TELEPHONE: '', // On n'a pas le tél dans ce formulaire, pas grave
                            PRIX: form.value.amount // On enregistre ce montant comme "Prix habituel" pour la prochaine fois
                        };

                        // Sauvegarde Firebase
                        await setDoc(clientRef, newClientData, { merge: true });

                        // Ajout à la liste locale pour qu'il apparaisse dans la recherche tout de suite
                        clientDatabase.value.push(newClientData);
                    }
                }
                
                // C. Reset Form
                form.value.label = '';
                form.value.recipient = '';
                form.value.reference = ''; 
                form.value.amount = '';
                form.value.expectedPrice = 0;
                form.value.isHidden = false;

            } catch (e) { 
                console.error(e);
                alert("Erreur ajout : " + e.message); 
            }
        };
        
        // --- AJOUT D'UNE PETITE FONCTION POUR LES ABREVIATIONS ---
        const getModeAbbr = (cat) => {
            if(cat === 'ESPECE') return 'ESP';
            if(cat === 'BANQUE') return 'BQ';
            return cat; // OM et WAVE restent pareil
        };

        const updateStartAmounts = async () => {
            if (!isAdmin.value) return;
            try {
                await updateDoc(doc(db, "sessions", currentSession.value.id), { startAmounts: currentSession.value.startAmounts });
                showEditStartModal.value = false;
            } catch(e) { alert("Erreur modif"); }
        };

        const openClosingModal = () => {
            if(!isAdmin.value) return alert("Accès réservé à l'admin");
            closing.value.om = totals.value.om;
            closing.value.wave = totals.value.wave;
            showClosingModal.value = true;
        };

        const confirmClose = async () => {
            if (!isAdmin.value) return;
            if(!confirm("Fermer la session ?")) return;
            try {
                await updateDoc(doc(db, "sessions", currentSession.value.id), {
                    status: 'CLOSED',
                    endTime: serverTimestamp(),
                    totalsComputed: totals.value,
                    flux: { credit: totals.value.totalCredit, debit: totals.value.totalDebit },
                    billetage: billets.value
                });
                startAmounts.value = { espece: totalEspeceCompte.value, om: closing.value.om, wave: closing.value.wave };
                currentSession.value = null; transactions.value = []; showClosingModal.value = false;
                fetchHistory();
            } catch (e) { alert("Erreur fermeture"); }
        };

        const deleteTransaction = async (id) => {
            if (!isAdmin.value) return;
            if(!confirm("Supprimer ?")) return;
            try { await deleteDoc(doc(db, "transactions", id)); } catch (e) { alert("Erreur"); }
        };

        const subscribeToTransactions = (sessionId) => {
            const q = query(collection(db, "transactions"), where("sessionId", "==", sessionId), orderBy("timestamp", "desc"));
            onSnapshot(q, (snapshot) => {
                transactions.value = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            });
        };

        // --- UTILS ---
        const formatMoney = (v) => (v || 0).toLocaleString('fr-FR') + ' F';
        const formatTime = (ts) => ts && ts.toDate ? ts.toDate().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : '--:--';
        const formatDate = (ts) => ts && ts.toDate ? ts.toDate().toLocaleDateString('fr-FR') : '';
        const formatDateTime = (ts) => ts && ts.toDate ? ts.toDate().toLocaleString('fr-FR') : '';

        const getBadgeClass = (cat) => ({
            'ESPECE': 'bg-green-100 text-green-800 px-2 py-1 rounded text-xs font-bold',
            'OM': 'bg-orange-100 text-orange-800 px-2 py-1 rounded text-xs font-bold',
            'WAVE': 'bg-blue-100 text-blue-800 px-2 py-1 rounded text-xs font-bold',
            'BANQUE': 'bg-gray-100 text-gray-800 px-2 py-1 rounded text-xs font-bold'
        }[cat]);

        const getGapClass = (gap) => {
            if (Math.abs(gap) < 5) return 'bg-green-100 text-green-800 border border-green-200'; // Caisse Juste
            if (gap > 0) return 'bg-blue-100 text-blue-800 border border-blue-200'; // Excédent
            return 'bg-red-100 text-red-800 border border-red-200'; // Manquant
        };
        const formatGap = (gap) => Math.abs(gap) < 5 ? 'OK' : (gap > 0 ? '+' + formatMoney(gap) : formatMoney(gap));

        // --- CORRECTION BUG PDF DANS exportToPDF ---
        const exportToPDF = () => {
            if (!window.jspdf) return alert("Erreur : La librairie PDF n'est pas chargée.");
            
            try {
                const { jsPDF } = window.jspdf;
                const doc = new jsPDF();

                doc.setFontSize(14);
                doc.text("Journal de Caisse", 14, 15);
                doc.setFontSize(10);
                doc.text("Généré le : " + new Date().toLocaleString(), 14, 22);
                
                // On utilise la liste visible à l'écran (donc ça respecte la case à cocher)
                const listToExport = visibleTransactions.value; 

                if (listToExport.length === 0) return alert("Rien à exporter !");

                const tableRows = listToExport.map(tx => {
                    const net = tx.amount - (tx.fees || 0);
                    
                    // --- CORRECTION DU FORMAT MONÉTAIRE POUR PDF ---
                    // On remplace les espaces insécables bizarres par un espace normal simple
                    // \s inclut les espaces, tabulations et les espaces insécables
                    const montantClean = formatMoney(net).replace(/\s/g, ' '); 

                    return [
                        formatDate(tx.timestamp) + '\n' + formatTime(tx.timestamp),
                        tx.reference || '-',
                        tx.label + (tx.isHidden ? ' (INT)' : ''),
                        tx.recipient || '',
                        getModeAbbr(tx.category),
                        montantClean // On utilise la version nettoyée
                    ];
                });

                doc.autoTable({
                    head: [["Date", "Réf", "Expéditeur", "Destinataire", "Mode", "Montant"]],
                    body: tableRows,
                    startY: 30,
                    theme: 'grid',
                    styles: { fontSize: 8, cellPadding: 2, valign: 'middle' },
                    headStyles: { fillColor: [63, 81, 181], textColor: 255, fontStyle: 'bold' },
                    columnStyles: {
                        0: { cellWidth: 20 },
                        4: { cellWidth: 15, halign: 'center' },
                        5: { halign: 'right', fontStyle: 'bold' }
                    }
                });

                doc.save("Journal_" + new Date().toISOString().slice(0,10) + ".pdf");

            } catch (error) { console.error(error); alert("Erreur PDF : " + error.message); }
        };

        const exportToExcel = (dataList = transactions.value, filename = "Export") => {
            const listToExport = isAdmin.value ? dataList : dataList.filter(t => !t.isHidden);
            const data = listToExport.map(tx => ({
                "Date": formatDate(tx.timestamp), "Heure": formatTime(tx.timestamp),
                "Type": tx.type === 'CREDIT' ? 'ENTRÉE' : 'SORTIE', 
                "Compte": tx.category,
                "Reference": tx.reference || '', // Export de la référence
                "Libellé": tx.label, 
                "Montant Total": tx.amount
            }));
            const ws = XLSX.utils.json_to_sheet(data);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, "Data");
            XLSX.writeFile(wb, filename + ".xlsx");
        };

        return {
            user, isAdmin, authLoading, loginForm, login, logout, loginError,
            currentView, 
            currentSession, transactions, visibleTransactions,
            loading, startAmounts, form, closing, billets, totals, totalEspeceCompte, showClosingModal, showEditStartModal, hasGap,
            // Historique
            closedSessions, showHistoryModal, selectedSessionHistory, selectedTransactionsHistory, visibleHistoryTransactions, openHistoryDetails,
            // Client DB
            clientDatabase, searchQuery, showSuggestions, filteredClients, selectClient, importClients, fileInput, importStatus,
            // Actions
            startSession, addTransaction, updateStartAmounts, openClosingModal, confirmClose, deleteTransaction,
            formatMoney, formatTime, formatDate, formatDateTime, getBadgeClass, getGapClass, formatGap, exportToExcel, exportToPDF,
            getModeAbbr, saveBilletage, showHiddenTransactions
        };
    }
}).mount('#app');