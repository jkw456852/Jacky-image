'use client';

import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { readDesktopDocument, writeDesktopDocument } from '@/lib/desktop-app-files';
import { resolveStoredImageRef } from '@/lib/image-downloader';
import { saveBlobToDownloads } from '@/lib/local-download';
import { generateUUID } from '@/lib/uuid';
import { resolveSeatCoverImageBlob } from './image-source';
import type {
  SeatCoverAngleTask,
  SeatCoverCandidate,
  SeatCoverFittingTask,
  SeatCoverGenerationConfig,
  SeatCoverProject,
  SeatCoverProjectStore,
  SeatCoverWorkspaceState,
} from './types';

export const SEAT_COVER_PROJECT_NAMESPACE = 'seat-cover-generation-workspace';

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
    reader.readAsDataURL(blob);
  });
}

export function createInitialWorkspace(config: SeatCoverGenerationConfig): SeatCoverWorkspaceState {
  return {
    version: 1,
    stage: 'angles',
    vehicleModel: '',
    vehicleYear: '',
    vehicleTrim: '',
    extraPrompt: '',
    selectedPresetIds: [],
    vehicleImages: [],
    frontCoverImages: [],
    rearCoverImages: [],
    angleTasks: [],
    fittingTasks: [],
    globalConfig: config,
  };
}

export function normalizeSeatCoverWorkspace(value: unknown, defaultConfig: SeatCoverGenerationConfig): SeatCoverWorkspaceState | null {
  if (!value || typeof value !== 'object' || (value as { version?: number }).version !== 1) return null;
  const base = createInitialWorkspace(defaultConfig);
  const parsed = value as Partial<SeatCoverWorkspaceState>;
  const interruptedMessage = '软件重启后任务状态已中断，请重新生成';
  const normalizeCandidate = (candidate: SeatCoverCandidate): SeatCoverCandidate => ({
    ...candidate,
    status: candidate.status || (candidate.imageRef ? 'completed' : 'pending'),
  });
  const normalizeTask = <T extends SeatCoverAngleTask | SeatCoverFittingTask>(task: T): T => {
    const interrupted = task.status === 'queued' || task.status === 'generating';
    const restartFailed = task.status === 'failed' && (
      task.error?.includes('软件重启后任务状态已中断') || task.error?.includes('服务器重启')
    );
    const normalizedCandidates = Array.isArray(task.candidates) ? task.candidates.map(candidate => {
      const normalized = normalizeCandidate(candidate);
      if ((interrupted || restartFailed) && normalized.status === 'generating') {
        return {
          ...normalized,
          status: 'failed' as const,
          error: normalized.error || interruptedMessage,
        };
      }
      return normalized;
    }) : [];
    return {
      ...task,
      status: interrupted ? 'failed' : task.status,
      error: interrupted ? interruptedMessage : task.error,
      candidates: normalizedCandidates,
    };
  };
  return {
    ...base,
    ...parsed,
    globalConfig: { ...base.globalConfig, ...(parsed.globalConfig || {}) },
    vehicleImages: Array.isArray(parsed.vehicleImages) ? parsed.vehicleImages : [],
    frontCoverImages: Array.isArray(parsed.frontCoverImages) ? parsed.frontCoverImages : [],
    rearCoverImages: Array.isArray(parsed.rearCoverImages) ? parsed.rearCoverImages : [],
    angleTasks: Array.isArray(parsed.angleTasks) ? parsed.angleTasks.map(normalizeTask) : [],
    fittingTasks: Array.isArray(parsed.fittingTasks) ? parsed.fittingTasks.map(normalizeTask) : [],
  };
}

function createProject(name: string, workspace: SeatCoverWorkspaceState): SeatCoverProject {
  const now = Date.now();
  return { id: `seat-project-${generateUUID()}`, name, createdAt: now, updatedAt: now, workspace };
}

function initialStore(config: SeatCoverGenerationConfig): SeatCoverProjectStore {
  const project = createProject('未命名座套项目', createInitialWorkspace(config));
  return { version: 2, activeProjectId: project.id, projects: [project] };
}

function normalizeStore(raw: unknown, config: SeatCoverGenerationConfig): SeatCoverProjectStore {
  if (raw && typeof raw === 'object' && (raw as { version?: number }).version === 2) {
    const parsed = raw as Partial<SeatCoverProjectStore>;
    const projects = (Array.isArray(parsed.projects) ? parsed.projects : []).flatMap(project => {
      const workspace = normalizeSeatCoverWorkspace(project.workspace, config);
      if (!workspace) return [];
      return [{
        ...project,
        id: project.id || `seat-project-${generateUUID()}`,
        name: project.name?.trim() || '未命名座套项目',
        createdAt: Number(project.createdAt) || Date.now(),
        updatedAt: Number(project.updatedAt) || Date.now(),
        workspace,
      }];
    });
    if (projects.length) {
      const activeProjectId = projects.some(project => project.id === parsed.activeProjectId) ? String(parsed.activeProjectId) : projects[0].id;
      return { version: 2, activeProjectId, projects };
    }
  }
  const legacy = normalizeSeatCoverWorkspace(raw, config);
  if (legacy) {
    const inferredName = [legacy.vehicleModel, legacy.vehicleYear].filter(Boolean).join('-') || '已迁移座套项目';
    const project = createProject(inferredName, legacy);
    return { version: 2, activeProjectId: project.id, projects: [project] };
  }
  return initialStore(config);
}

async function restoreWorkspace(workspace: SeatCoverWorkspaceState): Promise<SeatCoverWorkspaceState> {
  const restoreCandidates = async <T extends SeatCoverAngleTask | SeatCoverFittingTask>(task: T): Promise<T> => {
    const candidates = await Promise.all(task.candidates.map(async (candidate, index) => {
      if (!candidate.imageRef || candidate.imageRef.startsWith('data:')) return { ...candidate, imageUrl: candidate.imageRef || candidate.imageUrl };
      const resolved = await resolveStoredImageRef('', candidate.imageRef, index);
      return { ...candidate, imageUrl: resolved.image };
    }));
    return { ...task, candidates };
  };
  const angleTasks = await Promise.all(workspace.angleTasks.map(restoreCandidates));
  const fittingTasks = await Promise.all(workspace.fittingTasks.map(async task => {
    const restored = await restoreCandidates(task);
    if (!task.baseImageRef || task.baseImageRef.startsWith('data:')) return { ...restored, baseImageUrl: task.baseImageRef || task.baseImageUrl };
    const base = await resolveStoredImageRef('', task.baseImageRef, 0);
    return { ...restored, baseImageUrl: base.image || task.baseImageUrl };
  }));
  return { ...workspace, angleTasks, fittingTasks };
}

async function makePortableWorkspace(workspace: SeatCoverWorkspaceState): Promise<SeatCoverWorkspaceState> {
  const portableCandidates = async (candidates: SeatCoverCandidate[]) => Promise.all(candidates.map(async candidate => {
    if (!candidate.imageRef) return { ...candidate, imageUrl: undefined };
    const blob = await resolveSeatCoverImageBlob(candidate.imageRef, candidate.imageUrl);
    const dataUrl = await blobToDataUrl(blob);
    return { ...candidate, imageRef: dataUrl, imageUrl: undefined };
  }));
  const angleTasks = await Promise.all(workspace.angleTasks.map(async task => ({ ...task, candidates: await portableCandidates(task.candidates) })));
  const fittingTasks = await Promise.all(workspace.fittingTasks.map(async task => {
    let baseImageRef = task.baseImageRef;
    if (baseImageRef && !baseImageRef.startsWith('data:')) {
      baseImageRef = await blobToDataUrl(await resolveSeatCoverImageBlob(baseImageRef, task.baseImageUrl));
    }
    return { ...task, baseImageRef, baseImageUrl: undefined, candidates: await portableCandidates(task.candidates) };
  }));
  return { ...workspace, angleTasks, fittingTasks };
}

export interface SeatCoverProjectActions {
  createProject: () => string;
  switchProject: (id: string) => void;
  renameProject: (id: string, name: string) => void;
  duplicateProject: (id: string) => void;
  deleteProject: (id: string) => void;
  exportProject: (id: string) => Promise<void>;
  importProject: (file: File) => Promise<void>;
}

export function useSeatCoverProjects(defaultConfig: SeatCoverGenerationConfig): {
  state: SeatCoverWorkspaceState;
  setState: Dispatch<SetStateAction<SeatCoverWorkspaceState>>;
  hydrated: boolean;
  projects: SeatCoverProject[];
  activeProjectId: string;
  actions: SeatCoverProjectActions;
} {
  const [store, setStore] = useState<SeatCoverProjectStore>(() => initialStore(defaultConfig));
  const [hydrated, setHydrated] = useState(false);
  const activeProject = useMemo(() => store.projects.find(project => project.id === store.activeProjectId) || store.projects[0], [store]);
  const state = activeProject.workspace;

  useEffect(() => {
    let cancelled = false;
    void readDesktopDocument<unknown>(SEAT_COVER_PROJECT_NAMESPACE).then(async raw => {
      const normalized = normalizeStore(raw, defaultConfig);
      const projects = await Promise.all(normalized.projects.map(async project => ({ ...project, workspace: await restoreWorkspace(project.workspace) })));
      if (!cancelled) setStore({ ...normalized, projects });
    }).catch(() => undefined).finally(() => { if (!cancelled) setHydrated(true); });
    return () => { cancelled = true; };
  }, [defaultConfig]);

  useEffect(() => {
    if (!hydrated) return;
    const serializable: SeatCoverProjectStore = {
      ...store,
      projects: store.projects.map(project => ({
        ...project,
        workspace: {
          ...project.workspace,
          angleTasks: project.workspace.angleTasks.map(task => ({ ...task, candidates: task.candidates.map(candidate => ({ ...candidate, imageUrl: undefined })) })),
          fittingTasks: project.workspace.fittingTasks.map(task => ({ ...task, baseImageUrl: undefined, candidates: task.candidates.map(candidate => ({ ...candidate, imageUrl: undefined })) })),
        },
      })),
    };
    const timer = window.setTimeout(() => { void writeDesktopDocument(SEAT_COVER_PROJECT_NAMESPACE, serializable); }, 300);
    return () => window.clearTimeout(timer);
  }, [hydrated, store]);

  const setState = useCallback<Dispatch<SetStateAction<SeatCoverWorkspaceState>>>((action) => {
    setStore(current => ({
      ...current,
      projects: current.projects.map(project => {
        if (project.id !== current.activeProjectId) return project;
        const workspace = typeof action === 'function' ? action(project.workspace) : action;
        return { ...project, updatedAt: Date.now(), workspace };
      }),
    }));
  }, []);

  const createProjectAction = useCallback(() => {
    const project = createProject('未命名座套项目', createInitialWorkspace(defaultConfig));
    setStore(current => ({ ...current, activeProjectId: project.id, projects: [...current.projects, project] }));
    return project.id;
  }, [defaultConfig]);

  const switchProject = useCallback((id: string) => setStore(current => current.projects.some(project => project.id === id) ? { ...current, activeProjectId: id } : current), []);
  const renameProject = useCallback((id: string, name: string) => setStore(current => ({ ...current, projects: current.projects.map(project => project.id === id ? { ...project, name: name.trim() || project.name, updatedAt: Date.now() } : project) })), []);
  const duplicateProject = useCallback((id: string) => setStore(current => {
    const source = current.projects.find(project => project.id === id);
    if (!source) return current;
    const project = createProject(`${source.name} - 副本`, structuredClone(source.workspace));
    return { ...current, activeProjectId: project.id, projects: [...current.projects, project] };
  }), []);
  const deleteProject = useCallback((id: string) => setStore(current => {
    if (current.projects.length <= 1) return current;
    const projects = current.projects.filter(project => project.id !== id);
    return { ...current, projects, activeProjectId: current.activeProjectId === id ? projects[0].id : current.activeProjectId };
  }), []);
  const exportProject = useCallback(async (id: string) => {
    const project = store.projects.find(item => item.id === id);
    if (!project) throw new Error('项目不存在');
    const portable = { format: 'jacky-seat-cover-project', version: 1, project: { ...project, workspace: await makePortableWorkspace(project.workspace) } };
    const safeName = project.name.replace(/[\\/:*?"<>|]+/g, '-');
    await saveBlobToDownloads(new Blob([JSON.stringify(portable)], { type: 'application/json' }), `${safeName || '座套项目'}.jacky-seat-project.json`);
  }, [store.projects]);
  const importProject = useCallback(async (file: File) => {
    const parsed = JSON.parse(await file.text()) as { format?: string; project?: Partial<SeatCoverProject> };
    if (parsed.format !== 'jacky-seat-cover-project' || !parsed.project) throw new Error('不是有效的 Jacky Image 座套项目文件');
    const workspace = normalizeSeatCoverWorkspace(parsed.project.workspace, defaultConfig);
    if (!workspace) throw new Error('项目数据版本不受支持');
    const restored = await restoreWorkspace(workspace);
    const project = createProject(parsed.project.name?.trim() || file.name.replace(/\.jacky-seat-project\.json$/i, ''), restored);
    setStore(current => ({ ...current, activeProjectId: project.id, projects: [...current.projects, project] }));
  }, [defaultConfig]);

  return {
    state,
    setState,
    hydrated,
    projects: store.projects,
    activeProjectId: store.activeProjectId,
    actions: { createProject: createProjectAction, switchProject, renameProject, duplicateProject, deleteProject, exportProject, importProject },
  };
}
