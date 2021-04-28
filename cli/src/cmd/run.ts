import { Project, resloveProjectRoot } from "@neoxia/centipod-core";

export const run = async (cmd: string, options: {P: boolean, T: boolean, force: boolean, to?: string, affected?: string}) => {
  const project =  await Project.loadProject(resloveProjectRoot());
  for (const root of project.roots()) {
    console.debug('is root:', root.name);
  }
  for (const leaf of project.leaves()) {
    console.debug('is leaf:', leaf.name);
  }
}
