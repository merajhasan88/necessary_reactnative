/**
 * The files the tests share with the backends: the measurement contract and the client-server
 * vectors. They sit beside the package, or above it when the package is part of a larger repository.
 */
import * as fs from 'fs';
import * as path from 'path';

function nearest(relative: string, exists: (found: string) => boolean): string {
  let folder = path.resolve(__dirname, '..', '..');
  while (!exists(path.join(folder, relative))) {
    const parent = path.dirname(folder);
    if (parent === folder) {
      throw new Error(`${relative}: in no folder from ${__dirname} up`);
    }
    folder = parent;
  }
  return path.join(folder, relative);
}

/** [relative] in the nearest folder, from the package up, that holds it. */
export function repositoryFile(relative: string): string {
  return nearest(relative, (found) => fs.existsSync(found) && fs.statSync(found).isFile());
}

/** The folder [relative] in the nearest folder, from the package up, that holds it. */
export function repositoryDirectory(relative: string): string {
  return nearest(relative, (found) => fs.existsSync(found) && fs.statSync(found).isDirectory());
}

export function readJson(relative: string): any {
  return JSON.parse(fs.readFileSync(repositoryFile(relative), 'utf8'));
}
