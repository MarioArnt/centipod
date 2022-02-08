import path_1, {dirname, join} from "path";
import {promises as fs} from "fs";

export interface IConfigEntry {
  cmd: string | string[];
  src: string[];
}

export interface IConfig {
  [cmd: string]: IConfigEntry;
}

export interface IConfigFile {
  targets?: {
    [cmd: string]: IConfigEntry;
  }
  extends?: string;
}

export const readConfigFile = async (path: string): Promise<unknown> => {
  try {
    const data = await fs.readFile(path, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    if (e.code === 'ENOENT') {
      return {};
    }
    throw e;
  }
}

export const loadConfig = async (path: string): Promise<IConfig> => {
  const raw = await readConfigFile(path);
  // TODO: Validate
  const config = raw as IConfigFile;
  const targets = config.targets || {};
  if (config.extends) {
    const extending = join(dirname(path), ...config.extends.split('/'));
    if (extending === path) {
      // TODO: Throw properly
      // Throw also if not exists
      throw new Error('Cannot extend himself');
    }
    const parentConfig = await loadConfig(extending);
    return { ...parentConfig, ...targets}
  } else {
    return targets;
  }
}
