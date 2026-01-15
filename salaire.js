// /dev/null
// c:\Users\JEANAFFA\OneDrive\Documents\GitHub\CAISSE-JB\salaire.js
import { createApp, ref, computed, onMounted, watch } from "https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";
import { getFirestore, collection, addDoc, setDoc, deleteDoc, query, where, orderBy, onSnapshot, updateDoc, doc, serverTimestamp, getDocs, Timestamp, writeBatch, getDoc, limit } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";
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

        // --- ETAT APPLICATION SALAIRE ---
        const currentSalaireView = ref('employes'); 
        
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
        
        // PARAMETRE GLOBAL TONTINE
        const globalTontineAmount = ref(10000); // Valeur par défaut
        const selectedBudgetMonth = ref(new Date().toISOString().slice(0, 7)); // Par défaut : Mois actuel (ex: "2025-01")
        const selectedPaieMonth = ref(new Date().toISOString().slice(0, 7)); // Mois par défaut = Mois actuel
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

        const saveGlobalTontine = async () => {
            if(!isAdmin.value) return;
            try {
                await setDoc(doc(db, "settings", "salary"), { tontineAmount: globalTontineAmount.value }, { merge: true });
                alert("Nouveau montant de tontine enregistré !");
            } catch(e) { alert("Erreur : " + e.message); }
        };

        // GESTION EMPLOYES
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
            const currentMonth = selectedPaieMonth.value;

            if (paiePeriod.value === '15') return Math.round(emp.salary / 2);

            if (paiePeriod.value === '30') {
                const advancePayment = salaryHistory.value.find(p => 
                    p.employeeId === emp.id && 
                    p.month === currentMonth && 
                    p.type.includes('Acompte')
                );

                if (advancePayment) {
                    const totalAdvance = (advancePayment.net || 0) + (advancePayment.loan || 0) + (advancePayment.tontine || 0);
                    return emp.salary - totalAdvance;
                }
                return emp.salary;
            }
            return 0;
        };
        
        const calculateLoanDeduc = (emp) => (emp.loan > 0) ? Math.min(emp.loan, 10000) : 0;
        const calculateTontineDeduc = (emp) => (emp.isTontine) ? globalTontineAmount.value : 0;
        const calculateNet = (emp) => calculateBase(emp) - calculateLoanDeduc(emp) - calculateTontineDeduc(emp);

        const unpaidEmployees = computed(() => {
            const currentMonth = selectedPaieMonth.value;
            const typeKey = paiePeriod.value === '15' ? 'Acompte' : 'Solde';
            return employeesList.value.filter(emp => !salaryHistory.value.some(pay => pay.employeeId === emp.id && pay.month === currentMonth && pay.type.includes(typeKey)));
        });

        const paieTotals = computed(() => {
            let t = { base: 0, loan: 0, tontine: 0, net: 0 };
            unpaidEmployees.value.forEach(emp => {
                t.base += calculateBase(emp);
                t.loan += calculateLoanDeduc(emp);
                t.tontine += calculateTontineDeduc(emp);
                t.net += calculateNet(emp);
            });
            return t;
        });

        // PAIEMENT
        const openPayModal = (emp) => {
            const currentMonth = selectedPaieMonth.value;
            const baseAmount = calculateBase(emp);
            const suggestedLoan = (emp.loan > 0) ? Math.min(emp.loan, 10000) : 0;
            const tontineAmount = calculateTontineDeduc(emp);

            payForm.value = {
                id: emp.id, name: emp.name, month: currentMonth,
                base: baseAmount,
                loan: suggestedLoan, maxLoan: emp.loan || 0,
                tontine: tontineAmount,
                net: baseAmount - suggestedLoan - tontineAmount
            };
            showPayModal.value = true;
        };

        const recalcNet = () => {
            if (payForm.value.loan > payForm.value.maxLoan) payForm.value.loan = payForm.value.maxLoan;
            payForm.value.net = payForm.value.base - payForm.value.loan - (payForm.value.tontine || 0);
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
            try { 
                await addDoc(collection(db, "salary_funds"), { 
                    amount: newFund.value.amount, 
                    note: newFund.value.note || 'Dotation', 
                    targetMonth: newFund.value.targetMonth || selectedBudgetMonth.value,
                    timestamp: Timestamp.now() 
                }); 
                showFundModal.value = false; 
                newFund.value = { amount: '', note: '', targetMonth: selectedBudgetMonth.value };
                alert("Fonds enregistrés !"); 
            } catch(e) { alert(e.message); } 
        };
        const deleteSalaryFund = async (id) => { if(confirm("Supprimer ?")) await deleteDoc(doc(db, "salary_funds", id)); };

        const salaryStats = computed(() => {
            const target = selectedBudgetMonth.value;
            const totalReceived = salaryFunds.value
                .filter(f => {
                    const fundMonth = f.targetMonth || (f.timestamp?.toDate ? f.timestamp.toDate().toISOString().slice(0, 7) : '');
                    return fundMonth === target;
                })
                .reduce((acc, curr) => acc + (curr.amount || 0), 0);
            const totalPaid = salaryHistory.value
                .filter(p => p.month === target)
                .reduce((acc, curr) => acc + (curr.net || 0), 0);
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

        // UTILITAIRES
        const formatMoney = (m) => new Intl.NumberFormat('fr-FR').format(m || 0) + ' F';
        const formatDate = (ts) => { if (!ts) return '-'; const d = ts.toDate ? ts.toDate() : new Date(ts); const day = d.getDate().toString().padStart(2, '0'); let month = d.toLocaleString('fr-FR', { month: 'short' }).replace('.', ''); month = month.charAt(0).toUpperCase() + month.slice(1); const year = d.getFullYear(); return `${day}-${month}-${year}`; };
        
        // AUTH
        const login = async () => { try { await signInWithEmailAndPassword(auth, loginForm.value.email, loginForm.value.password); } catch (e) { loginError.value = "Erreur de connexion"; } };
        const logout = async () => { await signOut(auth); };

        onAuthStateChanged(auth, (u) => {
            user.value = u; authLoading.value = false;
            if (u) {
                loadEmployees(); loadSalaryHistory(); loadSalaryFunds();
                onSnapshot(doc(db, "settings", "salary"), (docSnap) => {
                    if (docSnap.exists()) {
                        globalTontineAmount.value = docSnap.data().tontineAmount || 10000;
                    }
                });
            }
        });

        return {
            user, isAdmin, authLoading, loginForm, login, logout, loginError,
            formatMoney, formatDate,
            currentSalaireView, employeesList, salaryHistory, salaryFunds, paiePeriod, selectedPaieMonth,
            showAddEmployeeModal, showEditEmployeeModal, showIndividualHistoryModal, showPayModal, showFundModal,
            newEmp, editingEmp, payForm, newFund, unpaidEmployees, selectedEmployeeHistoryName, individualHistory,
            groupedSalaryHistory, selectedHistoryMonth, openMonthDetails, closeMonthDetails,
            saveNewEmployee, updateEmployee, deleteEmployee, openEditEmployee, openIndividualHistory, selectedBudgetMonth,
            openPayModal, confirmSalaryPayment, deleteSalaryPayment, recalcNet, hasPaidTontine, tontineMembers, globalTontineAmount, saveGlobalTontine,
            calculateBase, calculateLoanDeduc, calculateTontineDeduc, calculateNet, exportSalaryHistoryPDF, paieTotals,
            saveSalaryFund, deleteSalaryFund, salaryStats
        };
    }
}).mount('#app');
