import { describe, expect, it, vi } from "vitest";
import { setFileInput } from "../file-injector";

describe("setFileInput", () => {
  it("sets file on input[type=file] via DataTransfer", () => {
    const input = document.createElement("input");
    input.type = "file";
    const dispatchSpy = vi.spyOn(input, "dispatchEvent");
    const pdfBytes = new Uint8Array([37, 80, 68, 70]);
    setFileInput(input, pdfBytes, "resume.pdf");
    expect(input.files?.length).toBe(1);
    expect(input.files?.[0].name).toBe("resume.pdf");
    expect(input.files?.[0].type).toBe("application/pdf");
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "change", bubbles: true }),
    );
  });

  it("does nothing when element is null", () => {
    expect(() =>
      setFileInput(null, new Uint8Array(), "test.pdf"),
    ).not.toThrow();
  });

  it("handles empty bytes array", () => {
    const input = document.createElement("input");
    input.type = "file";
    setFileInput(input, new Uint8Array(0), "empty.pdf");
    expect(input.files?.length).toBe(1);
    expect(input.files?.[0].size).toBe(0);
  });
});
