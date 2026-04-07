import { create } from 'zustand';
import { listWorkflows, type Workflow } from '@/lib/workflow-manager';

interface WorkflowState {
  workflows: Workflow[];
  isLoaded: boolean;
  load: () => Promise<void>;
}

export const useWorkflowStore = create<WorkflowState>((set) => ({
  workflows: [],
  isLoaded: false,
  load: async () => {
    const wfs = await listWorkflows();
    set({ workflows: wfs, isLoaded: true });
  },
}));
