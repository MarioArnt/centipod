import { Project, resloveProjectRoot } from "@neoxia/centipod-core";

export const isAffected = async (workspaceName: string, rev1: string, rev2?: string) => {
  const project =  await Project.loadProject(resloveProjectRoot());
  const workspace = project.getWorkspace(workspaceName);
  if (!workspace) {
    console.error('No such workspace:', workspaceName);
    process.exit(1);
  }
  console.info(await workspace.isAffected(rev1, rev2));
};
