import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setFileInput, uploadResume } from "../file-injector";

class DataTransferStub {
  private _files: File[] = [];
  get files(): FileList {
    return this._files as unknown as FileList;
  }
  get items(): { add: (file: File) => void } {
    return { add: (file: File) => this._files.push(file) };
  }
}

function installDataTransferPolyfill(): void {
  if (
    typeof (globalThis as { DataTransfer?: unknown }).DataTransfer ===
    "undefined"
  ) {
    (globalThis as unknown as { DataTransfer: unknown }).DataTransfer =
      DataTransferStub;
  }
}

function uninstallDataTransferPolyfill(): void {
  delete (globalThis as { DataTransfer?: unknown }).DataTransfer;
}

function stubInputFilesSetter(): () => void {
  const original = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "files",
  );
  Object.defineProperty(HTMLInputElement.prototype, "files", {
    get() {
      return (
        (this as unknown as { _stubbedFiles?: FileList })._stubbedFiles ?? null
      );
    },
    set(this: HTMLInputElement, value: FileList | null) {
      (this as unknown as { _stubbedFiles?: FileList })._stubbedFiles =
        value ?? undefined;
    },
    configurable: true,
  });
  return () => {
    if (original) {
      Object.defineProperty(HTMLInputElement.prototype, "files", original);
    }
  };
}

describe("setFileInput", () => {
  let restoreFiles: () => void;
  beforeEach(() => {
    installDataTransferPolyfill();
    restoreFiles = stubInputFilesSetter();
  });
  afterEach(() => {
    uninstallDataTransferPolyfill();
    restoreFiles();
  });

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

describe("uploadResume (US-014 + US-033)", () => {
  let restoreFiles: () => void;
  beforeEach(() => {
    installDataTransferPolyfill();
    restoreFiles = stubInputFilesSetter();
  });
  afterEach(() => {
    uninstallDataTransferPolyfill();
    restoreFiles();
  });

  it("attaches a decoded PDF file to a Greenhouse input (raw base64 fallback path)", async () => {
    document.body.innerHTML =
      '<input type="file" data-qa="resume-upload-input" />';
    const input = document.querySelector<HTMLInputElement>(
      'input[data-qa="resume-upload-input"]',
    );
    expect(input).toBeTruthy();

    const base64 = btoa("%PDF-1.4\nfake content\n%%EOF");
    const dispatchSpy = vi.spyOn(input as HTMLInputElement, "dispatchEvent");

    // Pass raw base64 (no data: prefix) — falls through to the atob path
    // which is exercised in jsdom where fetch + DecompressionStream are
    // unavailable. Production code receives a data: URL and uses the
    // fetch+gunzip path; verified by the orchestrator-side pdf integrity
    // tests in services/applications.buildPayload.pdfIntegrity.test.ts.
    const ok = await uploadResume(
      input as HTMLInputElement,
      base64,
      "tailored-resume.pdf",
    );

    expect(ok).toBe(true);
    expect(input?.files?.length).toBe(1);
    expect(input?.files?.[0].name).toBe("tailored-resume.pdf");
    expect(input?.files?.[0].type).toBe("application/pdf");
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "change", bubbles: true }),
    );
  });

  it("returns false when called with a null input (no file input found)", async () => {
    const base64 = btoa("anything");
    const ok = await uploadResume(null, base64, "tailored-resume.pdf");
    expect(ok).toBe(false);
  });

  it("returns false when DataTransfer is unavailable", async () => {
    uninstallDataTransferPolyfill();
    const input = document.createElement("input");
    input.type = "file";
    const base64 = btoa("%PDF-1.4\nfake content\n%%EOF");
    const ok = await uploadResume(input, base64, "tailored-resume.pdf");
    expect(ok).toBe(false);
  });

  it("returns false on malformed base64 (negative)", async () => {
    const input = document.createElement("input");
    input.type = "file";
    const ok = await uploadResume(input, "!!@@", "tailored-resume.pdf");
    expect(ok).toBe(false);
  });
});
