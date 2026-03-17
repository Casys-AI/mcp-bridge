import { assertEquals, assertThrows } from "@std/assert";
import { parseResourceUri, resolveToHttp } from "../../src/core/resource-resolver.ts";

Deno.test("parseResourceUri - basic URI", () => {
  const uri = parseResourceUri("ui://my-app/index.html");
  assertEquals(uri.server, "my-app");
  assertEquals(uri.path, "/index.html");
  assertEquals(uri.query, {});
  assertEquals(uri.raw, "ui://my-app/index.html");
});

Deno.test("parseResourceUri - URI with query params", () => {
  const uri = parseResourceUri("ui://my-app/page?theme=dark&lang=en");
  assertEquals(uri.server, "my-app");
  assertEquals(uri.path, "/page");
  assertEquals(uri.query, { theme: "dark", lang: "en" });
});

Deno.test("parseResourceUri - server only (no path)", () => {
  const uri = parseResourceUri("ui://my-app");
  assertEquals(uri.server, "my-app");
  assertEquals(uri.path, "/");
});

Deno.test("parseResourceUri - throws on non-ui scheme", () => {
  assertThrows(
    () => parseResourceUri("https://example.com"),
    Error,
    'expected "ui://" scheme',
  );
});

Deno.test("parseResourceUri - throws on empty server", () => {
  assertThrows(
    () => parseResourceUri("ui:///path"),
    Error,
    "empty server",
  );
});

Deno.test("resolveToHttp - basic resolution", () => {
  const url = resolveToHttp("ui://my-app/index.html", "https://res.example.com");
  assertEquals(url, "https://res.example.com/my-app/index.html");
});

Deno.test("resolveToHttp - with query params", () => {
  const url = resolveToHttp(
    "ui://app/page?key=value",
    "https://res.example.com",
  );
  assertEquals(url, "https://res.example.com/app/page?key=value");
});

Deno.test("resolveToHttp - base URL with trailing slash", () => {
  const url = resolveToHttp("ui://app/index.html", "https://res.example.com/");
  assertEquals(url, "https://res.example.com/app/index.html");
});

Deno.test("resolveToHttp - accepts ResourceUri object", () => {
  const uri = parseResourceUri("ui://my-app/test");
  const url = resolveToHttp(uri, "http://localhost:8080");
  assertEquals(url, "http://localhost:8080/my-app/test");
});
