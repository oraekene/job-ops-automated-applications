import { describe, expect, it, vi } from "vitest";
import { setReactInputValue } from "../native-events";

describe("setReactInputValue", () => {
  it("sets input value via native setter and dispatches events", () => {
    const input = document.createElement("input");
    const dispatchSpy = vi.spyOn(input, "dispatchEvent");
    setReactInputValue(input, "test@example.com");
    expect(input.value).toBe("test@example.com");
    expect(dispatchSpy).toHaveBeenCalledTimes(2);
    const eventTypes = dispatchSpy.mock.calls.map((c) => (c[0] as Event).type);
    expect(eventTypes).toContain("input");
    expect(eventTypes).toContain("change");
  });

  it("sets textarea value and dispatches events", () => {
    const textarea = document.createElement("textarea");
    vi.spyOn(textarea, "dispatchEvent");
    setReactInputValue(textarea, "Hello world");
    expect(textarea.value).toBe("Hello world");
  });

  it("does nothing when element is null", () => {
    expect(() => setReactInputValue(null, "test")).not.toThrow();
  });

  it("dispatches events with bubbles: true", () => {
    const input = document.createElement("input");
    const dispatchedEvents: Event[] = [];
    input.addEventListener("input", (e) => dispatchedEvents.push(e));
    input.addEventListener("change", (e) => dispatchedEvents.push(e));
    setReactInputValue(input, "test");
    expect(dispatchedEvents.every((e) => e.bubbles)).toBe(true);
  });
});
