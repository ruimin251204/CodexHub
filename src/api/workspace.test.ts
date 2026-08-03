import { expect, test } from "vitest";
import { transferSourceDisplayName } from "./workspace";

test("upload transfer labels use the concrete file name without exposing a local path", () => {
  expect(transferSourceDisplayName({
    direction: "upload",
    sourceRef: "grant-opaque",
    destinationPath: "/home/demo/reports/result.csv"
  })).toBe("result.csv");
  expect(transferSourceDisplayName({
    direction: "upload",
    sourceRef: "grant-opaque",
    destinationPath: "E:\\uploads\\archive.zip"
  })).toBe("archive.zip");
});

test("download transfer labels keep the canonical remote source", () => {
  expect(transferSourceDisplayName({
    direction: "download",
    sourceRef: "/srv/data/report.pdf",
    destinationPath: "download"
  })).toBe("/srv/data/report.pdf");
});
