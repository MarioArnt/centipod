import { Subject, Observable } from "rxjs";
import { OrderedTargets } from "./targets";
import { IResolvedTarget } from "./process";
import { watch, FSWatcher } from "chokidar";

export interface IChangeEvent {
  event: "add" | "addDir" | "change" | "unlink" | "unlinkDir";
  path: string;
}

export interface WatchEvent {
  target: IResolvedTarget;
  events: Array<IChangeEvent>;
}

export class Watcher {

  public readonly targets: IResolvedTarget[];
  private _watcher: FSWatcher | undefined;

  constructor(steps: OrderedTargets, public readonly cmd: string, public readonly debounce = 0) {
    this.targets = steps.flat();
  }

  private _events$ = new Subject<Array<WatchEvent>>();

  watch(): Observable<Array<WatchEvent>> {
    this.unwatch();
    const filesChanges = new Map<IResolvedTarget, Array<IChangeEvent>>();
    this.targets.forEach((target) => {
      const patterns = target.workspace.config[this.cmd].src;
      patterns?.forEach((glob) => {
        this._watcher = watch(glob).on('all', (event, path) => {
          if (filesChanges.has(target)) {
            filesChanges.get(target)?.push({ event, path });
          } else {
            filesChanges.set(target, [{ event, path }]);
          }
        });
      });
    });
    setInterval(() => {
      if (filesChanges.size) {
        this._events$.next(Array.from(filesChanges.entries()).map(([target, events]) => ({
          target,
          events,
        })));
      }
      filesChanges.clear();
    }, this.debounce);
    return this._events$.asObservable();
  }

  unwatch() {
    this._watcher?.close();
    this._events$ = new Subject<Array<WatchEvent>>();
  }
}
