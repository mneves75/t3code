// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { expect, it } from "vite-plus/test";
import { extractDocumentText } from "./documentTextWorker.ts";

function buildStoredZip(entries: ReadonlyArray<readonly [name: string, content: string]>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const dataBytes = Buffer.from(content, "utf8");
    const crc = NodeZlib.crc32(dataBytes) >>> 0;
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(dataBytes.length, 18);
    localHeader.writeUInt32LE(dataBytes.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localParts.push(localHeader, nameBytes, dataBytes);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(dataBytes.length, 20);
    centralHeader.writeUInt32LE(dataBytes.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + dataBytes.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralSize, 12);
  endRecord.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, endRecord]);
}

const cellHeading = "## Cell 1 (code)\n";
const outputHeading = "\nOutput:\n";

it.each([
  {
    name: "omits the output heading when only half an emoji fits after it",
    source: "x".repeat(1_000_000 - cellHeading.length - outputHeading.length - 1),
    outputs: ["😀"],
    remainder: "\n\n[Extracted text truncated at document extraction limits.]",
  },
  {
    name: "keeps reading after a high surrogate in an output below the limit",
    source: "run()",
    outputs: ["\uD83D", "\uDE00"],
    remainder: "\nOutput:\n\uD83D\n\uDE00\n\n## Cell 2 (markdown)\nLater cell",
  },
])("$name", async ({ source, outputs, remainder }) => {
  const folder = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-notebook-budget-"));
  try {
    const path = NodePath.join(folder, "output.ipynb");
    await NodeFSP.writeFile(
      path,
      JSON.stringify({
        cells: [
          {
            cell_type: "code",
            source,
            outputs: outputs.map((text) => ({ output_type: "stream", text })),
          },
          { cell_type: "markdown", source: "Later cell" },
        ],
      }),
    );
    const extracted = await extractDocumentText(path, ".ipynb");
    expect(extracted.slice(source.length + cellHeading.length)).toBe(remainder);
  } finally {
    await NodeFSP.rm(folder, { recursive: true, force: true });
  }
});

it("enforces row limit on empty EPUB table rows and caps cumulative XML nodes across parts", async () => {
  const folder = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-doc-limits-"));
  try {
    const emptyRowsEpub = NodePath.join(folder, "empty-rows.epub");
    await NodeFSP.writeFile(
      emptyRowsEpub,
      buildStoredZip([
        [
          "META-INF/container.xml",
          `<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>`,
        ],
        [
          "content.opf",
          `<package><manifest><item id="c1" href="c1.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>`,
        ],
        [
          "c1.xhtml",
          `<html xmlns="http://www.w3.org/1999/xhtml"><body><table>${"<tr><td></td></tr>".repeat(10_005)}</table></body></html>`,
        ],
      ]),
    );
    const epubText = await extractDocumentText(emptyRowsEpub, ".epub");
    expect(epubText).toContain("[Extracted text truncated at document extraction limits.]");

    // Repeated itemref referencing the same part uses memoized AST instead of reparsing and hitting XML node cap.
    const repeatedPartEpub = NodePath.join(folder, "repeated-part.epub");
    await NodeFSP.writeFile(
      repeatedPartEpub,
      buildStoredZip([
        [
          "META-INF/container.xml",
          `<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>`,
        ],
        [
          "content.opf",
          `<package><manifest><item id="c1" href="c1.xhtml"/></manifest><spine>${'<itemref idref="c1"/>'.repeat(25)}</spine></package>`,
        ],
        [
          "c1.xhtml",
          `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Hello</p>${"<span/>".repeat(10_000)}</body></html>`,
        ],
      ]),
    );
    const memoizedText = await extractDocumentText(repeatedPartEpub, ".epub");
    expect(memoizedText).not.toContain("[Extracted text truncated");
    expect(memoizedText).toContain("## Chapter 25\nHello");

    // Distinct parts share a cumulative 200,000 XML node budget.
    const multiPartEntries: Array<readonly [string, string]> = [
      [
        "META-INF/container.xml",
        `<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>`,
      ],
      [
        "content.opf",
        `<package><manifest>${Array.from({ length: 5 }, (_, i) => `<item id="c${i}" href="c${i}.xhtml"/>`).join("")}</manifest><spine>${Array.from({ length: 5 }, (_, i) => `<itemref idref="c${i}"/>`).join("")}</spine></package>`,
      ],
      ...Array.from(
        { length: 5 },
        (_, i) =>
          [
            `c${i}.xhtml`,
            `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Part ${i}</p>${"<span/>".repeat(50_000)}</body></html>`,
          ] as const,
      ),
    ];
    const cumulativeEpub = NodePath.join(folder, "cumulative.epub");
    await NodeFSP.writeFile(cumulativeEpub, buildStoredZip(multiPartEntries));
    const cumulativeText = await extractDocumentText(cumulativeEpub, ".epub");
    expect(cumulativeText).toContain("[Extracted text truncated at document extraction limits.]");
  } finally {
    await NodeFSP.rm(folder, { recursive: true, force: true });
  }
});
