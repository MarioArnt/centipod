import { join, parse } from 'path';
import { existsSync } from 'fs';

export const resloveProjectRoot = (): string => {
  const root = parse(process.cwd()).root;
  const recursivelyFind = (path: string): string => {
    if (path === root) {
      throw new Error('Not in a valid yarn project');
    }
    if (existsSync(join(path, 'yarn.lock'))) {
      return path;
    } else {
      return recursivelyFind(join(path, '..'));
    }
  };
  return recursivelyFind(process.cwd());
};
