import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const indexPath = resolve("dist", "index.html");
const description = "VoxLive provides intelligent speech transcription and real-time Tamil translation for meetings, presentations, education, and multilingual discussions.";

let html = await readFile(indexPath, "utf8");

if (!html.includes('name="description"')) {
  html = html.replace(
    "<title>VoxLive</title>",
    `<title>VoxLive</title>\n    <meta name="description" content="${description}" />\n    <meta name="theme-color" content="#0B0812" />\n    <meta property="og:title" content="VoxLive — Every Voice. Every Language. One Understanding." />\n    <meta property="og:description" content="${description}" />\n    <meta property="og:type" content="website" />`,
  );
}

await writeFile(indexPath, html, "utf8");
