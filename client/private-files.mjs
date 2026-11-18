import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
const uid = process.getuid?.(); // Windows uses the ACL inherited from the user profile.

function restrict(path, stat, mode) {
  if (stat.uid !== uid || (stat.isFile() && stat.nlink !== 1)) {
    throw new Error(`Unsafe ownership or link count in Hub client data: ${path}`);
  }
  if ((stat.mode & 0o7777) !== mode) chmodSync(path, mode);
}

export function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (uid === undefined) return;
  const stat = lstatSync(path);
  if (!stat.isDirectory()) throw new Error(`Expected a Hub client data directory: ${path}`);
  restrict(path, stat, PRIVATE_DIR_MODE);
}

export function openPrivateFile(path, flags) {
  const fd = openSync(path, flags | (uid === undefined ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK), PRIVATE_FILE_MODE);
  if (uid === undefined) return fd;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1) throw new Error(`Unsafe Hub client data file: ${path}`);
    if ((stat.mode & 0o7777) !== PRIVATE_FILE_MODE) fchmodSync(fd, PRIVATE_FILE_MODE);
    return fd;
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}

/** Repair previously written private data before use, without following links. */
export function repairPrivateTree(dir) {
  ensurePrivateDirectory(dir);
  if (uid === undefined) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      const stat = lstatSync(path);
      if (stat.isDirectory()) repairPrivateTree(path);
      else if (stat.isFile()) restrict(path, stat, PRIVATE_FILE_MODE);
      else throw new Error(`Unexpected entry in Hub client data: ${path}`);
    } catch (e) {
      // Another hook may concurrently replace a journal entry or remove a lock.
      if (e.code !== 'ENOENT') throw e;
    }
  }
}
