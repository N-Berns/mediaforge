import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The Ink screen tests drive a real render loop; slow CI runners (Windows) need more than 5 s.
    testTimeout: 20_000,
  },
});
