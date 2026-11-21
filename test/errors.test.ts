import { describe, it, expect } from "vitest";
import { mapGlError } from "../src/errors.js";

describe("mapGlError", () => {
  it("maps the glab Go unmarshal error on a structured GitLab body to VALIDATION_ERROR", () => {
    const err = mapGlError(
      "json: cannot unmarshal object into Go struct field .Message of type string",
      1,
    );
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toBe(
      "GitLab rejected the request with a validation error whose details the installed CLI version does not pass through",
    );
    expect(err.suggestions.join(" ")).toMatch(/GitLab API documentation/);
    expect(err.message).not.toMatch(/masked/i);
    expect(err.suggestions.join(" ")).not.toMatch(/masked/i);
  });

  it("reports the HTTP status of an object-valued error recovered by gl.ts", () => {
    const err = mapGlError(
      "json: cannot unmarshal object into Go struct field .Message of type string (HTTP 409)",
      1,
    );
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toBe(
      "GitLab rejected the request with HTTP 409 and an error whose details the installed CLI version does not pass through",
    );
  });

  it("surfaces GitLab's own message with the status for each error shape", () => {
    expect(mapGlError('Bad (HTTP 400)\n{"message":"Bad"}', 1).message).toBe(
      "Bad (HTTP 400)",
    );
    expect(
      mapGlError(
        'HTTP 400\n{"message":{"user_id":["is invalid"],"base":["x"]}}',
        1,
      ).message,
    ).toBe("user_id is invalid; base x (HTTP 400)");
    expect(
      mapGlError(
        'glab: HTTP 400\n{"error":"invalid_grant","error_description":"bad grant"}',
        1,
      ).message,
    ).toBe("invalid_grant: bad grant (HTTP 400)");
  });

  it("still prefers a real HTTP status over the Go unmarshal fallback", () => {
    const err = mapGlError(
      'HTTP 422 {"message":"key has already been taken"}',
      1,
    );
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toBe("key has already been taken (HTTP 422)");
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
