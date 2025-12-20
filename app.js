import { createApp, ref, computed, onMounted, watch } from "https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";
import { getFirestore, collection, addDoc, setDoc, deleteDoc, query, where, orderBy, onSnapshot, updateDoc, doc, serverTimestamp, getDocs, Timestamp, writeBatch, getDoc } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";

// ---------------------------------------------------------
// CONFIGURATION FIREBASE
// ---------------------------------------------------------
const firebaseConfig = {
    apiKey: "AIzaSyDvo7FRCpr_mE4nTGz6VW7-UL0U1JKe-g8",
    authDomain: "caisse-jb.firebaseapp.com",
    projectId: "caisse-jb",
    storageBucket: "caisse-jb.firebasestorage.app",
    messagingSenderId: "877905828814",
    appId: "1:877905828814:web:79840cd0dfcb8a8036e99f"   
};

// Initialisation
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

createApp({
    setup() {
        // --- ETAT AUTHENTIFICATION ---
        const user = ref(null);
        const authLoading = ref(true);
        const loginForm = ref({ email: '', password: '' });
        const loginError = ref('');
        const isAdmin = computed(() => user.value && user.value.email === 'admin@caisse.com'); 

        // --- ETAT APPLICATION ---
        const currentView = ref('dashboard'); 
        const currentSalaireView = ref('employes'); 
        
        // --- DONNEES CAISSE ---
        const currentSession = ref(null);
        const transactions = ref([]);
        const loading = ref(false);
        const startAmounts = ref({ espece: 0, om: 0, wave: 0 });
        const form = ref({ type: 'CREDIT', category: 'ESPECE', amount: '', label: '', recipient: '', reference: '', date: new Date().toISOString().split('T')[0], expectedPrice: 0, isHidden: false, isBill: false });
        const closing = ref({ om: 0, wave: 0 });
        const showClosingModal = ref(false);
        const billets = ref([ {val:10000, count:''}, {val:5000, count:''}, {val:2000, count:''}, {val:1000, count:''}, {val:500, count:''}, {val:200, count:''}, {val:100, count:''}, {val:50, count:''} ]);
        const showHiddenTransactions = ref(true);

        // --- DONNEES HISTORIQUE CAISSE ---
        const closedSessions = ref([]);
        const showHistoryModal = ref(false);
        const selectedSessionHistory = ref(null);
        const selectedTransactionsHistory = ref([]);
        const showEditTransactionModal = ref(false); // NOUVEAU
        const editingTx = ref({}); // NOUVEAU (Données en cours de modif)
        const originalTxState = ref({}); // NOUVEAU (Pour se souvenir de l'état avant modif)
        
        // --- DONNEES DATABASE CLIENT ---
        const clientDatabase = ref([]);
        const searchQuery = ref('');
        const showSuggestions = ref(false);
        const fileInput = ref(null);
        const importStatus = ref('');

        // --- DONNEES SALAIRE & RH ---
        const employeesList = ref([]);
        const salaryHistory = ref([]);
        const salaryFunds = ref([]); 
        const paiePeriod = ref("15"); 
        
        const showAddEmployeeModal = ref(false);
        const showEditEmployeeModal = ref(false); 
        const showIndividualHistoryModal = ref(false); 
        const showPayModal = ref(false);
        const showFundModal = ref(false);

        const newEmp = ref({ name: '', salary: 0, loan: 0, isTontine: false });
        const editingEmp = ref({}); 
        const selectedEmployeeHistoryId = ref(null);
        const selectedEmployeeHistoryName = ref('');
        const payForm = ref({});
        const newFund = ref({ amount: '', note: '' });
        
        const selectedHistoryMonth = ref(null); // Pour l'historique groupé

        // ---------------------------------------------------------
        // --- LOGIQUE SALAIRE ---
        // ---------------------------------------------------------

        const loadEmployees = () => {
             onSnapshot(collection(db, "employees"), (snap) => {
                employeesList.value = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            });
        };

        const loadSalaryHistory = () => {
             onSnapshot(query(collection(db, "salary_payments"), orderBy('timestamp', 'desc')), (snap) => {
                salaryHistory.value = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            });
        };

        const loadSalaryFunds = () => {
             onSnapshot(query(collection(db, "salary_funds"), orderBy('timestamp', 'desc')), (snap) => {
                salaryFunds.value = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            });
        };

        // GESTION EMPLOYES
        const saveNewEmployee = async () => {
            if(!newEmp.value.name || !newEmp.value.salary) return;
            try {
                await addDoc(collection(db, "employees"), { name: newEmp.value.name, salary: newEmp.value.salary, loan: newEmp.value.loan || 0, isTontine: newEmp.value.isTontine });
                showAddEmployeeModal.value = false;
                newEmp.value = { name: '', salary: 0, loan: 0, isTontine: false };
            } catch(e) { alert("Erreur: " + e.message); }
        };

        const openEditEmployee = (emp) => {
            editingEmp.value = { ...emp };
            showEditEmployeeModal.value = true;
        };

        const updateEmployee = async () => {
            try {
                await updateDoc(doc(db, "employees", editingEmp.value.id), { name: editingEmp.value.name, salary: editingEmp.value.salary, loan: editingEmp.value.loan, isTontine: editingEmp.value.isTontine });
                showEditEmployeeModal.value = false;
            } catch(e) { alert("Erreur: " + e.message); }
        };

        const deleteEmployee = async (id) => { if(confirm("Supprimer cet employé ?")) await deleteDoc(doc(db, "employees", id)); };

        // CALCULS PAIE (INTELLIGENT)
        const calculateBase = (emp) => {
            if (paiePeriod.value === '15') return Math.round(emp.salary / 2);
            if (paiePeriod.value === '30') {
                const currentMonth = new Date().toISOString().slice(0, 7);
                const hasTakenAdvance = salaryHistory.value.some(p => p.employeeId === emp.id && p.month === currentMonth && p.type === 'Acompte (15)');
                return hasTakenAdvance ? Math.round(emp.salary / 2) : emp.salary;
            }
            return 0;
        };
        
        const calculateLoanDeduc = (emp) => (emp.loan > 0) ? Math.min(emp.loan, 10000) : 0;
        const calculateTontineDeduc = (emp) => (emp.isTontine && paiePeriod.value === "30") ? 15000 : 0;
        const calculateNet = (emp) => calculateBase(emp) - calculateLoanDeduc(emp) - calculateTontineDeduc(emp);

        const unpaidEmployees = computed(() => {
            const currentMonth = new Date().toISOString().slice(0, 7);
            const currentTypeLabel = paiePeriod.value === '15' ? 'Acompte (15)' : 'Solde (Fin)';
            return employeesList.value.filter(emp => !salaryHistory.value.some(pay => pay.employeeId === emp.id && pay.month === currentMonth && pay.type === currentTypeLabel));
        });

        // PAIEMENT
        const openPayModal = (emp) => {
            const currentMonth = new Date().toISOString().slice(0, 7);
            const baseAmount = calculateBase(emp);
            const suggestedLoan = (emp.loan > 0) ? Math.min(emp.loan, 10000) : 0;
            const tontineAmount = calculateTontineDeduc(emp);

            payForm.value = {
                id: emp.id, name: emp.name, month: currentMonth,
                base: baseAmount,
                loan: suggestedLoan, maxLoan: emp.loan || 0, // Pour la limite manuelle
                tontine: tontineAmount,
                net: baseAmount - suggestedLoan - tontineAmount
            };
            showPayModal.value = true;
        };

        const recalcNet = () => {
            if (payForm.value.loan > payForm.value.maxLoan) {
                alert("Impossible : Le remboursement dépasse la dette (" + formatMoney(payForm.value.maxLoan) + ")");
                payForm.value.loan = payForm.value.maxLoan;
            }
            payForm.value.net = payForm.value.base - payForm.value.loan - payForm.value.tontine;
        };

        const confirmSalaryPayment = async () => {
            try {
                await addDoc(collection(db, "salary_payments"), {
                    employeeId: payForm.value.id, employeeName: payForm.value.name, month: payForm.value.month,
                    type: paiePeriod.value === '15' ? 'Acompte (15)' : 'Solde (Fin)',
                    base: payForm.value.base, loan: payForm.value.loan, tontine: payForm.value.tontine, net: payForm.value.net,
                    timestamp: Timestamp.now()
                });
                if(payForm.value.loan > 0) {
                    const emp = employeesList.value.find(e => e.id === payForm.value.id);
                    if(emp) await updateDoc(doc(db, "employees", payForm.value.id), { loan: Math.max(0, emp.loan - payForm.value.loan) });
                }
                showPayModal.value = false;
                alert("Paiement validé !");
            } catch(e) { alert("Erreur: " + e.message); }
        };

        const deleteSalaryPayment = async (payment) => {
             if(!confirm("Annuler ce paiement ?")) return;
             try {
                if(payment.loan > 0) {
                    const emp = employeesList.value.find(e => e.id === payment.employeeId);
                    if(emp) await updateDoc(doc(db, "employees", payment.employeeId), { loan: emp.loan + payment.loan });
                }
                await deleteDoc(doc(db, "salary_payments", payment.id));
             } catch(e) { alert("Erreur: " + e.message); }
        };

        // HISTORIQUE & STATS
        const openIndividualHistory = (emp) => { selectedEmployeeHistoryId.value = emp.id; selectedEmployeeHistoryName.value = emp.name; showIndividualHistoryModal.value = true; };
        const individualHistory = computed(() => selectedEmployeeHistoryId.value ? salaryHistory.value.filter(p => p.employeeId === selectedEmployeeHistoryId.value) : []);

        const groupedSalaryHistory = computed(() => {
            const groups = {};
            salaryHistory.value.forEach(pay => {
                const m = pay.month;
                if (!groups[m]) groups[m] = { month: m, totalNet: 0, totalLoan: 0, payments: [] };
                groups[m].totalNet += (pay.net || 0);
                groups[m].totalLoan += (pay.loan || 0);
                groups[m].payments.push(pay);
            });
            return Object.values(groups).sort((a, b) => b.month.localeCompare(a.month));
        });
        const openMonthDetails = (group) => { group.payments.sort((a, b) => b.timestamp.seconds - a.timestamp.seconds); selectedHistoryMonth.value = group; };
        const closeMonthDetails = () => { selectedHistoryMonth.value = null; };

        // FONDS & BUDGET
        const saveSalaryFund = async () => {
            if(!newFund.value.amount) return;
            try { await addDoc(collection(db, "salary_funds"), { amount: newFund.value.amount, note: newFund.value.note || 'Dotation', timestamp: Timestamp.now() }); showFundModal.value = false; newFund.value = { amount: '', note: '' }; alert("Fonds reçus !"); } catch(e) { alert(e.message); }
        };
        const deleteSalaryFund = async (id) => { if(confirm("Supprimer ?")) await deleteDoc(doc(db, "salary_funds", id)); };

        const salaryStats = computed(() => {
            const totalReceived = salaryFunds.value.reduce((acc, curr) => acc + (curr.amount || 0), 0);
            const totalPaid = salaryHistory.value.reduce((acc, curr) => acc + (curr.net || 0), 0);
            const totalLoans = employeesList.value.reduce((acc, curr) => acc + (curr.loan || 0), 0);
            return { totalReceived, totalPaid, balance: totalReceived - totalPaid, totalLoans };
        });

        // TONTINE
        const tontineMembers = computed(() => employeesList.value.filter(e => e.isTontine));
        const hasPaidTontine = (empId) => {
            const currentMonth = new Date().toISOString().slice(0, 7);
            return salaryHistory.value.some(p => p.employeeId === empId && p.month === currentMonth && p.tontine > 0);
        };

        const exportSalaryHistoryPDF = () => {
            if (!window.jspdf) return;
            const { jsPDF } = window.jspdf; const doc = new jsPDF();
            doc.text("Journal des Paiements Salaires", 14, 20);
            const rows = salaryHistory.value.map(p => [formatDate(p.timestamp), p.month, p.employeeName, p.type, formatMoney(p.net)]);
            doc.autoTable({ head: [["Date", "Mois", "Employé", "Type", "Montant"]], body: rows, startY: 30 });
            doc.save("Salaires.pdf");
        };

        // ---------------------------------------------------------
        // --- LOGIQUE CAISSE GENERALE ---
        // ---------------------------------------------------------

        const totals = computed(() => {
            let t = { espece: 0, om: 0, wave: 0 };
            transactions.value.forEach(tx => {
                const amount = tx.amount - (tx.fees || 0);
                if (tx.category === 'ESPECE') { if (tx.type === 'CREDIT') t.espece += amount; else t.espece -= amount; }
                else if (tx.category === 'OM') { if (tx.type === 'CREDIT') t.om += amount; else t.om -= amount; }
                else if (tx.category === 'WAVE') { if (tx.type === 'CREDIT') t.wave += amount; else t.wave -= amount; }
            });
            if (currentSession.value) { t.espece += (currentSession.value.startAmount?.espece || 0); t.om += (currentSession.value.startAmount?.om || 0); t.wave += (currentSession.value.startAmount?.wave || 0); }
            return t;
        });

        const totalEspeceCompte = computed(() => billets.value.reduce((acc, b) => acc + (b.val * (b.count || 0)), 0));

        const visibleTransactions = computed(() => {
            let filtered = isAdmin.value ? (showHiddenTransactions.value ? transactions.value : transactions.value.filter(t => !t.isHidden)) : transactions.value.filter(t => !t.isHidden);
            return filtered.sort((a, b) => {
                const orderMap = { 'ESPECE': 1, 'WAVE': 2, 'OM': 3, 'BANQUE': 4 };
                const oA = orderMap[a.category] || 99, oB = orderMap[b.category] || 99;
                if (oA !== oB) return oA - oB;
                const timeA = a.timestamp?.toMillis ? a.timestamp.toMillis() : 0;
                const timeB = b.timestamp?.toMillis ? b.timestamp.toMillis() : 0;
                return timeB - timeA; 
            });
        });

        const historyModalTotals = computed(() => {
            let t = { entree: 0, sortie: 0, espece: 0, om: 0, wave: 0 };
            visibleHistoryTransactions.value.forEach(tx => {
                const net = tx.amount - (tx.fees || 0);
                if (tx.type === 'CREDIT') t.entree += net; else t.sortie += net;
                if (tx.category === 'ESPECE') t.espece += net;
                if (tx.category === 'OM') t.om += net;
                if (tx.category === 'WAVE') t.wave += net;
            });
            return t;
        });

        const visibleHistoryTransactions = computed(() => {
            // Sécurité : Si pas admin, on ne montre pas les transactions cachées dans l'historique
            if (!isAdmin.value) return selectedTransactionsHistory.value.filter(t => !t.isHidden);
            return selectedTransactionsHistory.value;
        });
        
        const filteredClients = computed(() => {
            if (!searchQuery.value || searchQuery.value.length < 2) return [];
            
            // On met la recherche en minuscule pour ignorer les majuscules
            const q = searchQuery.value.toLowerCase();
            
            return clientDatabase.value.filter(c => 
                (c.REFERENCE?.toLowerCase().includes(q)) || 
                (c.EXPEDITEUR?.toLowerCase().includes(q)) || 
                (c.DESTINATEUR?.toLowerCase().includes(q)) || 
                (c.TELEPHONE?.toString().includes(q)) ||  // Recherche Tel 1
                (c.TELEPHONE2?.toString().includes(q))    // Recherche Tel 2
            ).slice(0, 10);
        });

        // WATCHERS
        onAuthStateChanged(auth, (u) => {
            user.value = u; authLoading.value = false;
            if (u) {
                const q = query(collection(db, "sessions"), where("status", "==", "OPEN"));
                onSnapshot(q, (snapshot) => {
                    if (!snapshot.empty) {
                        const docData = snapshot.docs[0]; currentSession.value = { id: docData.id, ...docData.data() }; startAmounts.value = currentSession.value.startAmount || { espece:0, om:0, wave:0 };
                        onSnapshot(collection(db, "transactions"), where("sessionId", "==", docData.id), (txSnap) => { transactions.value = txSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })); });
                    } else { currentSession.value = null; transactions.value = []; }
                });
                onSnapshot(query(collection(db, "sessions"), where("status", "==", "CLOSED"), orderBy("endTime", "desc")), (snap) => { closedSessions.value = snap.docs.map(d => ({ id: d.id, ...d.data() })); });
                onSnapshot(collection(db, "clients"), (snap) => { clientDatabase.value = snap.docs.map(d => ({ id: d.id, ...d.data() })); });
                loadEmployees(); loadSalaryHistory(); loadSalaryFunds();
            }
        });
        // --- LOGIQUE MODIFICATION TRANSACTION (NOUVEAU) ---

        // 1. Ouvrir le modal et préparer les données
        const openEditTransaction = (tx) => {
            // On sauvegarde l'état original pour pouvoir annuler l'impact sur l'ancien client
            originalTxState.value = { ...tx }; 
            
            // On prépare l'objet d'édition (copie)
            editingTx.value = { 
                ...tx, 
                // On convertit le timestamp en format date pour l'input HTML (YYYY-MM-DD)
                date: tx.timestamp.toDate().toISOString().split('T')[0] 
            };
            
            // On pré-remplit la barre de recherche avec le nom actuel
            searchQuery.value = tx.label || tx.reference || ''; 
            showSuggestions.value = false; // On cache la liste au début
            showEditTransactionModal.value = true;
        };

        // 2. Sélectionner un client dans le modal de modification
        const selectClientForEdit = (c) => {
            editingTx.value.reference = c.REFERENCE;
            editingTx.value.label = c.EXPEDITEUR;
            editingTx.value.recipient = c.DESTINATEUR || '';
            editingTx.value.expectedPrice = c.PRIX;
            searchQuery.value = c.EXPEDITEUR; // Affiche le nom choisi
            showSuggestions.value = false;
        };

        // 3. Sauvegarder les modifications
        const saveEditedTransaction = async () => {
            try {
                // ETAPE A : Annuler l'impact de l'ANCIENNE transaction (comme une suppression)
                // Si l'ancienne transaction avait une référence, on rembourse la dette de ce client "X"
                if (originalTxState.value.reference) {
                    const oldRefClean = originalTxState.value.reference.replace(/\//g, "-").trim();
                    const oldClientRef = doc(db, "clients", oldRefClean);
                    const oldClientSnap = await getDoc(oldClientRef);
                    
                    if (oldClientSnap.exists()) {
                        const oldDebt = oldClientSnap.data().PRIX || 0;
                        // On lui remet le montant net qu'on avait déduit
                        const amountToRestore = originalTxState.value.amount - (originalTxState.value.fees || 0);
                        await updateDoc(oldClientRef, { PRIX: oldDebt + amountToRestore });
                    }
                }

                // ETAPE B : Recalculer les frais avec les NOUVELLES données
                let newFees = 0;
                const amount = editingTx.value.amount;
                if (!editingTx.value.isBill) {
                    if (editingTx.value.category === 'OM' && editingTx.value.type === 'CREDIT') {
                        const net = amount / 1.01; newFees = Math.round(amount - net);
                    } else if (editingTx.value.category === 'WAVE' && editingTx.value.type === 'DEBIT') {
                        let calc = Math.round(amount * 0.01); if (calc > 5000) calc = 5000; newFees = calc;
                    }
                }
                const newNetAmount = amount - newFees;

                // ETAPE C : Mise à jour de la transaction dans la base
                const selectedDate = new Date(editingTx.value.date);
                const now = new Date(); selectedDate.setHours(now.getHours(), now.getMinutes(), now.getSeconds());

                await updateDoc(doc(db, "transactions", editingTx.value.id), {
                    reference: editingTx.value.reference,
                    label: editingTx.value.label,
                    recipient: editingTx.value.recipient,
                    amount: editingTx.value.amount,
                    category: editingTx.value.category,
                    fees: newFees,
                    timestamp: Timestamp.fromDate(selectedDate)
                });

                // ETAPE D : Appliquer l'impact sur le NOUVEAU client (ou le même mis à jour)
                // (Même logique que addTransaction)
                let contactKey = editingTx.value.reference;
                if (!contactKey && editingTx.value.recipient) {
                    contactKey = editingTx.value.recipient.toUpperCase().replace(/[^A-Z0-9]/g, '');
                }

                if (contactKey) {
                    const newRefClean = contactKey.replace(/\//g, "-").trim();
                    const newClientRef = doc(db, "clients", newRefClean);
                    const newClientSnap = await getDoc(newClientRef); // On récupère la version fraîche

                    if (newClientSnap.exists()) {
                        // Client existe : on déduit le nouveau montant
                        const currentDebt = newClientSnap.data().PRIX || 0;
                        await updateDoc(newClientRef, { PRIX: currentDebt - newNetAmount });
                    } else {
                        // Nouveau client : on crée
                        const initialDebt = editingTx.value.reference ? editingTx.value.amount : 0;
                        await setDoc(newClientRef, { 
                            REFERENCE: editingTx.value.reference || contactKey, 
                            EXPEDITEUR: editingTx.value.label, 
                            DESTINATEUR: editingTx.value.recipient || '', 
                            TELEPHONE: '', 
                            PRIX: initialDebt 
                        }, { merge: true });

                        if (!editingTx.value.reference) await updateDoc(newClientRef, { PRIX: 0 - newNetAmount });
                    }
                }

                showEditTransactionModal.value = false;
                alert("Transaction modifiée avec succès !");

            } catch(e) { console.error(e); alert("Erreur lors de la modification : " + e.message); }
        };

        // METHODS
        const login = async () => { try { await signInWithEmailAndPassword(auth, loginForm.value.email, loginForm.value.password); } catch (e) { loginError.value = "Erreur de connexion"; } };
        const logout = async () => { await signOut(auth); };
        
        const startSession = async () => {
            if (!startAmounts.value.espece && startAmounts.value.espece !== 0) return alert("Montant Espèce requis");
            loading.value = true;
            try { await addDoc(collection(db, "sessions"), { startTime: Timestamp.now(), status: "OPEN", startAmount: startAmounts.value, openedBy: user.value.email }); } catch (e) { alert(e.message); } finally { loading.value = false; }
        };

        const addTransaction = async () => {
            if (!isAdmin.value) return alert("Refusé");
            if (!form.value.amount || !form.value.label || !form.value.date) return;
            
            // --- LOGIQUE FRAIS & CALCULS ---
            let fees = 0; const amount = form.value.amount;
            if (form.value.isBill) fees = 0;
            else {
                if (form.value.category === 'OM') {
                    if (form.value.type === 'CREDIT') { const net = amount / 1.01; fees = Math.round(amount - net); } // Entrée OM = Frais déduits
                    else fees = 0;
                } else if (form.value.category === 'WAVE') {
                    if (form.value.type === 'CREDIT') fees = 0;
                    else { let calc = Math.round(amount * 0.01); if (calc > 5000) calc = 5000; fees = calc; }
                }
            }
            const netAmountPaid = amount - fees;
            const selectedDate = new Date(form.value.date); const now = new Date(); selectedDate.setHours(now.getHours(), now.getMinutes(), now.getSeconds());

            try {
                // 1. Enregistrement Transaction
                await addDoc(collection(db, "transactions"), { sessionId: currentSession.value.id, ...form.value, expectedPrice: form.value.expectedPrice || 0, recipient: form.value.recipient || '', isHidden: form.value.isHidden || false, isBill: form.value.isBill || false, fees: fees, timestamp: Timestamp.fromDate(selectedDate) });
                
                // 2. GESTION CLIENT / PRESTATAIRE (AUTO-APPRENTISSAGE)
                
                // On détermine l'identifiant (Priorité : Référence > Destinataire)
                let contactKey = form.value.reference;
                
                // Si pas de référence, on génère une clé basée sur le Destinataire (ex: "PLOMBIERJEAN")
                if (!contactKey && form.value.recipient) {
                    contactKey = form.value.recipient.toUpperCase().replace(/[^A-Z0-9]/g, ''); 
                }

                if (contactKey) {
                    const cleanRef = contactKey.replace(/\//g, "-").trim();
                    const clientRef = doc(db, "clients", cleanRef);
                    
                    // On regarde dans la liste locale si ce client existe déjà
                    const existingClient = clientDatabase.value.find(c => c.id === cleanRef);

                    if (existingClient) {
                        // IL EXISTE DÉJÀ : On met à jour son solde
                        const currentDebt = existingClient.PRIX || 0;
                        await updateDoc(clientRef, { PRIX: currentDebt - netAmountPaid });
                    } else {
                        // NOUVEAU : On le crée
                        // Si c'est une création via le Destinataire (pas de vraie ref), la dette commence à 0 
                        // car on suppose que c'est un prestataire qu'on paie, pas une dette qu'il nous doit.
                        // Si c'est une création via Référence, c'est une dette classique.
                        const initialDebt = form.value.reference ? form.value.amount : 0;
                        
                        await setDoc(clientRef, { 
                            REFERENCE: form.value.reference || contactKey, // On sauvegarde la clé générée si pas de ref
                            EXPEDITEUR: form.value.label, 
                            DESTINATEUR: form.value.recipient || '', 
                            TELEPHONE: '', 
                            PRIX: initialDebt 
                        }, { merge: true });

                        // Si c'est un prestataire (créé sans Ref), on applique tout de suite le mouvement
                        // Exemple : Plombier créé à 0, on le paie 10.000 -> Son solde devient -10.000 (ce qui est correct pour une dépense)
                        if (!form.value.reference) {
                             await updateDoc(clientRef, { PRIX: 0 - netAmountPaid });
                        }
                    }
                }
                
                // Reset Formulaire
                form.value.label = ''; form.value.recipient = ''; form.value.reference = ''; form.value.amount = ''; form.value.expectedPrice = 0; form.value.isHidden = false; form.value.isBill = false;
            } catch (e) { console.error(e); alert("Erreur ajout : " + e.message); }
        };

        const deleteTransaction = async (tx) => { 
            if (!confirm("Supprimer cette opération ? Si elle est liée à un client, sa dette sera rétablie.")) return;
            try {
                // RESTAURATION DETTE CLIENT
                if (tx.reference) {
                    const cleanRef = tx.reference.replace(/\//g, "-").trim();
                    const clientRef = doc(db, "clients", cleanRef);
                    const clientSnap = await getDoc(clientRef);
                    if (clientSnap.exists()) {
                        const currentDebt = clientSnap.data().PRIX || 0;
                        const amountToRestore = tx.amount - (tx.fees || 0); // Montant Net
                        await updateDoc(clientRef, { PRIX: currentDebt + amountToRestore });
                    }
                }
                await deleteDoc(doc(db, "transactions", tx.id));
            } catch (e) { alert("Erreur suppression : " + e.message); }
        };
        
        const openClosingModal = () => { closing.value.om = 0; closing.value.wave = 0; showClosingModal.value = true; };
        
        const confirmClose = async () => {
            if (!currentSession.value) return;
            try {
                await updateDoc(doc(db, "sessions", currentSession.value.id), { endTime: Timestamp.now(), status: "CLOSED", totalsComputed: totals.value, closingAmounts: closing.value, gaps: { om: closing.value.om - totals.value.om, wave: closing.value.wave - totals.value.wave } });
                showClosingModal.value = false; startAmounts.value = { espece:0, om:0, wave:0 };
            } catch (e) { alert("Erreur clôture"); }
        };

        const openHistoryDetails = async (sess) => {
            selectedSessionHistory.value = sess;
            const snap = await getDocs(query(collection(db, "transactions"), where("sessionId", "==", sess.id)));
            let txs = snap.docs.map(d => ({id: d.id, ...d.data()}));
            txs.sort((a,b) => (a.timestamp?.toMillis() || 0) - (b.timestamp?.toMillis() || 0));
            selectedTransactionsHistory.value = txs;
            showHistoryModal.value = true;
        };

        const selectClient = (c) => { form.value.reference = c.REFERENCE; form.value.label = c.EXPEDITEUR; form.value.recipient = c.DESTINATEUR || ''; form.value.expectedPrice = c.PRIX; showSuggestions.value = false; searchQuery.value = ''; };

        const importClients = () => {
            const file = fileInput.value.files[0]; if (!file) return; importStatus.value = "Lecture...";
            Papa.parse(file, { header: true, skipEmptyLines: true, complete: async (results) => {
                    importStatus.value = `Import de ${results.data.length} clients...`; let count = 0; const batchSize = 400; let batch = writeBatch(db);
                    for (const row of results.data) {
                        if (!row.REFERENCE) continue;
                        const refClean = row.REFERENCE.replace(/\//g, "-").trim();
                        
                        // ICI : On s'assure de bien prendre toutes les colonnes du CSV
                        batch.set(doc(db, "clients", refClean), { 
                            REFERENCE: row.REFERENCE, 
                            EXPEDITEUR: row.EXPEDITEUR || '', 
                            DESTINATEUR: row.DESTINATEUR || '', // Ajouté
                            TELEPHONE: row.TELEPHONE || '',     // Ajouté
                            TELEPHONE2: row.TELEPHONE2 || '',   // Ajouté
                            PRIX: row.PRIX ? parseFloat(row.PRIX.replace(/\s/g, '').replace(',', '.')) : 0 
                        }, { merge: true });
                        
                        count++; if (count % batchSize === 0) { await batch.commit(); batch = writeBatch(db); }
                    }
                    await batch.commit(); importStatus.value = "Terminé !"; setTimeout(() => importStatus.value = '', 3000);
                }
            });
        };

        const exportToExcel = (data, title) => { const ws = XLSX.utils.json_to_sheet(data.map(t => ({ Date: formatDate(t.timestamp), Ref: t.reference, Exp: t.label, Dest: t.recipient, Type: t.type, Cat: t.category, Montant: t.amount }))); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Feuille1"); XLSX.writeFile(wb, title + ".xlsx"); };
        
        const exportToPDF = () => {
            if (!window.jspdf) return alert("Erreur PDF");
            const { jsPDF } = window.jspdf; const doc = new jsPDF(); doc.text("Journal de Caisse", 14, 15);
            const list = visibleTransactions.value;
            doc.autoTable({ head: [["Date", "Réf", "Expéditeur", "Destinataire", "Mode", "Montant"]], body: list.map(tx => [formatDate(tx.timestamp)+'\n'+formatTime(tx.timestamp), tx.reference||'-', tx.label+(tx.isHidden?' (INT)':''), tx.recipient||'', getModeAbbr(tx.category), formatMoney(tx.amount-(tx.fees||0)).replace(/\s/g,' ')]), startY: 30, theme: 'grid', styles: {fontSize:8}, columnStyles: {0:{cellWidth:20}, 4:{cellWidth:15, halign:'center'}, 5:{halign:'right', fontStyle:'bold'}} });
            doc.save("Journal.pdf");
        };

        const formatMoney = (m) => new Intl.NumberFormat('fr-FR').format(m || 0) + ' F';
        const formatDate = (ts) => { if (!ts) return '-'; const d = ts.toDate ? ts.toDate() : new Date(ts); const day = d.getDate().toString().padStart(2, '0'); let month = d.toLocaleString('fr-FR', { month: 'short' }).replace('.', ''); month = month.charAt(0).toUpperCase() + month.slice(1); const year = d.getFullYear(); return `${day}-${month}-${year}`; };
        const formatTime = (ts) => { if (!ts) return '-'; const d = ts.toDate ? ts.toDate() : new Date(ts); return d.toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit'}); };
        const formatDateTime = (ts) => formatDate(ts) + ' ' + formatTime(ts);
        const getBadgeClass = (c) => ({ 'OM': 'bg-orange-50 text-orange-700 border-orange-200', 'WAVE': 'bg-blue-50 text-blue-700 border-blue-200', 'ESPECE': 'bg-green-50 text-green-700 border-green-200', 'BANQUE': 'bg-gray-50 text-gray-700 border-gray-200' }[c] || '');
        const getModeAbbr = (c) => ({ 'ESPECE': 'ESP', 'OM': 'OM', 'WAVE': 'WAV', 'BANQUE': 'BQE' }[c] || c);
        const getGapClass = (gap) => gap === 0 ? 'text-gray-400' : (gap > 0 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700');
        const formatGap = (g) => (g > 0 ? '+' : '') + formatMoney(g);
        const saveBilletage = () => {}; 

        return {
            user, isAdmin, authLoading, loginForm, login, logout, loginError,
            currentView, currentSession, transactions, visibleTransactions, loading, startAmounts, form, closing, billets, totals, totalEspeceCompte, showClosingModal,
            closedSessions, showHistoryModal, selectedSessionHistory, selectedTransactionsHistory, visibleHistoryTransactions, openHistoryDetails,
            clientDatabase, searchQuery, showSuggestions, filteredClients, selectClient, importClients, fileInput, importStatus,
            startSession, addTransaction, openClosingModal, confirmClose, deleteTransaction,
            formatMoney, formatTime, formatDate, formatDateTime, getBadgeClass, getGapClass, formatGap, exportToExcel, exportToPDF,
            saveBilletage, getModeAbbr, showHiddenTransactions, historyModalTotals,
            
            // EXPORTS SALAIRE
            currentSalaireView, employeesList, salaryHistory, salaryFunds, paiePeriod, 
            showAddEmployeeModal, showEditEmployeeModal, showIndividualHistoryModal, showPayModal, showFundModal,
            newEmp, editingEmp, payForm, newFund, unpaidEmployees, selectedEmployeeHistoryName, individualHistory,
            groupedSalaryHistory, selectedHistoryMonth, openMonthDetails, closeMonthDetails,
            saveNewEmployee, updateEmployee, deleteEmployee, openEditEmployee, openIndividualHistory,
            openPayModal, confirmSalaryPayment, deleteSalaryPayment, recalcNet, hasPaidTontine, tontineMembers,
            calculateBase, calculateLoanDeduc, calculateTontineDeduc, calculateNet, exportSalaryHistoryPDF, 
            saveSalaryFund, deleteSalaryFund, salaryStats, showEditTransactionModal, editingTx, openEditTransaction, saveEditedTransaction, selectClientForEdit
        };
    }
}).mount('#app');