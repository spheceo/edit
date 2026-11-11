// Read-only: ListObjectsV2 over the whole bucket, writes key\tsize\tlastModified lines.
const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
const client = new Bun.S3Client({ accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, bucket: R2_BUCKET, endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, region: "auto" });
const out = Bun.file(process.argv[2]).writer();
let token: string | undefined; let n = 0; let bytes = 0;
do {
  const page: any = await client.list({ maxKeys: 1000, continuationToken: token });
  for (const o of page.contents ?? []) { out.write(`${o.key}\t${o.size}\t${o.lastModified}\n`); n++; bytes += o.size; }
  token = page.isTruncated ? page.nextContinuationToken : undefined;
  if (n % 20000 < 1000) console.error(n, (bytes / 1e9).toFixed(1) + " GB");
} while (token);
await out.end();
console.error("done", n, (bytes / 1e9).toFixed(2) + " GB");
