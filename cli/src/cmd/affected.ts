import { Project, resloveProjectRoot, Workspace } from "@neoxia/centipod-core";

export const affected = async (rev1: string, rev2?: string) => {
  const project =  await Project.loadProject(resloveProjectRoot());
  const affected = new Set<Workspace>();
  for (const workspace of project.workspaces.values()) {
    if (await workspace.isAffected(rev1, rev2)) {
      affected.add(workspace);
    }
  }
  // TODO: Better output
  console.info('Workspaces affected', rev2 ? rev1 : 'HEAD', '->', rev2 || rev1, '\n');
  console.info(Array.from(affected).map(a => a.name).join('\n'));
};
