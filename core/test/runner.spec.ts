import { getProject } from './mocks/utils';
import { SinonStub, stub } from 'sinon';
import { Project, RunCommandEventEnum, Runner, TargetsResolver, Workspace } from '../src';
import { expectObservable } from './utils/runner-observable';
import { Observable } from 'rxjs';

const resolveAfter = <T>(value: T, ms: number): Promise<T> => new Promise<T>((resolve) => {
  setTimeout(() => resolve(value), ms);
});

const rejectAfter = <E>(error: E, ms: number): Promise<never> => new Promise<never>((resolve, reject) => {
  setTimeout(() => reject(error), ms);
});

interface IRunStub {
  resolve: boolean;
  args: unknown[];
  fromCache?: boolean;
  delay?: number;
  error?: unknown;
}

const stubRun = (stub: SinonStub, calls: IRunStub[]) => {
  calls.forEach((call, idx) => {
    console.log('stubbing', { stub, call, idx });
    if (call.resolve) {
      stub.withArgs(...call.args).onCall(idx).returns(new Observable((obs) => {
        setTimeout(() => {
          obs.next({
            commands:[],
            overall: call.delay || 0,
            fromCache: call.fromCache || false,
          });
          obs.complete();
        }, call.delay || 0)
      }));
    } else {
      stub.withArgs(...call.args).onCall(idx).returns(new Observable((obs) => {
        setTimeout(() => {
          obs.error(call.error);
          obs.complete();
        }, call.delay || 0)
      }));
    }
  });
}

describe('[class] Runner', () => {
  describe('[method] runCommand', () => {
    let project: Project;
    let stubs: {
      run?: SinonStub,
      invalidate?: SinonStub,
      targets?: SinonStub,
    } = {};
    beforeEach(async() => {
      project = await getProject();
      stubs.invalidate = stub(Workspace.prototype, 'invalidate');
      stubs.invalidate.resolves();
      stubs.run = stub(Workspace.prototype, 'runObs');
      stubs.targets = stub(TargetsResolver.prototype, 'resolve');
    })
    afterEach(() => {
      Object.values(stubs).forEach((stub) => stub.restore());
    })
    it('should run command in all workspace at once - parallel', async () => {
      stubs.targets?.returns(resolveAfter([
        [
          { workspace: project.workspaces.get('@org/workspace-a')!, affected: true, hasCommand: true },
          { workspace: project.workspaces.get('@org/workspace-b')!, affected: true, hasCommand: false },
          { workspace: project.workspaces.get('@org/workspace-c')!, affected: false, hasCommand: true },
          { workspace: project.workspaces.get('@org/app-a')!, affected: false, hasCommand: true },
          { workspace: project.workspaces.get('@org/app-b')!, affected: true, hasCommand: false },
          { workspace: project.workspaces.get('@org/api')!, affected: true, hasCommand: true },
        ]
      ], 12));
      stubRun(stubs.run!, [
        { resolve: true, args: ['lint', false, [], 'pipe'], delay: 14 },
        { resolve: true, args: ['lint', false, [], 'pipe'], delay: 23 },
      ])
      try {
        const runner = new Runner(project);
        const execution$ = runner.runCommand('lint', {
          mode: 'parallel',
          force: false,
        });
        await expectObservable(execution$, '0-444433-11', {
          1: ['@org/workspace-a', '@org/api'],
          2: [],
          4: ['@org/workspace-c', '@org/workspace-b', '@org/app-a', '@org/app-b'],
          3: ['@org/workspace-a', '@org/api'],
        });
      } catch (e) {
        expect(e).toBeFalsy();
      }
    });
    it('should run command in all workspace even if it fails for some workspace - parallel', async () => {
      stubs.targets?.returns(resolveAfter([
        [
          { workspace: project.workspaces.get('@org/workspace-a')!, affected: true, hasCommand: true },
          { workspace: project.workspaces.get('@org/workspace-b')!, affected: true, hasCommand: false },
          { workspace: project.workspaces.get('@org/workspace-c')!, affected: true, hasCommand: true },
          { workspace: project.workspaces.get('@org/app-a')!, affected: false, hasCommand: true },
          { workspace: project.workspaces.get('@org/app-b')!, affected: true, hasCommand: true },
          { workspace: project.workspaces.get('@org/api')!, affected: true, hasCommand: true },
        ]
      ], 12));
      stubRun(stubs.run!, [
        { resolve: true, args: ['lint', false, [], 'pipe'], delay: 14 },
        { resolve: false, args: ['lint', false, [], 'pipe'], delay: 7, error: new Error('Unexpected') },
        { resolve: true, args: ['lint', false, [], 'pipe'], delay: 13 },
        { resolve: true, args: ['lint', false, [], 'pipe'], delay: 23 },
      ])
      try {
        const runner = new Runner(project);
        const execution$ = runner.runCommand('lint', {
          mode: 'parallel',
          force: false,
        });
        await expectObservable(execution$, '0-443333-11152', {
          4: ['@org/workspace-b', '@org/app-a'],
          3: ['@org/workspace-a',  '@org/app-b',  '@org/workspace-c', '@org/api'],
        }, (events) => {
          const invalidation = events.find((e) => e.type === RunCommandEventEnum.CACHE_INVALIDATED);
          const error = events.find((e) => e.type === RunCommandEventEnum.NODE_ERRORED);
          expect(invalidation).toBeTruthy();
          expect(invalidation?.workspace).toBe(error?.workspace);
        });
      } catch (e) {
        expect(e).toBeFalsy();
      }
    });
    it('should run command from leaves to roots - topological', async () => {
      stubs.targets?.returns(resolveAfter([
        [
          { workspace: project.workspaces.get('@org/workspace-a')!, affected: true, hasCommand: true },
          { workspace: project.workspaces.get('@org/workspace-c')!, affected: true, hasCommand: true },
        ],
        [
          { workspace: project.workspaces.get('@org/workspace-b')!, affected: true, hasCommand: true },
          { workspace: project.workspaces.get('@org/app-a')!, affected: true, hasCommand: true },
        ],
        [
          { workspace: project.workspaces.get('@org/api')!, affected: true, hasCommand: true },
        ],
        [
          { workspace: project.workspaces.get('@org/app-b')!, affected: true, hasCommand: true },
        ]
      ], 12));
      stubRun(stubs.run!, [
        { resolve: true, args: ['build', false, [], 'pipe'], delay: 14 },
        { resolve: true, args: ['build', false, [], 'pipe'], delay: 7 },
        { resolve: true, args: ['build', false, [], 'pipe'], delay: 13 },
        { resolve: true, args: ['build', false, [], 'pipe'], delay: 23 },
        { resolve: true, args: ['build', false, [], 'pipe'], delay: 12 },
        { resolve: true, args: ['build', false, [], 'pipe'], delay: 4 },
      ])
      try {
        const runner = new Runner(project);
        const execution$ = runner.runCommand('build', {
          mode: 'topological',
          force: false,
        });
        await expectObservable(execution$, '0-33-115555-33-1155-3-15-3-1', {
          1: ['@org/workspace-b', '@org/app-a', '@org/workspace-a',  '@org/app-b',  '@org/workspace-c', '@org/api'],
          3: ['@org/workspace-b', '@org/app-a', '@org/workspace-a',  '@org/app-b',  '@org/workspace-c', '@org/api'],
        }, (events) => {
          const invalidations: string[] = events
            .filter((evt) => evt.type === RunCommandEventEnum.CACHE_INVALIDATED)
            .map((evt) => String(evt.workspace));
          expect(invalidations.slice(0, 4).sort()).toEqual(['@org/workspace-b', '@org/api', '@org/app-b', '@org/app-a'].sort());
          expect(invalidations.slice(4, 6).sort()).toEqual(['@org/api', '@org/app-b'].sort());
          expect(invalidations.slice(6, 7).sort()).toEqual(['@org/app-b']);
        });
      } catch (e) {
        expect(e).toBeFalsy();
      }
    });
    it.todo('should invalidate cache of subsequent workspaces if a command fail in a workspace - topological');
    it.todo('should invalidate cache of subsequent workspaces if a command must be re-run in a workspace - topological');

  });
});
