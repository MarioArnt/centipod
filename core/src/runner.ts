import { from, Observable } from "rxjs";
import { mergeAll } from "rxjs/operators";
import { isNodeErroredEvent, isNodeSucceededEvent, RunCommandEvent, RunCommandEventEnum } from "./process";
import { Project } from "./project";
import { Workspace } from "./workspace";

export interface IRunOptions {
  parallel: boolean;
  to: Workspace;
  force: boolean;
  affected: { rev1: string, rev2: string};
}

export class Runner {

  constructor(
    private readonly _project: Project,
    private readonly _concurrency: number = 4,
  ) {}

  runCommand(cmd: string, options: Partial<IRunOptions>): Observable<RunCommandEvent> {
    return new Observable((obs) => {
      this._resolveTargets(cmd, options).then((targets) => {
        // TODO: Validate configurations for each targets
        obs.next({ type: RunCommandEventEnum.TARGETS_RESOLVED, targets });
        if (!targets.length) {
          obs.complete();
        } else if (options.parallel && options.to && targets.length) {
          this._runForWorkspace(options.to, cmd, !!options.force).subscribe(
            (evt) => obs.next(evt),
            (err) => obs.error(err),
            () => obs.complete(), 
          )
        } else if (options.parallel) {
          from(targets.map((w) => this._runForWorkspace(w, cmd, !!options.force))).pipe(mergeAll(this._concurrency)).subscribe(
            (evt) => obs.next(evt),
            (err) => obs.error(err),
            () => obs.complete(), 
          )
        } else {
          let force = !!options.force;
          const runNextWorkspace = () => {
            this._runForWorkspace(targets[0], cmd, force).subscribe(
              (evt) => {
                if (isNodeSucceededEvent(evt)) {
                  obs.next(evt);
                  if (!force && !evt.result.fromCache) {
                    force = true;
                  }
                  targets.shift();
                  if (targets.length) {
                    runNextWorkspace();
                  } else {
                    obs.complete();
                  }
                } else if (isNodeErroredEvent(evt)) {
                  Promise.all(targets.map(t => t.invalidate(cmd))).finally(() => {
                    obs.error(evt);
                  });
                }
              },
              (error) => obs.error(error),
            )
          }
          runNextWorkspace();
        }
      })
    });
  }

  private _runForWorkspace(workspace: Workspace, cmd: string, force: boolean): Observable<RunCommandEvent> {
    return new Observable((obs) => {
      workspace.run(cmd, force)
        .then((result) => {
          obs.next({ type: RunCommandEventEnum.NODE_PROCESSED, result, workspace });
        }).catch((error) => {
          obs.next({ type: RunCommandEventEnum.NODE_ERRORED, error, workspace })
        }).finally(() => {
          obs.complete();
        });
    });
  }

  private async _resolveTargets(cmd: string, options: Partial<IRunOptions>): Promise<Workspace[]> {
    if (options.parallel && options.to) {
      const hasCommand = await options.to.hasCommand(cmd);
      return hasCommand ? [options.to] : [];
    }
    const findTargets = async (eligible: Workspace[]): Promise<Workspace[]> => {
      const targets: Workspace[] = [];
      await Promise.all(Array.from(eligible).map(async (workspace) => {
        const hasCommand = await workspace.hasCommand(cmd);
        let isTarget = hasCommand;
        if (options.affected?.rev1) {
          const patterns = workspace.config[cmd].src;
          const affected = await workspace.isAffected(options.affected.rev1, options.affected.rev2, patterns, !options.parallel);
          isTarget = hasCommand && affected;
        }
        if (isTarget) {
          targets.push(workspace);
        }
      }));
      return targets;
    }
    if (options.parallel) {
      return findTargets(Array.from(this._project.workspaces.values()));
    }
    return findTargets(this._project.getTopologicallySortedWorkspaces(options.to));
  }
}
