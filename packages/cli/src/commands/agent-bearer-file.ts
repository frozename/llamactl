// #289: read a tunnel bearer from a 0600 file so it never has to enter
// a launchd plist, a command line, or a process env. Errors name the
// flag and path only — never the file content.
import { readFileSync, statSync } from "../safe-fs.js";

export function readBearerFile(
  path: string,
  flagLabel: string,
): { bearer: string } | { error: string } {
  let mode: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) {
      return { error: `${flagLabel}: bearer file ${path} is not a regular file` };
    }
    mode = st.mode;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { error: `${flagLabel}: cannot read bearer file ${path}: ${reason}` };
  }
  if (process.platform !== "win32" && (mode & 0o077) !== 0) {
    const shown = `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
    return {
      error: `${flagLabel}: bearer file ${path} has mode ${shown}; it must not be readable by group or others (run: chmod 600 ${path})`,
    };
  }
  let bearer: string;
  try {
    bearer = readFileSync(path, "utf8").trim();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { error: `${flagLabel}: cannot read bearer file ${path}: ${reason}` };
  }
  if (bearer === "") return { error: `${flagLabel}: bearer file ${path} is empty` };
  return { bearer };
}
