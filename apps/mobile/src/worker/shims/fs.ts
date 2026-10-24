/** node:fs */
import fs from '../opfs-fs.ts';
export const {
  promises, constants, existsSync, statSync, lstatSync, readdirSync, mkdirSync, rmSync, unlinkSync, renameSync,
  realpathSync, accessSync, readFileSync, writeFileSync, createReadStream, createWriteStream, stat, lstat, readdir,
  readFile, writeFile, mkdir, rm, unlink, rename, utimes, access, open, Stats, Dirent,
} = fs;
export default fs;
