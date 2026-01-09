import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Branch } from '@/types';

// ============================================
// SAMPLE BRANCHES
// ============================================
const SAMPLE_BRANCHES: Branch[] = [
  {
    id: 'cmk2mcc2r00001d9esaynov48',
    name: 'Sobhana – Madhapur',
    code: 'MPR',
    address: '123 Tech Street, Madhapur, Hyderabad',
    phone: '9876543200',
    isActive: true,
    createdAt: new Date(),
  },
  {
    id: 'cmk2mcc3100011d9epecdj53v',
    name: 'Sobhana – Kukatpally',
    code: 'KPY',
    address: '456 KPHB Road, Kukatpally, Hyderabad',
    phone: '9876543201',
    isActive: true,
    createdAt: new Date(),
  },
];

// ============================================
// BRANCH STORE INTERFACE
// ============================================
interface BranchState {
  branches: Branch[];
  activeBranchId: string | null;
  
  // Getters
  getActiveBranch: () => Branch | undefined;
  getBranchById: (id: string) => Branch | undefined;
  getAllBranches: () => Branch[];
  
  // Setters
  setActiveBranch: (branchId: string) => void;
  
  // CRUD
  addBranch: (branch: Branch) => void;
  updateBranch: (id: string, updates: Partial<Branch>) => void;
}

// ============================================
// BRANCH STORE IMPLEMENTATION
// ============================================
export const useBranchStore = create<BranchState>()(
  persist(
    (set, get) => ({
      branches: SAMPLE_BRANCHES,
      activeBranchId: 'cmjzumgap00003zwljoqlubsn', // Default to Madhapur
      
      getActiveBranch: () => {
        const { branches, activeBranchId } = get();
        return branches.find((b) => b.id === activeBranchId);
      },
      
      getBranchById: (id) => {
        const { branches } = get();
        return branches.find((b) => b.id === id);
      },
      
      getAllBranches: () => {
        const { branches } = get();
        return branches.filter((b) => b.isActive);
      },
      
      setActiveBranch: (branchId) => {
        set({ activeBranchId: branchId });
      },
      
      addBranch: (branch) => {
        set((state) => ({ branches: [...state.branches, branch] }));
      },
      
      updateBranch: (id, updates) => {
        set((state) => ({
          branches: state.branches.map((b) =>
            b.id === id ? { ...b, ...updates } : b
          ),
        }));
      },
    }),
    {
      name: 'branch-storage',
    }
  )
);
