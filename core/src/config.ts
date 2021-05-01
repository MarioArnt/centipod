export interface Config {
  [cmd: string]: {
    cmd: string | string[];
    src: string[];
  }
}
