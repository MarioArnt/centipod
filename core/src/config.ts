export interface Config {
  [cmd: string]: {
    cmd: string;
    src: string[];
  }
}
