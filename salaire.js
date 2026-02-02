import { createApp, ref, computed, onMounted, watch } from "https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";
import { getFirestore, collection, addDoc, setDoc, deleteDoc, query, where, orderBy, onSnapshot, updateDoc, doc, serverTimestamp, getDocs, Timestamp, writeBatch, getDoc, limit } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";

// CONFIGURATION FIREBASE
const firebaseConfig = {
    apiKey: "AIzaSyDvo7FRCpr_mE4nTGz6VW7-UL0U1JKe-g8",
    authDomain: "caisse-jb.firebaseapp.com",
    projectId: "caisse-jb",
    storageBucket: "caisse-jb.firebasestorage.app",
    messagingSenderId: "877905828814",
    appId: "1:877905828814:web:79840cd0dfcb8a8036e99f"   
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

createApp({
    setup() {
        const user = ref(null);
        const authLoading = ref(true);
        const loginForm = ref({ email: '', password: '' });
        const loginError = ref('');
        const isAdmin = computed(() => user.value && user.value.email === 'admin@caisse.com'); 

        const currentSalaireView = ref('employes'); 
        const employeesList = ref([]);
        const salaryHistory = ref([]);
        const salaryFunds = ref([]); 
        const paiePeriod = ref("15"); 
        
        const showAddEmployeeModal = ref(false);
        const showEditEmployeeModal = ref(false); 
        const showIndividualHistoryModal = ref(false); 
        const showPayModal = ref(false);
        const showFundModal = ref(false);

        const newEmp = ref({ name: '', salary: 0, loan: 0, tontineCount: 0 });
        const editingEmp = ref({}); 
        const selectedEmployeeHistoryId = ref(null);
        const selectedEmployeeHistoryName = ref('');
        const payForm = ref({});
        const newFund = ref({ amount: '', note: '' });
        
        const globalTontineAmount = ref(10000);
        const selectedBudgetMonth = ref(new Date().toISOString().slice(0, 7));
        const selectedPaieMonth = ref(new Date().toISOString().slice(0, 7));
        const selectedTontineMonth = ref(new Date().toISOString().slice(0, 7));
        const selectedHistoryMonth = ref(null);

        // --- CHARGEMENT DES DONNÉES ---
        const loadEmployees = () => {
             onSnapshot(collection(db, "employees"), (snap) => {
                let list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                list.sort((a, b) => a.name.localeCompare(b.name));
                employeesList.value = list;
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

        // --- COEUR DU SYSTÈME : CALCULS ROBUSTES ---

        // 1. Fonction utilitaire pour savoir ce qui a DÉJÀ été payé ce mois-ci
        const getMonthlySummary = (emp, month) => {
            const payments = salaryHistory.value.filter(p => p.employeeId === emp.id && p.month === month);
            
            const totalNetPaid = payments.reduce((sum, p) => sum + (p.net || 0), 0);
            const totalLoanPaid = payments.reduce((sum, p) => sum + (p.loan || 0), 0);
            const totalTontinePaid = payments.reduce((sum, p) => sum + (p.tontine || 0), 0);
            
            // Le salaire "Brut" déjà couvert = Net perçu + Dettes remboursées + Tontine payée
            const totalGrossPaid = totalNetPaid + totalLoanPaid + totalTontinePaid;

            return { totalNetPaid, totalLoanPaid, totalTontinePaid, totalGrossPaid };
        };

        // 2. Calcul du salaire de base (Ce qu'il reste à payer BRUT)
        const calculateBase = (emp) => {
            const summary = getMonthlySummary(emp, selectedPaieMonth.value);
            
            // Si période Acompte (15) : Cible = 50% du salaire
            if (paiePeriod.value === '15') {
                const target = Math.round(emp.salary / 2);
                const remaining = target - summary.totalGrossPaid;
                return Math.max(0, remaining);
            }
            
            // Si période Solde (30) : Cible = 100% du salaire
            if (paiePeriod.value === '30') {
                const remaining = emp.salary - summary.totalGrossPaid;
                return Math.max(0, remaining);
            }
            return 0;
        };

        // 3. Calcul Tontine (Ne payer que si pas encore fait ce mois-ci)
        const calculateTontineDeduc = (emp) => {
            const count = parseInt(emp.tontineCount || (emp.isTontine ? 1 : 0));
            if (count <= 0) return 0;
            // On ne propose la tontine que pour le SOLDE (30), pas l'acompte
            if (paiePeriod.value === '15') return 0;

            const summary = getMonthlySummary(emp, selectedPaieMonth.value);
            const totalDue = count * globalTontineAmount.value;

            // Si on a déjà payé au moins le montant de la tontine ce mois-ci en tontine, c'est bon
            if (summary.totalTontinePaid >= totalDue) return 0;

            return totalDue - summary.totalTontinePaid;
        };

        // 4. Calcul Prêt (Plafond 10k mais intelligent)
        const calculateLoanDeduc = (emp) => {
            if (!emp.loan || emp.loan <= 0) return 0;
            
            // On propose 10.000 ou le reste de la dette
            const standardDeduc = Math.min(emp.loan, 10000);
            
            // MAIS on vérifie qu'il reste assez de salaire pour payer ça
            const base = calculateBase(emp);
            const tontine = calculateTontineDeduc(emp);
            
            // Reste disponible après tontine
            const available = Math.max(0, base - tontine);
            
            // On ne prend pas plus que ce qui est disponible
            return Math.min(standardDeduc, available);
        };

        // 5. Calcul du Net
        const calculateNet = (emp) => {
            const base = calculateBase(emp);
            const loan = calculateLoanDeduc(emp);
            const tontine = calculateTontineDeduc(emp);
            return Math.max(0, base - loan - tontine);
        };

        // 6. Liste des impayés (CORRIGÉE : Ne disparaît que si tout est payé)
        const unpaidEmployees = computed(() => {
            return employeesList.value.filter(emp => {
                // On garde l'employé tant qu'il reste de l'argent à verser pour la cible
                // Si Acompte (15) : Tant qu'on n'a pas atteint 50%
                // Si Solde (30) : Tant qu'on n'a pas atteint 100%
                const remaining = calculateBase(emp);
                return remaining > 0; // Si reste > 0, il s'affiche
            });
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

        const employeesTotals = computed(() => {
            return employeesList.value.reduce((acc, emp) => {
                acc.salary += (parseFloat(emp.salary) || 0);
                acc.loan += (parseFloat(emp.loan) || 0);
                const count = parseInt(emp.tontineCount || (emp.isTontine ? 1 : 0));
                acc.tontine += count * (parseFloat(globalTontineAmount.value) || 0);
                return acc;
            }, { salary: 0, loan: 0, tontine: 0 });
        });

        // --- ACTIONS ---

        const openPayModal = (emp) => {
            const baseAmount = calculateBase(emp);
            const suggestedLoan = calculateLoanDeduc(emp);
            const tontineAmount = calculateTontineDeduc(emp);

            payForm.value = {
                id: emp.id, 
                name: emp.name, 
                month: selectedPaieMonth.value,
                base: baseAmount,
                loan: suggestedLoan, 
                maxLoan: emp.loan || 0,
                tontine: tontineAmount,
                absence: 0,
                net: baseAmount - suggestedLoan - tontineAmount
            };
            showPayModal.value = true;
        };

        const recalcNet = () => {
            if (payForm.value.loan > payForm.value.maxLoan) payForm.value.loan = payForm.value.maxLoan;
            // Sécurité pour ne pas avoir de net négatif
            const deductions = (payForm.value.loan || 0) + (payForm.value.tontine || 0) + (payForm.value.absence || 0);
            if (deductions > payForm.value.base) {
                // On bloque visuellement ou on laisse faire (choix utilisateur), ici on laisse faire mais le net sera négatif ou on bloque
                // payForm.value.net = 0; 
            }
            payForm.value.net = payForm.value.base - (payForm.value.loan || 0) - (payForm.value.tontine || 0) - (payForm.value.absence || 0);
        };

        const updateBaseFromNet = () => {
            payForm.value.base = (parseFloat(payForm.value.net) || 0) + (parseFloat(payForm.value.loan) || 0) + (parseFloat(payForm.value.tontine) || 0) + (parseFloat(payForm.value.absence) || 0);
        };

        const confirmSalaryPayment = async () => {
            // VERIFICATION BUDGET : On ne peut pas payer si le mois n'a pas de dotation
            const hasBudget = salaryFunds.value.some(f => f.targetMonth === payForm.value.month);
            if (!hasBudget) {
                alert(`Impossible d'effectuer un paiement pour ${payForm.value.month} : Aucun fonds n'a été alloué pour ce mois. Veuillez ajouter une dotation dans l'onglet "Fonds & Budget".`);
                return;
            }

            try {
                // On enregistre
                await addDoc(collection(db, "salary_payments"), {
                    employeeId: payForm.value.id, 
                    employeeName: payForm.value.name, 
                    month: payForm.value.month,
                    type: paiePeriod.value === '15' ? 'Acompte (15)' : 'Solde (Fin)',
                    base: payForm.value.base, 
                    loan: payForm.value.loan, 
                    tontine: payForm.value.tontine, 
                    absence: payForm.value.absence || 0,
                    net: payForm.value.net,
                    timestamp: Timestamp.now()
                });
                
                // On met à jour la dette de l'employé
                if(payForm.value.loan > 0) {
                    const emp = employeesList.value.find(e => e.id === payForm.value.id);
                    if(emp) await updateDoc(doc(db, "employees", payForm.value.id), { loan: Math.max(0, emp.loan - payForm.value.loan) });
                }
                
                showPayModal.value = false;
                // alert("Paiement enregistré !");
            } catch(e) { alert("Erreur: " + e.message); }
        };

        // --- RESTE DU CODE (GESTION RH, TONTINE, PDF...) ---
        // (Identique à votre logique existante pour ne pas tout casser)

        const saveGlobalTontine = async () => {
            if(!isAdmin.value) return;
            try {
                await setDoc(doc(db, "settings", "salary"), { tontineAmount: globalTontineAmount.value }, { merge: true });
                alert("Nouveau montant de tontine enregistré !");
            } catch(e) { alert("Erreur : " + e.message); }
        };

        const saveNewEmployee = async () => {
            if(!newEmp.value.name) return;
            try {
                await addDoc(collection(db, "employees"), { 
                    name: newEmp.value.name, salary: newEmp.value.salary || 0, loan: newEmp.value.loan || 0, tontineCount: newEmp.value.tontineCount || 0, isTontine: (newEmp.value.tontineCount || 0) > 0
                });
                showAddEmployeeModal.value = false;
                newEmp.value = { name: '', salary: 0, loan: 0, tontineCount: 0 };
            } catch(e) { alert("Erreur: " + e.message); }
        };

        const openEditEmployee = (emp) => { editingEmp.value = { ...emp }; showEditEmployeeModal.value = true; };
        const updateEmployee = async () => {
            try {
                await updateDoc(doc(db, "employees", editingEmp.value.id), { name: editingEmp.value.name, salary: editingEmp.value.salary, loan: editingEmp.value.loan, tontineCount: editingEmp.value.tontineCount || 0, isTontine: (editingEmp.value.tontineCount || 0) > 0 });
                showEditEmployeeModal.value = false;
            } catch(e) { alert("Erreur: " + e.message); }
        };
        const deleteEmployee = async (id) => { if(confirm("Supprimer cet employé ?")) await deleteDoc(doc(db, "employees", id)); };

        const cancelTontine = async (emp) => {
            if (!confirm(`Voulez-vous vraiment annuler toutes les parts de tontine pour ${emp.name} ? Cette action est irréversible.`)) {
                return;
            }
            try {
                await updateDoc(doc(db, "employees", emp.id), {
                    tontineCount: 0,
                    isTontine: false
                });
                alert(`La tontine pour ${emp.name} a été annulée.`);
            } catch (e) { alert("Erreur lors de l'annulation de la tontine : " + e.message); }
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

        const openIndividualHistory = (emp) => { selectedEmployeeHistoryId.value = emp.id; selectedEmployeeHistoryName.value = emp.name; showIndividualHistoryModal.value = true; };
        const individualHistory = computed(() => selectedEmployeeHistoryId.value ? salaryHistory.value.filter(p => p.employeeId === selectedEmployeeHistoryId.value) : []);

        // Regroupement Historique (Corrigé selon demande précédente)
        const groupedSalaryHistory = computed(() => {
            const groups = {};
            salaryHistory.value.forEach(pay => {
                if (!groups[pay.month]) groups[pay.month] = { month: pay.month, payments: [], totalNet: 0, totalLoan: 0, totalFund: 0 };
                groups[pay.month].payments.push(pay);
                groups[pay.month].totalNet += pay.net;
                groups[pay.month].totalLoan += (pay.loan || 0);
            });
            salaryFunds.value.forEach(fund => {
                const m = fund.targetMonth;
                if (!groups[m]) groups[m] = { month: m, payments: [], totalNet: 0, totalLoan: 0, totalFund: 0 };
                groups[m].totalFund += fund.amount;
            });
            return Object.values(groups).sort((a, b) => b.month.localeCompare(a.month)).map(group => ({ ...group, balance: group.totalFund - group.totalNet }));
        });

        const openMonthDetails = (group) => { group.payments.sort((a, b) => b.timestamp.seconds - a.timestamp.seconds); selectedHistoryMonth.value = group; };
        const closeMonthDetails = () => { selectedHistoryMonth.value = null; };

        const saveSalaryFund = async () => {
            if(!newFund.value.amount) return;
            try { 
                await addDoc(collection(db, "salary_funds"), { amount: newFund.value.amount, note: newFund.value.note || 'Dotation', targetMonth: newFund.value.targetMonth || selectedBudgetMonth.value, timestamp: Timestamp.now() }); 
                showFundModal.value = false; newFund.value = { amount: '', note: '', targetMonth: selectedBudgetMonth.value }; alert("Fonds enregistrés !"); 
            } catch(e) { alert(e.message); } 
        };
        const deleteSalaryFund = async (id) => { if(confirm("Supprimer ?")) await deleteDoc(doc(db, "salary_funds", id)); };

        const salaryStats = computed(() => {
            const target = selectedBudgetMonth.value;
            const totalReceived = salaryFunds.value.filter(f => (f.targetMonth || (f.timestamp?.toDate ? f.timestamp.toDate().toISOString().slice(0, 7) : '')) === target).reduce((acc, curr) => acc + (curr.amount || 0), 0);
            const totalPaid = salaryHistory.value.filter(p => p.month === target).reduce((acc, curr) => acc + (curr.net || 0), 0);
            const totalLoans = employeesList.value.reduce((acc, curr) => acc + (curr.loan || 0), 0);
            return { totalReceived, totalPaid, balance: totalReceived - totalPaid, totalLoans };
        });

        const tontineMembers = computed(() => {
            let list = [];
            employeesList.value.forEach(e => {
                const count = parseInt(e.tontineCount || (e.isTontine ? 1 : 0));
                for(let i=1; i<=count; i++) {
                    list.push({ ...e, shareIndex: i, uniqueId: e.id + '_' + i });
                }
            });
            return list;
        });
        const hasPaidTontine = (empId, shareIndex = 1) => {
            const currentMonth = selectedTontineMonth.value;
            const totalPaid = salaryHistory.value
                .filter(p => p.employeeId === empId && p.month === currentMonth)
                .reduce((sum, p) => sum + (p.tontine || 0), 0);
            return totalPaid >= (shareIndex * globalTontineAmount.value);
        };

        const getTontinePaidAmount = (empId) => {
            const currentMonth = selectedTontineMonth.value;
            return salaryHistory.value
                .filter(p => p.employeeId === empId && p.month === currentMonth)
                .reduce((sum, p) => sum + (p.tontine || 0), 0);
        };

        const markTontinePayment = async (emp) => {
            let amount = prompt("Montant de la cotisation pour " + emp.name + " ?", globalTontineAmount.value);
            if (amount === null) return;
            amount = parseFloat(amount);
            if (isNaN(amount) || amount <= 0) return alert("Montant invalide");

            try {
                const currentMonth = selectedTontineMonth.value;
                await addDoc(collection(db, "salary_payments"), {
                    employeeId: emp.id, 
                    employeeName: emp.name, 
                    month: currentMonth,
                    type: 'Cotisation Tontine',
                    base: 0, 
                    loan: 0, 
                    tontine: amount, 
                    net: 0,
                    timestamp: Timestamp.now()
                });
            } catch(e) { alert("Erreur: " + e.message); }
        };

        const tontineBeneficiaries = computed(() => {
            return salaryHistory.value.filter(p => 
                p.month === selectedTontineMonth.value && 
                p.type === 'Gain Tontine'
            );
        });

        const markTontineBeneficiary = async (emp) => {
            if (!confirm(`Confirmer que ${emp.name} récupère la tontine du mois (${selectedTontineMonth.value}) ?`)) return;
            
            const totalShares = employeesList.value.reduce((sum, e) => sum + (parseInt(e.tontineCount || (e.isTontine ? 1 : 0))), 0);
            const defaultAmount = totalShares * globalTontineAmount.value;

            let amount = prompt("Montant récupéré ?", defaultAmount);
            if (amount === null) return;
            amount = parseFloat(amount);
            if (isNaN(amount) || amount <= 0) return alert("Montant invalide");

            try {
                await addDoc(collection(db, "salary_payments"), {
                    employeeId: emp.id, employeeName: emp.name, month: selectedTontineMonth.value,
                    type: 'Gain Tontine', base: 0, loan: 0, tontine: 0, tontineGain: amount, net: 0, timestamp: Timestamp.now()
                });
            } catch(e) { alert("Erreur: " + e.message); }
        };

        const deleteTontineBeneficiary = async (payment) => { if(confirm("Supprimer ce gain ?")) await deleteDoc(doc(db, "salary_payments", payment.id)); };

        const exportSalaryHistoryPDF = () => {
            const doc = new jspdf.jsPDF();
            
            // 1. En-tête Principal du Document
            doc.setFontSize(18);
            doc.setTextColor(40);
            doc.text("Rapport Détaillé des Salaires", 14, 20);
            
            doc.setFontSize(10);
            doc.setTextColor(100);
            doc.text("Généré le : " + new Date().toLocaleString(), 14, 28);
            
            let currentY = 35; // Position verticale de départ

            // 2. On boucle sur CHAQUE MOIS de l'historique
            groupedSalaryHistory.value.forEach(group => {
                
                // Vérifier s'il reste assez de place sur la page, sinon nouvelle page
                if (currentY > 250) {
                    doc.addPage();
                    currentY = 20;
                }

                // --- CADRE RÉSUMÉ DU MOIS ---
                doc.setFillColor(245, 247, 250); // Fond gris très clair
                doc.setDrawColor(200, 200, 200); // Bordure grise
                doc.roundedRect(14, currentY, 182, 18, 2, 2, 'FD'); // Rectangle rempli
                
                doc.setFontSize(12);
                doc.setTextColor(0);
                doc.setFont("helvetica", "bold");
                doc.text(`Période : ${group.month}`, 20, currentY + 8);
                
                doc.setFontSize(10);
                doc.setFont("helvetica", "normal");
                
                // Ligne des Totaux (Budget / Payé / Solde)
                // On formate les montants proprement
                const budgetTxt = `Budget: ${formatMoney(group.totalFund)}`;
                const payeTxt = `Payé: ${formatMoney(group.totalNet)}`;
                const soldeTxt = `Reste: ${formatMoney(group.balance)}`;
                
                doc.text(budgetTxt, 20, currentY + 14);
                doc.setTextColor(75, 85, 99); // Gris
                doc.text(payeTxt, 80, currentY + 14);
                
                // Couleur dynamique pour le Solde
                if (group.balance < 0) doc.setTextColor(220, 38, 38); // Rouge
                else doc.setTextColor(22, 163, 74); // Vert
                doc.text(soldeTxt, 140, currentY + 14);

                // --- TABLEAU DÉTAILLÉ DES EMPLOYÉS ---
                // On prépare les lignes (Triées par date)
                const sortedPayments = [...group.payments].sort((a, b) => b.timestamp.seconds - a.timestamp.seconds);
                
                const tableBody = sortedPayments.map(p => [
                    formatDate(p.timestamp),
                    p.employeeName,
                    p.type,
                    p.loan > 0 ? formatMoney(p.loan) : '-', // Afficher '-' si pas de prêt
                    p.absence > 0 ? formatMoney(p.absence) : '-',
                    formatMoney(p.net)
                ]);

                // Si le mois n'a pas de paiement, on met une ligne vide
                if (tableBody.length === 0) {
                    tableBody.push(['-', 'Aucun paiement enregistré', '-', '-', '-', '-']);
                }

                doc.autoTable({
                    startY: currentY + 20, // Juste en dessous du cadre résumé
                    head: [['Date', 'Employé', 'Type', 'Prêt', 'Abs.', 'Net Payé']],
                    body: tableBody,
                    theme: 'grid',
                    headStyles: { 
                        fillColor: [79, 70, 229], // Couleur Indigo (comme votre site)
                        textColor: 255,
                        fontStyle: 'bold'
                    },
                    styles: { 
                        fontSize: 9, 
                        cellPadding: 3 
                    },
                    columnStyles: {
                        0: { cellWidth: 25 }, // Date
                        3: { halign: 'right', cellWidth: 20 }, // Prêt aligné droite
                        4: { halign: 'right', cellWidth: 20 }, // Absence aligné droite
                        5: { halign: 'right', fontStyle: 'bold', cellWidth: 30 } // Net aligné droite
                    },
                    margin: { left: 14, right: 14 },
                    // Important : Mise à jour de la position Y après le tableau
                    didDrawPage: (data) => {
                        // Si le tableau coupe la page, on met à jour currentY pour la suite
                        currentY = data.cursor.y;
                    }
                });

                // Ajouter un espace avant le prochain mois
                currentY = doc.lastAutoTable.finalY + 15;
            });

            doc.save("Rapport_Salaires_Complet.pdf");
        };

        // Fonction qui remplace l'espace insécable (problématique en PDF) par un espace normal
        const formatMoney = (m) => {
            if (!m && m !== 0) return '0 F';
            // On formate en FR, puis on remplace le caractère invisible (\u202f ou \u00a0) par un espace simple
            return new Intl.NumberFormat('fr-FR').format(m).replace(/\s/g, ' ') + ' F';
        };
        const formatDate = (ts) => { if (!ts) return '-'; const d = ts.toDate ? ts.toDate() : new Date(ts); const day = d.getDate().toString().padStart(2, '0'); let month = d.toLocaleString('fr-FR', { month: 'short' }).replace('.', ''); month = month.charAt(0).toUpperCase() + month.slice(1); const year = d.getFullYear(); return `${day}-${month}-${year}`; };
        
        const login = async () => { try { await signInWithEmailAndPassword(auth, loginForm.value.email, loginForm.value.password); } catch (e) { loginError.value = "Erreur de connexion"; } };
        const logout = async () => { await signOut(auth); };

        onAuthStateChanged(auth, (u) => {
            user.value = u; authLoading.value = false;
            if (u) {
                loadEmployees(); loadSalaryHistory(); loadSalaryFunds();
                onSnapshot(doc(db, "settings", "salary"), (docSnap) => { if (docSnap.exists()) globalTontineAmount.value = docSnap.data().tontineAmount || 10000; });
            }
        });

        return {
            user, isAdmin, authLoading, loginForm, login, logout, loginError,
            formatMoney, formatDate,
            currentSalaireView, employeesList, salaryHistory, salaryFunds, paiePeriod, selectedPaieMonth,
            showAddEmployeeModal, showEditEmployeeModal, showIndividualHistoryModal, showPayModal, showFundModal,
            newEmp, editingEmp, payForm, newFund, unpaidEmployees, selectedEmployeeHistoryName, individualHistory,
            groupedSalaryHistory, selectedHistoryMonth, openMonthDetails, closeMonthDetails,
            saveNewEmployee, updateEmployee, deleteEmployee, openEditEmployee, openIndividualHistory, selectedBudgetMonth, cancelTontine,
            openPayModal, confirmSalaryPayment, deleteSalaryPayment, recalcNet, updateBaseFromNet, hasPaidTontine, getTontinePaidAmount, markTontinePayment, tontineMembers, globalTontineAmount, saveGlobalTontine, selectedTontineMonth,
            calculateBase, calculateLoanDeduc, calculateTontineDeduc, calculateNet, exportSalaryHistoryPDF, paieTotals, employeesTotals,
            saveSalaryFund, deleteSalaryFund, salaryStats,
            tontineBeneficiaries, markTontineBeneficiary, deleteTontineBeneficiary
        };
    }
}).mount('#app');