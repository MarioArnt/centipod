import {SinonStub, stub} from "sinon";
import {Workspace} from "../src";
import { promises as fs } from 'fs';
import fastGlob from "fast-glob";
import {join} from "path";
import {mockedPackages} from "./mocks/project/package-json";
import {CentipodError, CentipodErrorCode} from "../src";
import {Project} from "../src";
import { fixture } from '../src/git';

describe('[class] workspace', () => {
  let readFile: SinonStub;
  let glob: SinonStub;
  const root = '/somewhere/on/filesystem';
  beforeEach(() => {
    readFile = stub(fs, 'readFile');
    glob = stub(fastGlob, 'sync');
    readFile.rejects();
    glob.throws();
    glob.withArgs(join(root, 'packages/*/package.json')).returns([
      join(root, 'packages/workspace-a/package.json'),
      join(root, 'packages/workspace-b/package.json'),
      join(root, 'packages/workspace-c/package.json'),
    ]);
    glob.withArgs(join(root, 'api/package.json')).returns([
      join(root, 'api/package.json'),
    ]);
    glob.withArgs(join(root, 'apps/*/package.json')).returns([
      join(root, 'apps/app-a/package.json'),
      join(root, 'apps/app-b/package.json'),
    ]);
    readFile.withArgs(join(root, 'package.json')).resolves(JSON.stringify(mockedPackages.root));
    readFile.withArgs(join(root, 'packages/workspace-a', 'package.json')).resolves(JSON.stringify(mockedPackages.workspaces.workspaceA));
    readFile.withArgs(join(root, 'packages/workspace-b', 'package.json')).resolves(JSON.stringify(mockedPackages.workspaces.workspaceB));
    readFile.withArgs(join(root, 'packages/workspace-c', 'package.json')).resolves(JSON.stringify(mockedPackages.workspaces.workspaceC));
    readFile.withArgs(join(root, 'api', 'package.json')).resolves(JSON.stringify(mockedPackages.workspaces.api));
    readFile.withArgs(join(root, 'apps/app-a', 'package.json')).resolves(JSON.stringify(mockedPackages.workspaces.appA));
    readFile.withArgs(join(root, 'apps/app-b', 'package.json')).resolves(JSON.stringify(mockedPackages.workspaces.appB));
    readFile.withArgs(root).resolves({});
    const notFound = new Error();
    (notFound as unknown as { code: string }).code = 'ENOENT';
    readFile.withArgs(join(root, 'centipod.json')).rejects(notFound);
    readFile.withArgs(join(root, 'packages/workspace-a', 'centipod.json')).resolves("{}");
    readFile.withArgs(join(root, 'packages/workspace-b', 'centipod.json')).resolves("{}");
    readFile.withArgs(join(root, 'packages/workspace-c', 'centipod.json')).rejects(notFound);
    readFile.withArgs(join(root, 'api', 'centipod.json')).resolves("{}");
    readFile.withArgs(join(root, 'apps/app-a', 'centipod.json')).resolves("{}");
    readFile.withArgs(join(root, 'apps/app-b', 'centipod.json')).rejects(notFound);
  });
  afterEach(() => {
    readFile.restore();
    glob.restore();
  });
  describe('[static method] loadWorkspace', () => {
    it('should load workspace', async () => {
      const workspace = await Workspace.loadWorkspace(join(root, 'packages/workspace-a'));
      expect(workspace.name).toBe('@org/workspace-a');
      expect(workspace.version).toBe('2.3.1');
      expect(workspace.private).toBe(false);
      expect(workspace.config).toEqual({});
    });
  });
  describe('[static method] loadConfig', () => {
    it('should return empty config if file does not exists', async () => {
      const config = await Workspace.loadConfig(join(root, 'packages/workspace-c'));
      expect(config).toEqual({});
    });
    it('should throw if another error occurs', async () => {
      try {
        readFile.withArgs(join(root, 'packages/workspace-c', 'centipod.json')).rejects('Permission denied');
        await Workspace.loadConfig(join(root, 'packages/workspace-c'));
        fail('should throw');
      } catch (e) {
        expect(e).toBeTruthy();
      }
    });
  });
  describe('[generator] dependencies', () => {
    it.skip('should not yield any deps if no deps', async () => {
      const project = await Project.loadProject(root);
      const workspace = await Workspace.loadWorkspace(join(root, 'packages/workspace-c'), project);
      const deps = [];
      for (const dep of workspace.dependencies()) deps.push(dep)
      expect(deps).toHaveLength(0);
    });
    it('should throw if project is not set', async () => {
      try {
        const workspace = await Workspace.loadWorkspace(join(root, 'packages/workspace-a'));
        for (const dep of workspace.dependencies()) {
          // eslint-disable-next-line no-console
          console.info(dep.name);
        }
        fail('should throw');
      } catch (e) {
        expect(e).toBeTruthy();
        expect(e instanceof CentipodError).toBe(true);
        expect(e.code).toBe(CentipodErrorCode.PROJECT_NOT_RESOLVED);
      }
    });
  });
  describe('[generator] dependents', () => {
    it('should throw if project is not set', async () => {
      try {
        const workspace = await Workspace.loadWorkspace(join(root, 'packages/workspace-a'));
        for (const dep of workspace.dependents()) {
          // eslint-disable-next-line no-console
          console.info(dep.name);
        }
        fail('should throw');
      } catch (e) {
        expect(e).toBeTruthy();
        expect(e instanceof CentipodError).toBe(true);
        expect(e.code).toBe(CentipodErrorCode.PROJECT_NOT_RESOLVED);
      }
    });
  });
  describe('[method] isAffected', () => {
    let gitDiff: SinonStub;
    beforeEach(() => {
      gitDiff = stub(fixture.simpleGitInstance, 'diff');
      gitDiff.rejects();
    });
    afterEach(() => {
      gitDiff.restore()
    });
    it('should return true when not topological only if workspace sources have been changed', async () => {
      const project = await Project.loadProject(root);
      const workspace = await Workspace.loadWorkspace(join(root, 'apps/app-a'), project);
      gitDiff.withArgs(['--name-only', 'rev1', '--', join(root, 'apps/app-a')]).resolves([
        'apps/app-a/package.json',
        'apps/app-a/src/cache.ts',
        'apps/app-a/src/checksum.ts',
        'apps/app-a/src/project.ts',
        'apps/app-a/src/workspace.ts',
      ].join('\n'));
      expect(await workspace.isAffected('rev1')).toBe(true);
    });
    it.skip('should return false when not topological if workspace sources not have been changed', async () => {
      const project = await Project.loadProject(root);
      const workspace = await Workspace.loadWorkspace(join(root, 'apps/app-a'), project);
      gitDiff.withArgs([
        '--name-only',
        'rev1',
        'rev2',
        '--',
        '/somewhere/on/filesystem/apps/app-a'
      ]).resolves('apps/app-a/package.json');
      glob.withArgs(join(root, 'apps/app-a', '*.ts')).returns(['src/foo.ts', 'src/bar.ts']);
      expect(await workspace.isAffected('rev1', 'rev2', ['*.ts'])).toBe(false)
    });
    it('should return true when topological if at least one dependency source code have been changed', async () => {
      const project = await Project.loadProject(root);
      const workspace = await Workspace.loadWorkspace(join(root, 'apps/app-a'), project);
      gitDiff.withArgs(['--name-only', 'rev1', 'rev2', '--', join(root, 'apps/app-a')]).resolves('');
      gitDiff.withArgs(['--name-only', 'rev1', 'rev2', '--', join(root, 'packages/workspace-a')]).resolves('');
      gitDiff.withArgs(['--name-only', 'rev1', 'rev2', '--', join(root, 'packages/workspace-c')]).resolves('packages/workspace-c/package.json');
      expect(await workspace.isAffected('rev1', 'rev2', undefined, true)).toBe(true)
    });
    it('should return false when topological only if source code did not change for all dependency and workspace itself', async () => {
      const project = await Project.loadProject(root);
      const workspace = await Workspace.loadWorkspace(join(root, 'apps/app-a'), project);
      gitDiff.withArgs(['--name-only', 'rev1', '--', join(root, 'apps/app-a')]).resolves('');
      gitDiff.withArgs(['--name-only', 'rev1', '--', join(root, 'packages/workspace-a')]).resolves('');
      gitDiff.withArgs(['--name-only', 'rev1', '--', join(root, 'packages/workspace-c')]).resolves('');
      expect(await workspace.isAffected('rev1', undefined, ['**'], true)).toBe(false)
    });
  });
  describe('[method] hasCommand', () => {
    it.todo('should be tested');
  });
  describe('[method] run', () => {
    it.todo('should be tested');
  });
  describe('[method] invalidate', () => {
    it.todo('should be tested');
  });
  describe('[method] bumpVersions', () => {
    it.todo('should be tested');
  });
  describe('[method] publish', () => {
    it.todo('should be tested');
  });
  describe('[method] getNpmInfos', () => {
    it.todo('should be tested');
  });
  describe('[method] isPublished', () => {
    it.todo('should be tested');
  });
  describe('[method] listGreaterVersionsInRegistry', () => {
    it.todo('should be tested');
  });
  describe('[method] setVersion', () => {
    it.todo('should be tested');
  });
  describe('[method] getLastReleaseOnRegistry', () => {
    it.todo('should be tested');
  });
  describe('[method] getLastReleaseTag', () => {
    it.todo('should be tested');
  });
});
