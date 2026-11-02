import { readFile, lstat, open, rename, unlink, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
// The deployment concatenates portfolio-project.mjs before this module.
export async function applyPortfolio(root, { validate, transform }) {
  const file = root + "/site.json";
  const info = await lstat(root),
    saved = await lstat(file);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    !saved.isFile() ||
    saved.isSymbolicLink()
  )
    throw Error("Unsafe portfolio data path");
  const original = await readFile(file),
    site = JSON.parse(original);
  validate(site);
  const { next, changed, id } = transform(site);
  if (!changed) return { changed, id };
  validate(next);
  await mkdir(root + "/backups", { recursive: true, mode: 0o700 });
  if ((await lstat(root + "/backups")).isSymbolicLink())
    throw Error("Unsafe backup directory");
  const backup =
      root + "/backups/site-before-voicerooms-" + randomUUID() + ".json",
    b = await open(backup, "wx", 0o600);
  try {
    await b.writeFile(original);
    await b.sync();
  } finally {
    await b.close();
  }
  if (!(await readFile(file)).equals(original))
    throw Error("Portfolio changed during update");
  const temp = root + "/.voicerooms-" + randomUUID() + ".tmp",
    out = await open(temp, "wx", 0o600);
  try {
    await out.writeFile(JSON.stringify(next, null, 2) + "\n");
    await out.sync();
  } finally {
    await out.close();
  }
  try {
    await rename(temp, file);
    if (process.platform !== "win32") {
      const dir = await open(root, "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    }
  } finally {
    await unlink(temp).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
  return { changed: true, id, backup };
}
if (process.argv.includes("--apply")) {
  try {
    const { validateSite } = await import(
      pathToFileURL("/app/server.mjs").href
    );
    console.log(
      JSON.stringify(
        await applyPortfolio("/data", {
          validate: validateSite,
          transform: addVoiceRooms,
        }),
      ),
    );
  } catch {
    console.error(
      "Portfolio update stopped. Existing data and its backup were preserved.",
    );
    process.exitCode = 1;
  }
}
