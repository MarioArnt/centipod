import { Project, resloveProjectRoot } from "@neoxia/centipod-core";
import { resolveWorkspace } from "../utils/validate-workspace";

export const isAffected = async (workspaceName: string, rev1: string, rev2?: string) => {
  const project =  await Project.loadProject(resloveProjectRoot());
  const workspace = resolveWorkspace(project, workspaceName);
    // TODO: Better output
  console.info(await workspace.isAffected(rev1, rev2));
};
