import { describe, expect, it } from "vitest";
import {
  createPersonalInfoMasker,
  maskPersonalHostAddress,
  maskPersonalUsername
} from "./personalInfo";

describe("personal information masking", () => {
  it("masks the requested SSH endpoint shape while preserving its port", () => {
    const masker = createPersonalInfoMasker(true);

    expect(masker.maskText("jy@192.0.2.28:22")).toBe("j*@192.xx.xx.28:22");
    expect(masker.maskText("192.0.2.28:22")).toBe("192.xx.xx.28:22");
    expect(maskPersonalUsername("jy")).toBe("j*");
    expect(maskPersonalHostAddress("192.0.2.28")).toBe("192.xx.xx.28");
  });

  it("masks known standalone identities, hostnames, IPv6 addresses, and home paths", () => {
    const masker = createPersonalInfoMasker(true, [{ username: "jy", address: "gpu.example.com" }]);

    expect(masker.maskUsername("jy")).toBe("j*");
    expect(masker.maskHostAddress("gpu.example.com")).toBe("g*.xx.xx");
    expect(masker.maskHostAddress("[2001:db8::1]")).toBe("[2001:xx:xx:xx]");
    expect(masker.maskHostAddress("-")).toBe("-");
    expect(masker.maskText("jy uses /home/jy on gpu.example.com")).toBe("j* uses /home/j* on g*.xx.xx");
  });

  it("returns original values when masking is disabled", () => {
    const masker = createPersonalInfoMasker(false, [{ username: "jy", address: "192.0.2.28" }]);

    expect(masker.maskText("jy@192.0.2.28:22")).toBe("jy@192.0.2.28:22");
    expect(masker.maskUsername("jy")).toBe("jy");
    expect(masker.maskHostAddress("192.0.2.28")).toBe("192.0.2.28");
  });
});
