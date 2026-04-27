import pkg from "../../package.json";

export async function runVersion(_rawArgs: string[]): Promise<number> {
  process.stdout.write(`Jarvis v${pkg.version}\n`);
  return 0;
}
