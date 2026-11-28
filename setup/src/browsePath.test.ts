// @vitest-environment node
// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { INSTALL_FOLDER_NAME, installFolderFromPicked } from "./browsePath";

describe("Browse target", () => {
  it("appends the product folder when a parent folder is picked", () => {
    expect(installFolderFromPicked("D:\\Games")).toBe(`D:\\Games\\${INSTALL_FOLDER_NAME}`);
    expect(installFolderFromPicked("C:\\Users\\User\\AppData\\Local")).toBe(
      `C:\\Users\\User\\AppData\\Local\\${INSTALL_FOLDER_NAME}`,
    );
    expect(installFolderFromPicked("C:\\")).toBe(`C:\\${INSTALL_FOLDER_NAME}`);
    expect(installFolderFromPicked("D:/Games/")).toBe(`D:\\Games\\${INSTALL_FOLDER_NAME}`);
  });

  it("keeps a picked folder that is already the product folder", () => {
    expect(installFolderFromPicked(`D:\\Games\\${INSTALL_FOLDER_NAME}`)).toBe(
      `D:\\Games\\${INSTALL_FOLDER_NAME}`,
    );
    expect(installFolderFromPicked(`D:\\Games\\${INSTALL_FOLDER_NAME}\\`)).toBe(
      `D:\\Games\\${INSTALL_FOLDER_NAME}`,
    );
    expect(installFolderFromPicked("D:\\Games\\voxelight launcher")).toBe(
      "D:\\Games\\voxelight launcher",
    );
  });

  it("does not invent a folder when nothing was picked", () => {
    expect(installFolderFromPicked(null)).toBeNull();
    expect(installFolderFromPicked(undefined)).toBeNull();
    expect(installFolderFromPicked("")).toBeNull();
    expect(installFolderFromPicked("   ")).toBeNull();
  });

  it("does not double the product folder when the installer folder is inside it", () => {
    expect(installFolderFromPicked(`D:\\Games\\${INSTALL_FOLDER_NAME}\\data`)).toBe(
      `D:\\Games\\${INSTALL_FOLDER_NAME}\\data\\${INSTALL_FOLDER_NAME}`,
    );
  });
});
