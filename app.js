import { createApp, ref, computed, onMounted, watch } from "https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";
import { getFirestore, collection, addDoc, setDoc, deleteDoc, query, where, orderBy, onSnapshot, updateDoc, doc, serverTimestamp, getDocs, Timestamp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";

// CONFIGURATION FIREBASE (Remettez VOS clés ici si elles sont différentes)
const firebaseConfig = {
    apiKey: "AIzaSyDvo7FRCpr_mE4nTGz6VW7-UL0U1JKe-g8",
    authDomain: "caisse-jb.firebaseapp.com",
    projectId: "caisse-jb",
    storageBucket: "caisse-jb.firebasestorage.app",
    messagingSenderId: "877905828814",
    appId: "1:877905828814:web:79840cd0dfcb8a8036e99f"   
};

// Initialisation
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
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
        const isAdmin = computed(() => user.value && user.value.email === 'admin@caisse.com'); // Mettez votre email admin ici

        // --- ETAT APPLICATION ---
        const currentView = ref('dashboard'); // dashboard, history, database, salaire
        const currentSalaireView = ref('employes'); // employes, paie, historique, tontine
        
        // --- DONNEES CAISSE ---
        const currentSession = ref(null);
        const transactions = ref([]);
        const loading = ref(false);
        const startAmounts = ref({ espece: 0, om: 0, wave: 0 });
        const form = ref({ type: 'CREDIT', category: 'ESPECE', amount: '', label: '', recipient: '', reference: '', date: new Date().toISOString().split('T')[0], expectedPrice: 0, isHidden: false });
        const closing = ref({ om: 0, wave: 0 });
        const showClosingModal = ref(false);
        const billets = ref([ {val:10000, count:''}, {val:5000, count:''}, {val:2000, count:''}, {val:1000, count:''}, {val:500, count:''}, {val:200, count:''}, {val:100, count:''}, {val:50, count:''} ]);
        const showHiddenTransactions = ref(true);

        // --- DONNEES HISTORIQUE CAISSE ---
        const closedSessions = ref([]);
        const showHistoryModal = ref(false);
        const selectedSessionHistory = ref(null);
        const selectedTransactionsHistory = ref([]);
        
        // --- DONNEES DATABASE CLIENT ---
        const clientDatabase = ref([]);
        const searchQuery = ref('');
        const showSuggestions = ref(false);
        const fileInput = ref(null);
        const importStatus = ref('');

        // --- DONNEES SALAIRE ---
        const employeesList = ref([]);
        const salaryHistory = ref([]);
        const paiePeriod = ref("15"); // "15" ou "30"
        const showAddEmployeeModal = ref(false);
        const showEditEmployeeModal = ref(false); // NOUVEAU
        const showIndividualHistoryModal = ref(false); // NOUVEAU
        const showPayModal = ref(false);
        const newEmp = ref({ name: '', salary: 0, loan: 0, isTontine: false });
        const editingEmp = ref({}); // NOUVEAU (Stocke l'employé en cours de modification)
        const selectedEmployeeHistoryId = ref(null); // NOUVEAU
        const selectedEmployeeHistoryName = ref(''); // NOUVEAU
        const payForm = ref({});
        const salaryFunds = ref([]); // NOUVEAU
        const showFundModal = ref(false); // NOUVEAU
        const newFund = ref({ amount: '', note: '' }); // NOUVEAU

        // ---------------------------------------------------------
        // --- LOGIQUE SALAIRE (INSPIRÉE DE VOTRE CODE) ---
        // ---------------------------------------------------------

        // 1. Charger Employés
        const loadEmployees = () => {
             onSnapshot(collection(db, "employees"), (snap) => {
                employeesList.value = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            });
        };

        // 2. Charger Historique Salaires
        const loadSalaryHistory = () => {
             onSnapshot(query(collection(db, "salary_payments"), orderBy('timestamp', 'desc')), (snap) => {
                salaryHistory.value = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            });
        };
        // 3-Bis. Ouvrir Modal Modification (NOUVEAU)
        const openEditEmployee = (emp) => {
            // On clone l'objet pour ne pas modifier la liste directement avant confirmation
            editingEmp.value = { ...emp };
            showEditEmployeeModal.value = true;
        };

        // 3-Ter. Enregistrer Modification (NOUVEAU)
        const updateEmployee = async () => {
            try {
                const empRef = doc(db, "employees", editingEmp.value.id);
                await updateDoc(empRef, {
                    name: editingEmp.value.name,
                    salary: editingEmp.value.salary,
                    loan: editingEmp.value.loan,
                    isTontine: editingEmp.value.isTontine
                });
                showEditEmployeeModal.value = false;
                // Pas besoin de recharger, le onSnapshot le fera tout seul
            } catch(e) { alert("Erreur modification: " + e.message); }
        };
        const unpaidEmployees = computed(() => {
            const currentMonth = new Date().toISOString().slice(0, 7); // "2023-12"
            const currentTypeLabel = paiePeriod.value === '15' ? 'Acompte (15)' : 'Solde (Fin)';
            
            // On retourne seulement les employés qui n'ont PAS de paiement correspondant dans l'historique
            return employeesList.value.filter(emp => {
                const hasBeenPaid = salaryHistory.value.some(pay => 
                    pay.employeeId === emp.id && 
                    pay.month === currentMonth && 
                    pay.type === currentTypeLabel
                );
                return !hasBeenPaid; // Garde si NON payé
            });
        });

        // 12. Historique Individuel (NOUVEAU)
        const openIndividualHistory = (emp) => {
            selectedEmployeeHistoryId.value = emp.id;
            selectedEmployeeHistoryName.value = emp.name;
            showIndividualHistoryModal.value = true;
        };

        const individualHistory = computed(() => {
            if(!selectedEmployeeHistoryId.value) return [];
            return salaryHistory.value.filter(p => p.employeeId === selectedEmployeeHistoryId.value);
        });

        // 3. Ajouter Employé
        const saveNewEmployee = async () => {
            if(!newEmp.value.name || !newEmp.value.salary) return;
            try {
                await addDoc(collection(db, "employees"), {
                    name: newEmp.value.name,
                    salary: newEmp.value.salary,
                    loan: newEmp.value.loan || 0,
                    isTontine: newEmp.value.isTontine
                });
                showAddEmployeeModal.value = false;
                newEmp.value = { name: '', salary: 0, loan: 0, isTontine: false };
            } catch(e) { alert("Erreur: " + e.message); }
        };

        // 4. Supprimer Employé
        const deleteEmployee = async (id) => {
            if(confirm("Supprimer cet employé ?")) await deleteDoc(doc(db, "employees", id));
        };

        // 5. Calculs Paie (LOGIQUE INTELLIGENTE)
        const calculateBase = (emp) => {
            // Cas 1 : Si on est en train de faire les Acomptes du 15
            if (paiePeriod.value === '15') {
                return Math.round(emp.salary / 2); // Toujours la moitié
            }

            // Cas 2 : Si on est en train de faire le Solde de fin de mois (30)
            if (paiePeriod.value === '30') {
                const currentMonth = new Date().toISOString().slice(0, 7); // Ex: "2025-12"
                
                // On vérifie si cet employé a DÉJÀ reçu un acompte ce mois-ci
                const hasTakenAdvance = salaryHistory.value.some(p => 
                    p.employeeId === emp.id && 
                    p.month === currentMonth && 
                    p.type === 'Acompte (15)'
                );

                if (hasTakenAdvance) {
                    // Il a déjà pris l'acompte -> On lui verse le RESTE (la moitié)
                    return Math.round(emp.salary / 2);
                } else {
                    // Il n'a rien pris ce mois-ci -> On lui verse la TOTALITÉ
                    return emp.salary;
                }
            }
            
            return 0;
        };
        
        const calculateLoanDeduc = (emp) => {
            // On retient max 10.000 ou le reste de la dette si moins
            return (emp.loan > 0) ? Math.min(emp.loan, 10000) : 0;
        };
        
        const calculateTontineDeduc = (emp) => {
            // On retient 15.000 seulement à la fin du mois (30)
            return (emp.isTontine && paiePeriod.value === "30") ? 15000 : 0;
        };

        const calculateNet = (emp) => {
            return calculateBase(emp) - calculateLoanDeduc(emp) - calculateTontineDeduc(emp);
        };

        // Fonction pour recalculer le Net quand on modifie le Prêt manuellement
        const recalcNet = () => {
            // Sécurité : On ne peut pas rembourser plus que la dette restante
            if (payForm.value.loan > payForm.value.maxLoan) {
                alert("Attention : Ce montant dépasse la dette de l'employé (" + formatMoney(payForm.value.maxLoan) + ")");
                payForm.value.loan = payForm.value.maxLoan;
            }
            // Net = Base - Prêt - Tontine
            payForm.value.net = payForm.value.base - payForm.value.loan - payForm.value.tontine;
        };

        // 6. Ouvrir Modal Paiement (MISE À JOUR)
        const openPayModal = (emp) => {
            const currentMonth = new Date().toISOString().slice(0, 7); 
            
            // Suggestion de base (comme avant, mais modifiable)
            const suggestedLoan = (emp.loan > 0) ? Math.min(emp.loan, 10000) : 0;
            const tontineAmount = calculateTontineDeduc(emp);
            const baseAmount = calculateBase(emp);

            payForm.value = {
                id: emp.id,
                name: emp.name,
                month: currentMonth,
                base: baseAmount,
                loan: suggestedLoan,     // Montant modifiable
                maxLoan: emp.loan || 0,  // Pour vérifier qu'on ne dépasse pas
                tontine: tontineAmount,
                net: baseAmount - suggestedLoan - tontineAmount
            };
            showPayModal.value = true;
        };

        // 7. Confirmer Paiement
        const confirmSalaryPayment = async () => {
            try {
                // A. Enregistrer le paiement
                await addDoc(collection(db, "salary_payments"), {
                    employeeId: payForm.value.id,
                    employeeName: payForm.value.name,
                    month: payForm.value.month,
                    type: paiePeriod.value === '15' ? 'Acompte (15)' : 'Solde (Fin)',
                    base: payForm.value.base,
                    loan: payForm.value.loan,
                    tontine: payForm.value.tontine,
                    net: payForm.value.net,
                    timestamp: Timestamp.now()
                });

                // B. Mettre à jour la dette de l'employé (si remboursement)
                if(payForm.value.loan > 0) {
                    const empRef = doc(db, "employees", payForm.value.id);
                    // On récupère la dette actuelle pour être sûr
                    const emp = employeesList.value.find(e => e.id === payForm.value.id);
                    if(emp) {
                         await updateDoc(empRef, { loan: Math.max(0, emp.loan - payForm.value.loan) });
                    }
                }

                showPayModal.value = false;
                alert("Paiement validé !");
            } catch(e) { alert("Erreur paiement: " + e.message); }
        };

        // 8. Supprimer un paiement (Annulation)
        const deleteSalaryPayment = async (payment) => {
             if(!confirm("Annuler ce paiement ? Si c'était un remboursement de prêt, la dette sera rétablie.")) return;
             
             try {
                // Si c'était un prêt, on remet la dette
                if(payment.loan > 0) {
                    const emp = employeesList.value.find(e => e.id === payment.employeeId);
                    if(emp) {
                        await updateDoc(doc(db, "employees", payment.employeeId), {
                            loan: emp.loan + payment.loan
                        });
                    }
                }
                await deleteDoc(doc(db, "salary_payments", payment.id));
             } catch(e) { alert("Erreur: " + e.message); }
        };

        // 9. Calcul Tontine (Membres qui ont payé ce mois-ci)
        const tontineMembers = computed(() => employeesList.value.filter(e => e.isTontine));
        
        const hasPaidTontine = (empId) => {
            const currentMonth = new Date().toISOString().slice(0, 7);
            return salaryHistory.value.some(p => 
                p.employeeId === empId && 
                p.month === currentMonth && 
                p.tontine > 0
            );
        };

        // 10. Export PDF Historique Salaire
        const exportSalaryHistoryPDF = () => {
            if (!window.jspdf) return;
            const { jsPDF } = window.jspdf;
            const doc = new jsPDF();
            doc.text("Journal des Paiements Salaires", 14, 20);
            
            // Helper Date Format "15-Déc-2025"
            const formatDate = (ts) => { 
                if (!ts) return '-'; 
                const d = ts.toDate ? ts.toDate() : new Date(ts); 
                
                const day = d.getDate().toString().padStart(2, '0'); // 15
                // Mois en abrégé (déc), on enlève le point s'il y en a et on met la majuscule
                let month = d.toLocaleString('fr-FR', { month: 'short' }).replace('.', ''); 
                month = month.charAt(0).toUpperCase() + month.slice(1); // Déc
                const year = d.getFullYear(); // 2025

                return `${day}-${month}-${year}`; 
            };
            
            doc.autoTable({
                head: [["Date", "Mois", "Employé", "Type", "Montant"]],
                body: rows,
                startY: 30
            });
            doc.save("Salaires.pdf");
        };
        // X. Charger les Fonds (NOUVEAU)
        const loadSalaryFunds = () => {
             onSnapshot(query(collection(db, "salary_funds"), orderBy('timestamp', 'desc')), (snap) => {
                salaryFunds.value = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            });
        };

        // Variable pour stocker le mois sélectionné (pour le détail)
        const selectedHistoryMonth = ref(null);

        // LOGIQUE DE GROUPEMENT PAR MOIS
        const groupedSalaryHistory = computed(() => {
            const groups = {};
            
            salaryHistory.value.forEach(pay => {
                const m = pay.month; // Ex: "2023-12"
                if (!groups[m]) {
                    groups[m] = { 
                        month: m, 
                        totalNet: 0, 
                        totalLoan: 0, 
                        payments: [] 
                    };
                }
                groups[m].totalNet += (pay.net || 0);
                groups[m].totalLoan += (pay.loan || 0);
                groups[m].payments.push(pay);
            });

            // On transforme l'objet en liste et on trie (Le mois le plus récent en premier)
            return Object.values(groups).sort((a, b) => b.month.localeCompare(a.month));
        });

        // Fonction pour ouvrir les détails d'un mois
        const openMonthDetails = (group) => {
            // On trie les paiements du mois par date
            group.payments.sort((a, b) => b.timestamp.seconds - a.timestamp.seconds);
            selectedHistoryMonth.value = group;
        };

        // Fonction pour revenir à la liste
        const closeMonthDetails = () => {
            selectedHistoryMonth.value = null;
        };

        // Y. Enregistrer un Fonds (NOUVEAU)
        const saveSalaryFund = async () => {
            if(!newFund.value.amount) return;
            try {
                await addDoc(collection(db, "salary_funds"), {
                    amount: newFund.value.amount,
                    note: newFund.value.note || 'Dotation',
                    timestamp: Timestamp.now()
                });
                showFundModal.value = false;
                newFund.value = { amount: '', note: '' };
                alert("Fonds reçus !");
            } catch(e) { alert("Erreur : " + e.message); }
        };

        // Z. Supprimer un Fonds (NOUVEAU)
        const deleteSalaryFund = async (id) => {
            if(confirm("Supprimer cette entrée d'argent ?")) await deleteDoc(doc(db, "salary_funds", id));
        };

        // STATS : Calcul Budget + Total Prêts (MISE À JOUR)
        const salaryStats = computed(() => {
            // 1. Total Reçu (Entrées)
            const totalReceived = salaryFunds.value.reduce((acc, curr) => acc + (curr.amount || 0), 0);
            
            // 2. Total Payé (Sorties)
            const totalPaid = salaryHistory.value.reduce((acc, curr) => acc + (curr.net || 0), 0);
            
            // 3. Total Prêts en cours (Somme des dettes actuelles des employés)
            const totalLoans = employeesList.value.reduce((acc, curr) => acc + (curr.loan || 0), 0);

            return {
                totalReceived,
                totalPaid,
                balance: totalReceived - totalPaid,
                totalLoans // Nouvelle donnée disponible
            };
        });

        // ---------------------------------------------------------
        // --- FIN LOGIQUE SALAIRE ---
        // ---------------------------------------------------------


        // --- COMPUTED PROPERTIES EXISTANTES (Caisse) ---
        const totals = computed(() => {
            let t = { espece: 0, om: 0, wave: 0 };
            transactions.value.forEach(tx => {
                const amount = tx.amount - (tx.fees || 0); // Net
                if (tx.category === 'ESPECE') {
                    if (tx.type === 'CREDIT') t.espece += amount; else t.espece -= amount;
                } else if (tx.category === 'OM') {
                    if (tx.type === 'CREDIT') t.om += amount; else t.om -= amount;
                } else if (tx.category === 'WAVE') {
                    if (tx.type === 'CREDIT') t.wave += amount; else t.wave -= amount;
                }
            });
            // Ajout des reports
            if (currentSession.value) {
                t.espece += (currentSession.value.startAmount?.espece || 0);
                t.om += (currentSession.value.startAmount?.om || 0);
                t.wave += (currentSession.value.startAmount?.wave || 0);
            }
            return t;
        });

        const totalEspeceCompte = computed(() => {
            return billets.value.reduce((acc, b) => acc + (b.val * (b.count || 0)), 0);
        });

        const visibleTransactions = computed(() => {
            let filteredList = [];
            if (!isAdmin.value) filteredList = transactions.value.filter(t => !t.isHidden);
            else filteredList = showHiddenTransactions.value ? transactions.value : transactions.value.filter(t => !t.isHidden);

            return filteredList.sort((a, b) => {
                const orderMap = { 'ESPECE': 1, 'WAVE': 2, 'OM': 3, 'BANQUE': 4 };
                const orderA = orderMap[a.category] || 99;
                const orderB = orderMap[b.category] || 99;
                if (orderA !== orderB) return orderA - orderB;
                const timeA = a.timestamp && a.timestamp.toMillis ? a.timestamp.toMillis() : 0;
                const timeB = b.timestamp && b.timestamp.toMillis ? b.timestamp.toMillis() : 0;
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

        // Filtre de sécurité pour l'historique (Modifié)
        const visibleHistoryTransactions = computed(() => {
            // Si c'est un simple visiteur, on cache les transactions masquées
            if (!isAdmin.value) {
                return selectedTransactionsHistory.value.filter(t => !t.isHidden);
            }
            // Si c'est l'admin, on montre tout
            return selectedTransactionsHistory.value;
        });
        
        const filteredClients = computed(() => {
            if (!searchQuery.value || searchQuery.value.length < 2) return [];
            const q = searchQuery.value.toLowerCase();
            return clientDatabase.value.filter(c => 
                (c.REFERENCE && c.REFERENCE.toLowerCase().includes(q)) || 
                (c.EXPEDITEUR && c.EXPEDITEUR.toLowerCase().includes(q))
            ).slice(0, 10);
        });

        // --- WATCHERS & LIFECYCLE ---
        onAuthStateChanged(auth, (u) => {
            user.value = u;
            authLoading.value = false;
            if (u) {
                // Charger Session Caisse
                const q = query(collection(db, "sessions"), where("status", "==", "OPEN"));
                onSnapshot(q, (snapshot) => {
                    if (!snapshot.empty) {
                        const docData = snapshot.docs[0];
                        currentSession.value = { id: docData.id, ...docData.data() };
                        startAmounts.value = currentSession.value.startAmount || { espece:0, om:0, wave:0 };
                        
                        // Charger Transactions Caisse
                        onSnapshot(collection(db, "transactions"), where("sessionId", "==", docData.id), (txSnap) => {
                            transactions.value = txSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                        });
                    } else { currentSession.value = null; transactions.value = []; }
                });
                
                // Charger Historique Sessions
                onSnapshot(query(collection(db, "sessions"), where("status", "==", "CLOSED"), orderBy("endTime", "desc")), (snap) => {
                    closedSessions.value = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                });

                // Charger Base Clients
                onSnapshot(collection(db, "clients"), (snap) => {
                    clientDatabase.value = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                });

                // CHARGEMENT DONNEES SALAIRE (NOUVEAU)
                loadEmployees();
                loadSalaryHistory();
                loadSalaryFunds(); // <-- AJOUTER ICI
            }
        });

        // --- METHODS ---
        const login = async () => { try { await signInWithEmailAndPassword(auth, loginForm.value.email, loginForm.value.password); } catch (e) { loginError.value = "Erreur de connexion"; } };
        const logout = async () => { await signOut(auth); };
        
        const startSession = async () => {
            if (!startAmounts.value.espece && startAmounts.value.espece !== 0) return alert("Montant Espèce requis");
            loading.value = true;
            try {
                await addDoc(collection(db, "sessions"), {
                    startTime: Timestamp.now(), status: "OPEN",
                    startAmount: startAmounts.value,
                    openedBy: user.value.email
                });
            } catch (e) { alert(e.message); } finally { loading.value = false; }
        };

        const addTransaction = async () => {
            if (!isAdmin.value) return alert("Refusé");
            if (!form.value.amount || !form.value.label || !form.value.date) return;
            let fees = 0;
            if (form.value.category === 'OM') { const net = form.value.amount / 1.01; fees = Math.round(form.value.amount - net); }
            const netAmountPaid = form.value.amount - fees;
            const selectedDate = new Date(form.value.date); const now = new Date(); selectedDate.setHours(now.getHours(), now.getMinutes(), now.getSeconds());

            try {
                await addDoc(collection(db, "transactions"), {
                    sessionId: currentSession.value.id, ...form.value, expectedPrice: form.value.expectedPrice || 0, recipient: form.value.recipient || '', isHidden: form.value.isHidden || false, fees: fees, timestamp: Timestamp.fromDate(selectedDate)
                });
                if (form.value.reference) {
                    const cleanRef = form.value.reference.replace(/\//g, "-").trim();
                    const clientRef = doc(db, "clients", cleanRef);
                    const existingClientIndex = clientDatabase.value.findIndex(c => c.REFERENCE === form.value.reference);
                    if (existingClientIndex !== -1) {
                        if (form.value.expectedPrice > 0) {
                            let newBalance = form.value.expectedPrice - netAmountPaid; if (newBalance < 0) newBalance = 0;
                            await updateDoc(clientRef, { PRIX: newBalance });
                        }
                    } else {
                        await setDoc(clientRef, { REFERENCE: form.value.reference, EXPEDITEUR: form.value.label, DESTINATEUR: form.value.recipient || '', TELEPHONE: '', PRIX: form.value.amount }, { merge: true });
                    }
                }
                form.value.label = ''; form.value.recipient = ''; form.value.reference = ''; form.value.amount = ''; form.value.expectedPrice = 0; form.value.isHidden = false;
            } catch (e) { console.error(e); alert("Erreur ajout : " + e.message); }
        };

        const deleteTransaction = async (id) => { if (confirm("Supprimer ?")) await deleteDoc(doc(db, "transactions", id)); };
        
        const openClosingModal = () => { closing.value.om = 0; closing.value.wave = 0; showClosingModal.value = true; };
        
        const confirmClose = async () => {
            if (!currentSession.value) return;
            try {
                await updateDoc(doc(db, "sessions", currentSession.value.id), {
                    endTime: Timestamp.now(), status: "CLOSED",
                    totalsComputed: totals.value,
                    closingAmounts: closing.value,
                    gaps: { om: closing.value.om - totals.value.om, wave: closing.value.wave - totals.value.wave }
                });
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
            const file = fileInput.value.files[0];
            if (!file) return;
            importStatus.value = "Lecture...";
            Papa.parse(file, {
                header: true, skipEmptyLines: true,
                complete: async (results) => {
                    importStatus.value = `Import de ${results.data.length} clients...`;
                    let count = 0; const batchSize = 400; let batch = writeBatch(db);
                    for (const row of results.data) {
                        if (!row.REFERENCE) continue;
                        const refClean = row.REFERENCE.replace(/\//g, "-").trim();
                        batch.set(doc(db, "clients", refClean), { REFERENCE: row.REFERENCE, EXPEDITEUR: row.EXPEDITEUR || '', DESTINATEUR: row.DESTINATEUR || '', TELEPHONE: row.TELEPHONE || '', TELEPHONE2: row.TELEPHONE2 || '', PRIX: row.PRIX ? parseFloat(row.PRIX.replace(/\s/g, '').replace(',', '.')) : 0 }, { merge: true });
                        count++;
                        if (count % batchSize === 0) { await batch.commit(); batch = writeBatch(db); }
                    }
                    await batch.commit();
                    importStatus.value = "Terminé !"; setTimeout(() => importStatus.value = '', 3000);
                }
            });
        };

        const exportToExcel = (data, title) => { const ws = XLSX.utils.json_to_sheet(data.map(t => ({ Date: formatDate(t.timestamp), Ref: t.reference, Exp: t.label, Dest: t.recipient, Type: t.type, Cat: t.category, Montant: t.amount }))); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Feuille1"); XLSX.writeFile(wb, title + ".xlsx"); };
        
        const exportToPDF = () => {
            if (!window.jspdf) return alert("Erreur PDF");
            const { jsPDF } = window.jspdf; const doc = new jsPDF();
            doc.text("Journal de Caisse", 14, 15);
            const list = visibleTransactions.value;
            doc.autoTable({ head: [["Date", "Réf", "Expéditeur", "Destinataire", "Mode", "Montant"]], body: list.map(tx => [formatDate(tx.timestamp)+'\n'+formatTime(tx.timestamp), tx.reference||'-', tx.label+(tx.isHidden?' (INT)':''), tx.recipient||'', getModeAbbr(tx.category), formatMoney(tx.amount-(tx.fees||0)).replace(/\s/g,' ')]), startY: 30, theme: 'grid', styles: {fontSize:8}, columnStyles: {0:{cellWidth:20}, 4:{cellWidth:15, halign:'center'}, 5:{halign:'right', fontStyle:'bold'}} });
            doc.save("Journal.pdf");
        };

        // Helpers
        const formatMoney = (m) => new Intl.NumberFormat('fr-FR').format(m || 0) + ' F';
        const formatDate = (ts) => { if (!ts) return '-'; const d = ts.toDate ? ts.toDate() : new Date(ts); return d.toLocaleDateString('fr-FR'); };
        const formatTime = (ts) => { if (!ts) return '-'; const d = ts.toDate ? ts.toDate() : new Date(ts); return d.toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit'}); };
        const formatDateTime = (ts) => formatDate(ts) + ' ' + formatTime(ts);
        const getBadgeClass = (c) => ({ 'OM': 'bg-orange-50 text-orange-700 border-orange-200', 'WAVE': 'bg-blue-50 text-blue-700 border-blue-200', 'ESPECE': 'bg-green-50 text-green-700 border-green-200', 'BANQUE': 'bg-gray-50 text-gray-700 border-gray-200' }[c] || '');
        const getModeAbbr = (c) => ({ 'ESPECE': 'ESP', 'OM': 'OM', 'WAVE': 'WAV', 'BANQUE': 'BQE' }[c] || c);
        const getGapClass = (gap) => gap === 0 ? 'text-gray-400' : (gap > 0 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700');
        const formatGap = (g) => (g > 0 ? '+' : '') + formatMoney(g);
        const saveBilletage = () => {}; 
        const updateStartAmounts = () => {};

        return {
            user, isAdmin, authLoading, loginForm, login, logout, loginError,
            currentView, currentSession, transactions, visibleTransactions, loading, startAmounts, form, closing, billets, totals, totalEspeceCompte, showClosingModal,
            closedSessions, showHistoryModal, selectedSessionHistory, selectedTransactionsHistory, visibleHistoryTransactions, openHistoryDetails,
            clientDatabase, searchQuery, showSuggestions, filteredClients, selectClient, importClients, fileInput, importStatus,
            startSession, addTransaction, openClosingModal, confirmClose, deleteTransaction,
            formatMoney, formatTime, formatDate, formatDateTime, getBadgeClass, getGapClass, formatGap, exportToExcel, exportToPDF,
            saveBilletage, getModeAbbr, showHiddenTransactions, historyModalTotals,
            
            // --- EXPORTS POUR LA VUE SALAIRE ---
            currentSalaireView, employeesList, salaryHistory, paiePeriod, 
            showAddEmployeeModal, showEditEmployeeModal, showIndividualHistoryModal, showPayModal, // Ajoutés
            newEmp, editingEmp, payForm, unpaidEmployees, // Ajoutés
            selectedEmployeeHistoryName, individualHistory, // Ajoutés
            
            saveNewEmployee, updateEmployee, deleteEmployee, openEditEmployee, openIndividualHistory, // Ajoutés
            openPayModal, confirmSalaryPayment, deleteSalaryPayment, hasPaidTontine, tontineMembers,
            calculateBase, calculateLoanDeduc, calculateTontineDeduc, calculateNet, exportSalaryHistoryPDF, salaryFunds, showFundModal, newFund, salaryStats, // AJOUTÉS
            saveSalaryFund, deleteSalaryFund, groupedSalaryHistory, selectedHistoryMonth, openMonthDetails, closeMonthDetails, openPayModal, confirmSalaryPayment, recalcNet // <--- AJOUTER ICI
        };
    }
}).mount('#app');