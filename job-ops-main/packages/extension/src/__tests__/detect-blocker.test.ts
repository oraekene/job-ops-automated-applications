import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectBlocker } from "../lib/detect-blocker";

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("detectBlocker", () => {
  it("detects reCAPTCHA iframe", () => {
    document.body.innerHTML =
      '<iframe src="https://www.google.com/recaptcha/api2/anchor?k=abc"></iframe>';
    expect(detectBlocker()).toEqual({
      blocked: true,
      reason: "reCAPTCHA detected",
    });
  });

  it("detects hCaptcha iframe", () => {
    document.body.innerHTML =
      '<iframe src="https://js.hcaptcha.com/1/api.js?sitekey=xyz"></iframe>';
    expect(detectBlocker()).toEqual({
      blocked: true,
      reason: "hCaptcha detected",
    });
  });

  it("detects MFA prompt", () => {
    document.body.innerHTML =
      "<div>Please verify your identity to continue</div>";
    expect(detectBlocker()).toEqual({
      blocked: true,
      reason: "MFA prompt detected",
    });
  });

  it("detects Greenhouse sign-in modal", () => {
    document.body.innerHTML = '<div class="modal">Sign in to apply</div>';
    expect(detectBlocker()).toEqual({
      blocked: true,
      reason: "sign-in required",
    });
  });

  it("detects Lever sign-in modal", () => {
    document.body.innerHTML = '<div class="modal">Sign in</div>';
    expect(detectBlocker()).toEqual({
      blocked: true,
      reason: "sign-in required",
    });
  });

  it("returns not blocked for clean Greenhouse DOM", () => {
    document.body.innerHTML =
      '<form><input name="first_name" /><input name="last_name" /></form>';
    expect(detectBlocker()).toEqual({ blocked: false });
  });
});
