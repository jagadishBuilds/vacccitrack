import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Syringe, Baby, ClipboardList, Calendar, Search, Bell, Users, 
  Settings, LogOut, LayoutDashboard, ChevronRight, Menu, 
  CheckCircle, Clock, AlertTriangle, Plus, Eye, Edit, Trash2, 
  ClipboardCheck, Venus, Mars, MapPin, Phone, Mail, Info, BarChart3, 
  RefreshCw, Send, History, X, Save, Undo
} from 'lucide-react';
import * as emailjs from '@emailjs/browser';
import { format, addWeeks, differenceInDays } from 'date-fns';
import { INITIAL_VACCINES, INITIAL_USERS } from './constants';
import { 
  User, UserRole, Vaccine, Child as ChildType, 
  VaccinationRecord, EmailJSConfig, ReminderLog 
} from './types';
import { cn, calcAge, calcAgeWeeks, formatDate } from './lib/utils';
import { db as firestore, auth, handleFirestoreError, OperationType } from './lib/firebase';
import { 
  collection, doc, setDoc, getDoc, getDocs, onSnapshot, 
  query, where, addDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp 
} from 'firebase/firestore';
import { 
  signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged, signInAnonymously 
} from 'firebase/auth';

// --- MAIN APP COMPONENT ---
export default function App() {
  const [db, setDb] = useState<{
    users: User[];
    vaccines: Vaccine[];
    children: ChildType[];
    vaccinationRecords: VaccinationRecord[];
    nextChildId: number;
    nextUserId: number;
    reminderLog: ReminderLog[];
  }>({
    users: [],
    vaccines: [],
    children: [],
    vaccinationRecords: [],
    nextChildId: 1001,
    nextUserId: 1,
    reminderLog: [],
  });

  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [activePage, setActivePage] = useState('dashboard');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [authError, setAuthError] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  // Sync with Firestore
  useEffect(() => {
    if (!currentUser || !auth.currentUser) return;
    const isStaff = currentUser.role === UserRole.ADMIN || currentUser.role === UserRole.WORKER;
    const uid = auth.currentUser.uid;

    const unsubVaccines = onSnapshot(collection(firestore, 'vaccines'), (snapshot) => {
      const vaccines = snapshot.docs.map(doc => ({ ...doc.data() } as Vaccine));
      setDb(prev => ({ ...prev, vaccines }));
      
      // Seed initial vaccines if empty (staff only)
      if (snapshot.empty && isStaff) {
        const batch = writeBatch(firestore);
        INITIAL_VACCINES.forEach(v => {
          batch.set(doc(firestore, 'vaccines', v.id.toString()), { ...v, id: v.id.toString() });
        });
        batch.commit().catch(err => {
          if (currentUser) handleFirestoreError(err, OperationType.WRITE, 'vaccines');
        });
      }
    }, (err) => {
      if (currentUser) handleFirestoreError(err, OperationType.LIST, 'vaccines');
    });

    const childrenQuery = isStaff 
      ? collection(firestore, 'children') 
      : query(collection(firestore, 'children'), where('id', '==', currentUser.id.toString().replace('p-', '')));

    const unsubChildren = onSnapshot(childrenQuery, (snapshot) => {
      const children = snapshot.docs.map(doc => ({ ...doc.data() } as ChildType));
      setDb(prev => ({ 
        ...prev, 
        children,
        nextChildId: snapshot.empty ? 1001 : Math.max(...children.map(c => Number(c.id))) + 1
      }));
    }, (err) => {
      if (isStaff) handleFirestoreError(err, OperationType.LIST, 'children');
    });

    const unsubReminders = onSnapshot(
      isStaff ? collection(firestore, 'reminders') : query(collection(firestore, 'reminders'), where('childId', '==', currentUser.id.toString().replace('p-', ''))), 
      (snapshot) => {
        const reminderLog = snapshot.docs.map(doc => ({ ...doc.data() } as ReminderLog));
        setDb(prev => ({ ...prev, reminderLog }));
      }, (err) => {
        if (currentUser) handleFirestoreError(err, OperationType.LIST, 'reminders');
      }
    );

    // User listener
    let unsubUsers: () => void;
    if (isStaff) {
      unsubUsers = onSnapshot(collection(firestore, 'users'), (snapshot) => {
        const users = snapshot.docs.map(doc => ({ ...doc.data() } as User));
        setDb(prev => ({ ...prev, users }));
      }, (err) => {
        if (currentUser) handleFirestoreError(err, OperationType.LIST, 'users');
      });
    } else {
      unsubUsers = onSnapshot(doc(firestore, 'users', uid), (snapshot) => {
        if (snapshot.exists()) {
          const user = { ...snapshot.data() } as User;
          setDb(prev => ({ ...prev, users: [user] }));
        }
      }, (err) => {
        if (currentUser) handleFirestoreError(err, OperationType.GET, `users/${uid}`);
      });
    }

    // Filter records by childId for parents
    const recordsQuery = isStaff
      ? collection(firestore, 'all_records')
      : query(collection(firestore, 'all_records'), where('childId', '==', currentUser.id.toString().replace('p-', '')));

    const unsubRecords = onSnapshot(recordsQuery, (snapshot) => {
      const vaccinationRecords = snapshot.docs.map(doc => ({ ...doc.data() } as VaccinationRecord));
      setDb(prev => ({ ...prev, vaccinationRecords }));
    }, (err) => {
      if (currentUser) handleFirestoreError(err, OperationType.LIST, 'all_records');
    });

    return () => {
      unsubVaccines();
      unsubChildren();
      unsubReminders();
      unsubUsers();
      unsubRecords();
    };
  }, [currentUser]);

  // Auth synchronization
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        setAuthError('');
        try {
          const userDoc = await getDoc(doc(firestore, 'users', firebaseUser.uid));
          if (userDoc.exists()) {
            setCurrentUser(userDoc.data() as User);
          } else {
            // Check if there's a pre-approved user record by email (for staff)
            let foundUser: User | null = null;
            if (firebaseUser.email) {
              const tempId = firebaseUser.email.toLowerCase().replace(/[@.]/g, '_');
              const preDoc = await getDoc(doc(firestore, 'users', tempId));
              if (preDoc.exists()) {
                foundUser = preDoc.data() as User;
                // Migrate the record to use the real UID
                await setDoc(doc(firestore, 'users', firebaseUser.uid), {
                  ...foundUser,
                  id: firebaseUser.uid,
                  authUid: firebaseUser.uid
                });
                // Delete temp record
                await deleteDoc(doc(firestore, 'users', tempId));
              }
            }

            if (!foundUser) {
              // New user (first time login) - handle initial admin
              // FOR ANONYMOUS PARENTS: Don't auto-create as worker. 
              // Wait for handleLogin to finish setDoc.
              if (firebaseUser.isAnonymous) return;

              const isInitialAdmin = firebaseUser.email === 'dharitriii01@gmail.com';
              const newUser: User = {
                id: firebaseUser.uid,
                email: firebaseUser.email || '',
                username: firebaseUser.email || firebaseUser.uid,
                fullname: firebaseUser.displayName || 'Staff Administrator',
                password: '',
                role: isInitialAdmin ? UserRole.ADMIN : UserRole.WORKER,
                active: true,
                authUid: firebaseUser.uid
              };
              await setDoc(doc(firestore, 'users', firebaseUser.uid), newUser);
              setCurrentUser(newUser);
            } else {
              setCurrentUser({ ...foundUser, id: firebaseUser.uid });
            }
          }
        } catch (err) {
          handleFirestoreError(err, OperationType.GET, `users/${firebaseUser.uid}`);
        }
      } else {
        setCurrentUser(null);
      }
      setIsLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const [loginType, setLoginType] = useState<'hospital' | 'parent'>('hospital');

  // Auth logic
  const handleGoogleLogin = async () => {
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (err: any) {
      setAuthError(err.message || 'Google login failed.');
    }
  };

  const handleLogin = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const u = (formData.get('username') as string || "").trim();
    const p = (formData.get('password') as string || "").trim();
    
    if (loginType === 'hospital') {
      // For now, hospital staff uses Google Login or we can search in users collection
      // Let's implement a simple user lookup if they don't want to use Google
      try {
        const usersRef = collection(firestore, 'users');
        const q = query(usersRef, where('username', '==', u), where('password', '==', p));
        const snapshot = await getDocs(q);
        
        if (!snapshot.empty) {
          const user = snapshot.docs[0].data() as User;
          if (user.active) {
            setCurrentUser(user);
            setAuthError('');
          } else {
            setAuthError('Account is deactivated.');
          }
        } else {
          setAuthError('Invalid username or password.');
        }
      } catch (err: any) {
        setAuthError('Login error occurred.');
      }
    } else {
      // Parent Login
      try {
        // 1. Sign in anonymously first to get access to Firestore
        const userCredential = await signInAnonymously(auth);
        const tempUid = userCredential.user.uid;

        // 2. Try to find the child by ID or Email with the password from Firestore
        const childrenRef = collection(firestore, 'children');
        let q;
        if (u.includes('@')) {
          q = query(childrenRef, where('email', '==', u), where('parentPassword', '==', p));
        } else {
          q = query(childrenRef, where('id', '==', u), where('parentPassword', '==', p));
        }
        
        const snapshot = await getDocs(q);

        if (!snapshot.empty) {
          const childDoc = snapshot.docs[0];
          const child = childDoc.data() as ChildType;
          const parentId = `p-${child.id}`;
          
          const parentUser: User = {
            id: parentId,
            username: child.email || child.id.toString(),
            fullname: child.guardian || `Parent of ${child.name}`,
            role: UserRole.PARENT,
            active: true,
            password: '',
            authUid: tempUid
          };

          // Create/Update the user doc in Firestore for security rules to work
          await setDoc(doc(firestore, 'users', tempUid), parentUser);

          setCurrentUser(parentUser);
          setAuthError('');
        } else {
          // If child not found, sign out to cleanup
          await signOut(auth);
          setAuthError('Invalid credentials. Please check Child ID and Parent Password.');
        }
      } catch (err: any) {
        if (err.code === 'auth/admin-restricted-operation') {
          setAuthError('Parent Login is currently disabled. Please enable the "Anonymous" provider in Firebase Console.');
        } else {
          setAuthError(err.message || 'Login failed.');
        }
      }
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
    setCurrentUser(null);
    setActivePage('dashboard');
  };


  // --- SUB-PAGES ---
  
  if (isLoading) {
    return (
      <div className="min-h-screen bg-linear-to-br from-sidebar-bg via-primary to-primary-mid flex items-center justify-center p-4">
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-white flex flex-col items-center gap-4">
          <RefreshCw className="animate-spin" size={48} />
          <p className="font-display text-xl">Loading VacciTrack...</p>
        </motion.div>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <div className={cn(
        "min-h-screen bg-linear-to-br transition-all duration-700 flex items-center justify-center p-4",
        loginType === 'hospital' 
          ? "from-sidebar-bg via-primary to-primary-mid" 
          : "from-blue-900 via-indigo-900 to-indigo-700"
      )}>
        <motion.div 
          key={loginType}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.4 }}
          className="auth-card max-w-sm w-full"
        >
          <div className="flex items-center gap-3 mb-8">
            <div className={cn(
              "w-12 h-12 rounded-xl flex items-center justify-center text-white transition-colors duration-500 shadow-lg",
              loginType === 'hospital' ? "bg-primary shadow-primary/20" : "bg-indigo-500 shadow-indigo-500/20"
            )}>
              {loginType === 'hospital' ? <Syringe size={24} /> : <Baby size={24} />}
            </div>
            <div>
              <h2 className="text-xl text-primary font-display leading-tight">VacciTrack</h2>
              <span className="text-[10px] text-text-muted font-sans uppercase tracking-wider">
                {loginType === 'hospital' ? 'Management System' : 'Parent Portal'}
              </span>
            </div>
          </div>
          
          <h3 className="text-2xl mb-1 text-text-main font-display">
            {loginType === 'hospital' ? 'Hospital Login' : 'Parent Portal'}
          </h3>
          <p className="text-sm text-text-muted mb-6">
            {loginType === 'hospital' ? 'Access management tools' : 'Track your child\'s health records'}
          </p>
          
          <div className="flex gap-2 mb-6 p-1 bg-body-bg rounded-xl">
            <button 
              onClick={() => { setLoginType('hospital'); setAuthError(''); }}
              className={cn(
                "flex-1 py-2 text-xs font-bold rounded-lg transition-all",
                loginType === 'hospital' ? "bg-primary text-white shadow-lg shadow-primary/20" : "text-text-muted hover:bg-white"
              )}
            >
              Hospital
            </button>
            <button 
              onClick={() => { setLoginType('parent'); setAuthError(''); }}
              className={cn(
                "flex-1 py-2 text-xs font-bold rounded-lg transition-all",
                loginType === 'parent' ? "bg-indigo-600 text-white shadow-lg shadow-indigo-600/20" : "text-text-muted hover:bg-white"
              )}
            >
              Parent
            </button>
          </div>

          {authError && (
            <div className="bg-danger-light text-danger text-xs p-3 rounded-lg flex items-center gap-2 mb-6 border border-danger/20">
              <AlertTriangle size={14} /> {authError}
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="text-xs font-bold text-text-main mb-1.5 block">
                {loginType === 'hospital' ? 'Username' : 'Child ID or Email'}
              </label>
              <input 
                name="username"
                type="text" 
                className="form-control-custom" 
                placeholder={loginType === 'hospital' ? "Enter username" : "ID like 1001 or email"}
                required
              />
            </div>
            <div>
              <label className="text-xs font-bold text-text-main mb-1.5 block">Password</label>
              <input 
                name="password"
                type="password" 
                className="form-control-custom" 
                placeholder="••••••••"
                required
              />
            </div>

            <button 
              type="submit" 
              className={cn(
                "w-full py-3 rounded-xl text-white text-sm font-bold shadow-lg transition-all flex items-center justify-center gap-2 mt-2",
                loginType === 'hospital' ? "bg-primary shadow-primary/20 border-none" : "bg-indigo-600 shadow-indigo-600/20 border-none"
              )}
            >
                {loginType === 'hospital' ? 'Hospital Login' : 'Parent Sign In'} <ChevronRight size={16} />
            </button>
          </form>
          
          {loginType === 'parent' && (
            <div className="mt-8 p-4 bg-indigo-50 rounded-xl text-[11px] text-indigo-700 space-y-1 border border-indigo-100">
               <strong className="block mb-1">Parent Note:</strong>
               <p>Use the password provided by your hospital during child registration.</p>
            </div>
          )}

          {loginType === 'hospital' && (
            <div className="mt-6 pt-6 border-t border-divider">
              <button 
                onClick={handleGoogleLogin}
                type="button"
                className="w-full py-3 rounded-xl bg-white border border-divider text-text-main text-sm font-bold flex items-center justify-center gap-3 hover:bg-body-bg transition-colors"
              >
                <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/action/google.svg" className="w-5 h-5" alt="Google" />
                Staff Google Login
              </button>
            </div>
          )}
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className={cn(
        "fixed lg:static inset-y-0 left-0 z-50 w-64 bg-sidebar-bg flex flex-col transition-transform duration-300 transform",
        isSidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
      )}>
        <div className="p-6 pb-4 border-b border-white/5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-primary-mid rounded-lg flex items-center justify-center text-white">
              <Syringe size={20} />
            </div>
            <div>
              <h4 className="text-white text-base font-display">VacciTrack</h4>
              <span className="text-[10px] text-sidebar-text font-sans">
                {currentUser.role === UserRole.PARENT ? 'Parent Portal' : 'Internal Dashboard'}
              </span>
            </div>
          </div>
        </div>

        <nav className="flex-1 p-3 pt-4 space-y-0.5 overflow-y-auto">
          {currentUser.role === UserRole.PARENT ? (
            <>
              <SectionLabel label="My Child" />
              <NavItem active={activePage==='dashboard'} icon={<LayoutDashboard size={18}/>} label="Status Dashboard" onClick={() => {setActivePage('dashboard'); setIsSidebarOpen(false);}} />
              <NavItem active={activePage==='history'} icon={<ClipboardList size={18}/>} label="Vaccine History" onClick={() => {setActivePage('history'); setIsSidebarOpen(false);}} />
              <NavItem active={activePage==='schedule'} icon={<Calendar size={18}/>} label="Future Schedule" onClick={() => {setActivePage('schedule'); setIsSidebarOpen(false);}} />
            </>
          ) : (
            <>
              <SectionLabel label="Main" />
              <NavItem active={activePage==='dashboard'} icon={<LayoutDashboard size={18}/>} label="Dashboard" onClick={() => {setActivePage('dashboard'); setIsSidebarOpen(false);}} />
              <NavItem active={activePage==='register'} icon={<Baby size={18}/>} label="Register Child" onClick={() => {setActivePage('register'); setIsSidebarOpen(false);}} />
              <NavItem active={activePage==='records'} icon={<ClipboardList size={18}/>} label="Vaccination Records" onClick={() => {setActivePage('records'); setIsSidebarOpen(false);}} />
              <NavItem active={activePage==='search'} icon={<Search size={18}/>} label="Search & Records" onClick={() => {setActivePage('search'); setIsSidebarOpen(false);}} />
              <NavItem active={activePage==='schedule'} icon={<Calendar size={18}/>} label="Schedule" onClick={() => {setActivePage('schedule'); setIsSidebarOpen(false);}} />
              <NavItem active={activePage==='reminders'} icon={<Bell size={18}/>} label="Email Reminders" onClick={() => {setActivePage('reminders'); setIsSidebarOpen(false);}} />
            </>
          )}
          
          {currentUser.role === UserRole.ADMIN && (
            <>
              <SectionLabel label="Admin" />
              <NavItem active={activePage==='adminUsers'} icon={<Users size={18}/>} label="Manage Users" onClick={() => {setActivePage('adminUsers'); setIsSidebarOpen(false);}} />
              <NavItem active={activePage==='adminVaccines'} icon={<Syringe size={18}/>} label="Manage Vaccines" onClick={() => {setActivePage('adminVaccines'); setIsSidebarOpen(false);}} />
              <NavItem active={activePage==='reports'} icon={<BarChart3 size={18}/>} label="Reports" onClick={() => {setActivePage('reports'); setIsSidebarOpen(false);}} />
            </>
          )}

          <SectionLabel label="Account" />
          <NavItem active={false} icon={<LogOut size={18}/>} label="Logout" onClick={handleLogout} />
        </nav>

        <div className="p-5 border-t border-white/5 flex items-center gap-3">
          <div className="w-9 h-9 bg-primary-mid rounded-full flex items-center justify-center text-white font-bold uppercase transition-all shadow-lg shadow-black/20">
            {currentUser.fullname.charAt(0)}
          </div>
          <div>
            <div className="text-white text-xs font-semibold">{currentUser.fullname}</div>
            <div className="text-[10px] text-sidebar-text capitalize">{currentUser.role}</div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 min-h-screen overflow-x-hidden">
        {/* Topbar */}
        <header className="p-6 lg:p-8 flex items-center justify-between">
          <div>
            <h3 className="text-2xl font-display text-text-main capitalize">
              {activePage.replace(/([A-Z])/g, ' $1').trim()}
            </h3>
            <p className="text-xs text-text-muted mt-0.5">
              {currentUser.role === UserRole.PARENT ? 'Personal Vaccination Tracker' : 'VacciTrack Central Management'}
            </p>
          </div>
          <button 
            className="lg:hidden p-2 text-primary bg-primary-light rounded-lg"
            onClick={() => setIsSidebarOpen(true)}
          >
            <Menu size={20} />
          </button>
        </header>

        <div className="px-6 lg:px-8 pb-12 overflow-y-auto">
          <AnimatePresence mode="wait">
            <motion.div
              key={activePage}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
            >
              {currentUser.role === UserRole.PARENT ? (
                <>
                  {activePage === 'dashboard' && <ParentDashboard db={db} currentUser={currentUser} setActivePage={setActivePage} />}
                  {activePage === 'history' && <ParentHistory db={db} currentUser={currentUser} />}
                  {activePage === 'schedule' && <Schedule vaccines={db.vaccines} />}
                </>
              ) : (
                <>
                  {activePage === 'dashboard' && <Dashboard db={db} setDb={setDb} setActivePage={setActivePage} />}
                  {activePage === 'register' && <RegisterChild db={db} setDb={setDb} currentUser={currentUser} />}
                  {activePage === 'records' && <Records db={db} setDb={setDb} currentUser={currentUser} />}
                  {activePage === 'search' && <SearchPage db={db} setDb={setDb} currentUser={currentUser} />}
                  {activePage === 'schedule' && <Schedule vaccines={db.vaccines} />}
                  {activePage === 'reminders' && <Reminders db={db} setDb={setDb} currentUser={currentUser} />}
                  {activePage === 'adminUsers' && <AdminUsers db={db} setDb={setDb} />}
                  {activePage === 'adminVaccines' && <AdminVaccines db={db} setDb={setDb} />}
                  {activePage === 'reports' && <Reports db={db} />}
                </>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
      
      {/* Sidebar Mobile Overlay */}
      {isSidebarOpen && (
        <div 
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}
    </div>
  );
}

// --- SUB-COMPONENTS ---

function SectionLabel({ label }: { label: string }) {
  return <div className="text-[9px] font-bold tracking-[0.15em] text-sidebar-text/40 uppercase px-3 pt-6 pb-2">{label}</div>;
}

function NavItem({ active, icon, label, onClick }: { active: boolean, icon: React.ReactNode, label: string, onClick: () => void }) {
  return (
    <button 
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-all duration-200",
        active ? "bg-primary text-white shadow-lg shadow-primary/20" : "text-sidebar-text hover:bg-white/5 hover:text-white"
      )}
    >
      {icon} {label}
    </button>
  );
}

// -- Dashboard Section --
function Dashboard({ db, setActivePage }: any) {
  const stats = useMemo(() => {
    const childrenCount = db.children.length;
    const completedVaccinations = db.vaccinationRecords.filter((r: any) => r.status === 'completed').length;
    const pendingVaccinations = (childrenCount * db.vaccines.length) - completedVaccinations;
    
    // Due this week
    const now = new Date();
    const oneWeekLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const dueThisWeek = db.children.reduce((acc: number, child: ChildType) => {
      const childDues = db.vaccines.filter((v: Vaccine) => {
        const record = db.vaccinationRecords.find((r: VaccinationRecord) => r.childId === child.id && r.vaccineId === v.id);
        if (record?.status === 'completed') return false;
        const dueDate = addWeeks(new Date(child.dob), v.ageWeeks);
        return dueDate <= oneWeekLater && dueDate >= now;
      });
      return acc + childDues.length;
    }, 0);

    return { childrenCount, completedVaccinations, pendingVaccinations, dueThisWeek };
  }, [db]);

  const recentRegistrations = [...db.children].reverse().slice(0, 5);

  const upcomingVaccinations = useMemo(() => {
    const list: any[] = [];
    const now = new Date();
    db.children.forEach((c: ChildType) => {
      db.vaccines.forEach((v: Vaccine) => {
        const rec = db.vaccinationRecords.find((r: VaccinationRecord) => r.childId === c.id && r.vaccineId === v.id);
        if (rec?.status === 'completed') return;
        const dueDate = addWeeks(new Date(c.dob), v.ageWeeks);
        const daysDiff = differenceInDays(dueDate, now);
        if (daysDiff <= 30) list.push({ child: c, vaccine: v, dueDate, daysDiff });
      });
    });
    return list.sort((a,b) => a.daysDiff - b.daysDiff).slice(0, 7);
  }, [db]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={<Baby className="text-primary" />} value={stats.childrenCount} label="Registered Children" bgColor="bg-primary-light" />
        <StatCard icon={<CheckCircle className="text-green-600" />} value={stats.completedVaccinations} label="Vaccinations Given" bgColor="bg-green-50" />
        <StatCard icon={<Clock className="text-accent" />} value={stats.pendingVaccinations} label="Pending Doses" bgColor="bg-accent-light" />
        <StatCard icon={<Bell className="text-info" />} value={stats.dueThisWeek} label="Due This Week" bgColor="bg-info-light" />
      </div>

      <div className="grid lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 card-custom">
          <div className="p-5 border-b border-border flex items-center justify-between">
            <h5 className="font-semibold text-text-main flex items-center gap-2">
              <ClipboardList size={18} className="text-primary" /> Recent Registrations
            </h5>
            <button onClick={() => setActivePage('register')} className="btn-sm-custom bg-primary-light text-primary hover:bg-primary hover:text-white">
              <Plus size={14} /> Add New
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full table-custom">
              <thead>
                <tr>
                  <th>Child Name</th>
                  <th>Age</th>
                  <th>Guardian</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {recentRegistrations.length > 0 ? recentRegistrations.map(c => {
                  const done = db.vaccinationRecords.filter((r: any) => r.childId === c.id && r.status === 'completed').length;
                  const pct = Math.round((done / db.vaccines.length) * 100);
                  return (
                    <tr key={c.id}>
                      <td><span className="font-semibold">{c.name}</span></td>
                      <td>{calcAge(c.dob)}</td>
                      <td>{c.guardian}</td>
                      <td>
                        <div className="badge-custom bg-orange-50 text-orange-600">
                           {pct}% Completed
                        </div>
                      </td>
                    </tr>
                  );
                }) : (
                  <tr>
                    <td colSpan={4} className="text-center py-8 text-text-muted italic">No children registered yet</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="lg:col-span-5 card-custom">
          <div className="p-5 border-b border-border">
            <h5 className="font-semibold text-text-main flex items-center gap-2">
              <Calendar size={18} className="text-accent" /> Upcoming Schedule
            </h5>
          </div>
          <div className="p-4 space-y-3 max-h-[400px] overflow-y-auto">
            {upcomingVaccinations.length > 0 ? upcomingVaccinations.map((u, idx) => (
              <div key={idx} className="flex items-center justify-between p-3 rounded-xl border border-border/50 hover:bg-body-bg transition-colors">
                <div className="flex items-center gap-3">
                  <div className={cn(
                    "w-2.5 h-2.5 rounded-full",
                    u.daysDiff < 0 ? "bg-danger" : u.daysDiff <= 3 ? "bg-accent" : "bg-primary-mid"
                  )} />
                  <div>
                    <div className="text-sm font-bold">{u.child.name}</div>
                    <div className="text-[11px] text-text-muted uppercase tracking-wide font-medium">{u.vaccine.name}</div>
                  </div>
                </div>
                <div className={cn(
                  "text-[10px] font-bold px-2 py-1 rounded-md",
                  u.daysDiff < 0 ? "bg-danger-light text-danger" : "bg-primary-light text-primary"
                )}>
                  {u.daysDiff < 0 ? `Overdue ${Math.abs(u.daysDiff)}d` : u.daysDiff === 0 ? "TODAY" : `${u.daysDiff} days left`}
                </div>
              </div>
            )) : (
              <div className="text-center py-8 text-text-muted italic text-sm">No upcoming vaccinations</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon, value, label, bgColor }: any) {
  return (
    <div className="stat-card">
      <div className={cn("w-12 h-12 rounded-xl flex items-center justify-center mb-4", bgColor)}>
        {icon}
      </div>
      <div className="text-3xl font-display font-bold text-text-main leading-none mb-1">{value}</div>
      <div className="text-xs text-text-muted font-medium">{label}</div>
    </div>
  );
}

function DetailItem({ label, value }: { label: string, value: string | number }) {
  return (
    <div>
      <div className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1">{label}</div>
      <div className="text-sm font-semibold text-text-main">{value || '—'}</div>
    </div>
  );
}

// -- Registration Section --
function RegisterChild({ db, setDb, currentUser }: any) {
  const [success, setSuccess] = useState('');

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const childId = db.nextChildId.toString();
    const newChild: ChildType = {
      id: childId,
      name: formData.get('name') as string,
      dob: formData.get('dob') as string,
      gender: formData.get('gender') as string,
      guardian: formData.get('guardian') as string,
      phone: formData.get('phone') as string,
      email: formData.get('email') as string,
      address: formData.get('address') as string,
      state: formData.get('state') as string,
      city: formData.get('city') as string,
      locality: formData.get('locality') as string,
      hospital: formData.get('hospital') as string,
      parentPassword: formData.get('parentPassword') as string || 'pass123',
      registeredBy: currentUser.username,
      registeredAt: new Date().toISOString(),
    };

    const form = e.currentTarget;
    try {
      await setDoc(doc(firestore, 'children', childId), newChild);
      setSuccess(`${newChild.name} registered successfully!`);
      form.reset();
      setTimeout(() => setSuccess(''), 5000);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `children/${childId}`);
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow-custom border border-border p-8 max-w-3xl">
      <div className="flex items-center gap-4 mb-8">
        <div className="w-12 h-12 bg-primary-light rounded-2xl flex items-center justify-center text-primary">
          <Plus size={24} />
        </div>
        <div>
          <h4 className="text-xl font-display font-bold leading-tight">Register New Child</h4>
          <p className="text-sm text-text-muted">Enter child and guardian details to start tracking</p>
        </div>
      </div>

      {success && (
        <div className="bg-green-50 text-green-700 p-4 rounded-xl flex items-center gap-2 mb-8 border border-green-200">
          <CheckCircle size={18} /> {success}
        </div>
      )}

      <form onSubmit={handleSubmit} className="grid md:grid-cols-2 gap-5">
        <div className="space-y-1.5">
          <label className="text-xs font-bold uppercase tracking-wider text-text-muted">Child's Full Name *</label>
          <input name="name" type="text" className="form-control-custom" placeholder="Aarav Sharma" required />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-bold uppercase tracking-wider text-text-muted">Date of Birth *</label>
          <input name="dob" type="date" className="form-control-custom" required />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-bold uppercase tracking-wider text-text-muted">Gender *</label>
          <select name="gender" className="form-control-custom" required>
            <option value="">Select gender</option>
            <option>Male</option>
            <option>Female</option>
            <option>Other</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-bold uppercase tracking-wider text-text-muted">Guardian Full Name *</label>
          <input name="guardian" type="text" className="form-control-custom" placeholder="Priya Sharma" required />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-bold uppercase tracking-wider text-text-muted">Phone Number *</label>
          <input name="phone" type="tel" className="form-control-custom" placeholder="+91..." required />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-bold uppercase tracking-wider text-text-muted">Guardian Email *</label>
          <input name="email" type="email" className="form-control-custom" placeholder="guardian@email.in" required />
        </div>
        <div className="md:col-span-2 space-y-1.5">
          <label className="text-xs font-bold uppercase tracking-wider text-text-muted">Residential Address</label>
          <input name="address" type="text" className="form-control-custom" placeholder="Sector 17, Vashi..." />
        </div>
        
        <div className="space-y-1.5">
          <label className="text-xs font-bold uppercase tracking-wider text-text-muted">State *</label>
          <input name="state" type="text" className="form-control-custom" placeholder="Maharashtra" required />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-bold uppercase tracking-wider text-text-muted">City *</label>
          <input name="city" type="text" className="form-control-custom" placeholder="Mumbai" required />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-bold uppercase tracking-wider text-text-muted">Area / Locality *</label>
          <input name="locality" type="text" className="form-control-custom" placeholder="Bandra West" required />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-bold uppercase tracking-wider text-text-muted">Assigned Hospital *</label>
          <input name="hospital" type="text" className="form-control-custom" placeholder="Apollo Hospital" required defaultValue={currentUser.fullname.includes('Hospital') ? currentUser.fullname : 'City Life Hospital'} />
        </div>
        <div className="md:col-span-2 space-y-1.5">
          <div className="p-4 bg-primary-light rounded-xl border border-primary/10">
            <label className="text-xs font-bold uppercase tracking-wider text-primary block mb-2">Set Parent Dashboard Password *</label>
            <input name="parentPassword" type="text" className="form-control-custom bg-white" placeholder="Password for parent login" required defaultValue={Math.random().toString(36).slice(-6)} />
            <p className="text-[10px] text-primary/70 mt-2 italic">Parents will use their email and this password to log in.</p>
          </div>
        </div>
        
        <div className="md:col-span-2 pt-4">
          <button type="submit" className="btn-primary-custom flex items-center gap-2">
            <UserCheck size={18} /> Complete Registration
          </button>
        </div>
      </form>
    </div>
  );
}

// Helper components that would otherwise make the file too large
function UserCheck(props: any) { return <ClipboardCheck {...props} />; }

// --- RECORDS, SCHEDULE, REMINDERS, ADMIN, REPORTS ---
// (These would continue with same logic: state mapping, tables, modals)

function Records({ db, setDb, currentUser }: any) {
  const [searchTerm, setSearchTerm] = useState('');
  const [viewingChild, setViewingChild] = useState<string | null>(null);
  const [editingChild, setEditingChild] = useState<string | null>(null);

  const filteredChildren = db.children.filter((c: ChildType) => 
    c.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
    c.id.toString().includes(searchTerm)
  );

  const deleteChild = async (id: string) => {
    if (!confirm('Are you sure you want to delete this child record? This cannot be undone.')) return;
    try {
      await deleteDoc(doc(firestore, 'children', id));
      // Records are subcollections or separate docs, we should clean them up too
      const recordsToCleanup = db.vaccinationRecords.filter(r => r.childId === id);
      const batch = writeBatch(firestore);
      recordsToCleanup.forEach(r => {
        batch.delete(doc(firestore, 'all_records', `${id}_${r.vaccineId}`));
      });
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `children/${id}`);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row gap-4 items-center justify-between">
        <div className="relative w-full md:w-96">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" size={18} />
          <input 
            type="text" 
            className="form-control-custom pl-10" 
            placeholder="Search by name or ID..." 
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
      </div>

      <div className="card-custom">
        <div className="overflow-x-auto">
          <table className="w-full table-custom">
            <thead>
              <tr>
                <th>ID</th>
                <th>Child Name</th>
                <th>Age</th>
                <th>Guardian</th>
                <th>Progress</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredChildren.length > 0 ? filteredChildren.map((c: ChildType) => {
                const finished = db.vaccinationRecords.filter((r: any) => r.childId === c.id && r.status === 'completed').length;
                const pct = Math.round((finished / db.vaccines.length) * 100);
                return (
                  <tr key={c.id}>
                    <td className="text-xs text-text-muted font-bold font-mono">#{c.id}</td>
                    <td><span className="font-bold">{c.name}</span></td>
                    <td>{calcAge(c.dob)}</td>
                    <td>{c.guardian}</td>
                    <td>
                      <div className="flex items-center gap-3">
                        <div className="progress-bar"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
                        <span className="text-[10px] font-bold text-text-muted">{pct}%</span>
                      </div>
                    </td>
                    <td className="text-right flex items-center justify-end gap-2 px-4 py-3">
                      <button onClick={() => setViewingChild(c.id.toString())} className="btn-sm-custom bg-primary-light text-primary hover:bg-primary-mid hover:text-white" title="View Record">
                        <Eye size={14} />
                      </button>
                      <button onClick={() => setEditingChild(c.id.toString())} className="btn-sm-custom bg-accent-light text-accent hover:bg-accent hover:text-white" title="Edit Profile">
                        <Edit size={14} />
                      </button>
                      <button onClick={() => deleteChild(c.id.toString())} className="btn-sm-custom bg-red-50 text-red-600 hover:bg-red-600 hover:text-white" title="Delete Record">
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                );
              }) : (
                <tr><td colSpan={6} className="text-center py-10 text-text-muted italic">No records found matching your search</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {viewingChild && (
        <ChildDetailModal 
          childId={viewingChild} 
          db={db} 
          setDb={setDb} 
          currentUser={currentUser} 
          onClose={() => setViewingChild(null)} 
        />
      )}

      {editingChild && (
        <EditChildModal
          child={db.children.find((c: any) => c.id === editingChild)}
          onSave={async (updated: any) => {
            try {
              await updateDoc(doc(firestore, 'children', editingChild), updated);
              setEditingChild(null);
            } catch (err) {
              handleFirestoreError(err, OperationType.UPDATE, `children/${editingChild}`);
            }
          }}
          onClose={() => setEditingChild(null)}
        />
      )}
    </div>
  );
}

function EditChildModal({ child, onSave, onClose }: any) {
  const [formData, setFormData] = useState({ ...child });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(formData);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} className="bg-white rounded-3xl p-8 w-full max-w-2xl shadow-2xl space-y-6">
        <div className="flex items-center justify-between">
          <h4 className="text-xl font-display font-bold">Edit Child Profile</h4>
          <button onClick={onClose}><X size={20}/></button>
        </div>
        <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Full Name</label>
            <input className="form-control-custom" value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} required />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider">DOB</label>
            <input type="date" className="form-control-custom" value={formData.dob} onChange={e => setFormData({ ...formData, dob: e.target.value })} required />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Gender</label>
            <select className="form-control-custom" value={formData.gender} onChange={e => setFormData({ ...formData, gender: e.target.value })} required>
              <option>Male</option><option>Female</option><option>Other</option>
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Guardian</label>
            <input className="form-control-custom" value={formData.guardian} onChange={e => setFormData({ ...formData, guardian: e.target.value })} required />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Phone</label>
            <input className="form-control-custom" value={formData.phone} onChange={e => setFormData({ ...formData, phone: e.target.value })} required />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Email</label>
            <input type="email" className="form-control-custom" value={formData.email} onChange={e => setFormData({ ...formData, email: e.target.value })} required />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Area / Locality</label>
            <input className="form-control-custom" value={formData.locality} onChange={e => setFormData({ ...formData, locality: e.target.value })} />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider">City</label>
            <input className="form-control-custom" value={formData.city} onChange={e => setFormData({ ...formData, city: e.target.value })} />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider">State</label>
            <input className="form-control-custom" value={formData.state} onChange={e => setFormData({ ...formData, state: e.target.value })} />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Hospital</label>
            <input className="form-control-custom" value={formData.hospital} onChange={e => setFormData({ ...formData, hospital: e.target.value })} />
          </div>
          <div className="col-span-2 space-y-1">
            <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Address</label>
            <input className="form-control-custom" value={formData.address} onChange={e => setFormData({ ...formData, address: e.target.value })} />
          </div>
          <div className="col-span-2 space-y-1">
            <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Dashboard Password</label>
            <input className="form-control-custom" value={formData.parentPassword} onChange={e => setFormData({ ...formData, parentPassword: e.target.value })} />
          </div>
          <div className="col-span-2 pt-4 flex gap-3">
            <button type="submit" className="btn-primary-custom flex-1">Save Changes</button>
            <button type="button" onClick={onClose} className="px-6 rounded-xl border border-border text-sm font-bold">Cancel</button>
          </div>
        </form>
      </motion.div>
    </div>
  );
}

function SearchPage({ db, setDb, currentUser }: any) {
  const [q, setQ] = useState('');
  const [genderFilter, setGenderFilter] = useState('');
  const [viewingChild, setViewingChild] = useState<string | null>(null);

  const results = q || genderFilter ? db.children.filter((c: any) => {
    const matchesQuery = c.name.toLowerCase().includes(q.toLowerCase()) || c.id.toString().includes(q);
    const matchesGender = genderFilter ? c.gender === genderFilter : true;
    return matchesQuery && matchesGender;
  }) : [];

  return (
    <div className="space-y-6">
      <div className="card-custom p-6">
        <div className="grid md:grid-cols-12 gap-4 items-end">
          <div className="md:col-span-6">
            <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-2 block">Search by Name or ID</label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" size={18} />
              <input 
                type="text" className="form-control-custom pl-10" placeholder="Type child name or ID..." 
                value={q} onChange={e => setQ(e.target.value)}
              />
            </div>
          </div>
          <div className="md:col-span-4">
            <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-2 block">Gender Filter</label>
            <select className="form-control-custom" value={genderFilter} onChange={e => setGenderFilter(e.target.value)}>
              <option value="">All Genders</option>
              <option>Male</option><option>Female</option><option>Other</option>
            </select>
          </div>
          <div className="md:col-span-2">
            <button className="btn-primary-custom w-full">Search</button>
          </div>
        </div>
      </div>

      <div className="card-custom">
        <div className="p-4 border-b border-border bg-body-bg/50">
          <h5 className="font-bold text-sm">Search Results ({results.length})</h5>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full table-custom">
            <thead>
              <tr>
                <th>ID</th><th>Name</th><th>DOB</th><th>Gender</th><th>Guardian</th><th>Phone</th><th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {results.length > 0 ? results.map((c: any) => (
                <tr key={c.id}>
                  <td className="font-mono text-xs text-text-muted font-bold">#{c.id}</td>
                  <td className="font-bold">{c.name}</td>
                  <td>{formatDate(c.dob)}</td>
                  <td>{c.gender}</td>
                  <td>{c.guardian}</td>
                  <td>{c.phone}</td>
                  <td className="text-right">
                    <button onClick={() => setViewingChild(c.id.toString())} className="px-3 py-1.5 bg-primary-light text-primary rounded-lg hover:bg-primary hover:text-white transition-all">
                      <Eye size={14}/>
                    </button>
                  </td>
                </tr>
              )) : (
                <tr><td colSpan={7} className="text-center py-12 text-text-muted italic">Enter matching criteria to see results</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {viewingChild && (
        <ChildDetailModal 
          childId={viewingChild} 
          db={db} 
          setDb={setDb} 
          currentUser={currentUser} 
          onClose={() => setViewingChild(null)} 
        />
      )}
    </div>
  );
}

function ChildDetailModal({ childId, db, setDb, currentUser, onClose }: any) {
  const child = db.children.find((c: any) => c.id === childId);
  const [recordingVaccine, setRecordingVaccine] = useState<string | null>(null);

  if (!child) return null;

  const finishedCount = db.vaccinationRecords.filter((r: any) => r.childId === childId && r.status === 'completed').length;
  const pct = Math.round((finishedCount / db.vaccines.length) * 100);

  const toggleVaccine = async (vId: string) => {
    const existing = db.vaccinationRecords.find((r: any) => r.childId === childId && r.vaccineId === vId);
    if (existing) {
      if (!confirm('Undo status for this vaccine?')) return;
      try {
        await deleteDoc(doc(firestore, 'all_records', `${childId}_${vId}`));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, `all_records/${childId}_${vId}`);
      }
    } else {
      setRecordingVaccine(vId);
    }
  };

  const saveVaccine = async (vId: string, data: any) => {
    const recordId = `${childId}_${vId}`;
    const newRecord: VaccinationRecord = {
      childId,
      vaccineId: vId,
      status: 'completed',
      date: data.date,
      batchNo: data.batch,
      administeredBy: data.by,
      notes: data.notes,
      updatedBy: currentUser.username,
      updatedAt: new Date().toISOString(),
    };
    try {
      await setDoc(doc(firestore, 'all_records', recordId), newRecord);
      setRecordingVaccine(null);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `all_records/${recordId}`);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <motion.div 
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="bg-white rounded-3xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl"
      >
        <div className="p-6 border-b border-border flex items-center justify-between bg-primary-light/30">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-primary rounded-2xl flex items-center justify-center text-white font-display text-xl">
              {child.name.charAt(0)}
            </div>
            <div>
              <h4 className="text-xl font-display font-bold">{child.name}</h4>
              <p className="text-xs text-text-muted">Record #{child.id} • Registered {formatDate(child.registeredAt)}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-white rounded-full transition-colors"><X size={20}/></button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-6 p-6 bg-body-bg rounded-2xl border border-border">
            <DetailItem label="DOB" value={formatDate(child.dob)} />
            <DetailItem label="Age" value={calcAge(child.dob)} />
            <DetailItem label="Gender" value={child.gender} />
            <DetailItem label="Guardian" value={child.guardian} />
            <DetailItem label="Phone" value={child.phone} />
            <DetailItem label="Hospital" value={child.hospital || '—'} />
            <DetailItem label="Locality" value={child.locality || '—'} />
            <DetailItem label="City" value={child.city || '—'} />
            <DetailItem label="State" value={child.state || '—'} />
            <DetailItem label="Address" value={child.address || '—'} />
            <DetailItem label="Dashboard PIN" value={child.parentPassword || '—'} />
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h5 className="font-bold flex items-center gap-2">Vaccines <span className="text-xs font-medium text-text-muted">({finishedCount}/{db.vaccines.length})</span></h5>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold text-primary">{pct}% Complete</span>
                <div className="progress-bar w-32"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
              </div>
            </div>

            <div className="space-y-2 pb-6">
              {db.vaccines.map((v: Vaccine) => {
                const rec = db.vaccinationRecords.find((r: any) => r.childId === childId && r.vaccineId === v.id);
                const isDone = rec?.status === 'completed';
                const dueDate = addWeeks(new Date(child.dob), v.ageWeeks);
                const isDue = new Date() >= dueDate;

                return (
                  <div key={v.id} className="flex items-center justify-between p-4 rounded-2xl bg-white border border-border shadow-xs hover:border-primary-mid transition-all">
                    <div className="flex-1 min-w-0 pr-4">
                      <div className="text-sm font-bold truncate">{v.name}</div>
                      <div className="flex items-center gap-2 mt-0.5">
                        {isDone ? (
                          <div className="badge-custom bg-green-50 text-green-700"><CheckCircle size={10} /> Given {formatDate(rec.date)}</div>
                        ) : isDue ? (
                          <div className="badge-custom bg-danger-light text-danger"><AlertTriangle size={10} /> Overdue {formatDate(dueDate)}</div>
                        ) : (
                          <div className="badge-custom bg-accent-light text-accent text-[9px]"><Clock size={10} /> Due {formatDate(dueDate)}</div>
                        )}
                      </div>
                    </div>
                    <button 
                      onClick={() => toggleVaccine(v.id.toString())}
                      className={cn(
                        "btn-sm-custom shrink-0",
                        isDone ? "bg-red-50 text-red-600 hover:bg-red-600 hover:text-white" : "bg-primary-light text-primary hover:bg-primary hover:text-white"
                      )}
                    >
                      {isDone ? <Trash2 size={14}/> : <Syringe size={14}/>} {isDone ? 'Remove' : 'Record'}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </motion.div>

      {/* Vaccine Record Inner Modal */}
      {recordingVaccine && (
        <VaccineRecordModal 
          vaccine={db.vaccines.find((v:any) => v.id === recordingVaccine)!} 
          childName={child.name}
          onSave={(data: any) => saveVaccine(recordingVaccine, data)}
          onClose={() => setRecordingVaccine(null)}
        />
      )}
    </div>
  );
}

function VaccineRecordModal({ vaccine, childName, onSave, onClose }: any) {
  const [formData, setFormData] = useState({
    date: new Date().toISOString().split('T')[0],
    batch: '',
    by: '',
    notes: ''
  });

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs">
      <motion.div 
        initial={{ scale: 0.95 }}
        animate={{ scale: 1 }}
        className="bg-white rounded-[24px] p-8 w-full max-w-md shadow-2xl space-y-6"
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-primary-light rounded-xl flex items-center justify-center text-primary"><Syringe size={20}/></div>
          <div>
            <h4 className="text-lg font-bold">Record {vaccine.name}</h4>
            <p className="text-xs text-text-muted leading-none mt-0.5">Administering to {childName}</p>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1 block">Date Administered</label>
            <input 
              type="date" 
              className="form-control-custom" 
              value={formData.date}
              onChange={e => setFormData({...formData, date: e.target.value})}
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1 block">Batch No.</label>
              <input 
                type="text" 
                className="form-control-custom" 
                placeholder="BTC-101"
                value={formData.batch}
                onChange={e => setFormData({...formData, batch: e.target.value})}
              />
            </div>
            <div>
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1 block">Staff Name</label>
              <input 
                type="text" 
                className="form-control-custom" 
                placeholder="Nurse Name"
                value={formData.by}
                onChange={e => setFormData({...formData, by: e.target.value})}
              />
            </div>
          </div>
          <div>
            <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1 block">Remarks</label>
            <textarea 
              className="form-control-custom min-h-[80px]" 
              placeholder="Any side effects or notes..." 
              value={formData.notes}
              onChange={e => setFormData({...formData, notes: e.target.value})}
            />
          </div>
        </div>

        <div className="flex gap-3 pt-2">
          <button onClick={() => onSave(formData)} className="btn-primary-custom flex-1 flex items-center justify-center gap-2">
            <Save size={16}/> Save Record
          </button>
          <button onClick={onClose} className="px-6 rounded-xl border border-border text-sm font-bold hover:bg-body-bg transition-colors">
            Cancel
          </button>
        </div>
      </motion.div>
    </div>
  );
}

function Schedule({ vaccines }: { vaccines: Vaccine[] }) {
  return (
    <div className="card-custom">
      <div className="p-6 border-b border-border flex items-center justify-between">
        <h4 className="text-xl font-display font-bold">National Immunization Schedule</h4>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full table-custom">
          <thead>
            <tr>
              <th>Age Given</th>
              <th>Vaccine Name</th>
              <th>Doses</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {vaccines.map((v) => (
              <tr key={v.id}>
                <td>
                  <span className="inline-block px-3 py-1 bg-primary-light text-primary text-[10px] font-bold rounded-lg uppercase tracking-wide">
                    {v.ageWeeks === 0 ? "At Birth" : v.ageWeeks < 4 ? `${v.ageWeeks} Weeks` : `${Math.floor(v.ageWeeks/4)} Months`}
                  </span>
                </td>
                <td className="font-bold text-sm">{v.name}</td>
                <td><span className="font-medium text-xs bg-info-light text-info px-2 py-0.5 rounded-md">{v.doses} Dose(s)</span></td>
                <td className="text-xs text-text-muted font-medium">{v.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Reminders({ db, setDb, currentUser }: any) {
  const [ejsConfig, setEjsConfig] = useState<EmailJSConfig>(() => {
    const saved = localStorage.getItem('vaccitrack_ejs');
    return saved ? JSON.parse(saved) : { publicKey: '', serviceId: '', templateId: '' };
  });

  const [isSendingBulk, setIsSendingBulk] = useState(false);
  const [testStatus, setTestStatus] = useState('');

  const saveEjs = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const config = {
      publicKey: data.get('pk') as string,
      serviceId: data.get('sid') as string,
      templateId: data.get('tid') as string,
    };
    setEjsConfig(config);
    localStorage.setItem('vaccitrack_ejs', JSON.stringify(config));
    emailjs.init(config.publicKey);
    alert('EmailJS Configuration Saved!');
  };

  const upcomingReminders = useMemo(() => {
    const list: any[] = [];
    const now = new Date();
    const next7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    db.children.forEach((c: ChildType) => {
      db.vaccines.forEach((v: Vaccine) => {
        const rec = db.vaccinationRecords.find((r: any) => r.childId.toString() === c.id.toString() && r.vaccineId.toString() === v.id.toString());
        if (rec?.status === 'completed') return;
        const dueDate = addWeeks(new Date(c.dob), v.ageWeeks);
        if (dueDate <= next7Days) {
          list.push({ child: c, vaccine: v, dueDate });
        }
      });
    });
    return list;
  }, [db]);

  const sendReminder = async (item: any) => {
    if (!ejsConfig.publicKey) return alert('Configure EmailJS first!');
    
    // Determine reminder type based on date
    const now = new Date();
    const diff = differenceInDays(item.dueDate, now);
    let message = `This is a reminder that your child ${item.child.name} is due for the ${item.vaccine.name} vaccination on ${formatDate(item.dueDate)}.`;
    
    if (diff === 7) message = `Notification: 7 days until ${item.child.name}'s scheduled ${item.vaccine.name} dose.`;
    if (diff === 1) message = `Final Reminder: Tomorrow is the due date for ${item.child.name}'s ${item.vaccine.name} dose.`;
    if (diff === 0) message = `Action Required: Today is the vaccination day for ${item.child.name} (${item.vaccine.name}).`;
    if (diff < 0) message = `Urgent ALERT: ${item.child.name} has MISSED the ${item.vaccine.name} dose that was due on ${formatDate(item.dueDate)}. Please visit the hospital immediately.`;

    try {
      await emailjs.send(ejsConfig.serviceId, ejsConfig.templateId, {
        to_email: item.child.email,
        guardian_name: item.child.guardian,
        child_name: item.child.name,
        vaccine_name: item.vaccine.name,
        due_date: formatDate(item.dueDate),
        hospital_name: item.child.hospital || 'VacciTrack Health Center',
        reminder_message: message,
        contact_info: item.child.phone || 'Contact your nearest hospital',
        support_email: 'support@vaccitrack.org'
      });

      const entry: ReminderLog = {
        childId: item.child.id,
        vaccineId: item.vaccine.id,
        email: item.child.email,
        status: 'sent',
        sentAt: new Date().toISOString(),
        sentBy: currentUser.fullname
      };

      await addDoc(collection(firestore, 'reminders'), entry);
      return true;
    } catch (err: any) {
      console.error(err);
      return false;
    }
  };

  const sendAll = async () => {
    if (upcomingReminders.length === 0) return alert('No reminders due!');
    if (!confirm(`Send ${upcomingReminders.length} reminders?`)) return;
    
    setIsSendingBulk(true);
    let successCount = 0;
    for (const item of upcomingReminders) {
      const ok = await sendReminder(item);
      if (ok) successCount++;
      await new Promise(r => setTimeout(r, 500)); // Respect rate limits
    }
    setIsSendingBulk(false);
    alert(`Finished! ${successCount} sent successfully.`);
  };

  return (
    <div className="space-y-6">
      <div className="card-custom">
        <div className="p-6 border-b border-border flex items-center justify-between">
          <h4 className="text-xl font-display font-bold">Email Notifications Setup</h4>
          <div className={cn(
            "badge-custom",
            ejsConfig.publicKey ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-500"
          )}>
            {ejsConfig.publicKey ? <CheckCircle size={10} /> : <Info size={10} />}
            {ejsConfig.publicKey ? 'Configured' : 'Not Setup'}
          </div>
        </div>
        <form onSubmit={saveEjs} className="p-6">
          <div className="grid md:grid-cols-3 gap-6">
            <div>
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1 block">EmailJS Public Key</label>
              <input name="pk" type="text" className="form-control-custom" defaultValue={ejsConfig.publicKey} placeholder="user_xxxxxxx" required />
            </div>
            <div>
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1 block">Service ID</label>
              <input name="sid" type="text" className="form-control-custom" defaultValue={ejsConfig.serviceId} placeholder="service_xxxxxxx" required />
            </div>
            <div>
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1 block">Template ID</label>
              <input name="tid" type="text" className="form-control-custom" defaultValue={ejsConfig.templateId} placeholder="template_xxxxxxx" required />
            </div>
          </div>
          <div className="mt-6 flex items-center gap-4">
            <button type="submit" className="btn-primary-custom flex items-center gap-2">
              <Save size={16} /> Save Credentials
            </button>
            <p className="text-xs text-text-muted font-medium italic">Create an account at emailjs.com to get these values.</p>
          </div>
        </form>
      </div>

      <div className="card-custom">
        <div className="p-6 border-b border-border flex items-center justify-between">
          <h4 className="text-xl font-display font-bold">Due Reminders (7-Day Outlook)</h4>
          <button 
            disabled={isSendingBulk || !ejsConfig.publicKey} 
            onClick={sendAll}
            className="btn-primary-custom flex items-center gap-2"
          >
            {isSendingBulk ? <RefreshCw className="animate-spin" size={16}/> : <Send size={16}/>}
            {isSendingBulk ? 'Sending...' : 'Send All Due'}
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full table-custom">
            <thead>
              <tr>
                <th>Child</th>
                <th>Guardian Email</th>
                <th>Vaccine</th>
                <th>Due Date</th>
                <th className="text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {upcomingReminders.length > 0 ? upcomingReminders.map((u, idx) => (
                <tr key={idx}>
                  <td><div className="font-bold">{u.child.name}</div><div className="text-[10px] text-text-muted">ID: #{u.child.id}</div></td>
                  <td className="text-xs font-mono text-primary">{u.child.email}</td>
                  <td><span className="font-bold">{u.vaccine.name}</span></td>
                  <td>{formatDate(u.dueDate)}</td>
                  <td className="text-right">
                    <button 
                      onClick={() => sendReminder(u)}
                      className="btn-sm-custom bg-accent-light text-accent hover:bg-accent hover:text-white"
                      disabled={!ejsConfig.publicKey}
                    >
                      <Send size={14} /> Send Alert
                    </button>
                  </td>
                </tr>
              )) : (
                <tr><td colSpan={5} className="text-center py-10 text-text-muted italic">No reminders due in the next 7 days</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card-custom">
        <div className="p-6 border-b border-border">
          <h4 className="text-xl font-display font-bold">Reminder History</h4>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full table-custom">
            <thead>
              <tr>
                <th>Time Sent</th>
                <th>Recipient</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {db.reminderLog.length > 0 ? db.reminderLog.map((log: any, idx: number) => (
                <tr key={idx}>
                  <td className="text-xs font-medium">{new Date(log.sentAt).toLocaleString()}</td>
                  <td className="text-xs">{log.email}</td>
                  <td>
                    <span className={cn(
                      "badge-custom",
                      log.status === 'sent' ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
                    )}>
                      {log.status === 'sent' ? 'Success' : 'Failed'}
                    </span>
                  </td>
                </tr>
              )) : (
                <tr><td colSpan={3} className="text-center py-6 text-text-muted italic">No logs found</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function AdminUsers({ db, setDb }: any) {
  const [adding, setAdding] = useState(false);

  const toggleStatus = async (id: string, current: boolean) => {
    // Prevent disabling self or master admin (based on email)
    if (id === auth.currentUser?.uid) return;
    try {
      await updateDoc(doc(firestore, 'users', id), { active: !current });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `users/${id}`);
    }
  };

  const handleCreateUser = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const username = data.get('username') as string;
    
    // Note: Creating a user here only creates the record, 
    // real auth is handled by Google login in this refined setup.
    // In a full app, we might use Firebase Admin SDK via an API route.
    const newUser: Partial<User> = {
      username,
      fullname: data.get('fullname') as string,
      role: data.get('role') as UserRole,
      active: true,
      password: '' // Explicitly add password property to satisfy Partial<User> requirements if needed, or just cast
    };
    
    try {
      // Create user record using username (email) as temporary reference or unique key
      // Real auth happens when they sign in with Google
      const tempId = username.toLowerCase().replace(/[@.]/g, '_');
      await setDoc(doc(firestore, 'users', tempId), { ...newUser, id: tempId, email: username } as User);
      setAdding(false);
    } catch (err) {
       handleFirestoreError(err, OperationType.WRITE, 'users');
    }
  };

  return (
    <div className="card-custom">
      <div className="p-6 border-b border-border flex items-center justify-between">
        <h4 className="text-xl font-display font-bold text-text-main">System Users</h4>
        <button onClick={() => setAdding(true)} className="btn-primary-custom flex items-center gap-2">
          <Plus size={18} /> New Account
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full table-custom">
          <thead>
            <tr>
              <th>Username</th>
              <th>Full Name</th>
              <th>Role</th>
              <th>Status</th>
              <th className="text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {db.users.map((u: User) => (
              <tr key={u.id}>
                <td className="font-mono text-xs font-bold bg-body-bg px-2 py-0.5 rounded-md inline-block mt-3">{u.username}</td>
                <td className="font-bold">{u.fullname}</td>
                <td><span className="capitalize text-xs font-medium">{u.role}</span></td>
                <td>
                  <span className={cn(
                    "badge-custom",
                    u.active ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
                  )}>
                    {u.active ? 'Active' : 'Disabled'}
                  </span>
                </td>
                <td className="text-right">
                  {u.id !== auth.currentUser?.uid && u.id !== '1' && (
                    <button 
                      onClick={() => toggleStatus(u.id.toString(), u.active)}
                      className={cn(
                        "btn-sm-custom", 
                        u.active ? "bg-red-50 text-red-600 hover:bg-red-600 hover:text-white" : "bg-green-50 text-green-600 hover:bg-green-600 hover:text-white"
                      )}
                    >
                      {u.active ? "Disable" : "Enable"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {adding && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} className="bg-white rounded-3xl p-8 w-full max-w-md shadow-2xl space-y-6">
            <h4 className="text-xl font-display font-bold">Add System User</h4>
            <form onSubmit={handleCreateUser} className="space-y-4">
              <div>
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1 block">Username</label>
                <input name="username" className="form-control-custom" placeholder="username" required />
              </div>
              <div>
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1 block">Full Name</label>
                <input name="fullname" className="form-control-custom" placeholder="Full Name" required />
              </div>
              <div>
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1 block">Password</label>
                <input name="password" type="password" className="form-control-custom" required />
              </div>
              <div>
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1 block">Role</label>
                <select name="role" className="form-control-custom" required>
                  <option value={UserRole.ADMIN}>Admin</option>
                  <option value={UserRole.WORKER}>Healthcare Worker</option>
                </select>
              </div>
              <div className="pt-4 flex gap-3">
                <button type="submit" className="btn-primary-custom flex-1">Create Account</button>
                <button type="button" onClick={() => setAdding(false)} className="px-6 rounded-xl border border-border text-sm font-bold">Cancel</button>
              </div>
            </form>
          </motion.div>
        </div>
      )}
    </div>
  );
}

function AdminVaccines({ db, setDb }: any) {
  const [adding, setAdding] = useState(false);

  const handleCreateVaccine = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const name = data.get('name') as string;
    const newId = name.toLowerCase().replace(/\s+/g, '_');
    const newVaccine: Vaccine = {
      id: newId,
      name,
      ageWeeks: parseInt(data.get('age') as string),
      doses: parseInt(data.get('doses') as string),
      desc: data.get('desc') as string,
    };
    
    try {
      await setDoc(doc(firestore, 'vaccines', newId), newVaccine);
      setAdding(false);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `vaccines/${newId}`);
    }
  };

  const deleteVaccine = async (id: string) => {
    if (!confirm('Delete this vaccine? This may break historical records.')) return;
    try {
      await deleteDoc(doc(firestore, 'vaccines', id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `vaccines/${id}`);
    }
  };

  return (
    <div className="card-custom">
      <div className="p-6 border-b border-border flex items-center justify-between">
        <h4 className="text-xl font-display font-bold text-text-main">Vaccine Definitions</h4>
        <button onClick={() => setAdding(true)} className="btn-primary-custom flex items-center gap-2">
          <Plus size={18} /> Add Vaccine
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full table-custom">
          <thead>
            <tr>
              <th>Vaccine Name</th><th>Age Given</th><th>Doses</th><th>Description</th><th className="text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {db.vaccines.map((v: Vaccine) => (
              <tr key={v.id}>
                <td className="font-bold">{v.name}</td>
                <td>{v.ageWeeks === 0 ? 'Birth' : v.ageWeeks + 'wks'}</td>
                <td>{v.doses}</td>
                <td className="text-xs text-text-muted">{v.desc}</td>
                <td className="text-right">
                  <button onClick={() => deleteVaccine(v.id.toString())} className="btn-sm-custom bg-red-50 text-red-600 hover:bg-red-600 hover:text-white">
                    <Trash2 size={14}/>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {adding && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} className="bg-white rounded-3xl p-8 w-full max-w-md shadow-2xl space-y-6">
            <h4 className="text-xl font-display font-bold">Add New Vaccine</h4>
            <form onSubmit={handleCreateVaccine} className="space-y-4">
              <div>
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1 block">Vaccine Name</label>
                <input name="name" className="form-control-custom" placeholder="Rotavirus" required />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1 block">Age (Weeks)</label>
                  <input name="age" type="number" className="form-control-custom" placeholder="0" required />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1 block">Doses</label>
                  <input name="doses" type="number" className="form-control-custom" defaultValue="1" min="1" required />
                </div>
              </div>
              <div>
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1 block">Description</label>
                <input name="desc" className="form-control-custom" placeholder="Purpose of vaccine" required />
              </div>
              <div className="pt-4 flex gap-3">
                <button type="submit" className="btn-primary-custom flex-1">Add to List</button>
                <button type="button" onClick={() => setAdding(false)} className="px-6 rounded-xl border border-border text-sm font-bold">Cancel</button>
              </div>
            </form>
          </motion.div>
        </div>
      )}
    </div>
  );
}

function Reports({ db }: { db: any }) {
  const totalChildren = db.children.length;
  const coverageData = useMemo(() => {
    return db.vaccines.map((v: Vaccine) => {
      const count = db.vaccinationRecords.filter((r: any) => r.vaccineId === v.id && r.status === 'completed').length;
      const pct = totalChildren > 0 ? Math.round((count / totalChildren) * 100) : 0;
      return { name: v.name, count, pct };
    });
  }, [db]);

  const genderData = useMemo(() => {
    const males = db.children.filter((c: any) => c.gender === 'Male').length;
    const females = db.children.filter((c: any) => c.gender === 'Female').length;
    return { 
      males: { count: males, pct: totalChildren > 0 ? Math.round((males/totalChildren)*100) : 0 },
      females: { count: females, pct: totalChildren > 0 ? Math.round((females/totalChildren)*100) : 0 }
    };
  }, [db]);

  return (
    <div className="space-y-6">
      <div className="grid lg:grid-cols-2 gap-6">
        <div className="card-custom p-6">
          <h5 className="font-bold text-text-main mb-6 flex items-center gap-2"><BarChart3 size={18} className="text-primary" /> Vaccine Coverage (N={totalChildren})</h5>
          <div className="space-y-6">
            {coverageData.map((d: any, idx: number) => (
              <div key={idx}>
                <div className="flex items-center justify-between text-xs font-bold mb-2">
                  <span>{d.name}</span>
                  <span className="text-text-muted">{d.count} Dose(s) ({d.pct}%)</span>
                </div>
                <div className="h-4 bg-body-bg rounded-full overflow-hidden border border-border/50 shadow-inner">
                  <motion.div 
                    initial={{ width: 0 }}
                    animate={{ width: `${d.pct}%` }}
                    transition={{ delay: idx * 0.1, duration: 1 }}
                    className="h-full bg-primary-mid rounded-full"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card-custom p-6">
          <h5 className="font-bold text-text-main mb-6 flex items-center gap-2"><Users size={18} className="text-primary" /> Demographic Split</h5>
          <div className="flex flex-col h-full justify-center space-y-12 pb-12">
            <div>
              <div className="flex items-center justify-between text-xs font-bold mb-3">
                <span className="flex items-center gap-2"><Mars size={14} className="text-blue-500" /> Male Children</span>
                <span className="text-text-muted">{genderData.males.count} ({genderData.males.pct}%)</span>
              </div>
              <div className="h-6 bg-body-bg rounded-full overflow-hidden border border-border/50">
                <motion.div 
                  initial={{ width: 0 }}
                  animate={{ width: `${genderData.males.pct}%` }}
                  className="h-full bg-blue-500 rounded-full"
                />
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between text-xs font-bold mb-3">
                <span className="flex items-center gap-2"><Venus size={14} className="text-pink-500" /> Female Children</span>
                <span className="text-text-muted">{genderData.females.count} ({genderData.females.pct}%)</span>
              </div>
              <div className="h-6 bg-body-bg rounded-full overflow-hidden border border-border/50">
                <motion.div 
                  initial={{ width: 0 }}
                  animate={{ width: `${genderData.females.pct}%` }}
                  className="h-full bg-pink-500 rounded-full"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- PARENT PORTAL COMPONENTS ---

function ParentDashboard({ db, currentUser, setActivePage }: { db: any, currentUser: User, setActivePage: (p: string) => void }) {
  const childId = currentUser.id.toString().split('-')[1];
  const child = db.children.find((c: any) => (c.id === childId || c.id.toString() === childId));

  if (!child && db.children.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-text-muted">
        <RefreshCw size={40} className="animate-spin mb-4 opacity-20" />
        <p className="font-medium">Syncing child profile...</p>
      </div>
    );
  }

  if (!child) return <div className="card-custom p-12 text-center text-text-muted italic">Child profile not found (# {childId}). Please contact your hospital.</div>;

  const records = db.vaccinationRecords.filter((r: any) => r.childId === childId || r.childId.toString() === childId);
  const vaccines = db.vaccines;

  const stats = useMemo(() => {
    const completed = records.filter((r: any) => r.status === 'completed').length;
    const pending = vaccines.length - completed;
    const progress = Math.round((completed / vaccines.length) * 100);
    
    const now = new Date();
    const missed = vaccines.filter((v: Vaccine) => {
      const rec = records.find((r: VaccinationRecord) => r.vaccineId === v.id.toString());
      if (rec?.status === 'completed') return false;
      const dueDate = addWeeks(new Date(child.dob), v.ageWeeks);
      return dueDate < now;
    }).length;

    const upcoming = vaccines.filter((v: Vaccine) => {
      const rec = records.find((r: VaccinationRecord) => r.vaccineId === v.id.toString());
      if (rec?.status === 'completed') return false;
      const dueDate = addWeeks(new Date(child.dob), v.ageWeeks);
      return dueDate >= now && dueDate <= new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    }).length;

    return { completed, pending, progress, missed, upcoming };
  }, [records, vaccines, child.dob]);

  return (
    <div className="space-y-6">
      {/* Welcome Card */}
      <div className="bg-linear-to-r from-primary to-primary-mid rounded-3xl p-8 text-white shadow-xl shadow-primary/20 relative overflow-hidden">
        <div className="relative z-10">
          <h2 className="text-3xl font-display font-bold">Hello, {child.guardian}!</h2>
          <p className="opacity-90 max-w-md mt-2">Track {child.name}'s vaccination journey and ensure a healthy future. Everything looks good so far!</p>
          <div className="mt-8 flex items-center gap-6">
             <div className="flex flex-col">
               <span className="text-3xl font-display font-bold">{stats.progress}%</span>
               <span className="text-[10px] uppercase font-bold tracking-widest opacity-70">Total Progress</span>
             </div>
             <div className="flex-1 max-w-[240px] h-3 bg-white/20 rounded-full overflow-hidden">
               <motion.div initial={{ width: 0 }} animate={{ width: `${stats.progress}%` }} className="h-full bg-white rounded-full" />
             </div>
          </div>
        </div>
        <Syringe className="absolute -right-8 -bottom-8 opacity-10 rotate-12" size={240} />
      </div>

      {/* Grid Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={<CheckCircle className="text-green-600" />} value={stats.completed} label="Completed" bgColor="bg-green-50" />
        <StatCard icon={<Clock className="text-info" />} value={stats.upcoming} label="Next 30 Days" bgColor="bg-info-light" />
        <StatCard icon={<AlertTriangle className="text-danger" />} value={stats.missed} label="Missed / Late" bgColor="bg-danger-light" />
        <StatCard icon={<Baby className="text-accent" />} value={stats.pending} label="Remaining" bgColor="bg-accent-light" />
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <div className="space-y-6">
          <div className="card-custom p-6">
            <h5 className="font-bold flex items-center gap-2 mb-6"><ClipboardCheck size={18} className="text-primary"/> Child Details</h5>
            <div className="grid grid-cols-2 gap-y-6">
              <DetailItem label="Full Name" value={child.name} />
              <DetailItem label="Child ID" value={`#${child.id}`} />
              <DetailItem label="Date of Birth" value={formatDate(child.dob)} />
              <DetailItem label="Gender" value={child.gender} />
              <DetailItem label="Assigned Hospital" value={child.hospital} />
              <DetailItem label="Location" value={`${child.locality}, ${child.city}`} />
            </div>
          </div>

          <div className="card-custom p-6">
            <h5 className="font-bold flex items-center gap-2 mb-6"><Calendar size={18} className="text-info"/> Upcoming Schedule</h5>
            <div className="space-y-3">
              {vaccines.filter((v: Vaccine) => {
                const rec = records.find((r: VaccinationRecord) => r.vaccineId === v.id.toString());
                return !rec || rec.status !== 'completed';
              }).sort((a: Vaccine, b: Vaccine) => a.ageWeeks - b.ageWeeks).slice(0, 3).map((v: Vaccine) => {
                const dueDate = addWeeks(new Date(child.dob), v.ageWeeks);
                const isPast = dueDate < new Date();
                return (
                  <div key={v.id} className={cn(
                    "flex items-center justify-between p-3 rounded-xl border",
                    isPast ? "bg-red-50 border-red-100" : "bg-blue-50 border-blue-100"
                  )}>
                    <div className="flex items-center gap-3">
                      <div className={cn(
                        "w-8 h-8 rounded-full flex items-center justify-center",
                        isPast ? "bg-red-100 text-red-600" : "bg-blue-100 text-info"
                      )}>
                        <Clock size={14} />
                      </div>
                      <div>
                        <div className={cn("text-sm font-bold", isPast ? "text-red-800" : "text-blue-800")}>{v.name}</div>
                        <div className={cn("text-[10px] font-medium uppercase", isPast ? "text-red-600" : "text-blue-600")}>
                          Due: {formatDate(dueDate.toISOString())} {isPast && "(Overdue)"}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
              <button 
                onClick={() => setActivePage('history')} 
                className="w-full py-2 text-xs font-bold text-primary hover:underline"
              >
                View Full Vaccine List
              </button>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="card-custom p-6">
            <h5 className="font-bold flex items-center gap-2 mb-6"><History size={18} className="text-green-600"/> Recently Completed</h5>
            <div className="space-y-3">
              {records.length > 0 ? records.sort((a:any, b:any) => new Date(b.date).getTime() - new Date(a.date).getTime()).slice(0, 3).map((r: any) => {
                const v = vaccines.find((vac: any) => vac.id.toString() === r.vaccineId);
                return (
                  <div key={r.id} className="flex items-center justify-between p-3 rounded-xl bg-green-50 border border-green-100">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center text-green-600">
                        <CheckCircle size={14} />
                      </div>
                      <div>
                        <div className="text-sm font-bold text-green-800">{v?.name || 'Vaccine'}</div>
                        <div className="text-[10px] text-green-600 font-medium">COMPLETED ON {formatDate(r.date)}</div>
                      </div>
                    </div>
                  </div>
                )
              }) : (
                <div className="text-center py-6 text-text-muted italic text-sm">No vaccinations recorded yet.</div>
              )}
              {records.length > 0 && (
                <button onClick={() => setActivePage('history')} className="w-full py-2 text-xs font-bold text-primary hover:underline">View Full History</button>
              )}
            </div>
          </div>
        </div>

        <div className="card-custom p-6">
          <h5 className="font-bold flex items-center gap-2 mb-6"><Calendar size={18} className="text-accent"/> Upcoming Schedule</h5>
          <div className="space-y-3">
            {vaccines.filter((v: any) => {
              const rec = records.find((r: any) => r.vaccineId === v.id);
              return !rec || rec.status !== 'completed';
            }).slice(0, 4).map((v: any) => {
               const dueDate = addWeeks(new Date(child.dob), v.ageWeeks);
               const isOverdue = new Date() > dueDate;
               return (
                 <div key={v.id} className="flex items-center justify-between p-4 rounded-2xl bg-body-bg border border-border/50">
                   <div>
                     <div className="text-sm font-bold">{v.name}</div>
                     <div className={cn("text-[10px] font-bold mt-1 uppercase", isOverdue ? "text-danger" : "text-text-muted")}>
                       {isOverdue ? "MISSING / OVERDUE" : `DUE: ${formatDate(dueDate)}`}
                     </div>
                   </div>
                   <div className={cn("px-2 py-1 rounded-md text-[9px] font-bold", isOverdue ? "bg-danger-light text-danger" : "bg-primary-light text-primary")}>
                     {v.doses} Dose(s)
                   </div>
                 </div>
               )
            })}
            {vaccines.filter((v: any) => !records.find((r: any) => r.vaccineId === v.id)).length === 0 && (
                <div className="text-center py-8 bg-green-50 rounded-2xl border border-green-100 text-green-700 font-bold text-sm">
                   <CheckCircle size={24} className="mx-auto mb-2 opacity-50" />
                   All vaccinations completed!
                </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ParentHistory({ db, currentUser }: any) {
  const childId = currentUser.id.toString().split('-')[1];
  const child = db.children.find((c: any) => c.id === childId || c.id.toString() === childId);
  const records = db.vaccinationRecords.filter((r: any) => r.childId === childId || r.childId.toString() === childId);
  const vaccines = db.vaccines;

  if (!child) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-text-muted">
        <RefreshCw size={32} className="animate-spin mb-4 opacity-20" />
        <p>Loading history...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-xl font-display font-bold">Vaccination History</h4>
          <p className="text-xs text-text-muted">Digital immunization record for {child.name}</p>
        </div>
        <button 
          onClick={() => window.print()}
          className="btn-primary-sm bg-white text-primary border border-primary/20 hover:bg-primary hover:text-white transition-all shadow-md"
        >
           <Save size={16} /> Download Certificate
        </button>
      </div>

      <div className="card-custom">
        <div className="overflow-x-auto">
          <table className="w-full table-custom">
            <thead>
              <tr>
                <th>Vaccine Name</th>
                <th>Doses</th>
                <th>Date Given</th>
                <th>Administered At</th>
                <th className="text-right">Status</th>
              </tr>
            </thead>
            <tbody>
              {db.vaccines.map((v: Vaccine) => {
                const rec = records.find((r: any) => r.vaccineId === v.id.toString());
                const isCompleted = rec?.status === 'completed';
                const dueDate = addWeeks(new Date(child.dob), v.ageWeeks);
                const isMissed = !isCompleted && new Date() > dueDate;

                return (
                  <tr key={v.id} className={cn(isCompleted ? "bg-green-50/20" : isMissed ? "bg-danger-light/20" : "")}>
                    <td><div className="font-bold text-sm">{v.name}</div><div className="text-[10px] text-text-muted">{v.desc}</div></td>
                    <td><span className="text-xs font-bold text-text-muted">{v.doses}</span></td>
                    <td>{isCompleted ? formatDate(rec.date) : "—"}</td>
                    <td>{isCompleted ? (rec.administeredBy || child.hospital) : "—"}</td>
                    <td className="text-right">
                       <span className={cn(
                         "badge-custom",
                         isCompleted ? "bg-green-50 text-green-700" : isMissed ? "bg-danger-light text-danger" : "bg-blue-50 text-blue-700"
                       )}>
                         {isCompleted ? "COMPLETED" : isMissed ? "MISSED" : "UPCOMING"}
                       </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
      
      {/* Hide on screen, show on print */}
      <div className="hidden print:block fixed inset-0 bg-white z-[9999] p-20 text-text-main">
          <div className="text-center mb-12 border-b-2 border-primary pb-8">
              <h1 className="text-4xl font-display font-bold text-primary">IMMUNIZATION CERTIFICATE</h1>
              <p className="text-sm font-semibold tracking-widest mt-2">{child.hospital}</p>
          </div>
          
          <div className="grid grid-cols-2 gap-8 mb-12">
              <DetailItem label="Child Name" value={child.name} />
              <DetailItem label="Child ID" value={`#${child.id}`} />
              <DetailItem label="Date of Birth" value={formatDate(child.dob)} />
              <DetailItem label="Gender" value={child.gender} />
              <DetailItem label="Guardian" value={child.guardian} />
              <DetailItem label="Locality" value={`${child.locality}, ${child.city}, ${child.state}`} />
          </div>

          <table className="w-full border-collapse">
              <thead>
                  <tr className="bg-primary/10 text-xs font-bold">
                      <th className="p-3 text-left border border-border">Vaccine</th>
                      <th className="p-3 text-left border border-border">Date Administered</th>
                      <th className="p-3 text-left border border-border">Batch No.</th>
                      <th className="p-3 text-left border border-border">Signature/Seal</th>
                  </tr>
              </thead>
              <tbody>
                  {db.vaccines.map((v: Vaccine) => {
                      const rec = records.find((r: any) => r.vaccineId === v.id.toString());
                      if (rec?.status !== 'completed') return null;
                      return (
                          <tr key={v.id} className="text-xs">
                              <td className="p-3 border border-border font-bold">{v.name}</td>
                              <td className="p-3 border border-border">{formatDate(rec.date)}</td>
                              <td className="p-3 border border-border">{rec.batchNo || 'N/A'}</td>
                              <td className="p-3 border border-border"></td>
                          </tr>
                      )
                  })}
              </tbody>
          </table>

          <div className="mt-20 flex justify-between">
              <div className="text-center pt-4 border-t border-text-main w-64">
                  <p className="text-xs font-bold">Parent/Guardian Signature</p>
              </div>
              <div className="text-center pt-4 border-t border-text-main w-64">
                  <p className="text-xs font-bold">Medical Officer Seal & Sign</p>
              </div>
          </div>
          <div className="mt-12 text-center text-[10px] text-text-muted italic">
              This is a digitally generated vaccination record from the VacciTrack System. Verification available via Hospital ID.
          </div>
      </div>
    </div>
  )
}
