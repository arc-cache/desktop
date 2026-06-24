import { useState, useCallback, useEffect } from "react";
import { toast } from "sonner";
import type { Project } from "../types";

function isProjectCreateError(result: Project | { error: string } | null): result is { error: string } {
  return !!result && "error" in result;
}

export function useProjectManager() {
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => {
    window.claude.projects.list().then(setProjects);
  }, []);

  const createProject = useCallback(async (spaceId?: string) => {
    const project = await window.claude.projects.create(spaceId);
    if (!project) return null;
    if (isProjectCreateError(project)) {
      toast.error("Project could not be opened", { description: project.error });
      return null;
    }

    setProjects((prev) => {
      if (prev.some((p) => p.id === project.id)) return prev;
      return [...prev, project];
    });
    return project;
  }, []);

  const createDevProject = useCallback(async (name: string, spaceId?: string) => {
    const project = await window.claude.projects.createDev(name, spaceId);
    if (!project) return null;
    if (isProjectCreateError(project)) {
      toast.error("Project could not be created", { description: project.error });
      return null;
    }

    setProjects((prev) => {
      if (prev.some((p) => p.id === project.id)) return prev;
      return [...prev, project];
    });
    return project;
  }, []);

  const deleteProject = useCallback(async (id: string) => {
    await window.claude.projects.delete(id);
    setProjects((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const renameProject = useCallback(async (id: string, name: string) => {
    await window.claude.projects.rename(id, name);
    setProjects((prev) =>
      prev.map((p) => (p.id === id ? { ...p, name } : p)),
    );
  }, []);

  const resetProjectCache = useCallback(async (id: string) => {
    const result = await window.claude.projects.resetCache(id);
    if (result.error) {
      toast.error("Failed to reset ARC cache", { description: result.error });
      return result;
    }

    toast.success(result.removed ? "ARC cache reset" : "ARC cache is already empty", {
      description: result.cacheDir,
    });
    return result;
  }, []);

  const updateProjectSpace = useCallback(async (id: string, spaceId: string) => {
    await window.claude.projects.updateSpace(id, spaceId);
    setProjects((prev) =>
      prev.map((p) => (p.id === id ? { ...p, spaceId } : p)),
    );
  }, []);

  const updateProjectIcon = useCallback(async (id: string, icon: string | null, iconType: "emoji" | "lucide" | null) => {
    await window.claude.projects.updateIcon(id, icon, iconType);
    setProjects((prev) =>
      prev.map((p) => {
        if (p.id !== id) return p;
        if (icon === null || iconType === null) {
          const { icon: _i, iconType: _t, ...rest } = p;
          return rest;
        }
        return { ...p, icon, iconType };
      }),
    );
  }, []);

  const reorderProject = useCallback(async (projectId: string, targetProjectId: string) => {
    await window.claude.projects.reorder(projectId, targetProjectId);
    setProjects((prev) => {
      const next = [...prev];
      const fromIdx = next.findIndex((p) => p.id === projectId);
      const toIdx = next.findIndex((p) => p.id === targetProjectId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  }, []);

  return {
    projects,
    createProject,
    createDevProject,
    deleteProject,
    renameProject,
    resetProjectCache,
    updateProjectSpace,
    updateProjectIcon,
    reorderProject,
  };
}
