import { describe, it, expect } from "vitest";
import { mapGlError } from "../src/errors.js";

describe("mapGlError", () => {
  it("maps the glab Go unmarshal error on a structured GitLab body to VALIDATION_ERROR", () => {
    const err = mapGlError(
      "json: cannot unmarshal object into Go struct field .Message of type string",
      1,
    );
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toBe("GitLab rejected the request as invalid");
  });

  it("still prefers a real HTTP status over the Go unmarshal fallback", () => {
    const err = mapGlError(
      'HTTP 422 {"message":"key has already been taken"}',
      1,
    );
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toBe("key has already been taken");
  });

  it("does not read a 401 inside an id as an auth failure", () => {
    const err = mapGlError(
      '409 Conflict (HTTP 409)\n{"message":"SHA does not match HEAD of source branch: 0401abc"}',
      1,
    );
    expect(err.code).toBe("CONFLICT");
  });

  it("maps an HTTP 401 to AUTH_REQUIRED", () => {
    expect(mapGlError("401 Unauthorized (HTTP 401)", 1).code).toBe(
      "AUTH_REQUIRED",
    );
    expect(mapGlError("HTTP 401", 1).code).toBe("AUTH_REQUIRED");
  });

  it("falls back to UNKNOWN for an unrecognized error", () => {
    const err = mapGlError("something went wrong", 1);
    expect(err.code).toBe("UNKNOWN");
  });
});
