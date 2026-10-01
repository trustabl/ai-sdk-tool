// Resolves the Trustabl scanner binary for the host platform.
//
// This package ships no binary. It downloads the release matching its own
// version, verifies it against that release's checksums.txt, and caches it. The
// approach is a port of the Claude plugin's launcher, which is proven on macOS,
// Linux and Windows; see scripts/trustabl-mcp.js in trustabl/claude-plugin.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

const REPO = "trustabl/agent-reliability-analyzer";

/** The engine release this package downloads.
 *
 *  This is deliberately NOT the package version. The two ship from different
 *  repositories and change for different reasons: a fix to the summariser is a
 *  package release that must not pretend to be a new engine, and an engine
 *  release does not always need a package release. The pin lives in
 *  package.json under "trustabl".engineVersion and is kept current by
 *  .github/workflows/engine-bump.yml, which opens a pull request when a new
 *  engine release appears. */
const PKG = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
export const ENGINE_VERSION: string = PKG.trustabl.engineVersion;

interface Target {
  goos: string;
  goarch: string;
  ext: "zip" | "tar.gz";
}

function target(): Target | null {
  const goos = ({ darwin: "darwin", linux: "linux", win32: "windows" } as const)[
    os.platform() as "darwin" | "linux" | "win32"
  ];
  let goarch = ({ x64: "amd64", arm64: "arm64" } as const)[
    os.arch() as "x64" | "arm64"
  ];
  if (!goos || !goarch) return null;
  // There is no windows/arm64 asset; .goreleaser.yaml ignores that pair on
  // purpose. Windows on ARM runs x64 under emulation, so amd64 is the right
  // answer rather than a missing one.
  if (goos === "windows" && goarch === "arm64") goarch = "amd64";
  return { goos, goarch, ext: goos === "windows" ? "zip" : "tar.gz" };
}

function cacheDir(): string {
  const base =
    process.env.TRUSTABL_CACHE_DIR ??
    path.join(os.homedir(), ".cache", "trustabl-ai-sdk");
  return path.join(base, ENGINE_VERSION);
}

async function get(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

// Extract one member from a zip buffer using only zlib. Deflate and stored are
// the only methods Go's archive/zip writes, which is what builds our assets.
function unzipMember(buf: Buffer, wantName: string): Buffer | null {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (path.basename(name) === wantName) {
      if (buf.readUInt32LE(localOff) !== 0x04034b50) return null;
      const start =
        localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
      const raw = buf.subarray(start, start + compSize);
      return method === 0 ? raw : inflateRawSync(raw);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

async function onPath(): Promise<string | null> {
  const probe = os.platform() === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(probe, ["trustabl"]);
    return stdout.split("\n")[0]!.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Returns a path to a Trustabl binary, downloading and verifying the pinned
 * release if it is not already cached.
 *
 * Set TRUSTABL_BIN to use an existing binary and skip the download entirely —
 * the escape hatch for air-gapped environments and for testing against a build
 * that is not released.
 */
export async function resolveBinary(): Promise<string> {
  if (process.env.TRUSTABL_BIN) return process.env.TRUSTABL_BIN;

  const name = os.platform() === "win32" ? "trustabl.exe" : "trustabl";
  const bin = path.join(cacheDir(), name);
  if (fs.existsSync(bin)) return bin;

  const t = target();
  if (!t) {
    const fallback = await onPath();
    if (fallback) return fallback;
    throw new Error(
      `Trustabl does not publish a build for ${os.platform()}/${os.arch()}. ` +
        `Install it yourself and set TRUSTABL_BIN, or see https://github.com/${REPO}/releases`,
    );
  }

  const asset = `trustabl_${ENGINE_VERSION}_${t.goos}_${t.goarch}.${t.ext}`;
  const base = `https://github.com/${REPO}/releases/download/v${ENGINE_VERSION}`;
  const [blob, sums] = await Promise.all([
    get(`${base}/${asset}`),
    get(`${base}/checksums.txt`),
  ]);

  // Verify before anything is written to disk or executed.
  const want = sums
    .toString("utf8")
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .find((p) => p[1] === asset || p[1] === `*${asset}`);
  const got = createHash("sha256").update(blob).digest("hex");
  if (!want || want[0] !== got) {
    throw new Error(
      `Checksum verification failed for ${asset}. Expected ${want?.[0] ?? "(absent from checksums.txt)"}, got ${got}.`,
    );
  }

  fs.mkdirSync(cacheDir(), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trustabl-"));
  try {
    let data: Buffer | null;
    if (t.ext === "zip") {
      // Read the zip here rather than shelling out: `tar` on PATH may be GNU
      // tar from Git Bash, which does not handle zips, and which one wins is
      // not ours to decide.
      data = unzipMember(blob, name);
    } else {
      const archive = path.join(tmp, asset);
      fs.writeFileSync(archive, blob);
      await execFileAsync("tar", ["-xf", archive, "-C", tmp]);
      const found = fs.readdirSync(tmp).find((f) => f === name);
      data = found ? fs.readFileSync(path.join(tmp, found)) : null;
    }
    if (!data) throw new Error(`Could not find ${name} inside ${asset}.`);

    // Stage beside the target so the rename is atomic on the same volume,
    // which stops a concurrent caller seeing a half-written file.
    const stage = `${bin}.staging.${process.pid}`;
    fs.writeFileSync(stage, data);
    if (os.platform() !== "win32") fs.chmodSync(stage, 0o755);
    fs.renameSync(stage, bin);
    return bin;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
