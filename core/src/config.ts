export interface IConfigEntry {
  cmd: string | string[];
  src: string[];
}

export interface Config {
  [cmd: string]: IConfigEntry;
}
