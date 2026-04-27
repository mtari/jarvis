import fs from "node:fs";
import path from "node:path";

let counter = 0;

export function atomicWriteFileSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  counter += 1;
  const tmp = path.join(
    dir,
    `.${base}.${process.pid}.${Date.now()}.${counter}.tmp`,
  );

  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, "w");
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort
      }
    }
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.closeSync(fd);

  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
