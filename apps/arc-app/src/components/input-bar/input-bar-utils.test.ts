import { describe, expect, it } from "vitest";
import {
  hasMeaningfulText,
  stripVoicePlaceholderText,
} from "./input-bar-utils";

describe("input-bar voice placeholder handling", () => {
  it("strips blank-audio placeholders from plain text", () => {
    expect(stripVoicePlaceholderText("[BLANK_AUDIO]")).toBe("");
    expect(stripVoicePlaceholderText("hello [BLANK_AUDIO]")).toBe("hello ");
  });

  it("treats blank-audio placeholders as non-meaningful text", () => {
    expect(hasMeaningfulText("[BLANK_AUDIO]")).toBe(false);
    expect(hasMeaningfulText(" [BLANK_AUDIO]\n")).toBe(false);
    expect(hasMeaningfulText("hello [BLANK_AUDIO]")).toBe(true);
  });
});
