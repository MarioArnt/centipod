import { Subject, Observable, throwError } from "rxjs";
import { OrderedTargets } from "./targets";
import { IResolvedTarget } from "./process";
import { watch, FSWatcher } from "chokidar";

export interface WatchEvent {
  target: IResolvedTarget;
  event: "add" | "addDir" | "change" | "unlink" | "unlinkDir";
  path: string;
}

export class Watcher {

  public readonly targets: IResolvedTarget[];
  private _watcher: FSWatcher | undefined;

  constructor(steps: OrderedTargets, public readonly cmd: string, public readonly debounce = 0) {
    this.targets = steps.flat();
  }

  private _events$ = new Subject<WatchEvent>();

  watch(): Observable<WatchEvent> {
    this.unwatch();
    this.targets.forEach((target) => {
      const patterns = target.workspace.config[this.cmd].src;
      patterns?.forEach((glob) => {
        this._watcher = watch(glob).on('all', (event, path) => {
          this._events$.next({
            target,
            event,
            path,
          });
        });
      });
    });
    return this._events$.asObservable();
  }

  unwatch() {
    this._watcher?.close();
    this._events$ = new Subject<WatchEvent>();
  }
}
