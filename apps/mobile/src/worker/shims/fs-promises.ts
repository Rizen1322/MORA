/** node:fs/promises */
import { promises } from '../opfs-fs.ts';
export const { readFile, writeFile, appendFile, mkdir, readdir, stat, lstat, access, rm, unlink, rmdir, rename, copyFile, statfs, utimes, realpath, open } = promises;
export default promises;
