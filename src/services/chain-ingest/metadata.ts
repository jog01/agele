import { lookup } from "node:dns/promises";
import { get } from "node:https";
import { isIP } from "node:net";
import { z } from "zod";

const MAX_BYTES = 128 * 1024;
const displayText = (max: number) =>
  z
    .string()
    .transform((value) => value.replace(/\p{Cc}/gu, "").trim())
    .pipe(z.string().min(1).max(max));
const metadata = z.object({
  name: displayText(100),
  symbol: displayText(32),
  image: z.string().max(2048).optional(),
});

function httpsUrl(uri: string): URL | null {
  try {
    const url = new URL(
      uri.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${uri.slice(7).replace(/^ipfs\//, "")}` : uri,
    );
    return url.protocol === "https:" && !url.username && !url.password && !url.port ? url : null;
  } catch {
    return null;
  }
}

function publicIpv4(address: string) {
  if (isIP(address) !== 4) return false;
  const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
  return (
    a > 0 &&
    a < 224 &&
    a !== 10 &&
    a !== 127 &&
    !(a === 100 && b >= 64 && b < 128) &&
    !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b < 32) &&
    !(a === 192 && [0, 168].includes(b)) &&
    !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) &&
    !(a === 203 && b === 0 && c === 113)
  );
}

async function readHttps(url: URL) {
  const host = url.hostname;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    (isIP(host) && !publicIpv4(host)) ||
    host.startsWith("[")
  ) {
    throw new Error("Metadata URL is not public");
  }
  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    get(
      url,
      {
        signal: AbortSignal.timeout(3000),
        family: 4,
        lookup: (hostname, _options, callback) => {
          void lookup(hostname, { family: 4 }).then(
            ({ address, family }) => {
              if (publicIpv4(address)) callback(null, address, family);
              else callback(new Error("Metadata address is not public"), "", 4);
            },
            (error: NodeJS.ErrnoException) => callback(error, "", 4),
          );
        },
      },
      resolve,
    ).on("error", reject);
  });
  try {
    if (response.statusCode !== 200 || Number(response.headers["content-length"]) > MAX_BYTES) {
      throw new Error("Invalid metadata response");
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) throw new Error("Metadata exceeds size limit");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    response.destroy();
  }
}

export async function resolveMetadata(uri: string | undefined, load = readHttps) {
  if (!uri || uri.length > MAX_BYTES * 3 || uri.includes("\0")) return null;
  try {
    const data = /^data:application\/json(;base64)?,(.*)$/s.exec(uri);
    const url = data ? null : httpsUrl(uri);
    const json = data
      ? data[1]
        ? Buffer.from(data[2]!, "base64").toString("utf8")
        : decodeURIComponent(data[2]!)
      : url
        ? await load(url)
        : "";
    if (Buffer.byteLength(json) > MAX_BYTES) return null;
    const { image, name, symbol } = metadata.parse(JSON.parse(json));
    return { name, symbol, imageUrl: image ? (httpsUrl(image)?.href ?? null) : null };
  } catch {
    return null;
  }
}
