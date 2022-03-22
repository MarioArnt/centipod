import { getProject } from './mocks/utils';
import { SinonStub, stub } from 'sinon';
import { Project, RunCommandEventEnum, Runner, TargetsResolver, Workspace } from '../src';
import { expectObservable } from './utils/runner-observable';
import { delay, from, mergeAll, Observable, of, Subject, switchMap, throwError } from "rxjs";
import { Watcher, WatchEvent } from "../src/watcher";

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
    // console.log('stubbing', { stub, call, idx });
    if (call.resolve) {
      stub.withArgs(...call.args).onCall(idx).returns(of({
        commands:[],
        overall: call.delay || 0,
        fromCache: call.fromCache || false,
      }).pipe(delay(call.delay || 0)))
    } else {
      stub.withArgs(...call.args).onCall(idx).returns(of('').pipe(
        delay(call.delay || 0),
        switchMap(() => throwError(call.error))
      ))
    }
  });
}

describe('[class] Runner', () => {
  let project: Project;
  let stubs: {
    run?: SinonStub,
    invalidate?: SinonStub,
    targets?: SinonStub,
    watch?: SinonStub,
  } = {};
  beforeEach(async() => {
    project = await getProject();
    stubs.invalidate = stub(Workspace.prototype, 'invalidate');
    stubs.invalidate.resolves();
    stubs.run = stub(Workspace.prototype, 'run');
    stubs.targets = stub(TargetsResolver.prototype, 'resolve');
    stubs.watch = stub(Watcher.prototype, 'watch');
  })
  afterEach(() => {
    Object.values(stubs).forEach((stub) => stub.restore());
  });
  describe('[method] runCommand', () => {
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
        await expectObservable(Date.now(), execution$, '0-444433-11', {
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
        await expectObservable(Date.now(), execution$, '0-443333-11152', {
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
        await expectObservable(Date.now(), execution$, '0-33-115555-33-1155-3-15-3-1', {
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
    it('should terminate and invalidate cache of subsequent workspaces if a command fail in a workspace - topological', async () => {
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
        { resolve: true, args: ['build', false, [], 'pipe'], delay: 14, fromCache: true },
        { resolve: true, args: ['build', false, [], 'pipe'], delay: 7, fromCache: true },
        { resolve: true, args: ['build', false, [], 'pipe'], delay: 13, fromCache: true },
        { resolve: false, args: ['build', false, [], 'pipe'], delay: 23 },
        { resolve: true, args: ['build', false, [], 'pipe'], delay: 12 },
        { resolve: true, args: ['build', false, [], 'pipe'], delay: 4 },
      ]);
      try {
        const runner = new Runner(project);
        const execution$ = runner.runCommand('build', {
          mode: 'topological',
          force: false,
        });
        await expectObservable(Date.now(), execution$, '0-33-11-33-12555-X', {
          1: ['@org/workspace-b', '@org/workspace-a', '@org/workspace-c'],
          2: ['@org/app-a'],
          3: ['@org/workspace-b', '@org/app-a', '@org/workspace-a', '@org/workspace-c'],
          5: ['@org/app-a', '@org/api', '@org/app-b'],
        });
      } catch (e) {
        expect(e).toBeFalsy();
      }
    });
    it('should invalidate cache of subsequent workspaces if a command must be re-run in a workspace - topological', async () => {
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
        { resolve: true, args: ['build', false, [], 'pipe'], delay: 14, fromCache: true },
        { resolve: true, args: ['build', false, [], 'pipe'], delay: 7, fromCache: true },
        { resolve: true, args: ['build', false, [], 'pipe'], delay: 13, fromCache: true },
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
        await expectObservable(Date.now(), execution$, '0-33-11-33-1155-3-15-3-1', {
          1: ['@org/workspace-b', '@org/app-a', '@org/workspace-a',  '@org/app-b',  '@org/workspace-c', '@org/api'],
          3: ['@org/workspace-b', '@org/app-a', '@org/workspace-a',  '@org/app-b',  '@org/workspace-c', '@org/api'],
          5: ['@org/api', '@org/app-b', '@org/app-b'],
        });
      } catch (e) {
        expect(e).toBeFalsy();
      }
    });
    it('should terminate on cache invalidation error  - parallel', async () => {
      stubs.targets?.returns(resolveAfter([
        [
          { workspace: project.workspaces.get('@org/workspace-a')!, affected: true, hasCommand: true },
          { workspace: project.workspaces.get('@org/workspace-b')!, affected: true, hasCommand: false },
          { workspace: project.workspaces.get('@org/workspace-c')!, affected: false, hasCommand: true },
          { workspace: project.workspaces.get('@org/app-a')!, affected: false, hasCommand: true },
          { workspace: project.workspaces.get('@org/app-b')!, affected: true, hasCommand: true },
          { workspace: project.workspaces.get('@org/api')!, affected: true, hasCommand: true },
        ]
      ], 12));
      stubs.invalidate?.rejects();
      stubRun(stubs.run!, [
        { resolve: true, args: ['lint', false, [], 'pipe'], delay: 14 },
        { resolve: true, args: ['lint', false, [], 'pipe'], delay: 8 },
        { resolve: false, args: ['lint', false, [], 'pipe'], delay: 23 },
      ])
      try {
        const runner = new Runner(project);
        const execution$ = runner.runCommand('lint', {
          mode: 'parallel',
          force: false,
        });
        await expectObservable(Date.now(), execution$, '0-444333-1126-X', {
          1: ['@org/workspace-a', '@org/app-b'],
          2: ['@org/api'],
          4: ['@org/workspace-c', '@org/workspace-b', '@org/app-a'],
          3: ['@org/workspace-a', '@org/app-b', '@org/api'],
          5: [],
          6: ['@org/api'],
        });
      } catch (e) {
        expect(e).toBeFalsy();
      }
    });
    it('should terminate on cache invalidation error  - topological', async () => {
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
        { resolve: true, args: ['build', false, [], 'pipe'], delay: 14, fromCache: true },
        { resolve: true, args: ['build', false, [], 'pipe'], delay: 7, fromCache: true },
        { resolve: true, args: ['build', false, [], 'pipe'], delay: 13, fromCache: true },
        { resolve: false, args: ['build', false, [], 'pipe'], delay: 23 },
        { resolve: true, args: ['build', false, [], 'pipe'], delay: 12 },
        { resolve: true, args: ['build', false, [], 'pipe'], delay: 4 },
      ]);
      stubs.invalidate?.onCall(0).resolves();
      stubs.invalidate?.onCall(1).rejects();
      stubs.invalidate?.onCall(2).resolves();
      try {
        const runner = new Runner(project);
        const execution$ = runner.runCommand('build', {
          mode: 'topological',
          force: false,
        });
        await expectObservable(Date.now(), execution$, '0-33-11-33-12556-X', {
          1: ['@org/workspace-b', '@org/workspace-a', '@org/workspace-c'],
          2: ['@org/app-a'],
          3: ['@org/workspace-b', '@org/app-a', '@org/workspace-a', '@org/workspace-c'],
          5: ['@org/app-a', '@org/app-b'],
          6: ['@org/api'],
        });
      } catch (e) {
        expect(e).toBeFalsy();
      }
    });
  });
  describe.only('[method] runCommand (watch mode)', () => {
    const mockSourcesChange = (changes: Array<{ workspaceName: string, delay: number }>): Observable<WatchEvent> => {
      const fakeEvents$: Array<Observable<WatchEvent>> = changes.filter((changes) => project.workspaces.has(changes.workspaceName)
      ).map((changes) => {
        return of({
          target: {
            workspace: project.workspaces.get(changes.workspaceName)!,
            affected: true,
            hasCommand: true,
          },
          event: 'change' as const,
          path: '/what/ever'
        }).pipe(delay(changes.delay))
      });
      return from(fakeEvents$).pipe(mergeAll());
    };
    it('should handle single-interruptions in running step and when idle - [parallel]', async () => {
      stubs.targets?.returns(resolveAfter([
        [
          { workspace: project.workspaces.get('@org/workspace-a')!, affected: true, hasCommand: true },
          { workspace: project.workspaces.get('@org/workspace-b')!, affected: true, hasCommand: false },
          { workspace: project.workspaces.get('@org/workspace-c')!, affected: false, hasCommand: true },
          { workspace: project.workspaces.get('@org/app-a')!, affected: true, hasCommand: true },
          { workspace: project.workspaces.get('@org/app-b')!, affected: true, hasCommand: false },
          { workspace: project.workspaces.get('@org/api')!, affected: true, hasCommand: true },
        ]
      ], 12));
      stubs.watch?.returns(mockSourcesChange([
        { workspaceName: '@org/api', delay: 150},
        { workspaceName: '@org/app-a', delay: 450},
      ]));
      stubRun(stubs.run!, [
        { resolve: true, args: ['lint', false, [], 'pipe', {}], delay: 100 }, // +100ms
        { resolve: true, args: ['lint', false, [], 'pipe', {}], delay: 200 }, // + 200ms
        { resolve: true, args: ['lint', false, [], 'pipe', {}], delay: 200 }, // + 200ms
        { resolve: true, args: ['lint', false, [], 'pipe', {}], delay: 200 }, // + 400ms
        { resolve: true, args: ['lint', false, [], 'pipe', {}], delay: 10 },
      ]);
      try {
        const runner = new Runner(project, 4);
        const execution$ = runner.runCommand('lint', {
          mode: 'parallel',
          force: false,
        }, [], {}, true, 8);
        await expectObservable(Date.now(), execution$, '0-444333-1-7813-1-7-3-1', {}, undefined, 500);
      } catch (e) {
        expect(e).toBeFalsy();
      }
    });
    it('should do nothing if impacted process has not started yet - [parallel]', async () => {
      stubs.targets?.returns(resolveAfter([
        [
          { workspace: project.workspaces.get('@org/workspace-a')!, affected: true, hasCommand: true },
          { workspace: project.workspaces.get('@org/workspace-b')!, affected: true, hasCommand: true },
          { workspace: project.workspaces.get('@org/workspace-c')!, affected: true, hasCommand: true },
          { workspace: project.workspaces.get('@org/app-a')!, affected: true, hasCommand: true },
          { workspace: project.workspaces.get('@org/app-b')!, affected: true, hasCommand: false },
          { workspace: project.workspaces.get('@org/api')!, affected: true, hasCommand: true },
        ]
      ], 12));
      stubs.watch?.returns(mockSourcesChange([
        { workspaceName: '@org/app-a', delay: 50},
        { workspaceName: '@org/api', delay: 150},
      ]));
      stubRun(stubs.run!, [
        // Initial
        // 0-333444-1-78-1-31-7-3-1
        { resolve: true, args: ['lint', false, [], 'pipe', {}], delay: 100 }, // +0ms
        { resolve: true, args: ['lint', false, [], 'pipe', {}], delay: 100 },

        { resolve: true, args: ['lint', false, [], 'pipe', {}], delay: 100 }, // +100ms
        { resolve: true, args: ['lint', false, [], 'pipe', {}], delay: 100 },

        { resolve: true, args: ['lint', false, [], 'pipe', {}], delay: 100 }, // + 200ms
      ]);
      try {
        const runner = new Runner(project, 2);
        const execution$ = runner.runCommand('lint', {
          mode: 'parallel',
          force: false,
        }, [], {}, true, 8);
        await expectObservable(Date.now(), execution$, '0-33-7-1133-7-1134-1', {}, undefined, 500);
      } catch (e) {
        expect(e).toBeFalsy();
      }
    });
    it('should do nothing if impacted target is not affected - [parallel]', async () => {
      stubs.targets?.returns(resolveAfter([
        [
          { workspace: project.workspaces.get('@org/workspace-a')!, affected: true, hasCommand: true },
          { workspace: project.workspaces.get('@org/workspace-b')!, affected: true, hasCommand: true },
          { workspace: project.workspaces.get('@org/workspace-c')!, affected: true, hasCommand: true },
          { workspace: project.workspaces.get('@org/app-a')!, affected: true, hasCommand: true },
          { workspace: project.workspaces.get('@org/app-b')!, affected: true, hasCommand: false },
          { workspace: project.workspaces.get('@org/api')!, affected: false, hasCommand: true },
        ]
      ], 12));
      stubs.watch?.returns(mockSourcesChange([
        { workspaceName: '@org/api', delay: 30},
      ]));
      stubRun(stubs.run!, [
        // Initial
        // 0-333444-1-78-1-31-7-3-1
        { resolve: true, args: ['lint', false, [], 'pipe', {}], delay: 100 }, // +0ms
        { resolve: true, args: ['lint', false, [], 'pipe', {}], delay: 100 },
        { resolve: true, args: ['lint', false, [], 'pipe', {}], delay: 100 },
        { resolve: true, args: ['lint', false, [], 'pipe', {}], delay: 100 },
        // +100ms
      ]);
      try {
        const runner = new Runner(project, 8);
        const execution$ = runner.runCommand('lint', {
          mode: 'parallel',
          force: false,
        }, [], {}, true, 8);
        await expectObservable(Date.now(), execution$, '0-333344-7-1111', {}, undefined, 500);
      } catch (e) {
        expect(e).toBeFalsy();
      }
    });
    it.only('should handle correctly multiple interruption - [parallel]', async () => {
      stubs.targets?.returns(resolveAfter([
        [
          { workspace: project.workspaces.get('@org/workspace-a')!, affected: true, hasCommand: true },
          { workspace: project.workspaces.get('@org/workspace-b')!, affected: true, hasCommand: false },
          { workspace: project.workspaces.get('@org/workspace-c')!, affected: false, hasCommand: true },
          { workspace: project.workspaces.get('@org/app-a')!, affected: false, hasCommand: true },
          { workspace: project.workspaces.get('@org/app-b')!, affected: true, hasCommand: true },
          { workspace: project.workspaces.get('@org/api')!, affected: true, hasCommand: true },
        ]
      ], 12));
      stubs.watch?.returns(mockSourcesChange([
        // During First round
        { workspaceName: '@org/workspace-a', delay: 130},
        { workspaceName: '@org/api', delay: 65},
        // After first round
        { workspaceName: '@org/api', delay: 210},
        { workspaceName: '@org/app-a', delay: 210},
        // During second round
        { workspaceName: '@org/app-b', delay: 250},
        { workspaceName: '@org/workspace-a', delay: 310},
        // After second round
        { workspaceName: '@org/app-a', delay: 380},
        { workspaceName: '@org/api', delay: 420},

      ]));
      stubRun(stubs.run!, [
        // First round
        { resolve: true, args: ['lint', false, [], 'pipe'], delay: 100 }, // + 0ms
        { resolve: true, args: ['lint', false, [], 'pipe'], delay: 150 },
        { resolve: true, args: ['lint', false, [], 'pipe'], delay: 200 },
        // Second round
        { resolve: true, args: ['lint', false, [], 'pipe'], delay: 120 }, // +210ms
        { resolve: true, args: ['lint', false, [], 'pipe'], delay: 140 },
        { resolve: true, args: ['lint', false, [], 'pipe'], delay: 160 },
        // Third round
        { resolve: true, args: ['lint', false, [], 'pipe'], delay: 23 }, // +370ms
      ])
      try {
        const runner = new Runner(project, 8);
        const execution$ = runner.runCommand('lint', {
          mode: 'parallel',
          force: false,
        }, [], {}, true, 20);
        await expectObservable(Date.now(), execution$, '0-444333-1778833-11-73-7837831-11-7-3-1', {});
      } catch (e) {
        expect(e).toBeFalsy();
      }
    });
    it.skip('should handle correctly errored node - [parallel]', async () => {
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
        await expectObservable(Date.now(), execution$, '0-444433-11', {
          1: ['@org/workspace-a', '@org/api'],
          2: [],
          4: ['@org/workspace-c', '@org/workspace-b', '@org/app-a', '@org/app-b'],
          3: ['@org/workspace-a', '@org/api'],
        });
      } catch (e) {
        expect(e).toBeFalsy();
      }
    });
    it.skip('should handle correctly interruption in previous step - [topological]', async () => {
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
        await expectObservable(Date.now(), execution$, '0-444433-11', {
          1: ['@org/workspace-a', '@org/api'],
          2: [],
          4: ['@org/workspace-c', '@org/workspace-b', '@org/app-a', '@org/app-b'],
          3: ['@org/workspace-a', '@org/api'],
        });
      } catch (e) {
        expect(e).toBeFalsy();
      }
    });
    it.skip('should handle correctly interruption in subsequent step - [topological]', async () => {
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
        await expectObservable(Date.now(), execution$, '0-444433-11', {
          1: ['@org/workspace-a', '@org/api'],
          2: [],
          4: ['@org/workspace-c', '@org/workspace-b', '@org/app-a', '@org/app-b'],
          3: ['@org/workspace-a', '@org/api'],
        });
      } catch (e) {
        expect(e).toBeFalsy();
      }
    });
    it.skip('should handle correctly interruption in current step (running node) - [topological]', async () => {
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
        await expectObservable(Date.now(), execution$, '0-444433-11', {
          1: ['@org/workspace-a', '@org/api'],
          2: [],
          4: ['@org/workspace-c', '@org/workspace-b', '@org/app-a', '@org/app-b'],
          3: ['@org/workspace-a', '@org/api'],
        });
      } catch (e) {
        expect(e).toBeFalsy();
      }
    });
    it.skip('should handle correctly interruption in current step (processed node) - [topological]', async () => {
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
        await expectObservable(Date.now(), execution$, '0-444433-11', {
          1: ['@org/workspace-a', '@org/api'],
          2: [],
          4: ['@org/workspace-c', '@org/workspace-b', '@org/app-a', '@org/app-b'],
          3: ['@org/workspace-a', '@org/api'],
        });
      } catch (e) {
        expect(e).toBeFalsy();
      }
    });
    it.skip('should handle correctly interruption in current step (queued node) - [topological]', async () => {
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
        await expectObservable(Date.now(), execution$, '0-444433-11', {
          1: ['@org/workspace-a', '@org/api'],
          2: [],
          4: ['@org/workspace-c', '@org/workspace-b', '@org/app-a', '@org/app-b'],
          3: ['@org/workspace-a', '@org/api'],
        });
      } catch (e) {
        expect(e).toBeFalsy();
      }
    });
    it.skip('should handle correctly multiple interruption complex scenario - [topological]', async () => {
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
        await expectObservable(Date.now(), execution$, '0-444433-11', {
          1: ['@org/workspace-a', '@org/api'],
          2: [],
          4: ['@org/workspace-c', '@org/workspace-b', '@org/app-a', '@org/app-b'],
          3: ['@org/workspace-a', '@org/api'],
        });
      } catch (e) {
        expect(e).toBeFalsy();
      }
    });
  });
});
