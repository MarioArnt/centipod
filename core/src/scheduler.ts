import { Workspace } from "./workspace";

export class Scheduler {
  constructor(readonly queue: Set<Workspace>, readonly concurreny: number) {}

  async exec(): Promise<void> {

  }
}
