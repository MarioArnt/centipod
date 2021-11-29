import {Project} from "../src";

describe('[class] Runner', () => {
  describe('[method] runCommand', () => {
    let project: Project;
    beforeEach(() => {
      project = new Project();

    });
    it('should resolve all targets that have the command - parallel');
    it('should resolve only package that have the command - parallel with argument to');
    it('should resolve recursively resolve targets - topological');
  });
});
