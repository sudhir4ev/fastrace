import { describe, expect, it } from "vitest";
import { formatIpPort } from "./utils";

describe("formatIpPort", () => {
  it("drops leading zeros and collapses the longest zero run into ::", () => {
    expect(formatIpPort("fd53:7cb8:0383:0002:0000:0000:0000:004f:49573")).toBe("[fd53:7cb8:383:2::4f]:49573");
  });

  it("picks the longest zero run when there are two", () => {
    expect(formatIpPort("2001:0000:0000:0001:0000:0000:0000:0001:80")).toBe("[2001:0:0:1::1]:80");
  });

  it("does not collapse a single isolated zero group", () => {
    expect(formatIpPort("fd53:7cb8:0000:0002:0003:0004:0005:0006:80")).toBe("[fd53:7cb8:0:2:3:4:5:6]:80");
  });

  it("leaves IPv4 addresses unchanged", () => {
    expect(formatIpPort("10.0.0.1:2000")).toBe("10.0.0.1:2000");
  });
});
